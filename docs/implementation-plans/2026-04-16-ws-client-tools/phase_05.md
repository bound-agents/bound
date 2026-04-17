# WebSocket Client Tools Implementation Plan — Phase 5

**Goal:** Merge `BoundSocket` into `BoundClient` with unified API for WS + HTTP, adding client-side tool registration and tool call handling.

**Architecture:** `BoundClient` (client.ts, 274 lines) currently provides HTTP-only methods. `BoundSocket` (socket.ts, 147 lines) provides WS connections with subscribe/unsubscribe and event listening. The merge combines both into a single class: HTTP methods for reads, WS for stateful interactions (message sending, subscriptions, tool registration). Auto-reconnect re-sends `session:configure` and active subscriptions (matching BoundSocket's current reconnect behavior). `sendMessage()` changes from HTTP POST (returning `Promise<Message>`) to fire-and-forget over WS.

**Tech Stack:** TypeScript, WebSocket API

**Scope:** 8 phases from original design (this is phase 5 of 8)

**Codebase verified:** 2026-04-16

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ws-client-tools.AC2: BoundClient Merges BoundSocket
- **ws-client-tools.AC2.1 Success:** Single `BoundClient` import provides WS connection, subscriptions, message sending, and HTTP reads
- **ws-client-tools.AC2.2 Success:** `BoundSocket` class and `packages/client/src/socket.ts` no longer exist
- **ws-client-tools.AC2.3 Success:** Auto-reconnect re-sends `session:configure` and active subscriptions
- **ws-client-tools.AC2.4 Success:** `sendMessage()` fires over WS; created message arrives via `message:created` event
- **ws-client-tools.AC2.5 Success:** Event names use colon delimiters (`task:updated`, `file:updated`)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add WS types and update event names in types.ts

**Verifies:** ws-client-tools.AC2.5

**Files:**
- Modify: `packages/client/src/types.ts` (update BoundSocketEvents at line 168, add tool types)

**Implementation:**

1. **Update `BoundSocketEvents`** (line 168) — Rename event keys to use colon delimiters and add new events:

   ```typescript
   export interface BoundSocketEvents {
       "message:created": (msg: Message) => void;
       "task:updated": (data: { taskId: string; status: string }) => void;
       "file:updated": (data: { path: string; operation: string }) => void;
       "context:debug": (data: ContextDebugTurn) => void;
       "thread:status": (data: { thread_id: string; active: boolean; state: string | null; tokens: number; model: string | null }) => void;
       "tool:call": (call: ToolCallRequest) => void;
       error: (err: Event | Error | { code: string; message: string }) => void;
       open: () => void;
       close: () => void;
   }
   ```

   Changes: `task_update` → `task:updated`, `file_update` → `file:updated`, added `thread:status` and `tool:call`.

2. **Add tool-related types:**

   ```typescript
   export interface ToolDefinition {
       type: "function";
       function: {
           name: string;
           description: string;
           parameters: Record<string, unknown>;
       };
   }

   export interface ToolCallRequest {
       call_id: string;
       thread_id: string;
       tool_name: string;
       arguments: Record<string, unknown>;
   }

   export interface ToolCallResult {
       call_id: string;
       thread_id: string;
       content: string;
       is_error?: boolean;
   }
   ```

3. **Update `SendMessageOptions`** (line 22) — The existing type has `modelId` and `fileId`. Keep as-is since the WS `message:send` handler accepts these via the message payload.

Export all new types from types.ts.

**Testing:**

Tests must verify:
- ws-client-tools.AC2.5: Type compilation succeeds with new event names
- ToolCallRequest, ToolCallResult, and ToolDefinition types are correctly defined

Type-only verification — no runtime tests needed for types.

**Verification:**
Run: `tsc -p packages/client --noEmit`
Expected: No type errors

**Commit:** `feat(client): update event names to colon-delimited and add tool types`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Merge BoundSocket WS logic into BoundClient

**Verifies:** ws-client-tools.AC2.1, ws-client-tools.AC2.2, ws-client-tools.AC2.3, ws-client-tools.AC2.4

**Files:**
- Modify: `packages/client/src/client.ts` (add WS connection, subscriptions, tool registration, message sending over WS)
- Delete: `packages/client/src/socket.ts` (after merge)
- Modify: `packages/client/src/index.ts` (remove BoundSocket export)

**Implementation:**

Add the following to `BoundClient` (currently lines 49-273), incorporating the WS patterns from `BoundSocket` (socket.ts lines 15-146):

1. **WS connection state** — Add private fields:

   ```typescript
   private ws: WebSocket | null = null;
   private wsUrl: string;
   private subscriptions = new Set<string>();
   private clientTools: ToolDefinition[] = [];
   private toolCallHandler: ((call: ToolCallRequest) => Promise<ToolCallResult>) | null = null;
   private listeners = new Map<string, Set<Function>>();
   private shouldReconnect = false;
   private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
   private reconnectDelay = 1000;
   ```

2. **Derive `wsUrl`** from `baseUrl` in constructor (matching BoundSocket pattern at lines 29-38):
   - Replace `http` with `ws` in URL scheme
   - Append `/ws` path

3. **Connection lifecycle:**
   - `connect()` — Set `shouldReconnect = true`, call `createConnection()`
   - `disconnect()` — Set `shouldReconnect = false`, clear reconnect timer, close WS
   - Private `createConnection()` — Open WebSocket, wire `onopen`/`onmessage`/`onerror`/`onclose` handlers

4. **Auto-reconnect** (matching BoundSocket lines 136-145):
   - On close: if `shouldReconnect`, schedule reconnect with exponential backoff (1s base, 30s max, jitter)
   - On reconnect success: re-send `session:configure` with stored `clientTools`, re-send subscriptions for all tracked thread IDs
   - Reset `reconnectDelay` to 1s on successful open

5. **WS message handling** — On incoming message:
   - Parse JSON, extract `type` field
   - For `tool:call`: if `toolCallHandler` is registered, invoke it and send `tool:result` back automatically
   - For all other types: emit as typed event to registered listeners

6. **Session configuration:**
   - `configureTools(tools: ToolDefinition[])` — Store tools locally, send `session:configure` message over WS
   - `onToolCall(handler: (call: ToolCallRequest) => Promise<ToolCallResult>)` — Register the callback invoked when `tool:call` arrives. When called, handler receives the request, returns the result, and `BoundClient` automatically sends `tool:result` back.

7. **Subscriptions:**
   - `subscribe(threadId)` — Add to local Set, send `thread:subscribe` message (new format, not old `{ subscribe: [...] }`)
   - `unsubscribe(threadId)` — Remove from local Set, send `thread:unsubscribe` message
   - `on(event, handler)` / `off(event, handler)` — Typed event listeners (copied from BoundSocket lines 68-83)

8. **Message sending (BREAKING CHANGE):**
   - Modify `sendMessage(threadId, content, options?)` — Change from HTTP POST to WS `message:send`. Fire-and-forget (no return value). The created message arrives via `message:created` event.
   - Return type changes from `Promise<Message>` to `void`
   - This is a breaking change to the `@bound/client` public API. All known consumers (bound-mcp in Phase 6, Svelte UI in Phase 7) are migrated in subsequent phases. External consumers of `@bound/client` will need to update their code.

9. **Delete `socket.ts`** — After all WS logic is in client.ts, remove the file.

10. **Update `index.ts`** — Remove `BoundSocket` export. Add new type exports (`ToolDefinition`, `ToolCallRequest`, `ToolCallResult`).

**Testing:**

Tests must verify:
- ws-client-tools.AC2.1: Single `BoundClient` import provides `connect()`, `subscribe()`, `sendMessage()`, `listThreads()` (HTTP), and `configureTools()`
- ws-client-tools.AC2.2: `BoundSocket` class no longer exists (import fails)
- ws-client-tools.AC2.3: After disconnect + reconnect, `session:configure` is re-sent with previously configured tools, and active subscriptions are re-sent
- ws-client-tools.AC2.4: `sendMessage()` sends `message:send` over WS, does not make HTTP POST
- Event listener registration and dispatch works for all event types

Note: Full integration testing requires a running WS server. Unit tests should mock the WebSocket to verify message sending format and reconnect behavior.

Add tests to: `packages/client/src/__tests__/client.test.ts` (create if needed)

**Verification:**
Run: `tsc -p packages/client --noEmit`
Expected: No type errors

Run: `bun test packages/client` (if tests exist)
Expected: All tests pass

**Commit:** `feat(client): merge BoundSocket into BoundClient, remove socket.ts (AC2.1-AC2.4)`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->
