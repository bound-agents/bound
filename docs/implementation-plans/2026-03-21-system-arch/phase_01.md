# Bound System Architecture - Phase 1: Foundation

**Goal:** Runnable Bun monorepo with `@bound/shared` types/utilities and `@bound/core` database schema, DI container, and config loading.

**Architecture:** Two-package foundation — `@bound/shared` provides cross-cutting types, events, and config schemas with zero runtime deps; `@bound/core` owns SQLite database creation, DI container bootstrap, and config file loading/validation. All subsequent packages depend on these two.

**Tech Stack:** Bun 1.2+, TypeScript 5.x, bun:sqlite (WAL mode), tsyringe (DI), Zod 4.x (validation — uses `z.treeifyError()`/`z.flattenError()` for error formatting; if Zod v4 is not stable at implementation time, use Zod v3 with `.format()`/`.flatten()` instead and pin to a specific working version), Biome (linting/formatting)

**Scope:** 8 phases from original design (phase 1 of 8)

**Codebase verified:** 2026-03-22 — pure greenfield, no existing code. Only docs/ directory exists with spec and design plan.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### system-arch.AC1: Implementation architecture is documented with clear module boundaries
- **system-arch.AC1.2 Success:** Each package has a well-defined responsibility boundary documented in its package.json description
- **system-arch.AC1.3 Success:** DI container resolves all services at startup without runtime errors
- **system-arch.AC1.4 Success:** Typed event bus delivers events across package boundaries (e.g., agent emits `message:created`, web receives it)

### system-arch.AC2: Technology stack is confirmed with specific libraries
- **system-arch.AC2.3 Success:** `bun:sqlite` creates the database with WAL mode and all 13 STRICT tables
- **system-arch.AC2.5 Success:** Zod validates config files at startup and rejects malformed input with specific error messages
- **system-arch.AC2.6 Failure:** Invalid config file (e.g., missing required `model_backends.json` fields) produces a clear validation error, not a runtime crash

### system-arch.AC3: Phased build order produces working vertical slices
- **system-arch.AC3.1 Success:** Phase 1 completes with a runnable monorepo where `bun install` and `bun test` succeed

### system-arch.AC4: Testing strategy covers all packages with multi-instance sync validation
- **system-arch.AC4.1 Success:** Every package has unit tests that run via `bun test`

---

<!-- START_SUBCOMPONENT_A (tasks 1-1) -->
<!-- START_TASK_1 -->
### Task 1: Root monorepo configuration

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `bunfig.toml`
- Create: `biome.json`

**Step 1: Create root package.json**

```json
{
  "name": "bound",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "bun test --recursive",
    "lint": "bunx @biomejs/biome check .",
    "lint:fix": "bunx @biomejs/biome check --write .",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@types/bun": "latest",
    "typescript": "^5.7.0"
  }
}
```

**Step 2: Create root tsconfig.json**

This is the base config that all packages extend.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "types": ["bun-types"]
  },
  "references": [
    { "path": "packages/shared" },
    { "path": "packages/core" }
  ]
}
```

**Step 3: Create bunfig.toml**

```toml
[test]
coverage = true
coverageThreshold = { line = 0.6, function = 0.6 }

# Note: Per AC4.6, differentiated thresholds are needed:
# core/agent/sync: 80% (line and function)
# web/discord/cli: 60% (line and function)
# bunfig.toml global threshold is the floor (60%).
# Per-package thresholds enforced via CI scripts or package-level bunfig.toml overrides.
```

**Step 4: Create biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.3/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "files": {
    "ignore": ["node_modules", "dist", "*.db", "*.db-wal", "*.db-shm"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedVariables": "error",
        "noUnusedImports": "error"
      }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always"
    }
  }
}
```

**Step 5: Verify operationally**

Run: `bun install`
Expected: Installs without errors. Creates `node_modules/` and `bun.lockb`.

**Step 6: Commit**

```bash
git add package.json tsconfig.json bunfig.toml biome.json bun.lockb
git commit -m "chore: initialize bun monorepo with workspaces"
```
<!-- END_TASK_1 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 2-5) -->
<!-- START_TASK_2 -->
### Task 2: @bound/shared package with core interfaces and types

