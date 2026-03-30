# Bound System Architecture

## Overview

Bound is a distributed, model-agnostic personal agent system built as a Bun monorepo with 10 packages. All state lives in a SQLite database that replicates across hosts via an event-sourced sync protocol.

```
                         +------------------+
                         |   @bound/cli     |
                         |  init / start    |
                         +--------+---------+
                                  |
              +-------------------+-------------------+
              |                   |                   |
     +--------v--------+ +-------v--------+ +--------v--------+
     |  @bound/web     | | @bound/platforms | |  @bound/agent   |
     |  Hono + Svelte  | | connector fwk  | |  Loop + Sched   |
     +--------+--------+ +-------+--------+ +----+-------+----+
              |                   |               |       |
              +-------------------+-------+-------+       |
                                          |               |
                                 +--------v--------+  +---v-----------+
                                 |  @bound/sandbox | |  @bound/llm    |
                                 |  ClusterFs/Bash | |  4 LLM drivers |
                                 +--------+--------+ +---+------------+
                                          |               |
                              +-----------v---------------v-----------+
                              |            @bound/core                 |
                              |  SQLite  |  DI Container  |  Config   |
                              +-----------+---------------+-----------+
                                          |
                              +-----------v-----------+
                              |      @bound/shared    |
                              |  Types | Events | Zod |
                              +------------------------+
                                          |
                              +-----------v-----------+
                              |      @bound/sync      |
                              |  Ed25519 | HTTP Sync  |
                              +-----------+-----------+
```

## Package Dependency Graph

```
shared  <--  core  <--  sync
  ^           ^
  |           |
  +----+------+----------+
       |      |          |
    sandbox  llm       agent  <--  web
       ^      ^          ^         ^
       |      |          |         |
       +------+----------+---------+
                         |
                      platforms
                         |
                        cli  (imports all)

shared  <--  mcp-server              (standalone stdio binary)
```

## Data Flow

### Message Processing

```
User sends message (web UI / Discord DM)
  |
  v
Persist to messages table + change_log
  |
  v
Agent Loop activates:
  HYDRATE_FS --> load files into virtual filesystem
  ASSEMBLE_CONTEXT --> 8-stage pipeline builds LLM prompt
  LLM_CALL --> stream response from configured backend
  |
  +-- (remote model) --> RELAY_STREAM --> poll relay_inbox for stream_chunk/stream_end
  |
  PARSE_RESPONSE --> detect text vs tool_use
  |
  +-- text --> RESPONSE_PERSIST --> save assistant message
  |
  +-- tool_use --> TOOL_EXECUTE --> run command in sandbox
                    |
                    +-- (remote MCP tool) --> RELAY_WAIT --> poll relay_inbox for result
                    |
                    v
                  TOOL_PERSIST --> save tool_call + tool_result
                    |
                    v
                  Back to ASSEMBLE_CONTEXT (include tool result)
  |
  v
FS_PERSIST --> OCC diff + write changed files to DB
  |
  v
QUEUE_CHECK --> any new messages? loop or return to IDLE
```

### Sync Protocol

```
Spoke                              Hub
  |                                 |
  |-- POST /sync/push [signed] --> |  (spoke sends its events)
  |                                |-- replay events via reducers
  |                                |-- update peer cursor
  |                                |
  |-- POST /sync/pull [signed] --> |  (spoke requests hub's events)
  |                                |-- fetch with echo suppression
  | <-- changeset response --------|
  |-- replay events locally        |
  |                                |
  |-- POST /sync/ack [signed] -->  |  (spoke confirms receipt)
  |                                |-- update peer cursor
  |                                |
  |-- POST /sync/relay [signed]--> |  (exchange relay_outbox/inbox messages)
  | <-- relay response ------------|
  |                                |
```

### Relay Transport (Inference & Tool Calls)

Cross-host operations (MCP tool calls, LLM inference, loop delegation) use a store-and-forward relay piggybacked on the sync cycle:

```
Requester                          Hub                         Target
    |                               |                              |
    |-- writes relay_outbox ------->|                              |
    |                               |                              |
    |-- syncCycle() relay phase --> |                              |
    |                               |-- routes to target inbox --> |
    |                               |                              |-- RelayProcessor processes
    |                               |                              |-- writes relay_outbox (response)
    |                               |                              |
    |                               | <-- syncCycle() relay phase--|
    |                               |-- routes to requester inbox  |
    |                               |                              |
    | <-- syncCycle() relay phase---|                              |
    |-- reads relay_inbox           |                              |
```

Relay message kinds:
- **Request kinds:** `tool_call`, `resource_read`, `prompt_invoke`, `cache_warm`, `cancel`, `inference`, `process`, `intake`, `platform_deliver`, `event_broadcast`
- **Response kinds:** `result`, `error`, `stream_chunk`, `stream_end`, `status_forward`

`intake` routes inbound platform messages to the spoke with platform affinity. `platform_deliver` routes outbound assistant responses to the platform leader host. `event_broadcast` (target `*`) fans out custom events to all spokes.

## Database Schema

17 STRICT tables in WAL mode:

