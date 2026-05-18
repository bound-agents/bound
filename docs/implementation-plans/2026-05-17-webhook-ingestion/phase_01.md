# Webhook Ingestion Implementation Plan — Phase 1

**Goal:** `webhooks` table exists, syncs across hosts, `tasks.system_prompt_addition` column available.

**Architecture:** New synced LWW table following the established connector_handles pattern (deterministic UUID, soft deletes, unique partial index on name). New column on tasks via idempotent ALTER TABLE migration.

**Tech Stack:** bun:sqlite, TypeScript

**Scope:** 6 phases from original design (this is phase 1 of 6)

**Codebase verified:** 2026-05-17

---

## Acceptance Criteria Coverage

This phase is infrastructure — it creates schema and sync registration. No acceptance criteria are directly tested here; all ACs depend on this schema existing.

**Verifies: None** (infrastructure setup, verified operationally)

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Add `webhooks` CREATE TABLE to schema.ts

**Files:**
- Modify: `packages/core/src/schema.ts` (after connector_handles table at line 415)

**Step 1: Add the webhooks table definition**

Insert after the connector_handles CREATE TABLE block (after line 415), before the change_log section (line 417):

```typescript
	// 14. webhooks (synced) — HMAC-authenticated HTTP endpoints that trigger agent tasks
	db.run(`
		CREATE TABLE IF NOT EXISTS webhooks (
			id               TEXT PRIMARY KEY,
			name             TEXT NOT NULL,
			secret           TEXT NOT NULL,
			signature_format TEXT NOT NULL DEFAULT 'github',
			description      TEXT,
			task_id          TEXT NOT NULL,
			thread_id        TEXT NOT NULL,
			created_at       TEXT NOT NULL,
			deleted          INTEGER NOT NULL DEFAULT 0,
			modified_at      TEXT NOT NULL
		) STRICT
	`);

	db.run(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_webhooks_name
		ON webhooks(name) WHERE deleted = 0
	`);
```

**Step 2: Verify operationally**

Run: `bun run typecheck`
Expected: No new errors (schema.ts changes are runtime SQL strings, not type-checked)

**Step 3: Commit**

```bash
git add packages/core/src/schema.ts
git commit -m "feat(core): add webhooks synced table schema"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add `system_prompt_addition` column migration to schema.ts

**Files:**
- Modify: `packages/core/src/schema.ts` (in the migrations section, after line 604)

**Step 1: Add the idempotent ALTER TABLE**

Insert after the `origin_thread_id` migration block (after line 604):

```typescript
	// system_prompt_addition column on tasks — persistent prompt injection for
	// event tasks (webhooks, scheduled), replacing ephemeral WS-only mechanism.
	// Read by scheduler and relay processor when building AgentLoopConfig.
	try {
		db.run("ALTER TABLE tasks ADD COLUMN system_prompt_addition TEXT");
	} catch {
		/* already exists */
	}
```

**Step 2: Verify operationally**

Run: `bun run typecheck`
Expected: No new errors

**Step 3: Commit**

```bash
git add packages/core/src/schema.ts
git commit -m "feat(core): add system_prompt_addition column to tasks table"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add `system_prompt_addition` to Task interface in types.ts

**Files:**
- Modify: `packages/shared/src/types.ts` (Task interface at line 97-129)

**Step 1: Add the field to the Task interface**

Add after `no_quiescence` (line 121), before `heartbeat_at`:

```typescript
	system_prompt_addition: string | null;
```

**Step 2: Verify operationally**

Run: `bun run typecheck`
Expected: May surface compile errors in code that constructs Task objects without this field. Fix by adding `system_prompt_addition: null` to any test fixtures or factory functions that build Task rows.

**Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): add system_prompt_addition to Task interface"
```
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->

<!-- START_TASK_4 -->
### Task 4: Register `webhooks` in SyncedTableName and TABLE_REDUCER_MAP

**Files:**
- Modify: `packages/shared/src/types.ts` (lines 25-39 for SyncedTableName, lines 322-342 for TABLE_REDUCER_MAP)

**Step 1: Add to SyncedTableName union**

Add `| "webhooks"` after `| "connector_handles"` (line 38), before `| "turns"`:

```typescript
export type SyncedTableName =
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
	| "memory_edges"
	| "connector_handles"
	| "webhooks"
	| "turns";
```

**Step 2: Add to TABLE_REDUCER_MAP**

Add `webhooks: "lww",` after `connector_handles: "lww",` (line 335):

```typescript
export const TABLE_REDUCER_MAP: Record<SyncedTableName, ReducerType> = {
	users: "lww",
	threads: "lww",
	messages: "append-only",
	semantic_memory: "lww",
	tasks: "lww",
	files: "lww",
	hosts: "lww",
	overlay_index: "lww",
	cluster_config: "lww",
	advisories: "lww",
	skills: "lww",
	memory_edges: "lww",
	connector_handles: "lww",
	webhooks: "lww",
	turns: "append-only",
};
```

