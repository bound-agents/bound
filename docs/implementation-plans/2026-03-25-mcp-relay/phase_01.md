# MCP Relay Transport — Phase 1: Data Layer

**Goal:** Create relay tables, shared types, core CRUD helpers, and pruning logic — the foundation all subsequent relay phases build on.

**Architecture:** Two non-replicated SQLite tables (`relay_outbox`, `relay_inbox`) store ephemeral relay messages locally. CRUD helpers provide typed access with payload size enforcement (2MB limit) and periodic pruning. Relay config extends the existing sync config schema as an optional subsection.

**Tech Stack:** bun:sqlite (WAL mode, STRICT tables), Zod v4, TypeScript

**Scope:** 8 phases from original design (phase 1 of 8)

**Codebase verified:** 2026-03-25

---

## Acceptance Criteria Coverage

This phase implements and tests:

### mcp-relay.AC9: Data integrity
- **mcp-relay.AC9.1 Failure:** Payloads exceeding 2MB rejected at insert time
- **mcp-relay.AC9.3 Success:** Delivered outbox / processed inbox entries pruned after 5 minutes

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add relay tables to schema

**Files:**
- Modify: `packages/core/src/schema.ts:233-240` (append after `host_meta` table)

**Implementation:**

Add `relay_outbox` and `relay_inbox` table definitions to the `applySchema()` function, after the existing `host_meta` table (line 239). Follow the existing `CREATE TABLE IF NOT EXISTS ... STRICT` pattern with indexes.

```typescript
// After the host_meta table definition (line 239), add:

db.run(`
  CREATE TABLE IF NOT EXISTS relay_outbox (
    id              TEXT PRIMARY KEY,
    source_site_id  TEXT,
    target_site_id  TEXT NOT NULL,
    kind            TEXT NOT NULL,
    ref_id          TEXT,
    idempotency_key TEXT,
    payload         TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    delivered       INTEGER DEFAULT 0
  ) STRICT
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_relay_outbox_target
  ON relay_outbox(target_site_id, delivered)
  WHERE delivered = 0
`);

db.run(`
  CREATE TABLE IF NOT EXISTS relay_inbox (
    id              TEXT PRIMARY KEY,
    source_site_id  TEXT NOT NULL,
    kind            TEXT NOT NULL,
    ref_id          TEXT,
    idempotency_key TEXT,
    payload         TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    received_at     TEXT NOT NULL,
    processed       INTEGER DEFAULT 0
  ) STRICT
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_relay_inbox_unprocessed
  ON relay_inbox(processed)
  WHERE processed = 0
`);
```

**Verification:**

Run: `bun test packages/core/src/__tests__/schema.test.ts`
Expected: Existing schema tests still pass (idempotent CREATE TABLE IF NOT EXISTS).

**Commit:** `feat(core): add relay_outbox and relay_inbox tables to schema`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add relay types to shared package

**Files:**
- Modify: `packages/shared/src/types.ts:206` (append after TABLE_REDUCER_MAP)
- Modify: `packages/shared/src/index.ts` (add relay type exports)

**Implementation:**

Add relay message types, kind constants, and payload interfaces to `packages/shared/src/types.ts` after the existing `TABLE_REDUCER_MAP` (line 206). These types are NOT added to `SyncedTableName` because relay tables are local-only (like `change_log`, `sync_state`, `host_meta`).

