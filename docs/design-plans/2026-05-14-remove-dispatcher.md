# Remove Dispatcher Task Design

## Summary

The dispatcher task is a dedicated system thread that auto-binds platform event subscriptions (e.g., Discord channels) and provides four specialized tools for managing connector handles. This design removes it entirely, redistributing its capabilities into two mechanisms. First, a unified `connector` tool replaces the four dispatcher-specific tools, using an action-dispatcher pattern (list/channels/attach/detach) that any user-facing thread can invoke on demand. Second, platform tools now carry MCP `annotations` from registration through discovery, with `readOnlyHint` marking safe read-only operations; the `platformToolResolver` uses these annotations to expose read-only platform tools (like `discord_list_channels`) to all user-facing threads without granting write access (like `discord_send_message`). Event task threads bound to a specific platform server continue to receive full tool access unchanged.

The result is a simpler tool scoping model: event task threads get their bound server's full tool set (unchanged), and all other threads get the connector tool plus any platform tools annotated `readOnlyHint: true`. No special-case dispatcher logic remains—the system treats event management as a normal agent capability rather than a privileged orchestrator pattern. Existing connector_handles and event tasks continue working without migration; the dispatcher task row remains in the database but never wakes again.

## Definition of Done

1. The dispatcher task, its seeding logic, its tools file, and all `connector:list_changed` event wiring are removed from the codebase
2. A unified `connector` tool (action-dispatcher pattern: list/channels/attach/detach) exists in `@bound/platforms`, registered as `kind: "builtin"`, available to all user-facing threads
3. Platform tools carry their MCP `annotations` through the discovery pipeline, and `platformToolResolver` uses `readOnlyHint` to grant user-facing threads access to read-only platform tools without exposing write tools
4. Event task threads retain their existing narrow tool scoping (full access to their one bound server's tools)
5. Existing connector_handles and event tasks continue working without migration

## Acceptance Criteria

### remove-dispatcher.AC1: Dispatcher code fully removed
- **remove-dispatcher.AC1.1 Success:** No references to DISPATCHER_TASK_ID, seedDispatcher, registerConnectorEventListeners, or isDispatcherThread exist in source
- **remove-dispatcher.AC1.2 Success:** No connector:list_changed event emission or handling exists in mcp-registry.ts or server.ts
- **remove-dispatcher.AC1.3 Success:** Build passes and all existing tests pass after removal

### remove-dispatcher.AC2: Connector tool available and functional
- **remove-dispatcher.AC2.1 Success:** `list` action returns all connected platform servers (local + cluster-wide from hosts.platforms)
- **remove-dispatcher.AC2.2 Success:** `channels` action returns events from a server annotated with bound/unbound status
- **remove-dispatcher.AC2.3 Success:** `channels` action falls back to remotePlatformRequest when server is not local
- **remove-dispatcher.AC2.4 Success:** `attach` action creates connector_handle, event task (type=event), and thread (interface=platform) with correct linkage
- **remove-dispatcher.AC2.5 Success:** `attach` action activates subscription immediately when local leader has the server
- **remove-dispatcher.AC2.6 Success:** `detach` action soft-deletes handle and associated task
- **remove-dispatcher.AC2.7 Failure:** `attach` returns error when handle already exists (idempotency check)
- **remove-dispatcher.AC2.8 Failure:** `detach` returns error when handle_id not found
- **remove-dispatcher.AC2.9 Failure:** `channels` returns error when server not found locally and no remote relay

### remove-dispatcher.AC3: Annotation-based tool filtering
- **remove-dispatcher.AC3.1 Success:** discord_list_channels is registered with readOnlyHint: true annotation
- **remove-dispatcher.AC3.2 Success:** discoverTools() preserves annotations from MCP listTools() response on PlatformRegisteredTool
- **remove-dispatcher.AC3.3 Success:** getReadOnlyPlatformTools() returns only tools where annotations.readOnlyHint === true
- **remove-dispatcher.AC3.4 Success:** User-facing threads receive readOnly platform tools + connector tool from platformToolResolver
- **remove-dispatcher.AC3.5 Failure:** User-facing threads do NOT receive write tools (discord_send_message, discord_respond_interaction)
- **remove-dispatcher.AC3.6 Edge:** Tools with no annotations (readOnlyHint defaults to false) are excluded from user-facing threads

### remove-dispatcher.AC4: Event task scoping preserved
- **remove-dispatcher.AC4.1 Success:** Event task threads with a connector handle receive all tools from their bound server
- **remove-dispatcher.AC4.2 Success:** Event task threads do NOT receive the connector tool or tools from other servers

### remove-dispatcher.AC5: Existing infrastructure unaffected
- **remove-dispatcher.AC5.1 Success:** Existing connector_handles rows continue to activate subscriptions at startup
- **remove-dispatcher.AC5.2 Success:** connector:event:{handleId} triggers still wake event tasks on delivery
- **remove-dispatcher.AC5.3 Success:** No DB migration required

## Glossary

- **Dispatcher task**: A dedicated system thread (pre-fix) that auto-binds platform event streams and provides four specialized management tools (`connector_list`, `connector_channels`, `connector_attach`, `connector_detach`). Runs with a deterministic UUID (`DISPATCHER_TASK_ID`) and wakes on `connector:list_changed` events.
- **Connector handle**: A database row in the `connector_handles` table that binds `(server_name, event_name, event_args)` to a task ID and delivery mode (push or poll). Represents an active event subscription.
- **Event task**: A task with `type="event"` linked to a connector handle. Wakes when its subscription delivers events via the `connector:event:{handleId}` trigger mechanism.
- **Platform connector**: An in-process MCP server (e.g., Discord) managed by `PlatformMcpRegistry`. Provides tools (send message, list channels) and event streams (message received, interaction received) to the agent.
- **MCP annotations**: Metadata attached to tools at registration time (`@modelcontextprotocol/sdk@1.27.1` supports `annotations?: ToolAnnotations` on `registerTool()`). Examples: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
- **`readOnlyHint`**: An MCP annotation indicating a tool performs read-only operations with no side effects. Used by `platformToolResolver` to grant user-facing threads safe platform access.
- **Action-dispatcher pattern**: A tool design where a single tool accepts an `action` enum parameter (e.g., "list" | "channels" | "attach" | "detach") and dispatches to per-action handlers. Used by existing tools like `memory` and `skill`.
- **Tool scoping**: The mechanism determining which tools are visible to a given thread. Pre-fix: three branches (dispatcher, event tasks, other threads). Post-fix: two branches (event tasks get scoped tools, all others get connector tool + read-only platform tools).
- **PlatformRegisteredTool**: A registered tool object representing a platform connector tool. Extended in this design to include an `annotations` field (previously dropped during `discoverTools()`).
- **remotePlatformRequest**: A closure passed to the connector tool context that proxies MCP requests to a remote platform host via the relay mechanism when the requested server is not locally available.

## Architecture

Remove the dispatcher task (a dedicated stateless orchestrator that auto-binds platform event streams) and redistribute its capabilities into two mechanisms:

1. **Unified `connector` tool** — a single action-dispatcher tool (list/channels/attach/detach) in `@bound/platforms` that any user-facing thread can invoke to manage event subscriptions on demand.
2. **Annotation-based tool filtering** — platform tools declare MCP `readOnlyHint` annotations at registration. The `platformToolResolver` uses these annotations to safely expose read-only platform tools (e.g., `discord_list_channels`) to all user-facing threads without granting write access (e.g., `discord_send_message`).

The tool scoping model simplifies from three branches to two:

- **Event task threads** (bound via connector_handle chain): receive all tools from their bound server (unchanged).
- **All other threads** (user-facing): receive the `connector` tool + any platform tools annotated `readOnlyHint: true`.

### Connector Tool Contract

```typescript
export interface ConnectorToolContext {
  registry: PlatformMcpRegistry;
  db: Database;
  siteId: string;
  remotePlatformRequest?: (
    serverName: string,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

// Action-dispatch schema
{
  action: "list" | "channels" | "attach" | "detach";
  server_name?: string;   // required for channels, attach
  event_name?: string;    // required for attach
  event_args?: Record<string, unknown>; // required for attach
  handle_id?: string;     // required for detach
}
```

### PlatformRegisteredTool Extension

```typescript
export interface PlatformRegisteredTool {
  kind: "platform" | "builtin";
  toolDefinition: ToolDefinition;
  execute?: (input: Record<string, unknown>) => Promise<string>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}
```

### platformToolResolver Contract

```typescript
// New resolver logic (replaces dispatcher-special-cased version)
(threadId: string) => RegisteredTool[]
// Returns:
//   Event task thread → scoped server tools (via getToolsForThread)
//   User-facing thread → getReadOnlyPlatformTools() + connectorTool
```

## Existing Patterns

**Action-dispatcher tool pattern** — `packages/agent/src/tools/memory.ts` uses a Zod schema with an `action` enum, exhaustive switch dispatch, and per-action parameter validation. The `connector` tool follows this pattern exactly.

**DispatcherTool interface** — `packages/platforms/src/dispatcher-tools.ts` defines a structurally-compatible interface (`kind`, `toolDefinition`, `execute`) that TypeScript's structural typing allows to be registered directly in the CLI layer's unified tool registry without importing `RegisteredTool` from `@bound/agent`. The connector tool reuses this approach.

**remotePlatformRequest closure** — `packages/cli/src/commands/start/scheduler.ts` already constructs a relay-based closure for proxying MCP requests to remote platform hosts. This closure moves from dispatcher tool context to connector tool context unchanged.

**MCP SDK annotations** — `@modelcontextprotocol/sdk@1.27.1` supports `annotations?: ToolAnnotations` on `registerTool()`. The SDK's `listTools()` response includes annotations, which are currently dropped during `discoverTools()`. This design preserves them.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Annotation Pipeline

**Goal:** Platform tools carry annotations from MCP server registration through discovery to the registered tool object.

**Components:**
- `packages/platforms/src/connectors/discord-server.ts` — add `annotations: { readOnlyHint: true }` to `discord_list_channels` registration
- `packages/platforms/src/mcp-registry.ts` — extend `PlatformRegisteredTool` with `annotations` field; preserve `tool.annotations` in `discoverTools()`
- `packages/platforms/src/mcp-registry.ts` — add `getReadOnlyPlatformTools()` method that filters by `annotations?.readOnlyHint === true`

**Dependencies:** None (first phase)

**Done when:** `discoverTools()` preserves annotations on registered tools, `getReadOnlyPlatformTools()` correctly returns only tools with `readOnlyHint: true`, tests verify both behaviors.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Connector Tool

**Goal:** A unified action-dispatcher tool replaces the 4 individual dispatcher tool factories.

**Components:**
- `packages/platforms/src/connector-tool.ts` — `createConnectorTool(ctx: ConnectorToolContext)` factory returning a single tool with list/channels/attach/detach actions
- Zod schema with action enum and per-action optional parameters
- Execute bodies lifted from existing `dispatcher-tools.ts` functions

**Dependencies:** Phase 1 (uses registry for list/channels actions)

**Done when:** All 4 actions work correctly (list returns servers, channels returns annotated events, attach creates handle+task+thread, detach soft-deletes handle+task), tests cover success and error cases for each action.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Tool Resolver Rewrite

**Goal:** Replace the dispatcher-special-cased `platformToolResolver` with the two-branch annotation-filtered version.

**Components:**
- `packages/cli/src/commands/start/scheduler.ts` — rewrite `platformToolResolver` callback: event task threads get scoped tools, user-facing threads get readOnly tools + connector tool
- `packages/cli/src/commands/start/scheduler.ts` — create connector tool via `createConnectorTool()` with existing `remotePlatformRequest` closure
- Remove `isDispatcherThread()` usage from resolver

**Dependencies:** Phase 1 (getReadOnlyPlatformTools), Phase 2 (createConnectorTool)

**Done when:** User-facing threads receive connector tool + readOnly platform tools, event task threads receive their scoped server's full tool set, no dispatcher special-casing remains in the resolver.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Dispatcher Removal

**Goal:** Remove all dispatcher-related code and wiring.

**Components:**
- Delete `packages/platforms/src/dispatcher.ts`
- Delete `packages/platforms/src/dispatcher-tools.ts`
- `packages/platforms/src/mcp-registry.ts` — remove `notifications/events/list_changed` → `connector:list_changed` event emission, remove `registerConnectorEventListeners()` export, remove `isDispatcherThread()`
- `packages/cli/src/commands/start/server.ts` — remove `seedDispatcher()` call, remove synthetic `connector:list_changed` startup emit
- `packages/platforms/src/index.ts` — remove all dispatcher-related exports
- Update or replace `packages/platforms/src/__tests__/dispatcher-tools.integration.test.ts`

**Dependencies:** Phase 3 (resolver no longer references dispatcher)

**Done when:** No references to `DISPATCHER_TASK_ID`, `seedDispatcher`, `registerConnectorEventListeners`, `isDispatcherThread`, or `connector:list_changed` remain in the codebase. Build passes, all tests pass.
<!-- END_PHASE_4 -->

## Additional Considerations

**Backward compatibility:** Existing `connector_handles` rows and their associated event tasks remain functional. The per-handle `connector:event:{handleId}` trigger mechanism is untouched — event tasks still wake when their subscription delivers events. The dispatcher task row in the DB is left as-is (not soft-deleted, not cleaned up).

**Future connectors:** When new platform connectors are added, they annotate their read-only tools with `readOnlyHint: true` at registration time. No changes to the resolver or connector tool are needed — the annotation filter picks them up automatically.
