# RFC: Boundless — Coding Agent Client

**Supplements:** `docs/design-plans/2026-04-16-ws-client-tools.md`
**Date:** 2026-04-17
**Status:** Draft

---

## 1. Introduction

This document specifies boundless, a terminal-based coding-agent client for bound. A boundless process runs on a user's workstation, connects to a bound server over the existing client-tool WebSocket interface, attaches to one bound thread at a time, and registers host-side filesystem and shell tools into the agent's tool set for that thread. A boundless process may additionally launch user-configured MCP servers as subprocesses and proxy their tools into the same tool set under a distinct prefix.

The design reuses existing bound mechanisms — thread storage, agent loops, memory operations, scheduler, and the client-tool protocol — without modification beyond three backward-compatible extensions to the client-tool protocol, specified in §3.10 and §4.2. No database schema changes are required.

### 1.1 Motivation

bound provides LLM-backed threads, a memory graph, a scheduler, and client surfaces (web UI, Discord, `@bound/cli`) sharing a common thread store. None of these surfaces give the bound agent access to the user's working filesystem. The user has three options for combining bound with coding work:

- Drive the work by hand, describing files and pasting command output to the agent through an existing surface. This is workable for isolated questions but does not scale to sessions that involve multiple files, iteration, or command execution as a primary activity.
- Attach a filesystem-and-shell MCP server to the bound spoke. This grants the bound agent persistent, cluster-wide access to the spoke's host. It is a poor match for session-bounded coding work for the reasons given in §1.3.
- Run a separate coding-agent client. Such clients exist and are capable, but each maintains its own thread, message, and memory storage independently of bound. Context produced during coding work does not enter bound's thread store or memory graph, and is therefore unavailable to the bound agent when the user consults it through any other surface.

This document specifies a fourth option: a coding-agent client whose durable state lives in bound. A boundless session is a bound thread; its messages, tool calls, and tool results are bound thread events; memory operations issued during the session write to bound's memory store. Sessions are inspectable from other bound surfaces while active, resumable from boundless after detach, and contribute to bound's memory graph regardless of which surface the agent is consulted through subsequently.

### 1.2 Cross-Surface Accrual

boundless is run intermittently. A user opens it for a coding session and closes it when the session ends; bound runs without any boundless process attached for the remainder of the time. This section describes the effect of intermittent boundless use on other bound surfaces.

- **Memory.** Messages, tool calls, and memory operations from a boundless session are written to the same thread store and memory graph that the rest of bound reads from. Agent interactions on other surfaces subsequently observe this state. A bound deployment that has hosted coding sessions has memory coverage of the user's development work; one that has not, does not.
- **Scheduled tasks.** bound's scheduler-driven tasks can query and reference boundless-produced threads as they can any other thread. A scheduled task observing an upstream change can cite a thread in which the user worked on the affected area; a scheduled task synthesizing across recent activity can relate an unrelated note to a coding decision.
- **Thread inspection.** While boundless is not running, the thread it last attached to remains an ordinary bound thread. Other surfaces (web UI, Discord, `@bound/cli`, advisories) can read, summarize, and cross-reference it by the same mechanisms they use for any other thread.

### 1.3 Tension With the Existing MCP Path

bound's agent can reach a user's filesystem without boundless. bound supports MCP servers configured against an agent, and MCP's transports (stdio, streamable HTTP, SSE) admit a server running on the same machine as the bound spoke. A user whose spoke runs on their own workstation — the common case for single-user deployments — can configure a filesystem-and-shell MCP server and grant the bound agent broad access to that machine. This path has the following properties, which make it a poor fit for session-scoped coding work:

- **A bound agent's authority is long-lived and cluster-wide.** The spoke that hosts the MCP server sits inside a bound cluster where any active thread on any node can reach the tools that spoke registers. Authority granted once is authority granted permanently, to every agent session on that spoke, for every task that agent undertakes. A coding session is normally bounded by a task: the user opens it for a specific purpose, works on that purpose, and closes it. The scope of acceptable side-effects is the task's scope, and that scope ends with the task.
- **A bound agent's work is not continuously observed.** A user may have multiple active threads doing unrelated background work without watching any one of them. A coding session, in contrast, is a task the user is present for: reading the agent's output as it appears and in a position to intervene. The acceptable risk profile differs accordingly.
- **A permanent host bridge cannot be scoped to a cwd.** A coding agent is trustworthy in part because its reads and writes are bounded to the project being edited. A filesystem MCP plugged into bound has no task-scoped cwd; it has whatever cwd the user configured globally. Per-thread scoping can be added to an MCP server, but doing so reimplements boundless inside an MCP server.

boundless takes the opposite position on these tradeoffs: it holds workstation authority only while attached, scopes that authority to the cwd the user launched it in, releases it on detach, and surfaces the host-side and sandbox-side split in the agent's tool namespace. The tension between bound's persistent-agent deployment model and a coding session's session-scoped needs persists beyond this RFC. Cross-host attach, delegated authority, and background coding tasks are anticipated follow-up work.

### 1.4 Scope

This RFC specifies:
- A new `@bound/less` package in the bound monorepo, producing a CLI binary named `boundless`.
- An Ink-based terminal UI for interactive coding sessions.
- Four host-side tools (`boundless_read`, `boundless_write`, `boundless_edit`, `boundless_bash`) registered via the existing `session:configure` message.
- A bridge that proxies user-configured MCP servers into the agent's tool set under the `boundless_mcp_<serverName>_<toolName>` namespace.
- A configuration surface under `~/.bound/less/` (config, MCP servers, logs, lockfiles).
- An attach-time lockfile protocol preventing a single thread from being attached from two different working directories simultaneously.
- Three protocol extensions: `systemPromptAddition` on `session:configure`, a new `tool:cancel` message, and a widened `tool:result.content`.

This RFC does not specify:
- **Project-local configuration.** `.boundless.toml` in the cwd and related override semantics are deferred. All configuration in v1 lives in `~/.bound/less/`.
- **Environment variable overrides.** No `BOUND_URL` or similar. Config file and CLI flags only.
- **Authentication.** The WebSocket to bound is assumed reachable without additional auth in v1 (localhost default, no token). Remote-bound scenarios are deferred.
- **Log rotation and retention.** Log files grow unbounded in v1 and are documented as such.
- **The TUI's specific Ink component tree, keybindings, and visual layout.** These are captured in implementation design documents that follow this RFC.
- **Multi-host boundless scenarios.** Two boundless instances on different machines attached to the same thread via the bound server are not prevented by the lockfile design and are documented as an accepted gap.

### 1.5 Design Principles

**bound is the authoritative record of every interaction the agent has ever had.** Every message, tool call, tool result, and memory operation is persisted to bound; boundless holds no durable state that bound does not also hold. Local files under `~/.bound/less/` are limited to user preferences and in-session scratch space. A workstation that loses `~/.bound/less/` should lose only preferences; a bound instance that loses its database should lose the session.

**The agent experiences host-side tools as ordinary tools.** boundless's tools carry no special status beyond a prefix that disambiguates them and a `systemPromptAddition` string that describes their scope. Tool-selection, output-rendering, and error-handling behavior on the agent side is identical to any other client-registered tool. Every coding-specific affordance on the agent side would erode the property that any other client type can register tools the same way and get the same behavior.

**Fail loudly at startup, fail gracefully in session.** A user invoking `boundless --attach nonexistent` finds out at launch; a user whose MCP server crashes mid-session keeps their session. The same underlying operations power both paths; the caller decides whether a failure kills the process or becomes a banner.

