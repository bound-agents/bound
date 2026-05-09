# MCP Platform Connectors Design

## Summary

This design replaces Bound's existing `PlatformConnector` interface with MCP-based platform connectors built on the MCP Events extension specification. The Discord connector is reimplemented as a standard MCP Server that exposes typed events (via `events/list` and `events/stream`) for inbound platform messages and standard MCP tools for outbound actions. The system uses `InMemoryTransport` for zero-IPC-cost in-process operation, with a three-layer architecture: (1) connector handles manage active subscriptions and deliver events transparently across push/poll modes, (2) a dispatcher task discovers new conversations and creates subscriptions, and (3) per-conversation event tasks process incoming events using platform-scoped tools.

Platform tools are scoped to the thread bound to that platform conversation — other threads must use the `notify` tool to reach platform users indirectly. Leader election gates connector instantiation to ensure only one host listens to each platform at a time. The architecture preserves existing relay intake routing for multi-host clusters, maintains config file compatibility with `platforms.json`, and eliminates the legacy delivery verification system. The connector carries enough context in events for agents to use tools correctly without Bound needing to understand platform-specific semantics.

## Definition of Done

Replace bound's `PlatformConnector` interface with MCP-based connectors built against the MCP Events extension spec. The Discord connector becomes a unified MCP Server exposing typed events (`events/list`, `events/stream`) for inbound and standard MCP tools for outbound, connected via `InMemoryTransport` for zero-IPC-cost in-process operation. The architecture enables future externalization by swapping transports, but that is not in scope.

**Success criteria:**
- Inbound: Platform messages arrive as MCP events, persisted as `role: "developer"` messages, routed to per-conversation threads
- Outbound: Agent uses MCP tools (`discord_send_message`) registered as `kind: "platform"` native tools. Execute proxies to the MCP server's `CallTool`. Bound reads `ToolDefinition`s from the MCP server at connect time.
- Tool scoping: Platform tools are ONLY available in the thread bound to that platform conversation. Other threads that want to reach a platform user must use the `notify` tool targeting the platform thread. The platform thread is the gatekeeper for all platform I/O.
- Interactions: Separate event type with `response_callback_id`, connector exposes `respond_interaction` tool
- Behavior: DMs, interactions, attachments (inline), typing (within send tool only) all work from user perspective
- Config: `platforms.json` schema unchanged
- Infrastructure: Leader election gates connector instantiation, relay intake preserved, no users table linkage
- Connector carries enough context in events for agent to use tools correctly (opaque to bound)

**Excluded:**
- Delivery verification/nudge retry system (dropped — incompatible with new execution model)
- Stdio/subprocess externalization (future phase)
- Webhook delivery mode (future phase)
- Users table bridging (deferred — optional resolution tool later)

## Acceptance Criteria

### mcp-platform-connectors.AC1: Platform events arrive as MCP Events and persist correctly
- **mcp-platform-connectors.AC1.1 Success:** Discord DM received → MCP server emits `notifications/events/event` with correct eventId, name, timestamp, data, cursor
- **mcp-platform-connectors.AC1.2 Success:** Event persisted as `role: "developer"` message in the correct event task thread via outbox
- **mcp-platform-connectors.AC1.3 Success:** Duplicate event (same eventId) is not persisted twice
- **mcp-platform-connectors.AC1.4 Success:** Bot's own messages are never emitted as events
- **mcp-platform-connectors.AC1.5 Success:** Messages from non-allowlisted users are never emitted as events
- **mcp-platform-connectors.AC1.6 Success:** Attachments < 1MB included as base64 ContentBlocks in event data
- **mcp-platform-connectors.AC1.7 Success:** Attachments ≥ 1MB stored as file_ref in event data

