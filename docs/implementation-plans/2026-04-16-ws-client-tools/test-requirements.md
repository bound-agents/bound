# WebSocket Client Tools -- Test Requirements

Maps each acceptance criterion to automated tests and/or human verification steps.

---

## Summary

| AC | Automated | Human | Notes |
|----|-----------|-------|-------|
| AC1.1 | Integration | -- | WS `message:send` persists message |
| AC1.2 | Integration | -- | POST endpoint returns 404 |
| AC1.3 | Integration | -- | Subscribed client receives event broadcasts |
| AC1.4 | Unit | -- | Malformed WS messages produce error, connection stays open |
| AC1.5 | Integration | -- | `thread:status` push to subscribed clients |
| AC2.1 | Unit | -- | Single import provides all methods |
| AC2.2 | Unit | -- | `BoundSocket` import fails; `socket.ts` absent |
| AC2.3 | Unit | -- | Reconnect re-sends `session:configure` and subscriptions |
| AC2.4 | Unit | -- | `sendMessage` fires over WS, not HTTP POST |
| AC2.5 | Unit | -- | Event names use colon delimiters |
| AC3.1 | Integration | -- | `session:configure` tools appear in LLM tool list |
| AC3.2 | Integration | -- | Client receives `tool:call` with correct payload |
| AC3.3 | Integration | -- | Agent loop resumes after `tool:result`; LLM sees pair in context |
| AC3.4 | Integration | -- | Mixed turn: server tools eager, client tools deferred, loop yields |
| AC3.5 | Unit | -- | Unknown `call_id` receives error response |
| AC3.6 | Unit | -- | Tools persist for connection lifetime |
| AC4.1 | Unit | -- | `enqueueClientToolCall` creates correct dispatch_queue entry |
| AC4.2 | Unit | -- | `claimPending` skips threads with pending `client_tool_call` entries |
| AC4.3 | Integration | -- | Bootstrap recovery + reconnect re-delivery |
| AC4.4 | Integration | -- | TTL expiry, interruption notice, thread unblocked |
| AC4.5 | Unit | -- | Cancel expires pending client tool calls |
| AC5.1 | Unit | -- | MCP handler uses WS send + `thread:status` event |
| AC5.2 | Unit | -- | MCP handler does not call `configureTools` |
| AC6.1 | -- | Manual | Web UI uses single `BoundClient` |
| AC6.2 | -- | Manual + e2e | Message sending over WS; responses via events |
| AC6.3 | -- | Manual | Event listeners use updated names |
| AC7.1 | Integration | -- | Reconnect re-delivers pending tool calls |
| AC7.2 | Unit | -- | `claimed_by` updated to new `connectionId` |
| AC7.3 | Unit | -- | Expired entry receives `tool_call_expired` error |
| AC7.4 | Integration | -- | Bootstrap distinguishes `client_tool_call` from server tool crashes |

---

## AC1: Unified WS Protocol

### AC1.1 -- Client connects to `/ws`, sends `message:send`, message is persisted

**Automated: Integration test**
- Phase/Task: P3/T3
- File: `packages/web/src/server/__tests__/websocket.test.ts`
- Test: Open WS connection, send `{ type: "message:send", thread_id, content }`, query messages table, assert row exists with correct `thread_id`, `content`, and `role = "user"`. Verify `message:created` event is emitted on the eventBus.
- Additional cases:
  - Empty content receives error response
  - Message to thread with pending client tool calls is still persisted and queued (not rejected)

---

### AC1.2 -- `POST /api/threads/:id/messages` removed; returns 404

**Automated: Integration test**
- Phase/Task: P7/T3
- File: `packages/web/src/server/__tests__/messages.test.ts`
- Test: Send HTTP POST to `/api/threads/:id/messages` with valid body. Assert response status is 404 and body contains the migration notice. Verify GET routes for messages still return 200.

---

### AC1.3 -- Client receives `message:created`, `task:updated`, `file:updated`, `context:debug` events

