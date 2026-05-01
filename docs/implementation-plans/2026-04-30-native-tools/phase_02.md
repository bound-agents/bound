# Native Agent Tools Implementation Plan — Phase 2

**Goal:** Implement the 11 standalone native tools (schedule, cancel, query, emit, await_event, purge, advisory, notify, archive, model_hint, hostinfo) as `RegisteredTool` factories in a new `packages/agent/src/tools/` directory.

**Architecture:** Each tool is a factory function `create*Tool(ctx: ToolContext): RegisteredTool` that closes over the shared context (db, siteId, eventBus, logger, threadId, taskId, modelRouter). The factory returns a `RegisteredTool` with `kind: "builtin"`, a JSON schema `toolDefinition`, and an `execute` handler that receives structured JSON input — eliminating all string-parsing ambiguity from the bash dispatch path. Tool logic is ported directly from the existing command handlers, preserving identical behavior.

**Tech Stack:** TypeScript, bun:test, @bound/agent, @bound/core, @bound/llm, @bound/sandbox

**Scope:** 6 phases from original design (phase 2 of 6)

**Codebase verified:** 2026-04-30

---

## Acceptance Criteria Coverage

This phase implements and tests:

### native-tools.AC2: Standalone agent tools accept structured params
- **native-tools.AC2.1 Success:** `schedule` tool accepts `cron` as a single string field (e.g., `"0,30 * * * *"`) without word-splitting
- **native-tools.AC2.2 Success:** `query` tool accepts `sql` as a single string field containing `=` characters without misparsing
- **native-tools.AC2.3 Success:** `cancel` tool accepts `task_id` and cancels the specified task
- **native-tools.AC2.4 Success:** `emit` tool accepts `event` and `payload` as separate structured fields
- **native-tools.AC2.5 Success:** All 11 standalone tools produce equivalent output to the bash command versions for identical inputs
- **native-tools.AC2.6 Failure:** `schedule` tool rejects cron expression with fewer than 5 fields
- **native-tools.AC2.7 Failure:** Missing required params return descriptive error, not crash

### native-tools.AC1: Unified tool registry dispatches all tool kinds
- **native-tools.AC1.4 Success:** Built-in agent tool call (e.g., schedule, memory) dispatches and returns result

---

<!-- START_TASK_1 -->
### Task 1: Add ToolContext type and createAgentTools stub

**Files:**
- Modify: `packages/agent/src/types.ts`
- Create: `packages/agent/src/tools/index.ts`

**Implementation:**

Add `ToolContext` to `packages/agent/src/types.ts` after the `RegisteredTool` interface. This type extends the fields needed by all agent tool factories:

```typescript
export interface ToolContext {
	db: import("bun:sqlite").Database;
	siteId: string;
	eventBus: import("@bound/shared").TypedEventEmitter;
	logger: { debug: (...args: unknown[]) => void; info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
	threadId?: string;
	taskId?: string;
	modelRouter?: import("@bound/llm").ModelRouter;
}
```

Use inline `import()` types to avoid adding package-level imports that would create circular dependencies. The actual `ToolContext` will be constructed in `agent-factory.ts` from the existing `AppContext` + per-loop config.

Create `packages/agent/src/tools/index.ts` with a stub `createAgentTools()` that returns an empty array (to be filled in subsequent tasks):

```typescript
import type { RegisteredTool, ToolContext } from "../types.js";

export function createAgentTools(ctx: ToolContext): RegisteredTool[] {
	return [];
}
```

Export `createAgentTools` and `ToolContext` from `packages/agent/src/index.ts`.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: Clean typecheck

**Commit:** `feat(agent): add ToolContext type and createAgentTools stub`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Wire createAgentTools into createToolRegistry

**Files:**
- Modify: `packages/cli/src/commands/start/agent-factory.ts`

**Implementation:**