### mcp-platform-connectors.AC2: Agent uses MCP tools for outbound platform actions
- **mcp-platform-connectors.AC2.1 Success:** `discord_send_message` sends content to correct Discord channel
- **mcp-platform-connectors.AC2.2 Success:** Messages > 2000 chars are chunked at appropriate boundaries
- **mcp-platform-connectors.AC2.3 Success:** Typing indicator starts and stops within `discord_send_message` execution
- **mcp-platform-connectors.AC2.4 Success:** `discord_respond_interaction` edits ephemeral reply for valid callback_id
- **mcp-platform-connectors.AC2.5 Failure:** `discord_respond_interaction` with expired callback_id returns error
- **mcp-platform-connectors.AC2.6 Success:** Tool execute closure proxies to MCP server's CallTool and returns result

### mcp-platform-connectors.AC3: Platform tools scoped to correct threads
- **mcp-platform-connectors.AC3.1 Success:** Event task thread receives platform tools for its bound connector only
- **mcp-platform-connectors.AC3.2 Success:** Dispatcher task receives tools from ALL connected platform servers
- **mcp-platform-connectors.AC3.3 Success:** Threads not bound to any connector handle receive no platform tools
- **mcp-platform-connectors.AC3.4 Success:** Tool scoping resolves through thread → task → connector handle → server_name chain

### mcp-platform-connectors.AC4: Dispatcher discovers and binds new conversations
- **mcp-platform-connectors.AC4.1 Success:** Dispatcher wakes on `notifications/events/list_changed` from MCP server
- **mcp-platform-connectors.AC4.2 Success:** `connector_channels` returns available event types with existing binding annotations
- **mcp-platform-connectors.AC4.3 Success:** `connector_attach` creates connector handle + event task + thread with history retention
- **mcp-platform-connectors.AC4.4 Failure:** `connector_attach` for already-bound (server, event, args) tuple returns error
- **mcp-platform-connectors.AC4.5 Success:** Newly attached subscription replays buffered events via cursor
- **mcp-platform-connectors.AC4.6 Success:** Periodic cron fallback wakes dispatcher even without list_changed

### mcp-platform-connectors.AC5: Delivery mode transparency
- **mcp-platform-connectors.AC5.1 Success:** Push-mode subscription receives events via `notifications/events/event` and delivers batch to task
- **mcp-platform-connectors.AC5.2 Success:** Poll-mode handle's timer calls `events/poll` at server-specified interval
- **mcp-platform-connectors.AC5.3 Success:** Poll with no new events produces no inference cost (no task wake)
- **mcp-platform-connectors.AC5.4 Success:** Both modes produce identical developer-role messages from event task's perspective
- **mcp-platform-connectors.AC5.5 Success:** Cursor persisted after each successful batch delivery

### mcp-platform-connectors.AC6: Leader election and failover
- **mcp-platform-connectors.AC6.1 Success:** Only leader host instantiates MCP server + transport pair
- **mcp-platform-connectors.AC6.2 Success:** Non-leader hosts have no MCP server, no platform tools, no subscriptions
- **mcp-platform-connectors.AC6.3 Success:** On failover, new leader reconstitutes subscriptions from connector_handles table with correct cursors
- **mcp-platform-connectors.AC6.4 Success:** Replayed events after failover resume from stored cursor (no duplicates if upstream supports replay)
- **mcp-platform-connectors.AC6.5 Success:** `hosts.platforms` advertised correctly for relay platform affinity routing

### mcp-platform-connectors.AC7: Relay intake preserved
- **mcp-platform-connectors.AC7.1 Success:** Event listener writes relay intake entries with platform field
- **mcp-platform-connectors.AC7.2 Success:** Hub routes intake to host with platform affinity (leader)
- **mcp-platform-connectors.AC7.3 Success:** `executeProcess()` injects platform tools from new registry

### mcp-platform-connectors.AC8: Config unchanged, legacy removed
- **mcp-platform-connectors.AC8.1 Success:** Existing `platforms.json` config loads without modification
- **mcp-platform-connectors.AC8.2 Success:** No references to old `PlatformConnector` interface remain in codebase
- **mcp-platform-connectors.AC8.3 Success:** `platform:deliver` and `platform:webhook` event types removed
- **mcp-platform-connectors.AC8.4 Success:** Webhook route `POST /hooks/:platform` removed
- **mcp-platform-connectors.AC8.5 Success:** All packages typecheck clean

