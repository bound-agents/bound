# RFC: MCP Platform Connectors

**Supplements:** `2026-03-25-service-channel.md` (platform connectors), `web-and-discord.md` §3 (connector registry and leader election), `agent-system.md` §3 (built-in commands), `agent-system.md` §6.3 (platform silence semantics)
**Date:** 2026-05-08
**Status:** Implemented

---

## 1. Problem Statement

Bound's platform integration layer routes external conversation events (Discord messages, future Slack/Telegram messages) into agent loops and delivers outbound responses back to the originating platforms. The system must handle platform-specific semantics (message chunking, attachment handling, ephemeral interactions) while preserving the relay-based multi-host architecture and maintaining clean package boundaries. Platform tools must be scoped to the appropriate threads: event-task threads get full write access to their bound platform, while user-facing threads have limited read-only access for discovery and inspection.

Historical implementations used bespoke connector interfaces with automatic reply delivery. The current architecture unifies platform integration around the Model Context Protocol (MCP), exposing platforms as in-process MCP servers with typed event streams and standard tools. This RFC describes the implemented end state, consolidating three evolutionary design phases into a single coherent specification.

---

## 2. Proposal

### 2.1 Architecture Overview

Platform connectors are standard MCP servers implementing the Events extension specification. Each platform (Discord, future connectors) is wrapped as an MCP `Server` instance providing:

1. **Event streams** via `events/list`, `events/stream`, and `events/poll` for inbound platform events (message received, interaction received).
2. **Action tools** via `tools/list` and `tools/call` for outbound platform actions (send message, respond to interaction).
3. **Discovery tools** annotated with `readOnlyHint` for safe inspection by all user-facing threads (list channels, query metadata).

Connectors run in-process using `InMemoryTransport` (zero IPC cost). `PlatformMcpRegistry` manages server lifecycle, tool discovery, and event subscription activation. Leader election ensures only one host in a multi-host cluster instantiates platform servers and listens to external event sources.

### 2.2 Three-Layer Coordination

```
Layer 1: Connector Handle Registry (infrastructure, zero inference cost)
  - Manages active MCP event subscriptions via connector_handles table
  - Delivers events transparently across push/poll modes
  - Persists events as developer-role messages → fires event task triggers

Layer 2: Connector Tool (agent-accessible, on-demand coordination)
  - Unified action-dispatcher tool: list/channels/attach/detach
  - Available to all user-facing threads
  - Creates/removes connector handles and their associated event tasks

Layer 3: Event Tasks (agent-driven, per-conversation)
  - One task per connector handle
  - Thread with history retention
  - Full platform tools scoped to bound server (write access)
  - Processes event batches, responds via platform-specific tools
```

The system decouples infrastructure concerns (subscription management, event buffering, cursor persistence) from agent coordination (deciding which conversations to monitor) and per-conversation processing (responding to individual events).

### 2.3 Lifecycle Example: Discord DM

```
1. User sends DM to Discord bot
2. Discord MCP Server: gateway event → allowlist check → emit notifications/events/event
3. If no connector handle exists:
   - Event buffered in server's ring buffer
   - Server emits notifications/events/list_changed
   - User may ask agent to attach via connector tool (action: channels, then action: attach)
   - Agent calls connector tool → creates handle + event task + thread
   - Subscription activated → buffered events replayed via cursor
4. Connector Handle (infrastructure): buffers event, flushes batch
5. Persist as developer-role message (outbox) → fire connector:event:{handleId} trigger
6. Event task wakes → agent loop processes with platform tools → discord_send_message
7. Tool execute closure → mcpClient.callTool() → Discord API
8. Response appears in Discord
```

### 2.4 Tool Scoping Model

The system enforces two-branch tool scoping:

- **Event task threads** (bound via `connector_handles.task_id`): receive **all tools** from their bound server, including write tools (`discord_send_message`, `discord_respond_interaction`). Resolved via `thread → task → connector_handle → server_name` chain.
- **All other threads** (user-facing): receive the `connector` tool plus **read-only platform tools** annotated with `readOnlyHint: true` (`discord_list_channels`). No write access to external platforms.

Platform silence semantics: when an event task runs, no automatic reply is delivered. The agent must explicitly call the platform's send tool. If it never calls the tool, the user sees nothing. A system message injected into event task context explains this behavior.