**Automated: Integration test**
- Phase/Task: P3/T6
- File: `packages/web/src/server/__tests__/websocket.test.ts`
- Tests:
  - Subscribe to a thread via `thread:subscribe`. Emit `message:created` on eventBus for that thread. Assert WS client receives JSON with `type: "message:created"`.
  - Emit `task:completed` on eventBus. Assert WS client receives JSON with `type: "task:updated"` (not `task_update`).
  - Emit `file:changed` on eventBus. Assert WS client receives JSON with `type: "file:updated"` (not `file_update`).
  - Emit `context:debug` on eventBus. Assert WS client receives JSON with `type: "context:debug"`.
  - Non-subscribed clients do NOT receive thread-scoped events.

---

### AC1.4 -- Malformed WS messages receive error without killing connection

**Automated: Unit test**
- Phase/Task: P3/T2
- File: `packages/web/src/server/__tests__/websocket.test.ts`
- Tests:
  - Send invalid JSON string over WS. Assert client receives `{ type: "error", code: "invalid_json" }`. Assert connection remains open (subsequent valid message still works).
  - Send valid JSON that fails schema validation (e.g., `{ type: "unknown_type" }`). Assert client receives `{ type: "error", code: "invalid_message" }`. Assert connection remains open.

---

### AC1.5 -- `thread:status` events push to subscribed clients on state changes

**Automated: Integration test**
- Phase/Task: P3/T6
- File: `packages/web/src/server/__tests__/websocket.test.ts`
- Test: Subscribe to a thread. Trigger a thread status change event. Assert WS client receives `{ type: "thread:status", thread_id, active, state }`. Assert non-subscribed clients do not receive the event.

---

## AC2: BoundClient Merges BoundSocket

### AC2.1 -- Single `BoundClient` import provides WS + HTTP + subscriptions + tools

**Automated: Unit test**
- Phase/Task: P5/T2
- File: `packages/client/src/__tests__/client.test.ts`
- Test: Import `BoundClient` from `@bound/client`. Instantiate. Assert the following methods exist: `connect()`, `disconnect()`, `subscribe()`, `unsubscribe()`, `sendMessage()`, `configureTools()`, `onToolCall()`, `listThreads()`, `listMessages()`, `on()`, `off()`.

---

### AC2.2 -- `BoundSocket` class and `socket.ts` no longer exist

**Automated: Unit test**
- Phase/Task: P5/T2
- File: `packages/client/src/__tests__/client.test.ts`
- Tests:
  - Assert `import { BoundSocket } from "@bound/client"` fails (or `BoundSocket` is undefined when dynamically imported).
  - Assert `packages/client/src/socket.ts` does not exist on the filesystem (via a build or glob check).

---

### AC2.3 -- Auto-reconnect re-sends `session:configure` and active subscriptions

**Automated: Unit test (with mocked WebSocket)**
- Phase/Task: P5/T2
- File: `packages/client/src/__tests__/client.test.ts`
- Test: Create `BoundClient`, connect with mock WS. Call `configureTools([...])` and `subscribe("thread-1")`. Simulate WS close event. Assert reconnection is scheduled (exponential backoff). Simulate reconnect success (new WS open). Assert mock WS received a `session:configure` message with the previously configured tools AND a `thread:subscribe` message for `"thread-1"`.

---

### AC2.4 -- `sendMessage()` fires over WS; created message arrives via `message:created` event

**Automated: Unit test (with mocked WebSocket)**
- Phase/Task: P5/T2
- File: `packages/client/src/__tests__/client.test.ts`
- Test: Create `BoundClient`, connect with mock WS. Call `sendMessage("thread-1", "hello")`. Assert return type is `void` (not `Promise<Message>`). Assert mock WS received `{ type: "message:send", thread_id: "thread-1", content: "hello" }`. No HTTP fetch call was made.

---

### AC2.5 -- Event names use colon delimiters

**Automated: Unit test**
- Phase/Task: P5/T1
- File: `packages/client/src/__tests__/client.test.ts`
- Test: Verify `BoundSocketEvents` interface keys include `"task:updated"` and `"file:updated"`. Verify there are no keys matching `"task_update"` or `"file_update"`. (Compile-time type test or runtime event registration test.)

---

## AC3: Client-Side Tool Registration & Execution

### AC3.1 -- `session:configure` tools included in LLM tool list