```typescript
// --- Relay transport types (local-only, not synced) ---

export const RELAY_REQUEST_KINDS = [
	"tool_call",
	"resource_read",
	"prompt_invoke",
	"cache_warm",
	"cancel",
] as const;

export const RELAY_RESPONSE_KINDS = ["result", "error"] as const;

export const RELAY_KINDS = [
	...RELAY_REQUEST_KINDS,
	...RELAY_RESPONSE_KINDS,
] as const;

export type RelayRequestKind = (typeof RELAY_REQUEST_KINDS)[number];
export type RelayResponseKind = (typeof RELAY_RESPONSE_KINDS)[number];
export type RelayKind = (typeof RELAY_KINDS)[number];

export interface RelayOutboxEntry {
	id: string;
	source_site_id: string | null;
	target_site_id: string;
	kind: string;
	ref_id: string | null;
	idempotency_key: string | null;
	payload: string;
	created_at: string;
	expires_at: string;
	delivered: number;
}

export interface RelayInboxEntry {
	id: string;
	source_site_id: string;
	kind: string;
	ref_id: string | null;
	idempotency_key: string | null;
	payload: string;
	expires_at: string;
	received_at: string;
	processed: number;
}

export interface RelayMessage {
	id: string;
	target_site_id: string;
	source_site_id: string;
	kind: string;
	ref_id: string | null;
	idempotency_key: string | null;
	payload: string;
	created_at: string;
	expires_at: string;
}

// Request payloads (requester -> target)
export interface ToolCallPayload {
	tool: string;
	args: Record<string, unknown>;
	timeout_ms: number;
}

export interface ResourceReadPayload {
	resource_uri: string;
	timeout_ms: number;
}

export interface PromptInvokePayload {
	prompt_name: string;
	prompt_args: Record<string, unknown>;
	timeout_ms: number;
}

export interface CacheWarmPayload {
	paths: string[];
	timeout_ms: number;
}

// Response payloads (target -> requester)
export interface ResultPayload {
	stdout: string;
	stderr: string;
	exit_code: number;
	execution_ms: number;
}

export interface ErrorPayload {
	error: string;
	retriable: boolean;
}
```

Update `packages/shared/src/index.ts` to export the new relay types:

```typescript
// Add to existing exports:
export type {
	RelayOutboxEntry,
	RelayInboxEntry,
	RelayMessage,
	RelayRequestKind,
	RelayResponseKind,
	RelayKind,
	ToolCallPayload,
	ResourceReadPayload,
	PromptInvokePayload,
	CacheWarmPayload,
	ResultPayload,
	ErrorPayload,
} from "./types.js";

export {
	RELAY_REQUEST_KINDS,
	RELAY_RESPONSE_KINDS,
	RELAY_KINDS,
} from "./types.js";
```

**Verification:**

Run: `tsc -p packages/shared --noEmit`
Expected: No type errors.

**Commit:** `feat(shared): add relay message types, kind constants, and payload interfaces`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Add relay config schema

**Files:**
- Modify: `packages/shared/src/config-schemas.ts` (add relay schema, extend sync schema)

**Implementation:**

Add a relay configuration Zod schema and nest it as an optional field within the existing `syncSchema`. The relay config provides defaults for timeout, payload size limit, and pruning interval.

Locate the existing `syncSchema` definition (approximately lines 85-88):
```typescript
export const syncSchema = z.object({
	hub: z.string().min(1),
	sync_interval_seconds: z.number().int().positive().default(30),
});
```

Add the relay sub-schema and extend `syncSchema`:

```typescript
export const relaySchema = z.object({
	enabled: z.boolean().default(true),
	max_payload_bytes: z.number().int().positive().default(2 * 1024 * 1024),
	request_timeout_ms: z.number().int().positive().default(30_000),
	prune_interval_seconds: z.number().int().positive().default(60),
	prune_retention_seconds: z.number().int().positive().default(300),
	eager_push: z.boolean().default(true),
	drain_timeout_seconds: z.number().int().positive().default(120),
});

export type RelayConfig = z.infer<typeof relaySchema>;
```

Then update `syncSchema` to include the optional relay section:

```typescript
export const syncSchema = z.object({
	hub: z.string().min(1),
	sync_interval_seconds: z.number().int().positive().default(30),
	relay: relaySchema.optional(),
});
```

**Verification:**

Run: `tsc -p packages/shared --noEmit`
Expected: No type errors.

**Commit:** `feat(shared): add relay config Zod schema as optional sync subsection`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Update config loader for relay defaults

**Files:**
- Modify: `packages/core/src/config-loader.ts` (ensure relay defaults populate when sync.json omits relay section)

**Implementation:**

The sync config is already loaded as an optional config (line ~199 in the optionalConfigs array). Because `relay` is an optional field within `syncSchema` with all sub-fields having defaults, Zod automatically provides defaults when `relay` is present but fields are omitted. When `relay` is absent entirely, the field is `undefined`.