### 2.5 Unified Connector Tool

The `connector` tool replaces dedicated dispatcher logic and provides four actions:

- **list**: Returns all connected platform servers (local + cluster-wide from `hosts.platforms`)
- **channels**: Returns available event types from a server, annotated with bound/unbound status. Falls back to `remotePlatformRequest` when server is not local leader.
- **attach**: Creates `connector_handle`, event task (type=event), and thread (interface=platform) with correct linkage. Activates subscription immediately when local leader has the server.
- **detach**: Soft-deletes handle and associated task.

Available to all user-facing threads as a `kind: "builtin"` tool. Follows the action-dispatcher pattern used by existing `memory` and `skill` tools.

### 2.6 Delivery Mode Transparency

Connector handles support two delivery modes:

- **Push (events/stream)**: Active stream reference. On `notifications/events/event`, appends to buffer. Periodic flush (or size threshold) → persist batch → fire trigger.
- **Poll (events/poll)**: Timer fires at `nextPollSeconds` interval (from server response). Calls `events/poll` with stored cursor. Empty response = no-op, no task wake.

From the event task's perspective, both modes produce identical behavior: a developer-role message appears containing the event batch, and the task wakes.

### 2.7 Leader Election and Failover

`PlatformLeaderElection` uses `cluster_config` LWW writes with heartbeat-based failover detection. Only the leader instantiates MCP servers and transport pairs. Standby hosts poll every `failover_threshold_ms / 3`. On failover:

1. New leader reads all non-deleted `connector_handles`
2. Reconstitutes subscriptions from stored cursors
3. Resumes event delivery from last persisted position

Cursor-based replay prevents duplicate event delivery when upstream supports it. The leader advertises `hosts.platforms` (JSON array of server names) for relay intake routing.

### 2.8 Relay Intake Integration

Multi-host clusters preserve relay intake routing. When an event batch is delivered, the infrastructure writes a relay inbox entry with `kind: "intake"` and `payload.platform` field. The hub's `selectIntakeHost()` routes intake to the host advertising the matching platform in `hosts.platforms` (the leader). This ensures relay-based tool calls (`RelayProcessor.executeProcess()`) run on the host with active platform connections.

---

## 3. Requirements (EARS Format)

Requirements use the prefix `R-MPC` (MCP Platform Connectors).

### 3.1 Ubiquitous

**R-MPC1.** The system shall implement each platform connector as a standard MCP `Server` instance exposing `events/list`, `events/stream`, `events/poll`, `tools/list`, and `tools/call` endpoints per the MCP Events extension specification.

**R-MPC2.** The system shall connect MCP servers in-process using `InMemoryTransport`, with zero IPC overhead. Each platform's MCP server shall be instantiated by a factory function accepting a `PlatformConnectorConfig` and returning a configured `Server` instance.

**R-MPC3.** The system shall persist active event subscriptions in a synced `connector_handles` table with LWW reducer, keyed by deterministic UUID derived from `(server_name, event_name, event_args)` using stable JSON serialization. Each handle shall link to exactly one event task via `task_id`.

**R-MPC4.** The system shall manage connector handle lifecycle via a unified `connector` tool with four actions: `list` (returns all connected servers), `channels` (returns available events annotated with bound status), `attach` (creates handle + task + thread + subscription), and `detach` (soft-deletes handle and task). The tool shall be registered as `kind: "builtin"` and available to all user-facing threads.

**R-MPC5.** When `connector attach` is invoked, the system shall create a `connector_handle` row (outbox), an event task with `type="event"` and `trigger_spec="connector:event:{handleId}"`, and a thread with `interface="platform"` and history retention enabled. The subscription shall be activated immediately if the local host is the leader for that server.

**R-MPC6.** The system shall deliver event batches by persisting a developer-role message in the event task's thread (via outbox) and firing a `connector:event:{handleId}` trigger on the event bus. The event task shall wake and process the batch with full platform tools available.

**R-MPC7.** The system shall deduplicate events within an active subscription using the `eventId` field from `notifications/events/event`. Duplicate events shall be silently dropped before reaching `deliverBatch()`.

**R-MPC8.** The system shall filter bot-authored messages and non-allowlisted users at the MCP server event emission layer. Discord messages where `msg.author.bot === true` or where the author is not in `allowed_users` (when non-empty) shall never emit `notifications/events/event` notifications.