**Verifies:** system-arch.AC1.2

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/result.ts`
- Create: `packages/shared/src/events.ts`

**Implementation:**

`packages/shared/package.json`:
```json
{
  "name": "@bound/shared",
  "version": "0.0.1",
  "description": "Cross-cutting types, events, utilities, and Zod config schemas for the Bound agent system — zero runtime deps",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "zod": "^4.0.0"
  }
}
```

`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`packages/shared/src/types.ts` — Define TypeScript interfaces that mirror the database schema from `docs/design/specs/2026-03-20-base.md` section 5. The following types must be defined:

- `User` — maps to `users` table (id, display_name, discord_id, first_seen_at, modified_at, deleted)
- `Thread` — maps to `threads` table (id, user_id, interface: 'web' | 'discord', host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, deleted)
- `MessageRole` — union type: `'user' | 'assistant' | 'system' | 'alert' | 'tool_call' | 'tool_result' | 'purge'`
- `Message` — maps to `messages` table (id, thread_id, role: MessageRole, content, model_id, tool_name, created_at, modified_at, host_origin)
- `SemanticMemory` — maps to `semantic_memory` table (id, key, value, source, created_at, modified_at, last_accessed_at, deleted)
- `TaskType` — union: `'cron' | 'deferred' | 'event'`
- `TaskStatus` — union: `'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled'`
- `InjectMode` — union: `'results' | 'status' | 'file'`
- `Task` — maps to `tasks` table (all 24 fields including id, type, status, trigger_spec, payload, thread_id, claimed_by, claimed_at, lease_id, next_run_at, last_run_at, run_count, max_runs, requires, model_hint, no_history, inject_mode, depends_on, require_success, alert_threshold, consecutive_failures, event_depth, no_quiescence, heartbeat_at, result, error, created_at, created_by, modified_at, deleted)
- `AgentFile` — maps to `files` table (id, path, content, is_binary, size_bytes, created_at, modified_at, deleted, created_by, host_origin). Named `AgentFile` to avoid collision with global `File`.
- `Host` — maps to `hosts` table (site_id as PK, host_name, version, sync_url, mcp_servers, mcp_tools, models, overlay_root, online_at, modified_at)
- `OverlayIndexEntry` — maps to `overlay_index` table (id, site_id, path, size_bytes, content_hash, indexed_at, deleted)
- `ClusterConfigEntry` — maps to `cluster_config` table (key, value, modified_at)
- `ChangeLogEntry` — maps to `change_log` table (seq, table_name, row_id, site_id, timestamp, row_data)
- `SyncState` — maps to `sync_state` table (peer_site_id, last_received, last_sent, last_sync_at, sync_errors)
- `HostMeta` — maps to `host_meta` table (key, value)
- `Advisory` — maps to `advisories` table (id, type: AdvisoryType, status: AdvisoryStatus, title, detail, action, impact, evidence, proposed_at, defer_until, resolved_at, created_by, modified_at)
- `AdvisoryType` — union: `'cost' | 'frequency' | 'memory' | 'model' | 'general'`
- `AdvisoryStatus` — union: `'proposed' | 'approved' | 'dismissed' | 'deferred' | 'applied'`
- `SyncedTableName` — union of all synced table names: `'users' | 'threads' | 'messages' | 'semantic_memory' | 'tasks' | 'files' | 'hosts' | 'overlay_index' | 'cluster_config' | 'advisories'`
- `ReducerType` — union: `'lww' | 'append-only'`
- `TableReducerMap` — Record mapping `SyncedTableName` to its `ReducerType` (messages = append-only, all others = lww)

All timestamp fields are `string` (ISO 8601). All IDs are `string` (UUID). Nullable fields use `| null`. Boolean-like fields from SQLite (deleted, is_binary, no_history, etc.) use `number` (0 or 1) to match SQLite's integer representation.

`packages/shared/src/result.ts` — Define a `Result<T, E>` discriminated union type:
```typescript
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
```

`packages/shared/src/events.ts` — Define the typed event map interface:
```typescript
import type { Message, Task } from "./types.js";

export interface EventMap {
  "message:created": { message: Message; thread_id: string };
  "task:triggered": { task_id: string; trigger: string };
  "task:completed": { task_id: string; result: string | null };
  "sync:completed": { peer_site_id: string; events_received: number };
  "file:changed": { path: string; operation: "created" | "modified" | "deleted" };
  "alert:created": { message: Message; thread_id: string };
}
```

