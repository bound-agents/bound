# MCP Platform Connectors Implementation Plan — Phase 5

**Goal:** Register platform MCP tools as native tools in the agent loop, with scoping that restricts tools to their bound thread via the thread → task → connector handle → server_name chain.

**Architecture:** `PlatformMcpRegistry` calls `tools/list` at connect time, constructs `RegisteredTool` entries with `kind: "platform"` and execute closures that proxy to `mcpClient.callTool()`. Scoping logic in the relay processor and server.ts resolves which tools belong to each thread by tracing through the connector handle. The dispatcher task is special-cased to receive ALL platform tools.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk (Client.listTools, Client.callTool), RegisteredTool interface

**Scope:** 7 phases from original design (phase 5 of 7)

**Codebase verified:** 2026-05-08

---

## Acceptance Criteria Coverage

This phase implements and tests:

### mcp-platform-connectors.AC2: Agent uses MCP tools for outbound platform actions
- **mcp-platform-connectors.AC2.6 Success:** Tool execute closure proxies to MCP server's CallTool and returns result

### mcp-platform-connectors.AC3: Platform tools scoped to correct threads
- **mcp-platform-connectors.AC3.1 Success:** Event task thread receives platform tools for its bound connector only
- **mcp-platform-connectors.AC3.2 Success:** Dispatcher task receives tools from ALL connected platform servers
- **mcp-platform-connectors.AC3.3 Success:** Threads not bound to any connector handle receive no platform tools
- **mcp-platform-connectors.AC3.4 Success:** Tool scoping resolves through thread → task → connector handle → server_name chain

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add tool discovery to PlatformMcpRegistry

**Verifies:** mcp-platform-connectors.AC2.6 (partially — tool registration with proxy closures)

**Files:**
- Modify: `packages/platforms/src/mcp-registry.ts`

**Implementation:**

After connecting to an MCP server, call `tools/list` to discover available tools and create `RegisteredTool` entries with execute closures that proxy to the server:

```typescript
// Add to PlatformMcpRegistry class:
private platformTools = new Map<string, Map<string, RegisteredTool>>(); // serverName → toolName → RegisteredTool

/**
 * Discovers tools from a connected MCP server and stores them.
 * Called after registerServer() connects the client.
 */
private async discoverTools(entry: PlatformServerEntry): Promise<void> {
  const result = await entry.client.listTools();
  const serverTools = new Map<string, RegisteredTool>();

  for (const tool of result.tools) {
    const registeredTool: RegisteredTool = {
      kind: "platform",
      toolDefinition: {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.inputSchema as Record<string, unknown>,
        },
      },
      execute: async (input: Record<string, unknown>) => {
        const callResult = await entry.client.callTool({
          name: tool.name,
          arguments: input,
        });
        // Convert MCP tool result to BuiltInToolResult (string)
        const textContent = callResult.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map(c => c.text)
          .join("\n");
        return callResult.isError
          ? `Error: ${textContent}`
          : textContent || "done";
      },
    };
    serverTools.set(tool.name, registeredTool);
  }

  this.platformTools.set(entry.name, serverTools);
  this.deps.logger.info(`Discovered ${serverTools.size} tools from server '${entry.name}'`);
}
```

Also register a handler for `notifications/tools/list_changed` to refresh the tool list:

```typescript
// In registerServer():
client.setNotificationHandler(
  { method: "notifications/tools/list_changed" },
  async () => {
    await this.discoverTools(entry);
  }
);
```

Call `discoverTools(entry)` at the end of `registerServer()`.

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): add tool discovery to PlatformMcpRegistry`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add tool retrieval methods to PlatformMcpRegistry

**Verifies:** mcp-platform-connectors.AC3.1, mcp-platform-connectors.AC3.2, mcp-platform-connectors.AC3.3

**Files:**
- Modify: `packages/platforms/src/mcp-registry.ts`

**Implementation:**

Add methods to retrieve tools with appropriate scoping:

```typescript
/**
 * Returns platform tools for a specific server (used for per-thread scoping).
 * Returns empty map if server not found.
 */
getToolsForServer(serverName: string): Map<string, RegisteredTool> {
  return this.platformTools.get(serverName) ?? new Map();
}

/**
 * Returns ALL platform tools from ALL servers (used for dispatcher task).
 */
