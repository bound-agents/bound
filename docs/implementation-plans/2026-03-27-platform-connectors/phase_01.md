# Platform Connectors Implementation Plan — Phase 1: Schema + Type Foundations

**Goal:** Generalize all data model types from Discord-specific to platform-generic, adding `platform_ids`/`platforms` DB columns, new relay kinds + payload types, EventMap entries, and replacing `discord.json` config with `platforms.json`. No behavior changes — purely structural.

**Architecture:** Pure structural additions to `packages/shared` and `packages/core`. The DB migration adds `platform_ids`, populates it from `discord_id`, drops the index, then drops the column. TypeScript type changes are additive in this phase — `discord_id` is kept as `@deprecated` on the `User` type so the existing `packages/discord` package continues to compile. Full removal of `discord_id` from the TypeScript type happens in Phase 6 when the discord package is deleted.

**Tech Stack:** TypeScript, Zod v4 (`z.record()` requires two args: `z.record(z.string(), z.string())`), bun:sqlite 3.51.0 (supports `ALTER TABLE … DROP COLUMN` natively since SQLite 3.35.0+)

**Scope:** Phase 1 of 7 from docs/design-plans/2026-03-27-platform-connectors.md

**Codebase verified:** 2026-03-27

---

## Acceptance Criteria Coverage

### platform-connectors.AC1: Schema migrations applied correctly
- **platform-connectors.AC1.1 Success:** `users` table has `platform_ids TEXT` column after migration
- **platform-connectors.AC1.2 Success:** Rows with existing `discord_id` have `platform_ids` populated as `{"discord":"<id>"}` after migration
- **platform-connectors.AC1.3 Success:** `discord_id` column no longer exists after migration
- **platform-connectors.AC1.4 Success:** `hosts` table has `platforms TEXT` column after migration
- **platform-connectors.AC1.5 Success:** `threads.interface` accepts values other than `"web"` and `"discord"` (e.g. `"telegram"`)
- **platform-connectors.AC1.6 Failure:** `allowlist.json` with `discord_id` field fails validation with message referencing `platforms.discord`
- **platform-connectors.AC1.7 Success:** `allowlist.json` with `platforms.discord` passes validation

### platform-connectors.AC2: Config schema and loader
- **platform-connectors.AC2.1 Success:** `platforms.json` with valid Discord connector config loads successfully
- **platform-connectors.AC2.2 Failure:** `platforms.json` with invalid `leadership` value (`"manual"`) fails Zod validation
- **platform-connectors.AC2.3 Success:** `configSchemaMap` has no entry for `"discord.json"`
- **platform-connectors.AC2.4 Success:** `DiscordConfig` / `discordSchema` are not exported from `@bound/shared`

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Update shared types — User, Host, Thread, relay kinds, payload interfaces

**Verifies:** platform-connectors.AC1.5 (Thread.interface widening — enforced by TypeScript compiler)

**Files:**
- Modify: `packages/shared/src/types.ts`

**Implementation:**

**1a. Update the `User` interface** (currently at lines 34–41).

Add `platform_ids: string | null` after `display_name`. Mark `discord_id` as `@deprecated` and make it optional so `packages/discord` continues to compile in this phase. Full removal of `discord_id` from this type happens in Phase 6.

```typescript
export interface User {
  id: string;
  display_name: string;
  platform_ids: string | null;
  /** @deprecated removed in Phase 6 — use platform_ids */
  discord_id?: string | null;
  first_seen_at: string;
  modified_at: string;
  deleted: number;
}
```

**1b. Update the `Host` interface** (currently at lines 128–139).

Append `platforms: string | null` after `modified_at`:

```typescript
export interface Host {
  site_id: string;
  host_name: string;
  version: string | null;
  sync_url: string | null;
  mcp_servers: string | null;
  mcp_tools: string | null;
  models: string | null;
  overlay_root: string | null;
  online_at: string | null;
  modified_at: string;
  platforms: string | null;
}
```

**1c. Widen `Thread.interface`** (currently lines 43–57) from `"web" | "discord"` to `string`:

```typescript
export interface Thread {
  id: string;
  user_id: string;
  interface: string;  // widened from "web" | "discord"
  host_origin: string;
  color: number;
  title: string | null;
  summary: string | null;
  summary_through: string | null;
  summary_model_id: string | null;
  extracted_through: string | null;
  created_at: string;
  last_message_at: string;
  deleted: number;
}
```

**1d. Add new relay request kinds** to `RELAY_REQUEST_KINDS` (currently at lines 210–222):

```typescript
export const RELAY_REQUEST_KINDS = [
  "tool_call",
  "resource_read",
  "prompt_invoke",
  "cache_warm",
  "cancel",
  "inference",
  "process",
  "intake",
  "platform_deliver",
  "event_broadcast",
] as const;
```

**1e. Add new payload interfaces** after the last existing payload interface (after line 323). Place them adjacent to the other `*Payload` interfaces:

```typescript
export interface IntakePayload {
  platform: string;
  platform_event_id: string;
  thread_id: string;
  user_id: string;
  content: string;
  attachments?: unknown[];
}

export interface PlatformDeliverPayload {
  platform: string;
  thread_id: string;
  message_id: string;
  content: string;
  attachments?: unknown[];
}

export interface EventBroadcastPayload {
  event_name: string;
  event_payload: Record<string, unknown>;
  source_host: string;
  event_depth: number;
}
```

**Verification:**

Run: `tsc -p packages/shared --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat: add platform_ids/platforms to User/Host, widen Thread.interface, add intake/platform_deliver/event_broadcast relay kinds and payload types`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add platform:deliver and platform:webhook to EventMap

**Verifies:** (structural — event emission tested in later phases)

**Files:**
- Modify: `packages/shared/src/events.ts`

**Implementation:**

`packages/shared/src/events.ts` currently imports `StatusForwardPayload` from `./types`. Add `PlatformDeliverPayload` to that import, then add two new entries to `EventMap`.

Update the import at the top of the file:

```typescript
import type { Message, StatusForwardPayload, PlatformDeliverPayload } from "./types";
```

Add two entries at the end of the `EventMap` interface:

```typescript
export interface EventMap {
  "message:created": { message: Message; thread_id: string };
  "task:triggered": { task_id: string; trigger: string };
  "task:completed": { task_id: string; result: string | null };
  "sync:completed": { pushed: number; pulled: number; duration_ms: number };
  "sync:trigger": { reason: string };
  "file:changed": { path: string; operation: "created" | "modified" | "deleted" };
  "alert:created": { message: Message; thread_id: string };
  "agent:cancel": { thread_id: string };
  "status:forward": StatusForwardPayload;
  "platform:deliver": PlatformDeliverPayload;
  "platform:webhook": { platform: string; rawBody: string; headers: Record<string, string> };
}
```

**Verification:**

Run: `tsc -p packages/shared --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat: add platform:deliver and platform:webhook entries to EventMap`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Config schema — replace discord.json schema with platforms.json

**Verifies:** platform-connectors.AC1.6, AC1.7, AC2.1, AC2.2, AC2.3, AC2.4

**Files:**
- Modify: `packages/shared/src/config-schemas.ts`

**Implementation:**

**3a. Update `userEntrySchema`** (currently at lines 4–7).

Remove `discord_id` and add `platforms`. To satisfy AC1.6 (allowlist.json with `discord_id` fails with a specific message), explicitly define `discord_id` as a field that must be absent:

```typescript
const userEntrySchema = z
  .object({
    display_name: z.string().min(1),
    platforms: z.record(z.string(), z.string()).optional(),
    discord_id: z
      .string()
      .optional()
      .refine((v) => v === undefined, {
        message: "discord_id is no longer supported — use platforms.discord instead",
      }),
  })
  .transform(({ discord_id: _legacy, ...rest }) => rest);
```

Note: `z.record(z.string(), z.string())` — two arguments required in Zod v4.

**3b. Delete the `discordSchema` export and `DiscordConfig` type** (currently lines 78–83).

Remove these lines entirely:

```typescript
// DELETE:
export const discordSchema = z.object({
  bot_token: z.string().min(1),
  host: z.string().min(1),
});

export type DiscordConfig = z.infer<typeof discordSchema>;
```

