# Test Plan: MCP Server

**Implementation plan:** `docs/implementation-plans/2026-03-29-mcp-server/`
**Branch:** `mcp-server`
**Date:** 2026-03-29

---

## Prerequisites

- Bun >= 1.3.7 installed
- Repository checked out on branch `mcp-server`
- Dependencies installed (`bun install`)
- All automated tests passing:
  ```bash
  bun test packages/cli/src/__tests__/mcp-user.test.ts
  bun test packages/web/src/server/__tests__/mcp.integration.test.ts
  bun test packages/mcp-server
  ```

---

## Phase 1: Binary Compilation (AC1.1)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Run `bun run build` from the repository root | Exit code 0, console output lists both `dist/bound` and `dist/bound-mcp` |
| 2 | Run `ls -lh dist/bound-mcp` | File exists, size is non-zero (expected range: 30-80 MB depending on platform) |
| 3 | Run `file dist/bound-mcp` | Output identifies it as an executable binary for the current platform (e.g., `Mach-O 64-bit executable arm64` on Apple Silicon) |

---

## Phase 2: MCP Stdio Smoke Test (AC1.2)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Build the binary per Phase 1 if not already built | `dist/bound-mcp` exists |
| 2 | Run the following command to send `initialize` and `tools/list` JSON-RPC requests over stdin: | Two JSON-RPC response lines on stdout |
| | `printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \| timeout 5 ./dist/bound-mcp 2>/dev/null \|\| true` | |
| 3 | Inspect the response with `"id":2` | Contains a `tools` array |
| 4 | Find the entry with `"name":"bound_chat"` in the `tools` array | Entry exists |
| 5 | Inspect `inputSchema` of the `bound_chat` tool entry | `"required"` array contains `"message"`. `"properties"` has `message` (type `string`) and `thread_id` (type `string`, not in `required`). |
| 6 | Inspect the response with `"id":1` | Contains `"serverInfo"` with `"name":"bound-mcp"` |

---

## Phase 3: End-to-End Integration with Running Agent

**Purpose:** Validate the full round-trip: MCP binary -> HTTP API -> agent loop -> response, spanning AC2.1, AC3.1, AC4.1, AC4.2, AC4.4, AC5.1.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Start a bound agent: `bun packages/cli/src/bound.ts start` (with a valid config directory) | Agent starts, web server listening on `http://localhost:3000` |
| 2 | In a separate terminal, verify agent is reachable: `curl -s http://localhost:3000/api/status \| jq .` | Returns JSON with agent status (not connection refused) |
| 3 | Run `./dist/bound-mcp --url http://localhost:3000` in a terminal. Send an `initialize` request, then a `tools/call` request with `bound_chat` and `{"message":"Hello, what is 2+2?"}` over stdin. | Agent receives the message, processes it, and the MCP server returns a `result` with `content` containing the assistant's reply as a `{ type: "text", text: "..." }` block. The reply should mention "4". |
| 4 | Note the `thread_id` from the internal logs or by querying `curl http://localhost:3000/api/threads \| jq .` | A thread with `interface: "mcp"` exists |
| 5 | Send another `tools/call` with `bound_chat` and `{"message":"What was my previous question?", "thread_id":"<thread_id from step 4>"}` | Response references the previous question about 2+2, confirming thread continuity |
| 6 | Stop the bound agent (Ctrl+C) | Agent shuts down |
| 7 | Send a `tools/call` with `bound_chat` and `{"message":"Hello"}` to the still-running MCP server | Returns `isError: true` with a message containing `http://localhost:3000` indicating the agent is unreachable |

---

## Phase 4: URL Configuration Verification

**Purpose:** Validate AC3.1, AC3.2, AC3.3 in a real binary context.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Run `./dist/bound-mcp` (no args, no env) and observe stderr | Stderr shows `[bound-mcp] MCP server running on stdio (bound at http://localhost:3000)` |
| 2 | Run `BOUND_URL=http://myhost:4000 ./dist/bound-mcp` and observe stderr | Stderr shows `(bound at http://myhost:4000)` |
| 3 | Run `./dist/bound-mcp --url http://other:5000` and observe stderr | Stderr shows `(bound at http://other:5000)` |
| 4 | Run `BOUND_URL=http://env:4000 ./dist/bound-mcp --url http://cli:5000` and observe stderr | Stderr shows `(bound at http://cli:5000)` (CLI flag takes precedence) |

---

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|------------|-------|
| AC1.1: Binary compiles | Build-system operation depends on host environment (OS, architecture, Bun version). Cannot be meaningfully unit-tested. | Phase 1, Steps 1-3 |
| AC1.2: Binary responds to MCP initialize and lists bound_chat | Cross-process stdio verification requires compiled binary and subprocess I/O. Fragile to automate, better as smoke test. | Phase 2, Steps 1-6 |

---

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 Binary compiles | -- | Phase 1, Steps 1-3 |
| AC1.2 MCP initialize + tools/list | -- | Phase 2, Steps 1-6 |
| AC2.1 `bound_chat` accepts `message`+`thread_id` | `server.test.ts` (schema safeParse) | Phase 2, Step 5 |
| AC2.2 Rejects missing `message` | `server.test.ts` (schema safeParse) | -- |
| AC3.1 `--url` sets base URL | `server.test.ts` (getBaseUrl) | Phase 4, Steps 3-4 |
| AC3.2 `BOUND_URL` env var | `server.test.ts` (getBaseUrl) | Phase 4, Step 2 |
| AC3.3 Default `localhost:3000` | `server.test.ts` (getBaseUrl) | Phase 4, Step 1 |
| AC4.1 No `thread_id` creates new thread | `handler.test.ts` (mock createMcpThread) | Phase 3, Steps 3-4 |
| AC4.2 Thread has `interface="mcp"` + correct `user_id` | `mcp.integration.test.ts` (DB query) | Phase 3, Step 4 |
| AC4.3 Supplied `thread_id` reused | `handler.test.ts` (mock assert) | Phase 3, Step 5 |
| AC4.4 Returns assistant message as text block | `handler.test.ts` (content assertion) | Phase 3, Step 3 |
| AC5.1 `isError:true` when unreachable | `handler.test.ts` (BoundNotRunningError) | Phase 3, Step 7 |
| AC5.2 `isError:true` on 5-min timeout | `handler.test.ts` (Date.now mock) | -- |
| AC6.1 POST returns 201 with `thread_id` | `mcp.integration.test.ts` (status + body) | Phase 3, Step 4 |
| AC6.2 Thread attributes correct | `mcp.integration.test.ts` (DB query) | Phase 3, Step 4 |
| AC6.3 `mcp` user exists after startup | `mcp-user.test.ts` (DB query) | -- |
| AC6.4 `mcp` user provisioning idempotent | `mcp-user.test.ts` (double call) | -- |
| AC6.5 Rejects non-localhost Host | `mcp.integration.test.ts` (400 status) | -- |
