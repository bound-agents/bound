# Boundless Human Test Plan

Generated from automated test analysis of the boundless implementation (all 8 phases).

## Prerequisites

- A running `bound` server at `http://localhost:3001` (or configured URL)
- `bun run build` completes successfully, producing `dist/boundless`
- All automated tests pass: `bun test packages/less packages/web/src/server/__tests__/websocket.test.ts packages/client packages/agent/src/__tests__/context-assembly.test.ts`
- At least one MCP server configured in `mcp.json` (e.g., `@modelcontextprotocol/server-github` or a test echo server)
- At least two threads exist on the bound server (create via web UI or `boundctl`)

## Phase 1: Binary Compilation (AC1.7)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Run `bun run build` from the monorepo root | Build completes without errors |
| 2 | Run `ls -la dist/boundless` | File exists with execute permissions (`-rwxr-xr-x` or similar) |
| 3 | Run `dist/boundless --help 2>&1 || true` | Outputs usage text or recognizable error; does not segfault |
| 4 | Verify file size is reasonable (>1MB, <100MB) | Binary is a real compiled artifact, not a stub |

## Phase 2: Model Picker (AC9.5)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Start `boundless` connected to a live bound server | TUI renders with empty scrollback or message history |
| 2 | Type `/model` and press Enter | Model picker overlay appears with available models from `client.listModels()` |
| 3 | Use arrow keys to navigate the model list | Highlight moves between entries |
| 4 | Press Enter on a model | Picker closes; StatusBar updates to show selected model name |
| 5 | Type `/model claude-opus` and press Enter | Model switches directly (no picker); StatusBar reflects "claude-opus" |

## Phase 3: Thread Picker (AC9.6)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Ensure at least 2 threads exist on the server | Threads visible in web UI |
| 2 | Type `/attach` and press Enter | Thread picker overlay appears listing threads from `client.listThreads()` |
| 3 | Navigate with arrow keys | Thread entries highlight in sequence |
| 4 | Press Enter on a thread | Picker closes; transition occurs (StatusBar shows new thread ID); old message history replaced with new thread's messages |
| 5 | Verify lockfile: check `~/.bound/less/locks/<oldThreadId>.json` | Old lockfile removed |
| 6 | Verify lockfile: check `~/.bound/less/locks/<newThreadId>.json` | New lockfile present with current pid |

## Phase 4: MCP Configuration View (AC9.7)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Configure at least one MCP server in `~/.bound/less/mcp.json` | Server appears in mcp.json |
| 2 | Start `boundless`; verify MCP server count in StatusBar | Count matches configured servers |
| 3 | Type `/mcp` and press Enter | MCP configuration overlay appears with server list |
| 4 | Verify each server shows a status badge | Badges show "running", "failed", or "disabled" as appropriate |
| 5 | Select a running server and toggle "disable" | Server status changes to "disabled"; tool count in StatusBar updates |
| 6 | Toggle "enable" on the disabled server | Server restarts; status returns to "running" (or "failed" if misconfigured) |
| 7 | Press Escape to close the MCP view | Overlay closes; chat view restored |

## End-to-End: Full Session Lifecycle

**Purpose:** Validate the complete user workflow from startup through interaction to exit.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Run `dist/boundless` (no args) | New thread created; TUI renders with empty scrollback; lockfile acquired |
| 2 | Type a message and press Enter | Message appears in scrollback as "You: <message>"; agent begins processing (spinner visible) |
| 3 | Wait for agent response | Response renders as "Agent: <response>"; spinner disappears |
| 4 | If agent uses a tool, observe the tool call card | ToolCallCard shows tool name, spinner, elapsed time; for `boundless_bash`, stdout streams in real-time |
| 5 | Press Ctrl-C during agent processing | Agent turn cancels; "Canceled" indicator appears |
| 6 | Type `/clear` and press Enter | New thread created; scrollback cleared; model selection preserved |
| 7 | Type `/attach <previous-thread-id>` and press Enter | Transition occurs; previous thread's messages load into scrollback |
| 8 | Press Ctrl-C twice within 2 seconds | Graceful exit: MCP subprocesses terminated, lockfile released, process exits 0 |
| 9 | Verify lockfile is gone: `cat ~/.bound/less/locks/<threadId>.json` | File not found |

