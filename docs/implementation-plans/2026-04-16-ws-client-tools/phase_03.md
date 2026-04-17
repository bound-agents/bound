# WebSocket Client Tools Implementation Plan — Phase 3

**Goal:** Upgrade the `/ws` endpoint from server-push-only to fully bidirectional, handling all client→server message types including `session:configure`, `message:send`, `tool:result`, and subscription management.

**Architecture:** The existing `createWebSocketHandler()` in `websocket.ts` (lines 21-182) currently only handles `subscribe`/`unsubscribe` messages (lines 135-166). This phase extends it to dispatch by message type, adds per-connection state for client tools, and wires up tool:call delivery and tool:result handling. Event names migrate from underscore (`task_update`) to colon-delimited (`task:updated`).

**Tech Stack:** Bun, TypeScript, bun:sqlite, Hono

**Scope:** 8 phases from original design (this is phase 3 of 8)

**Codebase verified:** 2026-04-16

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ws-client-tools.AC1: Unified WS Protocol
- **ws-client-tools.AC1.1 Success:** Client connects to `/ws`, sends `message:send`, and message is persisted to the thread
- **ws-client-tools.AC1.3 Success:** Client receives `message:created`, `task:updated`, `file:updated`, `context:debug` events for subscribed threads
- **ws-client-tools.AC1.4 Failure:** Malformed WS messages receive `error` response without killing the connection
- **ws-client-tools.AC1.5 Success:** `thread:status` events push to subscribed clients on state changes (replaces polling)

### ws-client-tools.AC3: Client-Side Tool Registration & Execution (partial)
- **ws-client-tools.AC3.5 Failure:** `tool:result` with unknown `call_id` receives `error` response
- **ws-client-tools.AC3.6 Success:** Tools persist for connection lifetime without re-registration per message

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Extended ClientConnection type and WS message schemas

**Verifies:** ws-client-tools.AC3.6

**Files:**
- Modify: `packages/web/src/server/websocket.ts` (update `ClientConnection` type at line 24, add Zod schemas)

**Implementation:**

1. **Extend `ClientConnection` type** (currently at line 24 with `ws` and `subscriptions` fields):

   ```typescript
   interface ClientConnection {
       ws: ServerWebSocket<unknown>;
       connectionId: string;
       subscriptions: Set<string>;
       clientTools: Map<string, { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
   }
   ```

   Add `connectionId` (generated via `crypto.randomUUID()` at connection open) and `clientTools` (populated by `session:configure`, persists for connection lifetime).

2. **Define Zod schemas for all client→server message types:**

   ```typescript
   const sessionConfigureSchema = z.object({
       type: z.literal("session:configure"),
       tools: z.array(z.object({
           type: z.literal("function"),
           function: z.object({
               name: z.string(),
               description: z.string(),
               parameters: z.record(z.string(), z.unknown()),
           }),
       })),
   });

   const messageSendSchema = z.object({
       type: z.literal("message:send"),
       thread_id: z.string(),
       content: z.string(),
       file_ids: z.array(z.string()).optional(),
   });

   const threadSubscribeSchema = z.object({
       type: z.literal("thread:subscribe"),
       thread_id: z.string(),
   });

   const threadUnsubscribeSchema = z.object({
       type: z.literal("thread:unsubscribe"),
       thread_id: z.string(),
   });

   const toolResultSchema = z.object({
       type: z.literal("tool:result"),
       call_id: z.string(),
       thread_id: z.string(),
       content: z.string(),
       is_error: z.boolean().optional(),
   });

   const wsClientMessageSchema = z.discriminatedUnion("type", [
       sessionConfigureSchema,
       messageSendSchema,
       threadSubscribeSchema,
       threadUnsubscribeSchema,
       toolResultSchema,
   ]);
   ```

3. **Replace the old `wsMessageSchema`** (lines 5-8, which only handled `{ subscribe?, unsubscribe? }`) with the new discriminated union. The old format is no longer accepted — clients must use the new `thread:subscribe`/`thread:unsubscribe` message types.

**Testing:**

Tests must verify:
- ws-client-tools.AC3.6: The `ClientConnection` type includes `clientTools` Map that persists tool definitions
- Schema validation: each message type parses correctly with valid input, rejects invalid input
- Discriminated union correctly dispatches by `type` field