Import `createAgentTools` from `@bound/agent`. In the `createAgentLoopFactory` closure (inside the returned factory function), construct a `ToolContext` from the available context and call `createAgentTools()`:

```typescript
const toolCtx: ToolContext = {
	db: appContext.db,
	siteId: appContext.siteId,
	eventBus: appContext.eventBus,
	logger: appContext.logger,
	threadId: config.threadId,
	taskId: config.taskId,
	modelRouter,
};
const agentTools = createAgentTools(toolCtx);
```

Pass `agentTools` into `createToolRegistry()` — add a new parameter `agentTools: RegisteredTool[]` and register each as `kind: "builtin"` (they already have `kind` set by the factory). In the registry assembly, agent tools are registered after file built-ins and before the sandbox tool:

```typescript
for (const tool of agentTools) {
	const name = tool.toolDefinition.function.name;
	if (registry.has(name)) {
		logger.warn("[tool-registry] Duplicate tool name, keeping first registration", { name });
		continue;
	}
	registry.set(name, tool);
}
```

**Verification:**
Run: `tsc -p packages/cli --noEmit`
Expected: Clean typecheck

**Commit:** `feat(cli): wire createAgentTools into unified tool registry`
<!-- END_TASK_2 -->

<!-- START_SUBCOMPONENT_A (tasks 3-5) -->

<!-- START_TASK_3 -->
### Task 3: Implement schedule tool

**Verifies:** native-tools.AC2.1, native-tools.AC2.6, native-tools.AC2.7

**Files:**
- Create: `packages/agent/src/tools/schedule.ts`
- Modify: `packages/agent/src/tools/index.ts` (add to createAgentTools)

**Implementation:**

Port the logic from `packages/agent/src/commands/schedule.ts` (lines 53-151) into a `createScheduleTool(ctx: ToolContext): RegisteredTool` factory.

The tool definition uses flat JSON parameters — all fields that were previously parsed from `--flag value` bash args become structured JSON properties:

```typescript
parameters: {
	type: "object",
	properties: {
		task_description: { type: "string", description: "What the task should do" },
		cron: { type: "string", description: "Cron expression for recurring tasks (e.g., '0,30 * * * *')" },
		delay: { type: "string", description: "Deferred time offset (e.g., '5m', '2h', '1d')" },
		on_event: { type: "string", description: "Event name for event-driven tasks" },
		payload: { type: "string", description: "Task payload as JSON string" },
		model_hint: { type: "string", description: "Model ID or tier to suggest to scheduler" },
		thread_id: { type: "string", description: "Thread ID for task context" },
		no_history: { type: "boolean", description: "Skip loading conversation history" },
		after: { type: "string", description: "Task ID this depends on" },
		require_success: { type: "boolean", description: "Require dependency to succeed" },
		inject_mode: { type: "string", enum: ["results", "all", "file"], description: "How to inject dependency results" },
		alert_threshold: { type: "integer", description: "Consecutive failures before advisory (default 3)" },
	},
	required: ["task_description"],
}
```

The `execute` handler:
1. Validates exactly one of `cron`, `delay`, or `on_event` is provided
2. For `cron`: validates the expression has 5 space-separated fields (this is the key bug fix — the cron string arrives as a single JSON string, no word-splitting)
3. For `delay`: validates regex `^\d+[mhd]$`, computes `next_run_at`
4. For `on_event`: stores event trigger
5. Optional model validation via `ctx.modelRouter` if available
6. Inserts task via `insertRow()` with all the same fields as the current command handler
7. Returns the task ID string on success, `"Error: ..."` on failure

The `thread_id` parameter replaces the implicit `ctx.threadId` fallback — the tool receives it explicitly. If not provided, falls back to `ctx.threadId`.

Register in `createAgentTools()` by adding `createScheduleTool(ctx)` to the returned array.