**Automated: Integration test**
- Phase/Task: P2/T2
- File: `packages/agent/src/__tests__/client-tool-dispatch.test.ts`
- Test: Configure `AgentLoopConfig` with `clientTools` map containing a tool `"browser_click"`. Configure `MockLLMBackend`. Run agent loop. Capture the `tools` array passed to `backend.chat()`. Assert it contains a tool definition with `function.name === "browser_click"` alongside any server-side tools.

---

### AC3.2 -- LLM calls client tool; client receives `tool:call` with correct payload

**Automated: Integration test**
- Phase/Task: P2/T2 (dispatch) + P3/T5 (delivery)
- File: `packages/agent/src/__tests__/client-tool-dispatch.test.ts` (dispatch), `packages/web/src/server/__tests__/websocket.test.ts` (delivery)
- Tests:
  - **Dispatch test:** Configure mock LLM to return `tool_use` block for a client tool. Run `executeToolCall()`. Assert it returns a `ClientToolCallRequest` with correct `toolName`, `callId`, and `arguments`.
  - **Delivery test:** Emit `client_tool_call:created` event. Assert the WS connection subscribed to the thread and matching the tool name receives `{ type: "tool:call", call_id, thread_id, tool_name, arguments }`.

---

### AC3.3 -- Client sends `tool:result`; agent loop resumes with result in context

**Automated: Integration test**
- Phase/Task: P2/T3, P2/T4
- File: `packages/agent/src/__tests__/client-tool-dispatch.test.ts`
- Test: Full round-trip:
  1. Configure `MockLLMBackend` with two responses: first returns `tool_use` for a client tool, second returns text.
  2. Run agent loop with `clientTools` configured. Verify loop exits after first turn (client tool deferred).
  3. Insert `tool_result` message into messages table. Enqueue `tool_result` dispatch_queue entry.
  4. Re-run agent loop. Verify LLM receives context containing both the `tool_call` and `tool_result` messages. Verify loop completes with the text response.

---

### AC3.4 -- Mixed turn: server tools eager, client tools deferred, loop yields

**Automated: Integration test**
- Phase/Task: P2/T3
- File: `packages/agent/src/__tests__/client-tool-dispatch.test.ts`
- Test: Configure `MockLLMBackend` to return BOTH a server tool call (e.g., `bash`) and a client tool call (e.g., `browser_click`) in the same turn. Run agent loop. Assert:
  - Server tool executed immediately (tool_result message persisted for `bash`).
  - Client tool deferred (tool_call message persisted for `browser_click`, NO tool_result).
  - `client_tool_call` entry created in dispatch_queue.
  - Loop exited (`continueLoop = false`).

---

### AC3.5 -- `tool:result` with unknown `call_id` receives error

**Automated: Unit test**
- Phase/Task: P3/T4
- File: `packages/web/src/server/__tests__/websocket.test.ts`
- Test: Send `{ type: "tool:result", call_id: "nonexistent", thread_id, content: "result" }` over WS. Assert client receives `{ type: "error", code: "unknown_call_id", call_id: "nonexistent" }`.

---

### AC3.6 -- Tools persist for connection lifetime without re-registration

**Automated: Unit test**
- Phase/Task: P3/T1, P3/T2
- File: `packages/web/src/server/__tests__/websocket.test.ts`
- Tests:
  - Send `session:configure` with tools. Send multiple `message:send` messages. Verify connection's `clientTools` map still contains the tools after each message (not cleared).
  - Send `session:configure` with new tools. Verify old tools replaced. Send `session:configure` with empty array. Verify tools cleared.

---

## AC4: Persistent Tool Call Queue

### AC4.1 -- Client tool calls create `client_tool_call` entries in `dispatch_queue`

**Automated: Unit test**
- Phase/Task: P1/T1
- File: `packages/core/src/__tests__/dispatch-queue.test.ts`
- Test: Call `enqueueClientToolCall(db, threadId, { call_id, tool_name, arguments }, connectionId)`. Query dispatch_queue. Assert entry exists with `event_type = 'client_tool_call'`, `status = 'pending'`, `claimed_by = connectionId`. Parse `event_payload` JSON and assert it matches the input payload.

---

