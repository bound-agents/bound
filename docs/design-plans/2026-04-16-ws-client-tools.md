# WebSocket Client Tools Design

## Summary

This design replaces two separate client-facing interfaces — an HTTP POST endpoint for sending messages and a server-push-only WebSocket for receiving events — with a single persistent, bidirectional WebSocket connection. The unified connection handles everything a client needs: sending messages, subscribing to thread events, and registering tool definitions that the AI agent can invoke. When the agent calls a client-registered tool, it yields execution, delivers a `tool:call` message over the WebSocket, waits for the client to execute the tool locally and return a `tool:result`, then resumes the agent loop with the result in context. This allows clients to expose capabilities (local filesystem access, UI interactions, third-party integrations) to the agent without running those capabilities server-side.

Rather than holding the agent loop in memory while waiting for a client response, pending tool calls are written to the existing `dispatch_queue` database table and the loop exits. The thread remains locked against new agent turns until all client tool results arrive. If the server restarts or the client disconnects and reconnects, pending calls are re-delivered to any reconnecting client that presents matching tool definitions. Stale calls that never receive a response are expired on a TTL, injecting an interruption notice so the agent can recover gracefully.

## Definition of Done

1. **Unified WS protocol** replaces both POST /api/threads/:id/messages and the /ws event subscription endpoint with a single bidirectional WebSocket connection
2. **BoundClient merges BoundSocket** into a single client class with WS-native message sending, event subscription, and client-side tool support
3. **Client-side tool registration** allows clients to declare tool definitions per-connection that the agent can invoke, with the client executing tools and returning results over the same WS connection
4. **Persistent tool call queue** (DB-backed) enables the agent loop to yield while waiting for client tool results, surviving server restarts and supporting long-running tools
5. **MCP server (bound-mcp)** uses the unified WS client internally, buffering events for synchronous MCP response
6. **Svelte web UI** updated to use the new unified client instead of separate BoundClient + BoundSocket

## Acceptance Criteria

### ws-client-tools.AC1: Unified WS Protocol
- **ws-client-tools.AC1.1 Success:** Client connects to `/ws`, sends `message:send`, and message is persisted to the thread
- **ws-client-tools.AC1.2 Success:** `POST /api/threads/:id/messages` is removed; HTTP POST returns 404
- **ws-client-tools.AC1.3 Success:** Client receives `message:created`, `task:updated`, `file:updated`, `context:debug` events for subscribed threads
- **ws-client-tools.AC1.4 Failure:** Malformed WS messages receive `error` response without killing the connection
- **ws-client-tools.AC1.5 Success:** `thread:status` events push to subscribed clients on state changes (replaces polling)

### ws-client-tools.AC2: BoundClient Merges BoundSocket
- **ws-client-tools.AC2.1 Success:** Single `BoundClient` import provides WS connection, subscriptions, message sending, and HTTP reads
- **ws-client-tools.AC2.2 Success:** `BoundSocket` class and `packages/client/src/socket.ts` no longer exist
- **ws-client-tools.AC2.3 Success:** Auto-reconnect re-sends `session:configure` and active subscriptions
- **ws-client-tools.AC2.4 Success:** `sendMessage()` fires over WS; created message arrives via `message:created` event
- **ws-client-tools.AC2.5 Success:** Event names use colon delimiters (`task:updated`, `file:updated`)

### ws-client-tools.AC3: Client-Side Tool Registration & Execution
- **ws-client-tools.AC3.1 Success:** Client sends `session:configure` with tool definitions; agent loop includes those tools in LLM tool list
- **ws-client-tools.AC3.2 Success:** When LLM calls a client tool, client receives `tool:call` over WS with correct name and arguments
- **ws-client-tools.AC3.3 Success:** Client sends `tool:result`; agent loop resumes and LLM sees the result in context
- **ws-client-tools.AC3.4 Success:** Mixed turn with server + client tools: server tools execute eagerly, client tools deferred, loop yields after full pass
- **ws-client-tools.AC3.5 Failure:** `tool:result` with unknown `call_id` receives `error` response
- **ws-client-tools.AC3.6 Success:** Tools persist for connection lifetime without re-registration per message