## End-to-End: Error Recovery

**Purpose:** Validate graceful degradation under failure conditions.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Stop the bound server | Server process killed |
| 2 | Run `dist/boundless` | Connection error printed to stderr; process exits with code 1 |
| 3 | Start bound server again | Server is running |
| 4 | Run `dist/boundless` and verify connection | TUI renders; StatusBar shows "connected" |
| 5 | Stop bound server while boundless is running | StatusBar transitions to "disconnected"; banner shows connection error |
| 6 | Restart bound server | Client reconnects (exponential backoff); StatusBar returns to "connected"; active subscriptions restored |

## End-to-End: MCP Tool Execution

**Purpose:** Validate MCP bridge tools work end-to-end through the TUI.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Configure an MCP server with at least one tool in `mcp.json` | Server configured |
| 2 | Start `boundless`; verify MCP server count in StatusBar | Count matches configured servers |
| 3 | Send a message that triggers the MCP tool | Agent invokes the MCP tool; ToolCallCard appears showing `boundless_mcp_<server>_<tool>` |
| 4 | Tool completes | Result rendered in scrollback; provenance block shows `[boundless:mcp]` prefix |
| 5 | Type `/mcp`, disable the server, close the view | StatusBar MCP count decrements |
| 6 | Send another message requesting the same tool | Agent cannot use the tool (it was removed from tool list) |

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|------------|-------|
| AC1.7 (Binary compiles) | Build system artifact; automated test adds fragility | Phase 1 steps 1-4 |
| AC9.5 (Model picker) | Requires live server + visual verification | Phase 2 steps 1-5 |
| AC9.6 (Thread picker) | Requires live server with multiple threads | Phase 3 steps 1-6 |
| AC9.7 (MCP config view) | Requires visual verification of status badges and hot-reload | Phase 4 steps 1-7 |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 | e2e.integration.test.ts, boundless-startup.test.ts | E2E Lifecycle step 1 |
| AC1.2 | e2e.integration.test.ts, boundless-startup.test.ts | E2E Lifecycle step 7 |
| AC1.3 | boundless-startup.test.ts | -- |
| AC1.4 | boundless-errors.test.ts | E2E Error Recovery step 2 |
| AC1.5 | boundless-errors.test.ts | E2E Error Recovery step 2 |
| AC1.6 | boundless-errors.test.ts | E2E Lifecycle step 8 |
| AC1.7 | -- | Phase 1 |
| AC2.1-AC2.7 | websocket.test.ts, context-assembly.test.ts | -- |
| AC3.1-AC3.6 | websocket.test.ts, client.test.ts | -- |
| AC4.1-AC4.9 | config.test.ts, lockfile.test.ts | E2E Lifecycle steps 5-6, 9 |
| AC5.1-AC5.13 | read/write/edit/bash/provenance/registry tests | E2E MCP step 4 |
| AC6.1-AC6.8 | mcp-manager.test.ts, mcp-proxy.test.ts, registry.test.ts | E2E MCP steps 1-6 |
| AC7.1-AC7.11 | session-attach/transition/cancel tests | E2E Lifecycle steps 5-8 |
| AC8.1-AC8.6 | tui-controls/primitives/layout tests | Phases 2-4 |
| AC9.1-AC9.4 | tui-message-components.test.tsx | E2E Lifecycle steps 2-4 |
| AC9.5 | -- | Phase 2 |
| AC9.6 | -- | Phase 3 |
| AC9.7 | -- | Phase 4 |
| AC9.8 | tui-views.test.tsx | -- |
| AC9.9 | tui-views.test.tsx | E2E Lifecycle step 2 |
| AC10.1-AC10.4 | websocket.test.ts | -- |
