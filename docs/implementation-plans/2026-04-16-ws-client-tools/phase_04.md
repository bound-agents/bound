# WebSocket Client Tools Implementation Plan — Phase 4

**Goal:** Wire the WS handler into the agent loop factory and `handleThread` so client tool definitions flow from WS connections into agent loop config. Remove the POST message endpoint.

**Architecture:** The WS handler (`createWebSocketHandler` in `websocket.ts`) is currently scoped locally in `createWebServer()` (start.ts line 67) and not accessible from `server.ts` where `handleThread` lives (line 271). A connection registry needs to be exported from the WS handler so `handleThread` can look up client tools by thread subscription. The `agentLoopFactory` (agent-factory.ts line 41) passes client tools through to `AgentLoopConfig`.

**Tech Stack:** Bun, TypeScript, Hono

**Scope:** 8 phases from original design (this is phase 4 of 8)

**Codebase verified:** 2026-04-16

---

## Acceptance Criteria Coverage

This phase implements infrastructure wiring only. AC1.2 (POST endpoint removal) is deferred to Phase 7 to avoid breaking the MCP server and web UI during intermediate phases.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Connection registry with client tool lookup

**Verifies:** None (infrastructure for AC1.2 and AC3 integration)

**Files:**
- Modify: `packages/web/src/server/websocket.ts` (export connection registry from `createWebSocketHandler`)

**Implementation:**

The `createWebSocketHandler()` currently returns a `WebSocketConfig` object with `open/message/close` handlers and a `cleanup()` method. Extend the return type to also expose a connection registry that `handleThread` can query.

1. **Export a `ConnectionRegistry` interface:**

   ```typescript
   export interface ConnectionRegistry {
       /** Find client tools registered by connections subscribed to a thread */
       getClientToolsForThread(threadId: string): Map<string, { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
       /** Get the connectionId of the connection that has a specific tool for a thread */
       getConnectionForTool(threadId: string, toolName: string): string | undefined;
   }
   ```

2. **Implement in `createWebSocketHandler`** — The function already maintains a `Map<ServerWebSocket, ClientConnection>` (line 24). Add methods that iterate connections:

   ```typescript
   function getClientToolsForThread(threadId: string): Map<string, ToolDef> {
       const merged = new Map<string, ToolDef>();
       for (const [, conn] of connections) {
           if (conn.subscriptions.has(threadId)) {
               for (const [name, def] of conn.clientTools) {
                   merged.set(name, def);
               }
           }
       }
       return merged;
   }

   function getConnectionForTool(threadId: string, toolName: string): string | undefined {
       for (const [, conn] of connections) {
           if (conn.subscriptions.has(threadId) && conn.clientTools.has(toolName)) {
               return conn.connectionId;
           }
       }
       return undefined;
   }
   ```

3. **Extend return type** — Return `{ ...wsConfig, registry: ConnectionRegistry }` from `createWebSocketHandler()`.

4. **Pass registry up** — In `createWebServer()` (start.ts line 67), capture the registry from the WS handler return value and expose it on the returned server object so the CLI start command can pass it to `handleThread`.

**Testing:**

Tests must verify:
- `getClientToolsForThread` returns tools from connections subscribed to the thread
- `getClientToolsForThread` merges tools from multiple connections subscribed to the same thread
- `getClientToolsForThread` returns empty map when no connections have tools for the thread
- `getConnectionForTool` returns the connectionId of the first matching connection

Add tests to: `packages/web/src/server/__tests__/websocket.test.ts`

**Verification:**
Run: `bun test packages/web`
Expected: All tests pass

**Commit:** `feat(web): connection registry with client tool lookup`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Wire client tools into agent loop factory and handleThread

**Verifies:** None (infrastructure wiring — end-to-end verified in integration)

**Files:**
- Modify: `packages/cli/src/commands/start/agent-factory.ts` (accept clientTools in factory invocation, line 41)
- Modify: `packages/cli/src/commands/start/server.ts` (resolve client tools in handleThread, line 271)
- Modify: `packages/cli/src/lib/message-handler.ts` (pass clientTools through runLocalAgentLoop)

**Implementation:**

1. **Agent loop factory** (agent-factory.ts) — The factory returns `(config: AgentLoopConfig) => AgentLoop`. Since `AgentLoopConfig` already gains `clientTools` in Phase 2, no changes to the factory itself are needed — it passes the full config through. The caller (`runLocalAgentLoop`) needs to include `clientTools` in the config.

2. **`runLocalAgentLoop`** (message-handler.ts) — Add `clientTools` to the parameters it accepts and passes to the factory:

   ```typescript
   export async function runLocalAgentLoop(params: {
       // ... existing params
       clientTools?: Map<string, ToolDef>;
       connectionId?: string;
   }): Promise<{ agentResult: ... }>
   ```

   Pass `clientTools` and `connectionId` through to the `AgentLoopConfig` when invoking the factory.

3. **`handleThread`** (server.ts line 271) — Before calling `runLocalAgentLoop` (line 384), resolve client tools from the connection registry:

   ```typescript
   // Resolve client tools from WS connections subscribed to this thread
   const clientTools = connectionRegistry?.getClientToolsForThread(thread_id);
   const connectionId = clientTools && clientTools.size > 0
       ? connectionRegistry?.getConnectionForTool(thread_id, clientTools.keys().next().value)
       : undefined;
   ```

   Pass `clientTools` and `connectionId` to `runLocalAgentLoop`.

4. **Pass `connectionRegistry` to server.ts** — The `initServer` function (or however server.ts receives its dependencies) needs access to the connection registry from the web server. Add it to the parameters passed from the CLI start command.

**Testing:**

Tests must verify:
- When `clientTools` is provided, the AgentLoopConfig includes them in the tool list
- When `clientTools` is undefined/empty, behavior is unchanged
- `handleThread` correctly resolves client tools from the registry for the thread being processed

Add integration-level tests to: `packages/cli/src/__tests__/` (or verify via the existing agent loop tests with mock registry)

**Verification:**
Run: `bun test packages/agent && bun test packages/cli`
Expected: All tests pass

**Commit:** `feat(cli): wire client tools from WS connections into agent loop`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- Note: POST endpoint removal (AC1.2) is deferred to Phase 7 Task 3 to avoid breaking MCP server and web UI during intermediate phases. -->
