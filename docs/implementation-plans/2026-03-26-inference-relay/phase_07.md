# Inference Relay Implementation Plan — Phase 7: Web UI Loop Delegation

**Goal:** The orchestrator delegates entire agent loops to a remote host when conditions favor it, with full status forwarding and cancel support.

**Architecture:** No dedicated orchestrator class is needed. The delegation decision logic is inserted inline into the `message:created` event handler in `start.ts` (currently at lines ~501-565). When all AC6.1 conditions hold (model remote, exactly one host, ≥50% recent tools), the handler writes a `process` relay message instead of starting a local `AgentLoop`. The processing host's `RelayProcessor` receives `process`, looks up the user message by `thread_id` + `message_id`, starts an `AgentLoop`, and emits `status_forward` outbox entries on every state change. These flow back to the originating host via sync; the originating host's `RelayProcessor` caches them in a shared `Map<threadId, StatusForwardPayload>` that the web server exposes from the existing `/api/threads/{id}/status` endpoint. Cancel works by emitting `agent:cancel` locally (same as today) AND writing a `cancel` relay message with `ref_id` matching the `process` message.

**Tech Stack:** bun:sqlite, TypeScript 6.x strict, Svelte 5, bun:test, Playwright

**Scope:** Phase 7 of 7. Depends on Phase 1 (relay kinds, payload types), Phase 2 (resolveModel), Phase 3 (RELAY_STREAM as fallback path), Phase 5 (sync test harness for integration tests), Phase 6 (model resolution timing moved to before context assembly).

**Codebase verified:** 2026-03-26

---

## Acceptance Criteria Coverage

### inference-relay.AC6: Web UI loop delegation
- **inference-relay.AC6.1 Success:** Delegation triggers when: model remote, exactly one host has model, that host has ≥50% of thread's recent tools
- **inference-relay.AC6.2 Success:** Processing host receives `process` message, starts agent loop for the thread
- **inference-relay.AC6.3 Success:** Activity status forwarded via `status_forward`; originating host serves it from `/api/threads/{id}/status`
- **inference-relay.AC6.4 Success:** Cancel on originating host sends `cancel` with `ref_id` matching `process`; processing host aborts loop
- **inference-relay.AC6.5 Failure:** Any condition from AC6.1 unmet — no delegation, run locally with individual relay calls
- **inference-relay.AC6.6 Edge:** Confirmed tools blocked on delegated loops; agent receives block error and adapts
- **inference-relay.AC6.7 Edge:** Thread with no tool call history — vacuous ≥50% match — delegation proceeds

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: `getRecentToolCalls()` helper and delegation condition checker

**Verifies:** inference-relay.AC6.1, inference-relay.AC6.5, inference-relay.AC6.7

**Files:**
- Create: `packages/agent/src/delegation.ts`

**Implementation:**

Create `packages/agent/src/delegation.ts` with two exported functions:

```typescript
import type { Database } from "bun:sqlite";
import type { EligibleHost } from "./relay-router";
import type { ModelRouter } from "@bound/llm";
import { resolveModel } from "./model-resolution";

/**
 * Returns the counts of recent tool calls in a thread.
 * Tool names are stored in messages.tool_name (e.g., "server-toolName").
 */
export function getRecentToolCalls(
	db: Database,
	threadId: string,
	limit = 20,
): { toolName: string; count: number }[] {
	const rows = db
		.query(
			`SELECT tool_name, COUNT(*) as count
			 FROM messages
			 WHERE thread_id = ? AND tool_name IS NOT NULL
			 GROUP BY tool_name
			 ORDER BY MAX(created_at) DESC
			 LIMIT ?`,
		)
		.all(threadId, limit) as Array<{ tool_name: string; count: number }>;

	return rows.map((r) => ({ toolName: r.tool_name, count: r.count }));
}

/**
 * Determines whether to delegate the agent loop to a remote host.
 *
 * Returns the target EligibleHost if all AC6.1 conditions hold:
 * 1. Model resolves to a single remote host
 * 2. That host has ≥50% of the thread's recent tool calls in its mcp_tools
 *
 * Returns null to run locally (AC6.5).
 */
export function getDelegationTarget(
	db: Database,
	threadId: string,
	modelId: string | undefined,
	modelRouter: ModelRouter,
	localSiteId: string,
): EligibleHost | null {
	const resolution = resolveModel(modelId, modelRouter, db, localSiteId);

	// Condition 1: model must be remote
	if (resolution.kind !== "remote") return null;

	// Condition 1b: exactly one host has the model
	if (resolution.hosts.length !== 1) return null;

	const targetHost = resolution.hosts[0];

	// Condition 2: ≥50% of recent tools on that host
	const recentTools = getRecentToolCalls(db, threadId, 20);
	const totalToolCalls = recentTools.reduce((sum, t) => sum + t.count, 0);

	// AC6.7: vacuous match — no tool call history → delegate
	if (totalToolCalls === 0) return targetHost;

	// Look up target host's mcp_tools
	const hostRow = db
		.query("SELECT mcp_tools FROM hosts WHERE site_id = ? AND deleted = 0")
		.get(targetHost.site_id) as { mcp_tools: string | null } | null;

	if (!hostRow?.mcp_tools) return null; // Host has no tools — can't match 50%

	let targetMcpTools: string[];
	try {
		targetMcpTools = JSON.parse(hostRow.mcp_tools);
	} catch {
		return null;
	}

	const targetToolCalls = recentTools
		.filter((t) => targetMcpTools.includes(t.toolName))
		.reduce((sum, t) => sum + t.count, 0);

	if (targetToolCalls / totalToolCalls < 0.5) return null; // AC6.5: condition unmet

	return targetHost;
}
```