**3c. Add `platformsSchema` and related exports** after the removed discord schema (or after `cronSchedulesSchema`):

```typescript
const connectorConfigSchema = z.object({
  platform: z.string().min(1),
  token: z.string().optional(),
  signing_secret: z.string().optional(),
  allowed_users: z.array(z.string()).default([]),
  leadership: z.enum(["auto", "leader", "standby", "all"]).default("auto"),
  failover_threshold_ms: z.number().int().positive().default(30_000),
});

export const platformsSchema = z.object({
  connectors: z.array(connectorConfigSchema).min(1),
});

export type PlatformConnectorConfig = z.infer<typeof connectorConfigSchema>;
export type PlatformsConfig = z.infer<typeof platformsSchema>;
```

**3d. Update `configSchemaMap`** (currently lines 171–181).

Replace `"discord.json": discordSchema` with `"platforms.json": platformsSchema`:

```typescript
export const configSchemaMap = {
  "allowlist.json": allowlistSchema,
  "model_backends.json": modelBackendsSchema,
  "network.json": networkSchema,
  "platforms.json": platformsSchema,
  "sync.json": syncSchema,
  "keyring.json": keyringSchema,
  "mcp.json": mcpSchema,
  "overlay.json": overlaySchema,
  "cron_schedules.json": cronSchedulesSchema,
} as const;
```

**3e. Update `ConfigType` union** (currently lines 159–168).

Replace `DiscordConfig` with `PlatformsConfig`:

```typescript
export type ConfigType =
  | AllowlistConfig
  | ModelBackendsConfig
  | NetworkConfig
  | PlatformsConfig
  | SyncConfig
  | KeyringConfig
  | McpConfig
  | OverlayConfig
  | CronSchedulesConfig;
```

**Verification:**

Run: `tsc -p packages/shared --noEmit`
Expected: No TypeScript errors (the deletion of `DiscordConfig` may cause errors in downstream packages — fix those in the next steps).

Run: `grep -n '"discord.json"' packages/shared/src/config-schemas.ts`
Expected: No output (entry removed).

**Commit:** `feat: replace discordSchema/DiscordConfig with platformsSchema/PlatformsConfig in config-schemas`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->

<!-- START_TASK_4 -->
### Task 4: Config loader — replace discord.json with platforms.json

**Verifies:** AC2.3 (config loader no longer references discord.json)

**Files:**
- Modify: `packages/core/src/config-loader.ts`

**Implementation:**

**4a. Update imports** in `packages/core/src/config-loader.ts`.

Remove the import of `discordSchema` and `DiscordConfig`. Add imports for `platformsSchema` and `PlatformsConfig`:

```typescript
// Remove:
// import { ..., discordSchema, DiscordConfig, ... } from "@bound/shared";

// Add (merge into existing import from @bound/shared):
import { ..., platformsSchema, PlatformsConfig, ... } from "@bound/shared";
```

**4b. Update the `optionalConfigs` array** (currently lines 201–217).

Replace the `discord.json` entry with a `platforms.json` entry:

```typescript
const optionalConfigs: Array<{
  filename: string;
  schema: ZodSchema<unknown>;
  key: string;
}> = [
  { filename: "network.json", schema: networkSchema as ZodSchema<unknown>, key: "network" },
  { filename: "platforms.json", schema: platformsSchema as ZodSchema<unknown>, key: "platforms" },
  { filename: "sync.json", schema: syncSchema as ZodSchema<unknown>, key: "sync" },
  { filename: "keyring.json", schema: keyringSchema as ZodSchema<unknown>, key: "keyring" },
  { filename: "mcp.json", schema: mcpSchema as ZodSchema<unknown>, key: "mcp" },
  { filename: "overlay.json", schema: overlaySchema as ZodSchema<unknown>, key: "overlay" },
  { filename: "cron_schedules.json", schema: cronSchedulesSchema as ZodSchema<unknown>, key: "cronSchedules" },
];
```

**4c. Find and update the `OptionalConfig` type.**

Search for the type definition that includes `discord?: DiscordConfig`:

