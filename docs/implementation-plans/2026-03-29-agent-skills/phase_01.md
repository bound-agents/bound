# Agent Skills Implementation Plan — Phase 1: Database Foundation

**Goal:** Add the `skills` table to the synced-table infrastructure so the change-log outbox works.

**Architecture:** Extend `SyncedTableName` union and `TABLE_REDUCER_MAP` in `@bound/shared`, add the `skills` CREATE TABLE and unique index in `@bound/core`'s schema, and update schema tests to cover all Phase 1 ACs.

**Tech Stack:** TypeScript, bun:sqlite STRICT tables, bun:test

**Scope:** Phase 1 of 6

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### agent-skills.AC1: `skills` table is schema-compliant and synced

- **agent-skills.AC1.1 Success:** `applySchema()` creates the `skills` table in STRICT mode with all required columns
- **agent-skills.AC1.2 Success:** `"skills"` is in `SyncedTableName`; `TABLE_REDUCER_MAP.skills === "lww"`
- **agent-skills.AC1.3 Success:** `insertRow(db, "skills", ...)` and `updateRow(db, "skills", ...)` write a change-log entry
- **agent-skills.AC1.4 Failure:** Inserting a second active skill with the same name violates the unique index
- **agent-skills.AC1.5 Edge:** `applySchema()` is idempotent; running it twice does not error

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Add `SkillStatus` type, `Skill` interface, and synced-table registrations to `packages/shared`

**Verifies:** agent-skills.AC1.2 (TypeScript compilation verifies `SyncedTableName` and `TABLE_REDUCER_MAP` coverage)

**Files:**
- Modify: `packages/shared/src/types.ts:20-30` (SyncedTableName union)
- Modify: `packages/shared/src/types.ts:196-207` (TABLE_REDUCER_MAP)
- Modify: `packages/shared/src/types.ts:194` (after Advisory interface, before TABLE_REDUCER_MAP)

**Implementation:**

**Step 1: Add `SkillStatus` type after `AdvisoryStatus` on line 18**

Add the following line after line 18 (`export type AdvisoryStatus = ...`):

```typescript
export type SkillStatus = "active" | "retired";
```

**Step 2: Add `"skills"` to `SyncedTableName` (lines 20-30)**

Change:
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
	| "advisories";
```

To:
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
	| "skills";
```

**Step 3: Add `Skill` interface after the `Advisory` interface (after line 194, before the blank line before TABLE_REDUCER_MAP)**

```typescript
export interface Skill {
	id: string;
	name: string;
	description: string;
	status: SkillStatus;
	skill_root: string;
	content_hash: string | null;
	allowed_tools: string | null;
	compatibility: string | null;
	metadata_json: string | null;
	activated_at: string | null;
	created_by_thread: string | null;
	activation_count: number;
	last_activated_at: string | null;
	retired_by: string | null;
	retired_reason: string | null;
	modified_at: string;
}
```

**Step 4: Add `skills: "lww"` to `TABLE_REDUCER_MAP` (lines 196-207)**

Change:
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
};
```

To:
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
};
```

**Verification:**

Run: `tsc -p packages/shared --noEmit`
Expected: No errors. TypeScript verifies that `TABLE_REDUCER_MAP` covers all members of `SyncedTableName` including the new `"skills"` entry.

Run: `bun test packages/shared`
Expected: All existing tests pass.

**Commit:** `feat(shared): add skills to SyncedTableName and TABLE_REDUCER_MAP`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add `skills` table and unique index to `packages/core` schema

**Verifies:** agent-skills.AC1.1, agent-skills.AC1.4, agent-skills.AC1.5

**Files:**
- Modify: `packages/core/src/schema.ts:200` (after the advisories table, before the `// 11. change_log` comment)

**Implementation:**

**Step 1: Insert the `skills` table block after line 200 (closing `);` of the advisories table)**

Add the following immediately after line 200:

```typescript
	// 11. skills
	db.run(`
		CREATE TABLE IF NOT EXISTS skills (
			id                TEXT PRIMARY KEY,
			name              TEXT NOT NULL,
			description       TEXT NOT NULL,
			status            TEXT NOT NULL,
			skill_root        TEXT NOT NULL,
			content_hash      TEXT,
			allowed_tools     TEXT,
			compatibility     TEXT,
			metadata_json     TEXT,
			activated_at      TEXT,
			created_by_thread TEXT,
			activation_count  INTEGER DEFAULT 0,
			last_activated_at TEXT,
			retired_by        TEXT,
			retired_reason    TEXT,
			modified_at       TEXT NOT NULL,
			deleted           INTEGER DEFAULT 0
		) STRICT
	`);

	db.run(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name ON skills(name)
			WHERE deleted = 0
	`);
```

After inserting this block, renumber the existing `// 11. change_log` comment to `// 12. change_log`, `// 12. sync_state` to `// 13. sync_state`, and so on through `// 16. relay_cycles` to `// 17. relay_cycles`.

**Verification:**

Run: `tsc -p packages/core --noEmit`
Expected: No errors.

**Commit:** `feat(core): add skills table to schema`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Update schema tests to cover all agent-skills.AC1.* cases

**Verifies:** agent-skills.AC1.1, agent-skills.AC1.3, agent-skills.AC1.4, agent-skills.AC1.5

