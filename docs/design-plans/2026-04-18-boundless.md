# Boundless — Coding Agent Client Design

## Summary

Boundless is a new terminal-based coding agent interface for bound. It connects to a running bound server and turns it into an interactive development assistant with full access to your local filesystem, shell, and external tools via MCP (Model Context Protocol). When you start boundless, it spawns a terminal UI that attaches to a single conversation thread, registers tools scoped to your current directory (file read/write/edit, bash execution), and lets the agent manipulate your local environment through those tools. The client runs entirely on your machine — no server-side changes beyond three backward-compatible protocol extensions that let clients customize the agent's system prompt, receive cancellation notifications for timed-out tool calls, and return structured content blocks (like images or documents) instead of just strings. MCP servers configured in `~/.bound/less/mcp.json` are spawned as subprocesses and their tools are proxied into the agent's tool set under namespaced names, enabling hot-reload and fine-grained control without bundling third-party integrations into the bound server itself.

The architecture is a new `@bound/less` package that compiles to a standalone `boundless` binary. It uses Ink (React for terminals) to render a chat view with message history, live tool execution feedback, and modal views for switching threads or configuring MCP servers. Session management ensures only one boundless process can attach to a given thread from a given directory at a time via lockfiles, with automatic stale-lock recovery and graceful rollback on attach failures. Ctrl-C cancels in-flight agent turns without exiting; double-press within 2 seconds exits cleanly. The protocol extensions — `systemPromptAddition` on `session:configure`, a new `tool:cancel` server-to-client message, and widening `tool:result.content` to accept `ContentBlock[]` — are all additive changes implemented in `@bound/web` and `@bound/agent` that preserve compatibility with existing clients like the web UI and bound-mcp.

## Definition of Done

1. **New `@bound/less` package** producing a `boundless` CLI binary — an Ink-based terminal UI that connects to a bound server via `@bound/client`, attaches to one thread at a time, registers host-side filesystem/shell tools and MCP-proxied tools, and presents an interactive coding session. Config/logs/locks under `~/.bound/less/`.

2. **Three backward-compatible protocol extensions** implemented server-side (`@bound/web`, `@bound/agent`): `systemPromptAddition` on `session:configure`, `tool:cancel` server-to-client message, and `tool:result.content` widened to `string | ContentBlock[]`. No DB schema changes.

3. **Four core tools** (`boundless_read`, `boundless_write`, `boundless_edit`, `boundless_bash`) with provenance metadata, plus an MCP bridge that proxies user-configured MCP servers under `boundless_mcp_<server>_<tool>` namespace with hot-reload via `/mcp` TUI view.

4. **Lockfile protocol** preventing same-thread double-attach from different cwds, with stale-lock recovery and attach-transition rollback semantics.

## Acceptance Criteria

### boundless.AC1: CLI Startup & Process Lifecycle
- **boundless.AC1.1 Success:** `boundless` with no args creates a new thread, acquires lockfile, launches TUI with empty scrollback
- **boundless.AC1.2 Success:** `boundless --attach <threadId>` loads existing thread, acquires lockfile, renders message history in scrollback
- **boundless.AC1.3 Success:** `boundless --url <url>` overrides config.json URL for the process lifetime without persisting
- **boundless.AC1.4 Failure:** `boundless --attach <nonexistent>` prints thread-not-found to stderr and exits 1
- **boundless.AC1.5 Failure:** `boundless` when bound server is unreachable prints connection error to stderr and exits 1
- **boundless.AC1.6 Success:** SIGTERM triggers graceful exit: MCP subprocesses terminated, lockfile released, exit 0
- **boundless.AC1.7 Success:** Binary compiles to `dist/boundless` via existing build script

### boundless.AC2: Protocol Extension — systemPromptAddition
- **boundless.AC2.1 Success:** `session:configure` with `systemPromptAddition` stores the string per (connection, threadId) pair for all subscribed threads
- **boundless.AC2.2 Success:** Agent loop's context assembly appends the stored string to the system suffix for the matching pair
- **boundless.AC2.3 Success:** `thread:subscribe` after `session:configure` inherits the connection's most recent systemPromptAddition
- **boundless.AC2.4 Success:** Re-sending `session:configure` replaces the stored string for all subscribed pairs; omitting the field clears it
- **boundless.AC2.5 Success:** `thread:unsubscribe` clears the pair's stored addition
- **boundless.AC2.6 Edge:** `session:configure` without `systemPromptAddition` field does not error; existing stored values cleared
- **boundless.AC2.7 Success:** Existing clients that do not send `systemPromptAddition` continue to work unchanged

### boundless.AC3: Protocol Extension — tool:cancel
- **boundless.AC3.1 Success:** `cancelThread(threadId)` emits `tool:cancel` with reason `thread_canceled` for every pending client_tool_call dispatch entry
- **boundless.AC3.2 Success:** TTL expiry emits `tool:cancel` with reason `dispatch_expired` and synthesizes tool-error LLMMessage for the agent loop
- **boundless.AC3.3 Success:** Connection close with pending entries emits `tool:cancel` with reason `session_reset` and synthesizes tool-error LLMMessage
- **boundless.AC3.4 Success:** Late `tool:result` for an already-canceled callId is accepted but discarded — no LLMMessage persisted
- **boundless.AC3.5 Success:** Client receiving `tool:cancel` for an unrecognized callId drops it silently
- **boundless.AC3.6 Edge:** Re-sending `session:configure` (MCP hot-reload) does NOT trigger tool:cancel for pending entries — they are preserved and re-delivered