## Glossary

- **MCP (Model Context Protocol)**: A standardized protocol for exposing resources, prompts, and tools to LLM applications, with an extension specification for event streaming.
- **MCP Events extension**: Extension to MCP that adds `events/list`, `events/stream`, `events/poll` endpoints and `notifications/events/event`, `notifications/events/list_changed` notifications for push/poll event delivery.
- **InMemoryTransport**: An MCP transport implementation that connects client and server in the same process without IPC overhead (no stdio, HTTP, or WebSocket).
- **Connector handle**: A persistent entity (synced table row) representing an active subscription binding to a platform event stream, keyed by `(server_name, event_name, event_args)`.
- **Event task**: A task with `type: "event"` that wakes when a specific event fires; each connector handle has one event task that processes batches of platform events.
- **Dispatcher task**: A system-level event-driven task that discovers new platform conversations (via `notifications/events/list_changed`) and creates connector handles + event tasks for them.
- **Platform tools**: MCP tools (e.g., `discord_send_message`) registered with `kind: "platform"`, scoped to threads bound to that platform connector.
- **Relay intake**: A relay message kind that routes platform events to the correct host in a multi-host cluster (preserved from existing system).
- **Leader election**: Mechanism that ensures only one host in a cluster instantiates each platform connector, using `cluster_config` LWW writes and heartbeat-based failover detection.
- **LWW (Last-Write-Wins)**: A conflict resolution strategy for synced tables where the most recent `modified_at` timestamp wins during merge.
- **Outbox pattern**: Write pattern where mutations to synced tables MUST use `insertRow()`, `updateRow()`, or `softDelete()` helpers to generate `change_log` entries for cross-host replication.
- **`role: "developer"`**: Message role for system-generated context injected into agent threads (events, notifications, volatile context); distinct from user/assistant/tool messages.
- **Cursor**: An opaque string token from the MCP server representing a position in an event stream, used for replay and deduplication.
- **Delivery mode**: Whether events arrive via `events/stream` (push) or `events/poll` (poll); connector handle infrastructure makes this transparent to event tasks.
- **Tool scoping**: The mechanism that injects only the platform tools from the connector bound to the current thread (resolved via thread → task → handle → server_name).
- **ContentBlock**: Union type for LLM message content: `text | tool_use | image | document`, used for inline image attachments < 1MB (base64) or ≥ 1MB (file_ref).
- **Interaction**: Discord-specific ephemeral message type (slash command, context menu) with a 15-minute callback token; handled via separate `interaction.received` event type and `discord_respond_interaction` tool.
- **Stable JSON serialization**: Deterministic JSON stringification (via `json-stable-stringify`) used to compute connector handle IDs from `(server, event, args)` tuples; prevents duplicate handles from key-ordering variations.

## Architecture

Three-layer architecture separating infrastructure concerns (no inference cost) from agent-driven coordination (inference only when needed):

```
Layer 1: Connector Handle Registry (infrastructure, zero inference)
  - Manages active MCP event subscriptions
  - Drives poll timers and stream listeners
  - Batches events → persists developer-role messages → fires event triggers
  - Delivery-mode transparent: push and poll produce identical output

Layer 2: Dispatcher Task (agent-driven, wakes on list_changed)
  - Discovers available event streams via connector tools
  - Creates connector handles + event tasks for new conversations
  - Has access to ALL platform MCP tools for introspection

Layer 3: Event Tasks (agent-driven, per-conversation)
  - One task per connector handle
  - Thread with history retention
  - Platform tools scoped to that connector
  - Processes event batches, responds via platform tools
```

### Component Interactions