getAllPlatformTools(): Map<string, RegisteredTool> {
  const all = new Map<string, RegisteredTool>();
  for (const [_serverName, tools] of this.platformTools) {
    for (const [toolName, tool] of tools) {
      all.set(toolName, tool);
    }
  }
  return all;
}

/**
 * Resolves which platform tools a thread should receive.
 * Traces: thread → task → connector_handle → server_name → tools
 * Returns empty map for threads not bound to any connector handle.
 */
getToolsForThread(threadId: string): Map<string, RegisteredTool> {
  // Find task that owns this thread
  const task = this.deps.db.query(
    "SELECT id, payload FROM tasks WHERE thread_id = ? AND type = 'event' AND deleted = 0 ORDER BY created_at DESC LIMIT 1"
  ).get(threadId) as { id: string; payload: string | null } | null;

  if (!task) return new Map(); // AC3.3: no event task → no platform tools

  // Find connector handle for this task
  const handle = this.deps.db.query(
    "SELECT server_name FROM connector_handles WHERE task_id = ? AND deleted = 0"
  ).get(task.id) as { server_name: string } | null;

  if (!handle) return new Map(); // AC3.3: no handle → no platform tools

  // AC3.1: return only this server's tools
  return this.getToolsForServer(handle.server_name);
}

// Performance note: at scale, add indexes:
// CREATE INDEX idx_tasks_thread_event ON tasks(thread_id) WHERE deleted = 0 AND type = 'event';
// CREATE INDEX idx_connector_handles_task ON connector_handles(task_id) WHERE deleted = 0;

/**
 * Checks if a thread belongs to the dispatcher task.
 */
isDispatcherThread(threadId: string): boolean {
  const task = this.deps.db.query(
    "SELECT id FROM tasks WHERE thread_id = ? AND id = ?"
  ).get(threadId, DISPATCHER_TASK_ID) as { id: string } | null;
  return task !== null;
}
```

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): add scoped tool retrieval to PlatformMcpRegistry`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Wire tool scoping into server.ts (spoke-side injection)

**Verifies:** mcp-platform-connectors.AC3.4

**Files:**
- Modify: `packages/cli/src/commands/start/server.ts` (replace old getPlatformTools path with new registry lookup)

**Implementation:**

In the section that resolves platform tools for a thread (around lines 495–575 of server.ts), replace the old connector-based lookup with the new registry-based scoping:

```typescript
// OLD: platformRegistry.getConnector(threadInterface)?.getPlatformTools(threadId)
// NEW: use PlatformMcpRegistry.getToolsForThread() or getAllPlatformTools()

let platformToolsForThread: Map<string, RegisteredTool> | undefined;

if (platformMcpRegistry) {
  if (platformMcpRegistry.isDispatcherThread(threadId)) {
    // AC3.2: Dispatcher gets ALL platform tools
    platformToolsForThread = platformMcpRegistry.getAllPlatformTools();
  } else {
    // AC3.4: Trace thread → task → handle → server → tools
    const tools = platformMcpRegistry.getToolsForThread(threadId);
    if (tools.size > 0) {
      platformToolsForThread = tools;
    }
  }
}
```

Convert the `Map<string, RegisteredTool>` to the `platformTools` format expected by `AgentLoopConfig`:

```typescript
if (platformToolsForThread && platformToolsForThread.size > 0) {
  const legacyMap = new Map<string, { toolDefinition: ToolDefinition; execute: (input: Record<string, unknown>) => Promise<string> }>();
  for (const [name, tool] of platformToolsForThread) {
    legacyMap.set(name, {
      toolDefinition: tool.toolDefinition,
      execute: async (input) => {
        const result = await tool.execute!(input);
        return typeof result === "string" ? result : JSON.stringify(result);
      },
    });
  }
  // Pass to agent loop config
}
```

**Dispatcher tool injection:** When the current task is the dispatcher (check `taskId === DISPATCHER_TASK_ID`), additionally inject the three dispatcher-specific tools (`connector_list`, `connector_channels`, `connector_attach`) into the tool registry alongside all platform tools. The dispatcher tools are created via their factory functions in `packages/platforms/src/dispatcher-tools.ts` and passed the registry as context:

```typescript
if (taskId === DISPATCHER_TASK_ID) {
  // Dispatcher gets ALL platform tools + dispatcher-specific tools
  const dispatcherCtx = { registry: platformMcpRegistry, db: appContext.db, siteId: appContext.siteId };
  const dispatcherTools = [
    createConnectorListTool(dispatcherCtx),
    createConnectorChannelsTool(dispatcherCtx),
    createConnectorAttachTool(dispatcherCtx),
  ];
  for (const tool of dispatcherTools) {
    platformToolsForThread!.set(tool.toolDefinition.function.name, tool);
  }
}
```

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(cli): wire MCP platform tool scoping into server.ts`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Prepare relay processor for new registry (interface only)

**Verifies:** mcp-platform-connectors.AC3.4

**Files:**
- Modify: `packages/agent/src/relay-processor.ts` (add setter for PlatformMcpRegistry, prepare scoping logic)

**Implementation:**

**Note:** This task adds the setter method and scoping LOGIC to the relay processor. The actual live registry instance is not available until Phase 6 when `PlatformMcpRegistry` is bootstrapped in server.ts and passed via `relayProcessor.setPlatformMcpRegistry(registry)`. Until then, the new code path is guarded by `if (this.platformMcpRegistry)` and remains inert.

In `runDelegatedLoop()` (around lines 1571–1585), replace the old connector-based platform tool injection with the new registry path:

```typescript
// OLD:
// const connector = this.platformConnectorRegistry.getConnector(payload.platform);
// if (connector?.getPlatformTools) {
//   const platformTools = connector.getPlatformTools(payload.thread_id, this.fileReader);
//   loopConfig.platformTools = platformTools;
// }

// NEW:
if (this.platformMcpRegistry) {
  let tools: Map<string, RegisteredTool>;
  if (this.platformMcpRegistry.isDispatcherThread(payload.thread_id)) {
    tools = this.platformMcpRegistry.getAllPlatformTools();
  } else {
    tools = this.platformMcpRegistry.getToolsForThread(payload.thread_id);
  }

  if (tools.size > 0) {
    // Convert to legacy platformTools format for AgentLoopConfig
    const legacyMap = new Map();
    for (const [name, tool] of tools) {
      legacyMap.set(name, {
        toolDefinition: tool.toolDefinition,
        execute: async (input: Record<string, unknown>) => {
          const result = await tool.execute!(input);
          return typeof result === "string" ? result : JSON.stringify(result);
        },
      });
    }
    loopConfig.platformTools = legacyMap;
    loopConfig.platform = payload.platform;
  }
}
```

The relay processor will need a reference to `PlatformMcpRegistry` — add it as a constructor parameter or injected dependency.

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(agent): wire MCP platform tool scoping into relay processor`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_5 -->
### Task 5: Integration tests for tool scoping

**Verifies:** mcp-platform-connectors.AC2.6, mcp-platform-connectors.AC3.1, mcp-platform-connectors.AC3.2, mcp-platform-connectors.AC3.3, mcp-platform-connectors.AC3.4

**Files:**
- Create: `packages/platforms/src/__tests__/tool-scoping.integration.test.ts`

**Testing:**

Tests use a real temp DB, mock MCP server with tools, and verify scoping logic:

- **AC2.6**: Register server → discover tools → call execute closure → verify client.callTool() invoked and result returned correctly
- **AC3.1**: Create connector handle bound to "discord" server → call getToolsForThread(thread_id) → verify only discord tools returned (not tools from other servers)
- **AC3.2**: Create dispatcher task thread → call getToolsForThread or isDispatcherThread → verify getAllPlatformTools() used → all servers' tools included
- **AC3.3**: Query getToolsForThread for a thread with no event task → verify empty map returned. Query for a thread with event task but no connector handle → verify empty map returned.
- **AC3.4**: Set up full chain (thread → event task → connector handle → server) → verify getToolsForThread resolves correctly through the chain

Test setup:
- Temp DB with schema, two mock MCP servers ("discord", "slack") each with different tools
- Create threads, tasks, and connector handles to test scoping scenarios
- Verify tool isolation between servers

**Verification:**
Run: `bun test packages/platforms/src/__tests__/tool-scoping.integration.test.ts`
Expected: All tests pass.

**Commit:** `test(platforms): add tool scoping integration tests`
<!-- END_TASK_5 -->
