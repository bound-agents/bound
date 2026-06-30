# RFC: Client-Tool WebSocket Protocol

> **Superseded in part (2026-06-29):** `2026-06-29-unified-delegation.md` supersedes the must-run-on-the-WS-session-host requirement and the `process`-delegation facet. Client tools now dispatch through the uniform `{local | relay}` path: a loop on a non-session host relays a `client_tool` request to the session host and awaits a `client_result`, so session affinity is an optimization, not a correctness requirement.

**Supplements:** `2026-04-17-boundless.md`, `agent-system.md` §6
**Date:** 2026-04-16
**Status:** Implemented

---

## 1. Problem Statement

### 1.1 Split Client Interface Imposes Unnecessary Complexity

Bound's original client-facing architecture required two independent connections for interactive sessions:

- A one-shot HTTP POST endpoint for sending messages, which returned the created message synchronously.
- A separate server-push-only WebSocket connection for subscribing to thread events (message creation, task updates, file changes).

This split imposed operational costs on every interactive client:

- Separate error paths for connection failures, where either channel could fail independently.
- Clients implemented as two classes (`BoundClient` for HTTP, `BoundSocket` for WebSocket events) with duplicate connection lifecycle management.
- Message sending returned a synchronous response from the HTTP POST but required subscribing to WebSocket events to observe the agent's actual response, creating a race condition at session start if the subscription was not established before sending the first message.
- No structured path for clients to register capabilities (tools) that the agent could invoke, forcing all tool execution to happen server-side or through out-of-band channels.

The POST endpoint's synchronous nature was also incompatible with agent-side yielding: when a tool call required external input (e.g., long-running MCP tool, user confirmation prompt, or client-side filesystem access), the server had to either hold the HTTP connection open (blocking for the full agent turn) or accept the POST, close the connection, and rely on the client to poll for completion — a design that cannot support deferred tool-result collection after reconnection.

### 1.2 Existing WebSocket Was Unidirectional

The `/ws` endpoint was implemented as server-push-only: clients could send `thread:subscribe` and `thread:unsubscribe` messages, but the protocol had no provision for clients sending messages, declaring tool registrations, or returning tool results. This meant:

- No path for client-side tools (filesystem access, UI operations, third-party integrations scoped to the client's host rather than the server's host).
- No persistent queue for tool calls awaiting client responses — tools either had to complete synchronously within one agent loop run, or the agent loop had to block in memory waiting for the result (breaking across server restarts and preventing scale-out).
- No session-level configuration: tool registrations would need to be re-declared per message, or stored server-side with explicit session management that did not exist.

The protocol could support interactive chat sessions (send message via HTTP, receive responses via WebSocket) but could not support coding-agent clients (boundless) where the agent's tool set includes host-side tools that the client must execute locally.

---

## 2. Proposal

### 2.1 Summary

Replace the HTTP POST `/api/threads/:id/messages` endpoint and the server-push-only `/ws` endpoint with a single unified bidirectional WebSocket protocol. The enhanced protocol handles:

- Message sending (`message:send` client→server, fire-and-forget).
- Thread subscription (`thread:subscribe`, `thread:unsubscribe` unchanged).
- Session-level tool registration (`session:configure` client→server with `tools: ToolDefinition[]` and optional `systemPromptAddition: string`).
- Tool call dispatch (`tool:call` server→client with `callId`, `toolName`, `arguments`).
- Tool result return (`tool:result` client→server with `callId`, `content: string | ContentBlock[]`, `isError?: boolean`).
- Tool cancellation (`tool:cancel` server→client with `callId`, `reason`).

Tool calls are persisted in the existing `dispatch_queue` table with a new `event_type: "client_tool_call"`. The agent loop yields after dispatching client tool calls, releasing the thread's execution lock. When the client sends a `tool:result`, a new agent loop run is triggered via a `dispatch_queue` entry of `event_type: "tool_result"`. Pending tool calls survive server restarts and are re-delivered to reconnecting clients whose `session:configure` declares matching tool names.

The unified client (`BoundClient` merging `BoundSocket`) exposes both WebSocket and HTTP methods: message sending over WebSocket, event subscriptions over WebSocket, read-only thread/message/status queries over HTTP. The web UI, boundless, and any future clients use the same protocol.

### 2.2 What This Changes