Add a helper to resolve relay config with defaults when the sync config exists but `relay` is not specified:

```typescript
import { relaySchema, type RelayConfig } from "@bound/shared";

export function resolveRelayConfig(
	syncConfig: z.infer<typeof syncSchema> | undefined,
): RelayConfig {
	if (!syncConfig?.relay) {
		return relaySchema.parse({});
	}
	return syncConfig.relay;
}
```

Export this function from `packages/core/src/index.ts`.

**Verification:**

Run: `tsc -p packages/core --noEmit`
Expected: No type errors.

**Commit:** `feat(core): add resolveRelayConfig helper for default relay settings`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->
<!-- START_TASK_5 -->
### Task 5: Create relay CRUD helpers

**Verifies:** mcp-relay.AC9.1, mcp-relay.AC9.3

**Files:**
- Create: `packages/core/src/relay.ts`
- Modify: `packages/core/src/index.ts` (add relay exports)

**Implementation:**

Create `packages/core/src/relay.ts` with all CRUD helpers for relay_outbox and relay_inbox. Follow the transaction and parameterized query patterns from `packages/core/src/change-log.ts`. These tables are NOT synced — no change_log entries needed.

The 2MB payload size limit (configurable via `max_payload_bytes`) must be enforced at insert time for both outbox and inbox writes (AC9.1). Pruning must hard-delete delivered outbox entries and processed inbox entries older than the retention period (AC9.3).

```typescript
import type { Database } from "bun:sqlite";
import type { RelayOutboxEntry, RelayInboxEntry, RelayConfig } from "@bound/shared";

const MAX_PAYLOAD_BYTES_DEFAULT = 2 * 1024 * 1024;

export class PayloadTooLargeError extends Error {
	constructor(size: number, limit: number) {
		super(`Relay payload size ${size} exceeds limit ${limit}`);
		this.name = "PayloadTooLargeError";
	}
}

function enforcePayloadLimit(payload: string, maxBytes: number): void {
	const size = new TextEncoder().encode(payload).byteLength;
	if (size > maxBytes) {
		throw new PayloadTooLargeError(size, maxBytes);
	}
}

export function writeOutbox(
	db: Database,
	entry: Omit<RelayOutboxEntry, "delivered">,
	maxPayloadBytes: number = MAX_PAYLOAD_BYTES_DEFAULT,
): void {
	enforcePayloadLimit(entry.payload, maxPayloadBytes);
	db.run(
		`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, ref_id, idempotency_key, payload, created_at, expires_at, delivered)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		[
			entry.id,
			entry.source_site_id,
			entry.target_site_id,
			entry.kind,
			entry.ref_id,
			entry.idempotency_key,
			entry.payload,
			entry.created_at,
			entry.expires_at,
		],
	);
}

export function readUndelivered(
	db: Database,
	targetSiteId?: string,
): RelayOutboxEntry[] {
	if (targetSiteId) {
		return db
			.query(
				`SELECT * FROM relay_outbox WHERE delivered = 0 AND target_site_id = ? ORDER BY created_at ASC`,
			)
			.all(targetSiteId) as RelayOutboxEntry[];
	}
	return db
		.query(`SELECT * FROM relay_outbox WHERE delivered = 0 ORDER BY created_at ASC`)
		.all() as RelayOutboxEntry[];
}

export function markDelivered(db: Database, ids: string[]): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => "?").join(", ");
	db.run(
		`UPDATE relay_outbox SET delivered = 1 WHERE id IN (${placeholders})`,
		ids,
	);
}

export function readUnprocessed(db: Database): RelayInboxEntry[] {
	return db
		.query(
			`SELECT * FROM relay_inbox WHERE processed = 0 ORDER BY received_at ASC`,
		)
		.all() as RelayInboxEntry[];
}

