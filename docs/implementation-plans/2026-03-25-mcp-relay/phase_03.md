# MCP Relay Transport — Phase 3: Tool Routing + RELAY_WAIT

**Goal:** Replace `proxyToolCall()` with relay-based tool routing and add a RELAY_WAIT sub-state to the agent loop for transparent remote tool execution.

**Architecture:** When the agent encounters a remote tool call, it writes a relay request to the outbox, triggers an immediate sync, then polls the inbox for a matching response. The RELAY_WAIT sub-state handles timeout with host failover, cancel propagation, and activity status. `proxyToolCall()` is replaced — all remote tool calls now flow through the relay outbox/inbox.

**Tech Stack:** TypeScript, bun:sqlite, TypedEventEmitter

**Scope:** 8 phases from original design (phase 3 of 8)

**Codebase verified:** 2026-03-25

---

## Acceptance Criteria Coverage

This phase implements and tests:

### mcp-relay.AC1: Cross-host MCP calls via relay
- **mcp-relay.AC1.6 Failure:** Tool call to nonexistent tool returns "tool not available" error
- **mcp-relay.AC1.7 Failure:** Tool call to offline host (stale sync) returns "tool not reachable" with host name and staleness

### mcp-relay.AC6: RELAY_WAIT transparency
- **mcp-relay.AC6.1 Success:** Agent loop enters RELAY_WAIT for remote tools, returns same CommandResult as local
- **mcp-relay.AC6.2 Success:** Activity status shows `"relaying {tool_name} via {host_name}"` during wait
- **mcp-relay.AC6.3 Success:** Timeout on first host triggers failover to next eligible host
- **mcp-relay.AC6.4 Failure:** All eligible hosts exhausted returns error to agent
- **mcp-relay.AC6.5 Edge:** Immediate sync triggered on RELAY_WAIT entry (doesn't wait for scheduled sync)

### mcp-relay.AC7: Cancel propagation
- **mcp-relay.AC7.1 Success:** User cancel during RELAY_WAIT sends cancel message to target and stops waiting
- **mcp-relay.AC7.2 Success:** Cancel message references original request via `ref_id`

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add sync trigger event and immediate sync support

**Files:**
- Modify: `packages/shared/src/events.ts` (add `sync:trigger` event)
- Modify: `packages/sync/src/sync-loop.ts:262-302` (listen for trigger event in `startSyncLoop`)

**Implementation:**

Add a new `sync:trigger` event to the `EventMap` in `packages/shared/src/events.ts`:

```typescript
// Add to EventMap interface:
"sync:trigger": { reason: string };
```

Modify `startSyncLoop()` in `packages/sync/src/sync-loop.ts` to listen for this event and run an immediate sync cycle when triggered. The current implementation uses recursive `setTimeout`. Add an event listener that clears the pending timeout, runs a sync cycle immediately, then resumes the normal schedule.

```typescript
// Inside startSyncLoop(), after setting up the scheduled loop:
eventBus.on("sync:trigger", async ({ reason }) => {
	logger.debug("Immediate sync triggered", { reason });
	if (pendingTimeout) {
		clearTimeout(pendingTimeout);
		pendingTimeout = null;
	}
	await syncClient.syncCycle();
	scheduleNext(); // Resume normal scheduling
});
```

This requires refactoring `startSyncLoop()` to expose `pendingTimeout` and `scheduleNext()` as local variables accessible by the event handler. The existing recursive setTimeout pattern should be extracted into a named `scheduleNext()` function.

**Verification:**

Run: `tsc -p packages/sync --noEmit && tsc -p packages/shared --noEmit`
Expected: No type errors.

**Commit:** `feat(shared,sync): add sync:trigger event for immediate out-of-cycle sync`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add RELAY_WAIT state and relay routing types

**Files:**
- Modify: `packages/agent/src/types.ts:1-13` (add RELAY_WAIT state)
- Create: `packages/agent/src/relay-router.ts` (relay routing logic extracted from mcp-bridge)

**Implementation:**

Add `RELAY_WAIT` to the agent loop state union in `packages/agent/src/types.ts`. Note: `AWAIT_POLL` already exists and could be reused, but RELAY_WAIT has distinct semantics (relay-specific polling with failover).

```typescript
// Update AgentLoopState union to include:
| "RELAY_WAIT"
```

Create `packages/agent/src/relay-router.ts` with the relay routing logic. This module handles:
1. Querying `hosts.mcp_tools` to find which hosts advertise a tool
2. Filtering by sync recency (exclude hosts not seen within a configurable threshold)
3. Ordering by `online_at` descending (most recently synced first)
4. Generating the outbox entry for the selected target

```typescript
import type { Database } from "bun:sqlite";
import type { RelayOutboxEntry, ToolCallPayload, RelayConfig } from "@bound/shared";
import { writeOutbox } from "@bound/core";
import { createHash } from "crypto";

interface EligibleHost {
	site_id: string;
	host_name: string;
	sync_url: string | null;
	online_at: string | null;
}

export interface RelayRoutingResult {
	ok: true;
	hosts: EligibleHost[];
}

export interface RelayRoutingError {
	ok: false;
	error: string;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export function findEligibleHosts(
	db: Database,
	toolCommandName: string,
	localSiteId: string,
): RelayRoutingResult | RelayRoutingError {
	const rows = db
		.query(
			`SELECT site_id, host_name, sync_url, mcp_tools, online_at
			 FROM hosts
			 WHERE deleted = 0 AND site_id != ?`,
		)
		.all(localSiteId) as Array<{
		site_id: string;
		host_name: string;
		sync_url: string | null;
		mcp_tools: string | null;
		online_at: string | null;
	}>;

	const eligible: EligibleHost[] = [];
	for (const row of rows) {
		if (!row.mcp_tools) continue;
		const tools: string[] = JSON.parse(row.mcp_tools);
		if (!tools.includes(toolCommandName)) continue;
		eligible.push({
			site_id: row.site_id,
			host_name: row.host_name,
			sync_url: row.sync_url,
			online_at: row.online_at,
		});
	}

	if (eligible.length === 0) {
		return { ok: false, error: `Tool "${toolCommandName}" not available on any remote host` };
	}

	// Sort by online_at descending (most recent first), nulls last
	eligible.sort((a, b) => {
		if (!a.online_at && !b.online_at) return 0;
		if (!a.online_at) return 1;
		if (!b.online_at) return -1;
		return new Date(b.online_at).getTime() - new Date(a.online_at).getTime();
	});

	return { ok: true, hosts: eligible };
}

export function isHostStale(host: EligibleHost): boolean {
	if (!host.online_at) return true;
	return Date.now() - new Date(host.online_at).getTime() > STALE_THRESHOLD_MS;
}

export function buildIdempotencyKey(
	kind: string,
	toolName: string,
	args: Record<string, unknown>,
): string {
	const roundedTimestamp = Math.floor(Date.now() / 60_000) * 60_000;
	const data = JSON.stringify({ kind, toolName, args, ts: roundedTimestamp });
	return createHash("sha256").update(data).digest("hex").slice(0, 32);
}

export function createRelayOutboxEntry(
	targetSiteId: string,
	kind: string,
	payload: string,
	timeoutMs: number,
	refId?: string,
	idempotencyKey?: string,
): Omit<RelayOutboxEntry, "delivered"> {
	const now = new Date();
	return {
		id: crypto.randomUUID(),
		source_site_id: null,
		target_site_id: targetSiteId,
		kind,
		ref_id: refId ?? null,
		idempotency_key: idempotencyKey ?? null,
		payload,
		created_at: now.toISOString(),
		expires_at: new Date(now.getTime() + timeoutMs).toISOString(),
	};
}
```

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No type errors.

**Commit:** `feat(agent): add RELAY_WAIT state and relay routing module`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Replace proxyToolCall with relay routing in MCP bridge

**Verifies:** mcp-relay.AC1.6, mcp-relay.AC1.7

**Files:**
- Modify: `packages/agent/src/mcp-bridge.ts:38-136` (replace proxyToolCall internals)
- Modify: `packages/agent/src/mcp-bridge.ts:234-323` (update generateRemoteMCPCommands)

**Implementation:**

Replace the body of `proxyToolCall()` (or create a new `relayToolCall()` function) to use relay routing instead of direct HTTP. The function:

1. Calls `findEligibleHosts()` to discover which hosts have the tool
2. Returns `{ content: "tool not available", isError: true }` if no hosts found (AC1.6)
3. Checks recency of best host — if all are stale, returns `{ content: "tool not reachable: {host_name} last seen {staleness}", isError: true }` (AC1.7)
4. Writes a relay outbox entry via `writeOutbox()`
5. Returns the outbox entry ID and target info for the caller (agent loop) to enter RELAY_WAIT

The remote MCP command handler in `generateRemoteMCPCommands()` should be updated to return a special signal (e.g., a CommandResult with a `relayRequest` metadata field) that the agent loop recognizes as requiring RELAY_WAIT. Alternatively, the command handler can write to outbox and return a sentinel CommandResult that triggers RELAY_WAIT in the agent loop.

Design the interface so the agent loop's `executeToolCall()` method can detect "this is a relay call" and enter RELAY_WAIT:

```typescript
export interface RelayToolCallRequest {
	outboxEntryId: string;
	targetSiteId: string;
	targetHostName: string;
	toolName: string;
	eligibleHosts: EligibleHost[];
	currentHostIndex: number;
}
```

The command handler returns a discriminated union type `CommandResult | RelayToolCallRequest` instead of overloading exit codes. Add a type guard `isRelayRequest(result): result is RelayToolCallRequest` that checks for the `outboxEntryId` field. The agent loop's `executeToolCall()` method uses this type guard before persisting the tool result, and enters RELAY_WAIT if it matches.

```typescript
export function isRelayRequest(
	result: CommandResult | RelayToolCallRequest,
): result is RelayToolCallRequest {
	return "outboxEntryId" in result;
}
```

**Testing:**

Tests must verify:
- **mcp-relay.AC1.6:** Call relay routing with a tool name not advertised by any host → returns "tool not available" error
- **mcp-relay.AC1.7:** Call relay routing where all hosts with the tool have `online_at` older than 5 minutes → returns "tool not reachable" with host name and staleness info

Additional tests:
- Hosts with `deleted = 1` are excluded from routing
- Hosts sorted by `online_at` descending (most recent first)
- Local host (own siteId) excluded from routing
- Idempotency key is deterministic for same inputs within same minute

**Verification:**

Run: `bun test packages/agent`
Expected: All existing + new tests pass.

**Commit:** `feat(agent): replace proxyToolCall with relay-based tool routing`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Implement RELAY_WAIT in agent loop

**Verifies:** mcp-relay.AC6.1, mcp-relay.AC6.2, mcp-relay.AC6.3, mcp-relay.AC6.4, mcp-relay.AC6.5, mcp-relay.AC7.1, mcp-relay.AC7.2

**Files:**
- Modify: `packages/agent/src/agent-loop.ts:168-300` (add RELAY_WAIT handling within TOOL_EXECUTE)

**Implementation:**

Within the TOOL_EXECUTE phase, after `executeToolCall()` returns, check if the result is a `RelayToolCallRequest` using the `isRelayRequest()` type guard. If so, enter RELAY_WAIT:

1. **Extract relay request** fields from the `RelayToolCallRequest` object
2. **Emit `sync:trigger`** event for immediate sync (AC6.5)
3. **Set activity status** to `"relaying {tool_name} via {host_name}"` (AC6.2) via task heartbeat update
4. **Poll loop**: Every 500ms, call `readInboxByRefId(db, outboxEntryId)` to check for a response
   - If response found with kind `"result"`: parse `ResultPayload`, create CommandResult, mark inbox entry as processed → return as if local tool execution (AC6.1)
   - If response found with kind `"error"`: parse `ErrorPayload`, create error CommandResult, mark processed
   - If `this.aborted` becomes true (cancel): write cancel relay message, stop polling (AC7.1, AC7.2)
   - If timeout exceeded (from `expires_at`): try next eligible host via failover (AC6.3)
5. **Failover**: Increment `currentHostIndex`, write new outbox entry for next host, trigger sync again, resume polling. If all hosts exhausted, return error CommandResult (AC6.4).

Cancel handling during RELAY_WAIT:

```typescript
// When this.aborted is detected during RELAY_WAIT:
const cancelEntry = createRelayOutboxEntry(
	targetSiteId,
	"cancel",
	JSON.stringify({}),
	30_000,
	outboxEntryId, // ref_id references original request (AC7.2)
);
writeOutbox(db, cancelEntry);
this.ctx.eventBus.emit("sync:trigger", { reason: "relay-cancel" });
// Return cancellation CommandResult
```

The polling uses a simple `setTimeout`-based loop within an async function. Each poll iteration checks `readInboxByRefId()`, `this.aborted`, and the timeout.

**Cache-warm reassembly**: When waiting for a `cache_warm` response, the target may split large responses into multiple result messages (one per file, each with the same `ref_id`). RELAY_WAIT must collect ALL result messages matching the `ref_id` before returning. Poll until either (a) an error response arrives, (b) timeout, or (c) a result with a `complete: true` field in the payload arrives (the target marks the final chunk). Concatenate payloads from all collected results.

**Testing:**

Tests must verify:
- **mcp-relay.AC6.1:** Agent loop receives relay sentinel → enters RELAY_WAIT → response arrives in inbox → returns same CommandResult shape as local execution
- **mcp-relay.AC6.2:** During RELAY_WAIT, activity status includes tool name and host name
- **mcp-relay.AC6.3:** First host times out → agent writes new outbox entry for second host → triggers sync → polls for response from second host
- **mcp-relay.AC6.4:** All hosts time out → agent returns error CommandResult with descriptive message
- **mcp-relay.AC6.5:** On RELAY_WAIT entry, `sync:trigger` event is emitted
- **mcp-relay.AC7.1:** Cancel during RELAY_WAIT → cancel outbox entry written → polling stops
- **mcp-relay.AC7.2:** Cancel entry's `ref_id` matches the original request's outbox entry ID

Use mock patterns from `packages/agent/src/__tests__/agent-loop.test.ts`: MockLLMBackend, mock database with applySchema(), mock eventBus. For relay tests, pre-populate relay_inbox with expected responses to test the polling path without actual sync.

**Verification:**

Run: `bun test packages/agent`
Expected: All existing + new tests pass.

**Commit:** `feat(agent): implement RELAY_WAIT sub-state with polling, failover, and cancel`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5) -->
<!-- START_TASK_5 -->
### Task 5: Relay routing and RELAY_WAIT tests

