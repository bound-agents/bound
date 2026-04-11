# Hierarchical Memory Retrieval Implementation Plan

**Goal:** Add a `tier` column to `semantic_memory` and define shared types to support four-tier memory hierarchy (`pinned`/`summary`/`default`/`detail`).

**Architecture:** Extends the existing semantic memory schema with a new `tier` column and backfills prefix-keyed entries as `pinned`. Uses the established idempotent ALTER TABLE migration pattern. Adds `MemoryTier` type to the shared package for cross-package type safety.

**Tech Stack:** TypeScript 6.x, bun:sqlite, Zod v4

**Scope:** 6 phases from original design (this is phase 1 of 6)

**Codebase verified:** 2026-04-10

---

## Acceptance Criteria Coverage

This phase implements and tests:

### hierarchical-memory.AC6: Backward compatibility & migration
- **hierarchical-memory.AC6.1 Success:** Idempotent ALTER TABLE succeeds on fresh and existing databases
- **hierarchical-memory.AC6.2 Success:** Prefix-keyed entries backfilled to `pinned` after migration
- **hierarchical-memory.AC6.3 Success:** Non-prefix entries remain `default` after migration
- **hierarchical-memory.AC6.4 Success:** Running migration twice produces same result

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Add `MemoryTier` type to shared package

**Verifies:** None (type-only, compiler verifies)

**Files:**
- Modify: `packages/shared/src/types.ts:20-21` (insert after `SkillStatus` type)

**Implementation:**

Add the `MemoryTier` string literal union type after the existing `SkillStatus` type definition at line 20. Follow the single-line union pattern used by `TaskType` (line 10) since there are only 4 values:

```typescript
export type MemoryTier = "pinned" | "summary" | "default" | "detail";
```

Then add the `tier` field to the `SemanticMemory` interface (currently at lines 77-86). Add it after `last_accessed_at` and before `deleted`:

```typescript
export interface SemanticMemory {
	id: string;
	key: string;
	value: string;
	source: string | null;
	created_at: string;
	modified_at: string;
	last_accessed_at: string | null;
	tier: MemoryTier;
	deleted: number;
}
```

**Verification:**
Run: `tsc -p packages/shared --noEmit`
Expected: No type errors

**Commit:** `feat(shared): add MemoryTier type and tier field to SemanticMemory interface`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add idempotent `tier` column migration and backfill to schema.ts

**Verifies:** None (infrastructure — verified operationally and by tests in Task 3)

**Files:**
- Modify: `packages/core/src/schema.ts:517-524` (insert before closing brace of `applySchema`)

**Implementation:**

Add the following migration block just before the closing `}` of the `applySchema()` function (before line 524). Follow the established `try { db.run("ALTER TABLE ...") } catch { /* already exists */ }` pattern used throughout (e.g., lines 426-430):

```typescript
	// Hierarchical memory: add tier column for retrieval priority classification
	try {
		db.run("ALTER TABLE semantic_memory ADD COLUMN tier TEXT DEFAULT 'default'");
	} catch {
		/* already exists */
	}

	// Partial index on tier for efficient tier-filtered queries (only non-deleted rows)
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_memory_tier ON semantic_memory(tier)
		WHERE deleted = 0
	`);

	// Backfill: prefix-keyed entries → pinned tier (idempotent — only updates default tier)
	// IMPORTANT: Use the EXACT same ESCAPE syntax as summary-extraction.ts lines 467-470.
	// Do NOT derive the escaping from scratch — copy the pattern from the existing codebase.
	// The correct escape sequence depends on the string context (template literal vs prepare()).
	// Reference: summary-extraction.ts uses LIKE '\\_standing%' ESCAPE '\\' inside prepare().
	db.run(`
		UPDATE semantic_memory SET tier = 'pinned'
		WHERE (key LIKE '\\_standing%' ESCAPE '\\'
			OR key LIKE '\\_feedback%' ESCAPE '\\'
			OR key LIKE '\\_policy%' ESCAPE '\\'
			OR key LIKE '\\_pinned%' ESCAPE '\\')
			AND tier = 'default' AND deleted = 0
	`);
```

**Critical note on ESCAPE syntax:** The ESCAPE clause must be identical across all four LIKE conditions. Copy the exact escape sequence from the existing prefix queries in `summary-extraction.ts` lines 467-470 — do NOT attempt to derive it from first principles. The string escaping behavior differs between template literals and `prepare()` strings. Run the backfill manually against a test DB to verify it matches the expected prefix keys before committing.

**Verification:**
Run: `tsc -p packages/core --noEmit`
Expected: No type errors

Run: `bun test packages/core/src/__tests__/schema.test.ts`
Expected: Existing schema tests still pass

**Commit:** `feat(core): add tier column migration and pinned backfill to semantic_memory`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Tests for tier column migration and backfill

**Verifies:** hierarchical-memory.AC6.1, hierarchical-memory.AC6.2, hierarchical-memory.AC6.3, hierarchical-memory.AC6.4

**Files:**
- Create: `packages/core/src/__tests__/tier-migration.test.ts`
- Modify: `packages/sync/src/__tests__/test-harness.ts:75-84` (add `tier` column to FULL_SCHEMA's semantic_memory table)

**Implementation:**

First, update the FULL_SCHEMA in `packages/sync/src/__tests__/test-harness.ts` to include the `tier` column in the `semantic_memory` table definition (after `last_accessed_at`, before `deleted`):

```sql
CREATE TABLE semantic_memory (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL,
    tier TEXT DEFAULT 'default',
    deleted INTEGER NOT NULL DEFAULT 0
);
```

Then create the test file. Tests use the established pattern: real SQLite databases via `createDatabase()` + `applySchema()` from `@bound/core`, with `randomBytes(4).toString("hex")` for temp DB path isolation.

**Testing:**

Tests must verify each AC listed above:
- **hierarchical-memory.AC6.1:** Apply schema on fresh DB → `tier` column exists. Apply schema on DB that already has `tier` column → no error (idempotent ALTER TABLE).
- **hierarchical-memory.AC6.2:** Insert rows with prefix keys (`_standing:x`, `_feedback:y`, `_policy:z`, `_pinned:w`) with default tier, then run `applySchema()` → verify all have `tier = 'pinned'`.
- **hierarchical-memory.AC6.3:** Insert rows with non-prefix keys, run `applySchema()` → verify they have `tier = 'default'`.
- **hierarchical-memory.AC6.4:** Run `applySchema()` twice on a DB with mixed prefix and non-prefix entries → same result both times, no errors.

Additional edge cases to test:
- Soft-deleted prefix entries (`deleted = 1`) should NOT be backfilled to `pinned` (the backfill WHERE clause includes `deleted = 0`)
- Entries already set to a non-default tier (e.g., `summary`) should not be overwritten by backfill (the WHERE clause includes `tier = 'default'`)

Follow project testing patterns from `packages/core/src/__tests__/schema.test.ts` and `packages/core/src/__tests__/metrics-schema.test.ts`.

**Verification:**
Run: `bun test packages/core/src/__tests__/tier-migration.test.ts`
Expected: All tests pass

Run: `bun test packages/core packages/sync`
Expected: All existing tests still pass (FULL_SCHEMA update doesn't break sync tests)

**Commit:** `test(core): add tier migration and backfill tests (AC6.1-AC6.4)`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
