# Boundless Test Requirements

Maps each acceptance criterion to an automated test or documented human verification approach.

## boundless.AC1: CLI Startup & Process Lifecycle

### boundless.AC1.1 [Success]
- **Test type:** integration
- **File:** `packages/less/src/__tests__/e2e.integration.test.ts`
- **Verifies:** `boundless` with no args creates a new thread, acquires lockfile, launches TUI with empty scrollback

### boundless.AC1.2 [Success]
- **Test type:** integration
- **File:** `packages/less/src/__tests__/e2e.integration.test.ts`
- **Verifies:** `boundless --attach <threadId>` loads existing thread, acquires lockfile, renders message history in scrollback

### boundless.AC1.3 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/boundless-startup.test.ts`
- **Verifies:** `boundless --url <url>` overrides config.json URL for the process lifetime without persisting

### boundless.AC1.4 [Failure]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/boundless-startup.test.ts`
- **Verifies:** `boundless --attach <nonexistent>` prints thread-not-found to stderr and exits 1

### boundless.AC1.5 [Failure]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/boundless-startup.test.ts`
- **Verifies:** `boundless` when bound server is unreachable prints connection error to stderr and exits 1

### boundless.AC1.6 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/boundless-startup.test.ts`
- **Verifies:** SIGTERM triggers graceful exit: MCP subprocesses terminated, lockfile released, exit 0

### boundless.AC1.7 [Success]
- **Test type:** human
- **File:** N/A
- **Verifies:** Binary compiles to `dist/boundless` via existing build script
- **Justification:** Binary compilation is a build-system artifact verified by `bun run build && ls -la dist/boundless`. Automating binary existence as a test adds fragility.
- **Verification approach:** Run `bun run build`, confirm `dist/boundless` exists with execute permissions, run `dist/boundless --help 2>&1 || true` to confirm it executes.

---

## boundless.AC2: Protocol Extension -- systemPromptAddition

### boundless.AC2.1 [Success]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** `session:configure` with `systemPromptAddition` stores the string per (connection, threadId) pair for all subscribed threads

### boundless.AC2.2 [Success]
- **Test type:** unit
- **File:** `packages/agent/src/__tests__/context-assembly.test.ts`
- **Verifies:** Agent loop's context assembly appends the stored string to the system suffix for the matching pair

### boundless.AC2.3 [Success]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** `thread:subscribe` after `session:configure` inherits the connection's most recent systemPromptAddition

### boundless.AC2.4 [Success]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** Re-sending `session:configure` replaces the stored string for all subscribed pairs; omitting the field clears it

### boundless.AC2.5 [Success]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** `thread:unsubscribe` clears the pair's stored addition

### boundless.AC2.6 [Edge]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** `session:configure` without `systemPromptAddition` field does not error; existing stored values cleared

### boundless.AC2.7 [Success]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** Existing clients that do not send `systemPromptAddition` continue to work unchanged

---

## boundless.AC3: Protocol Extension -- tool:cancel

### boundless.AC3.1 [Success]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** `cancelThread(threadId)` emits `tool:cancel` with reason `thread_canceled` for every pending client_tool_call dispatch entry

### boundless.AC3.2 [Success]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** TTL expiry emits `tool:cancel` with reason `dispatch_expired` and synthesizes tool-error LLMMessage for the agent loop

### boundless.AC3.3 [Success]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** Connection close with pending entries emits `tool:cancel` with reason `session_reset` and synthesizes tool-error LLMMessage

### boundless.AC3.4 [Success]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** Late `tool:result` for an already-canceled callId is accepted but discarded -- no LLMMessage persisted

### boundless.AC3.5 [Success]
- **Test type:** unit
- **File:** `packages/client/src/__tests__/client.test.ts`
- **Verifies:** Client receiving `tool:cancel` for an unrecognized callId drops it silently

### boundless.AC3.6 [Edge]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** Re-sending `session:configure` (MCP hot-reload) does NOT trigger tool:cancel for pending entries

---

## boundless.AC4: Configuration & Lockfile