**R-MPC9.** The system shall handle Discord attachments inline: attachments under 1MB as base64 `ContentBlock` (type: image, source: base64), attachments 1MB or larger as `file_ref` ContentBlock with `file_id`, `filename`, and `size`. The event's `data` field shall contain the formatted `attachments` array.

**R-MPC10.** The system shall chunk Discord messages exceeding 2000 characters at appropriate boundaries (paragraph, line, word, or hard limit) within the `discord_send_message` tool. Each chunk shall be delivered as a separate `channel.send()` call. Typing indicators shall start before the first chunk and stop automatically on send.

**R-MPC11.** The system shall handle Discord interactions via a separate `interaction.received` event type with a 14-minute callback token TTL. The `discord_respond_interaction` tool shall edit the ephemeral reply if the token is valid, or return an error if expired.

**R-MPC12.** The system shall scope platform tools using a two-branch resolver: event task threads (bound via `thread → task → connector_handle → server_name` chain) receive all tools from their bound server; all other threads receive the `connector` tool plus platform tools annotated `readOnlyHint: true`. Write tools shall not be available to user-facing threads.

**R-MPC13.** The system shall annotate read-only platform tools with `annotations: { readOnlyHint: true }` at MCP server registration. `PlatformMcpRegistry.discoverTools()` shall preserve annotations on `PlatformRegisteredTool` objects. `getReadOnlyPlatformTools()` shall filter by `annotations?.readOnlyHint === true`.

**R-MPC14.** The system shall execute platform tool calls via closures that proxy to `mcpClient.callTool()`. The execute closure shall accept `input: Record<string, unknown>`, invoke `callTool({ name, arguments: input })`, and return the result text on success or an error string on failure.

**R-MPC15.** The system shall gate platform connector instantiation via leader election using `PlatformLeaderElection`. Only the leader shall call `registerServer()` and create InMemoryTransport pairs. Non-leader hosts shall have no active MCP servers, no platform tools, and no subscriptions.

**R-MPC16.** On leader failover, the new leader shall read all non-deleted `connector_handles` rows and reconstitute subscriptions with cursors. The `events/stream` request shall include `cursor: <stored_value>` to resume from the last persisted position.

**R-MPC17.** The system shall persist the event cursor after each successful batch delivery via `updateRow()` on the `connector_handle` row (outbox). The cursor shall advance monotonically with each batch.

**R-MPC18.** The system shall support transparent delivery modes (push and poll). Push-mode subscriptions shall buffer events from `notifications/events/event` and flush batches periodically. Poll-mode subscriptions shall call `events/poll` at `nextPollSeconds` intervals with the stored cursor. Both modes shall produce identical developer-role messages.

**R-MPC19.** When `events/poll` returns an empty `events` array, the system shall reschedule the poll timer but shall not persist a developer-role message, fire a trigger, or wake the event task (zero inference cost).

**R-MPC20.** The system shall advertise connected platform servers in `hosts.platforms` (JSON array of server names) via `updateRow()` at startup. Relay intake routing shall use this field for platform affinity: intake payloads with `platform: "discord"` shall route to the host advertising `["discord"]` in its platforms array.

**R-MPC21.** The system shall preserve existing `platforms.json` config schema unchanged. The config shall parse via `platformsConfigSchema` with fields: `platform`, `token`, `allowed_users`, `leadership`, `failover_threshold_ms`. Unknown keys shall fail parse (strict mode).

**R-MPC22.** The system shall inject a platform silence system message into event task context when `platformContext: { platform }` is set. The message shall explain that the user only sees messages sent via the platform's send tool and that no delivery occurs if the tool is never called.

**R-MPC23.** The system shall suppress automatic reply delivery in `RelayProcessor.executeProcess()` when `payload.platform` is non-null. Event task threads shall rely entirely on explicit platform tool calls for outbound delivery.

### 3.2 State-Driven

**R-MPC24.** When a connector handle exists for `(server_name, event_name, event_args)`, the system shall annotate that event type with `bound: true` in the `connector channels` response. Event types without handles shall be annotated `bound: false`.

**R-MPC25.** When `connector attach` is invoked for an already-bound `(server, event, args)` tuple (same deterministic ID), the system shall return an error without creating duplicate handle, task, or thread rows.