`packages/shared/src/index.ts` — Barrel export all types and utilities from this package.

**Testing:**
Types are verified by the TypeScript compiler. No runtime tests needed for pure type definitions.

**Verification:**
Run: `cd packages/shared && bun run tsc --noEmit`
Expected: No type errors

**Commit:** `feat(shared): add core type definitions and event map`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: @bound/shared utilities — UUID, TypedEventEmitter, createLogger

**Verifies:** system-arch.AC1.4

**Files:**
- Create: `packages/shared/src/uuid.ts`
- Create: `packages/shared/src/event-emitter.ts`
- Create: `packages/shared/src/logger.ts`
- Modify: `packages/shared/src/index.ts` — add exports

**Implementation:**

`packages/shared/src/uuid.ts` — UUID generation utilities:
- `randomUUID()`: Wraps `crypto.randomUUID()` for generating random v4 UUIDs.
- `deterministicUUID(namespace: string, name: string): string`: Generates a UUID v5 from a namespace and name string. Use this for idempotent seeding of users (from username) and cron tasks (from name|cron_expr). Implementation: SHA-1 hash of namespace bytes + name bytes, then format as UUID v5 per RFC 4122. The namespace should be a constant UUID defined as `BOUND_NAMESPACE = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"` (arbitrary but fixed).

`packages/shared/src/event-emitter.ts` — Typed event emitter wrapping Node's `EventEmitter`:
```typescript
import { EventEmitter } from "events";
import type { EventMap } from "./events.js";

export class TypedEventEmitter {
  private emitter = new EventEmitter();

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): boolean {
    return this.emitter.emit(event as string, data);
  }

  on<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): this {
    this.emitter.on(event as string, listener);
    return this;
  }

  off<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): this {
    this.emitter.off(event as string, listener);
    return this;
  }

  once<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): this {
    this.emitter.once(event as string, listener);
    return this;
  }
}
```

`packages/shared/src/logger.ts` — Structured JSON logger to stderr:
```typescript
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export function createLogger(pkg: string, component: string): Logger {
  // Implementation: write structured JSON lines to stderr
  // Each line: { timestamp: ISO8601, level, package: pkg, component, message, ...context }
  // Filter by LOG_LEVEL env var (default: "info")
  // Level ordering: debug < info < warn < error
}
```

Update `packages/shared/src/index.ts` to export all new utilities.

**Testing:**
Tests must verify AC1.4 — typed event bus delivers events:
- system-arch.AC1.4: TypedEventEmitter.emit() triggers registered listeners with correctly typed payloads. Register a listener for `message:created`, emit the event, verify the listener receives the data.
- UUID: deterministicUUID produces the same output for the same inputs, different output for different inputs. randomUUID produces valid UUID v4 format.
- Logger: createLogger produces JSON output to stderr with correct fields (timestamp, level, package, component, message).

Test file: `packages/shared/src/__tests__/uuid.test.ts` (unit)
Test file: `packages/shared/src/__tests__/event-emitter.test.ts` (unit)
Test file: `packages/shared/src/__tests__/logger.test.ts` (unit)

**Verification:**
Run: `bun test packages/shared/`
Expected: All tests pass

**Commit:** `feat(shared): add UUID helpers, typed event emitter, and logger`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: @bound/shared Zod config schemas

**Verifies:** system-arch.AC2.5, system-arch.AC2.6

**Files:**
- Create: `packages/shared/src/config-schemas.ts`
- Modify: `packages/shared/src/index.ts` — add exports

**Implementation:**

`packages/shared/src/config-schemas.ts` — Zod schemas for all config files from spec section 12:

**AllowlistConfig** (required — `config/allowlist.json`):
```typescript
import { z } from "zod";

const userEntrySchema = z.object({
  display_name: z.string().min(1),
  discord_id: z.string().optional(),
});

export const allowlistSchema = z.object({
  default_web_user: z.string().min(1),
  users: z.record(z.string(), userEntrySchema).refine(
    (users) => Object.keys(users).length > 0,
    { message: "At least one user must be defined" }
  ),
}).refine(
  (data) => data.default_web_user in data.users,
  { message: "default_web_user must reference a user defined in users" }
);
```