**Verifies:** mcp-relay.AC1.6, mcp-relay.AC1.7, mcp-relay.AC6.1, mcp-relay.AC6.2, mcp-relay.AC6.3, mcp-relay.AC6.4, mcp-relay.AC6.5, mcp-relay.AC7.1, mcp-relay.AC7.2

**Files:**
- Create: `packages/agent/src/__tests__/relay-router.test.ts` (unit)
- Create: `packages/agent/src/__tests__/relay-wait.test.ts` (unit)

**Testing:**

**relay-router.test.ts** — Unit tests for the relay routing module:

Follow test patterns from `packages/agent/src/__tests__/agent-loop.test.ts`: temp database with `applySchema()`, cleanup in afterEach.

- **mcp-relay.AC1.6:** Insert hosts with `mcp_tools` that do NOT include the requested tool → `findEligibleHosts()` returns error with "not available"
- **mcp-relay.AC1.7:** Insert hosts where all matching hosts have `online_at` > 5 minutes ago → `isHostStale()` returns true, routing reports "not reachable" with host name and time since last seen
- Host with `deleted = 1` excluded from results
- Local siteId excluded from results
- Multiple eligible hosts sorted by `online_at` descending
- `buildIdempotencyKey()` returns same hash for same inputs within same minute, different hash for different inputs

