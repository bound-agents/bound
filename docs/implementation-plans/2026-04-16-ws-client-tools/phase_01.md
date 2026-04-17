# WebSocket Client Tools Implementation Plan — Phase 1

**Goal:** Extend dispatch_queue to support `client_tool_call` and `tool_result` event types with thread locking semantics.

**Architecture:** New event_type values added to the existing dispatch_queue table (no new tables). `claimPending()` modified to skip `client_tool_call` entries so threads with pending client tool calls are effectively locked. New functions follow the established `enqueueMessage()`/`enqueueNotification()` patterns.

**Tech Stack:** Bun, TypeScript, bun:sqlite (WAL mode, STRICT tables)

**Scope:** 8 phases from original design (this is phase 1 of 8)

**Codebase verified:** 2026-04-16

**Note:** Line numbers referenced throughout all phases are approximate and may shift as earlier phases modify files. Use function/symbol names to locate code rather than relying on exact line numbers.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ws-client-tools.AC4: Persistent Tool Call Queue
- **ws-client-tools.AC4.1 Success:** Client tool calls create `client_tool_call` entries in `dispatch_queue`
- **ws-client-tools.AC4.2 Success:** Thread is locked while `client_tool_call` entries are pending; new user messages queue
- **ws-client-tools.AC4.3 Success:** After server restart, pending tool calls are re-delivered when client reconnects with matching tools
- **ws-client-tools.AC4.4 Success:** Stale entries (no reconnect within TTL) are expired; interruption notice injected, thread unblocked
- **ws-client-tools.AC4.5 Success:** Thread cancel expires pending client tool calls and unblocks the thread

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Dispatch queue event type constants and enqueue functions

**Verifies:** ws-client-tools.AC4.1

**Files:**
- Modify: `packages/core/src/dispatch.ts` (add new functions after existing `enqueueNotification` at line 31)

**Implementation:**

Add two new event type constants and three new functions to `dispatch.ts`, following the pattern established by `enqueueNotification()` (line 31):

1. **Event type constants** — Define string constants for the two new event types:
   - `CLIENT_TOOL_CALL = "client_tool_call"`
   - `TOOL_RESULT = "tool_result"`

2. **`enqueueClientToolCall(db, threadId, payload, connectionId)`** — Insert a `client_tool_call` entry into dispatch_queue.
   - `payload` is `{ call_id: string; tool_name: string; arguments: Record<string, unknown> }`
   - Generate UUID for `message_id` (same pattern as `enqueueNotification`: `crypto.randomUUID()`)
   - Set `event_type = CLIENT_TOOL_CALL`
   - Set `claimed_by = connectionId` (the WS connection that registered the tool)
   - Store `payload` as `JSON.stringify(payload)` in `event_payload`
   - Set `status = 'pending'`
   - Return the generated `message_id`

3. **`enqueueToolResult(db, threadId, callId)`** — Insert a `tool_result` entry to trigger agent loop resume.
   - Generate UUID for `message_id`
   - Set `event_type = TOOL_RESULT`
   - Store `{ call_id: callId }` as JSON in `event_payload`
   - Set `status = 'pending'`
   - Return the generated `message_id`

4. **`acknowledgeClientToolCall(db, entryId)`** — Mark a single `client_tool_call` entry as acknowledged.
   - UPDATE dispatch_queue SET `status = 'acknowledged'`, `modified_at = now` WHERE `message_id = entryId`
   - Use the same timestamp pattern as `acknowledgeBatch()` (line 93): `new Date().toISOString()`

Export all new functions and constants from the module.

**Testing:**

Tests must verify:
- ws-client-tools.AC4.1: `enqueueClientToolCall` creates an entry with correct `event_type`, `event_payload` (parsed JSON matches input), `claimed_by`, and `status = 'pending'`
- `enqueueToolResult` creates an entry with `event_type = 'tool_result'` and correct payload
- `acknowledgeClientToolCall` transitions status from `'pending'` to `'acknowledged'`
- `acknowledgeClientToolCall` on an already-acknowledged entry is idempotent (no error)

Add tests to existing file: `packages/core/src/__tests__/dispatch-queue.test.ts`

Follow the existing test setup pattern: `beforeEach` creates a fresh DB with `createDatabase(dbPath)` + `applySchema(db)`, `afterEach` closes and cleans up.

**Verification:**
Run: `bun test packages/core/src/__tests__/dispatch-queue.test.ts`
Expected: All existing + new tests pass

**Commit:** `feat(core): add client_tool_call and tool_result dispatch queue functions`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: claimPending skips client_tool_call entries and hasPendingClientToolCalls

**Verifies:** ws-client-tools.AC4.2