**ModelBackendsConfig** (required — `config/model_backends.json`):
```typescript
const modelBackendSchema = z.object({
  id: z.string().min(1),
  provider: z.enum(["ollama", "bedrock", "anthropic", "openai-compatible"]),
  model: z.string().min(1),
  base_url: z.string().url().optional(),
  api_key: z.string().optional(),
  region: z.string().optional(),
  context_window: z.number().int().positive(),
  tier: z.number().int().min(1).max(5),
  price_per_m_input: z.number().min(0).default(0),
  price_per_m_output: z.number().min(0).default(0),
  price_per_m_cache_write: z.number().min(0).optional(),
  price_per_m_cache_read: z.number().min(0).optional(),
});

export const modelBackendsSchema = z.object({
  backends: z.array(modelBackendSchema).min(1, "At least one backend must be configured"),
  default: z.string().min(1),
}).refine(
  (data) => data.backends.some((b) => b.id === data.default),
  { message: "default must reference a backend ID defined in backends" }
).refine(
  (data) => {
    // ollama and openai-compatible require base_url
    return data.backends.every((b) => {
      if (b.provider === "ollama" || b.provider === "openai-compatible") {
        return b.base_url !== undefined;
      }
      return true;
    });
  },
  { message: "ollama and openai-compatible providers require base_url" }
);
```

**Optional config schemas** (not required at startup, validated only when files exist):
- `networkSchema` — validates `network.json` (allowedUrlPrefixes: string[], allowedMethods: string[], transform: array of {url, headers})
- `discordSchema` — validates `discord.json` (bot_token: string, host: string)
- `syncSchema` — validates `sync.json` (hub: string, sync_interval_seconds: number optional default 30)
- `keyringSchema` — validates `keyring.json` (hosts: Record<string, { public_key: string, url: string }>)
- `mcpSchema` — validates `mcp.json` (servers: array of { name: string, command?: string, args?: string[], url?: string, transport: "stdio" | "sse", allow_tools?: string[], confirm?: string[] }). Per spec §7.2.
- `overlaySchema` — validates `overlay.json` (mounts: Record<string, string> mapping real paths to mount paths). Per spec §4.3.
- `cronSchedulesSchema` — validates `cron_schedules.json` (Record<string, { schedule: string, thread?: string, payload?: string, template?: string[], requires?: string[], model_hint?: string }>). Per spec §10.1.

Define a `ConfigType` union and a `configSchemaMap` record mapping config filenames to their schemas for programmatic validation.

Export all schemas and their inferred TypeScript types using `z.infer<typeof schema>`.

**Testing:**
Tests must verify AC2.5 and AC2.6:
- system-arch.AC2.5: Valid allowlist.json and model_backends.json parse without errors. All fields are correctly typed after parsing.
- system-arch.AC2.6: Missing required fields (e.g., no `backends` array, no `default_web_user`) produce specific Zod validation errors with field paths and human-readable messages. Invalid values (e.g., negative context_window, tier > 5) produce validation errors.
- Edge cases: default_web_user references nonexistent user (cross-field validation), default references nonexistent backend ID, ollama provider without base_url.

Test file: `packages/shared/src/__tests__/config-schemas.test.ts` (unit)

**Verification:**
Run: `bun test packages/shared/`
Expected: All tests pass

**Commit:** `feat(shared): add Zod config validation schemas`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: @bound/shared test suite

**Verifies:** system-arch.AC4.1

**Files:**
- Create: `packages/shared/src/__tests__/uuid.test.ts`
- Create: `packages/shared/src/__tests__/event-emitter.test.ts`
- Create: `packages/shared/src/__tests__/logger.test.ts`
- Create: `packages/shared/src/__tests__/config-schemas.test.ts`
- Create: `packages/shared/src/__tests__/result.test.ts`

**Implementation:**

Write all test files described in Tasks 3 and 4. Additionally add:

`result.test.ts` — verify Result type helpers:
- `ok(value)` produces `{ ok: true, value }`
- `err(error)` produces `{ ok: false, error }`
- Type narrowing works: after checking `result.ok`, TypeScript correctly narrows to `value` or `error`