**Testing:**
Tests must verify:
- **native-tools.AC2.1:** Pass `cron: "0,30 * * * *"` (contains comma and spaces) — inserts task with correct `trigger_spec.expression` preserving the full string
- **native-tools.AC2.6:** Pass `cron: "0 * *"` (only 3 fields) — returns error
- **native-tools.AC2.7:** Call with no trigger params (no cron, delay, or on_event) — returns descriptive error

Follow existing test patterns: real temp SQLite DB, `applySchema(db)`, seed minimal context.

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/schedule.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): implement native schedule tool with structured cron params`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Implement query tool

**Verifies:** native-tools.AC2.2, native-tools.AC2.7

**Files:**
- Create: `packages/agent/src/tools/query.ts`
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Port logic from `packages/agent/src/commands/query.ts` (lines 122-194). The key improvement: `sql` arrives as a single JSON string field — no `=` character misparsing.

```typescript
parameters: {
	type: "object",
	properties: {
		sql: { type: "string", description: "SQL SELECT query or read-only PRAGMA to execute" },
	},
	required: ["sql"],
}
```

The execute handler preserves all existing validation:
- Only SELECT and allowlisted read-only PRAGMAs
- PRAGMA assignment form rejected
- Auto-append `LIMIT 1000` to SELECTs without LIMIT
- `PRAGMA busy_timeout = 5000` before execution
- TSV output with headers
- 1MB output cap with truncation marker

Port the `SAFE_PRAGMA_ALLOWLIST` array and `isSafePragma()` function from the existing command.

**Testing:**
Tests must verify:
- **native-tools.AC2.2:** Pass `sql: "SELECT * FROM hosts WHERE site_id = 'abc'"` (contains `=`) — executes correctly, returns TSV result
- **native-tools.AC2.7:** Pass empty/missing `sql` — returns descriptive error
- Rejects `INSERT INTO ...` — returns error
- Rejects `PRAGMA journal_mode = WAL` (assignment) — returns error
- Accepts `PRAGMA table_info(hosts)` — returns result

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/query.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): implement native query tool with structured sql param`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Implement cancel tool

**Verifies:** native-tools.AC2.3, native-tools.AC2.7

**Files:**
- Create: `packages/agent/src/tools/cancel.ts`
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Port logic from `packages/agent/src/commands/cancel.ts` (lines 16-68).

```typescript
parameters: {
	type: "object",
	properties: {
		task_id: { type: "string", description: "Task ID to cancel" },
		payload_match: { type: "string", description: "Cancel all tasks matching this payload substring" },
	},
}
```

The execute handler:
- If `payload_match`: LIKE search on `tasks.payload`, cancel all matches via `updateRow()`
- If `task_id`: verify task exists, cancel via `updateRow()`
- Require at least one of the two params

**Testing:**
Tests must verify:
- **native-tools.AC2.3:** Create a pending task, call cancel with its `task_id` — task status becomes `"cancelled"`
- **native-tools.AC2.7:** Call with neither `task_id` nor `payload_match` — returns descriptive error
- Cancel with `payload_match` matching 2 tasks — both cancelled, returns count

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/cancel.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): implement native cancel tool`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 6-8) -->

<!-- START_TASK_6 -->
### Task 6: Implement emit tool

**Verifies:** native-tools.AC2.4, native-tools.AC2.7

**Files:**
- Create: `packages/agent/src/tools/emit.ts`
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Port logic from `packages/agent/src/commands/emit.ts` (lines 15-65).

```typescript
parameters: {
	type: "object",
	properties: {
		event: { type: "string", description: "Event name to emit" },
		payload: { type: "string", description: "Event payload as JSON string (default '{}')" },
	},
	required: ["event"],
}
```

The execute handler:
1. Parse `payload` as JSON (default `"{}"`)
2. Emit locally via `ctx.eventBus.emit(event, payload)`
3. If hub configured (check `cluster_config`): write relay outbox entry via `writeOutbox()` for cross-host broadcast
4. Return `"Event emitted: {event}"`

The `payload` remains a string field (JSON-encoded) rather than an object, matching the existing command's behavior and keeping the schema flat.

**Testing:**
Tests must verify:
- **native-tools.AC2.4:** Pass `event: "test:fired"` and `payload: '{"key": "value"}'` as separate structured fields — event emitted with parsed payload
- **native-tools.AC2.7:** Call with missing `event` — returns descriptive error
- Invalid JSON payload — returns error

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/emit.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): implement native emit tool`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Implement await_event tool