**Files:**
- Modify: `packages/core/src/dispatch.ts` (modify `claimPending` at line 49, add new function)

**Implementation:**

1. **Modify `claimPending()`** (line 49) — Add a WHERE clause to the SELECT at line 58 to exclude `client_tool_call` entries:
   - Current query selects `WHERE thread_id = ? AND status = 'pending'`
   - Change to `WHERE thread_id = ? AND status = 'pending' AND event_type != 'client_tool_call'`
   - This ensures `client_tool_call` entries are never claimed by the agent loop — they wait for client execution
   - The UPDATE at line 72 should also get the same filter (it currently updates by message_id list from the SELECT, so this is already scoped correctly — but verify)

2. **`hasPendingClientToolCalls(db, threadId)`** — New function that checks for unresolved `client_tool_call` entries on a thread.
   - SELECT COUNT(*) FROM dispatch_queue WHERE `thread_id = ?` AND `event_type = 'client_tool_call'` AND `status IN ('pending', 'processing')`
   - Return boolean (count > 0)
   - Note: `'processing'` status means the call was delivered to a client but no result yet

3. **`getPendingClientToolCalls(db, threadId)`** — New function that returns all pending/processing `client_tool_call` entries for a thread.
   - SELECT * FROM dispatch_queue WHERE `thread_id = ?` AND `event_type = 'client_tool_call'` AND `status IN ('pending', 'processing')`
   - Returns `DispatchEntry[]`
   - Used by WS handler (Phase 3) to re-deliver calls on reconnect

Export all new functions.

**Testing:**

Tests must verify:
- ws-client-tools.AC4.2: After inserting a `client_tool_call` entry, `claimPending` returns empty (skips it), but `user_message` and `notification` entries on the same thread are still claimed
- `hasPendingClientToolCalls` returns true when pending `client_tool_call` entries exist, false when none exist or all are acknowledged
- `hasPendingClientToolCalls` returns true for entries with `status = 'processing'` (delivered but no result yet)
- `getPendingClientToolCalls` returns the correct entries with parsed payloads
- Mixed scenario: thread has both `user_message` and `client_tool_call` entries — `claimPending` returns only the `user_message`

Add tests to: `packages/core/src/__tests__/dispatch-queue.test.ts`

**Verification:**
Run: `bun test packages/core/src/__tests__/dispatch-queue.test.ts`
Expected: All existing + new tests pass

**Commit:** `feat(core): skip client_tool_call in claimPending, add hasPendingClientToolCalls`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Expire stale client tool calls

**Verifies:** ws-client-tools.AC4.4, ws-client-tools.AC4.5

**Files:**
- Modify: `packages/core/src/dispatch.ts` (add new functions)

**Implementation:**

1. **`expireClientToolCalls(db, threadId?)`** — Expire stale `client_tool_call` entries that exceeded TTL.
   - Accept an optional `threadId` parameter. If provided, expire only for that thread. If not, expire across all threads.
   - Accept a `ttlMs` parameter (milliseconds) for the TTL duration.
   - Compute cutoff: `new Date(Date.now() - ttlMs).toISOString()` (follow the JS timestamp pattern from CLAUDE.md — never use SQLite `datetime()` for ISO comparison)
   - UPDATE dispatch_queue SET `status = 'expired'`, `modified_at = now` WHERE `event_type = 'client_tool_call'` AND `status IN ('pending', 'processing')` AND `created_at < cutoff` AND (optionally `thread_id = ?`)
   - Return the list of expired entries (need the thread_ids for injecting interruption notices)
   - Note: `'expired'` is a new status value alongside `'pending'`, `'processing'`, `'acknowledged'`

2. **`cancelClientToolCalls(db, threadId)`** — Cancel all pending client tool calls for a specific thread (used by thread cancel).
   - UPDATE dispatch_queue SET `status = 'expired'`, `modified_at = now` WHERE `thread_id = ?` AND `event_type = 'client_tool_call'` AND `status IN ('pending', 'processing')`
   - Return the count of cancelled entries
   - This is distinct from `expireClientToolCalls` because it doesn't check TTL — it immediately expires all pending calls for the thread

5. **`updateClaimedBy(db, entryId, connectionId)`** — Update the `claimed_by` and `status` fields of a dispatch_queue entry. Used by the WS handler (Phase 8) when re-delivering tool calls on reconnect.
   - UPDATE dispatch_queue SET `claimed_by = connectionId`, `status = 'processing'`, `modified_at = now` WHERE `message_id = entryId`

Export all new functions.

**Testing:**

