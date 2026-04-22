# Human Test Plan: MCP Subcommand Dispatch

**Implementation plan:** `docs/implementation-plans/2026-03-28-mcp-subcommand-dispatch/`
**Coverage:** 22/22 acceptance criteria covered by automated tests
**Automated test status:** PASS

All acceptance criteria are covered by automated tests. The manual steps below serve as supplementary end-to-end validation for confidence in the integration, not as required verification for any specific AC.

---

## Prerequisites

- Bun runtime installed (v1.3+)
- Working directory: project root
- All automated tests passing:
  ```
  bun test packages/agent/src/__tests__/mcp-bridge.test.ts
  bun test packages/agent/src/__tests__/commands.test.ts
  bun test packages/cli/src/__tests__/mcp-tool-definitions.test.ts
  ```

---

## Phase 1: MCP Bridge — Subcommand Dispatch

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | Configure `mcp.json` with a server that has multiple tools (e.g., a GitHub MCP server with `create_issue`, `list_issues`, `search_repos`). Start the agent with `bun packages/cli/src/bound.ts start`. | Agent starts without error; log output shows one command registered per server name, not one per tool. |
| 1.2 | In the web UI or via platform, send a message asking the LLM to use the MCP server. Observe the tool call the LLM emits. | The LLM emits a single tool call with `name` equal to the server name (e.g., `"github"`), with a `subcommand` argument (e.g., `"create_issue"`) and the tool's parameters as siblings. |
| 1.3 | Ask the LLM to call a tool that does not exist on the server (e.g., `subcommand: "nonexistent"`). | The tool execution returns an error message containing "Unknown subcommand" and "Available subcommands" listing the valid tools. The LLM should recover and retry with a valid subcommand. |
| 1.4 | Ask the LLM to discover what tools are available on the server (triggering a `subcommand: "help"` call or `{ help: "true" }` invocation). | The response lists all subcommands with their descriptions and parameter information. |

---

## Phase 2: Commands Discovery

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | With the agent running and at least one MCP server connected, ask the agent to list available tools or inspect the orientation block context. | Available tools are organized: "Built-in:" (query, memory, advisory, etc.), "LOCAL (MCP):" (with server names, not per-tool names), and "REMOTE (via relay):" (only if remote hosts exist). |
| 2.2 | Ask the agent to show help for a server command (e.g., by invoking `<server> --help`). | Output shows the server's subcommand listing with tool names, descriptions, and parameter tables — the same output as calling the server command with `{ help: "true" }`. |
| 2.3 | Verify `resources`, `resource`, `prompts`, and `prompt` appear as discoverable built-in commands via `<cmd> --help`. | These four meta-commands are available as built-in commands in the agent's command registry. |

---

## Phase 3: LLM Tool Schema Verification

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | Enable debug logging or inspect the LLM request payload sent to the model backend. Count the tool definitions sent. | There is one `ToolDefinition` per connected MCP server (not one per tool). Each has `parameters.required: ["subcommand"]` and `additionalProperties: true`. |
| 3.2 | Verify the tool definition names in the LLM payload. | Names match server names exactly (e.g., `"github"`, `"notion"`). No hyphenated per-tool entries like `"github-create_issue"` appear. |

---

## Phase 4: Host MCP Info Persistence

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | After the agent starts with MCP servers connected, query the local database: `SELECT mcp_tools FROM hosts WHERE site_id = '<local-site-id>'`. | The `mcp_tools` column contains a JSON array of server names (e.g., `["github", "notion"]`), not individual tool names. |
| 4.2 | In a multi-host cluster, verify that remote host rows also store server-level names after sync. | Remote hosts' `mcp_tools` columns contain flat `string[]` of server names, discoverable via the agent's command registry and `<cmd> --help` mechanism. |

---

## End-to-End: Full Subcommand Dispatch Flow

**Purpose:** Validate that the entire chain works from LLM tool call generation through dispatch to actual MCP server execution.

