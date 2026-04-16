# Core Infrastructure

This document covers the two foundational packages in the Bound agent system: `@bound/shared` and `@bound/core`. Together they provide all shared type definitions, runtime utilities, the SQLite database layer, configuration loading, dependency injection, and the application context factory that every other package builds on.

---

## Table of Contents

1. [@bound/shared](#boundshared)
   - [Domain Types](#domain-types)
   - [Result Type](#result-type)
   - [Event System](#event-system)
   - [TypedEventEmitter](#typedeventemitter)
   - [UUID Generation](#uuid-generation)
   - [Logger](#logger)
   - [Zod Config Schemas](#zod-config-schemas)
2. [@bound/core](#boundcore)
   - [Database Initialization](#database-initialization)
   - [Schema — 19 STRICT Tables](#schema--19-strict-tables)
   - [Change Log and Transactional Outbox](#change-log-and-transactional-outbox)
   - [Config Loader](#config-loader)
   - [Dependency Injection Container](#dependency-injection-container)
   - [AppContext Factory](#appcontext-factory)
   - [Metrics Schema](#metrics-schema)

---

## @bound/shared

The `@bound/shared` package exports all types, enumerations, utility functions, and Zod schemas that are shared across every other package in the monorepo. It has no dependency on `@bound/core` or any package above it.

---

### Domain Types

Every entity interface in `types.ts` corresponds directly to a SQLite table. Primary keys are `TEXT` UUIDs on entity tables; `change_log` uses a `TEXT` HLC (Hybrid Logical Clock) instead. Timestamps are ISO 8601 strings. Soft-deleted rows carry `deleted: number` (0 or 1 — SQLite has no boolean type).

#### String Union Types

```typescript
type MessageRole =
  | "user"
  | "assistant"
  | "system"
  | "alert"
  | "tool_call"
  | "tool_result"
  | "purge";

type TaskType   = "cron" | "deferred" | "event" | "heartbeat";
type TaskStatus = "pending" | "claimed" | "running" | "completed" | "failed" | "cancelled";
type InjectMode = "results" | "status" | "file";

type AdvisoryType   = "cost" | "frequency" | "memory" | "model" | "general";
type AdvisoryStatus = "proposed" | "approved" | "dismissed" | "deferred" | "applied";

type ReducerType = "lww" | "append-only";
```

#### SyncedTableName

```typescript
type SyncedTableName =
  | "users"
  | "threads"
  | "messages"
  | "semantic_memory"
  | "tasks"
  | "files"
  | "hosts"
  | "overlay_index"
  | "cluster_config"
  | "advisories"
  | "skills"
  | "memory_edges";
```

These twelve names are the tables that participate in cross-host replication. Every write to one of these tables must be accompanied by a `change_log` entry (see [Change Log](#change-log-and-transactional-outbox)).

#### TABLE_REDUCER_MAP

```typescript
const TABLE_REDUCER_MAP: Record<SyncedTableName, ReducerType>
```

Maps each synced table to its conflict resolution strategy. `"lww"` (last-write-wins) uses `modified_at` to resolve conflicts. `"append-only"` (used by `messages`) never updates existing rows.

#### Entity Interfaces

| Interface | Primary Key | Soft-delete | Notes |
|---|---|---|---|
| `User` | `id: string` | `deleted: number` | Optional `platform_ids` JSON (e.g. `{"discord":"12345"}`) |
| `Thread` | `id: string` | `deleted: number` | Tracks summary state, interface type (any `string` — e.g. `"web"`, `"discord"`) |
| `Message` | `id: string` | — | `role` is a `MessageRole`; append-only at the reducer level. Optional `exit_code` on `tool_result` rows |
| `SemanticMemory` | `id: string` | `deleted: number` | Keyed memory with LRU tracking (`last_accessed_at`) and a `tier: MemoryTier` field |
| `Task` | `id: string` | `deleted: number` | Full task scheduling state; see field notes below |
| `AgentFile` | `id: string` | `deleted: number` | Stored as text or binary; `content` is the raw payload |
| `Host` | `site_id: string` | — (schema only) | Describes a Bound node in the cluster; the TS interface omits `deleted`, the SQL table carries it for replication hygiene |
| `OverlayIndexEntry` | `id: string` | `deleted: number` | File index for a host's overlay filesystem |
| `ClusterConfigEntry` | `key: string` | — | Key-value cluster-wide config; LWW by `modified_at` |
| `Advisory` | `id: string` | — (schema only) | Agent self-advisory lifecycle; the TS interface omits `deleted`, the SQL table carries it |
| `Skill` | `id: string` | — (schema only) | Deterministic UUID from name; `status` is `"active"\|"retired"`; `skill_root` is the VFS path; context assembly uses `activation_count` and `last_activated_at`. The TS interface omits `deleted`, the SQL table carries it |
| `MemoryEdge` | `id: string` | `deleted: number` | Directed, weighted `relation` edge between `semantic_memory.key` values |

**Task field notes:**
- `trigger_spec` — cron expression or event name.
- `payload` — JSON string passed to the agent as task input.
- `inject_mode` — controls how prior task results are injected into the agent context: `"results"` (full result text), `"status"` (exit status only), `"file"` (written to a file path).
- `depends_on` — comma-separated task IDs that must complete before this task runs.
- `no_history` — when non-zero, the thread history is not included in the agent prompt.
- `no_quiescence` — when non-zero, the task runs even if the agent has not reached quiescence.
- `event_depth` — current recursion depth for event-triggered task chains.
- `alert_threshold` — number of consecutive failures before an alert message is created.
- `lease_id` — random UUID written when a worker claims the task; used to detect stale leases.

#### Support Interfaces

```typescript
interface ChangeLogEntry {
  hlc: string;               // Hybrid Logical Clock, local-only primary key
  table_name: SyncedTableName;
  row_id: string;
  site_id: string;
  timestamp: string;         // ISO 8601
  row_data: string;          // Full row snapshot, JSON-encoded
}

interface SyncState {
  peer_site_id: string;
  last_received: string;     // Highest change_log HLC received from peer
  last_sent: string;         // Highest change_log HLC sent to peer
  last_sync_at: string | null;
  sync_errors: number;
}

interface HostMeta {
  key: string;
  value: string;
}
```

---

### Result Type

`result.ts` provides a lightweight discriminated union for operations that can fail, avoiding thrown exceptions in business logic.

```typescript
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

function ok<T>(value: T): Result<T, never>
function err<E>(error: E): Result<never, E>
```

**Usage:**

```typescript
import { ok, err, type Result } from "@bound/shared";

function divide(a: number, b: number): Result<number, string> {
  if (b === 0) return err("division by zero");
  return ok(a / b);
}

const result = divide(10, 2);
if (result.ok) {
  console.log(result.value); // 5
} else {
  console.error(result.error);
}
```

The `E` type parameter defaults to `Error` but can be any type. Throughout `@bound/core`, `ConfigError` is used as the error type for configuration loading results.

---

### Event System

`events.ts` defines the `EventMap` interface, which is the single source of truth for all typed events in the system.

```typescript
interface EventMap {
  "message:created":       { message: Message; thread_id: string };
  "message:broadcast":     { message: Message; thread_id: string };
  "task:triggered":        { task_id: string; trigger: string };
  "task:completed":        { task_id: string; result: string | null };
  "file:changed":          { path: string; operation: "created" | "modified" | "deleted" };
  "alert:created":         { message: Message; thread_id: string };
  "agent:cancel":          { thread_id: string };
  "status:forward":        StatusForwardPayload;
  "platform:deliver":      PlatformDeliverPayload;
  "platform:webhook":      { platform: string; rawBody: string; headers: Record<string, string> };
  "context:debug":         { thread_id: string; turn_id: number; debug: ContextDebugInfo };
  "notify:enqueued":       { thread_id: string };
  "model:fallback": {
    requested_model: string;
    fallback_model: string;
    tier: number;
    thread_id: string;
    task_id?: string;
    reason: string;
  };
  "changelog:written":     { hlc: string; tableName: string; siteId: string };
  "relay:outbox-written":  { id: string; target_site_id: string };
  "relay:inbox":           { ref_id?: string; stream_id?: string; kind: RelayKind };
}
```

`"message:broadcast"` is emitted after a local agent loop run to push the new assistant message to WebSocket clients without re-triggering the agent loop handler. `"status:forward"` carries delegated loop state from remote hosts. `"platform:deliver"` routes outbound assistant responses to the platform leader; `"platform:webhook"` carries inbound webhook payloads for signature verification and dispatch. `"changelog:written"`, `"relay:outbox-written"`, and `"relay:inbox"` wake the sync and relay subsystems when new work is appended.

To add a new event to the system, add an entry to this interface. The `TypedEventEmitter` class (below) enforces the payload type at every call site.

---

### TypedEventEmitter

`event-emitter.ts` wraps Node's built-in `EventEmitter` with a fully typed API keyed on `EventMap`.

```typescript
class TypedEventEmitter {
  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): boolean
  on<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): this
  off<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): this
  once<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): this
}
```

All four methods are generic on `K extends keyof EventMap`, so the compiler will reject both unknown event names and mismatched payload shapes.

**Usage:**

```typescript
import { TypedEventEmitter } from "@bound/shared";

const bus = new TypedEventEmitter();

bus.on("task:completed", ({ task_id, result }) => {
  console.log(`Task ${task_id} finished:`, result);
});

bus.emit("task:completed", { task_id: "abc-123", result: "ok" });

// One-shot listener — unregisters itself after first fire
bus.once("changelog:written", ({ hlc, tableName, siteId }) => {
  console.log(`Changelog entry ${hlc} written to ${tableName} by ${siteId}`);
});
```

The underlying `EventEmitter` instance is private; all interaction must go through the typed methods.

---

### UUID Generation

`uuid.ts` exports two UUID functions and the Bound project namespace constant.

```typescript
const BOUND_NAMESPACE = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function randomUUID(): string
function deterministicUUID(namespace: string, name: string): string
```

**`randomUUID()`** delegates to `crypto.randomUUID()` (the Web Crypto API available in both Bun and Node). Use this for all new entity IDs.

**`deterministicUUID(namespace, name)`** is a UUID v5 implementation (RFC 4122). It computes SHA-1 over `namespace + name`, then sets the version nibble to `5` and the variant bits to RFC 4122's `10xxxxxx` pattern. Given the same inputs it always produces the same output, which is useful for deriving stable IDs from external identifiers (e.g., a Discord user ID → Bound user ID).

```typescript
import { deterministicUUID, BOUND_NAMESPACE } from "@bound/shared";

// Stable ID derived from a Discord user snowflake
const userId = deterministicUUID(BOUND_NAMESPACE, "discord:123456789");
```

---

### Logger

`logger.ts` provides a structured logger, built on [pino](https://getpino.io), that writes human-readable output to `stderr` and structured JSON to a log file.

```typescript
type LogLevel = "debug" | "info" | "warn" | "error";

interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message:  string, context?: Record<string, unknown>): void;
  warn(message:  string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

function createLogger(pkg: string, component: string): Logger
```

`createLogger` reads the `LOG_LEVEL` environment variable (defaulting to `"info"`) and returns a `Logger` that discards entries below that threshold. Internally it lazily constructs a single root pino logger on first use and spawns a child logger bound to `{ package, component }`; each call site gets its own child so those fields are always present in every record.

The root logger fans out to two destinations via `pino.multistream`:

- **`stderr`** — formatted by `pino-pretty` with colorized, human-readable output (timestamp `HH:MM:ss.l`, then `[package/component] message` plus any context fields). Writing to `stderr` keeps log output from interfering with stdout-based IPC or MCP stdio transports.
- **`logs/bound.log`** (relative to `process.cwd()`) — raw newline-delimited pino JSON, written asynchronously. The `logs/` directory is created on demand with `mkdirSync({ recursive: true })`.

A `resetLogger()` helper is exported for tests to discard the cached root logger.

**Usage:**

```typescript
import { createLogger } from "@bound/shared";

const logger = createLogger("@bound/tasks", "scheduler");

logger.info("Task claimed", { task_id: "abc-123", worker: "node-1" });
logger.error("Lease expired", { task_id: "abc-123", elapsed_ms: 12000 });
```

---

### Zod Config Schemas

`config-schemas.ts` exports Zod schemas for every supported configuration file. They are used by the config loader in `@bound/core` to parse and validate JSON files after environment variable expansion.

#### Required Config Schemas

**`allowlistSchema`** — `allowlist.json`

```typescript
type AllowlistConfig = {
  default_web_user: string;         // Must reference a key in users
  users: Record<string, {
    display_name: string;
    platforms?: Record<string, string>;  // e.g. { discord: "128581209109430272" }
  }>;
};
```

Cross-field constraint: `default_web_user` must be a key present in `users`.

**`modelBackendsSchema`** — `model_backends.json`

```typescript
type ModelBackendsConfig = {
  default: string;                  // Must reference a backend id
  daily_budget_usd?: number;
  backends: Array<{
    id: string;
    provider: "ollama" | "bedrock" | "anthropic" | "openai-compatible" | "cerebras" | "zai";
    model: string;
    base_url?: string;              // Required for ollama and openai-compatible
    api_key?: string;               // Required for cerebras, anthropic, and zai
    region?: string;
    profile?: string;
    context_window: number;
    tier: number;                   // 1–5
    price_per_m_input: number;
    price_per_m_output: number;
    price_per_m_cache_write?: number;
    price_per_m_cache_read?: number;
    capabilities?: Partial<{        // Merges over driver-reported capabilities at ModelRouter construction time
      streaming: boolean;
      tool_use: boolean;
      system_prompt: boolean;
      prompt_caching: boolean;
      vision: boolean;
      max_context: number;
    }>;
  }>;
};
```

Three cross-field constraints are enforced: `default` must reference a `backend.id` that exists in `backends` (or be the empty string sentinel when `backends` is empty, for hub-only nodes that relay inference to spokes); `ollama` / `openai-compatible` providers must supply `base_url`; and `cerebras` / `anthropic` / `zai` providers must supply `api_key`. The optional `capabilities` object overrides the capabilities that the driver auto-detects at startup, allowing operators to enable or disable specific features (e.g. marking a model as vision-capable or disabling tool use) without changing the driver code.

#### Optional Config Schemas

| Export | File | Type |
|---|---|---|
| `networkSchema` | `network.json` | Outbound HTTP allowlist with optional header injection |
| `platformsSchema` | `platforms.json` | Platform connector configs (Discord, etc.) with leader election settings |
| `syncSchema` | `sync.json` | Optional hub URL, nested `relay` (payload/timeout/prune/drain/inference limits), and `ws` (backpressure, idle timeout, reconnect) configs |
| `keyringSchema` | `keyring.json` | Per-host public key and URL map |
| `mcpSchema` | `mcp.json` | MCP server definitions (stdio or http transport) |
| `overlaySchema` | `overlay.json` | Virtual filesystem mount points |
| `cronSchedulesSchema` | `cron_schedules.json` | Named cron jobs with schedule, thread, and model hints |

**`networkSchema`:**

```typescript
type NetworkConfig = {
  allowedUrlPrefixes: string[];
  allowedMethods: string[];
  transform?: Array<{
    url: string;
    headers: Record<string, string>;
  }>;
};
```

**`mcpSchema`:**

```typescript
type McpConfig = {
  servers: Array<{
    name: string;
    transport: "stdio" | "http";
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    allow_tools?: string[];
    confirm?: string[];   // Tools requiring user confirmation before execution
  }>;
};
```

**`cronSchedulesSchema`:**

```typescript
type CronSchedulesConfig = {
  heartbeat?: {              // Reserved top-level key: agent heartbeat config
    enabled: boolean;        // default true
    interval_ms: number;     // default 1_800_000, minimum 60_000
    model_hint?: string;
  };
  // All other keys are cron entries (zod .catchall)
  [name: string]: {
    schedule: string;        // Cron expression
    thread?: string;
    payload?: string;
    template?: string[];
    requires?: string[];
    model_hint?: string;
  } | undefined;
};
```

#### configSchemaMap

```typescript
const configSchemaMap: {
  "allowlist.json":       typeof allowlistSchema;
  "model_backends.json":  typeof modelBackendsSchema;
  "network.json":         typeof networkSchema;
  "platforms.json":       typeof platformsSchema;
  "sync.json":            typeof syncSchema;
  "keyring.json":         typeof keyringSchema;
  "mcp.json":             typeof mcpSchema;
  "overlay.json":         typeof overlaySchema;
  "cron_schedules.json":  typeof cronSchedulesSchema;
}
```

Maps each filename to its schema. Use this for programmatic validation when iterating over all known config files.

---

## @bound/core

The `@bound/core` package owns the SQLite database lifecycle, the transactional change-log outbox, configuration loading with environment variable expansion, the tsyringe dependency injection container, and the `AppContext` factory that bootstraps a fully wired application.

---

### Database Initialization

`database.ts` exports a single factory function:

```typescript
function createDatabase(path: string): Database
```

It opens a `bun:sqlite` `Database` at the given path and sets three PRAGMAs before returning:

| PRAGMA | Value | Effect |
|---|---|---|
| `journal_mode` | `WAL` | Write-ahead logging — readers do not block writers |
| `foreign_keys` | `ON` | Enforces referential integrity at the SQLite level |
| `busy_timeout` | `5000` | Waits up to 5 s before returning `SQLITE_BUSY` |

On first run it also performs a one-time migration to `PRAGMA auto_vacuum = INCREMENTAL` (followed by `VACUUM` to restructure the file); subsequent startups detect the existing `auto_vacuum` setting and skip this step.

`database.ts` additionally exports `getSiteId(db: Database): string`, a convenience reader that returns the persisted `site_id` from `host_meta` (falling back to `"unknown"` if the row has not been written yet).

**Usage:**

```typescript
import { createDatabase } from "@bound/core";

const db = createDatabase("/data/bound.db");
```

---

### Schema — 19 STRICT Tables

`schema.ts` exports `applySchema(db: Database): void`, which issues `CREATE TABLE IF NOT EXISTS` statements for all 19 tables (12 synced + 7 local-only). Every table uses the `STRICT` keyword, which makes SQLite enforce declared column types rather than accepting arbitrary affinities.

`applySchema` is idempotent and safe to call on every startup. It also runs a number of in-place migrations (HLC conversion for `change_log` / `sync_state`, idempotent `ALTER TABLE` additions for newer columns, data backfills, and an `auto_vacuum` configuration).

#### Synced Tables (participate in replication)

These 12 tables are the source of truth for replicated state. Every mutation should go through the change-log helpers in `change-log.ts`.

**`users`**
```sql
id TEXT PRIMARY KEY, display_name TEXT NOT NULL, platform_ids TEXT,
first_seen_at TEXT NOT NULL, modified_at TEXT NOT NULL, deleted INTEGER DEFAULT 0
```
`platform_ids` stores a JSON object mapping platform name to platform user ID (e.g. `{"discord":"128581209109430272"}`).

**`threads`**
```sql
id TEXT PRIMARY KEY, user_id TEXT NOT NULL, interface TEXT NOT NULL,
host_origin TEXT NOT NULL, color INTEGER DEFAULT 0, title TEXT, summary TEXT,
summary_through TEXT, summary_model_id TEXT, extracted_through TEXT,
created_at TEXT NOT NULL, last_message_at TEXT NOT NULL,
modified_at TEXT NOT NULL, deleted INTEGER DEFAULT 0,
model_hint TEXT  -- added via idempotent ALTER TABLE
```
Index: on `(user_id, last_message_at)` where `deleted = 0`.

**`messages`**
```sql
id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
content TEXT NOT NULL, model_id TEXT, tool_name TEXT,
created_at TEXT NOT NULL, modified_at TEXT, host_origin TEXT NOT NULL,
deleted INTEGER DEFAULT 0,
exit_code INTEGER  -- added via idempotent ALTER TABLE; populated for tool_result rows
```
Index: on `(thread_id, created_at)`. The `deleted` column exists for column-parity with other synced tables, but the append-only reducer never updates existing rows — rows are inserted once and never tombstoned.

**`semantic_memory`**
```sql
id TEXT PRIMARY KEY, key TEXT NOT NULL, value TEXT NOT NULL, source TEXT,
created_at TEXT NOT NULL, modified_at TEXT NOT NULL, last_accessed_at TEXT,
deleted INTEGER DEFAULT 0,
tier TEXT DEFAULT 'default'  -- added via idempotent ALTER TABLE; one of "pinned" | "summary" | "default" | "detail"
```
Indexes: unique partial index on `key` where `deleted = 0`; `idx_memory_modified` on `modified_at DESC`; partial index `idx_memory_tier` on `tier` where `deleted = 0`. An idempotent backfill promotes entries with `_standing`/`_feedback`/`_policy`/`_pinned` key prefixes from the `default` tier to `pinned`.

**`tasks`**
```sql
id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
trigger_spec TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL,
created_by TEXT, thread_id TEXT, claimed_by TEXT, claimed_at TEXT,
lease_id TEXT, next_run_at TEXT, last_run_at TEXT, run_count INTEGER DEFAULT 0,
max_runs INTEGER, requires TEXT, model_hint TEXT, no_history INTEGER DEFAULT 0,
inject_mode TEXT DEFAULT 'results', depends_on TEXT,
require_success INTEGER DEFAULT 0, alert_threshold INTEGER DEFAULT 3,
consecutive_failures INTEGER DEFAULT 0, event_depth INTEGER DEFAULT 0,
no_quiescence INTEGER DEFAULT 0, heartbeat_at TEXT, result TEXT, error TEXT,
modified_at TEXT NOT NULL, deleted INTEGER DEFAULT 0,
origin_thread_id TEXT  -- added via idempotent ALTER TABLE; conversation that scheduled the task
```
Indexes: `idx_tasks_last_run` on `last_run_at DESC` where `deleted = 0 AND last_run_at IS NOT NULL`; `idx_tasks_pending_schedule` on `(status, next_run_at)` where `status = 'pending' AND deleted = 0 AND next_run_at IS NOT NULL`.

**`files`**
```sql
id TEXT PRIMARY KEY, path TEXT NOT NULL, content TEXT, is_binary INTEGER DEFAULT 0,
size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL, modified_at TEXT NOT NULL,
deleted INTEGER DEFAULT 0, created_by TEXT, host_origin TEXT
```
Index: unique on `path` where `deleted = 0`.

**`hosts`**
```sql
site_id TEXT PRIMARY KEY, host_name TEXT NOT NULL, version TEXT, sync_url TEXT,
mcp_servers TEXT, mcp_tools TEXT, models TEXT, overlay_root TEXT,
online_at TEXT, modified_at TEXT NOT NULL,
platforms TEXT, deleted INTEGER DEFAULT 0
```
JSON-encoded arrays/objects stored as TEXT in `mcp_servers`, `mcp_tools`, `models`, and `platforms`. `platforms` is a JSON array of platform names for which this host is the leader (e.g. `["discord"]`).

**`overlay_index`**
```sql
id TEXT PRIMARY KEY, site_id TEXT NOT NULL, path TEXT NOT NULL,
size_bytes INTEGER NOT NULL, content_hash TEXT, indexed_at TEXT NOT NULL,
deleted INTEGER DEFAULT 0
```
Index: on `(site_id, path)` where `deleted = 0`.

**`cluster_config`**
```sql
key TEXT PRIMARY KEY, value TEXT NOT NULL, modified_at TEXT NOT NULL
```
Simple key-value store for cluster-wide settings.

**`advisories`**
```sql
id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
title TEXT NOT NULL, detail TEXT NOT NULL, action TEXT, impact TEXT,
evidence TEXT, proposed_at TEXT NOT NULL, defer_until TEXT, resolved_at TEXT,
created_by TEXT, modified_at TEXT NOT NULL, deleted INTEGER DEFAULT 0
```

**`skills`**
```sql
id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
status TEXT NOT NULL, skill_root TEXT NOT NULL, content_hash TEXT,
allowed_tools TEXT, compatibility TEXT, metadata_json TEXT,
activated_at TEXT, created_by_thread TEXT,
activation_count INTEGER DEFAULT 0, last_activated_at TEXT,
retired_by TEXT, retired_reason TEXT,
modified_at TEXT NOT NULL, deleted INTEGER DEFAULT 0
```
Index: unique partial index `idx_skills_name ON skills(name) WHERE deleted = 0`.
IDs are deterministic: `deterministicUUID(BOUND_NAMESPACE, name)`. `status` is `"active"` or `"retired"`. `skill_root` is the VFS path under which the skill's `SKILL.md` and supporting files live. `allowed_tools` and `compatibility` are JSON arrays stored as TEXT.

**`memory_edges`**
```sql
id TEXT PRIMARY KEY, source_key TEXT NOT NULL, target_key TEXT NOT NULL,
relation TEXT NOT NULL, weight REAL DEFAULT 1.0,
created_at TEXT NOT NULL, modified_at TEXT NOT NULL,
deleted INTEGER DEFAULT 0
```
Indexes: unique partial index on `(source_key, target_key, relation)` where `deleted = 0`; partial indexes on `source_key` and `target_key` where `deleted = 0`. Stores directed, weighted relations between `semantic_memory.key` values.

#### Local-Only Tables (not replicated)

These seven tables hold node-local state and are never included in sync payloads.

**`change_log`** — the transactional outbox
```sql
hlc        TEXT PRIMARY KEY,   -- Hybrid Logical Clock: "<iso_timestamp>_<counter_hex>_<site_id>"
table_name TEXT NOT NULL, row_id TEXT NOT NULL, site_id TEXT NOT NULL,
timestamp  TEXT NOT NULL, row_data TEXT NOT NULL
```
The primary key is an HLC string (see `@bound/shared/hlc.ts`), which provides per-site-monotonic, total ordering across all sites. Range scans during sync use `WHERE hlc > ?` against peer cursors. A one-time migration (`migrateChangeLogToHlc`) converts an older `seq INTEGER PRIMARY KEY AUTOINCREMENT` schema by synthesizing HLCs from the legacy `(timestamp, seq, site_id)` triple.

**`sync_state`** — per-peer sync cursors
```sql
peer_site_id  TEXT PRIMARY KEY,
last_received TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000',
last_sent     TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000',
last_sync_at  TEXT, sync_errors INTEGER DEFAULT 0
```
Cursors are HLC strings (matching `change_log.hlc`). A one-time migration (`migrateSyncStateToHlc`) resets integer cursors from any older schema to `HLC_ZERO`.

**`host_meta`** — local node identity
```sql
key TEXT PRIMARY KEY, value TEXT NOT NULL
```
Used to persist the `site_id` UUID across restarts.

**`relay_outbox`** — pending relay messages to send to other hosts
```sql
id TEXT PRIMARY KEY, source_site_id TEXT, target_site_id TEXT NOT NULL,
kind TEXT NOT NULL, ref_id TEXT, idempotency_key TEXT,
payload TEXT NOT NULL, created_at TEXT NOT NULL,
expires_at TEXT NOT NULL, delivered INTEGER DEFAULT 0,
stream_id TEXT  -- added via idempotent ALTER TABLE
```
Index: on `(target_site_id, delivered)` where `delivered = 0`; partial index on `(stream_id)` where `stream_id IS NOT NULL`.

**`relay_inbox`** — received relay messages awaiting processing
```sql
id TEXT PRIMARY KEY, source_site_id TEXT NOT NULL, kind TEXT NOT NULL,
ref_id TEXT, idempotency_key TEXT,
payload TEXT NOT NULL, expires_at TEXT NOT NULL,
received_at TEXT NOT NULL, processed INTEGER DEFAULT 0,
stream_id TEXT  -- added via idempotent ALTER TABLE
```
Index: on `(processed)` where `processed = 0`; partial index on `(stream_id, processed)` where `stream_id IS NOT NULL AND processed = 0`.

**`relay_cycles`** — per-cycle relay metrics
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
direction TEXT NOT NULL, peer_site_id TEXT NOT NULL,
kind TEXT NOT NULL, delivery_method TEXT NOT NULL,
latency_ms INTEGER, expired INTEGER NOT NULL DEFAULT 0,
success INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
stream_id TEXT  -- added via idempotent ALTER TABLE
```
Index: on `(created_at)`. Use dedicated CRUD helpers (`writeOutbox`, `insertInbox`, `readUndelivered`, `markDelivered`, `readUnprocessed`, `markProcessed`) from `@bound/core` — do not use the change-log outbox pattern for these tables.

**`dispatch_queue`** — per-message dispatch coordination for the event-driven conversation model
```sql
message_id    TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
status        TEXT NOT NULL DEFAULT 'pending',
claimed_by    TEXT,
event_type    TEXT NOT NULL DEFAULT 'user_message',
event_payload TEXT,
created_at    TEXT NOT NULL, modified_at TEXT NOT NULL
```
Index: on `(thread_id, status)` where `status = 'pending'`. Local coordination only — never synced. The `event_type` and `event_payload` columns are added via idempotent `ALTER TABLE` for older databases.

---

### Change Log and Transactional Outbox

`change-log.ts` implements the write path for all replicated data. Every helper wraps its database writes and the corresponding `change_log` insertion in a single SQLite transaction, ensuring the two are always consistent.

Column names passed dynamically are validated against `/^[a-z_]+$/` before being interpolated into SQL, preventing injection via attacker-controlled schema data.

#### `createChangeLogEntry`

```typescript
function createChangeLogEntry(
  db: Database,
  tableName: SyncedTableName,
  rowId: string,
  siteId: string,
  rowData: Record<string, unknown>,
  remoteHlc?: string,
): string
```

Inserts a single row into `change_log` with the current ISO timestamp and a JSON snapshot of `rowData`, and returns the HLC assigned to the new entry. This is the primitive used by all other helpers and by `withChangeLog`. When generating the HLC it reads the current maximum HLC from `change_log` so the new value is strictly greater. Pass `remoteHlc` when applying a row received from a peer — the helper then calls `mergeHlc` instead of `generateHlc` to preserve causal ordering across sites.

#### `withChangeLog`

```typescript
function withChangeLog<T>(
  db: Database,
  siteId: string,
  fn: () => {
    tableName: SyncedTableName;
    rowId: string;
    rowData: Record<string, unknown>;
    result: T;
  },
): T
```

Executes `fn` inside a transaction, then atomically appends a `change_log` entry from the returned metadata. Use this when you need to write to a synced table with custom SQL that does not fit `insertRow` or `updateRow`.

```typescript
import { withChangeLog } from "@bound/core";

const newThread = { id: "...", user_id: "...", /* ... */ };

withChangeLog(db, siteId, () => {
  db.run("INSERT INTO threads ...", [...]);
  return {
    tableName: "threads",
    rowId: newThread.id,
    rowData: newThread,
    result: newThread,
  };
});
```

#### `insertRow`

```typescript
function insertRow(
  db: Database,
  table: SyncedTableName,
  row: Record<string, unknown>,
  siteId: string,
): void
```

Builds a parameterized `INSERT` from the keys of `row`, executes it, and appends a `change_log` entry — all in one transaction. The `row` object must include an `id` field.

```typescript
import { insertRow } from "@bound/core";
import { randomUUID } from "@bound/shared";

insertRow(db, "users", {
  id: randomUUID(),
  display_name: "Alice",
  platform_ids: JSON.stringify({ discord: "128581209109430272" }),
  first_seen_at: new Date().toISOString(),
  modified_at: new Date().toISOString(),
  deleted: 0,
}, siteId);
```

#### `updateRow`

```typescript
function updateRow(
  db: Database,
  table: SyncedTableName,
  id: string,
  updates: Record<string, unknown>,
  siteId: string,
): void
```

Applies `updates` to the row identified by `id`, automatically setting `modified_at` to the current time. After the `UPDATE`, it fetches the full row and writes the complete snapshot to `change_log`. This ensures the sync layer always has the full row state, not just a diff.

#### `softDelete`

```typescript
function softDelete(
  db: Database,
  table: SyncedTableName,
  id: string,
  siteId: string,
): void
```

Sets `deleted = 1` and `modified_at = now` on the row, then logs the full tombstoned snapshot to `change_log`. Physical deletion is never performed on synced tables.

`change-log.ts` also exports `insertMessage(db, params, siteId)`, a convenience wrapper that builds a standard `messages` row (`id`, timestamps, `deleted = 0`) and routes it through `insertRow`; `setChangelogEventBus(eventBus)`, which hooks up the optional `changelog:written` event emission used by the WS transport; and `validateColumnName(name)`, the exported version of the column-name regex check.

---

### Config Loader

`config-loader.ts` handles reading, parsing, environment variable expansion, and Zod validation of all configuration files. Every function returns a `Result` rather than throwing.

#### `expandEnvVars`

```typescript
function expandEnvVars(value: string): string
```

Expands `${VAR_NAME}` and `${VAR_NAME:-default}` patterns in a string.

- `${VAR_NAME}` — substitutes the value of `VAR_NAME`; throws if the variable is not set and no default is given.
- `${VAR_NAME:-default}` — substitutes the value of `VAR_NAME`, or `"default"` if the variable is unset.

Expansion is applied recursively to all string values in a parsed JSON object before Zod validation runs, so secrets can be kept in environment variables and referenced from config files:

```json
{
  "bot_token": "${DISCORD_BOT_TOKEN}",
  "host": "${DISCORD_HOST:-discord.example.com}"
}
```

#### `loadConfigFile`

```typescript
function loadConfigFile<T>(
  configDir: string,
  filename: string,
  schema: ZodSchema<T>,
): Result<T, ConfigError>
```

Reads `${configDir}/${filename}`, parses JSON, expands environment variables, and validates against `schema`. Returns `ok(data)` on success or `err(ConfigError)` on any failure (file not found, invalid JSON, or Zod validation error).

```typescript
interface ConfigError {
  filename: string;
  message: string;
  fieldErrors: Record<string, string[]>;
}
```

#### `loadRequiredConfigs`

```typescript
function loadRequiredConfigs(
  configDir: string,
  allowlistSchema: ZodSchema<AllowlistConfig>,
  modelBackendsSchema: ZodSchema<ModelBackendsConfig>,
): Result<RequiredConfig, ConfigError[]>

type RequiredConfig = {
  allowlist: AllowlistConfig;
  modelBackends: ModelBackendsConfig;
};
```

Loads `allowlist.json` and `model_backends.json` in parallel, collects all errors, and returns either the combined `RequiredConfig` or the full list of `ConfigError` objects. A missing required config is a fatal startup error.

#### `loadOptionalConfigs`

```typescript
function loadOptionalConfigs(configDir: string): OptionalConfigs

type OptionalConfigs = Record<string, Result<Record<string, unknown>, ConfigError>>
```

Attempts to load all seven optional config files. Files that are absent (ENOENT) are silently omitted from the returned map. Files that are present but fail validation are included as `err(ConfigError)` entries so the caller can surface them. The keys in the returned map are the logical config names (`"network"`, `"platforms"`, `"sync"`, `"keyring"`, `"mcp"`, `"overlay"`, `"cronSchedules"`).

```typescript
const optionals = loadOptionalConfigs("/etc/bound/config");

if ("platforms" in optionals) {
  const platformsResult = optionals["platforms"];
  if (platformsResult.ok) {
    // platformsResult.value is a validated PlatformsConfig
  }
}
```

---

### Dependency Injection Container

`container.ts` uses [tsyringe](https://github.com/microsoft/tsyringe) to wire the four core services as singletons. The container is the global tsyringe container instance.

#### Service Classes

All four services are decorated with `@injectable()` and `@singleton()`.

**`DatabaseService`**
```typescript
class DatabaseService {
  setDatabase(db: Database): void
  getDatabase(): Database
}
```
Holds the single `bun:sqlite` `Database` instance.

**`ConfigService`**
```typescript
class ConfigService {
  setConfig(config: RequiredConfig): void
  getConfig(): RequiredConfig
}
```
Holds the validated required configuration.

**`EventBusService`**
```typescript
class EventBusService {
  getEventBus(): TypedEventEmitter
}
```
Owns the shared `TypedEventEmitter` instance. The emitter is created at construction time; no setter is needed.

**`LoggerService`**
```typescript
class LoggerService {
  getLogger(pkg: string, component: string): Logger
}
```
Factory wrapper around `createLogger`. Does not cache logger instances.

#### `bootstrapContainer`

```typescript
function bootstrapContainer(configDir: string, dbPath: string): typeof container
```

The single entry point for container initialization. It performs the following steps in order:

1. Calls `loadRequiredConfigs` — throws if either required config is missing or invalid.
2. Calls `createDatabase(dbPath)`, then `applySchema(db)` and `applyMetricsSchema(db)`.
3. Registers all four service classes as singletons via `container.registerSingleton`.
4. Resolves `DatabaseService` and `ConfigService` and injects the database and config instances (the `EventBusService` and `LoggerService` need no setters — they are ready on construction).
5. Returns the fully initialized container.

Throws an `Error` with a descriptive message if any required config fails to load.

```typescript
import { bootstrapContainer } from "@bound/core";

const container = bootstrapContainer("/etc/bound/config", "/data/bound.db");
const db = container.resolve(DatabaseService).getDatabase();
```

---

### AppContext Factory

`app-context.ts` provides the highest-level bootstrap abstraction. Callers that do not need fine-grained DI control should use `createAppContext` rather than calling `bootstrapContainer` directly.

```typescript
interface AppContext {
  db: Database;
  config: RequiredConfig;
  optionalConfig: OptionalConfigs;
  eventBus: TypedEventEmitter;
  logger: Logger;
  siteId: string;
  hostName: string;
}

function createAppContext(configDir: string, dbPath: string): AppContext
```

In addition to calling `bootstrapContainer`, `createAppContext`:

- Reads or generates the `site_id` from the `host_meta` table. On first run a random UUID is generated and persisted. On subsequent runs the existing value is read, ensuring the node's identity is stable across restarts.
- Resolves `hostName` from `os.hostname()`, falling back to `"localhost"`.
- Calls `loadOptionalConfigs(configDir)` and attaches the result as `optionalConfig`.
- Creates the root logger for the application with package `"@bound/core"` and component `"app-context"`.

**Usage:**

```typescript
import { createAppContext } from "@bound/core";

const ctx = createAppContext("/etc/bound/config", "/data/bound.db");

ctx.logger.info("Application started", { siteId: ctx.siteId, host: ctx.hostName });

ctx.eventBus.on("message:created", ({ message, thread_id }) => {
  // handle new message
});
```

The `AppContext` object is intended to be passed as a dependency to subsystems rather than resolved from the container. It is a plain object, not a class, and carries no lifecycle methods.

---

### Metrics Schema

`metrics-schema.ts` manages a separate metrics database (or a separate schema within the same database) for recording per-turn token and cost data.

#### Schema

**`turns`** — one row per agent inference call
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
thread_id TEXT, task_id TEXT, dag_root_id TEXT,
model_id TEXT NOT NULL, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL,
cost_usd REAL, created_at TEXT NOT NULL,
relay_target TEXT,          -- hostname of the remote inference provider (NULL for local)
relay_latency_ms INTEGER,   -- time-to-first-chunk for relay inference (NULL for local)
tokens_cache_write INTEGER, -- prompt cache write tokens (NULL if not reported)
tokens_cache_read INTEGER,  -- prompt cache read tokens (NULL if not reported)
context_debug TEXT          -- JSON-encoded ContextDebugInfo for the turn (NULL if not captured)
```
Index: `idx_turns_thread` on `(thread_id, created_at DESC)` for fast per-thread lookup.
The five additional columns (`relay_target`, `relay_latency_ms`, `tokens_cache_write`, `tokens_cache_read`, `context_debug`) are added via idempotent `ALTER TABLE` statements at startup so the table remains backward-compatible with existing databases.

**`daily_summary`** — materialized daily aggregates, updated in-place by `recordTurn`
```sql
date TEXT PRIMARY KEY,
total_tokens_in INTEGER DEFAULT 0,
total_tokens_out INTEGER DEFAULT 0,
total_cost_usd REAL DEFAULT 0,
turn_count INTEGER DEFAULT 0
```

Both tables use `STRICT`.

#### Functions

```typescript
function applyMetricsSchema(db: Database): void
```
Creates both tables if they do not exist. Safe to call on every startup.

```typescript
interface TurnRecord {
  thread_id?: string;
  task_id?: string;
  dag_root_id?: string;
  model_id: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_write: number | null;
  tokens_cache_read: number | null;
  cost_usd?: number;
  created_at: string;   // ISO 8601
}

function recordTurn(db: Database, turn: TurnRecord): number
```
Inserts a row into `turns` and upserts the corresponding row in `daily_summary` within a single implicit transaction. The date key is derived by splitting `created_at` on `"T"`. Returns the auto-incremented row ID of the inserted turn. `tokens_cache_write` and `tokens_cache_read` should be `null` when the backend does not report prompt caching statistics.

```typescript
function recordContextDebug(db: Database, turnId: number, debug: ContextDebugInfo): void
```
Attaches a JSON-encoded `ContextDebugInfo` blob to an existing `turns` row via `UPDATE`. Called after `recordTurn` has returned the row ID — the same post-insert-update pattern used by the relay metrics helpers.

```typescript
function getDailySpend(db: Database, date: string): number
```
Returns the total USD cost recorded for `date` (format `"YYYY-MM-DD"`), or `0` if no data exists for that date.

**Usage:**

```typescript
import { applyMetricsSchema, recordTurn, getDailySpend } from "@bound/core";

applyMetricsSchema(db);

recordTurn(db, {
  thread_id: "thread-abc",
  model_id: "claude-3-7-sonnet-20250219",
  tokens_in: 1200,
  tokens_out: 340,
  tokens_cache_write: 800,
  tokens_cache_read: 400,
  cost_usd: 0.0048,
  created_at: new Date().toISOString(),
});

const todaySpend = getDailySpend(db, "2026-03-23");
console.log(`Today's spend: $${todaySpend.toFixed(4)}`);
```