Add tests to: `packages/web/src/server/__tests__/websocket.test.ts` (create if needed)

**Verification:**
Run: `tsc -p packages/web --noEmit`
Expected: No type errors

**Commit:** `feat(web): extended ClientConnection type and WS message schemas`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Message dispatcher and session:configure / subscription handlers

**Verifies:** ws-client-tools.AC1.4, ws-client-tools.AC3.6

**Files:**
- Modify: `packages/web/src/server/websocket.ts` (rewrite `message()` handler at line 135)

**Implementation:**

Replace the current `message()` handler (lines 135-166) with a type-dispatching handler:

1. **Parse and validate** — Parse incoming JSON, validate with `wsClientMessageSchema`. On parse failure, send `error` response without closing the connection:

   ```typescript
   message(ws, message) {
       const conn = connections.get(ws);
       if (!conn) return;

       let parsed: unknown;
       try {
           parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
       } catch {
           ws.send(JSON.stringify({ type: "error", code: "invalid_json", message: "Invalid JSON" }));
           return;
       }

       const result = wsClientMessageSchema.safeParse(parsed);
       if (!result.success) {
           ws.send(JSON.stringify({ type: "error", code: "invalid_message", message: result.error.message }));
           return;
       }

       const msg = result.data;
       switch (msg.type) {
           case "session:configure": handleSessionConfigure(conn, msg); break;
           case "message:send": handleMessageSend(conn, msg); break;
           case "thread:subscribe": handleThreadSubscribe(conn, msg); break;
           case "thread:unsubscribe": handleThreadUnsubscribe(conn, msg); break;
           case "tool:result": handleToolResult(conn, msg); break;
       }
   }
   ```

2. **`handleSessionConfigure`** — Store tool definitions on the connection:

   ```typescript
   function handleSessionConfigure(conn: ClientConnection, msg: z.infer<typeof sessionConfigureSchema>) {
       conn.clientTools.clear();
       for (const tool of msg.tools) {
           conn.clientTools.set(tool.function.name, tool);
       }
       // Scan for pending client_tool_call entries that match this connection's tools
       // (reconnection delivery — Phase 8 completes this, but structure the scan here)
   }
   ```

3. **`handleThreadSubscribe` / `handleThreadUnsubscribe`** — Same logic as current subscribe/unsubscribe but using the new message format:

   ```typescript
   function handleThreadSubscribe(conn: ClientConnection, msg: z.infer<typeof threadSubscribeSchema>) {
       conn.subscriptions.add(msg.thread_id);
   }
   function handleThreadUnsubscribe(conn: ClientConnection, msg: z.infer<typeof threadUnsubscribeSchema>) {
       conn.subscriptions.delete(msg.thread_id);
   }
   ```

4. **Update `open()` handler** — Initialize the new connection fields:

   ```typescript
   open(ws) {
       connections.set(ws, {
           ws,
           connectionId: crypto.randomUUID(),
           subscriptions: new Set(),
           clientTools: new Map(),
       });
   }
   ```

**Testing:**

Tests must verify:
- ws-client-tools.AC1.4: Malformed JSON and schema-invalid messages produce `error` response, connection stays open
- ws-client-tools.AC3.6: `session:configure` stores tools on connection; subsequent messages can reference them; tools persist across messages without re-registration
- `session:configure` with empty tools array clears previously registered tools
- Subscribe/unsubscribe work with new message format

Add tests to: `packages/web/src/server/__tests__/websocket.test.ts`

**Verification:**
Run: `bun test packages/web`
Expected: All tests pass

**Commit:** `feat(web): WS message dispatcher with session:configure and subscriptions`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: message:send WS handler

**Verifies:** ws-client-tools.AC1.1

**Files:**
- Modify: `packages/web/src/server/websocket.ts` (add `handleMessageSend`)

**Implementation:**

The `handleMessageSend` function replicates the core logic from the POST handler in `messages.ts` (lines 58-182) but operates over WS. The `createWebSocketHandler()` function needs access to `db`, `siteId`, `eventBus`, and `appContext` — these should be passed as parameters to the factory function (extending its current signature which only takes `eventBus`).