**Files:**
- Modify: `packages/core/src/__tests__/schema.test.ts`

**Implementation:**

Make the following targeted edits to `packages/core/src/__tests__/schema.test.ts`:

**Edit 1 — Update "applies schema successfully creating all 16 tables" test**

Change the test description from `"applies schema successfully creating all 16 tables"` to `"applies schema successfully creating all 17 tables"`.

Add `expect(tableNames).toContain("skills");` after the line `expect(tableNames).toContain("advisories");` (line 57).

Change `expect(tableNames.length).toBe(16)` to `expect(tableNames.length).toBe(17)` (line 65).

**Edit 2 — Update "creates all indexes" test**

Add `expect(indexNames).toContain("idx_skills_name");` after `expect(indexNames).toContain("idx_files_path");` (line 84).

**Edit 3 — Update "allows idempotent schema application" test**

Change `// Still exactly 16 tables` comment to `// Still exactly 17 tables`.
Change `expect(tables.length).toBe(16)` to `expect(tables.length).toBe(17)` (line 125).

**Edit 4 — Add new test: verifies skills table columns (AC1.1)**

Add this test after the existing `"verifies tasks table has all required columns"` test:

```typescript
it("verifies skills table has all required columns", () => {
	const db = createDatabase(dbPath);
	applySchema(db);

	const columns = db.query("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
	const columnNames = columns.map((c) => c.name);

	expect(columnNames).toContain("id");
	expect(columnNames).toContain("name");
	expect(columnNames).toContain("description");
	expect(columnNames).toContain("status");
	expect(columnNames).toContain("skill_root");
	expect(columnNames).toContain("content_hash");
	expect(columnNames).toContain("allowed_tools");
	expect(columnNames).toContain("compatibility");
	expect(columnNames).toContain("metadata_json");
	expect(columnNames).toContain("activated_at");
	expect(columnNames).toContain("created_by_thread");
	expect(columnNames).toContain("activation_count");
	expect(columnNames).toContain("last_activated_at");
	expect(columnNames).toContain("retired_by");
	expect(columnNames).toContain("retired_reason");
	expect(columnNames).toContain("modified_at");
	expect(columnNames).toContain("deleted");

	db.close();
});
```

**Edit 5 — Add new test: unique index rejects duplicate active skill name (AC1.4)**

```typescript
it("enforces unique index on active skill name", () => {
	const db = createDatabase(dbPath);
	applySchema(db);
	const now = new Date().toISOString();

	db.run(
		`INSERT INTO skills (id, name, description, status, skill_root, activation_count, modified_at, deleted)
		 VALUES ('id-1', 'pr-review', 'Review PRs', 'active', '/home/user/skills/pr-review', 0, ?, 0)`,
		[now],
	);

	// Inserting a second active skill with the same name must fail
	expect(() => {
		db.run(
			`INSERT INTO skills (id, name, description, status, skill_root, activation_count, modified_at, deleted)
			 VALUES ('id-2', 'pr-review', 'Duplicate', 'active', '/home/user/skills/pr-review', 0, ?, 0)`,
			[now],
		);
	}).toThrow();

	db.close();
});
```

**Edit 6 — Add new test: insertRow and updateRow write change-log entries for skills (AC1.3)**

Add the following imports at the top of `schema.test.ts` (after the existing imports):

```typescript
import { randomUUID } from "node:crypto";
import { insertRow, updateRow } from "../change-log";
```

Then add the test:

```typescript
it("insertRow and updateRow write change-log entries for skills table", () => {
	const db = createDatabase(dbPath);
	applySchema(db);
	const siteId = "test-site";
	const skillId = randomUUID();
	const now = new Date().toISOString();

	insertRow(
		db,
		"skills",
		{
			id: skillId,
			name: "test-skill",
			description: "A test skill",
			status: "active",
			skill_root: "/home/user/skills/test-skill",
			content_hash: null,
			allowed_tools: null,
			compatibility: null,
			metadata_json: null,
			activated_at: null,
			created_by_thread: null,
			activation_count: 0,
			last_activated_at: null,
			retired_by: null,
			retired_reason: null,
			modified_at: now,
			deleted: 0,
		},
		siteId,
	);

	const entry = db
		.query("SELECT * FROM change_log WHERE row_id = ?")
		.get(skillId) as Record<string, unknown>;
	expect(entry).toBeDefined();
	expect(entry.table_name).toBe("skills");

	updateRow(
		db,
		"skills",
		skillId,
		{ description: "Updated description", modified_at: now },
		siteId,
	);

	const entries = db
		.query("SELECT * FROM change_log WHERE row_id = ? ORDER BY seq")
		.all(skillId) as Array<Record<string, unknown>>;
	expect(entries).toHaveLength(2);
	expect(entries[1].table_name).toBe("skills");

	db.close();
});
```

**Verification:**

Run: `bun test packages/core`
Expected: All tests pass. Count increases from 104 to 108+ tests.

Run: `bun test packages/shared`
Expected: All existing tests pass.

Run: `tsc -p packages/shared --noEmit && tsc -p packages/core --noEmit`
Expected: No TypeScript errors.

**Commit:** `test(core): add skills table schema tests covering AC1.1–AC1.5`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
