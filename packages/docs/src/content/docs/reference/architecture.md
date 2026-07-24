---
title: Architecture
description: Package layout, data flow, and core design decisions for the Bound agent system.
---

Bound is a Bun workspace monorepo of 12 packages. All state lives in a SQLite database that replicates across hosts via an event-sourced sync protocol. Every interface — web UI, Discord, boundless terminal — talks to the same agent state.

## Package layout

| Package | Responsibility |
| --- | --- |
| `shared` | Types, events, `Result<T,E>`, Zod config schemas, HLC |
| `core` | SQLite schema, DI container, change-log outbox, repository layer, relay CRUD |
| `sync` | Ed25519 WS sync, XChaCha20 encryption, LWW/append reducers |
| `sandbox` | Virtual filesystem (InMemoryFs/ClusterFs), command framework |
| `llm` | Driver shims (Bedrock, OpenAI-compatible) over the Vercel AI SDK |
| `loop` | Reusable loop contracts, stream parsing, retry/timeout utilities |
| `agent` | Main-agent context pipeline, commands, scheduler, MCP bridge |
| `platforms` | MCP-based platform connectors (Discord), connector handles |
| `web` | Hono API + Svelte 5 SPA |
| `client` | `BoundClient` (HTTP + WS) for external consumers |
| `less` | Terminal coding-agent client (boundless) |
| `cli` | `bound` / `boundctl` / `boundless` binaries |

```
shared  <--  core  <--  sync
  ^           ^
  |           |
  +----+------+----------+
       |      |          |
    sandbox  llm       loop  <--  agent  <--  web
       ^      ^          ^          ^         ^
       |      |          |          |         |
       +------+----------+----------+---------+
                              |
                           platforms
                              |
                             cli  (imports all)
```

## Data flow

Every interface talks to the same agent state. Messages, memory, files, and tasks persist in SQLite and replicate between hosts over an encrypted WebSocket sync protocol. Inference routes cluster-wide to the appropriate backend and host, with fallback.

### Message processing

```
User sends message (web UI / Discord DM / boundless)
  |
  v
Persist to messages table + change_log
  |
  v
Agent Loop activates:
  HYDRATE_FS → load files into virtual filesystem
  ASSEMBLE_CONTEXT → 8-stage pipeline builds LLM prompt
  LLM_CALL → stream response from configured backend
  |
  +-- (remote model) → RELAY_STREAM → poll relay_inbox for stream chunks
  |
  PARSE_RESPONSE → detect text vs tool_use
  |
  +-- text → RESPONSE_PERSIST → save assistant message
  |
  +-- tool_use → TOOL_EXECUTE → run command in sandbox
                |
                +-- (remote MCP tool) → RELAY_WAIT → poll relay_inbox for result
                |
                v
              TOOL_PERSIST → save tool call + result
                |
                v
              Back to ASSEMBLE_CONTEXT (include tool result)
  |
  v
FS_PERSIST → OCC diff + write changed files to DB
  |
  v
QUEUE_CHECK → any new messages? loop or return to IDLE
```

### Sync protocol

```
Spoke                              Hub
  |                                 |
  |-- POST /sync/push [signed] --> |  (spoke sends its events)
  |                                |-- replay events via reducers
  |                                |-- update peer cursor
  |                                 |
  |-- POST /sync/pull [signed] --> |  (spoke requests hub's events)
  |                                |-- fetch with echo suppression
  | <-- changeset response --------|
  |-- replay events locally        |
  |                                 |
  |-- POST /sync/ack [signed] -->  |  (spoke confirms receipt)
  |                                 |
  |-- POST /sync/relay [signed]--> |  (exchange relay_outbox/inbox messages)
  | <-- relay response ------------|
```

### Relay transport

Cross-host operations (MCP tool calls, LLM inference, loop delegation) use a store-and-forward relay piggybacked on the sync cycle. The requesting host writes a message to `relay_outbox`; the sync cycle routes it to the target's `relay_inbox`; the target processes it and writes a response back the same way.

## Database schema

Bound uses 19+ STRICT tables in SQLite WAL mode. Synced tables use last-writer-wins (LWW) or append-only reducers to resolve conflicts. Local-only tables handle sync state, relay queues, and host identity.

Key synced tables: `users`, `threads`, `messages` (append-only), `semantic_memory`, `tasks`, `files`, `hosts`, `cluster_config`, `advisories`, `skills`, `memory_edges`, `connector_handles`, `webhooks`, `rss_feeds`, `client_sessions`, `turns`, `agents`.

Local-only tables: `change_log` (event outbox), `sync_state` (peer cursors), `host_meta` (identity), `relay_outbox`/`relay_inbox`/`relay_cycles` (relay transport), `dispatch_queue` (thread dispatch).

Every write to a synced table also writes to `change_log` via the transactional outbox pattern, ensuring atomic event production.

## Key design decisions

**Event-sourced sync over CRDTs.** The change log is an append-only event stream. LWW resolves conflicts for most tables by `modified_at` timestamp. Messages are append-only (insert, never update) with dedup by ID.

**SQLite over Postgres.** Single-file database, WAL mode for concurrent reads, sync protocol handles distribution. No external database process to manage.

**Sandbox isolation.** The agent executes commands in a virtual filesystem (`InMemoryFs`), not on the real host. Network access is restricted to allowlisted URLs. Writes never reach durable storage until persisted to the `files` table.

**OCC for filesystem persistence.** Pre-execution and post-execution snapshots are hash-compared. If another writer modified a file between snapshot and persist, LWW timestamp resolution applies.

**Context assembly pipeline.** An 8-stage pipeline transforms raw message history into an optimized LLM prompt — purge substitution, tool pair sanitization, budget validation, persona injection, volatile context enrichment, and stable orientation.

**Cluster-wide model resolution.** Each host advertises its available models. `resolveModel()` is a three-phase pipeline (identify → qualify → dispatch) with capability-aware routing — if the primary backend lacks required capabilities (vision, tool_use), it re-routes to eligible alternatives.

**Inference relay.** Remote LLM inference streams over the relay transport. The requesting host writes an inference relay message; the target streams `stream_chunk`/`stream_end` responses back. The agent loop enters `RELAY_STREAM` state, polling for chunks with monotonic `seq` reordering and per-host timeout failover.

**Ed25519 cryptographic identity.** Each host's site ID is derived from its Ed25519 public key. Keypairs stored at `data/host.key` (mode 0600) and `data/host.pub`. Sync handshakes are signed; subsequent frames are encrypted with XChaCha20-Poly1305 via ECDH-derived per-peer keys.

**One delegation path.** The loop always runs on the trigger host (the producer that received the message). The producer assembles context and relays only inference and tool calls — no consumer ever re-assembles context. Affinity (routing to the host that holds a session or tools) is an optimization, not a correctness requirement.
