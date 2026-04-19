# Boundless Implementation Plan — Phase 4: MCP Bridge

**Goal:** Implement MCP server lifecycle management and tool call proxying. Boundless spawns MCP servers as client-side subprocesses, enumerates their tools, and proxies agent tool calls through them.

**Architecture:** `McpServerManager` manages per-server state (spawn, connect, disconnect, enumerate). `proxyToolCall` maps MCP results to `ContentBlock[]`. Integration with `tools/registry.ts` from Phase 3 provides `allowTools` filtering and `confirm` gating. Follows the existing MCP client pattern from `packages/agent/src/mcp-client.ts` but lives in `@bound/less` to avoid depending on `@bound/agent`.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk (Client, StdioClientTransport, StreamableHTTPClientTransport), bun:test

**Scope:** 8 phases from original design (phase 4 of 8)

**Codebase verified:** 2026-04-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### boundless.AC6: MCP Bridge
- **boundless.AC6.1 Success:** Stdio MCP server spawns, handshakes, enumerates tools under `boundless_mcp_<server>_<tool>` namespace
- **boundless.AC6.2 Success:** HTTP/SSE MCP server connects and enumerates tools
- **boundless.AC6.3 Success:** Tool call proxied via `client.callTool()`, MCP result mapped to ContentBlock[] with MCP provenance
- **boundless.AC6.4 Success:** `allowTools` filters enumerated tools to whitelist only
- **boundless.AC6.5 Success:** `confirm` tools show TUI confirmation prompt; "no" returns isError
- **boundless.AC6.6 Failure:** MCP server spawn/handshake failure is non-fatal — server marked failed, tools omitted, other servers unaffected
- **boundless.AC6.7 Success:** `terminateAll()` sends SIGTERM then SIGKILL after 2s to all stdio subprocesses
- **boundless.AC6.8 Success:** Hot-reload: add/remove/enable/disable server, rebuild tool list, re-send session:configure, persist to mcp.json

---

<!-- START_TASK_1 -->
### Task 1: McpServerManager — lifecycle and tool enumeration

**Verifies:** boundless.AC6.1, boundless.AC6.2, boundless.AC6.6, boundless.AC6.7

**Files:**
- Create: `packages/less/src/mcp/manager.ts`
- Test: `packages/less/src/__tests__/mcp-manager.test.ts`

**Implementation:**

Create `McpServerManager` class that manages MCP server connections.