**Cross-surface parity is a constraint, not a feature.** Every state change boundless makes (thread creation, attach, tool dispatch, MCP-server configuration effect) is visible to and reversible from other bound surfaces where analogous operations exist. boundless is permitted UX-specific affordances (pickers, keyboard shortcuts, MCP subprocess lifecycle) but not to create state that only a `boundless` process can observe or undo.

**Protocol genericity over application-specific convenience.** Extensions this RFC proposes to the client-tool transport (`systemPromptAddition`, `tool:cancel`, widened `tool:result.content`) are phrased so any future client can adopt them. Application-specific concerns (cwd tracking, MCP bridging, thread-cwd locking) live entirely in boundless, at a client-side complexity cost that a coding-agent-specific protocol would not pay.

---

## 2. Proposal

### 2.1 Summary

A new `@bound/less` package is added to the bound monorepo, producing the `boundless` CLI: an Ink-based terminal UI client consuming `@bound/client`. On startup (or on `--attach <threadId>`), boundless connects to a bound server, acquires a per-thread lockfile, subscribes to the thread, registers four prefixed host-side tools (`boundless_read`, `boundless_write`, `boundless_edit`, `boundless_bash`) and any user-configured MCP-proxied tools (`boundless_mcp_<server>_<tool>`) via `session:configure`, and presents an interactive coding UI. Configuration, logs, and lockfiles are stored under `~/.bound/less/`. MCP server add, remove, and enable/disable operations, as well as model changes, hot-reload via in-TUI commands; URL changes require a process restart. Three additive protocol items are introduced: an optional `systemPromptAddition` on `session:configure`, a new `tool:cancel` message type, and a widened `tool:result.content` type admitting `ContentBlock[]` in addition to `string`.

### 2.2 What This Changes

At the level of public surfaces and contracts:

- A new interactive client binary is added to bound. It is a long-lived process that connects to a bound server and attaches to one thread at a time, with in-process transitions between threads.
- The client-tool WebSocket protocol (originally documented in `docs/design-plans/2026-04-16-ws-client-tools.md`) gains three additive, backward-compatible extensions: an optional `systemPromptAddition` field on `session:configure`, a new server-to-client `tool:cancel` message type, and a widening of `tool:result.content` to admit `ContentBlock[]` in addition to `string`. Wire shapes are in §4.2; rationale is in §7.
- No database migrations and no changes to persisted schemas.

### 2.3 Behavioral Overview

The agent's tool set contains both its sandbox-VFS built-ins and the host-side boundless tools after `session:configure` carries the four `boundless_*` tools plus any MCP-proxied tools. Tool names, tool descriptions, the `systemPromptAddition` string, and the provenance metadata block prefixed to every boundless-proxied `tool:result` identify which filesystem each tool acts on.

A single boundless process attaches to many threads over its lifetime. `boundless` (no args) creates a new thread and attaches to it. `/attach <otherId>` inside the TUI detaches from the current thread (releasing its lock) and attaches to another. `/clear` creates a new thread and transitions to it in place. Each attach acquires a fresh lockfile and each detach releases one. The process does not exit between attaches.

MCP servers are managed by boundless on demand. The `/mcp` command opens an in-TUI configuration view in which the user adds, removes, enables, or disables servers of any transport supported by the MCP spec (stdio, streamable HTTP, SSE). For stdio servers, boundless manages the subprocess lifecycle; for HTTP and SSE servers, boundless opens and holds a client connection. When a server is enabled, boundless performs the MCP handshake, enumerates its tools, adds them under the `boundless_mcp_<server>_<tool>` namespace, and re-sends `session:configure`. When a server is disabled, boundless tears down its client (terminating the subprocess for stdio, closing the connection for HTTP or SSE), strips its tools, and re-sends `session:configure`. Changes apply without reconnecting to bound.

Ctrl-C is the sole cancellation and exit affordance. The first Ctrl-C during an active turn calls `cancelThread(threadId)` via HTTP, ending the agent loop server-side and emitting `tool:cancel` for any in-flight `tool:call` for that thread; boundless aborts the affected handlers (primarily `boundless_bash`). A second Ctrl-C within a 2-second window exits the process gracefully; outside that window, a subsequent Ctrl-C is treated as a fresh first press. During an idle turn, the first Ctrl-C displays a transient hint ("press Ctrl-C again to exit") and a second press within 2 seconds exits.

Error surfacing depends on the origin of the failure. CLI-time errors during `boundless --attach <threadId>` exit the process with a non-zero code and a stderr message. The same failures surfaced by an in-TUI `/attach` render as an error banner and leave the current session untouched.

---

## 3. Requirements

### 3.1 Client Process and CLI

**R-BL1.** The system shall expose an interactive client binary, `boundless`, that connects to a bound server and attaches to exactly one thread at a time.

**R-BL2.** When invoked as `boundless` with no thread argument, the system shall, in order: load config, connect to bound via WebSocket, call `createThread()`, acquire the lockfile for the returned thread id, complete the attach flow (R-BL8), and launch the TUI. If any step fails, the process shall exit with a non-zero code and print a single-line error to stderr.

**R-BL3.** When invoked as `boundless --attach <threadId>`, the system shall, in order: load config, connect to bound, acquire the lockfile for `<threadId>`, call `getThread(threadId)` (exiting non-zero on 404), complete the attach flow, and launch the TUI. If the lockfile cannot be acquired, the process shall exit non-zero with the specific reason in the stderr message.

**R-BL4.** The `--url <url>` flag shall override the `url` field from `config.json` for the lifetime of the process. No environment variables are read in v1.

**R-BL4a.** The TUI shall recognize exactly four slash commands in v1, each of which takes no arguments beyond the ones specified:

| Command | Argument | Behavior |
|---|---|---|
| `/attach [<threadId>]` | optional | In-TUI attach transition per §5.6. If `<threadId>` is provided, attach directly to that thread. If omitted, open an in-TUI thread picker populated via `client.listThreads()`; the user's selection provides the `threadId`. Failure leaves the current session intact (R-BL23). |
| `/clear` | none | Create a new thread via `client.createThread()` and transition to it in-place (R-BL4b, §5.6a). Existing session intact on failure (R-BL23). |
| `/model [<name>]` | optional | Set model to `<name>` if provided; otherwise open an in-TUI picker (R-BL17). |
| `/mcp` | none | Open the in-TUI MCP configuration view (R-BL18). |

All other input lines not matching `^/[a-z]+(\s|$)` are treated as message content for the active thread. Cancellation and exit are handled via Ctrl-C (R-BL20) and shall not be exposed as slash commands.

**R-BL4b.** The `/clear` command shall create a new thread by calling `client.createThread()` and then execute the attach transition of §5.6 using the returned thread id as `<newId>`. On `createThread` failure, the current session is preserved (R-BL23) and the error surfaces as a TUI banner; no lock state is changed. The `config.model` selection (R-BL17) is preserved across `/clear`; the new thread inherits the current model choice.

### 3.2 Configuration

**R-BL5.** All boundless state shall live under `~/.bound/less/`. The system shall not read configuration from any other location. The directory tree shall be:
```
~/.bound/less/
  config.json
  mcp.json
  locks/<threadId>.json
  logs/application.log
  logs/<threadId>/<connectionId>.log
  logs/<threadId>/<connectionId>-<mcpServerName>.log
```

**R-BL6.** `config.json` shall contain camelCase JSON with fields:
- `url: string` — bound server URL. Default `http://localhost:3001` if missing or file absent.
- `model: string | null` — optional default model. Null means server chooses.

