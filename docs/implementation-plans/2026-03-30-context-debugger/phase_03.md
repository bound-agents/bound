# Context Debugger Implementation Plan - Phase 3

**Goal:** Context debug data persisted per turn, accessible via API, and pushed via WebSocket.

**Architecture:** A new `context_debug TEXT` column on the `turns` table stores serialized `ContextDebugInfo` JSON per turn. A `recordContextDebug()` function updates the turn row after initial insertion (same pattern as `recordTurnRelayMetrics()`). A new `"context:debug"` event type carries debug data through the EventBus to WebSocket clients. A new REST endpoint returns historical context debug data for a thread's turns.

**Tech Stack:** TypeScript, bun:sqlite, Hono, bun:test

**Scope:** 5 phases from original design (phase 3 of 5)

**Codebase verified:** 2026-03-31

**Testing reference:** CLAUDE.md lines 123-131. bun:test framework, temp SQLite databases via `randomBytes(4)`.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### context-debugger.AC3: Persistence Layer
- **context-debugger.AC3.1 Success:** `context_debug` column added to turns table via idempotent ALTER TABLE
- **context-debugger.AC3.2 Success:** `recordContextDebug(db, turnId, debug)` stores valid JSON retrievable by turn ID
- **context-debugger.AC3.3 Success:** Schema migration is idempotent (re-running does not error)
- **context-debugger.AC3.4 Edge:** Turns created before the migration have NULL context_debug (no backfill)

### context-debugger.AC4: API + WebSocket Delivery
- **context-debugger.AC4.1 Success:** `GET /api/threads/:id/context-debug` returns array of turn debug records ordered by created_at ASC
- **context-debugger.AC4.2 Success:** Each record includes turn_id, model_id, tokens_in (actual), tokens_out, context_debug (parsed), created_at
- **context-debugger.AC4.3 Success:** WebSocket `context:debug` event delivered to clients subscribed to the thread
- **context-debugger.AC4.4 Failure:** `GET /api/threads/:id/context-debug` for nonexistent thread returns empty array (not error)
- **context-debugger.AC4.5 Edge:** Turns with NULL context_debug are excluded from the response

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add context_debug column to turns table

**Verifies:** context-debugger.AC3.1, context-debugger.AC3.3, context-debugger.AC3.4

**Files:**
- Modify: `packages/core/src/metrics-schema.ts:50-53` (add after existing ALTER TABLE blocks)

**Implementation:**

Add after the existing `tokens_cache_read` ALTER TABLE block (after line 53 of `packages/core/src/metrics-schema.ts`):

```typescript
// Add context debug column to turns (idempotent — no-op if already exists)
try {
	db.run("ALTER TABLE turns ADD COLUMN context_debug TEXT");
} catch {
	// Column already exists
}
```

This follows the exact pattern used for `relay_target`, `relay_latency_ms`, `tokens_cache_write`, and `tokens_cache_read` columns at lines 31-53.

**Testing:**

Tests must verify:
- **context-debugger.AC3.1:** After `ensureMetricsSchema(db)`, the turns table has a `context_debug` column. Insert a turn, verify the column is accessible and defaults to NULL.
- **context-debugger.AC3.3:** Call `ensureMetricsSchema(db)` twice on the same database — no error on second call.
- **context-debugger.AC3.4:** Insert a turn WITHOUT setting context_debug. Query it back — `context_debug` is NULL.

Test file: `packages/core/src/__tests__/metrics-schema.test.ts` (unit, if exists) or add to existing schema test. Follow existing test DB setup: `createDatabase(join(tmpdir(), ...))`, `applySchema(db)`, `ensureMetricsSchema(db)`.

**Verification:**

Run: `bun test packages/core`
Expected: All tests pass

**Commit:** `feat(core): add context_debug column to turns table`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create recordContextDebug function

**Verifies:** context-debugger.AC3.2