| Table | Purpose | Reducer |
|-------|---------|---------|
| `users` | Operator and allowlisted users | LWW |
| `threads` | Conversation threads (web/discord) | LWW |
| `messages` | All messages (user, assistant, tool, alert, purge) | Append-only |
| `semantic_memory` | Key-value persistent memory | LWW |
| `tasks` | Scheduled/deferred/event-driven tasks | LWW |
| `files` | Virtual filesystem contents | LWW |
| `hosts` | Known hosts in the cluster (includes `models` JSON array) | LWW |
| `overlay_index` | Content-addressed overlay file index | LWW |
| `cluster_config` | Cluster-wide settings (hub, emergency_stop) | LWW |
| `advisories` | Cost/frequency/model advisories | LWW |
| `skills` | Operator-defined skill prompts injected into agent context | LWW |
| `change_log` | Event-sourced outbox for sync | Local only |
| `sync_state` | Per-peer replication cursors | Local only |
| `host_meta` | Local host identity (site_id, keys) | Local only |
| `relay_outbox` | Pending relay messages to send to other hosts | Local only |
| `relay_inbox` | Received relay messages awaiting processing | Local only |
| `relay_cycles` | Per-cycle relay metrics (latency, success) | Local only |

Every write to a synced table also writes to `change_log` via the transactional outbox pattern, ensuring atomic event production. The three relay tables are local-only and use dedicated CRUD helpers (`writeOutbox`, `insertInbox`, `readUnprocessed`, `markProcessed`).

The `relay_outbox` and `relay_inbox` tables carry a nullable `stream_id TEXT` column used to correlate streaming inference chunks.

## Key Design Decisions

**Event-sourced sync over CRDTs.** The change_log acts as an append-only event stream. LWW (last-writer-wins by `modified_at`) resolves conflicts for most tables. Messages use append-only (insert, never update) with dedup by ID.

**SQLite over Postgres/distributed DB.** Single-file database simplifies deployment. WAL mode enables concurrent reads. The sync protocol handles distribution.

**Sandbox isolation via just-bash.** The agent executes commands in a virtual filesystem (InMemoryFs), not on the real host. Network access is restricted to allowlisted URLs.

**OCC for filesystem persistence.** Pre-execution and post-execution snapshots are compared. If another writer modified a file between snapshot and persist, LWW timestamp resolution applies.

**Context assembly pipeline.** 8 stages transform raw message history into an optimized LLM prompt, handling purge substitution, tool pair sanitization, budget validation, persona injection, and stable orientation (available commands, model info, host identity).

**MCP integration via @modelcontextprotocol/sdk.** Supports stdio and Streamable HTTP transports. Tools from connected servers are exposed via subcommand dispatch: one `CommandDefinition` per MCP server (named by server, e.g. `github`), with a `subcommand` parameter selecting the individual tool. This reduces LLM tool definition count and simplifies cross-host delegation tracking. Cross-host tool proxying uses the relay transport (`tool_call` relay kind). The standalone `bound-mcp` binary (`@bound/mcp-server`) exposes a `bound_chat` MCP tool over stdio, allowing external MCP clients to drive the agent; it depends only on `@bound/shared`, `@modelcontextprotocol/sdk`, and `zod`.

**Inference relay over store-and-forward.** Remote LLM inference uses the sync relay transport: the requester writes an `inference` relay message; the target streams `stream_chunk`/`stream_end` responses back via the same relay. The agent loop enters `RELAY_STREAM` state during remote inference, polling `relay_inbox` for chunks. Chunks carry a monotonic `seq` field for reordering. Failover retries on the next eligible host after a 120s per-host timeout.

**Cluster-wide model resolution.** Each host advertises its available models in `hosts.models` as `HostModelEntry[]` objects (with `id`, `tier`, and `capabilities`). `resolveModel()` is a three-phase pipeline (identify → qualify → dispatch) that supports capability-aware routing: if the primary backend lacks required capabilities (vision, tool_use, etc.), it re-routes to eligible alternatives. Returns `{ kind: "local" }`, `{ kind: "remote" }`, or `{ kind: "error" }` with `reason` (`"capability-mismatch"` | `"transient-unavailable"`), `unmetCapabilities`, and `earliestRecovery` fields. `ModelSelector` in the web UI shows all cluster models with relay/offline annotations.

**Loop delegation.** When a message targets a remote model on a single host that also serves ≥50% of the thread's recent tool calls, the originator writes a `process` relay message instead of running a local `AgentLoop`. The target's `RelayProcessor` starts the loop, forwards status via `status_forward`, and the response syncs back.

**Agent skills system.** Skills are operator-defined SKILL.md files stored in the `skills` table (synced via LWW). When a task's payload specifies a skill name, its body is injected as a system message into the context assembly pipeline. Skills include frontmatter with name, description, and activation triggers. Four built-in commands (`skill-activate`, `skill-list`, `skill-read`, `skill-retire`) manage the lifecycle. A bundled skill-authoring skill is seeded idempotently on startup via `seedSkillAuthoring()`.

**Ed25519 cryptographic identity.** Each host's site_id is derived from its Ed25519 public key (first 16 bytes of SHA-256, hex). Keypair stored at `data/host.key` (mode 0600) and `data/host.pub`.

## Further Reading

- [Core Infrastructure](core-infrastructure.md) -- shared types, SQLite schema, DI container, config
- [Sync Protocol](sync-protocol.md) -- Ed25519 signing, reducers, three-phase sync
- [Sandbox and LLM](sandbox-and-llm.md) -- virtual filesystem, command framework, LLM drivers
- [Agent System](agent-system.md) -- agent loop, scheduler, commands, MCP bridge
- [Web and Discord](web-and-discord.md) -- HTTP API, WebSocket, Svelte UI, Discord bot
- [CLI and Operations](../cli-operations.md) -- init, start, management commands, binary build