1. **Extend `createWebSocketHandler` signature** to accept the dependencies needed for message handling:

   ```typescript
   export function createWebSocketHandler(config: {
       eventBus: TypedEventEmitter;
       db: Database;
       siteId: string;
       defaultUserId: string; // web user ID for messages
   }): WebSocketConfig
   ```

2. **`handleMessageSend` implementation:**

   - Validate content is non-empty and within 512KB limit (matching POST handler lines 75-95)
   - **Always persist the message** using `insertRow(db, "messages", ...)` (matching the POST handler pattern at lines 131-151, using the changelog-tracked write), regardless of whether the thread has pending client tool calls
   - Handle file_ids if provided (matching lines 108-129)
   - Emit `message:created` event via eventBus (matching lines 164-167) — this enqueues the message in dispatch_queue and triggers handleThread
   - If the thread has pending client tool calls, the message will be queued in dispatch_queue and processed after all tool calls resolve (the design specifies silent queuing, not error rejection)
   - Do NOT return a response — the message arrives back to the client via the `message:created` event broadcast

3. **Error handling** — Wrap in try/catch, send `error` event on failure without closing the connection.

**Testing:**

Tests must verify:
- ws-client-tools.AC1.1: Client sends `message:send` over WS, message is persisted to the thread (verify in DB), `message:created` event is emitted
- Message with empty content receives error response
- Message to thread with pending client tool calls is still persisted and queued (not rejected) — it will be processed after tool calls resolve
- File attachment handling works via WS (if file_ids provided)

Add tests to: `packages/web/src/server/__tests__/websocket.test.ts`

**Verification:**
Run: `bun test packages/web`
Expected: All tests pass

**Commit:** `feat(web): message:send WS handler replaces POST message endpoint`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: tool:result WS handler

**Verifies:** ws-client-tools.AC3.5

**Files:**
- Modify: `packages/web/src/server/websocket.ts` (add `handleToolResult`)

**Implementation:**

1. **`handleToolResult` implementation:**

   - Look up the `client_tool_call` dispatch_queue entry by `call_id`: use `getPendingClientToolCalls(db, msg.thread_id)` from Phase 1 and filter in application code by parsing `event_payload` JSON and matching `call_id`. This avoids SQL injection risk from JSON querying.
   - **If no matching entry found:** Send error: `{ type: "error", code: "unknown_call_id", message: "No pending tool call with this call_id", call_id: msg.call_id }`
   - **If entry is expired:** Send error: `{ type: "error", code: "tool_call_expired", message: "Tool call has expired", call_id: msg.call_id }`
   - **If valid:** 
     a. Persist the tool_result message to the messages table using `insertRow(db, "messages", ...)` with `role: "tool_result"` and content matching the format the agent loop expects
     b. Call `acknowledgeClientToolCall(db, entry.message_id)` to mark the dispatch_queue entry
     c. Call `enqueueToolResult(db, msg.thread_id, msg.call_id)` to trigger agent loop resume
     d. Emit event to trigger `handleThread` for the thread

2. **Call ID lookup implementation** — Use `getPendingClientToolCalls(db, msg.thread_id)` and iterate the results, parsing each entry's `event_payload` JSON to find the one with matching `call_id`. This is safe and efficient since the number of pending tool calls per thread is small.

**Testing:**

Tests must verify:
- ws-client-tools.AC3.5: `tool:result` with unknown `call_id` receives error with `code: "unknown_call_id"`
- `tool:result` with valid `call_id` persists tool_result message, acknowledges dispatch entry, enqueues tool_result trigger
- `tool:result` for expired entry receives error with `code: "tool_call_expired"`
- `tool:result` with `is_error: true` persists the error content correctly

Add tests to: `packages/web/src/server/__tests__/websocket.test.ts`

**Verification:**
Run: `bun test packages/web`
Expected: All tests pass

**Commit:** `feat(web): tool:result WS handler with call_id validation`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->
<!-- START_TASK_5 -->
### Task 5: tool:call delivery to WS clients

**Verifies:** None (infrastructure wiring — delivery verified end-to-end in Phase 4)

**Files:**
- Modify: `packages/web/src/server/websocket.ts` (add delivery logic)