```bash
grep -rn "discord.*DiscordConfig\|DiscordConfig.*discord" packages/ --include="*.ts" | grep -v node_modules
```

Update every occurrence: replace `discord?: DiscordConfig` with `platforms?: PlatformsConfig`. This type may be in `packages/core/src/config-loader.ts` or imported from `packages/shared`. Update the import and the type declaration at all found locations.

**Verification:**

Run: `tsc -p packages/core --noEmit`
Expected: No TypeScript errors in `packages/core`.

**Commit:** `feat: replace discord.json with platforms.json in config-loader optionalConfigs`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: SQLite schema migrations

**Verifies:** platform-connectors.AC1.1, AC1.2, AC1.3, AC1.4

**Files:**
- Modify: `packages/core/src/schema.ts`

**Implementation:**

In `packages/core/src/schema.ts`, locate the idempotent migration section (around lines 305–319) where `stream_id` columns are added using the `try { db.run(...) } catch { /* already exists */ }` pattern.

Add the following block **after** the existing `stream_id` migrations:

```typescript
// ── Platform connector migrations (Phase 1) ──────────────────────────────

// Add platform_ids column to users (replaces discord_id)
try {
  db.run(`ALTER TABLE users ADD COLUMN platform_ids TEXT`);
} catch {
  /* already exists */
}

// Migrate existing discord_id values → platform_ids JSON {"discord":"<id>"}
// Safe to re-run: WHERE clause skips rows already migrated
db.run(
  `UPDATE users
   SET    platform_ids = json_object('discord', discord_id)
   WHERE  discord_id IS NOT NULL
     AND  platform_ids IS NULL`,
);

// Drop the discord index BEFORE dropping the column
// (SQLite rejects DROP COLUMN on indexed columns)
db.run(`DROP INDEX IF EXISTS idx_users_discord`);

// Drop the discord_id column
// (Requires SQLite 3.35.0+; Bun bundles 3.51.0)
try {
  db.run(`ALTER TABLE users DROP COLUMN discord_id`);
} catch {
  /* already dropped, or column does not exist on fresh install */
}

// Add platforms column to hosts
try {
  db.run(`ALTER TABLE hosts ADD COLUMN platforms TEXT`);
} catch {
  /* already exists */
}
```

**Order is critical:** `DROP INDEX IF EXISTS` must execute before `DROP COLUMN` because SQLite refuses to drop a column that is still referenced by an index. The `try/catch` on `DROP COLUMN` handles re-runs where the column was already removed.

**Note on UPDATE idempotency:** The `WHERE platform_ids IS NULL` clause makes the UPDATE safe to re-run — it only populates rows that have not yet been migrated.

**Verification:**

Run: `tsc -p packages/core --noEmit`
Expected: No TypeScript errors.

Run: `bun test packages/core/src/__tests__/schema.test.ts`
Expected: All pre-existing tests pass (new tests are added in Task 6).

**Commit:** `feat: add platform_ids/hosts.platforms schema migrations and drop discord_id column`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 6-8) -->

<!-- START_TASK_6 -->
### Task 6: Update existing test files that reference `discord_id`

**Verifies:** (prerequisite — ensures `bun test --recursive` passes after Phase 1 drops the column)

**Files:**
- Modify: `packages/sync/src/__tests__/test-harness.ts` (mini-schema used by many integration tests)
- Modify: Any other test file found by the search below that INSERTs `discord_id`

**Implementation:**

After dropping the `discord_id` column in Task 5, existing tests that insert users with `discord_id` will fail at runtime. The `test-harness.ts` file in `packages/sync/src/__tests__/` defines a minimal schema for integration tests that likely includes `discord_id` in the users table CREATE statement.

**Step 1: Find all affected test files:**

```bash
grep -rln "discord_id" packages/ --include="*.test.ts" --include="*.integration.test.ts" | grep -v packages/discord | grep -v packages/platforms
```

**Step 2: For each file found, update the `discord_id` references:**

In SQL CREATE TABLE statements: remove the `discord_id TEXT` column.

In INSERT statements: replace `discord_id: "..."` or `discord_id = '...'` with `platform_ids: '{"discord":"..."}'` or `platform_ids = '{"discord":"..."}'`.