Tests must verify:
- ws-client-tools.AC4.4: `expireClientToolCalls` with a short TTL expires old entries but not recent ones; returns the expired entries with their thread_ids
- ws-client-tools.AC4.4: After expiry, `hasPendingClientToolCalls` returns false (expired entries don't count as pending)
- ws-client-tools.AC4.5: `cancelClientToolCalls` expires all pending entries for a thread regardless of age
- ws-client-tools.AC4.5: `cancelClientToolCalls` returns 0 when no pending entries exist
- Expired entries are not claimed by `claimPending` (already covered by status filter, but verify)

Add tests to: `packages/core/src/__tests__/dispatch-queue.test.ts`

**Verification:**
Run: `bun test packages/core/src/__tests__/dispatch-queue.test.ts`
Expected: All existing + new tests pass

**Commit:** `feat(core): add client tool call expiry and cancellation`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->
<!-- START_TASK_4 -->
### Task 4: Bootstrap recovery for client_tool_call entries

**Verifies:** ws-client-tools.AC4.3

**Files:**
- Modify: `packages/cli/src/commands/start/bootstrap.ts` (after existing dispatch recovery at line 285)

**Implementation:**

Add recovery logic for `client_tool_call` entries from prior server lifetime, placed after the existing `resetProcessing()` call at line 285.

The key distinction from regular dispatch recovery: `client_tool_call` entries should NOT be reset to pending and re-triggered like `user_message` entries. They need to wait for a client to reconnect with matching tools. The existing `resetProcessing()` call would incorrectly reset their `claimed_by` field.

1. **Query for orphaned `client_tool_call` entries:**
   - SELECT from dispatch_queue WHERE `event_type = 'client_tool_call'` AND `status IN ('pending', 'processing')`
   - These are entries that survived a server restart

2. **Reset their status to `'pending'`** (clear any stale `'processing'` status) but preserve `claimed_by` so reconnecting clients can be matched.
   - Actually, on reflection: `claimed_by` holds a `connection_id` which is per-connection and won't survive restart. Set `claimed_by = NULL` so the WS handler (Phase 3) can re-assign on reconnect.
   - UPDATE dispatch_queue SET `status = 'pending'`, `claimed_by = NULL`, `modified_at = now` WHERE `event_type = 'client_tool_call'` AND `status = 'processing'`

3. **Log the count** of orphaned entries for observability.

4. **Important:** Do NOT call `resetProcessing()` on `client_tool_call` entries — the generic `resetProcessing()` at line 285 already runs first, but it doesn't distinguish event types. Modify BOTH `resetProcessing()` (line 108) AND `resetProcessingForThread()` (line 124) in `dispatch.ts` to exclude `client_tool_call` entries (add `AND event_type != 'client_tool_call'` to the WHERE clause in both functions), so the bootstrap can handle them separately with the `claimed_by = NULL` logic.

**Testing:**

Tests must verify:
- ws-client-tools.AC4.3: After inserting `client_tool_call` entries with `status = 'processing'` (simulating crash), the bootstrap recovery resets them to `pending` with `claimed_by = NULL`
- `resetProcessing()` no longer touches `client_tool_call` entries (they're handled separately)
- `resetProcessingForThread()` no longer touches `client_tool_call` entries either
- Regular `user_message` entries with `status = 'processing'` are still reset by both functions as before

Add tests to: `packages/core/src/__tests__/dispatch-queue.test.ts` (for the modified `resetProcessing`)

**Verification:**
Run: `bun test packages/core/src/__tests__/dispatch-queue.test.ts`
Expected: All existing + new tests pass

**Commit:** `feat(core): bootstrap recovery for client_tool_call entries`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Export updated dispatch API and verify integration

**Verifies:** None (infrastructure wiring)

**Files:**
- Modify: `packages/core/src/index.ts` (verify exports)

**Implementation:**

Verify that all new functions and constants are exported from `@bound/core`:
- `CLIENT_TOOL_CALL` constant
- `TOOL_RESULT` constant
- `enqueueClientToolCall()`
- `enqueueToolResult()`
- `acknowledgeClientToolCall()`
- `hasPendingClientToolCalls()`
- `getPendingClientToolCalls()`
- `expireClientToolCalls()`
- `cancelClientToolCalls()`
- `updateClaimedBy()`

Check that the existing barrel export in `packages/core/src/index.ts` re-exports from `./dispatch` (it likely already does `export * from "./dispatch"`). If so, no changes needed. If not, add the re-export.

**Verification:**
Run: `bun test packages/core`
Expected: All core tests pass (179+ existing + new dispatch tests)

Run: `tsc -p packages/core --noEmit`
Expected: No type errors

**Commit:** `chore(core): verify dispatch API exports`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->