**Files:**
- Modify: `packages/core/src/metrics-schema.ts` (add function after `recordTurn`)
- Modify: `packages/core/src/index.ts` (export new function if not already re-exported)

**Implementation:**

Add to `packages/core/src/metrics-schema.ts` after the existing `recordTurn()` function (after line ~106):

```typescript
/**
 * Record context debug metadata for a turn.
 * Called after recordTurn() returns the turn ID.
 * Follows the same post-insert UPDATE pattern as recordTurnRelayMetrics() in relay-metrics.ts.
 */
export function recordContextDebug(
	db: Database,
	turnId: number,
	debug: ContextDebugInfo,
): void {
	db.run("UPDATE turns SET context_debug = ? WHERE id = ?", [
		JSON.stringify(debug),
		turnId,
	]);
}
```

Add import at top of file:

```typescript
import type { ContextDebugInfo } from "@bound/shared";
```

Ensure the function is exported from `packages/core/src/index.ts` (check if metrics-schema.ts is already re-exported via wildcard).

**Testing:**

Tests must verify:
- **context-debugger.AC3.2:** Call `recordTurn()` to get a turnId, then call `recordContextDebug(db, turnId, debugObj)`. Query the turn row back. `JSON.parse(row.context_debug)` equals the original debug object (round-trip verification).

Test file: `packages/core/src/__tests__/metrics-schema.test.ts` (unit). Use same test DB setup as Task 1.

**Verification:**

Run: `bun test packages/core`
Expected: All tests pass

**Commit:** `feat(core): add recordContextDebug function`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Add context:debug event type to EventMap

**Files:**
- Modify: `packages/shared/src/events.ts:3-18` (add new event type)

**Implementation:**

Add the `"context:debug"` event to the `EventMap` interface (at `packages/shared/src/events.ts`, inside the EventMap interface, after existing events):

```typescript
export interface EventMap {
	// ... existing events ...
	"context:debug": { thread_id: string; turn_id: number; debug: ContextDebugInfo };
}
```

Add import at top of file:

```typescript
import type { ContextDebugInfo } from "./types.js";
```

**Verification:**

Run: `tsc -p packages/shared --noEmit`
Expected: No type errors

**Commit:** `feat(shared): add context:debug event type`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Add WebSocket handler for context:debug event

**Verifies:** context-debugger.AC4.3

**Files:**
- Modify: `packages/web/src/server/websocket.ts` (add handler + event registration)

**Implementation:**

Follow the existing pattern at lines 27-37 (handleMessageCreated). Add a new handler function:

```typescript
const handleContextDebug = (data: {
	thread_id: string;
	turn_id: number;
	debug: unknown;
}): void => {
	for (const [ws, conn] of clients) {
		if (conn.subscriptions.has(data.thread_id)) {
			const message = JSON.stringify({
				type: "context:debug",
				data: { turn_id: data.turn_id, debug: data.debug },
			});
			if (ws.readyState === 1) {
				ws.send(message);
			}
		}
	}
};
```

Register the handler alongside existing event registrations (around lines 96-102):

```typescript
eventBus.on("context:debug", handleContextDebug);
```

**Testing:**

Tests must verify:
- **context-debugger.AC4.3:** When a `context:debug` event is emitted on the eventBus, a WebSocket client subscribed to the thread receives a JSON message with `type: "context:debug"` and `data: { turn_id, debug }`.

Test file: `packages/web/src/server/__tests__/websocket.test.ts` (if exists) or integration test. Follow existing WebSocket test patterns — mock clients, emit events, verify messages received.

**Verification:**

Run: `bun test packages/web`
Expected: All tests pass

**Commit:** `feat(web): add WebSocket handler for context:debug events`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Add GET /api/threads/:id/context-debug route

**Verifies:** context-debugger.AC4.1, context-debugger.AC4.2, context-debugger.AC4.4, context-debugger.AC4.5

**Files:**
- Modify: `packages/web/src/server/routes/threads.ts` (add new route)

**Implementation:**