1. Configure `mcp.json` with at least one real MCP server (e.g., a filesystem or GitHub server) with `allow_tools` restricting to a subset of tools.
2. Start the agent: `bun packages/cli/src/bound.ts start`.
3. Send a user message that should trigger use of an allowed tool on the server.
4. Observe: the LLM generates a single tool call with the server name, the `subcommand` field names the specific tool, and additional parameters are passed correctly.
5. Verify the tool executes successfully and the LLM receives the result.
6. Send a message that would trigger use of a blocked tool (one not in `allow_tools`).
7. Verify: the dispatch returns an error listing only the allowed subcommands. The LLM should receive this error and adapt.

---

## End-to-End: Confirm Gate in Autonomous Mode

**Purpose:** Validate that `confirmGates` prevents dangerous tool execution during scheduled/autonomous tasks while allowing interactive use.

1. Configure `mcp.json` with a server that has `confirm: ["dangerous_tool"]`.
2. Create a scheduled task (via `schedule` command) whose payload would trigger the confirmed tool.
3. When the task fires (autonomous mode, `taskId` without "interactive-" prefix), verify the tool call is rejected with a "confirmation" error.
4. Manually invoke the same tool from an interactive web UI session.
5. Verify the tool executes successfully in interactive mode.

---

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 | `mcp-bridge.test.ts` — "returns one CommandDefinition per connected server" | 1.1 |
| AC1.2 | `mcp-bridge.test.ts` — "returns three server commands for three servers" | 1.1 |
| AC1.3 | `mcp-bridge.test.ts` — "dispatches valid subcommand to callTool with correct args" | 1.2 |
| AC1.4 | `mcp-bridge.test.ts` — "returns error for unknown subcommand" | 1.3 |
| AC1.5 | `mcp-bridge.test.ts` — "disconnected server produces no command" | — |
| AC2.1 | `mcp-bridge.test.ts` — "--help only returns server-level listing" + "subcommand='help'..." | 1.4 |
| AC2.2 | `mcp-bridge.test.ts` — "subcommand + --help returns param table" | 1.4 |
| AC2.3 | `mcp-bridge.test.ts` — "no-args handler returns server-level listing" | 1.4 |
| AC2.4 | `mcp-bridge.test.ts` — "help listing only shows allow_tools-filtered subcommands" | E2E step 7 |
| AC3.1 | `mcp-bridge.test.ts` — "allow_tools blocks non-allowed subcommands" | E2E step 6–7 |
| AC3.2 | `mcp-bridge.test.ts` — "gated subcommand blocked in autonomous mode" | Confirm Gate step 3 |
| AC3.3 | `mcp-bridge.test.ts` — "gated subcommand allowed in interactive mode" | Confirm Gate step 4–5 |
| AC4.1 | `mcp-tool-definitions.test.ts` — "produces one ToolDefinition per server name" | 3.1 |
| AC4.2 | `mcp-tool-definitions.test.ts` — "schema has subcommand as required string" | 3.1 |
| AC4.3 | `mcp-tool-definitions.test.ts` — "produces no per-tool entries" | 3.2 |
| AC5.1 | `mcp-bridge.test.ts` — "updateHostMCPInfo stores server names not tool names" | 4.1 |
| AC5.2 | `mcp-bridge.test.ts` — (same test, 2 servers) | 4.1–4.2 |
| AC6.1 | `commands.test.ts` — "should show LOCAL and REMOTE tiers..." | 2.1 |
| AC6.2 | `commands.test.ts` — "should render subcommand listing for MCP server command" | 2.2 |
| AC6.3 | `commands.test.ts` — "should show LOCAL and REMOTE tiers..." (remote-server assertion) | 2.1 |
| AC7.1 | `commands.test.ts` — "should list meta-commands as builtins" | 2.3 |
| AC7.2 | `mcp-bridge.test.ts` — existing meta-command tests | — |