### ws-client-tools.AC4: Persistent Tool Call Queue
- **ws-client-tools.AC4.1 Success:** Client tool calls create `client_tool_call` entries in `dispatch_queue`
- **ws-client-tools.AC4.2 Success:** Thread is locked while `client_tool_call` entries are pending; new user messages queue
- **ws-client-tools.AC4.3 Success:** After server restart, pending tool calls are re-delivered when client reconnects with matching tools
- **ws-client-tools.AC4.4 Success:** Stale entries (no reconnect within TTL) are expired; interruption notice injected, thread unblocked
- **ws-client-tools.AC4.5 Success:** Thread cancel expires pending client tool calls and unblocks the thread

### ws-client-tools.AC5: MCP Server
- **ws-client-tools.AC5.1 Success:** `bound-mcp` sends messages via WS and detects completion via `thread:status` event
- **ws-client-tools.AC5.2 Success:** `bound-mcp` does not expose a tools parameter

### ws-client-tools.AC6: Svelte Web UI
- **ws-client-tools.AC6.1 Success:** Web UI uses single `BoundClient` (no separate `BoundSocket`)
- **ws-client-tools.AC6.2 Success:** Message sending works over WS; UI renders responses via `message:created` events
- **ws-client-tools.AC6.3 Success:** Event listeners use updated names (`task:updated`, `file:updated`)

### ws-client-tools.AC7: Cross-Cutting Recovery
- **ws-client-tools.AC7.1 Success:** Client disconnect + reconnect re-delivers pending tool calls matched by tool name
- **ws-client-tools.AC7.2 Success:** `claimed_by` updated to new connection_id on reconnect
- **ws-client-tools.AC7.3 Failure:** `tool:result` for expired entry receives `error` with `code: "tool_call_expired"`
- **ws-client-tools.AC7.4 Success:** Bootstrap recovery distinguishes `client_tool_call` entries from interrupted server tool calls

## Glossary

- **Agent loop**: The server-side state machine that orchestrates a conversation turn — assembles context, calls the LLM, dispatches tool calls, persists results, and repeats until the LLM produces a final response with no pending tool calls.
- **dispatch_queue**: A SQLite table used as a persistent work queue. Entries represent pending events (user messages, notifications, tool results) that trigger agent loop execution. Atomic claiming prevents concurrent processing of the same entry.
- **Client tool**: A tool definition registered by a connected WebSocket client. The agent can call it like any other tool, but execution happens in the client process; the server only brokers the call and result.
- **tool_use block**: The structured output format an LLM produces when it wants to invoke a tool — contains the tool name and arguments. Multiple tool_use blocks can appear in a single LLM turn.
- **Sentinel return type**: A special return value from a function that signals "this needs external handling" rather than returning a real result. `ClientToolCallRequest` (analogous to existing `RelayToolCallRequest`) signals the agent loop that a tool call must be deferred to a client.
- **RELAY_WAIT**: An existing agent loop state for waiting on tool results from a remote cluster node. Client tool waiting uses a different mechanism (persistent yield rather than in-memory waiting), but the event delivery pattern is analogous.
- **BoundClient / BoundSocket**: The existing client library split across two classes — `BoundClient` for HTTP reads, `BoundSocket` for WebSocket event subscriptions. This design merges them.
- **session:configure**: A WebSocket message sent by the client to declare which tools it can execute. Tool definitions persist for the connection lifetime and are re-sent automatically on reconnect.
- **ThreadExecutor / claimPending**: The server-side mechanism that ensures only one agent loop runs per thread at a time. This design extends `claimPending()` to also skip threads with unresolved client tool calls.
- **connection_id**: A per-connection identifier assigned on WebSocket connect. Used to route pending tool calls to the correct connection and updated on reconnect.
- **DNS-rebinding protection**: A server-side check that rejects requests whose `Host` header does not resolve to loopback, preventing cross-origin requests to the local server via a victim's browser.
- **MCP (Model Context Protocol)**: An open protocol for exposing tools and resources to LLM-based agents. The `bound-mcp` binary implements this protocol as a standalone stdio server.