Follow project test conventions:
- File naming: `*.test.ts` for unit tests
- Use `bun test` runner (Jest-compatible API: `describe`, `it`/`test`, `expect`)
- Test behavior, not implementation details
- Each test file tests one module

**Verification:**
Run: `bun test packages/shared/`
Expected: All tests pass, coverage reported

**Commit:** `test(shared): add unit tests for all shared utilities`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 6-10) -->
<!-- START_TASK_6 -->
### Task 6: @bound/core package with SQLite database schema

**Verifies:** system-arch.AC2.3

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/database.ts`
- Create: `packages/core/src/schema.ts`

**Implementation:**

`packages/core/package.json`:
```json
{
  "name": "@bound/core",
  "version": "0.0.1",
  "description": "SQLite database schema, migration runner, DI container bootstrap, and config file loading for the Bound agent system",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@bound/shared": "workspace:*",
    "tsyringe": "^4.8.0",
    "reflect-metadata": "^0.2.0"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [{ "path": "../shared" }]
}
```

`packages/core/src/database.ts` — Database creation and management:

```typescript
import { Database } from "bun:sqlite";

export function createDatabase(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}
```

`packages/core/src/schema.ts` — All 13 table CREATE statements. Reference `docs/design/specs/2026-03-20-base.md` section 5 for exact schemas. The function `applySchema(db: Database): void` runs all CREATE TABLE and CREATE INDEX statements.

Tables to create (all with STRICT mode):
1. `users` — with idx_users_discord index
2. `threads` — with idx_threads_user index
3. `messages` — with idx_messages_thread index
4. `semantic_memory` — with idx_memory_key index
5. `tasks` — no additional indexes specified in spec
6. `files` — with idx_files_path index
7. `hosts` — no additional indexes
8. `overlay_index` — with idx_overlay_site_path index
9. `cluster_config` — no additional indexes
10. `advisories` — no additional indexes
11. `change_log` — with idx_changelog_seq index
12. `sync_state` — no additional indexes
13. `host_meta` — no additional indexes

Copy the exact SQL from `docs/design/specs/2026-03-20-base.md` sections 5.2-5.13 and the advisories table from section 9.7. Each CREATE TABLE must end with `) STRICT;`.

**Testing:**
Tests must verify AC2.3:
- system-arch.AC2.3: Create a database at a temp path, run applySchema(), verify all 13 tables exist (query `sqlite_master`), verify WAL mode is active (`PRAGMA journal_mode` returns 'wal'), verify STRICT mode by attempting an INSERT with wrong types (should fail).
- Verify all indexes exist by querying `sqlite_master WHERE type='index'`.

Test file: `packages/core/src/__tests__/schema.test.ts` (integration — uses real SQLite in /tmp/)

**Verification:**
Run: `bun test packages/core/`
Expected: All tests pass

**Commit:** `feat(core): add SQLite database creation with all 13 STRICT tables`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: @bound/core change log producer (transactional outbox)

**Verifies:** system-arch.AC2.3 (change_log entries produced)

**Files:**
- Create: `packages/core/src/change-log.ts`
- Modify: `packages/core/src/index.ts` — add exports

**Implementation:**

`packages/core/src/change-log.ts` — Transactional outbox helper that writes to a synced table AND the change_log in a single SQLite transaction.

Key components:
- `createChangeLogEntry(db: Database, tableName: SyncedTableName, rowId: string, siteId: string, rowData: Record<string, unknown>): void` — Inserts a row into `change_log` with the current timestamp and JSON-serialized row data.
- `withChangeLog<T>(db: Database, siteId: string, fn: (tx: Database) => { tableName: SyncedTableName; rowId: string; rowData: Record<string, unknown>; result: T }): T` — Wraps a database mutation in a `BEGIN IMMEDIATE` transaction that atomically writes both the business table and the change_log entry. Uses `db.transaction().immediate()`.

The `rowData` field contains a **full row snapshot** as JSON — not a diff. This is the canonical event payload for the sync protocol.

The `siteId` parameter is the originating host's site_id (from host_meta table). It's passed in because the change_log preserves the ORIGINATING host's identity even when events are relayed through the hub.

Also provide typed query helpers:
- `insertRow(db: Database, table: SyncedTableName, row: Record<string, unknown>, siteId: string): void` — INSERT + change_log
- `updateRow(db: Database, table: SyncedTableName, id: string, updates: Record<string, unknown>, siteId: string): void` — UPDATE + change_log (sets modified_at automatically)
- `softDelete(db: Database, table: SyncedTableName, id: string, siteId: string): void` — Sets deleted=1, modified_at=now + change_log

**Testing:**
- Insert a row via `insertRow()`, verify both the business table and change_log have entries
- The change_log entry's `row_data` contains the full row snapshot as valid JSON
- Multiple writes in a single `withChangeLog` transaction are atomic (both succeed or both fail)
- Verify `seq` auto-increments correctly across multiple change_log entries

Test file: `packages/core/src/__tests__/change-log.test.ts` (integration — uses real SQLite in /tmp/)

**Verification:**
Run: `bun test packages/core/`
Expected: All tests pass

**Commit:** `feat(core): add transactional outbox change log producer`
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: @bound/core config loader with Zod validation

**Verifies:** system-arch.AC2.5, system-arch.AC2.6

**Files:**
- Create: `packages/core/src/config-loader.ts`
- Modify: `packages/core/src/index.ts` — add exports

**Implementation:**

`packages/core/src/config-loader.ts` — Loads config files from a `config/` directory, validates them against Zod schemas from `@bound/shared`, and returns typed config objects.

Key components:
- `expandEnvVars(value: string): string` — Replaces `${VAR_NAME}` patterns in strings with their environment variable values. Throws if a referenced env var is undefined and no default is provided. Supports `${VAR:-default}` syntax.
- `loadConfigFile<T>(configDir: string, filename: string, schema: ZodSchema<T>): Result<T, ConfigError>` — Reads JSON file, expands env vars in string values (recursive), validates with Zod schema. Returns `Result<T, ConfigError>` where `ConfigError` contains the filename and formatted Zod error messages.
- `ConfigError` type with fields: `filename: string`, `message: string`, `fieldErrors: Record<string, string[]>` — Structured error info from `z.treeifyError()` or `z.flattenError()`.
- `loadRequiredConfigs(configDir: string): Result<RequiredConfig, ConfigError[]>` — Loads both `allowlist.json` and `model_backends.json`. Returns all errors (not just the first), so the user sees every issue at once.
- `loadOptionalConfigs(configDir: string): OptionalConfigs` — Loads `network.json`, `discord.json`, `sync.json`, `keyring.json` if they exist. Missing files are not errors. Present but invalid files return errors.
- `RequiredConfig` type: `{ allowlist: AllowlistConfig; modelBackends: ModelBackendsConfig }`
- `OptionalConfigs` type: record mapping optional config names to their `Result<T, ConfigError>`

Env var expansion must be applied recursively to all string values in the parsed JSON before Zod validation, so that `"${DISCORD_BOT_TOKEN}"` becomes the actual token value before the schema checks it.

**Testing:**
Tests must verify AC2.5 and AC2.6:
- system-arch.AC2.5: Write valid JSON config files to a temp directory, load them, verify all fields are correctly parsed and typed.
- system-arch.AC2.6: Write invalid config files (missing `backends` array, missing `default_web_user`, extra unknown fields), verify specific error messages with field paths (e.g., "model_backends.json: backends — At least one backend must be configured").
- Env var expansion: Set `process.env.TEST_KEY = "value"`, write config with `"${TEST_KEY}"`, verify it resolves to `"value"`.
- Missing required config files produce clear "file not found" errors, not crashes.
- Optional config files that don't exist are silently skipped (not errors).

Test file: `packages/core/src/__tests__/config-loader.test.ts` (unit)

**Verification:**
Run: `bun test packages/core/`
Expected: All tests pass

**Commit:** `feat(core): add config file loader with Zod validation`
<!-- END_TASK_8 -->

<!-- START_TASK_9 -->
### Task 9: @bound/core DI container and AppContext

**Verifies:** system-arch.AC1.3

**Files:**
- Create: `packages/core/src/container.ts`
- Create: `packages/core/src/app-context.ts`
- Modify: `packages/core/src/index.ts` — add exports

**Implementation:**

**Note on tsyringe + Bun compatibility:** tsyringe requires `reflect-metadata` which has had compatibility issues with Bun. Import `reflect-metadata` as the first line in the container module. If runtime errors occur, try importing dynamically: `await import("reflect-metadata")`. If issues persist, fall back to a manual DI approach (factory function that constructs services in dependency order).

`packages/core/src/container.ts` — tsyringe DI container setup:

```typescript
import "reflect-metadata";
import { container, injectable, singleton } from "tsyringe";
```

Register core services as singletons:
- `DatabaseService` — wraps `Database` from `bun:sqlite`, provides typed query methods
- `ConfigService` — holds loaded config (RequiredConfig + OptionalConfigs)
- `EventBusService` — wraps `TypedEventEmitter` from `@bound/shared`
- `LoggerService` — wraps `createLogger` from `@bound/shared`

Provide a `bootstrapContainer(configDir: string, dbPath: string): container` function that:
1. Loads and validates config files via ConfigService
2. Creates the database and applies schema via DatabaseService
3. Registers EventBus and Logger
4. Returns the configured container

`packages/core/src/app-context.ts` — AppContext type that aggregates resolved services:

```typescript
export interface AppContext {
  db: Database;
  config: RequiredConfig;
  optionalConfig: OptionalConfigs;
  eventBus: TypedEventEmitter;
  logger: Logger;
  siteId: string;
  hostName: string;
}