**MCP Server (connector side):** Each platform exports a factory function returning a standard MCP `Server` instance. The server:
- Implements `events/list` — declares available event types with input schemas and payload schemas
- Implements `events/stream` — accepts subscriptions filtered by params, pushes `notifications/events/event`
- Implements `events/poll` — returns event batches with cursors for poll-mode delivery
- Exposes standard MCP tools (`tools/list` / `tools/call`) — platform actions like `discord_send_message`, `discord_respond_interaction`
- Emits `notifications/events/list_changed` when new conversations become available

**PlatformMcpRegistry (bound side):** Replaces `PlatformConnectorRegistry`. Creates `InMemoryTransport` pairs, connects MCP clients to servers, manages connector handle lifecycle, and integrates with leader election.

**Connector Handle:** Persistent entity (synced table, LWW) representing an active subscription binding. Keyed by `stableStringify(serverName, eventName, eventArgs)`. Links to exactly one event task. Infrastructure uses it to maintain stream/poll state and deliver events to the correct task.

### Data Flow

**Inbound (platform → agent):**
```
Discord gateway event
  → MCP Server: gate (allowlist), format, emit notifications/events/event
  → Connector Handle (infrastructure): buffer, flush batch
  → Persist as developer-role message in event task's thread (outbox)
  → Fire event trigger → event task wakes
  → Agent loop processes with platform tools → discord_send_message
```

**Outbound (agent → platform):**
```
Agent loop: tool_call("discord_send_message", { channel_id, content })
  → Tool registry (kind: "platform"): execute closure
  → mcpClient.callTool({ name: "discord_send_message", arguments: {...} })
  → MCP Server: sends Discord API call (includes typing start/stop)
  → Returns result string to agent
```

**Discovery (new conversation):**
```
MCP Server detects new DM user → emits notifications/events/list_changed
  → Dispatcher task wakes (event trigger)
  → Calls connector_channels("discord") → sees unbound conversation
  → Calls connector_attach("discord", "message.received", { channel_id: "..." })
  → Infrastructure: creates events/stream subscription + connector handle + event task
  → Buffered events replay → event task wakes
```

### Key Contracts

```typescript
// Factory function per platform (packages/platforms/src/connectors/)
type PlatformServerFactory = (config: PlatformConnectorConfig) => Server;

// Connector handle identity (deterministic, stable across restarts)
type ConnectorHandleId = string; // stableStringify({ server, event, args })

// Event batch delivered to task thread (developer-role message content)
// Format is connector-defined and opaque to bound infrastructure
type EventBatchContent = string;

// Tool registration from MCP server (read at connect time)
interface PlatformRegisteredTool {
  kind: "platform";
  toolDefinition: ToolDefinition;  // from MCP tools/list
  execute: (input: Record<string, unknown>) => Promise<BuiltInToolResult>;
}
```

```sql
-- New synced table (LWW reducer)
CREATE TABLE IF NOT EXISTS connector_handles (
  id            TEXT PRIMARY KEY,
  server_name   TEXT NOT NULL,
  event_name    TEXT NOT NULL,
  event_args    TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  cursor        TEXT,
  task_id       TEXT,
  created_at    TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  modified_at   TEXT NOT NULL
) STRICT;
```

### Dispatcher Task Tools

The dispatcher is a system-level event-driven task (seeded at startup, similar to heartbeat). Its custom tools:

- `connector_list()` — returns names of connected platform MCP servers
- `connector_channels(connector_name)` — calls `events/list` on the named server, annotates results with which (event_name, params) combinations already have connector handles
- `connector_attach(connector_name, event_name, event_args)` — creates `events/stream` subscription on the MCP server, creates connector handle row (outbox), creates event task with thread (history retention enabled), links handle to task. Fails if handle already exists for that key.

Additionally, the dispatcher has access to all platform MCP tools from all connected servers (e.g., Discord tools for listing guilds/channels to determine what to bind).

### Delivery Mode Transparency

The connector handle infrastructure handles delivery mode differences transparently:

- **Push (`events/stream`):** Active stream reference. On `notifications/events/event`, appends to buffer. Periodic flush (or size threshold) → persist batch → fire trigger.
- **Poll (`events/poll`):** Timer fires at `nextPollSeconds` interval (from server response). Calls `events/poll` with stored cursor. If events returned, same persist → trigger path. Empty response = no-op.