**Verifies:** native-tools.AC2.5, native-tools.AC2.7

**Files:**
- Create: `packages/agent/src/tools/await-event.ts`
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Port logic from `packages/agent/src/commands/await-cmd.ts` (lines 17-88). Named `await_event` to avoid JS reserved word collision. Note: the design table (line 141) abbreviates the params as "event, timeout" — the actual tool waits for task completion, not events, so `task_ids` is the correct primary parameter.

```typescript
parameters: {
	type: "object",
	properties: {
		task_ids: { type: "string", description: "Comma-separated task IDs to wait for" },
		timeout: { type: "integer", description: "Timeout in milliseconds (default 300000)" },
	},
	required: ["task_ids"],
}
```

The execute handler:
1. Split `task_ids` by comma, trim each
2. Poll loop: check each task's status every 2000ms
3. Terminal states: `"completed"`, `"failed"`, `"cancelled"`
4. Timeout default: 300,000ms (5 minutes)
5. Return JSON object `{[taskId]: {status, result, error}}`
6. Truncate output at 50KB

**Testing:**
Tests must verify:
- **native-tools.AC2.5:** Create a completed task, call await_event with its ID — returns immediately with `{status: "completed"}`
- **native-tools.AC2.7:** Call with empty `task_ids` — returns descriptive error
- Not-found task ID — returns `{status: "not_found"}`

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/await-event.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): implement native await_event tool`
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: Implement purge tool

**Verifies:** native-tools.AC2.5, native-tools.AC2.7

**Files:**
- Create: `packages/agent/src/tools/purge.ts`
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Port logic from `packages/agent/src/commands/purge.ts` (lines 15-113).

```typescript
parameters: {
	type: "object",
	properties: {
		message_ids: { type: "string", description: "Comma-separated message IDs to purge" },
		last_n: { type: "integer", description: "Purge the last N messages from the thread" },
		thread_id: { type: "string", description: "Thread ID (defaults to current thread)" },
		summary: { type: "string", description: "Optional summary text for the purge" },
	},
}
```

The execute handler:
1. Resolve target IDs: from `message_ids` (comma-split) or `last_n` with `thread_id`/`ctx.threadId`
2. Tool-pair integrity: for each `tool_call` in targets, auto-include paired `tool_result`
3. Create purge message via `insertRow()` into messages table with `role: "purge"`
4. Return purge summary

**Testing:**
Tests must verify:
- **native-tools.AC2.5:** Create messages, purge with `last_n: 2` — purge message created targeting correct IDs
- **native-tools.AC2.7:** Call with neither `message_ids` nor `last_n` — returns descriptive error

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/purge.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): implement native purge tool`
<!-- END_TASK_8 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 9-11) -->

<!-- START_TASK_9 -->
### Task 9: Implement advisory tool

**Verifies:** native-tools.AC2.5, native-tools.AC2.7

**Files:**
- Create: `packages/agent/src/tools/advisory.ts`
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Port logic from `packages/agent/src/commands/advisory.ts` (lines 36-240). The advisory command has subcommands (create, list, approve, apply, dismiss, defer). In the native tool, these become an `action` parameter — but since Phase 3 handles "grouped tools with action params", and the design doc lists `advisory` as a standalone tool (not grouped), use flat params instead:

```typescript
parameters: {
	type: "object",
	properties: {
		title: { type: "string", description: "Advisory title (for creating)" },
		detail: { type: "string", description: "Advisory detail/description (for creating)" },
		action: { type: "string", description: "Recommended corrective action (for creating)" },
		impact: { type: "string", description: "Impact description (for creating)" },
		list: { type: "boolean", description: "List advisories" },
		list_status: { type: "string", description: "Filter listed advisories by status" },
		approve: { type: "string", description: "Advisory ID prefix to approve" },
		apply: { type: "string", description: "Advisory ID prefix to apply" },
		dismiss: { type: "string", description: "Advisory ID prefix to dismiss" },
		defer: { type: "string", description: "Advisory ID prefix to defer" },
		defer_until: { type: "string", description: "ISO date to defer until (default: 24h from now)" },
	},
}
```

The execute handler checks which operation is requested (mutual exclusivity: exactly one of `title`+`detail`, `list`, `approve`, `apply`, `dismiss`, `defer`). Uses the existing `createAdvisory()`, `approveAdvisory()`, `applyAdvisory()`, `dismissAdvisory()`, `deferAdvisory()` functions from `packages/agent/src/advisories.ts`.

**Testing:**
Tests must verify:
- **native-tools.AC2.5:** Create advisory with `title` and `detail` — returns advisory ID; list advisories — shows created advisory
- **native-tools.AC2.7:** Call with `title` but no `detail` — returns descriptive error

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/advisory.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): implement native advisory tool`
<!-- END_TASK_9 -->

<!-- START_TASK_10 -->
### Task 10: Implement notify tool

**Verifies:** native-tools.AC2.5, native-tools.AC2.7

**Files:**
- Create: `packages/agent/src/tools/notify.ts`
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Port logic from `packages/agent/src/commands/notify.ts` (lines 77-184).

```typescript
parameters: {
	type: "object",
	properties: {
		user: { type: "string", description: "Target username" },
		all: { type: "boolean", description: "Broadcast to all users on the platform" },
		platform: { type: "string", description: "Platform name (e.g., 'discord')" },
		message: { type: "string", description: "Notification message text" },
	},
	required: ["platform", "message"],
}
```

The execute handler:
1. Validate `platform` and `message` non-empty
2. Validate `user` and `all` are mutually exclusive, at least one required
3. Single-user: resolve user via `deterministicUUID()`, find DM thread, enqueue notification
4. All-users: iterate all users, filter by platform presence, enqueue for each
5. Emit `notify:enqueued` event per target thread

Import `deterministicUUID` and `BOUND_NAMESPACE` from `@bound/shared`, `enqueueNotification` from `@bound/core`.

**Testing:**
Tests must verify:
- **native-tools.AC2.5:** Seed user with platform_ids, seed thread, call notify — notification enqueued, event emitted
- **native-tools.AC2.7:** Call without `platform` — returns descriptive error
- Call with both `user` and `all` — returns error

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/notify.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): implement native notify tool`
<!-- END_TASK_10 -->

<!-- START_TASK_11 -->
### Task 11: Implement archive tool

**Verifies:** native-tools.AC2.5, native-tools.AC2.7

**Files:**
- Create: `packages/agent/src/tools/archive.ts`
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Port logic from `packages/agent/src/commands/archive.ts` (lines 45-114).

```typescript
parameters: {
	type: "object",
	properties: {
		thread_id: { type: "string", description: "Single thread ID to archive" },
		older_than: { type: "string", description: "Archive threads older than this (e.g., '30d', '2w', '3m')" },
	},
}
```

The execute handler:
1. Single thread: verify exists, soft-delete via `softDelete()`
2. Batch: parse time offset (`d`/`w`/`m`), compute cutoff, soft-delete all matching
3. Require at least one param