**R-MPC26.** When `connector detach` is invoked with a valid `handle_id`, the system shall soft-delete both the `connector_handle` row and its linked task (via outbox). Subsequent events from that subscription shall not wake the task.

### 3.3 Optional

**R-MPC27.** The system may emit `notifications/events/list_changed` from MCP servers when new conversations become available (e.g., new Discord DM users). This notification is informational and does not trigger automatic subscription creation.

**R-MPC28.** The `connector channels` action may fall back to `remotePlatformRequest` when the requested server is registered on a remote leader host. The remote request shall proxy the MCP `events/list` call via the relay mechanism and return the annotated result.

### 3.4 Acceptance Criteria

**AC1: Platform events arrive as MCP Events and persist correctly**

- AC1.1: Discord DM received → MCP server emits `notifications/events/event` with correct eventId, name, timestamp, data, cursor
- AC1.2: Event persisted as `role: "developer"` message in correct event task thread via outbox
- AC1.3: Duplicate event (same eventId) not persisted twice
- AC1.4: Bot's own messages never emitted as events
- AC1.5: Messages from non-allowlisted users never emitted as events
- AC1.6: Attachments under 1MB included as base64 ContentBlocks
- AC1.7: Attachments 1MB or larger stored as file_ref ContentBlocks

**AC2: Agent uses platform tools for outbound actions**

- AC2.1: `discord_send_message` sends content to correct Discord channel
- AC2.2: Messages over 2000 chars chunked at appropriate boundaries
- AC2.3: Typing indicator starts before send, stops automatically
- AC2.4: `discord_respond_interaction` edits ephemeral reply for valid callback_id
- AC2.5: `discord_respond_interaction` returns error for expired callback_id
- AC2.6: Tool execute closure proxies to MCP `callTool` and returns result

**AC3: Tool scoping enforced correctly**

- AC3.1: Event task thread receives all tools from bound server only
- AC3.2: User-facing threads receive connector tool + read-only platform tools (annotated `readOnlyHint: true`)
- AC3.3: User-facing threads do NOT receive write tools (send/respond tools)
- AC3.4: Tool scoping resolves through thread → task → handle → server_name chain

**AC4: Connector tool actions work correctly**

- AC4.1: `list` action returns all connected platform servers (local + cluster-wide)
- AC4.2: `channels` action returns events annotated with bound/unbound status
- AC4.3: `channels` falls back to `remotePlatformRequest` when server not local
- AC4.4: `attach` creates handle + event task + thread with correct linkage
- AC4.5: `attach` activates subscription immediately when local leader has server
- AC4.6: `attach` returns error when handle already exists (idempotency)
- AC4.7: `detach` soft-deletes handle and task
- AC4.8: `detach` returns error when handle_id not found

**AC5: Delivery mode transparency**

- AC5.1: Push-mode subscription delivers events via `notifications/events/event` → batch → trigger
- AC5.2: Poll-mode timer calls `events/poll` at server-specified interval
- AC5.3: Poll with no new events produces no inference cost (no task wake)
- AC5.4: Both modes produce identical developer-role messages
- AC5.5: Cursor persisted after each successful batch delivery

**AC6: Leader election and failover**

- AC6.1: Only leader host instantiates MCP servers and transport pairs
- AC6.2: Non-leader hosts have no MCP servers, no platform tools, no subscriptions
- AC6.3: On failover, new leader reconstitutes subscriptions from connector_handles with correct cursors
- AC6.4: Replayed events resume from stored cursor (no duplicates)
- AC6.5: `hosts.platforms` advertised correctly for relay platform affinity routing

**AC7: Relay intake preserved**

- AC7.1: Event delivery writes relay intake entries with platform field
- AC7.2: Hub routes intake to host with platform affinity (leader)
- AC7.3: `RelayProcessor.executeProcess()` injects platform tools from registry

**AC8: Config and legacy cleanup**

- AC8.1: Existing `platforms.json` config loads without modification
- AC8.2: All packages typecheck clean

---

## 4. Implementation Notes

### 4.1 Schema