**Testing:**
Tests must verify each AC listed:
- AC6.1: Create thread with 4 tool calls (3 on target host's mcp_tools, 1 elsewhere) + remote model → verify delegation target returned.
- AC6.5 (condition unmet): Remote model but 2 hosts → returns null. OR remote model + only 30% tools on target → returns null.
- AC6.7: Thread with no tool calls + remote model + single host → returns target (vacuous match).

Test file: `packages/agent/src/__tests__/delegation.test.ts` (create new).

**Verification:**
Run: `bun test packages/agent/src/__tests__/delegation.test.ts`
Expected: All tests pass

Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add getDelegationTarget and getRecentToolCalls for loop delegation`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Delegation dispatch in `message:created` handler

**Verifies:** inference-relay.AC6.1, inference-relay.AC6.4, inference-relay.AC6.5

**Files:**
- Modify: `packages/cli/src/commands/start.ts` (message:created event handler at lines ~501-565)

**Implementation:**

In the `message:created` event handler (lines ~501-565), insert delegation logic BEFORE the existing `AgentLoop` instantiation:

```typescript
appContext.eventBus.on("message:created", async ({ message, thread_id }) => {
    if (message.role !== "user") return;
    if (!modelRouter) {
        console.warn("[agent] No model router configured, cannot process message");
        return;
    }
    if (activeLoops.has(thread_id)) {
        console.log(`[agent] Loop already active for thread ${thread_id}, skipping`);
        return;
    }

    activeLoops.add(thread_id);
    console.log(`[agent] Processing message in thread ${thread_id}`);

    try {
        const selectedModelId = message.model_id || undefined;
        const activeModelId = selectedModelId || routerConfig.default;

        // AC6.1: Check delegation conditions
        const delegationTarget = getDelegationTarget(
            appContext.db,
            thread_id,
            activeModelId,
            modelRouter,
            appContext.siteId,
        );

        if (delegationTarget) {
            // Delegate entire loop to remote host
            await dispatchDelegation(
                appContext,
                delegationTarget,
                thread_id,
                message.id,
                message.user_id || appContext.config.allowlist.default_web_user,
                null, // platform = null for web UI delegation
                statusForwardCache,
            );
        } else {
            // AC6.5: Run locally
            const agentLoop = new AgentLoop(appContext, sandbox?.bash ?? ({} as any), modelRouter, {
                threadId: thread_id,
                userId: message.user_id || appContext.config.allowlist.default_web_user,
                modelId: activeModelId,
            });
            const result = await agentLoop.run();
            // ... existing error handling, title generation, etc.
        }
    } finally {
        activeLoops.delete(thread_id);
    }
});
```

Add the `getDelegationTarget` import and create `dispatchDelegation()` inline or as a helper function. `dispatchDelegation()` writes a `process` relay message to the outbox and then polls (similar to RELAY_WAIT) until the thread has a new assistant message (indicating the delegated loop completed):

```typescript
async function dispatchDelegation(
    ctx: AppContext,
    targetHost: EligibleHost,
    threadId: string,
    messageId: string,
    userId: string,
    platform: string | null,
    statusForwardCache: Map<string, StatusForwardPayload>,
): Promise<void> {
    const processPayload: ProcessPayload = { thread_id: threadId, message_id: messageId, user_id: userId, platform };
    const outboxEntry = createRelayOutboxEntry(
        targetHost.site_id,
        "process",
        JSON.stringify(processPayload),
        5 * 60 * 1000, // 5 minute timeout for delegated loop
    );
    writeOutbox(ctx.db, outboxEntry);
    ctx.eventBus.emit("sync:trigger", { reason: "delegation" });

    // Poll until new assistant message appears in thread (loop completed on remote)
    const POLL_INTERVAL_MS = 1000;
    const TIMEOUT_MS = 5 * 60 * 1000;
    const startTime = Date.now();
    const initialMessageCount = getThreadMessageCount(ctx.db, threadId);

    while (true) {
        if (Date.now() - startTime > TIMEOUT_MS) {
            ctx.logger.warn("Delegation timeout — no response received", { threadId });
            break;
        }
        const currentCount = getThreadMessageCount(ctx.db, threadId);
        if (currentCount > initialMessageCount) break; // Response arrived via sync

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}
```

Also update the cancel endpoint in `status.ts` to write a relay cancel for delegated loops. Check if `thread_id` is in an active delegation (simple Set tracking) and if so, write cancel relay message alongside the local event.

**Verification:**
Run: `tsc -p packages/cli --noEmit`
Expected: No type errors

**Commit:** `feat(cli): add delegation dispatch in message:created handler`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: `process` case in `RelayProcessor` + `status_forward` emission

**Verifies:** inference-relay.AC6.2, inference-relay.AC6.3, inference-relay.AC6.6

**Files:**
- Modify: `packages/agent/src/relay-processor.ts` (constructor, processEntry() switch, processPendingEntries())

**Implementation:**

**Part A: Add `eventBus` to RelayProcessor constructor**

RelayProcessor needs to emit status events back to the originating host. Add `eventBus: TypedEventEmitter` as a new constructor parameter (after `logger`, before `relayConfig`):

```typescript
constructor(
    private db: Database,
    private siteId: string,
    private mcpClients: Map<string, MCPClient>,
    private modelRouter: ModelRouter | null,
    private keyringSiteIds: Set<string>,
    private logger: Logger,
    private eventBus: TypedEventEmitter,
    private relayConfig?: RelayConfig,
) {}
```

Update the RelayProcessor instantiation in `start.ts` to pass `appContext.eventBus`.

**Part B: Add `process` case to processEntry() switch**

```typescript
case "process": {
    const processPayload = JSON.parse(entry.payload) as ProcessPayload;
    // Fire-and-forget: executeProcess() runs the agent loop asynchronously
    this.executeProcess(entry, processPayload).catch((err) => {
        this.logger.error("executeProcess failed", { error: err, entryId: entry.id });
    });
    response = null; // Chunks written directly
    break;
}
```

**Part C: Add `status_forward` case to processEntry() switch**

`status_forward` entries come from a processing host back to the originating host. The originating host's RelayProcessor handles them by emitting a local event:

```typescript
case "status_forward": {
    const fwdPayload = JSON.parse(entry.payload) as StatusForwardPayload;
    // Emit locally so the web server can cache and serve it.
    // "status:forward" is added to the TypedEventEmitter event map in Phase 1 Task 9
    // (packages/shared/src/types.ts) — no type assertion needed here.
    this.eventBus.emit("status:forward", fwdPayload);
    response = null;
    break;
}
```

The `"status:forward"` event is defined in the TypedEventEmitter event map as part of Phase 1 Task 9. This ensures type safety when emitting and listening. The event map entry to add:

```typescript
// In TypedEventEmitter event definitions (shared/src/types.ts):
"status:forward": (payload: StatusForwardPayload) => void;
```

**Part D: `executeProcess()` private method**

```typescript
private async executeProcess(
    entry: RelayInboxEntry,
    payload: ProcessPayload,
): Promise<void> {
    if (!this.modelRouter) {
        this.writeResponse(
            entry,
            "error",
            JSON.stringify({ error: "No model router configured", retriable: false }),
        );
        return;
    }

    // Look up user message
    const userMessage = this.db
        .query("SELECT * FROM messages WHERE id = ? AND thread_id = ? AND deleted = 0")
        .get(payload.message_id, payload.thread_id) as Message | null;

    if (!userMessage) {
        this.writeResponse(
            entry,
            "error",
            JSON.stringify({ error: `Message not found: ${payload.message_id}`, retriable: false }),
        );
        return;
    }

    // For the delegated AgentLoop, use the full AppContext passed to RelayProcessor.
    // This requires adding `appCtx: AppContext` to the RelayProcessor constructor
    // (replacing the individual db/siteId/logger fields, or alongside them).
    //
    // Update the RelayProcessor constructor in Task 1 of Phase 7 to accept:
    //   private appCtx: AppContext
    // and derive db, siteId, logger from appCtx:
    //   private get db() { return this.appCtx.db; }
    //   private get siteId() { return this.appCtx.siteId; }
    //   private get logger() { return this.appCtx.logger; }
    //
    // Then update the start.ts instantiation to pass `appContext` directly.
    // This avoids the `as AppContext` cast and ensures the delegated loop has
    // access to the full config, optionalConfig, hostName, etc.
    const delegatedCtx = this.appCtx; // full AppContext — no casting needed

    // Emit status_forward on each AgentLoop state change
    const emitStatusForward = (status: string, detail: string | null, tokens: number): void => {
        const fwdPayload: StatusForwardPayload = {
            thread_id: payload.thread_id,
            status,
            detail,
            tokens,
        };
        const outboxEntry = createRelayOutboxEntry(
            entry.source_site_id,
            "status_forward",
            JSON.stringify(fwdPayload),
            5 * 60 * 1000,
        );
        try {
            writeOutbox(this.db, outboxEntry);
            this.eventBus.emit("sync:trigger", { reason: "status-forward" });
        } catch {
            // Non-fatal
        }
    };

    // Run delegated agent loop
    // Note: AgentLoop constructor will need a status callback added for Phase 7 wiring.
    // For now, emit status_forward at start and end.
    emitStatusForward("thinking", null, 0);

    try {
        const agentLoop = new AgentLoop(
            delegatedCtx,
            {} as any,  // No sandbox on delegated target (confirmed tools will block via autonomous mode)
            this.modelRouter,
            {
                threadId: payload.thread_id,
                userId: payload.user_id,
                taskId: `delegated-${entry.id}`,  // taskId starts with "delegated-" → confirmed tools blocked
            },
        );

        const result = await agentLoop.run();
        emitStatusForward("idle", null, 0);

        if (result.error) {
            this.writeResponse(
                entry,
                "error",
                JSON.stringify({ error: result.error, retriable: false }),
            );
        }
    } catch (err) {
        emitStatusForward("idle", null, 0);
        this.writeResponse(
            entry,
            "error",
            JSON.stringify({ error: String(err), retriable: false }),
        );
    }
}
```

Note on confirmed tools (AC6.6): The `taskId = "delegated-{id}"` does NOT start with `"interactive-"`, so confirmed tools will return block errors per the existing check in mcp-bridge.ts:111-118. This is the intended behavior.

**Verification:**
Run: `tsc -p packages/agent --noEmit && tsc -p packages/cli --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add process case to RelayProcessor, execute delegated agent loop`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->

<!-- START_TASK_4 -->
### Task 4: Status forward cache and extended `/api/threads/{id}/status`

**Verifies:** inference-relay.AC6.3

**Files:**
- Modify: `packages/web/src/server/routes/threads.ts` (the `/api/threads/{id}/status` endpoint at lines ~116-160)
- Modify: `packages/cli/src/commands/start.ts` (create statusForwardCache, wire event listener, pass to route)

**Implementation:**

**Part A: Create statusForwardCache in start.ts**

```typescript
// Ephemeral cache for status_forward payloads from delegated loops
const statusForwardCache = new Map<string, StatusForwardPayload>();

// Listen for status:forward events from RelayProcessor
// "status:forward" is defined in the TypedEventEmitter event map (Phase 1 Task 9)
appContext.eventBus.on("status:forward", (payload: StatusForwardPayload) => {
    statusForwardCache.set(payload.thread_id, payload);
});
```

Pass `statusForwardCache` to `createThreadRoutes()` (see Part B).

**Part B: Update createThreadRoutes() to accept status cache**

Update the function signature in `threads.ts`:

```typescript
export function createThreadRoutes(
    db: Database,
    eventBus: TypedEventEmitter,
    statusForwardCache: Map<string, StatusForwardPayload>, // <-- new
): Hono {
```

Update the `/api/threads/{id}/status` endpoint (lines ~116-160) to also return forwarded status if available:

```typescript
app.get("/:id/status", (c) => {
    const { id } = c.req.param();

    // ... existing thread validation ...

    // Check for forwarded status (delegated loops)
    const forwarded = statusForwardCache.get(id);

    const runningTask = db.query(
        "SELECT id FROM tasks WHERE thread_id = ? AND status = 'running' LIMIT 1",
    ).get(id) as { id: string } | null;

    const isActive = !!runningTask || (forwarded?.status === "thinking" || forwarded?.status === "tool_call");

    return c.json({
        active: isActive,
        state: forwarded?.status ?? (runningTask ? "running" : null),
        detail: forwarded?.detail ?? null,    // e.g., tool name
        tokens: forwarded?.tokens ?? 0,
        model: defaultModel,
    });
});
```

**Verification:**
Run: `tsc -p packages/web --noEmit && tsc -p packages/cli --noEmit`
Expected: No type errors

Add unit tests to `packages/web/src/server/__tests__/threads-status.test.ts`:
- `/api/threads/{id}/status` with no forwarded status → `{ active: false, state: null, detail: null }`
- With forwarded status `{ status: "thinking", detail: null, tokens: 150 }` → `{ active: true, state: "thinking", detail: null, tokens: 150 }`
- With forwarded status `{ status: "tool_call", detail: "bash" }` → `{ active: true, state: "tool_call", detail: "bash" }`
- After idle forwarded → `{ active: false, state: "idle" }`

**Commit:** `feat(web): extend /api/threads/:id/status with status_forward cache for delegated loops`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Cancel propagation for delegated loops

**Verifies:** inference-relay.AC6.4

**Files:**
- Modify: `packages/web/src/server/routes/status.ts` (the cancel endpoint at lines ~95-155)
- Modify: `packages/cli/src/commands/start.ts` (track active delegations for cancel routing)

**Implementation:**

**Part A: Track active delegations**

In start.ts, alongside `activeLoops`, track active delegations:

```typescript
const activeLoops = new Set<string>(); // local loops
const activeDelegations = new Map<string, { targetSiteId: string; processOutboxId: string }>(); // delegated loops
```

In `dispatchDelegation()` (from Task 2), set `activeDelegations.set(threadId, { targetSiteId: targetHost.site_id, processOutboxId: outboxEntry.id })` before the polling loop, and `activeDelegations.delete(threadId)` when done.

**Part B: Update cancel endpoint to propagate to delegated target**

In status.ts, the cancel endpoint currently:
1. Validates thread
2. Persists cancel message
3. Emits `agent:cancel` event

For delegated loops, also write a relay cancel. But status.ts doesn't have access to delegations. Pass `activeDelegations` as a parameter to `createStatusRoutes()`:

```typescript
export function createStatusRoutes(
    db: Database,
    eventBus: TypedEventEmitter,
    hostName: string,
    modelsConfig?: ModelsConfig,
    activeDelegations?: Map<string, { targetSiteId: string; processOutboxId: string }>,
): Hono {
```

In the cancel endpoint, after the existing `eventBus.emit("agent:cancel", ...)` call:

```typescript
// AC6.4: Propagate cancel to delegated processing host
const delegation = activeDelegations?.get(threadId);
if (delegation) {
    const cancelEntry = createRelayOutboxEntry(
        delegation.targetSiteId,
        "cancel",
        JSON.stringify({}),
        30_000,
        delegation.processOutboxId, // ref_id matches the process message
    );
    try {
        writeOutbox(db, cancelEntry);
        eventBus.emit("sync:trigger" as any, { reason: "delegation-cancel" });
    } catch {
        // Non-fatal
    }
}
```

**Verification:**
Run: `tsc -p packages/web --noEmit && tsc -p packages/cli --noEmit`
Expected: No type errors

**Commit:** `feat(web): propagate cancel to processing host for delegated loops`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 6-7) -->

<!-- START_TASK_6 -->
### Task 6: Unit tests for delegation decision logic

**Verifies:** inference-relay.AC6.1, inference-relay.AC6.5, inference-relay.AC6.7

**Files:**
- Modify: `packages/agent/src/__tests__/delegation.test.ts`

**Implementation:**

Complete the delegation test file. Tests use real SQLite databases with `applySchema()`. A `MockModelRouter` wraps a mock backend for the local model and returns remote hosts from `resolveModel()` using a pre-populated `hosts` table.

Tests must verify each AC listed:
- **AC6.1**: Thread has 12 tool calls: 8 matching target host's mcp_tools, 4 on other hosts. Remote model on single host. `getDelegationTarget()` returns target host.
- **AC6.5 (two hosts)**: Two eligible remote hosts → `getDelegationTarget()` returns null.
- **AC6.5 (tool mismatch)**: Single remote host, only 30% tools match → returns null.
- **AC6.5 (local model)**: Local model → returns null.
- **AC6.7**: Thread with 0 tool calls, remote model, single host → returns target (vacuous match).

**Verification:**
Run: `bun test packages/agent/src/__tests__/delegation.test.ts`
Expected: All tests pass

**Commit:** `test(agent): add unit tests for getDelegationTarget`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Playwright e2e tests for delegation

**Verifies:** inference-relay.AC6.1, inference-relay.AC6.2, inference-relay.AC6.3, inference-relay.AC6.4, inference-relay.AC6.5

**Files:**
- Create: `e2e/delegation.spec.ts`

**Implementation:**

Playwright tests run against a live server. These tests use route interception to simulate delegation without requiring a second running instance.

**Test 7a: "status indicator shows remote processing" (AC6.3)**

Use `page.route()` to intercept `/api/threads/{id}/status` and return:
```json
{ "active": true, "state": "thinking", "detail": null, "tokens": 0, "model": "remote-model" }
```

Verify: The thread UI shows a "LIVE" badge or thinking indicator.

Update response to `{ "active": false, "state": "idle" }`. Verify: Badge disappears.

**Test 7b: "cancel button sends cancel to delegated host" (AC6.4)**

Set up route intercept for the cancel endpoint to capture the request.
Click the cancel button in the thread UI.
Verify: Cancel endpoint was called with the correct threadId.

**Test 7c: "no delegation when conditions unmet" (AC6.5)**

Send a message to a thread with a local model. Verify: The response appears normally (no delegation failure).

**Verification:**
Run: `bun run test:e2e -- --grep "delegation"`
Expected: All tests pass

**Commit:** `test(e2e): add Playwright tests for delegation status and cancel`
<!-- END_TASK_7 -->

<!-- END_SUBCOMPONENT_C -->

---

## Phase Completion Verification

After all 7 tasks are committed:

Run all affected package tests:
```bash
bun test packages/agent
bun test packages/web
```
Expected: All tests pass.

Run typechecks:
```bash
tsc -p packages/shared --noEmit
tsc -p packages/agent  --noEmit
tsc -p packages/web    --noEmit
tsc -p packages/cli    --noEmit
```
Expected: Zero type errors.

Run Playwright tests:
```bash
bun run test:e2e -- --grep "delegation|model selector"
```
Expected: All e2e tests pass.

Confirm AC6.1–AC6.7 coverage via test output.