### boundless.AC4: Configuration & Lockfile
- **boundless.AC4.1 Success:** Absent `config.json` treated as defaults (url=http://localhost:3001, model=null)
- **boundless.AC4.2 Success:** Absent `mcp.json` treated as `{ servers: [] }`
- **boundless.AC4.3 Success:** Config save preserves unknown fields (forward compatibility)
- **boundless.AC4.4 Success:** Lockfile acquired with O_EXCL for new thread; file contains `{ cwd, pid, attachedAt }`
- **boundless.AC4.5 Success:** Stale lockfile (dead pid via ESRCH) is cleared and re-acquired
- **boundless.AC4.6 Failure:** Live pid + same cwd produces error "thread X is already attached from this directory by pid Y"
- **boundless.AC4.7 Failure:** Live pid + different cwd produces error "thread X is attached from Z by pid Y; you are in W"
- **boundless.AC4.8 Success:** Lockfile released on detach (transition, exit, SIGTERM)
- **boundless.AC4.9 Failure:** Duplicate server names in `mcp.json` rejected at load time with specific error

### boundless.AC5: Core Tools
- **boundless.AC5.1 Success:** `boundless_read` returns line-numbered content with provenance prefix for valid file path
- **boundless.AC5.2 Success:** `boundless_read` with offset/limit returns the specified line range
- **boundless.AC5.3 Failure:** `boundless_read` on nonexistent file returns isError with ENOENT message
- **boundless.AC5.4 Edge:** `boundless_read` on binary file returns summary instead of raw content
- **boundless.AC5.5 Success:** `boundless_write` creates file with parent directories, returns byte count
- **boundless.AC5.6 Success:** `boundless_edit` replaces exactly one match of old_string with new_string
- **boundless.AC5.7 Failure:** `boundless_edit` with no match returns isError with "not found" message
- **boundless.AC5.8 Failure:** `boundless_edit` with multiple matches returns isError with match count and context
- **boundless.AC5.9 Success:** `boundless_bash` executes command in cwd, returns stdout/stderr with exit code
- **boundless.AC5.10 Success:** `boundless_bash` on AbortSignal sends SIGTERM, waits 2s, sends SIGKILL
- **boundless.AC5.11 Edge:** `boundless_bash` output >100KB is truncated from the middle with marker
- **boundless.AC5.12 Success:** All tool results are `ContentBlock[]` with provenance text block first
- **boundless.AC5.13 Success:** Tool registry detects name collisions and rejects the offending MCP server

### boundless.AC6: MCP Bridge
- **boundless.AC6.1 Success:** Stdio MCP server spawns, handshakes, enumerates tools under `boundless_mcp_<server>_<tool>` namespace
- **boundless.AC6.2 Success:** HTTP/SSE MCP server connects and enumerates tools
- **boundless.AC6.3 Success:** Tool call proxied via `client.callTool()`, MCP result mapped to ContentBlock[] with MCP provenance
- **boundless.AC6.4 Success:** `allowTools` filters enumerated tools to whitelist only
- **boundless.AC6.5 Success:** `confirm` tools show TUI confirmation prompt; "no" returns isError
- **boundless.AC6.6 Failure:** MCP server spawn/handshake failure is non-fatal — server marked failed, tools omitted, other servers unaffected
- **boundless.AC6.7 Success:** `terminateAll()` sends SIGTERM then SIGKILL after 2s to all stdio subprocesses
- **boundless.AC6.8 Success:** Hot-reload: add/remove/enable/disable server, rebuild tool list, re-send session:configure, persist to mcp.json

### boundless.AC7: Session Management
- **boundless.AC7.1 Success:** Attach flow executes in order: listMessages, subscribe, ensure MCP servers, build tools, configure
- **boundless.AC7.2 Success:** Pending tool calls in history rendered as placeholders, replaced when re-delivered
- **boundless.AC7.3 Success:** `/attach <threadId>` transitions: drain, unsubscribe old, release old lock, acquire new lock, attach new
- **boundless.AC7.4 Success:** `/clear` creates new thread and transitions to it; model selection preserved
- **boundless.AC7.5 Success:** Transition failure at lock acquisition triggers rollback to old thread
- **boundless.AC7.6 Edge:** Rollback failure (another process grabbed old lock) enters degraded read-only mode with persistent banner
- **boundless.AC7.7 Success:** Ctrl-C during active turn calls cancelThread once, aborts in-flight tool handlers
- **boundless.AC7.8 Success:** Double Ctrl-C within 2s exits gracefully (MCP terminated, lock released)
- **boundless.AC7.9 Success:** Ctrl-C during idle shows hint; second within 2s exits
- **boundless.AC7.10 Success:** Ctrl-C while modal open dismisses modal without counting toward exit
- **boundless.AC7.11 Edge:** Ctrl-C during attach transition deferred until transition settles

### boundless.AC8: TUI Primitives
- **boundless.AC8.1 Success:** SelectList handles arrow-key navigation, enter to select, escape/Ctrl-C to cancel
- **boundless.AC8.2 Success:** Confirm handles yes/no with keyboard
- **boundless.AC8.3 Success:** TextInput handles text entry, submit, disabled state, placeholder
- **boundless.AC8.4 Success:** Collapsible toggles content visibility
- **boundless.AC8.5 Success:** Banner renders error/info with dismissal
- **boundless.AC8.6 Success:** ModalOverlay traps focus and dismisses on escape

### boundless.AC9: TUI Views & Integration
- **boundless.AC9.1 Success:** ChatView renders message history with user/assistant/tool_call/tool_result blocks
- **boundless.AC9.2 Success:** In-flight tool calls render as ToolCallCard with spinner and elapsed time
- **boundless.AC9.3 Success:** `boundless_bash` stdout streams to ToolCallCard in real-time locally
- **boundless.AC9.4 Success:** StatusBar shows thread ID, model name, connection status, MCP server count
- **boundless.AC9.5 Success:** `/model <name>` sets model; `/model` opens picker populated from `client.listModels()`
- **boundless.AC9.6 Success:** `/attach` without arg opens thread picker from `client.listThreads()`; selection triggers transition
- **boundless.AC9.7 Success:** `/mcp` opens configuration view with server list, status badges, add/remove/enable/disable
- **boundless.AC9.8 Success:** Unknown slash command shows inline error
- **boundless.AC9.9 Success:** Non-slash input sends message via `client.sendMessage()` with current model

### boundless.AC10: Protocol Extension — Content Widening
- **boundless.AC10.1 Success:** `tool:result` with `content: string` persisted as single text block (backward compatible)
- **boundless.AC10.2 Success:** `tool:result` with `content: ContentBlock[]` (text, image, document) persisted verbatim
- **boundless.AC10.3 Failure:** `tool:result` with invalid ContentBlock variant (e.g., tool_use, thinking) rejected with error response
- **boundless.AC10.4 Success:** Existing string-only clients continue to work unchanged

## Glossary

- **bound**: The existing distributed agent system this design extends. Consists of a server (hub or spoke), agent loop, LLM backends, sync protocol, and web UI.
- **client-tool WebSocket protocol**: The bidirectional WS protocol introduced in `ws-client-tools` that lets clients register tools via `session:configure`, receive `tool:call` requests from the agent, and return results via `tool:result`.
- **ContentBlock**: A discriminated union type (`text | image | document`) used to represent structured LLM message content. This design extends tool results to accept arrays of these blocks instead of just strings.
- **dispatch_queue**: A server-side SQLite table that persists pending tool call requests. Entries are re-delivered on reconnection and can expire after a TTL.
- **Ink**: A React-based framework for building terminal UIs. Uses React components and hooks to render to the terminal instead of the DOM.
- **lockfile**: A filesystem-based mutex that ensures only one boundless process can attach to a thread from a given directory at a time. Uses `O_EXCL` semantics for atomic acquisition.
- **MCP (Model Context Protocol)**: An open standard for exposing tools, resources, and prompts as stdio or HTTP servers. Boundless spawns these as subprocesses and proxies their tools.
- **provenance**: A metadata prefix prepended to tool results that records which host, cwd, and tool produced the output. Enables the agent to reason about tool execution context.
- **session:configure**: The WebSocket message type that clients send to register their available tools with the server. This design extends it with an optional `systemPromptAddition` field.
- **systemPromptAddition**: A client-supplied string appended to the agent's system prompt for a specific (connection, threadId) pair. Lets clients inject contextual instructions without modifying the server.
- **tool:call / tool:result**: WebSocket message types for the tool dispatch round-trip. Server sends `tool:call` when the agent invokes a registered tool; client returns `tool:result` after execution.
- **tool:cancel**: A new server-to-client message type introduced in this design. Signals that a pending tool call was canceled due to thread cancellation, TTL expiry, or connection loss.
- **@bound/client**: The existing TypeScript client library for talking to bound over HTTP + WebSocket. Used by the web UI, bound-mcp, and now boundless.
- **@bound/less**: The new package introduced in this design that produces the `boundless` binary.
- **AbortSignal**: A Web API standard for signaling cancellation to async operations. Used to cancel in-flight tool handlers on Ctrl-C or thread detach.
- **O_EXCL**: A POSIX file-open flag that causes file creation to fail if the file already exists. Enables atomic lockfile acquisition.
- **Zod**: A TypeScript-first schema validation library used for config file validation and protocol message schemas throughout the bound monorepo.

## Architecture

Boundless is a new `@bound/less` package in the bound monorepo producing a compiled `boundless` binary. It connects to a running bound server over the existing client-tool WebSocket protocol, attaches to one thread at a time, and registers host-side tools into the agent's tool set for that thread. Three backward-compatible protocol extensions are added server-side to support the client's needs.

### Dependency Graph

```
@bound/less
  ├── @bound/client              (HTTP + WS to bound server)
  ├── @bound/shared              (ContentBlock, ToolDefinition, Message types)
  ├── @modelcontextprotocol/sdk  (MCP client: stdio, HTTP, SSE transports)
  ├── ink + react + react-dom    (terminal UI framework)
  └── zod                        (config schema validation)
```

`@bound/less` does NOT depend on `@bound/agent`, `@bound/core`, or `@bound/llm`. All interaction with bound is through the public client API and WebSocket protocol.

### Package Layout

```
packages/less/src/
  boundless.tsx             CLI entry: arg parsing, config load, Ink render
  config.ts                 Load/save config.json + mcp.json with Zod schemas
  lockfile.ts               Acquire/release/check lockfile protocol
  logging.ts                Structured JSON-lines logger
  tools/
    types.ts                ToolHandler signature
    read.ts                 boundless_read: line-range file reads
    write.ts                boundless_write: full file writes
    edit.ts                 boundless_edit: search-replace with exact-match validation
    bash.ts                 boundless_bash: subprocess with AbortSignal
    provenance.ts           Shared provenance prefix formatting
    registry.ts             Merge core + MCP tools, collision detection, systemPromptAddition builder
  mcp/
    manager.ts              McpServerManager: lifecycle (spawn/connect/disconnect/enumerate)
    proxy.ts                Proxy tool:call to MCP callTool, map results to ContentBlock[]
  session/
    attach.ts               Attach flow: listMessages, subscribe, configure
    transition.ts           /attach and /clear transitions with rollback
    cancel.ts               Ctrl-C state machine
  tui/
    App.tsx                 Root component: state reducer, keybindings, view routing
    hooks/
      useSession.ts         BoundClient lifecycle, connection state, event routing
      useMessages.ts        Message list state, append on message:created
      useToolCalls.ts       In-flight tool call tracking, AbortController map
      useMcpServers.ts      MCP server state, add/remove/enable/disable
    views/
      ChatView.tsx          Main view: scrollback + input + status
      McpView.tsx           /mcp configuration view
      PickerView.tsx        Shared picker for /attach and /model
    components/             Primitive design system (see below)
```

### Protocol Extensions (Server-Side)

Three additive changes to the client-tool WebSocket protocol, implemented in `@bound/web` and `@bound/agent`:

**systemPromptAddition on session:configure** — `sessionConfigureSchema` in `packages/web/src/server/websocket.ts` gains optional `systemPromptAddition: z.string().optional()`. `ClientConnection` gains a connection-level `systemPromptAddition` field plus a per-thread map `systemPromptAdditions: Map<threadId, string>`. `handleSessionConfigure` stores the string and propagates to all subscribed threads. `handleThreadSubscribe` inherits the connection-level value; `handleThreadUnsubscribe` clears the pair. `ConnectionRegistry` gains `getSystemPromptAdditionForThread(threadId)`. In `packages/agent/src/context-assembly.ts`, `ContextParams` gains `systemPromptAddition?: string`, appended as a final block in the system suffix (uncached, varying).

**tool:cancel message (server-to-client)** — new helper `emitToolCancel(threadId, reason)` in `packages/web/src/server/websocket.ts` finds pending `client_tool_call` dispatch entries for the thread, sends `{ type: "tool:cancel", callId, threadId, reason }` to the claiming connection. Called from three sites: (1) `cancelThread` route handler (reason `thread_canceled`, no synthesized error — agent loop already interrupted), (2) `expireClientToolCalls` TTL scan (reason `dispatch_expired`, synthesizes tool-error LLMMessage), (3) connection close with pending entries (reason `session_reset`, synthesizes tool-error LLMMessage). Late `tool:result` for already-canceled callIds is accepted but discarded.

**tool:result.content widened to string | ContentBlock[]** — `toolResultSchema.content` in `packages/web/src/server/websocket.ts` changes to `z.union([z.string(), z.array(contentBlockSchema)])`. `contentBlockSchema` validates three variants: text, image, document. `handleToolResult` persists string as `[{ type: "text", text }]`; `ContentBlock[]` verbatim.

### Client Library Extensions

`@bound/client` gains:
- `configureTools(tools, options?)` — optional second arg `{ systemPromptAddition?: string }`, stored locally for reconnection re-send
- `ToolCallResult.content` type widens from `string` to `string | ContentBlock[]`
- New `tool:cancel` event in `BoundClientEvents` with `{ callId, threadId, reason? }`

### Core Tools

Four tools registered via `session:configure`, all scoped to the cwd of the boundless process:

**boundless_read** — `file_path: string`, `offset?: number` (1-indexed line), `limit?: number`. Reads file, returns line-numbered content. Binary detection (null bytes in first 8KB) returns summary instead of content.

**boundless_write** — `file_path: string`, `content: string`. Creates parent directories, writes atomically (temp + rename). Returns byte count.

**boundless_edit** — `file_path: string`, `old_string: string`, `new_string: string`. Exact-match search-replace. Errors on: not found, multiple matches (returns match count + context). The exact-match constraint serves as implicit content validation — `old_string` is the content fingerprint.

**boundless_bash** — `command: string`, `timeout?: number` (default 300000ms). Spawns `sh -c command` in cwd. NOTE: `sh` is a temporary Unix-only approach; Windows remediation deferred. On AbortSignal: SIGTERM to process group, 2s grace, SIGKILL. Large output (>100KB) truncated from middle.

All tools prepend a provenance text block: `[boundless] host=<hostname> cwd=<cwd> tool=<toolName>`. Tool results are sent as `ContentBlock[]`.

### MCP Bridge

`McpServerManager` owns the lifecycle of all MCP server connections. Maintains `Map<serverName, McpServerState>` with status (running/failed/not-spawned/disabled), SDK Client instance, enumerated tools, and last error. Transports created via `@modelcontextprotocol/sdk`: `StdioClientTransport` for stdio (stderr piped to per-server log), `StreamableHTTPClientTransport` for HTTP/SSE.

Tool proxy receives `tool:call` for `boundless_mcp_<server>_<tool>` names, parses server/tool, calls `client.callTool()`, maps MCP result to `ContentBlock[]` with MCP-specific provenance prefix.

`allowTools` filters enumerated tools to the whitelist. `confirm` patterns wrap matching tools with a TUI confirmation gate before execution.

Hot-reload: McpServerManager diffs old/new state, spawns/terminates as needed, tool registry rebuilds, `session:configure` re-sent. State persisted to `mcp.json`.

### Session Management

**Lockfile** — `~/.bound/less/locks/<threadId>.json` acquired with `O_EXCL` semantics. Contents: `{ cwd, pid, attachedAt }`. Stale detection via `process.kill(pid, 0)`. Same-cwd and different-cwd conflicts produce distinct error messages.

**Attach flow** — executes in order: listMessages (render history, detect pending tool calls), subscribe, ensure MCP servers, build merged tool list, send session:configure. MCP server failures are non-fatal (tools omitted, banner shown).

**Transitions** — `/attach` and `/clear` drain in-flight tool handlers (500ms deadline), unsubscribe old thread, release old lock, acquire new lock, perform attach. On failure at any step: rollback to old thread (re-subscribe, re-acquire lock). If rollback itself fails (another process grabbed the lock): degraded read-only mode with persistent banner.

**Cancellation** — Ctrl-C state machine tracks `lastCtrlCTime`, `canceledThisTurn`, `turnActive`, `modalOpen`, `transitionInFlight`. Active turn + first Ctrl-C = `cancelThread()` via HTTP. Second Ctrl-C within 2s = graceful exit. Idle + first = hint, second within 2s = exit. Modal open = dismiss (not counted). Transition in flight = deferred.

### TUI Primitive Design System

Atomic primitives composed into higher-level views:

**Primitives:** `<Spinner />` (elapsed time), `<Badge status={} />` (colored status), `<Collapsible header={} defaultOpen={}>`, `<KeyHint keys={} label={} />`

**Controls:** `<TextInput onSubmit={} placeholder={} disabled={} />`, `<SelectList items={} onSelect={} onCancel={} renderItem={} />`, `<Confirm message={} onYes={} onNo={} />`, `<ActionBar actions={} />`

**Layout:** `<ScrollRegion maxHeight={}>`, `<Banner type={} onDismiss={} />`, `<ModalOverlay onDismiss={}>`, `<SplitView top={} bottom={} />`

**Composed views:** `PickerView` = ModalOverlay > SelectList + ActionBar. `McpView` = ModalOverlay > SelectList (with Badge per item) + ActionBar + Confirm. `ChatView` = SplitView (ScrollRegion with MessageBlock list + Input) + Banner. `ToolCallCard` = Spinner + Badge + Collapsible (for bash output streaming).

### Tool Dispatch Flow

1. Server sends `tool:call` via WS, BoundClient emits event
2. `useToolCalls` hook creates AbortController, adds to `inFlightTools`
3. Dispatches to core tool handler or MCP proxy based on name prefix
4. Handler runs with AbortSignal, returns `ContentBlock[]`
5. `client.sendToolResult({ callId, threadId, content, isError? })`
6. Hook removes from `inFlightTools`

Context invalidation aborts: WS disconnect aborts all (no result sent, server re-delivers on reconnect). `/attach` transition drains with 500ms deadline. MCP disable aborts in-flight proxy calls (error result sent).

### Configuration

`~/.bound/less/config.json` — `{ url, model }` with `passthrough()` for forward compatibility. `--url` flag overrides without persisting. `/model` persists on valid selection.

`~/.bound/less/mcp.json` — `{ servers: [...] }` with camelCase fields mirroring bound's `mcpSchema`. Server name uniqueness validated at load time.

### Logging

Application log (`~/.bound/less/logs/application.log`): `O_APPEND`, JSON lines, INFO+, `{ ts, level, pid, event, ...fields }`.

Per-connection log (`~/.bound/less/logs/<threadId>/<connectionId>.log`): DEBUG+, opened at attach, closed at detach. New connectionId minted on WS reconnect.

MCP stderr log (`~/.bound/less/logs/<threadId>/<connectionId>-<serverName>.log`): raw subprocess stderr piped directly.

No rotation in v1.

## Existing Patterns

This design follows several established patterns in the bound codebase:

**client-tool WebSocket protocol** (`packages/web/src/server/websocket.ts`, `packages/client/src/client.ts`) — boundless is the second consumer of the `session:configure` / `tool:call` / `tool:result` protocol introduced by `ws-client-tools`. All tool dispatch, dispatch_queue persistence, reconnection re-delivery, and TTL expiry mechanics are reused without modification. The three protocol extensions are additive and backward-compatible.

**BoundClient usage** (`packages/client/src/client.ts`) — boundless uses BoundClient identically to how the web UI and bound-mcp use it: `connect()`, `subscribe()`, `sendMessage()`, `configureTools()`, `onToolCall()`, event listeners. No subclassing or monkey-patching.

**MCP SDK client** (`packages/agent/src/mcp-client.ts`) — the existing MCPClient in @bound/agent wraps `@modelcontextprotocol/sdk` with `StdioClientTransport` and `StreamableHTTPClientTransport`. Boundless creates its own thin wrapper in `@bound/less` using the same SDK classes and transport patterns, avoiding a dependency on @bound/agent. The transport creation code mirrors the existing pattern.

**dispatch_queue lifecycle** (`packages/core/src/dispatch.ts`) — the `enqueueClientToolCall` / `acknowledgeClientToolCall` / `expireClientToolCalls` / `cancelClientToolCalls` functions are consumed as-is through the server's existing WS handler. No new dispatch_queue event types are introduced.

**ContentBlock types** (`packages/llm/src/types.ts`) — tool results use the existing `ContentBlock` discriminated union (text, image, document). The `tool:result.content` widening admits these same types over the wire.

**Divergence: Ink/React TUI** — bound has no existing terminal UI framework. The CLI (`packages/cli/`) uses plain console output. Ink + React is a new dependency introduced solely in `@bound/less`. This is intentional: boundless is an interactive client with component-based UI needs that the existing CLI does not have.

**Divergence: client-side MCP management** — bound's existing MCP servers are configured server-side in `mcp.json` and managed by the agent process. Boundless manages MCP servers client-side: spawning subprocesses, enumerating tools, and proxying calls locally. This is the core architectural difference that enables session-scoped tool authority.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Package Scaffolding & Protocol Extensions

**Goal:** Create the `@bound/less` package skeleton and implement all three server-side protocol extensions with their client-side counterparts in `@bound/client`.

**Components:**
- `packages/less/package.json` — workspace package with dependencies (ink, react, @bound/client, @bound/shared, @modelcontextprotocol/sdk, zod)
- `packages/less/tsconfig.json` — TypeScript config matching monorepo conventions
- `packages/client/src/client.ts` — extend `configureTools()` with optional `{ systemPromptAddition }`, add `tool:cancel` event handling, widen `ToolCallResult.content` type
- `packages/client/src/types.ts` — widen `ToolCallResult.content` to `string | ContentBlock[]`, add `ToolCancelEvent` type
- `packages/web/src/server/websocket.ts` — `sessionConfigureSchema` gains `systemPromptAddition`, `ClientConnection` gains `systemPromptAddition` field and per-thread map, `toolResultSchema.content` widened with `contentBlockSchema` validation, `emitToolCancel()` helper, cancel/expiry/close emission sites, late-result discard logic
- `packages/agent/src/context-assembly.ts` — `ContextParams.systemPromptAddition`, appended in system suffix
- `packages/web/src/server/websocket.ts` — `ConnectionRegistry.getSystemPromptAdditionForThread()`, wired into agent loop factory
- `scripts/build.ts` or equivalent — fourth binary entry for `dist/boundless`

**Dependencies:** None (first phase)

**Done when:** `@bound/less` package installs and builds. `systemPromptAddition` flows from client through WS to context assembly. `tool:cancel` emitted on cancelThread/TTL expiry/connection close. `tool:result` accepts `ContentBlock[]`. All three extensions have passing tests. Existing test suite unaffected. Covers `boundless.AC2.*`, `boundless.AC3.*`.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Configuration, Lockfile & Logging

**Goal:** Implement the on-disk state layer: config loading/saving, lockfile protocol, and structured logging.

**Components:**
- `packages/less/src/config.ts` — `configSchema` and `mcpConfigSchema` Zod schemas, `loadConfig()`, `saveConfig()`, `loadMcpConfig()`, `saveMcpConfig()` with passthrough for forward compat, server name uniqueness validation
- `packages/less/src/lockfile.ts` — `acquireLock()`, `releaseLock()`, `ensureLocksDir()` with O_EXCL semantics, stale pid detection, same-cwd/different-cwd error messages
- `packages/less/src/logging.ts` — `AppLogger` with application-level and per-connection JSON-lines writers, `ensureLogDirs()`, log event types

**Dependencies:** Phase 1 (package exists)

**Done when:** Config round-trips through load/save with unknown field preservation. Lockfile acquisition succeeds for new threads, fails correctly for live-pid conflicts (same cwd, different cwd), clears stale locks. Logging writes structured JSON lines to correct paths. Covers `boundless.AC4.*`.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Core Tools

**Goal:** Implement the four host-side tool handlers with provenance, abort support, and the tool registry.

**Components:**
- `packages/less/src/tools/types.ts` — `ToolHandler` type signature `(args, signal, cwd) => Promise<ContentBlock[]>`
- `packages/less/src/tools/provenance.ts` — `formatProvenance(hostname, cwd, toolName)` and `formatMcpProvenance(hostname, serverName, toolName)`
- `packages/less/src/tools/read.ts` — line-range reads with line numbers, binary detection, ENOENT/EACCES handling
- `packages/less/src/tools/write.ts` — atomic write (temp + rename), mkdir -p, byte count return
- `packages/less/src/tools/edit.ts` — exact-match search-replace, not-found and multiple-match error paths
- `packages/less/src/tools/bash.ts` — `Bun.spawn(["sh", "-c", command])` with AbortSignal, SIGTERM/SIGKILL lifecycle, output truncation, timeout
- `packages/less/src/tools/registry.ts` — `buildToolSet(cwd, mcpTools?)` merging core four + MCP tools, collision detection, `buildSystemPromptAddition(cwd, hostname, mcpServers)`

**Dependencies:** Phase 1 (ContentBlock types available)

**Done when:** Each tool handler produces correct ContentBlock[] output with provenance. Read handles line ranges and binary files. Edit rejects ambiguous matches. Bash respects abort signal and timeout. Registry detects collisions. Covers `boundless.AC5.*`.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: MCP Bridge

**Goal:** Implement MCP server lifecycle management and tool call proxying.

**Components:**
- `packages/less/src/mcp/manager.ts` — `McpServerManager` class: spawn/connect/disconnect per server, MCP initialize + tools/list handshake, per-server state tracking (status, client, tools, error), `ensureAllEnabled()`, `terminateAll()` with SIGTERM/SIGKILL, stderr piping to log files
- `packages/less/src/mcp/proxy.ts` — `proxyToolCall(serverName, toolName, args, signal)`: parse prefixed name, lookup server, `client.callTool()`, map MCP result to ContentBlock[] (text, image, graceful degradation for unknown types), MCP provenance prefix
- Integration with `tools/registry.ts` — `allowTools` filtering, `confirm` gate wrapping, `boundless_mcp_<server>_<tool>` name derivation

**Dependencies:** Phase 2 (config loading for mcp.json), Phase 3 (tool registry)

**Done when:** Stdio MCP servers spawn, handshake, and enumerate tools. HTTP/SSE transports connect. Tool calls proxy through and return ContentBlock[]. allowTools filters correctly. Server failures are non-fatal (tools omitted, error tracked). terminateAll sends SIGTERM then SIGKILL. Covers `boundless.AC6.*`.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Session Management

**Goal:** Implement attach flow, thread transitions (/attach, /clear), and the Ctrl-C cancellation state machine.

**Components:**
- `packages/less/src/session/attach.ts` — `performAttach(client, threadId, mcpManager, cwd, logger)`: listMessages (detect pending tool calls), subscribe, ensureAllEnabled, buildToolSet, configureTools with systemPromptAddition. Returns messages, pending tool call IDs, MCP failures.
- `packages/less/src/session/transition.ts` — `transitionThread(client, oldId, newId, ...)`: drain in-flight tool handlers (500ms deadline), unsubscribe, release lock, acquire new lock, getThread, performAttach. Rollback on failure at any step. Degraded mode if rollback fails.
- `packages/less/src/session/cancel.ts` — `CancelStateMachine` class: tracks lastCtrlCTime, canceledThisTurn, turnActive, modalOpen, transitionInFlight. `onCtrlC()` implements the full state machine from R-BL20. `gracefulExit()` terminates MCP, releases lock, disconnects, exits.

**Dependencies:** Phase 2 (lockfile), Phase 3 (tool registry), Phase 4 (MCP manager)

**Done when:** Fresh attach loads history and configures tools. Thread transitions release/acquire locks correctly with rollback on failure. Ctrl-C cancels active turns, double-press exits, modal dismissal works, transition deferral works. Covers `boundless.AC7.*`.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: TUI Primitives & Design System

**Goal:** Build the shared primitive component library that all views compose from.

**Components:**
- `packages/less/src/tui/components/Spinner.tsx` — elapsed time display with activity indicator
- `packages/less/src/tui/components/Badge.tsx` — colored status badges (running, failed, disabled, connected, etc.)
- `packages/less/src/tui/components/Collapsible.tsx` — expandable/collapsible content region with header
- `packages/less/src/tui/components/KeyHint.tsx` — keyboard shortcut hint display
- `packages/less/src/tui/components/TextInput.tsx` — single-line text entry with submit, placeholder, disabled state
- `packages/less/src/tui/components/SelectList.tsx` — arrow-key navigable list with renderItem, onSelect, onCancel
- `packages/less/src/tui/components/Confirm.tsx` — yes/no confirmation prompt
- `packages/less/src/tui/components/ActionBar.tsx` — bottom bar showing available keyboard shortcuts
- `packages/less/src/tui/components/ScrollRegion.tsx` — scrollable content area
- `packages/less/src/tui/components/Banner.tsx` — error/info notification bar
- `packages/less/src/tui/components/ModalOverlay.tsx` — focus-trapping overlay for pickers/views
- `packages/less/src/tui/components/SplitView.tsx` — header + content layout pattern

**Dependencies:** Phase 1 (ink + react available)

**Done when:** Each primitive renders correctly in isolation. SelectList handles keyboard navigation. Confirm handles yes/no. TextInput handles submit and disabled state. Components compose without conflicts. Covers `boundless.AC8.*`.
<!-- END_PHASE_6 -->

<!-- START_PHASE_7 -->
### Phase 7: TUI Views & App Shell

**Goal:** Compose primitives into the full TUI: chat view, MCP view, pickers, and the root App component with state management.

**Components:**
- `packages/less/src/tui/components/MessageBlock.tsx` — renders user/assistant/tool_call/tool_result messages, pending tool call placeholders
- `packages/less/src/tui/components/ToolCallCard.tsx` — in-flight tool execution display with spinner, bash stdout streaming
- `packages/less/src/tui/components/StatusBar.tsx` — thread ID, model, connection status, MCP count
- `packages/less/src/tui/views/ChatView.tsx` — ScrollRegion with MessageBlock list, ToolCallCard for in-flight, Banner, TextInput with slash command parsing
- `packages/less/src/tui/views/McpView.tsx` — ModalOverlay with SelectList (Badge per server), ActionBar, add/remove/enable/disable flows
- `packages/less/src/tui/views/PickerView.tsx` — shared ModalOverlay + SelectList for /attach (thread list) and /model (model list)
- `packages/less/src/tui/hooks/useSession.ts` — BoundClient lifecycle, connection state, event routing to dispatch
- `packages/less/src/tui/hooks/useMessages.ts` — message list state, append/update on message:created, pending placeholder replacement
- `packages/less/src/tui/hooks/useToolCalls.ts` — AbortController map, tool dispatch to handlers, tool:cancel handling, context invalidation aborts
- `packages/less/src/tui/hooks/useMcpServers.ts` — McpServerManager integration, status updates for McpView
- `packages/less/src/tui/App.tsx` — useReducer with AppState, useInput for Ctrl-C routing to CancelStateMachine, view routing (chat/mcp/picker), slash command dispatch

**Dependencies:** Phase 5 (session management), Phase 6 (primitives)

**Done when:** Chat view renders message history and streams tool call output. /mcp view manages servers with hot-reload. /attach and /model pickers work. Ctrl-C cancellation and exit work end-to-end. Slash commands dispatch correctly. Covers `boundless.AC9.*`.
<!-- END_PHASE_7 -->

<!-- START_PHASE_8 -->
### Phase 8: CLI Entry & End-to-End Integration

**Goal:** Wire everything together: CLI arg parsing, startup sequence, graceful shutdown, binary compilation, and end-to-end validation.

**Components:**
- `packages/less/src/boundless.tsx` — CLI entry: parse `--attach` and `--url`, load config, validate mcp.json uniqueness, connect BoundClient (with timeout), create/get thread, acquire lock, open logger, `render(<App />)`. Startup errors go to stderr + exit 1. SIGTERM handler for graceful exit.
- `scripts/build.ts` or equivalent — add `dist/boundless` compilation target
- End-to-end integration tests — startup with no args (creates thread), startup with --attach (loads existing), --attach nonexistent (exit 1), lockfile conflicts (same cwd, different cwd, stale), /attach transition with rollback, /clear, /mcp hot-reload, Ctrl-C cancel and exit, tool dispatch round-trip

**Dependencies:** Phase 7 (TUI complete)

**Done when:** `boundless` starts, connects, attaches, and renders. `boundless --attach <id>` loads existing thread. `boundless --url <url>` overrides config. Lockfile conflicts produce correct error messages. Graceful exit cleans up MCP subprocesses and lockfiles. Binary compiles to `dist/boundless`. End-to-end tests pass. Covers `boundless.AC1.*`, `boundless.AC10.*`.
<!-- END_PHASE_8 -->

## Additional Considerations

**`sh -c` in boundless_bash is Unix-only.** This is a known temporary limitation. Windows support (selecting `cmd /c` or `powershell -Command` based on platform) is deferred to a future remediation pass.

**No token-level streaming.** Boundless receives complete messages via `message:created` events as the agent loop persists them. Tool calls and results arrive individually as they're processed; the final assistant text arrives after the LLM response completes. Real-time feedback comes from watching tool executions happen, not from per-token streaming. This matches the protocol's three defined extensions — no streaming extension is introduced.

**Empty threads from failed /clear.** Each failed `/clear` after `createThread` succeeds leaves an empty thread on the server. No client-side GC; no server-side GC today. A future thread-retention RFC can sweep these.

**Multi-machine lockfile gap.** Two boundless processes on different hosts can both attach to the same thread; lockfiles are per-host filesystem. The `systemPromptAddition` includes `host=`, so the agent observes both. Cross-host coordination is deferred.

**Config concurrent-write collisions.** Hand-edits to `config.json` or `mcp.json` while boundless is running may be overwritten on the next persist. Last-writer-wins.