| Area | Change |
|---|---|
| HTTP POST endpoint | `/api/threads/:id/messages` removed; message sending exclusively via WebSocket `message:send`. |
| WebSocket protocol | `message:send`, `tool:call`, `tool:result`, `tool:cancel`, `session:configure` added. |
| `dispatch_queue` table | Two new `event_type` values: `client_tool_call` (pending tool calls awaiting client execution), `tool_result` (triggers agent loop resume). |
| Agent loop tool dispatch | New priority-2 slot for client tools (after platform tools, before built-in tools). Returning `ClientToolCallRequest` sentinel triggers yield. |
| `@bound/client` package | `BoundClient` and `BoundSocket` merged into single class; `BoundSocket` removed. |
| Event naming | `task_update` → `task:updated`, `file_update` → `file:updated` (colon-delimited). |
| Thread locking | `claimPending()` skips threads with unresolved `client_tool_call` entries; new user messages queue until all tool results arrive. |

### 2.3 Design Notes

**Message sending is fire-and-forget.** `message:send` does not await a synchronous reply; the created message arrives via `message:created` event over the same WebSocket. This decouples message submission from agent turn completion, allowing the agent loop to yield mid-turn (for client tool calls) without blocking the send operation.

**Tool registration persists for the connection lifetime.** `session:configure` stores the tool list in per-connection server-side state. On reconnect, `BoundClient` automatically re-sends the last `session:configure`, so clients do not need to re-declare tools on every message. Hot-reload (adding or removing tools mid-session, e.g., MCP server enable/disable in boundless) re-sends `session:configure` with the updated list; the server clears and replaces the stored set.

**Pending tool calls are DB-backed.** When the agent encounters a client tool, it persists a `tool_call` message, writes a `client_tool_call` entry to `dispatch_queue`, and exits the loop. The entry's `claimed_by` field stores the connection's server-side connection handle. On reconnect, pending entries whose `tool_name` matches a tool in the new `session:configure` are re-delivered to the reconnecting client (updating `claimed_by` to the new connection). TTL expiry injects an interruption notice and unblocks the thread.

**Mixed server/client tool turns.** When an LLM produces both server-side and client-side tool calls in one turn, server-side tools execute eagerly and client-side tools are deferred. The loop exits after the full pass. On resume (when all client tool results arrive), the LLM sees all `tool_call` / `tool_result` pairs and continues.

**Thread affinity.** The `systemPromptAddition` field on `session:configure` is scoped per `(server-side-connection, threadId)` pair: the server stores it against every thread the connection is currently subscribed to, and subsequent `thread:subscribe` calls for the same connection inherit the most recent addition. This allows a single connection to serve multiple threads with distinct additions (e.g., boundless attaching to different cwds, or a multi-project IDE client).

**`tool:cancel` is fire-and-forget.** The server emits `tool:cancel` when `cancelThread()` is called, when a dispatch_queue entry expires, or when a session is reset. Clients signal abort to the handler; if the handler was already running, abort is best-effort. The server synthesizes a tool-error message for expired or session-reset cancellations so the agent loop observes a terminal outcome.

**Cross-cutting integration points.** The protocol integrates with bound's existing scheduler (quiescence), thread executor (single-loop-per-thread invariant), relay transport (spokes can have client tools), and context assembly (client tools appear in the LLM's tool list alongside built-ins and MCP tools). No schema migrations or new tables required beyond the two `dispatch_queue` event types.

---

## 3. Requirements (EARS Format)

Requirements use the prefix `R-CTP` (Client-Tool Protocol).

### 3.1 Ubiquitous

**R-CTP1.** The system shall expose a single WebSocket endpoint `/ws` that accepts both client→server messages (`message:send`, `thread:subscribe`, `thread:unsubscribe`, `tool:result`, `session:configure`) and server→client messages (`message:created`, `thread:status`, `task:updated`, `file:updated`, `context:debug`, `tool:call`, `tool:cancel`, `error`).

**R-CTP2.** The `message:send` message shall accept fields `thread_id: string`, `content: string`, `file_ids?: string[]`, and `model_id?: string`. The server shall persist the message to the `messages` table, trigger agent loop execution via `dispatch_queue`, and emit a `message:created` event to all subscribed connections for that thread. No synchronous reply is sent; clients observe the created message via the event.