**Imports** (following the pattern from `packages/agent/src/mcp-client.ts:6-9`):
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
```

**State per server** — `McpServerState`:
```ts
interface McpServerState {
    config: McpServerConfig; // from config.ts
    status: "not-spawned" | "running" | "failed" | "disabled";
    client: Client | null;
    tools: Tool[];
    error: string | null;
    transport: StdioClientTransport | StreamableHTTPClientTransport | null;
}
```

**Key methods:**

1. `constructor(logger: AppLogger)` — takes logger for stderr piping.

2. `async ensureAllEnabled(configs: McpServerConfig[])` — For each enabled config: if not already running, spawn/connect. For disabled configs, skip. For each server:
   - Create `Client({ name: "boundless", version: "0.0.1" })`
   - If stdio: create `StdioClientTransport({ command, args, env })`. Pipe stderr to log file via `logger.openMcpStderrLog()`.
   - If http: create `StreamableHTTPClientTransport(new URL(url))`
   - Call `client.connect(transport)`, then `client.listTools()` to enumerate tools
   - On success: set status "running", store tools
   - On failure (AC6.6): set status "failed", store error message, continue with other servers. Do NOT throw.

3. `async terminateAll()` (AC6.7) — For each server with status "running":
   - Call `client.close()` (which sends SIGTERM for stdio transports)
   - If stdio transport: check if process still alive after 2s, send SIGKILL if needed
   - Set status to "not-spawned"

4. `getRunningTools(): Map<string, Tool[]>` — Returns map of serverName -> Tool[] for all running servers.

5. `getServerStates(): Map<string, McpServerState>` — Returns full state for TUI display.

**Testing:**

- boundless.AC6.1: This requires an actual MCP server to test. Create a minimal mock stdio MCP server (a small script that speaks the MCP protocol) OR test the manager in isolation by mocking the Client/Transport. Since the MCP SDK is well-tested, testing the manager's state transitions and error handling is sufficient.
  - Test: spawn a non-existent command, verify server marked as "failed" with error (AC6.6)
  - Test: verify `terminateAll()` on an empty manager doesn't throw (AC6.7)

- boundless.AC6.6: Configure two servers, one with an invalid command. Verify the valid server's tools are still enumerated while the failed one is marked "failed".

**Verification:**
Run: `bun test packages/less/src/__tests__/mcp-manager.test.ts`
Expected: All tests pass

**Commit:** `feat(less): MCP server lifecycle manager with non-fatal error handling`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: MCP tool call proxy

**Verifies:** boundless.AC6.3

**Files:**
- Create: `packages/less/src/mcp/proxy.ts`
- Test: `packages/less/src/__tests__/mcp-proxy.test.ts`

**Implementation:**

Export `proxyToolCall(manager: McpServerManager, prefixedName: string, args: Record<string, unknown>, signal: AbortSignal, hostname: string): Promise<ContentBlock[]>`.

1. **Lookup prefixed name**: Do NOT parse the prefixed name with regex — server names may contain underscores, making regex ambiguous. Instead, `buildToolSet` (Phase 3) must maintain a reverse mapping `Map<string, { serverName: string, toolName: string }>` from prefixed names to (server, tool) pairs. Pass this mapping as a parameter:
   ```ts
   const mapping = toolNameMapping.get(prefixedName);
   if (!mapping) return errorResult("Unknown tool: " + prefixedName);
   const { serverName, toolName } = mapping;
   ```

2. **Lookup server**: get the server's Client from the manager. If server not running, return error ContentBlock.

3. **Call tool**: `client.callTool({ name: toolName, arguments: args })`.

4. **Map MCP result to ContentBlock[]** (AC6.3):
   - MCP text content → `{ type: "text", text: item.text }`
   - MCP image content → `{ type: "image", source: { type: "base64", media_type: item.mimeType, data: item.data } }`
   - Unknown types → `{ type: "text", text: "[unsupported MCP content type: ${item.type}]" }` (graceful degradation)
   - Prepend MCP provenance block via `formatMcpProvenance(hostname, serverName, toolName)`

5. **Error handling**: if `result.isError`, mark the first text block or create an error text block.

**Testing:**

- boundless.AC6.3: Mock the MCP Client.callTool to return known content, verify ContentBlock[] mapping is correct for text and image types. Verify provenance block is prepended.

**Verification:**
Run: `bun test packages/less/src/__tests__/mcp-proxy.test.ts`
Expected: All tests pass

**Commit:** `feat(less): MCP tool call proxy with ContentBlock mapping`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: allowTools filtering and confirm gating

**Verifies:** boundless.AC6.4, boundless.AC6.5

**Files:**
- Modify: `packages/less/src/tools/registry.ts` (add filtering and gating)
- Test: `packages/less/src/__tests__/registry.test.ts` (extend existing tests)

**Implementation:**

1. **`allowTools` filtering** (AC6.4): In `buildToolSet`, when processing MCP tools for a server:
   - If the server config has `allowTools: string[]`, filter the enumerated tools to only include those in the whitelist
   - Tools not in `allowTools` are excluded from the merged set

2. **`confirm` gating** (AC6.5): In `buildToolSet`, when processing MCP tools:
   - If the server config has `confirm: string[]`, wrap matching tool handlers with a confirmation gate
   - The gate calls a `confirmFn: (toolName: string) => Promise<boolean>` callback before execution
   - If the user declines ("no"), return `isError: true` with message "Tool call declined by user"
   - The `confirmFn` is provided by the TUI layer (Phase 7) — for now, accept it as a parameter to `buildToolSet`

3. Update `buildToolSet` signature:
   ```ts
   buildToolSet(
       cwd: string,
       hostname: string,
       mcpTools?: Map<string, { tools: Tool[], config: McpServerConfig }>,
       confirmFn?: (toolName: string) => Promise<boolean>,
   )
   ```

**Testing:**

- boundless.AC6.4: Provide an MCP server with tools ["read", "write", "delete"], set `allowTools: ["read", "write"]`, verify "delete" is excluded
- boundless.AC6.5: Provide a tool matching `confirm` pattern, mock confirmFn to return false, verify tool call returns isError

**Verification:**
Run: `bun test packages/less/src/__tests__/registry.test.ts`
Expected: All tests pass

**Commit:** `feat(less): allowTools filtering and confirm gating for MCP tools`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Hot-reload support

**Verifies:** boundless.AC6.8

**Files:**
- Modify: `packages/less/src/mcp/manager.ts` (add reload method)
- Test: `packages/less/src/__tests__/mcp-manager.test.ts` (extend)

**Implementation:**

Add `async reload(newConfigs: McpServerConfig[])` to `McpServerManager`:

1. Diff old vs new server configs by name:
   - **Added**: new server name not in current state → spawn/connect
   - **Removed**: current server not in new configs → terminate
   - **Changed**: config differs (command, url, enabled, etc.) → terminate old, spawn new
   - **Unchanged**: skip

2. For disabled servers in new configs: terminate if running.
3. For enabled servers: spawn if not running.
4. Return `{ added: string[], removed: string[], changed: string[], failed: string[] }` for TUI display.

The caller (TUI hook in Phase 7) is responsible for:
- Calling `reload()` with new configs
- Rebuilding the tool list via `buildToolSet()`
- Re-sending `session:configure` to the server
- Persisting the new config to `mcp.json`

**Testing:**

- boundless.AC6.8: Start with config [A, B], reload with [B, C], verify A terminated, B unchanged, C started. Also test enable/disable transitions.

**Verification:**
Run: `bun test packages/less/src/__tests__/mcp-manager.test.ts`
Expected: All tests pass

**Commit:** `feat(less): MCP hot-reload with diff-based server lifecycle`
<!-- END_TASK_4 -->