From the event task's perspective, both modes produce identical behavior: a developer-role message appears in the thread containing the event batch, and the task wakes to process it.

### Thread and Tool Scoping

Platform tools (from `tools/list`) are registered globally in the tool registry at MCP client connect time. However, they are only **injected into the agent loop** when:
1. The current thread belongs to an event task
2. That event task's connector handle references this MCP server

The relay processor checks: thread → task (via `tasks.thread_id`) → connector handle (via `connector_handles.task_id`) → `server_name`. Only that server's tools are included in the loop's tool set.

The dispatcher task is special-cased: it receives tools from ALL connected platform servers (it needs them for introspection/discovery).

## Existing Patterns

**Event-driven tasks:** The scheduler already supports `type: "event"` tasks with `trigger_spec` as the event name string. `scheduler.onEvent(eventType, payload)` queries for matching pending event tasks and executes them. Event depth tracking (max 5) prevents infinite loops. Connector handles fire event triggers through this existing mechanism.

**Heartbeat task seeding:** `seedHeartbeat()` in `packages/agent/src/task-resolution.ts` demonstrates system task seeding with deterministic UUID, custom context builder, and startup bootstrap. The dispatcher task follows this pattern.

**Leader election:** `PlatformLeaderElection` in `packages/platforms/src/leader-election.ts` uses `cluster_config` LWW writes with heartbeat-based failover detection. Standby hosts poll every `failover_threshold_ms / 3`. This mechanism is preserved unchanged.

**Tool registry dispatch:** `packages/cli/src/commands/start/agent-factory.ts` creates a unified `Map<string, RegisteredTool>` per loop invocation. Platform tools are tagged `kind: "platform"` and dispatch via their execute closure. This pattern is reused — the execute closure just proxies to `mcpClient.callTool()` instead of calling Discord.js directly.

**Relay intake:** The existing `writeOutbox(db, { kind: "intake", ... })` → hub routing → `executeProcess()` path is preserved. The intake payload shape changes slightly (no `user_id` since we dropped users table linkage) but the routing mechanism is identical.

**Deterministic IDs:** `deterministicUUID(namespace, name)` in `packages/shared/src/uuid.ts` produces stable UUIDs from string inputs. Connector handle IDs use this pattern with `stableStringify`'d inputs.

**No existing stable JSON serialization:** The codebase uses `JSON.stringify()` throughout. This design requires adding `json-stable-stringify` (or equivalent) as a dependency for deterministic connector handle key generation.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Infrastructure Foundation

**Goal:** New synced table, stable serialization dependency, and `PlatformMcpRegistry` skeleton with transport management.

**Components:**
- `connector_handles` table in `packages/core/src/schema.ts`
- `SyncedTableName` + `TABLE_REDUCER_MAP` entry in `packages/shared/src/types.ts`
- `SYNCED_TABLE_NAMES` entry in `packages/core/src/schema-introspection.ts`
- `SNAPSHOT_TABLE_ORDER` entry in `packages/sync/src/ws-transport.ts`
- `json-stable-stringify` dependency in `packages/platforms/package.json`
- `PlatformMcpRegistry` class in `packages/platforms/src/mcp-registry.ts` — constructor takes `AppContext` + `PlatformsConfig`, manages transport pair lifecycle and MCP client connections
- Connector handle persistence helpers (CRUD via outbox) in `packages/platforms/src/connector-handle.ts`

**Dependencies:** None (first phase)

**Done when:** Table exists in schema, registry can create/destroy InMemoryTransport pairs, connector handle rows can be written/read via outbox helpers, `json-stable-stringify` produces deterministic keys.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Discord MCP Server

**Goal:** Discord connector reimplemented as a standard MCP Server with events and tools.