**Implementation:**

When the agent loop enqueues a `client_tool_call` dispatch_queue entry (Phase 2), the WS handler needs to deliver the `tool:call` message to the appropriate client connection. Two delivery mechanisms:

1. **Event-driven delivery** — Listen for a new event on the eventBus. The agent loop (or the dispatch layer) should emit an event when a `client_tool_call` entry is created. Add a listener:

   ```typescript
   eventBus.on("client_tool_call:created", (data: { threadId: string; callId: string; toolName: string; arguments: Record<string, unknown> }) => {
       // Find connection subscribed to this thread that has the matching tool
       for (const [, conn] of connections) {
           if (conn.subscriptions.has(data.threadId) && conn.clientTools.has(data.toolName)) {
               conn.ws.send(JSON.stringify({
                   type: "tool:call",
                   call_id: data.callId,
                   thread_id: data.threadId,
                   tool_name: data.toolName,
                   arguments: data.arguments,
               }));
               // Update dispatch_queue entry status to 'processing' and claimed_by to conn.connectionId
               break; // Deliver to first matching connection
           }
       }
   });
   ```

   Note: The `client_tool_call:created` event type is added to `EventMap` in `packages/shared/src/events.ts` during Phase 2 Task 3. The agent loop emits this event after enqueueing each client tool call.

2. **Scan on session:configure** — When a client sends `session:configure`, scan for pending `client_tool_call` entries on threads the client is subscribed to that match the newly registered tool names. Deliver any found. This handles reconnection scenarios (Phase 8 completes this, but the scan structure should be here).

**Testing:**

Tests should verify the delivery function finds the correct connection by tool name and thread subscription. Full end-to-end delivery is verified in Phase 4 integration.

Add tests to: `packages/web/src/server/__tests__/websocket.test.ts`

**Verification:**
Run: `bun test packages/web`
Expected: All tests pass

**Commit:** `feat(web): tool:call delivery to matching WS connections`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Event name migration and thread:status push

**Verifies:** ws-client-tools.AC1.3, ws-client-tools.AC1.5

**Files:**
- Modify: `packages/web/src/server/websocket.ts` (update event handler names at lines 43-79, add thread:status handler)

**Implementation:**

1. **Event name migration** — Update the outgoing event type names in the broadcast handlers:
   - `handleTaskCompleted` (line 48): Change `type: "task_update"` to `type: "task:updated"`
   - `handleFileChanged` (line 67): Change `type: "file_update"` to `type: "file:updated"`
   - Keep internal eventBus listener names unchanged (`task:completed`, `file:changed`) — only the WS message `type` field changes

2. **thread:status push** — Add a new handler that pushes thread status changes to subscribed clients. Listen for a `status:forward` event (already exists in the EventMap) or create a new `thread:status` event:

   ```typescript
   function handleThreadStatus(threadId: string, status: { active: boolean; state: string | null; tokens: number; model: string | null }) {
       for (const [, conn] of connections) {
           if (conn.subscriptions.has(threadId)) {
               conn.ws.send(JSON.stringify({
                   type: "thread:status",
                   thread_id: threadId,
                   ...status,
               }));
           }
       }
   }
   ```

   Wire this to the appropriate event source. The agent loop emits status updates — find where loop state changes are emitted and hook into that. The `status:forward` event in the EventMap (used for relay status forwarding) is one source. For local loops, emit a similar event when the loop starts/stops/changes state.

3. **Disconnect cleanup** — In the `close()` handler, clean up the connection from the map. Leave any `client_tool_call` entries in dispatch_queue as `pending` (they'll be re-delivered on reconnect or expired by TTL — Phase 8).

**Testing:**

Tests must verify:
- ws-client-tools.AC1.3: Subscribed clients receive events with updated names: `task:updated`, `file:updated`, `message:created`, `context:debug`
- ws-client-tools.AC1.5: `thread:status` events are pushed to subscribed clients when thread state changes
- Non-subscribed clients do NOT receive thread-scoped events

Add tests to: `packages/web/src/server/__tests__/websocket.test.ts`

**Verification:**
Run: `bun test packages/web`
Expected: All tests pass

**Commit:** `feat(web): event name migration and thread:status push`
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_C -->