### boundless.AC4.1 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/config.test.ts`
- **Verifies:** Absent `config.json` treated as defaults (url=http://localhost:3001, model=null)

### boundless.AC4.2 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/config.test.ts`
- **Verifies:** Absent `mcp.json` treated as `{ servers: [] }`

### boundless.AC4.3 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/config.test.ts`
- **Verifies:** Config save preserves unknown fields (forward compatibility)

### boundless.AC4.4 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/lockfile.test.ts`
- **Verifies:** Lockfile acquired with O_EXCL for new thread; file contains `{ cwd, pid, attachedAt }`

### boundless.AC4.5 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/lockfile.test.ts`
- **Verifies:** Stale lockfile (dead pid via ESRCH) is cleared and re-acquired

### boundless.AC4.6 [Failure]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/lockfile.test.ts`
- **Verifies:** Live pid + same cwd produces error "thread X is already attached from this directory by pid Y"

### boundless.AC4.7 [Failure]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/lockfile.test.ts`
- **Verifies:** Live pid + different cwd produces error "thread X is attached from Z by pid Y; you are in W"

### boundless.AC4.8 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/lockfile.test.ts`
- **Verifies:** Lockfile released on detach (transition, exit, SIGTERM)

### boundless.AC4.9 [Failure]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/config.test.ts`
- **Verifies:** Duplicate server names in `mcp.json` rejected at load time with specific error

---

## boundless.AC5: Core Tools

### boundless.AC5.1 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/read.test.ts`
- **Verifies:** `boundless_read` returns line-numbered content with provenance prefix for valid file path

### boundless.AC5.2 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/read.test.ts`
- **Verifies:** `boundless_read` with offset/limit returns the specified line range

### boundless.AC5.3 [Failure]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/read.test.ts`
- **Verifies:** `boundless_read` on nonexistent file returns isError with ENOENT message

### boundless.AC5.4 [Edge]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/read.test.ts`
- **Verifies:** `boundless_read` on binary file returns summary instead of raw content

### boundless.AC5.5 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/write.test.ts`
- **Verifies:** `boundless_write` creates file with parent directories, returns byte count

### boundless.AC5.6 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/edit.test.ts`
- **Verifies:** `boundless_edit` replaces exactly one match of old_string with new_string

### boundless.AC5.7 [Failure]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/edit.test.ts`
- **Verifies:** `boundless_edit` with no match returns isError with "not found" message

### boundless.AC5.8 [Failure]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/edit.test.ts`
- **Verifies:** `boundless_edit` with multiple matches returns isError with match count and context

### boundless.AC5.9 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/bash.test.ts`
- **Verifies:** `boundless_bash` executes command in cwd, returns stdout/stderr with exit code

### boundless.AC5.10 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/bash.test.ts`
- **Verifies:** `boundless_bash` on AbortSignal sends SIGTERM, waits 2s, sends SIGKILL

### boundless.AC5.11 [Edge]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/bash.test.ts`
- **Verifies:** `boundless_bash` output >100KB is truncated from the middle with marker

### boundless.AC5.12 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/provenance.test.ts`
- **Verifies:** All tool results are `ContentBlock[]` with provenance text block first

### boundless.AC5.13 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/registry.test.ts`
- **Verifies:** Tool registry detects name collisions and rejects the offending MCP server

---

## boundless.AC6: MCP Bridge

### boundless.AC6.1 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/mcp-manager.test.ts`
- **Verifies:** Stdio MCP server spawns, handshakes, enumerates tools under `boundless_mcp_<server>_<tool>` namespace

### boundless.AC6.2 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/mcp-manager.test.ts`
- **Verifies:** HTTP/SSE MCP server connects and enumerates tools

### boundless.AC6.3 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/mcp-proxy.test.ts`
- **Verifies:** Tool call proxied via `client.callTool()`, MCP result mapped to ContentBlock[] with MCP provenance

### boundless.AC6.4 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/registry.test.ts`
- **Verifies:** `allowTools` filters enumerated tools to whitelist only

### boundless.AC6.5 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/registry.test.ts`
- **Verifies:** `confirm` tools show TUI confirmation prompt; "no" returns isError

### boundless.AC6.6 [Failure]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/mcp-manager.test.ts`
- **Verifies:** MCP server spawn/handshake failure is non-fatal -- server marked failed, tools omitted, other servers unaffected

### boundless.AC6.7 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/mcp-manager.test.ts`
- **Verifies:** `terminateAll()` sends SIGTERM then SIGKILL after 2s to all stdio subprocesses

### boundless.AC6.8 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/mcp-manager.test.ts`
- **Verifies:** Hot-reload: add/remove/enable/disable server, rebuild tool list, re-send session:configure, persist to mcp.json

---

## boundless.AC7: Session Management

### boundless.AC7.1 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/session-attach.test.ts`
- **Verifies:** Attach flow executes in order: listMessages, subscribe, ensure MCP servers, build tools, configure

### boundless.AC7.2 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/session-attach.test.ts`
- **Verifies:** Pending tool calls in history rendered as placeholders, replaced when re-delivered

### boundless.AC7.3 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/session-transition.test.ts`
- **Verifies:** `/attach <threadId>` transitions: drain, unsubscribe old, release old lock, acquire new lock, attach new

### boundless.AC7.4 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/session-transition.test.ts`
- **Verifies:** `/clear` creates new thread and transitions to it; model selection preserved

### boundless.AC7.5 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/session-transition.test.ts`
- **Verifies:** Transition failure at lock acquisition triggers rollback to old thread

### boundless.AC7.6 [Edge]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/session-transition.test.ts`
- **Verifies:** Rollback failure (another process grabbed old lock) enters degraded read-only mode with persistent banner

### boundless.AC7.7 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/session-cancel.test.ts`
- **Verifies:** Ctrl-C during active turn calls cancelThread once, aborts in-flight tool handlers

### boundless.AC7.8 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/session-cancel.test.ts`
- **Verifies:** Double Ctrl-C within 2s exits gracefully (MCP terminated, lock released)

### boundless.AC7.9 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/session-cancel.test.ts`
- **Verifies:** Ctrl-C during idle shows hint; second within 2s exits

### boundless.AC7.10 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/session-cancel.test.ts`
- **Verifies:** Ctrl-C while modal open dismisses modal without counting toward exit

### boundless.AC7.11 [Edge]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/session-cancel.test.ts`
- **Verifies:** Ctrl-C during attach transition deferred until transition settles

---

## boundless.AC8: TUI Primitives

### boundless.AC8.1 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/tui-controls.test.tsx`
- **Verifies:** SelectList handles arrow-key navigation, enter to select, escape/Ctrl-C to cancel

### boundless.AC8.2 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/tui-controls.test.tsx`
- **Verifies:** Confirm handles yes/no with keyboard

### boundless.AC8.3 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/tui-controls.test.tsx`
- **Verifies:** TextInput handles text entry, submit, disabled state, placeholder

### boundless.AC8.4 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/tui-primitives.test.tsx`
- **Verifies:** Collapsible toggles content visibility

### boundless.AC8.5 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/tui-layout.test.tsx`
- **Verifies:** Banner renders error/info with dismissal

### boundless.AC8.6 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/tui-layout.test.tsx`
- **Verifies:** ModalOverlay traps focus and dismisses on escape

---

## boundless.AC9: TUI Views & Integration

### boundless.AC9.1 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/tui-message-components.test.tsx`
- **Verifies:** ChatView renders message history with user/assistant/tool_call/tool_result blocks

### boundless.AC9.2 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/tui-message-components.test.tsx`
- **Verifies:** In-flight tool calls render as ToolCallCard with spinner and elapsed time

### boundless.AC9.3 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/tui-hooks.test.ts`
- **Verifies:** `boundless_bash` stdout streams to ToolCallCard in real-time locally

### boundless.AC9.4 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/tui-message-components.test.tsx`
- **Verifies:** StatusBar shows thread ID, model name, connection status, MCP server count

### boundless.AC9.5 [Success]
- **Test type:** human
- **File:** N/A
- **Verifies:** `/model <name>` sets model; `/model` opens picker populated from `client.listModels()`
- **Justification:** Model picker requires live server interaction and visual verification of picker rendering with real model data.
- **Verification approach:** Run boundless against a live server, type `/model`, confirm picker opens with available models. Select one, confirm model name updates in StatusBar.

### boundless.AC9.6 [Success]
- **Test type:** human
- **File:** N/A
- **Verifies:** `/attach` without arg opens thread picker from `client.listThreads()`; selection triggers transition
- **Justification:** Thread picker requires live server with multiple threads. Transition logic is unit-tested in AC7.3-AC7.6, but the full TUI flow requires manual verification.
- **Verification approach:** Create multiple threads, run boundless, type `/attach`, confirm picker lists threads. Select one, confirm transition occurs.

### boundless.AC9.7 [Success]
- **Test type:** human
- **File:** N/A
- **Verifies:** `/mcp` opens configuration view with server list, status badges, add/remove/enable/disable
- **Justification:** MCP configuration view requires visual verification of status badges and hot-reload behavior with real MCP servers.
- **Verification approach:** Configure an MCP server in mcp.json, run boundless, type `/mcp`, confirm server list with status badges. Test disable/enable toggling.

### boundless.AC9.8 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/tui-views.test.tsx`
- **Verifies:** Unknown slash command shows inline error

### boundless.AC9.9 [Success]
- **Test type:** unit
- **File:** `packages/less/src/__tests__/tui-views.test.tsx`
- **Verifies:** Non-slash input sends message via `client.sendMessage()` with current model

---

## boundless.AC10: Protocol Extension -- Content Widening

### boundless.AC10.1 [Success]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** `tool:result` with `content: string` persisted as single text block (backward compatible)

### boundless.AC10.2 [Success]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** `tool:result` with `content: ContentBlock[]` (text, image, document) persisted verbatim

### boundless.AC10.3 [Failure]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** `tool:result` with invalid ContentBlock variant (e.g., tool_use, thinking) rejected with error response

### boundless.AC10.4 [Success]
- **Test type:** unit
- **File:** `packages/web/src/server/__tests__/websocket.test.ts`
- **Verifies:** Existing string-only clients continue to work unchanged

---

## Summary

| Category | Automated (unit) | Automated (integration) | Human | Total |
|----------|------------------|------------------------|-------|-------|
| AC1: CLI Startup | 4 | 2 | 1 | 7 |
| AC2: systemPromptAddition | 7 | 0 | 0 | 7 |
| AC3: tool:cancel | 6 | 0 | 0 | 6 |
| AC4: Configuration & Lockfile | 9 | 0 | 0 | 9 |
| AC5: Core Tools | 13 | 0 | 0 | 13 |
| AC6: MCP Bridge | 8 | 0 | 0 | 8 |
| AC7: Session Management | 11 | 0 | 0 | 11 |
| AC8: TUI Primitives | 6 | 0 | 0 | 6 |
| AC9: TUI Views | 6 | 0 | 3 | 9 |
| AC10: Content Widening | 4 | 0 | 0 | 4 |
| **Total** | **74** | **2** | **4** | **80** |