Unknown fields shall be preserved on write (forward compatibility with future schema additions).

**R-BL7.** `mcp.json` shall contain camelCase JSON mirroring bound's `mcpSchema` field set:
```ts
{
  servers: Array<
    | { name: string; allowTools?: string[]; confirm?: string[]; transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
    | { name: string; allowTools?: string[]; confirm?: string[]; transport: "http"; url: string; headers?: Record<string, string> }
  >
}
```
If the file is absent, the system shall treat it as `{ servers: [] }`.

### 3.3 Attach Flow

**R-BL8.** The system's attach flow, given a `threadId`, shall execute in order: (1) call `listMessages(threadId)` and render the returned history into the TUI scrollback, (2) send `thread:subscribe` over the WebSocket, (3) ensure every enabled MCP server has a live subprocess — spawn any missing ones, performing the MCP `initialize` handshake and redirecting each subprocess's stderr to its per-server log file, and call `tools/list` against each, (4) build the merged tool list (core four + enabled MCP-proxied tools) and verify R-BL28's uniqueness invariant, (5) send `session:configure` with that list and a `systemPromptAddition` string identifying the boundless-side cwd and MCP provenance. If step 3 fails for a given server, that server is marked as failed in the `/mcp` view and its tools are omitted from the merged list; the attach flow continues. If step 5's `session:configure` is refused by the server, boundless treats the attach as failed and surfaces the error per R-BL22 or R-BL23 depending on call site.

**R-BL9.** When an attach flow begins, the system shall mint a fresh client-side `connectionId` (UUID v4) scoped to the current WebSocket connection and use it in per-thread log file paths. On reconnect, a new `connectionId` is minted and a new per-connection log file is opened. This `connectionId` is a boundless-side identifier used only for log file naming; it is not sent to the bound server and is distinct from the server's own per-WebSocket-connection handle (referred to below as "the server-side connection" where disambiguation matters).

### 3.4 Lockfile Protocol

**R-BL10.** Before completing any attach flow, the system shall atomically acquire `~/.bound/less/locks/<threadId>.json`. The file contents shall be `{ cwd: string, pid: number, attachedAt: string (ISO-8601) }`. Acquisition uses `fs.writeFileSync(path, data, { flag: "wx" })`.

**R-BL11.** When an attach request finds an existing lockfile, the system shall inspect it:
- If `pid` is not alive (determined by `process.kill(pid, 0)` returning ESRCH), the lockfile is stale and the system shall clear it and proceed.
- If `pid` is alive and `cwd` equals the current process's cwd, the system shall refuse the attach with the error `"thread <threadId> is already attached from this directory by pid <pid>"`.
- If `pid` is alive and `cwd` differs from the current process's cwd, the system shall refuse the attach with the error `"thread <threadId> is attached from <existingCwd> by pid <pid>; you are in <currentCwd>"`.

**R-BL12.** When a boundless process detaches from a thread (via `/attach <otherId>`, double Ctrl-C exit per R-BL20, SIGTERM), the system shall delete the thread's lockfile after terminating any MCP subprocesses it spawned (R-BL33). Ungraceful termination (SIGKILL, crash) leaves stale lockfiles, which subsequent attach attempts resolve via R-BL11's liveness check.

### 3.5 Tool Registration and Namespacing

**R-BL13.** The four core tools shall be registered with the names `boundless_read`, `boundless_write`, `boundless_edit`, `boundless_bash`. Their schemas match the semantics of Pi's read/write/edit/bash tools (line-range reads, hash-validated edits, cwd-scoped bash). Descriptions shall include the literal current cwd.

**R-BL14.** MCP-proxied tools shall be registered with names `boundless_mcp_<serverName>_<toolName>`, where `<serverName>` is the MCP server's configured `name` field and `<toolName>` is the MCP tool's own name. If this derivation produces a name already present in the merged tool list, the system shall refuse to register the colliding MCP server and surface the error in the `/mcp` view. Collision with the core four is impossible by prefix construction (`boundless_mcp_` vs. `boundless_<verb>`).

**R-BL15.** The `systemPromptAddition` sent on `session:configure` shall include (a) a line naming the boundless cwd and hostname (`host=<hostname> cwd=<cwd>`), (b) a summary of the boundless tool namespace (prefixed with `boundless_`, distinct from sandbox-VFS built-ins), and (c) a line per enabled MCP server naming the `boundless_mcp_<name>_*` subset.

### 3.6 Tool Result Provenance

**R-BL16.** When boundless sends a `tool:result` for a tool it handled locally, `content` shall be a `ContentBlock[]` whose first element is a text block containing a provenance metadata line.

For core-four tools:
```
[boundless] host=<hostname> cwd=<cwd> tool=<toolName>
```

For MCP-proxied tools:
```
[boundless] host=<hostname> mcpServer=<serverName> tool=<originalMcpToolName>
```

Subsequent elements are the tool's actual output blocks (for core-four tools: a single text block; for MCP tools: whatever the MCP server returned, passed through unmodified).

### 3.7 Hot-Reload