**Components:**
- `createDiscordServer(config)` factory in `packages/platforms/src/connectors/discord-server.ts`
- Event handlers: `events/list` (declares `message.received`, `interaction.received`), `events/stream` (filtered subscriptions with cursor-based replay from Discord REST API)
- Tool handlers: `discord_send_message` (chunking at 2000 chars, typing start/stop within the tool), `discord_respond_interaction` (ephemeral editReply with 14-min TTL)
- Sender gating: allowlist filtering from `PlatformConnectorConfig.allowed_users`
- Attachment handling: images < 1MB as base64 ContentBlocks, ≥ 1MB as file_ref, inline in event payload
- `notifications/events/list_changed` emission when new DM conversations are detected
- Bot-message filtering (never emits events for messages authored by the bot itself)

**Dependencies:** Phase 1 (transport infrastructure)

**Done when:** MCP server connects via InMemoryTransport, responds to `events/list` and `tools/list`, streams events from Discord gateway, tools execute Discord API calls. Tests verify event emission, tool execution, sender gating, attachment handling, and bot-message filtering.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Connector Handle Lifecycle

**Goal:** Infrastructure that manages active subscriptions and delivers events to tasks transparently across delivery modes.

**Components:**
- Stream subscription manager in `PlatformMcpRegistry` — creates `events/stream` requests, handles `notifications/events/event`, buffers and flushes batches
- Poll driver in `PlatformMcpRegistry` — timer per poll-mode handle, calls `events/poll`, respects `nextPollSeconds`
- Batch delivery: persist developer-role message in task thread (outbox), fire event trigger via `eventBus.emit()`
- Reconnection from `connector_handles` table on leader failover (read all handles, reconstitute subscriptions with cursor)
- Cursor update on successful batch delivery (`updateRow` on connector handle)

**Dependencies:** Phase 1 (handle table + registry), Phase 2 (MCP server to subscribe to)

**Done when:** Push-mode events flow from MCP server → handle → developer-role message → event trigger fires. Poll-mode timer drives the same path. Failover reconstitutes subscriptions from DB state with correct cursor. Tests verify both modes, cursor advancement, and reconnection.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Dispatcher Task

**Goal:** Agent-driven discovery and subscription management via dedicated system task.

**Components:**
- Dispatcher task seeding in `packages/platforms/src/dispatcher.ts` (follows `seedHeartbeat` pattern, deterministic UUID, event-driven trigger on `connector:list_changed`)
- Dispatcher tools: `connector_list`, `connector_channels`, `connector_attach` — registered as `kind: "builtin"` tools scoped to the dispatcher task
- `connector_channels` calls `events/list` on the named server and annotates with existing handle state
- `connector_attach` creates handle + event task + thread (history retention) + starts subscription via registry
- Dispatcher wakes on `notifications/events/list_changed` (mapped to eventBus `connector:list_changed` event) and periodic cron fallback
- All platform MCP tools injected into dispatcher's loop (for introspection)

**Dependencies:** Phase 1 (registry), Phase 2 (server), Phase 3 (handle lifecycle)

**Done when:** Dispatcher wakes on list_changed, discovers new conversations via connector tools, attaches subscriptions that create handles + event tasks. Tests verify full discovery → attach → event delivery chain.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Tool Registration and Scoping

**Goal:** Platform MCP tools registered as native tools, scoped to appropriate threads.

**Components:**
- Tool discovery in `PlatformMcpRegistry` — calls `tools/list` at connect time, constructs `RegisteredTool` entries with `kind: "platform"` and execute closures that proxy to `mcpClient.callTool()`
- Tool refresh on `notifications/tools/list_changed`
- Scoping logic in relay processor's `executeProcess()` — checks thread → task → connector handle → server_name, injects only matching server's tools
- Dispatcher special case: receives all platform tools regardless of thread binding
- Update `AgentLoopConfig` — remove old `platformTools` field, tools come from registry filtering

**Dependencies:** Phase 2 (tools exist on server), Phase 4 (event tasks with thread bindings exist)