**R-CTP3.** The `session:configure` message shall accept fields `tools: ToolDefinition[]` and optional `systemPromptAddition: string`. The server shall store the tool list in per-connection state (keyed by the server's internal WebSocket connection handle), replacing any prior registration. The `systemPromptAddition` string shall be stored per `(server-side-connection, threadId)` pair for every thread currently subscribed by that connection at the time of the message, and appended to the system prompt on every LLM call executed for one of those pairs. Subsequent `thread:subscribe` messages for the same connection inherit the most recent `systemPromptAddition`. Re-sending `session:configure` replaces the stored string for every currently-subscribed pair; omitting the field clears it.

**R-CTP4.** When the agent loop encounters a tool call whose name matches a tool registered via `session:configure`, the system shall persist a `tool_call` message, write a `client_tool_call` entry to `dispatch_queue` with `event_payload` containing `{tool_call_id, tool_name, arguments}` and `claimed_by` holding the connection's server-side handle, and exit the loop without completing the turn. The server shall emit a `tool:call` message to the connection, containing `callId`, `threadId`, `toolName`, and `arguments`.

**R-CTP5.** When the client sends a `tool:result` message with `callId`, `threadId`, `content: string | ContentBlock[]`, and optional `isError: boolean`, the server shall persist a `tool_result` message to the `messages` table, mark the corresponding `client_tool_call` entry as acknowledged, and enqueue a `tool_result` entry in `dispatch_queue` to trigger agent loop resume. A `string` content is persisted as a single text block; a `ContentBlock[]` is persisted verbatim. Admitted block types are `text`, `image`, `document` as defined by the LLM package; other shapes are rejected with an error response.

**R-CTP6.** The system shall emit `tool:cancel` messages (server→client) when `cancelThread(threadId)` is called while client tool calls are outstanding (reason: `"thread_canceled"`), when a `dispatch_queue` entry exceeds its TTL (reason: `"dispatch_expired"`), or when the connection's session is reset (reason: `"session_reset"`). For `dispatch_expired` and `session_reset`, the server shall synthesize a tool-error `LLMMessage` with `isError: true` and content `"Tool call ${callId} canceled: ${reason}."` so the agent loop observes a terminal outcome. Clients shall signal abort to the handler for the `callId`; unrecognized `callId`s are dropped silently.

**R-CTP7.** The system shall remove the HTTP POST `/api/threads/:id/messages` endpoint. Requests to that path shall return HTTP 404.

**R-CTP8.** The `claimPending()` function in the scheduler shall skip `client_tool_call` entries (they are not "trigger the loop now" — they are "waiting for external input"). Only `user_message`, `notification`, and `tool_result` event types shall be claimed and trigger immediate loop execution.

**R-CTP9.** A thread with unresolved `client_tool_call` entries in `dispatch_queue` shall not accept new agent loop runs until all outstanding tool results arrive. New user messages sent while tool calls are pending shall queue in `dispatch_queue` and be processed after all tool results are delivered.

**R-CTP10.** When a client reconnects and sends `session:configure` with a tool list, the server shall query `dispatch_queue` for `client_tool_call` entries on subscribed threads whose `tool_name` matches a tool in the new registration, update `claimed_by` to the new connection handle, and re-deliver each matched entry via `tool:call` message.

**R-CTP11.** When a `client_tool_call` entry remains unresolved beyond a configurable TTL (default 5 minutes), a periodic scan shall mark it expired, synthesize a tool-error message per R-CTP6, and unblock the thread. The same expiry logic applies when `cancelThread()` is invoked: all pending `client_tool_call` entries for that thread are marked expired, interruption notices injected, and the thread unblocked.

**R-CTP12.** Server→client event type names shall use colon delimiters: `message:created`, `thread:status`, `task:updated`, `file:updated`, `context:debug`, `tool:call`, `tool:cancel`, `error`. The legacy underscore-delimited names (`task_update`, `file_update`) are removed.

**R-CTP13.** When the server receives a `tool:result` for a `callId` for which it has already emitted `tool:cancel`, the server shall accept the message but discard it — no `LLMMessage` is persisted. The agent loop has already observed the synthesized error from R-CTP6 and does not rewrite that outcome on late arrival.

**R-CTP14.** The agent loop's tool dispatch order shall be: (1) platform tools, (2) client tools (NEW), (3) built-in tools, (4) Bash fallback (MCP commands, shell). When a tool call matches a client tool, `executeToolCall()` shall return a `ClientToolCallRequest` sentinel (analogous to `RelayToolCallRequest`). The main loop recognizes this in `TOOL_EXECUTE`, persists the `tool_call` message and `dispatch_queue` entry, and continues processing remaining tool calls in the turn. After the full pass, if any client tool calls were made, the loop exits (sets `continueLoop = false`).

### 3.2 State-Driven

**R-CTP15.** When a WebSocket connection closes gracefully (the client sends a close frame or the connection is terminated by the client), the server shall leave `client_tool_call` entries in `dispatch_queue` for potential reconnection. The TTL-based expiry scan (R-CTP11) handles permanent disconnections. On reconnect, R-CTP10 governs re-delivery.

**R-CTP16.** When a `session:configure` message arrives with a tool name that collides with an existing tool in the merged tool list (platform tools, built-in tools, or another client connection's tools), the server shall reject the configuration with an error response and not replace the stored tool list.

**R-CTP17.** When the agent loop assembles context for a thread with an active client session (a connection currently subscribed to the thread with a non-empty tool list), the client tools' schemas shall be included in the LLM tool list alongside built-in and MCP tools. The `systemPromptAddition` for that `(connection, threadId)` pair shall be appended to the system prompt as a final block.

### 3.3 Acceptance Criteria

Acceptance criteria use the prefix `client-tool-protocol.AC` and map 1:1 to test names and the scenarios documented in the test plan. Each R-CTP requirement with observable behavior has at least one success scenario and one failure-mode scenario. R-CTP7 (removal of HTTP POST endpoint) and R-CTP12 (event naming convention) are validated by integration tests and static analysis.

#### client-tool-protocol.AC1: Unified WebSocket Protocol (R-CTP1, R-CTP2, R-CTP7, R-CTP12)

- **AC1.1 Success.** Client connects to `/ws`, sends `message:send`, and message is persisted to the `messages` table. The client receives a `message:created` event with the user's message and subsequent `message:created` events with the agent's response.
- **AC1.2 Success.** HTTP POST to `/api/threads/:id/messages` returns 404. Message sending works exclusively via WebSocket `message:send`.
- **AC1.3 Success.** Client receives `message:created`, `task:updated`, `file:updated`, `context:debug`, `thread:status` events for subscribed threads. Event names use colon delimiters (no underscore names).
- **AC1.4 Failure.** Malformed WebSocket messages (missing required fields, invalid JSON) receive an `error` response without killing the connection.

#### client-tool-protocol.AC2: Client-Side Tool Registration & Execution (R-CTP3, R-CTP4, R-CTP5, R-CTP14, R-CTP17)

- **AC2.1 Success.** Client sends `session:configure` with `tools: [{ name: "local_read", description: "...", input_schema: {...} }]`. Agent loop includes `local_read` in LLM tool list. When LLM calls `local_read`, client receives `tool:call` with correct `toolName` and `arguments`.
- **AC2.2 Success.** Client sends `tool:result` with `callId`, `content`, and `isError: false`. Agent loop resumes, LLM sees the result in context, and turn completes.
- **AC2.3 Success.** Mixed turn: LLM produces both server-side (`read`) and client-side (`local_read`) tool calls. Server-side tool executes eagerly; client-side tool triggers `tool:call` message. Loop exits after processing both. On `tool:result` arrival, loop resumes and LLM sees both results.
- **AC2.4 Failure.** Client sends `tool:result` with unknown `callId` (no matching `client_tool_call` entry). Server responds with `error` message containing `code: "unknown_call_id"`.
- **AC2.5 Success.** Tools persist for connection lifetime: second `message:send` can trigger client tools without re-sending `session:configure`.
- **AC2.6 Success.** `systemPromptAddition` from `session:configure` is appended to system prompt on LLM call. Thread-scoped: different additions for different threads subscribed by the same connection.

#### client-tool-protocol.AC3: Persistent Tool Call Queue (R-CTP4, R-CTP8, R-CTP9, R-CTP10, R-CTP11, R-CTP15)

- **AC3.1 Success.** Client tool call creates `client_tool_call` entry in `dispatch_queue` with `event_payload` containing `tool_call_id`, `tool_name`, `arguments`, and `claimed_by` holding connection handle.
- **AC3.2 Success.** Thread is locked while `client_tool_call` entries are pending: new user messages sent via `message:send` queue in `dispatch_queue` and are processed after all `tool:result` messages arrive.
- **AC3.3 Success.** After server restart, pending `client_tool_call` entries survive. When client reconnects and sends `session:configure` with matching tool names, entries are re-delivered via `tool:call` messages.
- **AC3.4 Success.** Stale entries (no reconnect within TTL, default 5 minutes) are expired by periodic scan. Interruption notice injected (`LLMMessage` with `isError: true`, content `"Tool call ${callId} canceled: dispatch_expired."`), thread unblocked.
- **AC3.5 Success.** `cancelThread(threadId)` expires all pending `client_tool_call` entries for that thread, injects interruption notices, and unblocks the thread.
- **AC3.6 Success.** Client disconnect leaves `client_tool_call` entries for potential reconnection. TTL handles permanent disconnects per AC3.4.

#### client-tool-protocol.AC4: Tool Cancellation (R-CTP6, R-CTP13)

- **AC4.1 Success.** `cancelThread(threadId)` with in-flight client tool call emits `tool:cancel` message with `callId`, `threadId`, `reason: "thread_canceled"`. Client receives message and signals abort to handler.
- **AC4.2 Success.** Expired `client_tool_call` entry (TTL exceeded) triggers `tool:cancel` with `reason: "dispatch_expired"`. Server synthesizes tool-error message per R-CTP6.
- **AC4.3 Success.** Late `tool:result` for already-canceled `callId` is accepted but discarded. No `LLMMessage` persisted; agent loop has already observed the synthesized error.
- **AC4.4 Failure.** `tool:cancel` with unrecognized `callId` (late arrival after local completion, duplicate, or cross-reconnect) is dropped silently by client. No error logged beyond DEBUG level.

#### client-tool-protocol.AC5: BoundClient Unification (implementation validation)

- **AC5.1 Success.** Single `BoundClient` import provides WebSocket connection, subscriptions, message sending (`sendMessage()`), and HTTP read methods (`listThreads()`, `getThread()`, etc.). `BoundSocket` class removed.
- **AC5.2 Success.** Auto-reconnect re-sends `session:configure` and active subscriptions without manual client intervention.
- **AC5.3 Success.** `sendMessage()` fires over WebSocket (no return value); created message arrives via `message:created` event.

#### client-tool-protocol.AC6: Cross-Cutting Recovery (R-CTP10, R-CTP15)

- **AC6.1 Success.** Client disconnect + reconnect re-delivers pending `client_tool_call` entries matched by tool name. `claimed_by` updated to new connection handle.
- **AC6.2 Failure.** `tool:result` for expired entry (TTL exceeded, already synthesized error) receives `error` response with `code: "tool_call_expired"`. Result discarded.
- **AC6.3 Success.** Bootstrap recovery distinguishes `client_tool_call` entries (left for potential reconnect) from interrupted server tool calls (no client reconnection path; treated as failed). Periodic scan expires stale `client_tool_call` entries per AC3.4.

---

## 4. Implementation Notes

### 4.1 No Schema Migrations

This RFC requires no database schema changes. The `dispatch_queue` table already supports arbitrary `event_type` values; two new types (`client_tool_call`, `tool_result`) are added at runtime with no schema-level DDL. All other state is stored in per-connection server-side memory (tool registrations, `systemPromptAddition` mappings) or existing columns (`messages.content` stores `ContentBlock[]` as JSON, already supported).

### 4.2 Tool Name Collision Handling

When a `session:configure` arrives with a tool name that collides with an existing tool (platform tools, built-in tools, or another connection's client tools), the server rejects the configuration. The client must resolve the collision (e.g., by prefixing tool names) before re-sending. Boundless uses the `boundless_` prefix to avoid collisions; MCP tools use `boundless_mcp_{server}_{tool}`. The web UI has no client tools in v1, so collision is not a concern.

### 4.3 `systemPromptAddition` Scoping

The per-`(connection, threadId)` scoping (R-CTP3) allows a single connection to serve multiple threads with distinct additions. Boundless attaches to one thread at a time, so it always has exactly one `(connection, threadId)` pair with a live addition. A future IDE client might have multiple threads open simultaneously (e.g., one per project); each would have its own addition (cwd, project-specific context).

The `systemPromptAddition` is NOT sent to remote hosts via relay: when a thread is delegated (R-LD6 in the delegation RFC), the `ProcessPayload` does not carry the addition. This is correct: the addition describes the client's host environment (e.g., boundless cwd), which is orthogonal to which spoke runs the LLM inference. The client remains attached to the originating spoke; only the inference relocates. If the delegated loop needs client tools, `tool:call` messages route back to the originating spoke's connection via the relay transport.

### 4.4 Tool Dispatch Priority

The agent loop's tool dispatch order (R-CTP14) is:

1. Platform tools (`config.platformTools`) — Discord, Slack, etc.
2. **Client tools** (`config.clientTools`) — NEW, this RFC.
3. Built-in tools (`sandbox.builtInTools`) — `read`, `write`, `edit`, `bash`.
4. Bash fallback (MCP commands, shell) — catch-all for unrecognized names.

Client tools take priority over built-in tools so clients can shadow built-in behavior (e.g., boundless's `boundless_bash` takes precedence over the sandbox's `bash` tool, scoping execution to the client's host cwd rather than the server's sandbox VFS).

### 4.5 TTL and Expiry

The default TTL for `client_tool_call` entries is 5 minutes (300,000 ms), matching the scheduler's eviction timeout for running tasks. A periodic scan in the web server (not the scheduler) runs every 60 seconds and expires entries whose `created_at + TTL < now`. The TTL is not configurable in v1; future RFCs may expose it as a cluster-level config value.

### 4.6 Reconnection State

When a client reconnects, it re-sends `session:configure` and `thread:subscribe` for every thread it was previously attached to. The server matches pending `client_tool_call` entries by tool name (R-CTP10): if the new `session:configure` declares a tool `local_read` and a pending entry has `tool_name: "local_read"`, the entry is re-delivered. The server does NOT match by connection handle or session ID; tool name is the sole matching criterion.

This means:

- A client that crashes and restarts with the same tool names receives its own pending tool calls.
- A *different* client that connects and declares overlapping tool names may receive another client's pending tool calls if both are subscribed to the same thread. This is an accepted gap (see §6.7 of boundless RFC); the primary use case is a single boundless process per thread, where the restart path is unambiguous.

### 4.7 Thread Locking Semantics

R-CTP9 specifies that a thread with unresolved `client_tool_call` entries does not accept new agent loop runs. This is implemented by extending the `ThreadExecutor` lock concept (documented in `agent-system.md`): a thread is "locked" not just while a loop is running in-memory, but also while client tool calls are pending. The `handleThread` function in `packages/cli/src/commands/start/server.ts` checks for unresolved entries before instantiating a new `AgentLoop`.

New user messages sent while the thread is locked queue in `dispatch_queue` with `event_type: "user_message"` and are claimed on the next scheduler tick after the lock is released (when all `tool:result` messages have arrived and been processed).

### 4.8 Cost and Noise Budget

- **Per-connection state.** Each WebSocket connection holds a tool registry (Map of name → ToolDefinition) and a `systemPromptAddition` mapping (Map of threadId → string). For boundless, this is ~10 tools × ~500 bytes each + 1 threadId × ~200 bytes = ~5.2 KB per connection. For the web UI (no client tools in v1), it is ~200 bytes per connection (subscriptions only). 100 concurrent connections = ~520 KB server-side memory, acceptable.
- **`dispatch_queue` growth.** `client_tool_call` entries are ephemeral: they exist for the duration of one tool call (typically seconds to minutes), then are acknowledged and can be purged. The periodic scan removes expired entries. No unbounded growth expected.
- **Message overhead.** `tool:call` and `tool:result` messages add ~500 bytes per tool call (tool name, arguments, callId). A 10-tool turn adds ~5 KB to the WebSocket payload. Acceptable for the anticipated tool call rate (median 2–3 tools per turn, per existing message statistics).

---

## 5. Open Questions

**Q1.** Future optimization: should the `systemPromptAddition` be cached server-side and reused across cold cache builds, or always passed fresh per turn? Currently it is read from per-connection state on every `assembleContext()` call. Caching would require cache invalidation on `session:configure`, which is rare (only on tool registry hot-reload), so the optimization is likely premature.

**Q2.** Should the TTL for `client_tool_call` entries be configurable per-thread or per-connection? Currently it is a global constant (5 minutes). Per-thread TTL would allow long-running MCP tools (e.g., file indexing, large git operations) to opt into longer timeouts. Deferred pending evidence of need.

**Q3.** Should `tool:cancel` messages be acknowledged by the client? Currently they are fire-and-forget (R-CTP6). Acknowledgement would allow the server to track which clients honored the abort signal vs. which ignored it (handler already completed, or client unresponsive). Deferred; the synthesized error message already unblocks the agent loop regardless of client cooperation.

---

## 6. Migration

No data migration required. The HTTP POST endpoint (`/api/threads/:id/messages`) is removed; clients that still use it receive HTTP 404 and must upgrade to the WebSocket protocol. The web UI and boundless ship with the new protocol from initial release; no legacy clients exist in production.

Event naming migration (underscore → colon) is backward-incompatible for external clients: any script or tool that listens to `task_update` or `file_update` events must update to `task:updated` and `file:updated`. The web UI is updated in the same commit, so no client-side migration window exists. External integrations (if any) must upgrade before deploying the new server.

No coordinated cluster upgrade required. Spokes and hub can be rolled one at a time; the new event names propagate via the existing event bus, and the WebSocket protocol is server-local (not part of the inter-node relay transport).

---

## 7. Glossary

- **`session:configure`** — A WebSocket message (client→server) declaring which tools the client can execute and an optional `systemPromptAddition` string. Tool definitions persist for the connection lifetime and are re-sent automatically on reconnect.
- **`tool:call`** — A WebSocket message (server→client) requesting the client execute a tool. Contains `callId`, `threadId`, `toolName`, `arguments`. The client executes the tool locally and returns a `tool:result`.
- **`tool:result`** — A WebSocket message (client→server) returning the result of a tool execution. Contains `callId`, `threadId`, `content: string | ContentBlock[]`, `isError?: boolean`.
- **`tool:cancel`** — A WebSocket message (server→client) signaling that a previously-issued `tool:call` should be aborted. The client signals abort to the handler; late arrival after completion is dropped silently.
- **`client_tool_call` (dispatch_queue event type)** — A pending tool call awaiting client execution. `event_payload` contains `{tool_call_id, tool_name, arguments}`. `claimed_by` holds the server-side connection handle. Persisted in `dispatch_queue`, survives server restarts.
- **`tool_result` (dispatch_queue event type)** — Triggers agent loop resume when a client sends a `tool:result`. Claimed by the scheduler and processed as a normal agent turn start.
- **Client tool** — A tool definition registered by a connected WebSocket client via `session:configure`. The agent can call it like any other tool, but execution happens in the client process; the server only brokers the call and result.
- **`ClientToolCallRequest` sentinel** — A special return type from `executeToolCall()` signaling that a tool call must be deferred to a client. Analogous to `RelayToolCallRequest` for remote MCP tools.
- **Thread locking** — A thread with unresolved `client_tool_call` entries in `dispatch_queue` does not accept new agent loop runs. New user messages queue and are processed after all tool results arrive. Extends the existing `ThreadExecutor` lock concept.
- **`systemPromptAddition`** — An optional string sent on `session:configure` that is appended to the system prompt on every LLM call for a subscribed thread. Scoped per `(server-side-connection, threadId)` pair, allowing one connection to serve multiple threads with distinct additions.
- **Server-side connection handle** — The server's internal identifier for a WebSocket connection. Used to key per-connection state (tool registries, `systemPromptAddition` mappings) and to route `tool:call` messages to the correct connection. Distinct from the client-minted `connectionId` used by boundless for log file naming (which the server never sees).
- **TTL (Time To Live)** — The maximum duration (default 5 minutes) a `client_tool_call` entry remains pending before expiry. Expired entries trigger `tool:cancel` with `reason: "dispatch_expired"`, synthesize a tool-error message, and unblock the thread.
- **Fire-and-forget** — A message pattern where the sender does not await a synchronous reply. `message:send`, `tool:cancel`, and `thread:subscribe` are fire-and-forget; the server processes them and sends events asynchronously.
- **ContentBlock** — A discriminated union type from `@bound/llm` representing structured content: `{ type: "text"; text: string }`, `{ type: "image"; source: ImageSource; description?: string }`, or `{ type: "document"; source: ImageSource; textRepresentation: string; title?: string }`. Used in `tool:result.content` to allow clients (e.g., MCP servers) to return images or documents in addition to text.