**Testing:**
Tests must verify:
- **native-tools.AC2.5:** Create thread, call archive with `thread_id` — thread soft-deleted
- **native-tools.AC2.7:** Call with neither param — returns descriptive error

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/archive.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): implement native archive tool`
<!-- END_TASK_11 -->

<!-- END_SUBCOMPONENT_C -->

<!-- START_SUBCOMPONENT_D (tasks 12-14) -->

<!-- START_TASK_12 -->
### Task 12: Implement model_hint tool

**Verifies:** native-tools.AC2.5, native-tools.AC2.7

**Files:**
- Create: `packages/agent/src/tools/model-hint.ts`
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Port logic from `packages/agent/src/commands/model-hint.ts` (lines 16-136).

```typescript
parameters: {
	type: "object",
	properties: {
		model: { type: "string", description: "Model ID or tier to set as hint" },
		reset: { type: "boolean", description: "Clear the current model hint" },
	},
}
```

The execute handler:
1. Requires `ctx.taskId` — returns error if missing
2. If `reset: true`: update task with `model_hint: null`
3. Otherwise: validate model via `ctx.modelRouter` if available (capability check for vision if recent messages contain images), update task with `model_hint: model`
4. All writes via `updateRow()`

**Testing:**
Tests must verify:
- **native-tools.AC2.5:** Create task, set model_hint — task row updated
- **native-tools.AC2.7:** Call without `ctx.taskId` — returns descriptive error
- Call with neither `model` nor `reset` — returns descriptive error

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/model-hint.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): implement native model_hint tool`
<!-- END_TASK_12 -->

<!-- START_TASK_13 -->
### Task 13: Implement hostinfo tool

**Verifies:** native-tools.AC2.5

**Files:**
- Create: `packages/agent/src/tools/hostinfo.ts`
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Port logic from `packages/agent/src/commands/hostinfo.ts` (lines 48-310).

```typescript
parameters: {
	type: "object",
	properties: {},
}
```

No parameters — this is a read-only diagnostic tool. The execute handler runs the same multi-query report:
1. Query hosts, sync_state, task stats, message stats (last hour), advisory stats
2. Format topology summary, model/MCP distribution, sync mesh, SPOF detection
3. Per-node details with staleness detection (120s threshold)

This is the largest tool handler. Port the entire formatting logic from the existing command.

**Testing:**
Tests must verify:
- **native-tools.AC2.5:** Seed hosts table, call hostinfo — returns formatted report containing host names
- No hosts — returns "No hosts registered."

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/hostinfo.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): implement native hostinfo tool`
<!-- END_TASK_13 -->

<!-- START_TASK_14 -->
### Task 14: Complete createAgentTools and verify all 11 tools registered

**Verifies:** native-tools.AC1.4

**Files:**
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Ensure `createAgentTools()` includes all 11 tool factories:

```typescript
export function createAgentTools(ctx: ToolContext): RegisteredTool[] {
	return [
		createScheduleTool(ctx),
		createCancelTool(ctx),
		createQueryTool(ctx),
		createEmitTool(ctx),
		createAwaitEventTool(ctx),
		createPurgeTool(ctx),
		createAdvisoryTool(ctx),
		createNotifyTool(ctx),
		createArchiveTool(ctx),
		createModelHintTool(ctx),
		createHostinfoTool(ctx),
	];
}
```

Add a unit test verifying all 11 tools are returned with valid `RegisteredTool` shapes.

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/index.test.ts`
Expected: All 11 tools registered, each has `kind: "builtin"`, valid `toolDefinition`, and `execute` function

**Commit:** `feat(agent): register all 11 standalone native tools`
<!-- END_TASK_14 -->

<!-- END_SUBCOMPONENT_D -->

<!-- START_TASK_15 -->
### Task 15: Verify full test suite passes

**Files:** None (verification only)

**Verification:**
Run: `bun test --recursive`
Expected: Exit code 0, no new failures

Run: `tsc -p packages/agent --noEmit && tsc -p packages/cli --noEmit`
Expected: Clean typecheck on both packages

**Commit:** No commit — verification only. Fix any regressions before proceeding.
<!-- END_TASK_15 -->