export function createAppContext(configDir: string, dbPath: string): AppContext {
  // Resolve services from DI container
  // Read or create host_meta.site_id
  // Determine hostName from keyring or config
}
```

The `siteId` is read from `host_meta` table. On first startup, generate it from the Ed25519 public key (first 16 bytes of SHA-256, hex). Store it in `host_meta` and never change it. For Phase 1, generate a random site_id since Ed25519 key generation is Phase 2 work.

**Testing:**
Tests must verify AC1.3:
- system-arch.AC1.3: Call `bootstrapContainer()` with valid config files and a temp DB path. Resolve each registered service from the container. Verify all services are singletons (resolving twice returns the same instance). Verify no runtime errors during resolution.
- `createAppContext()` returns a fully populated AppContext with all fields non-null.

Test file: `packages/core/src/__tests__/container.test.ts` (integration — uses real SQLite + real config files in /tmp/)

**Verification:**
Run: `bun test packages/core/`
Expected: All tests pass

**Commit:** `feat(core): add DI container setup and AppContext factory`
<!-- END_TASK_9 -->

<!-- START_TASK_10 -->
### Task 10: @bound/core test suite and integration verification

**Verifies:** system-arch.AC3.1, system-arch.AC4.1

**Files:**
- Create: `packages/core/src/__tests__/schema.test.ts`
- Create: `packages/core/src/__tests__/change-log.test.ts`
- Create: `packages/core/src/__tests__/config-loader.test.ts`
- Create: `packages/core/src/__tests__/container.test.ts`
- Create: `packages/core/src/__tests__/integration.test.ts`

**Implementation:**

Write all test files described in Tasks 6-9. Additionally create an integration test that verifies the complete Phase 1 vertical slice:

`integration.test.ts` — End-to-end integration test:
1. Create temp directory with valid `allowlist.json` and `model_backends.json`
2. Call `createAppContext()` with the temp config dir and a temp DB path
3. Verify database has all 13 tables via `sqlite_master` query
4. Insert a user via `insertRow()`, verify change_log entry exists
5. Emit `message:created` on the event bus, verify a registered listener receives it
6. Verify WAL mode is active

Follow project test conventions:
- Integration tests use `*.integration.test.ts` suffix
- Create temp databases in `/tmp/bound-test-*` and clean up after each test
- Use `beforeEach`/`afterEach` for setup/teardown

**Step: Final operational verification**

Run from project root:
```bash
bun install
bun test --recursive
```

Expected: All workspace packages install, all tests pass across both packages. This verifies system-arch.AC3.1.

**Commit:** `test(core): add unit and integration tests for database, config, and container`
<!-- END_TASK_10 -->
<!-- END_SUBCOMPONENT_C -->