**relay-wait.test.ts** — Unit tests for RELAY_WAIT behavior:

Use mock database pre-populated with relay tables. Test the polling logic in isolation (without full agent loop):

- **mcp-relay.AC6.1:** Write response entry to relay_inbox → polling finds it → returns CommandResult with matching stdout/stderr/exitCode
- **mcp-relay.AC6.2:** Verify activity status string format during RELAY_WAIT
- **mcp-relay.AC6.3:** First poll times out → failover writes new outbox entry for next host → second host's response found
- **mcp-relay.AC6.4:** All hosts exhaust timeout → returns error CommandResult
- **mcp-relay.AC6.5:** Verify `sync:trigger` event emitted on RELAY_WAIT entry (use mock eventBus)
- **mcp-relay.AC7.1:** Set aborted flag during RELAY_WAIT → cancel outbox entry written → polling stops
- **mcp-relay.AC7.2:** Verify cancel entry's ref_id matches original request ID

**Verification:**

Run: `bun test packages/agent/src/__tests__/relay-router.test.ts`
Run: `bun test packages/agent/src/__tests__/relay-wait.test.ts`
Expected: All tests pass.

Run: `bun test packages/agent`
Expected: All existing + new tests pass.

**Commit:** `test(agent): add relay routing and RELAY_WAIT tests`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_C -->
