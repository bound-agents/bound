# WebSocket Client Tools Implementation Plan — Phase 8

**Goal:** Ensure robustness across server restarts, client disconnects, and edge cases. TTL-based expiry, bootstrap recovery, cancel integration, and connection drop handling.

**Architecture:** This phase builds on the dispatch_queue extensions (Phase 1), WS handler (Phase 3), and bootstrap (Phase 4) to handle the recovery scenarios. Pending `client_tool_call` entries survive in the dispatch_queue across server restarts. Reconnecting clients match by tool name. Stale entries are expired by periodic TTL scan. Cancel integration expires pending calls immediately. Connection drops leave entries for potential reconnect — TTL handles permanent disconnects.

**Tech Stack:** Bun, TypeScript, bun:sqlite

**Scope:** 8 phases from original design (this is phase 8 of 8)

**Codebase verified:** 2026-04-16

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ws-client-tools.AC4: Persistent Tool Call Queue (completion)
- **ws-client-tools.AC4.3 Success:** After server restart, pending tool calls are re-delivered when client reconnects with matching tools
- **ws-client-tools.AC4.4 Success:** Stale entries (no reconnect within TTL) are expired; interruption notice injected, thread unblocked
- **ws-client-tools.AC4.5 Success:** Thread cancel expires pending client tool calls and unblocks the thread

### ws-client-tools.AC7: Cross-Cutting Recovery
- **ws-client-tools.AC7.1 Success:** Client disconnect + reconnect re-delivers pending tool calls matched by tool name
- **ws-client-tools.AC7.2 Success:** `claimed_by` updated to new connection_id on reconnect
- **ws-client-tools.AC7.3 Failure:** `tool:result` for expired entry receives `error` with `code: "tool_call_expired"`
- **ws-client-tools.AC7.4 Success:** Bootstrap recovery distinguishes `client_tool_call` entries from interrupted server tool calls

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: TTL-based expiry scan with interruption notice injection

**Verifies:** ws-client-tools.AC4.4

**Files:**
- Modify: `packages/cli/src/commands/start/server.ts` (add periodic scan)
- Modify: `packages/core/src/dispatch.ts` (if `expireClientToolCalls` needs adjustment)

**Implementation:**

1. **Periodic expiry scan** — Add a `setInterval` in the server startup (server.ts, after the scheduler and other periodic tasks are initialized) that scans for stale `client_tool_call` entries:

   ```typescript
   const CLIENT_TOOL_CALL_TTL_MS = 5 * 60 * 1000; // 5 minutes default
   const EXPIRY_SCAN_INTERVAL_MS = 60 * 1000; // Scan every 60 seconds

   const expiryScanInterval = setInterval(() => {
       const expired = expireClientToolCalls(db, undefined, CLIENT_TOOL_CALL_TTL_MS);
       if (expired.length > 0) {
           // Group by thread_id
           const threadIds = new Set(expired.map(e => e.thread_id));
           for (const threadId of threadIds) {
               // Inject interruption notice as system message
               insertRow(db, "messages", {
                   id: crypto.randomUUID(),
                   thread_id: threadId,
                   role: "system",
                   content: `[Client tool call expired] One or more client tool calls timed out after ${CLIENT_TOOL_CALL_TTL_MS / 1000}s without receiving results. The client may have disconnected permanently.`,
                   user_id: "system",
                   created_at: new Date().toISOString(),
                   modified_at: new Date().toISOString(),
                   deleted: 0,
               }, siteId);

               // Re-trigger handleThread to unblock the thread
               handleThread(threadId);
           }
           logger.info(`[expiry] Expired ${expired.length} stale client tool call(s) across ${threadIds.size} thread(s)`);
       }
   }, EXPIRY_SCAN_INTERVAL_MS);
   ```

2. **Clean up on server stop** — Clear the interval in the cleanup/shutdown handler.

3. **Make TTL configurable** — Optionally read from an environment variable or config file. For now, a constant is fine.

**Testing:**

Tests must verify:
- ws-client-tools.AC4.4: After TTL elapses, `expireClientToolCalls` marks entries as expired. An interruption notice system message is injected. The thread is re-triggered via `handleThread`.
- Entries created less than TTL ago are NOT expired
- Multiple expired entries on the same thread produce a single interruption notice