In SELECT/WHERE clauses: replace `WHERE discord_id = ?` with `WHERE json_extract(platform_ids, '$.discord') = ?`.

In test assertions: replace `.discord_id` field access with `JSON.parse(user.platform_ids ?? '{}').discord`.

**Step 3: Update `packages/sync/src/__tests__/test-harness.ts` specifically:**

Find the `users` table CREATE statement in the file. It currently has `discord_id TEXT`. Remove that column and add `platform_ids TEXT` instead. This affects all integration tests that use `createTestInstance()`.

**Verification:**

Run: `bun test --recursive`
Expected: No test failures related to `discord_id` column not found.

**Commit:** `fix: update all test files to use platform_ids instead of discord_id (Phase 1 schema migration)`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Schema migration tests

**Verifies:** platform-connectors.AC1.1, AC1.2, AC1.3, AC1.4, AC1.5

**Files:**
- Modify: `packages/core/src/__tests__/schema.test.ts`

**Implementation:**

Add a new `describe` block to the existing `schema.test.ts`. Follow the existing pattern: import `applySchema` (or equivalent DB-initialization function), create a temp in-memory or temp-file DB, and run assertions.

The key challenge for AC1.2 is verifying the migration path FROM a pre-existing `discord_id` value. This requires creating the DB with the OLD schema first, inserting data, then calling `applySchema` to trigger the migration.

Tests to add:

```typescript
describe("platform-connectors Phase 1 migrations", () => {
  it("AC1.1: users table has platform_ids column after applySchema", () => {
    // Create fresh in-memory DB and apply schema
    const db = new Database(":memory:");
    applySchema(db);
    const cols = db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("platform_ids");
  });

  it("AC1.2: existing discord_id rows are migrated to platform_ids", () => {
    const db = new Database(":memory:");
    // Apply OLD schema (before platform_ids exists) by running the base
    // CREATE TABLE with discord_id but without platform_ids
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        discord_id   TEXT,
        first_seen_at TEXT NOT NULL,
        modified_at  TEXT NOT NULL,
        deleted      INTEGER DEFAULT 0
      ) STRICT
    `);
    db.run(
      `INSERT INTO users VALUES ('u1', 'Alice', '12345', '2026-01-01', '2026-01-01', 0)`,
    );
    // Now run the full schema (triggers the migration)
    applySchema(db);
    const row = db.query("SELECT platform_ids FROM users WHERE id = 'u1'").get() as {
      platform_ids: string | null;
    };
    expect(row.platform_ids).toBe('{"discord":"12345"}');
  });

  it("AC1.3: discord_id column does not exist after applySchema", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const cols = db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain("discord_id");
  });

  it("AC1.4: hosts table has platforms column after applySchema", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const cols = db.query("PRAGMA table_info(hosts)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("platforms");
  });

  it("AC1.5: threads table accepts non-web-non-discord interface values", () => {
    const db = new Database(":memory:");
    applySchema(db);
    // Insert a thread with interface = "telegram" — should not throw
    expect(() => {
      db.run(
        `INSERT INTO threads (id, user_id, interface, host_origin, color, created_at, last_message_at, deleted)
         VALUES ('t1', 'u1', 'telegram', 'host1', 0, '2026-01-01', '2026-01-01', 0)`,
      );
    }).not.toThrow();
    const row = db.query("SELECT interface FROM threads WHERE id = 't1'").get() as {
      interface: string;
    };
    expect(row.interface).toBe("telegram");
  });
});
```

Note: Import `Database` from `"bun:sqlite"`. Import `applySchema` from the same location as the rest of the test file already imports it. Use `randomBytes(4).toString("hex")` for temp file paths if needed, following the existing test pattern.

**Verification:**

Run: `bun test packages/core/src/__tests__/schema.test.ts`
Expected: All tests pass including the five new ones.

**Commit:** `test: add platform-connectors Phase 1 schema migration tests (AC1.1–1.5)`
<!-- END_TASK_6 -->

<!-- START_TASK_8 -->
### Task 8: Config schema validation tests

**Verifies:** platform-connectors.AC1.6, AC1.7, AC2.1, AC2.2, AC2.3, AC2.4; and platform-connectors.AC3.1 (structural check that new relay kinds exist)

**Files:**
- Create: `packages/shared/src/__tests__/config-schemas.test.ts`

**Implementation:**

Create a new test file at `packages/shared/src/__tests__/config-schemas.test.ts`. Check whether the `packages/shared/src/__tests__/` directory exists first — if not, create it. Follow bun:test patterns (`import { describe, it, expect } from "bun:test"`).

```typescript
import { describe, it, expect } from "bun:test";
import {
  userEntrySchema,
  platformsSchema,
  configSchemaMap,
} from "../config-schemas";

