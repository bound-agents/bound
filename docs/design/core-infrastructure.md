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
   - [Schema — 13 STRICT Tables](#schema--13-strict-tables)
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

Every interface in `types.ts` corresponds directly to a SQLite table. All primary keys are `TEXT` UUIDs. Timestamps are ISO 8601 strings. Soft-deleted rows carry `deleted: number` (0 or 1 — SQLite has no boolean type).

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

type TaskType   = "cron" | "deferred" | "event";
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
  | "advisories";
```

These ten names are the tables that participate in cross-host replication. Every write to one of these tables must be accompanied by a `change_log` entry (see [Change Log](#change-log-and-transactional-outbox)).

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
| `Message` | `id: string` | — | `role` is a `MessageRole`; append-only table |
| `SemanticMemory` | `id: string` | `deleted: number` | Keyed memory with LRU tracking (`last_accessed_at`) |
| `Task` | `id: string` | `deleted: number` | Full task scheduling state; see field notes below |
| `AgentFile` | `id: string` | `deleted: number` | Stored as text or binary; `content` is the raw payload |
| `Host` | `site_id: string` | — | No soft-delete; describes a Bound node in the cluster |
| `OverlayIndexEntry` | `id: string` | `deleted: number` | File index for a host's overlay filesystem |
| `ClusterConfigEntry` | `key: string` | — | Key-value cluster-wide config; LWW by `modified_at` |
| `Advisory` | `id: string` | — | Agent self-advisory lifecycle |

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
  seq: number;               // AUTOINCREMENT, local-only
  table_name: SyncedTableName;
  row_id: string;
  site_id: string;
  timestamp: string;         // ISO 8601
  row_data: string;          // Full row snapshot, JSON-encoded
}

interface SyncState {
  peer_site_id: string;
  last_received: number;     // Highest change_log seq received from peer
  last_sent: number;         // Highest change_log seq sent to peer
  last_sync_at: string;
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
  "message:created": { message: Message; thread_id: string };
  "task:triggered":  { task_id: string; trigger: string };
  "task:completed":  { task_id: string; result: string | null };
  "sync:completed":  { pushed: number; pulled: number; duration_ms: number };
  "file:changed":    { path: string; operation: "created" | "modified" | "deleted" };
  "alert:created":   { message: Message; thread_id: string };
}
```

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
bus.once("sync:completed", ({ pushed, pulled, duration_ms }) => {
  console.log(`Sync done in ${duration_ms}ms, +${pushed}/-${pulled}`);
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

`logger.ts` provides a structured JSON logger that writes to `stderr`.

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

`createLogger` reads the `LOG_LEVEL` environment variable (defaulting to `"info"`) and returns a `Logger` that discards entries below that threshold. Each entry is a single line of JSON with the following fixed fields merged with any `context` object provided:

```json
{
  "timestamp": "2026-03-23T14:00:00.000Z",
  "level": "info",
  "package": "@bound/core",
  "component": "app-context",
  "message": "Generated new site_id",
  "siteId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

All output goes to `stderr` so it does not interfere with stdout-based IPC or MCP stdio transports.

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
  backends: Array<{
    id: string;
    provider: "ollama" | "bedrock" | "anthropic" | "openai-compatible";
    model: string;
    base_url?: string;              // Required for ollama and openai-compatible
    api_key?: string;
    region?: string;
    context_window: number;
    tier: number;                   // 1–5
    price_per_m_input: number;
    price_per_m_output: number;
    price_per_m_cache_write?: number;
    price_per_m_cache_read?: number;
  }>;
};
```

Two cross-field constraints are enforced: `default` must reference a `backend.id` that exists in `backends`, and `ollama` / `openai-compatible` providers must supply `base_url`.

#### Optional Config Schemas

| Export | File | Type |
|---|---|---|
| `networkSchema` | `network.json` | Outbound HTTP allowlist with optional header injection |
| `platformsSchema` | `platforms.json` | Platform connector configs (Discord, etc.) with leader election settings |
| `syncSchema` | `sync.json` | Hub URL and polling interval |
| `keyringSchema` | `keyring.json` | Per-host public key and URL map |
| `mcpSchema` | `mcp.json` | MCP server definitions (stdio or SSE transport) |
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
    transport: "stdio" | "sse";
    command?: string;
    args?: string[];
    url?: string;
    allow_tools?: string[];
    confirm?: string[];   // Tools requiring user confirmation before execution
  }>;
};
```

**`cronSchedulesSchema`:**

```typescript
type CronSchedulesConfig = Record<string, {
  schedule: string;         // Cron expression
  thread?: string;
  payload?: string;
  template?: string[];
  requires?: string[];
  model_hint?: string;
}>;
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

**Usage:**

```typescript
import { createDatabase } from "@bound/core";

const db = createDatabase("/data/bound.db");
```

---

### Schema — 13 STRICT Tables

`schema.ts` exports `applySchema(db: Database): void`, which issues `CREATE TABLE IF NOT EXISTS` statements for all 13 tables. Every table uses the `STRICT` keyword, which makes SQLite enforce declared column types rather than accepting arbitrary affinities.

`applySchema` is idempotent and safe to call on every startup.

#### Synced Tables (participate in replication)

These 10 tables are the source of truth for replicated state. Every mutation should go through the change-log helpers in `change-log.ts`.

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
created_at TEXT NOT NULL, last_message_at TEXT NOT NULL, deleted INTEGER DEFAULT 0
```
Index: on `(user_id, last_message_at)` where `deleted = 0`.

**`messages`**
```sql
id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
content TEXT NOT NULL, model_id TEXT, tool_name TEXT,
created_at TEXT NOT NULL, modified_at TEXT, host_origin TEXT NOT NULL
```
Index: on `(thread_id, created_at)`. No soft-delete column — the append-only reducer never tombstones messages.

**`semantic_memory`**
```sql
id TEXT PRIMARY KEY, key TEXT NOT NULL, value TEXT NOT NULL, source TEXT,
created_at TEXT NOT NULL, modified_at TEXT NOT NULL, last_accessed_at TEXT,
deleted INTEGER DEFAULT 0
```
Index: unique on `key` where `deleted = 0`.

**`tasks`**
```sql
id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
trigger_spec TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL,
created_by TEXT, thread_id TEXT, claimed_by TEXT, claimed_at TEXT,
lease_id TEXT, next_run_at TEXT, last_run_at TEXT, run_count INTEGER DEFAULT 0,
max_runs INTEGER, requires TEXT, model_hint TEXT, no_history INTEGER DEFAULT 0,
inject_mode TEXT DEFAULT 'results', depends_on TEXT,
require_success INTEGER DEFAULT 0, alert_threshold INTEGER DEFAULT 1,
consecutive_failures INTEGER DEFAULT 0, event_depth INTEGER DEFAULT 0,
no_quiescence INTEGER DEFAULT 0, heartbeat_at TEXT, result TEXT, error TEXT,
modified_at TEXT NOT NULL, deleted INTEGER DEFAULT 0
```

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
online_at TEXT, modified_at TEXT NOT NULL
```
JSON-encoded arrays/objects stored as TEXT in `mcp_servers`, `mcp_tools`, and `models`.

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
created_by TEXT, modified_at TEXT NOT NULL
```

#### Local-Only Tables (not replicated)

These three tables hold node-local state and are never included in sync payloads.

**`change_log`** — the transactional outbox
```sql
seq INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL,
row_id TEXT NOT NULL, site_id TEXT NOT NULL, timestamp TEXT NOT NULL,
row_data TEXT NOT NULL
```
Index: on `seq` (explicitly created for efficient range scans during sync).

**`sync_state`** — per-peer sync cursors
```sql
peer_site_id TEXT PRIMARY KEY, last_received INTEGER NOT NULL,
last_sent INTEGER NOT NULL, last_sync_at TEXT, sync_errors INTEGER DEFAULT 0
```

**`host_meta`** — local node identity
```sql
key TEXT PRIMARY KEY, value TEXT NOT NULL
```
Used to persist the `site_id` UUID across restarts.

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
): void
```

Inserts a single row into `change_log` with the current ISO timestamp and a JSON snapshot of `rowData`. This is the primitive used by all other helpers and by `withChangeLog`.

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

Attempts to load all seven optional config files. Files that are absent (ENOENT) are silently omitted from the returned map. Files that are present but fail validation are included as `err(ConfigError)` entries so the caller can surface them. The keys in the returned map are the logical config names (`"network"`, `"discord"`, `"sync"`, `"keyring"`, `"mcp"`, `"overlay"`, `"cronSchedules"`).

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
2. Calls `createDatabase(dbPath)` and `applySchema(db)`.
3. Registers all four service classes as singletons via `container.registerSingleton`.
4. Resolves each service and injects the database and config instances.
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
cost_usd REAL, created_at TEXT NOT NULL
```

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
  cost_usd?: number;
  created_at: string;   // ISO 8601
}

function recordTurn(db: Database, turn: TurnRecord): void
```
Inserts a row into `turns` and upserts the corresponding row in `daily_summary` within a single implicit transaction. The date key is derived by splitting `created_at` on `"T"`.

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
  cost_usd: 0.0048,
  created_at: new Date().toISOString(),
});

const todaySpend = getDailySpend(db, "2026-03-23");
console.log(`Today's spend: $${todaySpend.toFixed(4)}`);
```