### AC4.2 -- Thread locked while `client_tool_call` entries pending; new messages queue

**Automated: Unit test**
- Phase/Task: P1/T2
- File: `packages/core/src/__tests__/dispatch-queue.test.ts`
- Tests:
  - Insert a `client_tool_call` entry for a thread. Call `claimPending()` for that thread. Assert result is empty (skips the entry).
  - Insert both a `client_tool_call` and a `user_message` entry for the same thread. Call `claimPending()`. Assert only the `user_message` is returned (client tool call skipped, user message still claimable).
  - `hasPendingClientToolCalls(db, threadId)` returns `true` when pending entries exist, `false` when none or all acknowledged.
  - `hasPendingClientToolCalls` returns `true` for entries with `status = 'processing'`.

---

### AC4.3 -- After server restart, pending tool calls re-delivered on reconnect

**Automated: Integration test**
- Phase/Task: P1/T4 (bootstrap recovery), P8/T2 (bootstrap integration), P8/T4 (reconnect re-delivery)
- File: `packages/core/src/__tests__/dispatch-queue.test.ts` (resetProcessing exclusion), `packages/web/src/server/__tests__/websocket.test.ts` (reconnect re-delivery)
- Tests:
  - **Bootstrap recovery:** Insert `client_tool_call` entries with `status = 'processing'` and non-null `claimed_by` (simulating mid-flight crash). Run bootstrap recovery. Assert entries are reset to `status = 'pending'` with `claimed_by = NULL`.
  - **resetProcessing exclusion:** Call `resetProcessing()`. Assert `client_tool_call` entries are NOT affected (still `'pending'`/`'processing'`, not reset like regular entries). Assert regular `user_message` entries with `status = 'processing'` ARE reset.
  - **Reconnect re-delivery:** Insert pending `client_tool_call` entry. Simulate client disconnect + reconnect. Client sends `session:configure` with matching tool name + `thread:subscribe`. Assert client receives `tool:call` message. Assert `claimed_by` updated to new `connectionId`.

---

### AC4.4 -- Stale entries expired by TTL; interruption notice injected; thread unblocked

**Automated: Integration test**
- Phase/Task: P1/T3 (expiry function), P8/T1 (periodic scan + notice injection)
- File: `packages/core/src/__tests__/dispatch-queue.test.ts` (expiry), integration test for scan
- Tests:
  - **Expiry function:** Insert `client_tool_call` entries with old `created_at` timestamps. Call `expireClientToolCalls(db, undefined, shortTtlMs)`. Assert old entries are marked `status = 'expired'`. Assert recent entries are untouched. Assert `hasPendingClientToolCalls` returns `false` after expiry.
  - **Periodic scan:** Insert stale `client_tool_call` entry. Run the expiry scan. Assert a system message is injected into the thread with content matching `[Client tool call expired]`. Assert thread is re-triggered via `handleThread`.
  - **Multiple entries same thread:** Insert multiple stale entries for one thread. Assert only a single interruption notice is injected (not one per entry).

---

### AC4.5 -- Thread cancel expires pending client tool calls and unblocks thread

**Automated: Unit test**
- Phase/Task: P1/T3 (cancelClientToolCalls function), P8/T3 (cancel integration)
- File: `packages/core/src/__tests__/dispatch-queue.test.ts` (function), `packages/web/src/server/__tests__/status.test.ts` (cancel handler)
- Tests:
  - **Cancel function:** Insert `client_tool_call` entries with `status = 'pending'` and `status = 'processing'`. Call `cancelClientToolCalls(db, threadId)`. Assert all entries are `status = 'expired'`. Assert function returns correct count. Assert `hasPendingClientToolCalls` returns `false`.
  - **Cancel function empty:** Call `cancelClientToolCalls` on thread with no pending entries. Assert returns 0 with no error.
  - **Cancel handler integration:** POST to `/api/status/cancel/:threadId`. Assert pending `client_tool_call` entries are expired. Assert interruption system message injected with `[Client tool calls cancelled]`. Assert thread is unblocked.

---

## AC5: MCP Server

### AC5.1 -- `bound-mcp` sends messages via WS and detects completion via `thread:status` event