## Architecture

Unified bidirectional WebSocket protocol replacing both the HTTP message endpoint (`POST /api/threads/:id/messages`) and the event subscription WebSocket (`/ws`). One persistent connection per client handles message sending, event streaming, client-side tool registration, tool call dispatch, and tool result return.

### WS Protocol

All messages are JSON with a `type` field using colon-delimited names (matching existing event conventions).

**Client → Server:**

| Type | Fields | Purpose |
|------|--------|---------|
| `session:configure` | `tools: ToolDefinition[]` | Register client tool definitions for connection lifetime |
| `message:send` | `thread_id`, `content`, `file_ids?` | Send user message (replaces HTTP POST) |
| `thread:subscribe` | `thread_id` | Subscribe to thread events |
| `thread:unsubscribe` | `thread_id` | Unsubscribe from thread events |
| `tool:result` | `call_id`, `thread_id`, `content`, `is_error?` | Return result for a client-side tool call |

**Server → Client:**

| Type | Fields | Purpose |
|------|--------|---------|
| `message:created` | `Message` | New message in subscribed thread |
| `tool:call` | `call_id`, `thread_id`, `tool_name`, `arguments` | Agent requesting client to execute a tool |
| `thread:status` | `thread_id`, `active`, `state`, `tokens`, `model` | Thread status change (replaces polling) |
| `task:updated` | `taskId`, `status` | Task status change (renamed from `task_update`) |
| `file:updated` | `path`, `operation` | File change (renamed from `file_update`) |
| `context:debug` | `ContextDebugTurn` | Context debug info |
| `error` | `code`, `message`, `call_id?` | Error event |

### Connection State

Per-connection in-memory state on the server:

```typescript
interface ClientConnection {
	connectionId: string;
	subscriptions: Set<string>;
	clientTools: Map<string, ToolDefinition>;
}
```

Tool definitions persist for the connection lifetime. On reconnect, the client re-sends `session:configure` (auto-resent by BoundClient, like BoundSocket re-sends subscriptions today).

### Client Tool Call Flow

1. Agent loop runs, LLM produces `tool_use` blocks (mix of server-side and client-side)
2. Server-side tools execute immediately, results persisted as usual
3. Client-side tool calls: `tool_call` message persisted, `client_tool_call` entry written to `dispatch_queue`
4. After all tool calls processed, loop exits (`continueLoop = false`)
5. Server delivers `tool:call` to the WS connection that registered the tool
6. Client executes tool, sends `tool:result` back over WS
7. Server persists `tool_result` message, marks `client_tool_call` entry acknowledged
8. Server enqueues `tool_result` entry in `dispatch_queue` → `handleThread()` fires
9. New agent loop starts, context assembly picks up all `tool_call`/`tool_result` pairs, LLM continues

### Thread Locking During Client Tool Calls

A thread is effectively locked while client tool calls are pending. `claimPending()` skips threads with unresolved `client_tool_call` entries in `dispatch_queue`. New user messages queue in `dispatch_queue` and are processed after all tool calls resolve.

Cancellation unblocks: the existing cancel mechanism (`POST /api/status/cancel/:threadId`) marks pending `client_tool_call` entries as expired, injects an interruption system message, and unblocks the thread.

### Agent Loop Tool Dispatch

Updated dispatch order in `executeToolCall()`:

1. Platform tools (`config.platformTools`)
2. **Client tools** (`config.clientTools`) — NEW
3. Built-in tools (`sandbox.builtInTools`)
4. Bash fallback (MCP commands, shell)

