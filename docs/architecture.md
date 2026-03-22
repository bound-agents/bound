# Bound System Architecture

## Overview

Bound is a distributed, model-agnostic personal agent system built as a Bun monorepo with 9 packages. All state lives in a SQLite database that replicates across hosts via an event-sourced sync protocol.

```
                         +------------------+
                         |   @bound/cli     |
                         |  init / start    |
                         +--------+---------+
                                  |
              +-------------------+-------------------+
              |                   |                   |
     +--------v--------+ +-------v--------+ +--------v--------+
     |  @bound/web     | | @bound/discord | |  @bound/agent   |
     |  Hono + Svelte  | | discord.js DM  | |  Loop + Sched   |
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
                      discord
                         |
                        cli  (imports all)
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
  PARSE_RESPONSE --> detect text vs tool_use
  |
  +-- text --> RESPONSE_PERSIST --> save assistant message
  |
  +-- tool_use --> TOOL_EXECUTE --> run command in sandbox
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
```

## Database Schema

13 STRICT tables in WAL mode:

| Table | Purpose | Reducer |
|-------|---------|---------|
| `users` | Operator and allowlisted users | LWW |
| `threads` | Conversation threads (web/discord) | LWW |
| `messages` | All messages (user, assistant, tool, alert, purge) | Append-only |
| `semantic_memory` | Key-value persistent memory | LWW |
| `tasks` | Scheduled/deferred/event-driven tasks | LWW |
| `files` | Virtual filesystem contents | LWW |
| `hosts` | Known hosts in the cluster | LWW |
| `overlay_index` | Content-addressed overlay file index | LWW |
| `cluster_config` | Cluster-wide settings (hub, emergency_stop) | LWW |
| `advisories` | Cost/frequency/model advisories | LWW |
| `change_log` | Event-sourced outbox for sync | Local only |
| `sync_state` | Per-peer replication cursors | Local only |
| `host_meta` | Local host identity (site_id, keys) | Local only |

Every write to a synced table also writes to `change_log` via the transactional outbox pattern, ensuring atomic event production.

## Key Design Decisions

**Event-sourced sync over CRDTs.** The change_log acts as an append-only event stream. LWW (last-writer-wins by `modified_at`) resolves conflicts for most tables. Messages use append-only (insert, never update) with dedup by ID.

**SQLite over Postgres/distributed DB.** Single-file database simplifies deployment. WAL mode enables concurrent reads. The sync protocol handles distribution.

**Sandbox isolation via just-bash.** The agent executes commands in a virtual filesystem (InMemoryFs), not on the real host. Network access is restricted to allowlisted URLs.

**OCC for filesystem persistence.** Pre-execution and post-execution snapshots are compared. If another writer modified a file between snapshot and persist, LWW timestamp resolution applies.

**Context assembly pipeline.** 8 stages transform raw message history into an optimized LLM prompt, handling purge substitution, tool pair sanitization, budget validation, and persona injection.

## Further Reading

- [Core Infrastructure](core-infrastructure.md) -- shared types, SQLite schema, DI container, config
- [Sync Protocol](sync-protocol.md) -- Ed25519 signing, reducers, three-phase sync
- [Sandbox and LLM](sandbox-and-llm.md) -- virtual filesystem, command framework, LLM drivers
- [Agent System](agent-system.md) -- agent loop, scheduler, commands, MCP bridge
- [Web and Discord](web-and-discord.md) -- HTTP API, WebSocket, Svelte UI, Discord bot
- [CLI and Operations](cli-operations.md) -- init, start, management commands, binary build