**Automated: Unit test (with mocked BoundClient)**
- Phase/Task: P6/T1
- File: `packages/mcp-server/src/__tests__/handler.test.ts`
- Test: Mock `BoundClient`. Invoke the MCP handler with a chat message. Assert:
  - `client.connect()` was called during startup.
  - `client.subscribe(threadId)` was called before sending.
  - `client.sendMessage(threadId, message)` was called (WS, fire-and-forget).
  - A `thread:status` event listener was registered via `client.on("thread:status", ...)`.
  - When the listener receives `{ thread_id: threadId, active: false }`, the handler fetches `client.listMessages(threadId)` via HTTP and returns the response.
  - Event listener is cleaned up after completion.
- Additional case: Timeout -- if `thread:status` event does not arrive within `MAX_POLL_MS`, handler returns an error.

---

### AC5.2 -- `bound-mcp` does not expose a tools parameter

**Automated: Unit test**
- Phase/Task: P6/T1
- File: `packages/mcp-server/src/__tests__/handler.test.ts`
- Test: Mock `BoundClient`. Invoke the MCP handler. Assert `client.configureTools()` is never called. Inspect the MCP tool schema definition for `bound_chat` and assert no `tools` parameter exists.

---

## AC6: Svelte Web UI

### AC6.1 -- Web UI uses single `BoundClient` (no separate `BoundSocket`)

**Human verification**
- Phase/Task: P7/T1
- Justification: Svelte components lack unit test infrastructure in this codebase. Verification is a codebase search.
- Steps:
  1. Run `grep -r "BoundSocket" packages/web/src/client/` and assert zero matches.
  2. Run `grep -r "from.*socket" packages/web/src/client/lib/bound.ts` and assert zero matches.
  3. Verify `packages/web/src/client/lib/bound.ts` imports only `BoundClient` from `@bound/client`.
  4. Run `tsc -p packages/web --noEmit` and verify no type errors.
  5. Run `bun run build` and verify Vite build succeeds.

---

### AC6.2 -- Message sending works over WS; UI renders responses via `message:created` events

**Human verification + e2e**
- Phase/Task: P7/T2
- Justification: Requires a running server and Svelte UI interaction. Playwright e2e is appropriate but may not exist for this flow.
- Steps:
  1. Start the app: `bun packages/cli/src/bound.ts start`.
  2. Open the web UI in a browser.
  3. Navigate to a thread.
  4. Type a message and send.
  5. Confirm the message appears in the thread via the `message:created` event (no full page reload needed).
  6. Confirm the agent response also appears via `message:created` event.
  7. Open browser DevTools Network tab -- verify no HTTP POST to `/api/threads/:id/messages`. Verify WS frames contain `message:send` and `message:created`.

**Automated (if Playwright e2e suite covers chat):**
- File: `e2e/chat.spec.ts` (create if needed)
- Test: Navigate to thread, send message, assert response appears in DOM within timeout.

---

### AC6.3 -- Event listeners use updated names (`task:updated`, `file:updated`)

**Human verification**
- Phase/Task: P7/T1
- Justification: Codebase search for old event names.
- Steps:
  1. Run `grep -r "task_update" packages/web/src/client/` and assert zero matches.
  2. Run `grep -r "file_update" packages/web/src/client/` and assert zero matches.
  3. Run `grep -r "task:updated" packages/web/src/client/` and assert at least one match.
  4. Run `grep -r "file:updated" packages/web/src/client/` and assert at least one match.

---

## AC7: Cross-Cutting Recovery

### AC7.1 -- Client disconnect + reconnect re-delivers pending tool calls matched by tool name

**Automated: Integration test**
- Phase/Task: P8/T4
- File: `packages/web/src/server/__tests__/websocket.test.ts`
- Test:
  1. Open WS connection. Send `session:configure` with tool `"browser_click"`. Subscribe to a thread.
  2. Insert a pending `client_tool_call` entry for that thread with `tool_name = "browser_click"`.
  3. Close the WS connection (simulate disconnect).
  4. Open new WS connection. Send `session:configure` with same tool. Subscribe to the same thread.
  5. Assert client receives `tool:call` message with the pending call details.
  6. Assert the entry's `claimed_by` in dispatch_queue is updated to the new connection's `connectionId`.