describe("platform-connectors Phase 1 config schema validation", () => {
  // AC1.6: discord_id in allowlist.json entry must fail with helpful message
  it("AC1.6: userEntrySchema rejects discord_id with message referencing platforms.discord", () => {
    const result = userEntrySchema.safeParse({
      display_name: "Alice",
      discord_id: "12345",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("platforms.discord"))).toBe(true);
    }
  });

  // AC1.7: platforms.discord in allowlist.json entry must pass
  it("AC1.7: userEntrySchema accepts platforms.discord field", () => {
    const result = userEntrySchema.safeParse({
      display_name: "Alice",
      platforms: { discord: "12345" },
    });
    expect(result.success).toBe(true);
  });

  // AC2.1: valid Discord connector config parses successfully
  it("AC2.1: platformsSchema accepts valid Discord connector config", () => {
    const result = platformsSchema.safeParse({
      connectors: [
        {
          platform: "discord",
          token: "Bot.MyToken",
          leadership: "auto",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  // AC2.2: invalid leadership value "manual" must fail Zod validation
  it("AC2.2: platformsSchema rejects invalid leadership value 'manual'", () => {
    const result = platformsSchema.safeParse({
      connectors: [
        {
          platform: "discord",
          token: "Bot.MyToken",
          leadership: "manual",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  // AC2.3: configSchemaMap must not contain "discord.json"
  it('AC2.3: configSchemaMap has no "discord.json" entry', () => {
    expect("discord.json" in configSchemaMap).toBe(false);
  });

  // AC2.4: discordSchema and DiscordConfig must not be exported from @bound/shared
  // Checked at compile time (tsc will error if referenced), plus runtime check:
  it("AC2.4: discordSchema is not exported from config-schemas", async () => {
    const mod = await import("../config-schemas");
    expect("discordSchema" in mod).toBe(false);
  });
});

// AC3.1 tests are co-located in this file — bun:test allows multiple describe blocks.
// The describe/it/expect imports at the top of the file are reused here.
import { RELAY_REQUEST_KINDS } from "../types";

describe("platform-connectors.AC3.1 — new relay kinds exist", () => {
  it("AC3.1: RELAY_REQUEST_KINDS contains intake", () => {
    expect(RELAY_REQUEST_KINDS).toContain("intake");
  });
  it("AC3.1: RELAY_REQUEST_KINDS contains platform_deliver", () => {
    expect(RELAY_REQUEST_KINDS).toContain("platform_deliver");
  });
  it("AC3.1: RELAY_REQUEST_KINDS contains event_broadcast", () => {
    expect(RELAY_REQUEST_KINDS).toContain("event_broadcast");
  });
});
```

**Verification:**

Run: `bun test packages/shared/src/__tests__/config-schemas.test.ts`
Expected: All 6 tests pass.

Run: `bun run typecheck`
Expected: All packages pass typecheck. If `packages/discord` reports errors referencing the removed `DiscordConfig`, note them — they will be resolved in Phase 6 (when the discord package is deleted). For now, the package may need a local `// @ts-ignore` on the specific DiscordConfig import if it uses it.

Run: `bun test packages/core && bun test packages/shared`
Expected: All tests pass.

**Commit:** `test: add platform-connectors Phase 1 config schema validation tests (AC1.6–1.7, AC2.1–2.4)`
<!-- END_TASK_8 -->

<!-- END_SUBCOMPONENT_C -->