Add a new route handler after the existing `/:id/status` route (around line 164 of `packages/web/src/server/routes/threads.ts`). Note: The route is added inside the `createThreadRoutes(db)` factory function, where `db` is already in scope from the factory parameter:

```typescript
app.get("/:id/context-debug", (c) => {
	try {
		const { id } = c.req.param();

		const rows = db
			.query(
				`SELECT id, model_id, tokens_in, tokens_out, context_debug, created_at
				 FROM turns
				 WHERE thread_id = ? AND context_debug IS NOT NULL
				 ORDER BY created_at ASC`,
			)
			.all(id) as Array<{
			id: number;
			model_id: string;
			tokens_in: number;
			tokens_out: number;
			context_debug: string;
			created_at: string;
		}>;

		const result = rows.map((row) => ({
			turn_id: row.id,
			model_id: row.model_id,
			tokens_in: row.tokens_in,
			tokens_out: row.tokens_out,
			context_debug: JSON.parse(row.context_debug),
			created_at: row.created_at,
		}));

		return c.json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return c.json(
			{
				error: "Failed to get context debug data",
				details: message,
			},
			500,
		);
	}
});
```

Key design decisions:
- Returns empty array `[]` for nonexistent threads (not 404), satisfying AC4.4
- Filters `WHERE context_debug IS NOT NULL` to exclude turns without debug data, satisfying AC4.5
- Parses `context_debug` JSON server-side so clients receive structured objects, satisfying AC4.2
- Ordered by `created_at ASC` for chronological turn order, satisfying AC4.1

**Testing:**

Tests must verify:
- **context-debugger.AC4.1:** Insert 3 turns with context_debug for a thread. GET returns array of 3 records ordered by created_at ASC.
- **context-debugger.AC4.2:** Each record in the response has `turn_id`, `model_id`, `tokens_in`, `tokens_out`, `context_debug` (parsed object), `created_at`.
- **context-debugger.AC4.4:** GET for a nonexistent thread_id returns `[]` (status 200, empty array).
- **context-debugger.AC4.5:** Insert turns with and without context_debug. GET returns only turns with non-NULL context_debug.

Test file: `packages/web/src/server/__tests__/threads-context-debug.test.ts` (unit/integration). Set up a test Hono app with the threads router, use temp SQLite DB.

**Verification:**

Run: `bun test packages/web`
Expected: All tests pass

**Commit:** `feat(web): add GET /api/threads/:id/context-debug route`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Emit context:debug event from agent loop after recording turn

**Verifies:** context-debugger.AC4.3

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` (after recordContextDebug call)

**Implementation:**

In the agent loop's turn recording section (around lines 443-475 of `packages/agent/src/agent-loop.ts`), after calling `recordContextDebug()`, emit the event:

1. Add import:

```typescript
import { recordContextDebug } from "@bound/core";
```

2. After the existing `recordTurnRelayMetrics()` block (around line 475), add:

```typescript
// Record context debug data and emit event
if (currentTurnId !== null && this.lastContextDebug) {
	recordContextDebug(this.ctx.db, currentTurnId, this.lastContextDebug);
	this.ctx.eventBus.emit("context:debug", {
		thread_id: this.config.threadId,
		turn_id: currentTurnId,
		debug: this.lastContextDebug,
	});
}
```

`this.lastContextDebug` was set in Phase 2, Task 4 after destructuring the assembleContext result.

**Testing:**

Tests must verify:
- **context-debugger.AC4.3:** After a turn completes in the agent loop, a `context:debug` event is emitted with the correct thread_id, turn_id, and debug data. Verify by subscribing to the eventBus in a test.

Test file: `packages/agent/src/__tests__/agent-loop.test.ts` or `context-assembly.test.ts`. Follow existing agent loop test patterns.

**Verification:**

Run: `bun test packages/agent`
Expected: All tests pass

Run: `bun test --recursive`
Expected: All tests pass across the project

**Commit:** `feat(agent): emit context:debug event after recording turn`
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_C -->