- Additional case: Reconnect without the matching tool -- pending call is NOT re-delivered (remains pending for another client or TTL).

---

### AC7.2 -- `claimed_by` updated to new `connectionId` on reconnect

**Automated: Unit test**
- Phase/Task: P8/T4, P1/T3
- File: `packages/core/src/__tests__/dispatch-queue.test.ts`
- Test: Insert `client_tool_call` entry with `claimed_by = "old-conn-id"`. Call `updateClaimedBy(db, entryId, "new-conn-id")`. Query the entry. Assert `claimed_by = "new-conn-id"` and `status = 'processing'`.

---

### AC7.3 -- `tool:result` for expired entry receives error with `code: "tool_call_expired"`

**Automated: Unit test**
- Phase/Task: P3/T4, P8/T4
- File: `packages/web/src/server/__tests__/websocket.test.ts`
- Test: Insert `client_tool_call` entry. Call `expireClientToolCalls` to expire it. Send `{ type: "tool:result", call_id, thread_id, content: "result" }` over WS. Assert client receives `{ type: "error", code: "tool_call_expired", call_id }`. Assert no `tool_result` message is persisted.

---

### AC7.4 -- Bootstrap recovery distinguishes `client_tool_call` from interrupted server tool calls

**Automated: Integration test**
- Phase/Task: P1/T4, P8/T2
- File: `packages/core/src/__tests__/dispatch-queue.test.ts` (resetProcessing exclusion), integration test for bootstrap
- Tests:
  - **resetProcessing exclusion:** Insert `client_tool_call` entry with `status = 'processing'`. Also insert `user_message` entry with `status = 'processing'`. Call `resetProcessing()`. Assert `user_message` entry is reset. Assert `client_tool_call` entry is NOT reset by `resetProcessing` (it remains `'processing'`; separate bootstrap recovery handles it).
  - **resetProcessingForThread exclusion:** Same test but using `resetProcessingForThread(db, threadId)`. Assert `client_tool_call` entries are excluded.
  - **Bootstrap does not inject spurious interruption notice:** Insert `client_tool_call` entry (simulating pending client tool). Run bootstrap. Assert no `[Interrupted]` system message is injected for the client tool call. (The existing interrupted-tool detector should skip tool_call messages that have corresponding `client_tool_call` dispatch_queue entries.)

---

## Test File Index

| Test File | Package | ACs Covered |
|-----------|---------|-------------|
| `packages/core/src/__tests__/dispatch-queue.test.ts` | core | AC4.1, AC4.2, AC4.3, AC4.4, AC4.5, AC7.2, AC7.4 |
| `packages/agent/src/__tests__/client-tool-dispatch.test.ts` | agent | AC3.1, AC3.2, AC3.3, AC3.4 |
| `packages/web/src/server/__tests__/websocket.test.ts` | web | AC1.1, AC1.3, AC1.4, AC1.5, AC3.2, AC3.5, AC3.6, AC7.1, AC7.3 |
| `packages/web/src/server/__tests__/messages.test.ts` | web | AC1.2 |
| `packages/web/src/server/__tests__/status.test.ts` | web | AC4.5 |
| `packages/client/src/__tests__/client.test.ts` | client | AC2.1, AC2.2, AC2.3, AC2.4, AC2.5 |
| `packages/mcp-server/src/__tests__/handler.test.ts` | mcp-server | AC5.1, AC5.2 |
| `e2e/chat.spec.ts` (if created) | e2e | AC6.2 |

## Human Verification Index

| AC | Phase/Task | Verification Approach | Justification |
|----|------------|----------------------|---------------|
| AC6.1 | P7/T1 | Codebase search for `BoundSocket` references; typecheck; build | Svelte components lack unit tests; verification is a static analysis pass |
| AC6.2 | P7/T2 | Manual browser test: send message, confirm WS frames in DevTools, no HTTP POST | Requires running server + UI interaction; Playwright e2e can supplement if available |
| AC6.3 | P7/T1 | Codebase search for old event names (`task_update`, `file_update`) | Static analysis; no runtime behavior to test beyond build success |