**Done when:** Platform tools appear in agent loop only for correct threads. Dispatcher gets all tools. Other threads see no platform tools. Execute closures successfully proxy to MCP server. Tests verify scoping, proxy execution, and refresh.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Relay Integration and Leader Election

**Goal:** Wire registry into startup, leader election gates instantiation, relay intake routes correctly.

**Components:**
- Bootstrap in `packages/cli/src/commands/start/server.ts` — create `PlatformMcpRegistry` (replacing old registry), wire into relay processor, seed dispatcher task, advertise `hosts.platforms`
- Leader election integration — only leader instantiates MCP servers + transports. Failover reconstitutes from `connector_handles`.
- Relay processor updates in `packages/agent/src/relay-processor.ts` — `executeProcess()` gets platform tools from new registry instead of old `getPlatformTools()`. Remove `verifyDelivery` post-loop check. Remove `deliverPlatformPayload` path.
- Intake path: registry's event listener writes relay intake entries with platform field. Hub routes via platform affinity (unchanged).
- Remove old `platform:deliver` and `platform:webhook` event bus handlers

**Dependencies:** Phases 1-5 (all core components ready)

**Done when:** Full startup sequence works with new registry. Leader election gates instantiation. Failover reconnects subscriptions. Relay intake routes platform messages correctly. Old `PlatformConnector` interface removed.
<!-- END_PHASE_6 -->

<!-- START_PHASE_7 -->
### Phase 7: Cleanup and Migration

**Goal:** Remove all legacy platform connector code, update config handling, clean package exports.

**Components:**
- Delete: `packages/platforms/src/connector.ts` (old interface), `packages/platforms/src/registry.ts` (old registry), `packages/platforms/src/connectors/discord.ts` (old DM connector), `packages/platforms/src/connectors/discord-interaction.ts`, `packages/platforms/src/connectors/discord-client-manager.ts`
- Delete: `platform:deliver` and `platform:webhook` event types from `packages/shared/src/events.ts`
- Delete: webhook route `POST /hooks/:platform` from `packages/web/`
- Update: `packages/platforms/src/index.ts` exports (new registry, new server factories)
- Update: `IntakePayload` type — remove `user_id` field
- Remove: `platformTools` from `AgentLoopConfig` type (legacy path)
- Remove: `deliverPlatformPayload`, `verifyDelivery` logic from relay processor

**Dependencies:** Phase 6 (new system fully operational)

**Done when:** No references to old `PlatformConnector` interface remain. Package compiles cleanly. All tests pass with new system. Typecheck clean across all packages.
<!-- END_PHASE_7 -->

## Additional Considerations

**Interaction TTL:** Discord interaction tokens expire at 15 minutes. The MCP server holds the interaction object in memory keyed by `callback_id`. If the event task takes too long to respond, `discord_respond_interaction` returns an error. No retry mechanism — the token is dead. The event task can detect this and potentially DM the user instead.

**Connector handle constraint enforcement:** The "one handle per (server, event, args)" constraint is enforced by the deterministic ID (same inputs = same primary key). The "one task per handle" constraint is enforced by `connector_attach` checking `task_id IS NOT NULL` before creating.

**Future externalization:** Swapping `InMemoryTransport` for `StdioServerTransport` requires: (1) moving the connector server factory to a standalone entry point, (2) updating `PlatformMcpRegistry` to spawn a subprocess and use `StdioClientTransport`. No protocol or schema changes needed. The connector handle table, dispatcher task, and event tasks are all transport-agnostic.

**`json-stable-stringify` vs alternatives:** The `json-stable-stringify` package handles edge cases around symbol keys, `toJSON` methods, and cyclic references. Using it (rather than a hand-rolled sort) prevents subtle key-ordering bugs that would create duplicate handles for the same logical subscription.

**Event batch content format:** The format of the developer-role message persisted for each batch is determined by the MCP server's event `data` field. Bound's infrastructure passes it through unchanged. The MCP server's `instructions` (added to system prompt) tells the agent how to interpret events and which tool arguments to extract from them.