```sql
CREATE TABLE IF NOT EXISTS connector_handles (
  id            TEXT PRIMARY KEY,      -- deterministicUUID(server, event, args)
  server_name   TEXT NOT NULL,
  event_name    TEXT NOT NULL,
  event_args    TEXT NOT NULL,         -- JSON.stringify(args)
  delivery_mode TEXT NOT NULL,         -- "push" | "poll"
  cursor        TEXT,                  -- opaque position token from MCP server
  task_id       TEXT,                  -- links to tasks.id
  created_at    TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  modified_at   TEXT NOT NULL
) STRICT;

-- Index for task -> handle resolution in tool scoping
CREATE INDEX IF NOT EXISTS idx_connector_handles_task 
  ON connector_handles(task_id) WHERE deleted = 0;
```

Added to `TABLE_REDUCER_MAP` with `"LWW"` reducer. Added to `SYNCED_TABLE_NAMES` array. Added to `SNAPSHOT_TABLE_ORDER` in sync transport.

### 4.2 MCP Server Factory Pattern

Each platform exports a factory function:

```typescript
export function createDiscordServer(config: PlatformConnectorConfig): Server;
```

The factory instantiates a Discord.js client, wires gateway event handlers (`messageCreate`, `interactionCreate`), registers MCP event and tool handlers, and returns a standard MCP `Server` instance. The server is stateless except for in-memory interaction tokens (keyed by callback_id, TTL 14 minutes).

### 4.3 Deterministic Handle IDs

Connector handle IDs are computed as:

```typescript
import stableStringify from "json-stable-stringify";
import { deterministicUUID } from "@bound/shared";

const key = stableStringify({ server: serverName, event: eventName, args: eventArgs });
const handleId = deterministicUUID(BOUND_NAMESPACE, key);
```

Stable serialization prevents key-ordering variations from creating duplicate handles. The same `(server, event, args)` tuple always produces the same UUID.

### 4.4 Annotation Pipeline

Platform tools carry MCP `annotations` from registration through discovery:

1. MCP server calls `server.registerTool({ name, annotations: { readOnlyHint: true }, ... })`
2. `PlatformMcpRegistry.discoverTools()` calls `client.listTools()` and stores result with annotations
3. `getReadOnlyPlatformTools()` filters `tools.filter(t => t.annotations?.readOnlyHint === true)`
4. Tool scoping resolver injects filtered set into user-facing threads

Write tools omit `readOnlyHint` (defaults to false) and are excluded from read-only set.

### 4.5 Connector Tool Context

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