`AgentLoopConfig` gains a `clientTools: Map<string, ToolDefinition>` field (schema only, no executor). When `executeToolCall` matches a client tool, it returns a `ClientToolCallRequest` sentinel (analogous to `RelayToolCallRequest`). The main loop recognizes this in TOOL_EXECUTE, persists the `tool_call` message and `dispatch_queue` entry, and continues processing remaining tool calls in the turn. After the full pass, if any client tool calls were made, the loop exits.

### Persistence via dispatch_queue Extension

No new table. The existing `dispatch_queue` table gains two new `event_type` values:

- `client_tool_call`: Pending tool call awaiting client execution. `event_payload` contains `{tool_call_id, tool_name, arguments}`. `claimed_by` holds the connection_id of the WS connection that registered the tool.
- `tool_result`: Triggers agent loop resume when client sends a result.

`claimPending()` is modified to skip `client_tool_call` entries (they aren't "trigger the loop now" — they're "waiting for external input"). Only `user_message`, `notification`, and `tool_result` types get claimed.

### Reconnection & Recovery

**Client reconnect (same server):** Client sends `session:configure` + `thread:subscribe`. Server matches pending/delivered `client_tool_call` entries by tool_name on subscribed threads → updates `claimed_by` to new connection_id → re-delivers.

**Server restart:** `client_tool_call` entries survive in `dispatch_queue`. On startup, they remain pending. When a client reconnects and registers matching tools, entries are re-delivered. Stale entries (no reconnect within configurable TTL) are expired by periodic scan — interruption notice injected, thread unblocked.

**Tool result for expired/cancelled entry:** Server responds with `error` (`code: "tool_call_expired"`). Result discarded.

### BoundClient Unified API

`BoundClient` and `BoundSocket` merge into a single class. HTTP methods remain for read-only operations; WS handles stateful interactions.

```typescript
class BoundClient {
	// Connection lifecycle
	connect(): void;
	disconnect(): void;

	// Session (WS)
	configureTools(tools: ToolDefinition[]): void;
	onToolCall(handler: (call: ToolCallRequest) => Promise<ToolCallResult>): void;

	// Messages (WS, fire-and-forget)
	sendMessage(threadId: string, content: string, options?: SendMessageOptions): void;

	// Subscriptions (WS)
	subscribe(threadId: string): void;
	unsubscribe(threadId: string): void;
	on<E extends EventName>(event: E, handler: BoundSocketEvents[E]): void;
	off<E extends EventName>(event: E, handler: BoundSocketEvents[E]): void;

	// Read-only (HTTP, unchanged)
	listThreads(): Promise<ThreadListEntry[]>;
	listMessages(threadId: string): Promise<Message[]>;
	getThread(id: string): Promise<Thread>;
	getThreadStatus(id: string): Promise<ThreadStatus>;
	// ... all other GET endpoints unchanged
}
```

`sendMessage` is fire-and-forget over WS (no longer returns `Promise<Message>`). The created message arrives via the `message:created` event. `onToolCall` registers a callback invoked when a `tool:call` arrives; the result is automatically sent back as `tool:result`. Auto-reconnect re-sends `session:configure` and active subscriptions.

Updated event type names: `task_update` → `task:updated`, `file_update` → `file:updated`.

### MCP Server

The MCP server (`bound-mcp`) switches from HTTP POST + polling to the unified WS client. It does not expose a tools parameter — the execution model doesn't support passing functions over MCP. It connects via WS, sends messages, waits for `thread:status` (active=false) to detect completion, then fetches the final response via HTTP `listMessages()`.

### Svelte Web UI

Replaces separate `BoundClient` + `BoundSocket` imports with the unified `BoundClient`. Message sending becomes fire-and-forget over WS. Event listener names updated (`task_update` → `task:updated`, `file_update` → `file:updated`). Thread status received via `thread:status` event instead of polling. Mostly mechanical find-and-replace.

## Existing Patterns

This design follows several established patterns in the codebase:

**dispatch_queue pattern** (`packages/core/src/dispatch.ts`): The `enqueueMessage` → `claimPending` → `acknowledgeBatch` lifecycle with atomic claiming (`BEGIN IMMEDIATE`) and status flow (`pending` → `processing` → `acknowledged`). Client tool call persistence extends this directly with new `event_type` values rather than introducing new tables.

**RELAY_WAIT event-driven waiting** (`packages/agent/src/agent-loop.ts:1095-1255`): Promise + eventBus listener with timeout and immediate DB check to prevent races. While this design uses persistent yield (loop exit + dispatch_queue resume) rather than in-memory waiting, the event delivery pattern for notifying the WS handler of new `client_tool_call` entries follows the same event-driven approach.

**ThreadExecutor lock** (`packages/core/src/thread-executor.ts`): Single-loop-per-thread invariant with drain loop. Extended conceptually — a thread is "locked" not just while a loop is running in-memory, but also while client tool calls are pending in `dispatch_queue`.

**Bun.serve WS upgrade** (`packages/web/src/server/start.ts:73-87`): Path-based routing in the `fetch` handler, delegating `/ws` to `server.upgrade()` and everything else to Hono. The enhanced `/ws` handler extends this with bidirectional message handling rather than server-push-only.

**platformTools dispatch** (`packages/agent/src/agent-loop.ts:1485-1489`): Priority-based tool dispatch in `executeToolCall`. Client tools slot into this chain at position 2 (after platform tools, before built-in tools), following the same Map-based lookup and sentinel-return pattern.

**RelayToolCallRequest sentinel** (`packages/agent/src/agent-loop.ts:1516-1517`): The agent loop already handles a special return type from `executeToolCall` that signals "this tool call needs external handling." `ClientToolCallRequest` follows the same pattern.

**Divergence:** The current `/ws` handler is server-push-only (clients can only send subscribe/unsubscribe). This design makes it fully bidirectional. This is a new pattern for the web listener, though the sync listener (`/sync/ws`) already handles bidirectional binary frames.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: dispatch_queue Extension & Thread Locking

**Goal:** Extend dispatch_queue to support `client_tool_call` and `tool_result` event types with thread locking semantics.

**Components:**
- `claimPending()` in `packages/core/src/dispatch.ts` — skip `client_tool_call` entries, claim `tool_result` entries
- `hasPendingClientToolCalls()` in `packages/core/src/dispatch.ts` — check for unresolved `client_tool_call` entries on a thread
- `enqueueClientToolCall()` in `packages/core/src/dispatch.ts` — insert `client_tool_call` entry with tool metadata payload and connection_id
- `enqueueToolResult()` in `packages/core/src/dispatch.ts` — insert `tool_result` entry to trigger loop resume
- `acknowledgeClientToolCall()` in `packages/core/src/dispatch.ts` — mark entry as acknowledged when result arrives
- `expireClientToolCalls()` in `packages/core/src/dispatch.ts` — expire stale entries (TTL-based)
- Bootstrap recovery in `packages/cli/src/commands/start/bootstrap.ts` — handle `client_tool_call` entries from prior server lifetime

**Dependencies:** None (first phase)

**Done when:** dispatch_queue supports new event types, `claimPending` correctly skips client_tool_call entries, thread locking prevents new loops while tool calls are pending. Covers `ws-client-tools.AC4.1`–`ws-client-tools.AC4.5`.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Agent Loop Client Tool Dispatch

**Goal:** Agent loop recognizes client tools, persists tool_call messages, writes dispatch_queue entries, and yields after processing all tools in a turn.

**Components:**
- `ClientToolCallRequest` type in `packages/agent/src/types.ts` — sentinel return type (analogous to `RelayToolCallRequest`)
- `AgentLoopConfig.clientTools` field in `packages/agent/src/types.ts` — `Map<string, ToolDefinition>`
- `executeToolCall()` in `packages/agent/src/agent-loop.ts` — client tool dispatch at priority 2
- TOOL_EXECUTE state handling in `packages/agent/src/agent-loop.ts` — recognize `ClientToolCallRequest`, persist dispatch_queue entries, track pending client calls, exit loop after full pass if any exist
- Tool definition merging in `packages/agent/src/agent-loop.ts` — include `clientTools` schemas in LLM tool list