**Step 3: Verify operationally**

Run: `bun run typecheck`
Expected: Clean (the Record type will now require `webhooks` key, which we just added)

**Step 4: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): register webhooks as synced LWW table"
```
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Add `Webhook` interface to types.ts

**Files:**
- Modify: `packages/shared/src/types.ts` (after the Task interface, around line 130)

**Step 1: Add the Webhook interface**

Insert after the Task interface closing brace (line 129):

```typescript
export interface Webhook {
	id: string;
	name: string;
	secret: string;
	signature_format: SignatureFormat;
	description: string | null;
	task_id: string;
	thread_id: string;
	created_at: string;
	deleted: number;
	modified_at: string;
}

export type SignatureFormat = "github" | "stripe" | "slack" | "raw";
```

**Step 2: Add `webhooks` to `SyncedTableRowMap`**

In the same file (`packages/shared/src/types.ts`), find the `SyncedTableRowMap` interface (around line 302-317). Add after `connector_handles: ConnectorHandleRow;`:

```typescript
export interface SyncedTableRowMap {
	users: User;
	threads: Thread;
	messages: Message;
	semantic_memory: SemanticMemory;
	tasks: Task;
	files: AgentFile;
	hosts: Host;
	overlay_index: OverlayIndexEntry;
	cluster_config: ClusterConfigEntry;
	advisories: Advisory;
	skills: Skill;
	memory_edges: MemoryEdge;
	connector_handles: ConnectorHandleRow;
	webhooks: Webhook;
	turns: Turn;
}
```

**Step 4: Verify operationally**

Run: `bun run typecheck`
Expected: Clean

**Step 5: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): add Webhook interface, SignatureFormat type, and SyncedTableRowMap entry"
```
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 6-7) -->

<!-- START_TASK_6 -->
### Task 6: Add `webhooks` to SYNCED_TABLE_NAMES in schema-introspection.ts

**Files:**
- Modify: `packages/core/src/schema-introspection.ts` (lines 26-41)

**Step 1: Add webhooks to the array**

Add `"webhooks",` after `"connector_handles",` (line 39), before `"turns"`:

```typescript
const SYNCED_TABLE_NAMES: readonly SyncedTableName[] = [
	"users",
	"threads",
	"messages",
	"semantic_memory",
	"tasks",
	"files",
	"hosts",
	"overlay_index",
	"cluster_config",
	"advisories",
	"skills",
	"memory_edges",
	"connector_handles",
	"webhooks",
	"turns",
];
```

**Step 2: Verify operationally**

Run: `bun run typecheck`
Expected: Clean (typed as `readonly SyncedTableName[]`, so the literal is valid)

**Step 3: Commit**

```bash
git add packages/core/src/schema-introspection.ts
git commit -m "feat(core): expose webhooks table to agent query tool"
```
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Add `webhooks` to SNAPSHOT_TABLE_ORDER in ws-transport.ts

**Files:**
- Modify: `packages/sync/src/ws-transport.ts` (lines 109-124)

**Step 1: Add webhooks to the snapshot order**

Add `"webhooks",` after `"connector_handles",` (line 120). Position is after connector_handles because webhooks reference tasks (which come earlier in the array):

```typescript
const SNAPSHOT_TABLE_ORDER: SyncedTableName[] = [
	"users",
	"hosts",
	"cluster_config",
	"threads",
	"messages",
	"turns",
	"semantic_memory",
	"memory_edges",
	"tasks",
	"connector_handles",
	"webhooks",
	"files",
	"advisories",
	"skills",
	"overlay_index",
];
```

**Step 2: Verify operationally**

Run: `bun run typecheck`
Expected: Clean

**Step 3: Commit**

```bash
git add packages/sync/src/ws-transport.ts
git commit -m "feat(sync): include webhooks in snapshot seeding order"
```
<!-- END_TASK_7 -->

<!-- END_SUBCOMPONENT_C -->

<!-- START_TASK_8 -->
### Task 8: Run full test suite to verify no regressions

**Step 1: Run tests**

Run: `bun test --recursive`
Expected: All tests pass (3392+ passing, 0 failures)

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: Clean across all packages

If any tests fail due to the new `system_prompt_addition` field on Task interface (e.g., test fixtures constructing Task objects), fix by adding `system_prompt_addition: null` to those fixtures.

**Step 3: Commit any fixture fixes**

```bash
git add -A
git commit -m "fix(tests): add system_prompt_addition to Task test fixtures"
```

(Only if fixes were needed)
<!-- END_TASK_8 -->