export function createConnectorTool(ctx: ConnectorToolContext): RegisteredTool;
```

The `remotePlatformRequest` closure is provided by the relay processor and proxies MCP requests to remote leaders when the local host is not the leader for the requested server. Used by `channels` action for cross-host discovery.

### 4.6 Platform Silence Injection

When `params.platformContext` is set, `assembleContext()` injects a system message:

```
You are running in a platform event context (platform: discord). The user cannot see your responses unless you explicitly send them using the discord_send_message tool. If you do not call that tool, the user will see nothing. Use the tool intentionally to control what the user observes.
```

This explains the silence semantics and is excluded from message history (volatile context only).

### 4.7 Delivery Timing

Platform tool executes (`discord_send_message`, `discord_respond_interaction`) invoke Discord API calls synchronously within the tool execution phase. Messages are delivered mid-turn, in the order tool calls are processed by the agent loop. This matches existing serial tool execution behavior.

### 4.8 Sequencing Notes

The system was implemented in seven phases:

1. Infrastructure foundation: `connector_handles` table, stable serialization, `PlatformMcpRegistry` skeleton
2. Discord MCP server: factory, event/tool handlers, gateway wiring, attachment handling
3. Connector handle lifecycle: subscription manager, poll driver, batch delivery, cursor persistence
4. Connector tool: action-dispatcher tool with list/channels/attach/detach
5. Tool scoping: annotation-based filtering, resolver rewrite, execute closures
6. Relay integration and leader election: startup wiring, intake routing, failover reconnection
7. Annotation pipeline: `readOnlyHint` propagation from MCP registration through tool discovery

The dispatcher task (dedicated system thread for auto-binding) was introduced in phase 4 and removed in a subsequent simplification. The unified `connector` tool replaced it, redistributing capabilities into a normal agent-accessible tool available to all user-facing threads.

---

## 5. Open Questions

None. This RFC documents the implemented end state.

---

## 6. Migration

No database migration required for existing connector_handles. The table schema includes all necessary columns from initial implementation. Existing handles activate subscriptions at startup via `PlatformMcpRegistry.reconnectAll()`.

The dispatcher task row (if present in production databases) remains but never wakes again. No cleanup required — the row is inert.

Config files (`platforms.json`) require no changes. The existing schema is preserved.

Multi-host clusters require synchronized deployment: all hosts must run the post-fix code that understands the annotation-based tool scoping and unified connector tool. Rolling deployment is safe (old hosts ignore new tool, new hosts handle both old and new message formats).

---

## 7. Glossary

- **MCP (Model Context Protocol)** — A standardized protocol for exposing resources, prompts, and tools to LLM applications, with an Events extension for event streaming.
- **MCP Events extension** — Extension adding `events/list`, `events/stream`, `events/poll` endpoints and `notifications/events/event`, `notifications/events/list_changed` notifications for push/poll event delivery.
- **InMemoryTransport** — An MCP transport connecting client and server in the same process without IPC overhead (no stdio, HTTP, or WebSocket).
- **Connector handle** — A persistent entity (synced table row) representing an active subscription to a platform event stream, keyed by `(server_name, event_name, event_args)`.
- **Event task** — A task with `type: "event"` that wakes when a specific event fires; each connector handle has one event task processing batches of platform events.
- **Connector tool** — Unified action-dispatcher tool (list/channels/attach/detach) available to all user-facing threads for managing event subscriptions on demand.
- **Platform tools** — MCP tools (e.g., `discord_send_message`) registered by platform servers, scoped to event task threads or available as read-only tools to user-facing threads based on `readOnlyHint` annotation.
- **Relay intake** — A relay message kind that routes platform events to the correct host in a multi-host cluster via platform affinity matching.
- **Leader election** — Mechanism ensuring only one host in a cluster instantiates each platform connector, using `cluster_config` LWW writes and heartbeat-based failover detection.
- **LWW (Last-Write-Wins)** — Conflict resolution strategy for synced tables where the most recent `modified_at` timestamp wins during merge.
- **Outbox pattern** — Write pattern where mutations to synced tables MUST use `insertRow()`, `updateRow()`, or `softDelete()` helpers to generate `change_log` entries for cross-host replication.
- **`role: "developer"`** — Message role for system-generated context injected into agent threads (events, notifications, volatile context); distinct from user/assistant/tool messages.
- **Cursor** — An opaque string token from the MCP server representing a position in an event stream, used for replay and deduplication after reconnection or failover.
- **Delivery mode** — Whether events arrive via `events/stream` (push) or `events/poll` (poll); connector handle infrastructure makes this transparent to event tasks.
- **Tool scoping** — Mechanism injecting platform tools into agent loops based on thread binding: event task threads get full tools from their bound server; user-facing threads get connector tool + read-only platform tools.
- **ContentBlock** — Union type for LLM message content: `text | tool_use | image | document`, used for inline image attachments under 1MB (base64) or 1MB or larger (file_ref).
- **Interaction** — Discord-specific ephemeral message type (slash command, context menu) with a 15-minute callback token; handled via separate `interaction.received` event type and `discord_respond_interaction` tool.
- **Stable JSON serialization** — Deterministic JSON stringification (via `json-stable-stringify`) used to compute connector handle IDs from `(server, event, args)` tuples; prevents duplicate handles from key-ordering variations.
- **Platform silence semantics** — Behavior where nothing is delivered to the platform user unless the agent explicitly calls the platform's send tool, explained via system message injection into event task context.
- **`readOnlyHint`** — MCP annotation marking a tool as read-only with no side effects; used by tool scoping resolver to safely expose platform discovery tools to all user-facing threads.
- **Action-dispatcher pattern** — Tool design where a single tool accepts an `action` enum parameter and dispatches to per-action handlers (e.g., `memory` tool with actions: add/recall/forget/search).
- **PlatformMcpRegistry** — Class managing platform connector lifecycle: instantiates MCP servers, creates InMemoryTransport pairs, discovers tools, activates subscriptions, and integrates with leader election.
- **remotePlatformRequest** — Closure provided to connector tool context that proxies MCP requests to remote platform hosts via relay mechanism when the requested server is not locally available.