Add tests to: `packages/core/src/__tests__/dispatch-queue.test.ts` (expiry logic) and integration-level test for the scan + notice injection

**Verification:**
Run: `bun test packages/core/src/__tests__/dispatch-queue.test.ts`
Expected: All tests pass

**Commit:** `feat(cli): periodic TTL-based expiry scan for stale client tool calls`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Bootstrap recovery distinguishing client_tool_call entries

**Verifies:** ws-client-tools.AC4.3, ws-client-tools.AC7.4

**Files:**
- Modify: `packages/cli/src/commands/start/bootstrap.ts` (after dispatch recovery at line 285)

**Implementation:**

Phase 1 Task 4 already adds the bootstrap recovery for `client_tool_call` entries (resetting `status = 'processing'` to `'pending'` with `claimed_by = NULL`). This task ensures the recovery is correctly integrated into the full bootstrap sequence and doesn't interfere with the existing interrupted tool-use detection (lines 291-336).

1. **Verify integration with interrupted tool-use detection** — The existing code at lines 291-336 scans for incomplete tool interactions and injects interruption notices. This logic should NOT treat `client_tool_call` entries as interrupted server tool calls. The Phase 1 recovery handles them separately.

   The existing detection looks at the messages table (not dispatch_queue) for tool_call messages without corresponding tool_result messages. Since client tool_call messages ARE persisted to the messages table (Phase 2 Task 3), the interrupted tool detector might flag them.

   Add a guard: when checking for interrupted tool calls, skip tool_call messages that have a corresponding `client_tool_call` entry in dispatch_queue (they're waiting for client response, not crashed server tools).

2. **Log clearly** — Log the count of client_tool_call entries found during bootstrap with a distinct message so operators can see them in startup logs:

   ```typescript
   const clientToolCalls = getPendingClientToolCalls(db); // all threads
   if (clientToolCalls.length > 0) {
       logger.info(`[recovery] Found ${clientToolCalls.length} pending client tool call(s) from prior server lifetime — will re-deliver on client reconnect`);
   }
   ```

3. **Re-trigger threads with pending client tool calls** — After bootstrap, the threads with pending `client_tool_call` entries should NOT be re-triggered via `handleThread` (unlike regular pending dispatch entries at lines 544-549). They need to wait for a client to reconnect. The re-delivery happens in the WS handler's `session:configure` handler (Phase 3 Task 2).

**Testing:**

Tests must verify:
- ws-client-tools.AC7.4: Bootstrap recovery resets `client_tool_call` entries to `pending` with `claimed_by = NULL` without triggering the interrupted tool-use flow
- Regular `user_message` dispatch entries still get standard recovery treatment
- `client_tool_call` entries don't cause spurious interruption notices during bootstrap

Add tests to: integration test that simulates bootstrap with mixed dispatch_queue entries

**Verification:**
Run: `bun test packages/core && bun test packages/cli`
Expected: All tests pass

**Commit:** `feat(cli): bootstrap recovery distinguishes client_tool_call entries (AC7.4)`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Cancel integration — expire pending client tool calls

**Verifies:** ws-client-tools.AC4.5

**Files:**
- Modify: `packages/web/src/server/routes/status.ts` (cancel handler at lines 156-234)

**Implementation:**

Extend the cancel handler at `POST /api/status/cancel/:threadId` (status.ts lines 156-234) to also expire pending client tool calls:

1. **Add cancellation step** — Before the existing `agent:cancel` event emission (line 200), add:

   ```typescript
   // Expire any pending client tool calls for this thread
   const cancelledToolCalls = cancelClientToolCalls(db, threadId);
   if (cancelledToolCalls > 0) {
       logger.info(`[cancel] Expired ${cancelledToolCalls} pending client tool call(s) for thread ${threadId}`);
   }
   ```

   Import `cancelClientToolCalls` from `@bound/core`.

2. **Inject interruption notice** — If client tool calls were cancelled, inject a system message (similar to the expiry scan in Task 1):

   ```typescript
   if (cancelledToolCalls > 0) {
       insertRow(db, "messages", {
           id: crypto.randomUUID(),
           thread_id: threadId,
           role: "system",
           content: "[Client tool calls cancelled] Pending client tool calls were cancelled by user request.",
           user_id: "system",
           created_at: new Date().toISOString(),
           modified_at: new Date().toISOString(),
           deleted: 0,
       }, siteId);
   }
   ```

3. **Notify connected clients** — If a WS client has pending tool calls that were just cancelled, send them a `tool:call` cancellation notification or an `error` event so they know to stop executing. This is optional — the `tool:result` handler already rejects results for expired entries (AC7.3).

**Testing:**

Tests must verify:
- ws-client-tools.AC4.5: After cancelling a thread, all pending `client_tool_call` entries for that thread are expired
- The thread is unblocked after cancellation (new messages can be processed)
- An interruption notice system message is injected

Add tests to: `packages/web/src/server/__tests__/status.test.ts` (if exists) or integration test

**Verification:**
Run: `bun test packages/web`
Expected: All tests pass

**Commit:** `feat(web): cancel thread expires pending client tool calls (AC4.5)`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Reconnect re-delivery and claimed_by update

**Verifies:** ws-client-tools.AC7.1, ws-client-tools.AC7.2, ws-client-tools.AC7.3

**Files:**
- Modify: `packages/web/src/server/websocket.ts` (enhance `handleSessionConfigure` and `handleToolResult`)

**Implementation:**

1. **Reconnect re-delivery in `handleSessionConfigure`** — When a client sends `session:configure` (after connecting or reconnecting), scan for pending `client_tool_call` entries that match the client's tools on subscribed threads:

   ```typescript
   function handleSessionConfigure(conn: ClientConnection, msg: SessionConfigureMsg) {
       // Store tools (existing)
       conn.clientTools.clear();
       for (const tool of msg.tools) {
           conn.clientTools.set(tool.function.name, tool);
       }

       // Scan for re-deliverable pending tool calls
       for (const threadId of conn.subscriptions) {
           const pending = getPendingClientToolCalls(db, threadId);
           for (const entry of pending) {
               const payload = JSON.parse(entry.event_payload);
               if (conn.clientTools.has(payload.tool_name)) {
                   // Update claimed_by to new connection (using dispatch.ts helper)
                   updateClaimedBy(db, entry.message_id, conn.connectionId);

                   // Re-deliver tool:call
                   conn.ws.send(JSON.stringify({
                       type: "tool:call",
                       call_id: payload.call_id,
                       thread_id: threadId,
                       tool_name: payload.tool_name,
                       arguments: payload.arguments,
                   }));
               }
           }
       }
   }
   ```

   Note: Subscriptions may be empty at `session:configure` time if the client subscribes after configuring tools. Handle the scan in `handleThreadSubscribe` as well — when subscribing to a new thread, check for pending tool calls.

2. **Handle `tool:result` for expired entries** — The `handleToolResult` function (Phase 3 Task 4) already validates the call_id. Ensure it explicitly checks for expired entries and returns the correct error code:

   ```typescript
   // Check if entry exists but is expired
   const expiredEntry = /* query for status='expired' entries with matching call_id */;
   if (expiredEntry) {
       conn.ws.send(JSON.stringify({
           type: "error",
           code: "tool_call_expired",
           message: "This tool call has expired",
           call_id: msg.call_id,
       }));
       return;
   }
   ```

**Testing:**

Tests must verify:
- ws-client-tools.AC7.1: After disconnect + reconnect, client receives pending `tool:call` messages matched by tool name on subscribed threads
- ws-client-tools.AC7.2: `claimed_by` in dispatch_queue is updated to the new connection's `connectionId` after reconnect
- ws-client-tools.AC7.3: `tool:result` for an expired entry receives `error` with `code: "tool_call_expired"` and the result is discarded
- If a client reconnects but no longer has the matching tool, the pending call is NOT re-delivered (remains pending for another client or TTL expiry)

Add tests to: `packages/web/src/server/__tests__/websocket.test.ts`

**Verification:**
Run: `bun test packages/web`
Expected: All tests pass

**Commit:** `feat(web): reconnect re-delivery and tool_call_expired error handling (AC7.1-AC7.3)`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->