export function insertInbox(
	db: Database,
	entry: RelayInboxEntry,
	maxPayloadBytes: number = MAX_PAYLOAD_BYTES_DEFAULT,
): boolean {
	enforcePayloadLimit(entry.payload, maxPayloadBytes);
	const result = db.run(
		`INSERT OR IGNORE INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		[
			entry.id,
			entry.source_site_id,
			entry.kind,
			entry.ref_id,
			entry.idempotency_key,
			entry.payload,
			entry.expires_at,
			entry.received_at,
		],
	);
	return result.changes > 0;
}

export function markProcessed(db: Database, ids: string[]): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => "?").join(", ");
	db.run(
		`UPDATE relay_inbox SET processed = 1 WHERE id IN (${placeholders})`,
		ids,
	);
}

export function pruneRelayTables(
	db: Database,
	retentionSeconds: number = 300,
): { outboxPruned: number; inboxPruned: number } {
	const cutoff = new Date(
		Date.now() - retentionSeconds * 1000,
	).toISOString();

	const outboxResult = db.run(
		`DELETE FROM relay_outbox WHERE delivered = 1 AND created_at < ?`,
		[cutoff],
	);
	const inboxResult = db.run(
		`DELETE FROM relay_inbox WHERE processed = 1 AND received_at < ?`,
		[cutoff],
	);

	return {
		outboxPruned: outboxResult.changes,
		inboxPruned: inboxResult.changes,
	};
}

export function readInboxByRefId(
	db: Database,
	refId: string,
): RelayInboxEntry | null {
	return (
		db
			.query(
				`SELECT * FROM relay_inbox WHERE ref_id = ? AND processed = 0 ORDER BY received_at ASC LIMIT 1`,
			)
			.get(refId) as RelayInboxEntry | null
	);
}
```

Export from `packages/core/src/index.ts`:

```typescript
export {
	writeOutbox,
	readUndelivered,
	markDelivered,
	readUnprocessed,
	insertInbox,
	markProcessed,
	pruneRelayTables,
	readInboxByRefId,
	PayloadTooLargeError,
} from "./relay.js";
```

**Verification:**

Run: `tsc -p packages/core --noEmit`
Expected: No type errors.

**Commit:** `feat(core): add relay CRUD helpers with payload size enforcement and pruning`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Relay CRUD tests

**Verifies:** mcp-relay.AC9.1, mcp-relay.AC9.3

**Files:**
- Create: `packages/core/src/__tests__/relay.test.ts` (unit)

**Testing:**

Follow the existing test patterns from `packages/core/src/__tests__/schema.test.ts`:
- Use `bun:test` with `describe/it/expect/beforeEach/afterEach`
- Create a temp database per test with `randomBytes(4).toString("hex")`
- Call `applySchema(db)` to set up tables
- Clean up with `db.close()` and `unlinkSync()` in `afterEach`

Tests must verify each AC listed:
- **mcp-relay.AC9.1:** Write a payload exceeding 2MB to both `writeOutbox()` and `insertInbox()` — verify `PayloadTooLargeError` is thrown. Verify payloads under 2MB succeed.
- **mcp-relay.AC9.3:** Write entries, mark them as delivered/processed with timestamps >5 minutes old, call `pruneRelayTables()`, verify they are deleted. Verify non-delivered/non-processed entries are NOT pruned. Verify recently delivered/processed entries are NOT pruned.

Additional CRUD tests (not AC-specific but required for "Done when: CRUD helpers work"):
- `writeOutbox()` inserts a valid entry, `readUndelivered()` returns it
- `readUndelivered()` with targetSiteId filter returns only matching entries
- `markDelivered()` marks entries as delivered, `readUndelivered()` no longer returns them
- `insertInbox()` inserts a valid entry, `readUnprocessed()` returns it
- `insertInbox()` with duplicate ID returns false (INSERT OR IGNORE dedup)
- `markProcessed()` marks entries as processed, `readUnprocessed()` no longer returns them
- `readInboxByRefId()` returns matching unprocessed entry, returns null when none found

**Verification:**

Run: `bun test packages/core/src/__tests__/relay.test.ts`
Expected: All tests pass.

Run: `bun test packages/core`
Expected: All existing + new tests pass.

**Commit:** `test(core): add relay CRUD helper tests for outbox, inbox, pruning, and payload limits`
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_C -->