**Dependencies:** Phase 1 (dispatch_queue extension)

**Done when:** Agent loop correctly dispatches client tools, executes server tools eagerly, yields for client tools, and resumes cleanly when tool_result triggers a new loop. Covers `ws-client-tools.AC3.1`–`ws-client-tools.AC3.4`.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Bidirectional WS Handler

**Goal:** Upgrade the `/ws` endpoint from server-push-only to fully bidirectional, handling all client→server message types.

**Components:**
- `ClientConnection` type in `packages/web/src/server/websocket.ts` — per-connection state (connectionId, subscriptions, clientTools)
- WS message handler in `packages/web/src/server/websocket.ts` — dispatch by message type (`session:configure`, `message:send`, `thread:subscribe`, `thread:unsubscribe`, `tool:result`)
- `session:configure` handler — store tool definitions in connection state, scan for re-deliverable pending tool calls
- `message:send` handler — validate, persist message, emit `message:created` (replaces HTTP POST logic), reject if thread has pending client tool calls
- `tool:result` handler — validate call_id, persist tool_result message, mark dispatch_queue entry, enqueue tool_result trigger
- `tool:call` delivery — listen for new `client_tool_call` dispatch_queue entries, find matching connection, send `tool:call`, update status to delivered
- `thread:status` push — emit status changes to subscribed connections
- Disconnect cleanup — handle orphaned `client_tool_call` entries on connection close
- Event name migration — emit `task:updated` and `file:updated` instead of `task_update` and `file_update`

**Dependencies:** Phase 1 (dispatch_queue), Phase 2 (agent loop yields for client tools)

**Done when:** WS endpoint handles all message types bidirectionally, tool calls flow to clients and results flow back, events use colon-delimited names. Covers `ws-client-tools.AC1.1`–`ws-client-tools.AC1.5`, `ws-client-tools.AC3.5`–`ws-client-tools.AC3.6`.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Server-Side Wiring

**Goal:** Wire the new WS handler into the agent loop factory and `handleThread` so client tool definitions flow from WS connections into agent loop config.

**Components:**
- Connection registry in `packages/web/src/server/websocket.ts` — map of active connections by connectionId, lookup by thread subscription + tool name
- Agent loop factory in `packages/cli/src/commands/start/agent-factory.ts` — accept `clientTools` parameter, pass to `AgentLoopConfig`
- `handleThread` in `packages/cli/src/commands/start/server.ts` — resolve client tools for the thread (find WS connections subscribed to this thread that have registered tools), pass to agent loop factory
- Remove `POST /api/threads/:id/messages` route from `packages/web/src/server/routes/messages.ts` — message sending now exclusively through WS

**Dependencies:** Phase 3 (WS handler)

**Done when:** Agent loops receive client tool definitions from connected WS clients, HTTP POST message endpoint removed. Covers `ws-client-tools.AC1.2`.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: BoundClient Unification

**Goal:** Merge `BoundSocket` into `BoundClient` with unified API for WS + HTTP.

**Components:**
- Merged `BoundClient` class in `packages/client/src/client.ts` — WS connection lifecycle, session configuration, tool callback registration, message sending, subscriptions, plus existing HTTP read methods
- `BoundSocket` removal — `packages/client/src/socket.ts` removed, exports consolidated
- Type updates in `packages/client/src/types.ts` — `BoundSocketEvents` updated with new event names (`task:updated`, `file:updated`, `thread:status`), `ToolCallRequest`/`ToolCallResult` types added, `SendMessageOptions` updated
- Index exports in `packages/client/src/index.ts` — consolidated

**Dependencies:** Phase 3 (WS protocol finalized)