**R-BL17.** The `/model` command shall accept an optional `<name>` argument. If provided, the model is set to `<name>` immediately. If omitted, the TUI shall render a selectable list of known models (populated from bound's model registry via the existing client API) and the user's choice is applied. Subsequent `sendMessage` calls shall use the new model; no reconnection is required. The new value is persisted to `config.json`. The client does not pre-validate `<name>` against the server's model registry when supplied via argument form; an unknown model surfaces as a server error on the next `sendMessage` and is rendered as an inline error. `config.model` on disk is not modified until a valid selection succeeds.

**R-BL18.** The `/mcp` command shall accept no arguments and open an in-TUI configuration view listing every server in `mcp.json` with status (enabled/disabled, running/failed/not-spawned). The view shall support add, remove, enable, and disable actions. When the user applies a change, the system shall (a) spawn or terminate subprocesses as needed, (b) re-enumerate tools from the resulting set of live MCP connections, (c) rebuild the merged tool list, (d) send a fresh `session:configure` containing the new list. The new state is persisted to `mcp.json`. No reconnection to bound is required.

**R-BL19.** When the user changes `url` in the config view, the system shall accept the change, persist it to `config.json`, and display a non-dismissable notice indicating a restart is required. The WebSocket connection is not altered.

### 3.8 Cancellation

**R-BL20.** The system shall bind Ctrl-C as the combined cancel/exit key with double-press-to-exit semantics:

- **Active turn, first Ctrl-C within 2s of the last:** no-op on the exit counter, but if this is the first Ctrl-C since the turn began, the system shall call `cancelThread(threadId)` via HTTP exactly once. Pending in-flight tool calls for that thread shall receive `tool:cancel` messages (R-BL24) from the server, triggering local abort per R-BL21.
- **Active turn, second Ctrl-C within 2s:** the system shall initiate graceful exit (detach, terminate MCP subprocesses per R-BL33, release lockfile, exit 0).
- **Idle turn, first Ctrl-C:** the system shall render a transient TUI hint ("press Ctrl-C again to exit") and start a 2-second timer.
- **Idle turn, second Ctrl-C within 2s:** graceful exit.
- **Any Ctrl-C outside the 2-second window of the prior press:** treated as a fresh first press (hint shown if idle; cancelThread invoked if active and not already canceled in this turn).
- **Modal picker or in-TUI view open (`/mcp` view, `/model` picker, `/attach` picker):** the first Ctrl-C shall be consumed by the open modal as a dismiss/cancel signal (equivalent to Escape), leaving the prior turn state untouched. It shall not count toward the exit counter and shall not invoke `cancelThread`. A second Ctrl-C after the modal closes behaves per the turn state at that moment (active or idle).
- **Attach transition in flight (§5.6 steps 0–5 or §5.6a steps 0–3 running):** Ctrl-C during the tool-call drain window (step 0) is deferred until the 500ms deadline elapses or the abort signals settle, whichever comes first; the transition completes its release-and-reacquire sequence before Ctrl-C is processed. Once the transition reaches a terminal state (new thread attached, rollback completed, or degraded-recovery banner shown), normal Ctrl-C handling resumes.

The system shall not expose `/cancel` or `/quit` as slash commands; Ctrl-C is the sole cancel-and-exit affordance.

**R-BL21.** Every local tool handler shall accept an `AbortSignal`. When a `tool:cancel` message arrives with a matching `callId`, the system shall signal abort to the handler. If the handler completes before honoring the abort, its `tool:result` is sent normally; if it honors the abort, the system shall send a `tool:result` with `isError: true` and a text content block explaining the cancellation.

### 3.9 Error Surfacing

**R-BL22.** Failures during `boundless` or `boundless --attach` startup shall write a single-line message to stderr and exit with code 1. No TUI is launched.

**R-BL23.** Failures during in-TUI `/attach [<threadId>]` or `/clear` shall render as an error banner in the TUI. The current attached session shall remain intact and active whenever rollback succeeds: the old lockfile is re-acquired, the old subscription is re-established, and the tool list is not modified. An exception applies when another process acquires the old thread's lockfile in the window between release and rollback attempt; in that case §5.6 governs the degraded-recovery path, and the user recovers via Ctrl-C × 2 (R-BL20). For `/clear` specifically, a newly-created thread whose lock cannot be acquired is treated as any other attach failure: rollback to the prior thread, banner surfaced.

### 3.10 Protocol Extensions

**R-BL24.** The WebSocket protocol shall gain a `tool:cancel` message, emitted server→client:
```ts
{ type: "tool:cancel", callId: string, threadId: string, reason?: "thread_canceled" | "dispatch_expired" | "session_reset" }
```
The server shall emit `tool:cancel` for every dispatch_queue entry it retires without a matching `tool:result`: when `cancelThread(threadId)` is invoked while entries for that thread remain outstanding, when a dispatch_queue TTL expires, or when the server invalidates the session epoch (e.g., the server-side connection's tool registry is force-reset or the connection terminates without graceful detach). On TTL expiry or session reset, the server shall synthesize a tool-error `LLMMessage` (`content = "Tool call ${callId} canceled: ${reason}.", isError = true`) for the canceled `callId` so that the agent loop observes a terminal state per tool_use. Clients that do not handle `tool:cancel` shall drop the message; the server does not require acknowledgement, and the synthesized error message is emitted independently of client participation. An ordinary re-`session:configure` (as used by MCP hot-reload in R-BL18) does not constitute a session reset: `handleSessionConfigure` clears and replaces `conn.clientTools` while preserving pending dispatch_queue entries, which are re-delivered to the same connection and do not trigger `tool:cancel`.

**R-BL25.** The `session:configure` message shall accept an optional `systemPromptAddition: string` field. The server shall store the string against the `(server-side-connection, threadId)` pair for every thread currently subscribed by that server-side connection at the time of the `session:configure` message, and shall append it to the system prompt on every LLM call executed for one of those pairs. `thread:subscribe` messages that arrive after `session:configure` inherit the most recent `systemPromptAddition` stored for the server-side connection; `thread:unsubscribe` clears that pair's entry. Re-sending `session:configure` (with or without the field) replaces the stored string for every currently-subscribed pair under the server-side connection; omitting the field clears it. Per-pair scoping allows a single server-side connection to carry distinct additions across threads serving different roles (e.g., a coding-agent thread and a chat thread). The pair key uses the server's own WebSocket connection handle, not the client-minted `connectionId` from R-BL9, which the server never sees.

**R-BL26.** The `tool:result.content` field shall accept `string | ContentBlock[]`. A string is persisted as a single text block. A `ContentBlock[]` is persisted verbatim to the corresponding `LLMMessage.content`. The admitted `ContentBlock` variants are exactly those already defined by `packages/llm/src/types.ts` (text, image, document); any other block shape is rejected by the server with a tool-error response to that `callId`.

**R-BL31.** When the server receives a `tool:result` for a `callId` for which it has already emitted `tool:cancel` (any reason), the server shall accept the message but discard it — no `LLMMessage` is persisted for the canceled call. The agent loop has already observed the synthesized error from R-BL24 and does not rewrite that outcome on late arrival.

**R-BL32.** When the client receives a `tool:cancel` for a `callId` it does not recognize (late arrival after local completion, duplicate, or cross-reconnect), it shall drop the message silently. No log line is required beyond DEBUG level.

**R-BL33.** On graceful boundless exit (double Ctrl-C per R-BL20 or SIGTERM), the system shall terminate every spawned MCP subprocess before releasing the lockfile, sending SIGTERM followed by SIGKILL after a two-second grace period. On SIGKILL of boundless itself, MCP subprocesses inherit orphan status and are reaped by PID 1.

**R-BL34.** When an in-flight tool call's originating context becomes invalid — specifically (a) the WebSocket disconnects while a local handler is running, (b) the user issues `/attach` to a different thread while handlers for the old thread are running, or (c) an MCP server is disabled through `/mcp` while a proxied tool call against it is in flight — the system shall signal abort to the affected handlers (via the same `AbortSignal` mechanism as R-BL21). On (a) WebSocket disconnect, no `tool:result` is sent for the aborted calls; on reconnect the server re-delivers the original `tool:call` via dispatch_queue and a fresh handler invocation runs (R-BL21 governs its lifecycle). On (b) and (c), if the connection is still live, boundless sends a `tool:result` with `isError: true` and an explanatory text block before discarding the handler state; the server treats this as an ordinary error result for the `callId`.

**R-BL35.** When the TUI receives duplicate MCP server configurations (two entries in `mcp.json` with the same `name` field), the second and subsequent entries shall be rejected at load time with a `/mcp`-view error naming the conflict. Server-name uniqueness is the precondition for R-BL14's tool-name derivation being injective and for the per-server log file path being unambiguous.

**R-BL36.** When rendering message history from `listMessages` in R-BL8 step 1, boundless shall detect assistant messages whose tool-use blocks lack a corresponding tool-result message in the returned history. These correspond to tool calls that were dispatched but not yet completed before the previous client disconnected. Boundless shall render them as "[pending tool call — will be re-delivered]" placeholders and expect the server to re-issue the corresponding `tool:call` via dispatch_queue re-delivery after `thread:subscribe` (R-BL8 step 2) completes. The placeholder is replaced in scrollback once the `tool:result` is eventually sent.

### 3.11 Unwanted Behavior

**R-BL27.** The system shall not read or write configuration outside `~/.bound/less/` in v1.

**R-BL28.** The system shall not accept a tool name collision at `session:configure` time. If the merged tool list contains duplicates, `session:configure` shall not be sent; the offending MCP server configuration shall be rejected and surfaced as a `/mcp` error.

**R-BL29.** The system shall not hold a thread's lockfile across attach transitions beyond the rollback window in §5.6. The old lock is released before the new lock is acquired, permitting rapid thread switches without stranded locks. The resulting narrow race is addressed by R-BL23 and the degraded-recovery path in §5.6.

**R-BL30.** The server shall not interpret `systemPromptAddition` content, `tool:result.content` block structure, or tool names beyond uniqueness. Application-specific semantics live entirely in the client.

---

## 4. Data Model Changes

### 4.1 On-Disk State (`~/.bound/less/`)

**`config.json`** — Created on first write. Absent-file behavior: treated as `{}` with defaults applied.
```json
{
  "url": "http://localhost:3001",
  "model": null
}
```

**`mcp.json`** — Created on first MCP server add. Absent-file behavior: `{ "servers": [] }`.
```json
{
  "servers": [
    {
      "name": "rust-analyzer",
      "transport": "stdio",
      "command": "rust-analyzer-mcp",
      "args": ["--stdio"],
      "env": {},
      "allowTools": ["hover", "definition"],
      "confirm": []
    }
  ]
}
```

**`locks/<threadId>.json`** — Acquired at attach, deleted at detach. Contents:
```json
{
  "cwd": "/home/kara/proj",
  "pid": 12345,
  "attachedAt": "2026-04-17T22:00:00.000Z"
}
```
Acquisition uses `O_EXCL` semantics via `fs.writeFileSync(path, data, { flag: "wx" })`; a failure to create indicates an existing lockfile, triggering the liveness-check path in R-BL11.

**`logs/application.log`** — Append-only, concurrent-write tolerant (POSIX `O_APPEND` guarantees atomicity for writes ≤ `PIPE_BUF`; lines are kept under 4KB). Level: INFO and above. Format: JSON lines.
```
{"ts":"2026-04-17T22:00:00.000Z","level":"info","pid":12345,"event":"attach","threadId":"...","cwd":"..."}
```

**`logs/<threadId>/<connectionId>.log`** — Per-attach detailed log. Level: DEBUG and above. JSON lines. Records `tool:call` receipt, `tool:result` send, MCP subprocess lifecycle, `message:created`, state transitions.

**`logs/<threadId>/<connectionId>-<mcpServerName>.log`** — Raw stderr of the named MCP subprocess. Unbuffered, unparsed, append-only.

### 4.2 Protocol Changes

#### 4.2.1 `session:configure` — add `systemPromptAddition`

Before:
```ts
type SessionConfigureMessage = {
  type: "session:configure";
  tools: ToolDefinition[];
};
```
After:
```ts
type SessionConfigureMessage = {
  type: "session:configure";
  tools: ToolDefinition[];
  systemPromptAddition?: string;
};
```

Server behavior: the string is stored per-`(server-side-connection, threadId)` pair for every thread the server-side connection is subscribed to at the time of the `session:configure` message (see R-BL25). During LLM request assembly for a given `(server-side-connection, threadId)` pair, the server appends the pair's stored `systemPromptAddition` to the system prompt as a final block. `thread:subscribe` messages received after `session:configure` inherit the most recent string stored for the server-side connection; `thread:unsubscribe` clears the pair. Re-sending `session:configure` replaces the stored string for every currently-subscribed pair; omitting the field on resend clears it. The server-side connection is identified by the server's own WebSocket handle; the client-side `connectionId` from R-BL9 is never sent on the wire and plays no part in this scoping.

#### 4.2.2 `tool:result` — widen `content`

Before:
```ts
type ToolCallResult = {
  callId: string;
  threadId: string;
  content: string;
  isError?: boolean;
};
```
After:
```ts
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource; description?: string }
  | { type: "document"; source: ImageSource; textRepresentation: string; title?: string };

type ToolCallResult = {
  callId: string;
  threadId: string;
  content: string | ContentBlock[];
  isError?: boolean;
};
```

Server behavior: a `string` is persisted as a single text block. A `ContentBlock[]` is persisted verbatim to `LLMMessage.content`. The admitted `ContentBlock` variants are those defined by `packages/llm/src/types.ts` (`text`, `image`, `document`); `ImageSource` is the existing discriminated union declared there (`{ type: "base64"; mediaType: string; data: string }` | `{ type: "url"; url: string }`). Any other block shape is rejected by the server with a tool-error response to the call. Server and client changes ship together; servers predating the widening cannot accept `ContentBlock[]`-sending clients, but the inverse (new server, old string-only client) is supported.

#### 4.2.3 New `tool:cancel` message (server→client)

```ts
type ToolCancelMessage = {
  type: "tool:cancel";
  callId: string;
  threadId: string;
  reason?: "thread_canceled" | "dispatch_expired" | "session_reset";
};
```

Server emits this when:
- `cancelThread(threadId)` is called and the server has in-flight `tool:call` dispatches for that thread (reason: `thread_canceled`).
- A `dispatch_queue` entry exceeds its TTL (reason: `dispatch_expired`).
- A connection's session is reset while holding pending tool calls (reason: `session_reset`).

For reasons `dispatch_expired` and `session_reset`, where no external operator triggered the cancellation and the agent loop would otherwise stall waiting on the tool, the server shall synthesize a tool-error `LLMMessage` (`role: "tool", content: "Tool call ${callId} canceled: ${reason}.", isError: true`) bound to the canceled `callId` so that the agent loop sees a terminal outcome and proceeds. For `thread_canceled`, the agent loop has already been interrupted by `cancelThread` and no synthesized message is emitted.

Client-side handling is described by R-BL32: unrecognized `callId`s are dropped silently. Unknown `reason` values shall be treated as `thread_canceled` by clients.

Client behavior: on receipt, signal abort to the handler for `callId`. If the handler was already running, abort is best-effort; if not yet invoked, the client may skip invocation entirely. The server treats absent `tool:result` after `tool:cancel` as acceptable.

---

## 5. Behavioral Descriptions

### 5.1 Startup (no `--attach`)

Invoked as `$ boundless` in `/home/kara/proj`. Boundless loads `~/.bound/less/config.json` (absent → defaults: `url=http://localhost:3001`, `model=null`) and `~/.bound/less/mcp.json` (absent → empty servers list). It opens a WebSocket to the configured URL. On connection failure, it prints `boundless: cannot reach bound at http://localhost:3001: ECONNREFUSED` to stderr and exits 1 (R-BL22).

It calls `client.createThread()` via HTTP and receives `{ id: "t_abc123", ... }`, then attempts to acquire `~/.bound/less/locks/t_abc123.json` via `fs.writeFileSync(..., { flag: "wx" })`. Because the thread is newly created, no lockfile exists and the write succeeds. The file contains `{ cwd: "/home/kara/proj", pid: 12345, attachedAt: "2026-04-17T22:00:00.000Z" }`.

The attach flow (§5.3) runs. The TUI launches, showing an empty conversation with a header indicating the thread id and attached cwd. The user types `list the files in src/` and submits. Boundless calls `client.sendMessage("t_abc123", "list the files in src/")`. Subsequent `message:created` events and `tool:call` events arrive; the latter carries `toolName: "boundless_bash"` with arguments `{ command: "ls src/" }`. The `boundless_bash` handler spawns the command in cwd `/home/kara/proj`, captures stdout and stderr, and sends a `tool:result` with `content` as a `ContentBlock[]` whose first block is `[boundless] host=kara-laptop cwd=/home/kara/proj tool=boundless_bash` and whose second block contains the `ls` output.

On graceful exit (Ctrl-C × 2 per R-BL20, SIGTERM), the lockfile is deleted after MCP subprocesses are terminated. On crash or SIGKILL, the lockfile is left behind; the next attach attempt observes the dead pid and clears it (R-BL11).

### 5.2 Startup with `--attach`

Invoked as `$ boundless --attach t_abc123` in `/home/kara/proj`. Boundless loads config, opens the WebSocket, and attempts to acquire `~/.bound/less/locks/t_abc123.json`.

**Case A — no existing lockfile.** Write succeeds. Boundless calls `getThread("t_abc123")`. If the server returns 404, boundless prints `boundless: thread t_abc123 not found` and exits 1 (after deleting the just-acquired lockfile). Otherwise attach flow runs.

**Case B — existing lockfile, dead pid.** `process.kill(existing.pid, 0)` raises `ESRCH`. Boundless logs a `stale_lock_cleared` event to `application.log`, deletes the lockfile, retries acquisition. Proceeds as Case A.

**Case C — existing lockfile, live pid, same cwd.** `process.kill` succeeds, `existing.cwd === "/home/kara/proj"`. Boundless prints `boundless: thread t_abc123 is already attached from this directory by pid 9876` and exits 1.

**Case D — existing lockfile, live pid, different cwd.** `process.kill` succeeds, `existing.cwd === "/home/kara/other-proj"`. Boundless prints `boundless: thread t_abc123 is attached from /home/kara/other-proj by pid 9876; you are in /home/kara/proj` and exits 1.

### 5.3 Attach Flow (shared)

Given a validated `threadId` and an acquired lockfile, the flow is:

1. `client.listMessages(threadId)` returns the full message history. Boundless renders each message into the TUI's scrollback buffer in chronological order. Files referenced as message attachments are rendered as placeholder lines (`[file: <name>, <n> bytes]`) without fetching content. Assistant tool-use blocks whose corresponding tool-result messages are absent from the returned history are rendered per R-BL36.
2. Boundless sends `thread:subscribe` via the WebSocket. Further `message:created`, `thread:status`, and `tool:call` events for this thread route to boundless.
3. Boundless ensures every enabled MCP server has a live subprocess. Any missing ones are spawned (stderr redirected to the per-server log file) and walked through the MCP `initialize` + `tools/list` handshake. If a particular server's subprocess fails to spawn or handshake, the server is marked failed in the `/mcp` view and its tools are omitted from the merged list; other servers still contribute.
4. Boundless builds the merged tool list: the four core tools plus every tool enumerated from live MCP servers. Tool names are derived per R-BL14; collisions are caught per R-BL28.
5. Boundless builds the `systemPromptAddition` string per R-BL15 and sends `session:configure` with the merged tool list and the addition. If the server rejects the configure (e.g., validation failure), boundless surfaces the error per the call site's error policy (R-BL22 for startup, R-BL23 for in-TUI).
6. TUI renders the main prompt.

### 5.4 Sending a Message

User input is submitted. Boundless calls `client.sendMessage(threadId, content, { modelId: config.model ?? undefined })`; the call is dispatched over the WebSocket without awaiting a reply. The TUI enters an "awaiting response" state.

As events arrive:
- `message:created` with role `assistant` → append to scrollback, stream tokens into the latest message bubble.
- `tool:call` with a name in the boundless namespace → dispatch to the local handler in a non-blocking manner. The handler registers an `AbortSignal` keyed by `callId`. On completion or abort, a `tool:result` is sent.
- `thread:status` with `active: false` → turn complete, TUI returns to idle.

### 5.5 Cancellation and Exit

Ctrl-C serves as both the cancel-current-turn key and the exit key, with double-press-to-exit semantics (R-BL20). The state machine has two modes (turn-active and turn-idle) and tracks the timestamp of the last Ctrl-C press.

**Scenario A — cancel during a long-running tool.** The user has sent `please run the full test suite` and `boundless_bash` is executing `pnpm test` in a subprocess. The user presses Ctrl-C. Boundless observes: turn active, first press of this turn. It calls `client.cancelThread(threadId)` via HTTP. The server ends the agent loop, marks `dispatch_queue` entries for this thread as canceled, and emits one `tool:cancel` per in-flight `callId`. Boundless receives each `{ type: "tool:cancel", callId, threadId, reason: "thread_canceled" }` and calls `abort()` on the matching `AbortSignal`. The `pnpm test` subprocess receives SIGTERM and, after a 2-second grace period, SIGKILL. The aborted handler sends a `tool:result` with `isError: true` and a text block `"Canceled by user."`. The TUI renders a "Canceled" banner and returns to idle. The Ctrl-C timestamp is recorded.

**Scenario B — exit via double Ctrl-C during an active turn.** Continuing from Scenario A: within 2 seconds of the first press, the user presses Ctrl-C again. Boundless observes: second press within 2 seconds. Graceful exit begins. It terminates any remaining MCP subprocesses (SIGTERM, then SIGKILL after 2 seconds), releases the lockfile, closes the WebSocket, and exits 0. The second press does not trigger a second `cancelThread`; cancellation is idempotent per turn.

**Scenario C — exit via double Ctrl-C during an idle turn.** Turn is idle. The user presses Ctrl-C. Boundless renders a transient hint line ("press Ctrl-C again to exit") below the prompt and starts a 2-second timer. The user presses Ctrl-C again within 2 seconds. Graceful exit proceeds as in Scenario B. If the user does not press again within 2 seconds, the hint fades and the next Ctrl-C is treated as a fresh first press.

**Scenario D — Ctrl-C after a turn completes normally.** The user sends a message, the turn completes, output is rendered, and the turn is idle. The user presses Ctrl-C with nothing active to cancel. The idle-turn path applies: the hint is shown and a 2-second window opens. An accidental single Ctrl-C does not exit the process.

**Scenario E — Ctrl-C outside the 2-second window.** The user presses Ctrl-C during an idle turn, waits 5 seconds, and presses Ctrl-C again. Each press is treated independently; each shows the hint and opens a new 2-second window. Only two presses within a single 2-second window trigger exit.

**Interaction with `tool:cancel` reason variants.** R-BL20 invokes `cancelThread` only on the first Ctrl-C of a turn while active. `tool:cancel` messages carrying `dispatch_expired` or `session_reset` are handled by R-BL31's server-error surfacing path independently of Ctrl-C, and do not reset the Ctrl-C-since-turn-started flag.

### 5.6 In-TUI `/attach`

User issues `/attach t_xyz789` from within an active TUI session attached to `t_abc123`. Boundless:

0. **Tool-call drain.** If any boundless-registered tool call for `t_abc123` is in flight, boundless signals abort on each handler per R-BL34(b) and waits up to a short deadline (500ms) for handlers to finalize their `tool:result` sends; handlers that do not finalize by the deadline have their result discarded and the server observes them as `dispatch_expired` at TTL. The `/attach` command proceeds regardless of whether all finalizations complete; the transition does not block on slow handlers. (This drain is a local in-TUI operation on pending client-tool handlers; it is unrelated to bound's scheduler-wide quiescence system, which is addressed in §6.6.)
1. Calls `client.unsubscribe("t_abc123")`.
2. Deletes `~/.bound/less/locks/t_abc123.json`.
3. Attempts to acquire `~/.bound/less/locks/t_xyz789.json` (same conflict matrix as §5.2). **If acquisition fails**, boundless attempts to re-subscribe to `t_abc123` and re-acquire its lockfile; if re-acquisition also fails (another process acquired the lock in the window between release and retry, or the lockfile directory became unwritable), boundless writes a fatal error to `application.log`, renders a persistent banner reading "detached from t_abc123 and unable to re-attach — press Ctrl-C twice to exit boundless", and transitions the TUI to a read-only state: `message:send` is disabled, tool handlers are unregistered, and existing scrollback remains scrollable; Ctrl-C × 2 (R-BL20) exits. This is the only in-TUI failure mode that compromises the active session. The precondition is narrow: another process must acquire the lockfile in the sub-millisecond window between release and retry.
4. If acquisition succeeds, calls `client.getThread("t_xyz789")`. On 404, same error-banner path as step 3 (lock released, old thread re-acquired, with the same fatal fallback if re-acquisition fails).
5. On success, calls `client.listMessages("t_xyz789")`, clears the scrollback, and renders the new thread's history (applying R-BL36's placeholder rule for any tool-use blocks without matching results). If `listMessages` fails (network error, 5xx), the new lockfile is released and rollback to `t_abc123` runs with the same failure and fallback semantics as step 4. `session:configure` does not re-run unless MCP state changed: the tool set is session-scoped, not thread-scoped. `systemPromptAddition` is not re-sent because per R-BL25's inheritance rule the new `thread:subscribe` for `t_xyz789` inherits the most recent addition stored for the server-side connection, and the cwd line is unchanged across attaches within a single boundless process.

### 5.6a In-TUI `/clear`

User issues `/clear` from within an active TUI session attached to `t_abc123`. Boundless:

0. **Tool-call drain** — identical to §5.6 step 0: signal abort on in-flight boundless-registered tool calls, wait up to 500ms for finalization, proceed regardless.
1. Calls `client.createThread()`. On network error, boundless renders an error banner, leaves the current attachment untouched (no lock released, no subscription canceled), and returns per R-BL23.
2. The server returns `{ id: "t_new456" }`. Boundless continues as if the user had typed `/attach t_new456`: steps 1–5 of §5.6 run unchanged. The one textual difference is scrollback treatment: `/clear` empties scrollback before `listMessages` runs (which returns an empty message list for a fresh thread), so the prior thread's history does not flash during the transition.
3. On `/attach`-phase failure (e.g., `fs.writeFileSync` for the new lockfile fails due to a disk-full `~/.bound/less/locks/`), the rollback path re-subscribes to `t_abc123` and re-acquires its lockfile. The degraded-recovery path of §5.6 step 3 applies if rollback itself fails. `t_new456` was created on the server but never attached to. Bound does not currently auto-GC unattached threads, so this thread persists in the `threads` table as an empty-history row until the user deletes it or a future RFC adds thread retention. The accepted cost is a handful of empty threads per failed `/clear` attempt. Tracked in §6.7.
4. Model selection from `config.model` is preserved; subsequent `sendMessage` calls use the same model as before `/clear`, consistent with R-BL4b.

### 5.7 Adding an MCP Server Through `/mcp`

The user opens `/mcp`, navigates to the add-server affordance, fills in a server definition (e.g., `{ name: "rust-analyzer", transport: "stdio", command: "rust-analyzer-mcp" }`), and confirms. Boundless:

1. Instantiates the MCP client for the declared transport. For stdio transports it spawns the subprocess with stderr redirected to the per-server log; for streamable-HTTP or SSE transports it opens a client against the configured URL.
2. Performs the MCP initialization handshake.
3. Calls `tools/list` on the server. The response is (for example) `[{ name: "hover", ... }, { name: "definition", ... }]`.
4. Derives boundless-side names: `boundless_mcp_rust-analyzer_hover`, `boundless_mcp_rust-analyzer_definition`. Verifies that neither collides with an existing tool.
5. Persists the new server entry to `mcp.json`.
6. Rebuilds the merged tool list (core four + existing MCP tools + new MCP tools).
7. Sends `session:configure` with the new list. The server clears `conn.clientTools` and replaces it, then re-delivers any pending tool calls.
8. The TUI closes the `/mcp` view and shows a toast: `MCP server "rust-analyzer" added (2 tools)`.

If step 2, 3, or 4 fails, the MCP client is torn down (subprocess terminated for stdio, connection closed for HTTP or SSE), no persistence occurs, and the TUI shows the specific error.

### 5.8 Log Lifecycle

`application.log` is opened at process start with `O_APPEND`. Each line's `pid` identifies which boundless process wrote it; this disambiguates concurrent processes (one in `/proj-a`, another in `/proj-b`).

`logs/<threadId>/<connectionId>.log` is opened at attach and closed at detach. If the WebSocket reconnects mid-session, a new `connectionId` is minted and a new log file opened; the old file is closed. The TUI does not pause during reconnect.

`logs/<threadId>/<connectionId>-<mcpServerName>.log` is opened when the MCP subprocess is spawned and closed when it terminates. Auto-restarting MCP servers produce a new stderr log file per spawn.

No rotation in v1. Files grow unbounded. Operators who wish to cap log directory size can add a logrotate rule targeting `~/.bound/less/logs/**/*.log`.

---

## 6. Interaction with Existing Specifications

### 6.1 Client-Tool WebSocket Protocol

The protocol originally documented in `docs/design-plans/2026-04-16-ws-client-tools.md` gains three additive items. All three are backward compatible — clients and servers that do not use the new features behave identically.

- **`systemPromptAddition` on `session:configure`.** Optional field. Server stores the string per `(server-side-connection, threadId)` pair for every thread currently subscribed by that server-side connection at the time of the message, and appends it to the system prompt during LLM request assembly for those pairs. `thread:subscribe` after `session:configure` inherits the most recent string stored for the server-side connection; `thread:unsubscribe` clears the pair. Re-sending `session:configure` replaces the stored string for every currently-subscribed pair; omitting the field on resend clears it. See R-BL25 and §4.2.1 for the authoritative statement.
- **`tool:cancel` message (server→client).** New type. Emitted on thread cancellation, dispatch_queue TTL expiry, or session reset with pending tool calls.
- **`tool:result.content` widened to `string | ContentBlock[]`.** Server accepts both; a string is promoted to `[{ type: "text", text: content }]` when written to `LLMMessage.content`.

These amendments should be captured in a short PR to the protocol design plan. Server and client changes ship together; boundless consumes all three from initial release.

`session:configure` is already re-callable within the same connection (`handleSessionConfigure` in `packages/web/src/server/websocket.ts` clears and replaces `conn.clientTools` on every call, and re-delivers pending tool calls). Hot-reload of MCP servers (R-BL18) relies on that property; no protocol change is needed.

### 6.2 `packages/shared/src/config-schemas.ts` (bound's `mcpSchema`)

bound's existing `mcpSchema` (field set: `name`, `allow_tools`, `confirm`, `transport`, `command`, `args`, `env`, `url`, `headers`) is the reference for boundless's `mcp.json`. Boundless camelCases all field names for consistency with its own JSON convention, producing a schema whose semantics mirror bound's exactly but whose field names differ in casing (`allowTools` vs `allow_tools`, etc.). This RFC does not propose changes to bound's existing `mcpSchema`. If the MCP protocol finalizes a canonical `mcp.json` spec (modelcontextprotocol/modelcontextprotocol#292), both bound and boundless should migrate together to that canonical form in a separate RFC.

### 6.3 `packages/agent/src/built-in-tools.ts`

The server's built-in `read`, `write`, `edit` operate on the agent's sandbox VFS. This RFC does not modify those tools. The boundless `boundless_*` tools are additive and orthogonal. The only interaction point is the agent's prompt, which this RFC augments via `systemPromptAddition` to make the "two filesystems" distinction clear.

### 6.4 `@bound/cli`

Unchanged. `@bound/cli` has no interaction with boundless. Users invoke `bound` for administrative operations and `boundless` for coding-agent sessions.

### 6.5 `@bound/web`

Unchanged. Web and boundless can be attached to the same thread concurrently. Both receive `message:created` events; each attaches its own tool list scoped to its own WebSocket connection. Tool-call dispatches route to the connection that provided a matching tool name, so `boundless_read` dispatches land on the boundless client and any web-side tools land on the web client.

### 6.6 Bound's Quiescence System

Bound's scheduler throttles its poll cadence and heartbeat rescheduling based on `lastUserInteractionAt`, a scheduler-wide timestamp advanced in response to every `message:created` event on the server's internal event bus (`packages/agent/src/scheduler.ts`, subscribed via `onUserInteraction()`). `message:created` is emitted at exactly two call sites in `packages/web/src/server/websocket.ts`: `handleMessageSend` (when a client sends a `message:send` frame) and `handleToolResult` (when a client sends a `tool:result` frame). The agent loop's own assistant and tool_use message writes use `insertRow` directly and do not emit the event.

This RFC introduces no new quiescence semantics. Boundless interacts with the scheduler exclusively through the existing `message:send` and `tool:result` WebSocket frames, so its effect on `lastUserInteractionAt` is identical to the web client's. Three consequences follow and are called out here so that future readers do not treat them as surprises:

- **Boundless-originated user messages advance quiescence.** A `message:send` from boundless fires `handleMessageSend` just like a web-UI message does; `lastUserInteractionAt` resets and the scheduler collapses to its active tier. This is the intended and correct behavior.
- **`lastUserInteractionAt` is scheduler-wide, not per-thread.** A user typing in one boundless session on thread A accelerates scheduled tasks and heartbeats across every thread in the cluster. This is pre-existing bound behavior; boundless does not change it. Worth stating explicitly because the attachment model invites the intuition that quiescence is thread-scoped, and it is not.
- **Long-running boundless tool calls permit mid-turn quiescence drift.** A tool call that runs for minutes (e.g., `boundless_bash pnpm test`) produces no `message:created` events during execution, so the scheduler may tier down into a slower polling multiplier before the tool returns. When the client sends `tool:result`, `handleToolResult` fires `message:created` and quiescence snaps back to active on the next poll. The observable effect is bounded to at most one scheduler tick at a slower multiplier (poll interval is measured in seconds) and is harmless; the tool's dispatch TTL is governed separately by the existing client-tool protocol and does not depend on quiescence.

Idle-attached and detached cases introduce no new signals: subscription state is not tracked by the scheduler, so a boundless process parked attached with no traffic contributes nothing to quiescence, and a graceful detach (WebSocket close after lockfile release) is invisible to the scheduler. Quiescence continues to decay naturally from the last genuine `message:created` regardless of boundless lifecycle events.

### 6.7 Accepted Gaps

- **Multi-machine boundless against one thread.** Two boundless processes on different hosts can both attach to thread T; lockfiles are per-host filesystem and do not coordinate across machines. The `systemPromptAddition` includes `host=`, so the agent observes both hosts. Cross-host coordination is deferred pending evidence of multi-workstation use cases.
- **Web client and boundless with same-named tools.** The base protocol scopes registered tools per WebSocket connection (`conn.clientTools`), so two connections attached to the same thread with overlapping tool names produce non-deterministic routing at the server: the server does not specify cross-connection tool-name precedence. This RFC does not extend the server to arbitrate; in the collision case, users should detach one client before driving the thread from another. A follow-up RFC may introduce explicit per-connection priority or per-tool owner registration if the ambiguity matters in practice.
- **Crash recovery leaves stale lockfiles.** Standard unix lockfile idiom; recovered via `process.kill(pid, 0)` liveness check.
- **Empty server threads from failed `/clear`.** Each failed `/clear` after `createThread` succeeds leaves one empty thread on the server. No client-side GC; no automatic server-side GC today. A future thread-retention RFC can sweep these.
- **Hand-edits to `mcp.json` while the `/mcp` view is open.** Boundless reads `mcp.json` at `/mcp` open time and writes on apply; a concurrent external edit will be overwritten on the next apply. Last-writer-wins. Users who wish to hand-edit should close the `/mcp` view, edit, and re-open.
- **Log rotation.** Unbounded growth, manual pruning. Rotation is a follow-up RFC.
- **Config concurrent-write collisions.** Hand-edits to `config.json` or `mcp.json` while boundless is running may be overwritten on the next persist. Last-writer-wins.

---

## 7. Design Choices

### 7.1 Client-Side Lockfile over Server-Side Thread-CWD Binding

A server-side solution would have bound store each thread's claiming cwd and reject conflicting attaches at `session:configure` time. This extends the transport with client-specific semantics (bound reasoning about "cwds") and conflicts with protocol genericity. A client-side lockfile keeps the transport ignorant and places the invariant where it is enforced. The cost is the cross-host gap documented in §6.7. The primary deployment model is one user, one bound instance, one or a few boundless workstations; the client-side lockfile covers the conflicts reachable under that model.

### 7.2 A Single Lockfile Per Thread (Not Per-Cwd)

An alternative keys lockfiles by cwd, preventing two boundless processes from sharing a cwd. Worktrees make per-cwd locking the wrong invariant: a user may have `/home/kara/proj` checked out on branch `main` and `/home/kara/proj-feature` as a worktree on a feature branch, with two boundless processes running against two threads simultaneously. Per-cwd locking would correctly forbid a single thread across two cwds but would also forbid two threads sharing a cwd. Per-thread locking yields the intended invariant directly.

### 7.3 Single Config Directory over XDG-Split

A support report of state scattered across `$XDG_CONFIG_HOME/boundless/`, `$XDG_STATE_HOME/boundless/`, `$XDG_CACHE_HOME/boundless/`, and `$XDG_DATA_HOME/boundless/` is more expensive to diagnose than one with state under `~/.bound/less/`. The cost of violating XDG on Linux is accepted because consolidation aligns with bound's own `~/.bound/` conventions.

### 7.4 Hot-Reload MCP Servers over Restart-on-Change

Adding and removing MCP servers is a mid-session operation. Forcing a restart disrupts the session, discards in-memory state (scrollback, draft), and drops the thread subscription. Because `session:configure` is re-callable, the implementation cost of hot-reload is low: manage the server lifecycle, rebuild the tool list, re-send. The one config dimension that does not hot-reload is `url`; restart-only is acceptable for that dimension.

### 7.5 `tool:result.content` Widened to `ContentBlock[]` over String Wrapping

The alternative is to keep `content` as string and let boundless prepend provenance as `[boundless] host=... cwd=... tool=...\n\n<actual output>`. This works for text-only tools but fails for MCP servers that return images (diagram tools) or heterogeneous blocks (text + image, e.g., browser-automation MCP returning screenshot + HTML dump). The LLM layer already supports `string | ContentBlock[]`; widening the WebSocket protocol is a minimal amendment that admits those MCP servers and remains usable by any future client.

### 7.6 Fresh `connectionId` Per WebSocket Reconnect

An alternative uses one `connectionId` per boundless process lifetime. A reconnect is a new `session:configure` epoch (pending tool calls re-delivered, tool schemas freshly sent), and a log partitioned by WS connection separates one epoch's activity from the next. The cost is more log files per thread over time; in the absence of rotation (v1), additional files do not change the operational picture and can be pruned independently.

### 7.7 Cancellation Through HTTP `cancelThread` Rather Than a WebSocket Message

`cancelThread` is the existing public API for canceling an agent loop, used by the web UI, Discord, and any other surface. A new WebSocket message with the same semantics would require the server to implement two code paths with identical outcomes. HTTP latency is acceptable for user-initiated cancellations. boundless uses the existing primitive rather than extending the transport.