**Done when:** Single `BoundClient` class handles WS + HTTP, auto-reconnect re-sends session config and subscriptions, `onToolCall` callback works end-to-end. Covers `ws-client-tools.AC2.1`–`ws-client-tools.AC2.5`.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: MCP Server Migration

**Goal:** Migrate `bound-mcp` from HTTP POST + polling to unified WS client.

**Components:**
- Handler in `packages/mcp-server/src/handler.ts` — use `BoundClient.connect()`, `sendMessage()` over WS, wait for `thread:status` event instead of polling, fetch final response via `listMessages()` HTTP
- No tools parameter exposed — MCP execution model doesn't support function arguments

**Dependencies:** Phase 5 (unified BoundClient)

**Done when:** MCP server sends messages over WS, detects completion via `thread:status` event, returns final assistant response. Covers `ws-client-tools.AC5.1`–`ws-client-tools.AC5.2`.
<!-- END_PHASE_6 -->

<!-- START_PHASE_7 -->
### Phase 7: Svelte Web UI Migration

**Goal:** Update web UI to use unified `BoundClient` instead of separate `BoundClient` + `BoundSocket`.

**Components:**
- Bound client usage in `packages/web/src/client/` — replace dual imports with single `BoundClient`
- Message sending — switch from `await client.sendMessage()` to fire-and-forget `client.sendMessage()`
- Event listeners — `task_update` → `task:updated`, `file_update` → `file:updated`
- Thread status — use `thread:status` event instead of polling `getThreadStatus()`
- Bound client initialization in `packages/web/src/client/lib/bound.ts` — consolidated setup

**Dependencies:** Phase 5 (unified BoundClient)

**Done when:** Web UI uses single BoundClient, all event names updated, message sending works over WS. Covers `ws-client-tools.AC6.1`–`ws-client-tools.AC6.3`.
<!-- END_PHASE_7 -->

<!-- START_PHASE_8 -->
### Phase 8: Recovery & Cleanup

**Goal:** Ensure robustness across server restarts, client disconnects, and edge cases.

**Components:**
- TTL-based expiry scan in `packages/cli/src/commands/start/server.ts` — periodic scan for stale `client_tool_call` entries, inject interruption notices, unblock threads
- Bootstrap recovery in `packages/cli/src/commands/start/bootstrap.ts` — handle `client_tool_call` entries from prior server lifetime (don't treat as interrupted server tools)
- Cancel integration in `packages/web/src/server/routes/threads.ts` — cancel thread also expires pending client tool calls
- Connection drop handling in `packages/web/src/server/websocket.ts` — leave entries for potential reconnect, TTL handles permanent disconnects

**Dependencies:** All prior phases

**Done when:** Server restart preserves pending tool calls, reconnecting clients receive re-delivered calls, expired calls unblock threads, cancellation works. Covers `ws-client-tools.AC4.3`–`ws-client-tools.AC4.5`, `ws-client-tools.AC7.1`–`ws-client-tools.AC7.4`.
<!-- END_PHASE_8 -->

## Additional Considerations

**HTTP GET endpoints remain unchanged.** All read-only API routes (`/api/threads`, `/api/messages`, `/api/status`, `/api/files`, etc.) continue to work over HTTP. Only message sending moves to WS. This preserves compatibility with simple scripts and curl-based debugging.

**No authentication changes.** The `/ws` endpoint remains localhost-only with DNS-rebinding protection, matching the current security model. The sync listener (`/sync/ws`) continues to handle Ed25519-authenticated cluster traffic separately.

**Mixed server/client tool turns.** When the LLM produces both server-side and client-side tool calls in one turn, server tools execute eagerly and client tools are deferred. The loop exits after the full processing pass. On resume, the LLM sees all tool_call/tool_result pairs and continues naturally.

**Future extensibility.** The `session:configure` message type can be extended with additional session-level preferences (model hints, context window overrides) without protocol changes. Client tool definitions could also include capability metadata (e.g., "interactive", "long-running") to inform agent behavior.
