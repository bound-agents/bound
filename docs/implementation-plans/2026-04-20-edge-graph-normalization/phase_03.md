# Edge Graph Normalization Implementation Plan — Phase 3

**Goal:** Every node, on every startup, converges its `memory_edges` rows to the canonical state. First boot after deploy performs the real work; subsequent boots are zero-cost no-ops that double as a health check.

**Architecture:** A new `normalizeEdgeRelations(db, siteId, logger)` function in `@bound/core` drives the migration, using `updateRow()` for all mutations to emit changelog entries for sync. The function is called from `packages/cli/src/commands/start/bootstrap.ts` after `createAppContext()` where `siteId` is available — following the same pattern as `seedSkillAuthoring(db, siteId)`. The `clearColumnCache()` call also lives in `bootstrap.ts` after `applySchema()` returns.

**Tech Stack:** TypeScript, bun:sqlite, bun:test

**Scope:** 3 phases from original design (phase 3 of 3)

**Codebase verified:** 2026-04-21

**Key architectural finding:** `applySchema()` in `packages/core/src/schema.ts` takes only `(db: Database)` — no `siteId`. It is called from `bootstrapContainer()` in `packages/core/src/container.ts:71` before `siteId` is generated. The normalization migration MUST be called from `bootstrap.ts` (not `applySchema`) because `updateRow()` requires `siteId` for changelog entries. Additionally, `clearColumnCache()` from `@bound/sync` cannot be imported in `packages/core/src/schema.ts` (would create circular dep: core → sync → core) — it must also be called from `bootstrap.ts`.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### edge-graph-normalization.AC2: Data normalization runs on startup
- **edge-graph-normalization.AC2.1 Success:** The normalization routine runs automatically during schema init on every startup, after the `ALTER TABLE` and `CREATE TRIGGER` steps so that the `context` column and canonical-relation trigger are in place before any row updates.
- **edge-graph-normalization.AC2.2 Success:** Known spelling variants (e.g. `related-to`, `relates_to`, `relates`, `related`) are mapped to their canonical equivalent via a deterministic lookup table.
- **edge-graph-normalization.AC2.3 Success:** Rows with bespoke relations (not canonical, not in the spelling-variant table) have `relation` rewritten to `related_to` and the original relation preserved in `context`.
- **edge-graph-normalization.AC2.4 Success:** Normalization emits row-level change-log entries through the standard `updateRow()` path so peers replay the same transitions deterministically.
- **edge-graph-normalization.AC2.5 Success:** Startup logs summary counts for `{variants_mapped, moved_to_context, collisions_merged, total_scanned}` (zeros logged when the table is already canonical, so the log line doubles as a health signal on subsequent restarts).
- **edge-graph-normalization.AC2.6 Edge:** When normalization produces a `(source_key, target_key, relation)` triple that collides with an existing row under the unique index, the two rows are merged: keep the surviving row's id, take `max()` of the two weights, join distinct `context` values with `" | "`, soft-delete the loser (`deleted = 1`), bump `modified_at` on both.
- **edge-graph-normalization.AC2.7 Success:** Running startup a second time is a no-op for data — all non-deleted rows already have canonical relations, the SELECT that drives the loop returns zero rows, summary counts are all zero.
- **edge-graph-normalization.AC2.8 Success:** Each node in a multi-node cluster runs the normalization independently during its own startup and converges to the same canonical state; collision-merge results are deterministic across nodes given identical input data, so change-log entries from independent runs resolve under LWW without manual coordination.

### edge-graph-normalization.AC5: Sync round-trip
- **edge-graph-normalization.AC5.1 Success:** Peer A writes an edge with `context="foo"`; peer B receives the change-log entry and materializes the edge with `context="foo"` intact.
- **edge-graph-normalization.AC5.2 Success:** Peer B's trigger fires on replay — if peer A somehow emits a non-canonical relation, peer B's apply path surfaces the trigger error (audit path, not expected under normal deployment).
- **edge-graph-normalization.AC5.3 Success:** `memory_edges` in `FULL_SCHEMA` in `packages/sync/src/__tests__/test-harness.ts` includes the `context` column and the canonical-relation trigger so reducer tests exercise the full schema.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Create normalizeEdgeRelations module

**Verifies:** edge-graph-normalization.AC2.1, edge-graph-normalization.AC2.2, edge-graph-normalization.AC2.3, edge-graph-normalization.AC2.4, edge-graph-normalization.AC2.5, edge-graph-normalization.AC2.6

**Files:**
- Create: `packages/core/src/normalize-edge-relations.ts`

**Note:** The design plan specifies `packages/core/src/migrations/normalize-edge-relations.ts` (in a `migrations/` subdirectory). Since no `migrations/` directory currently exists in `packages/core/src/` and this is the only migration file, placing it directly in `src/` follows the existing flat structure. If more migration files are added in the future, consider extracting to a subdirectory at that point.

**Implementation:**

Create the normalization function. It runs against the DB, finds all non-deleted rows with non-canonical relations, and normalizes them using `updateRow()` and `softDelete()` from the change-log module.

```typescript
import type { Database } from "bun:sqlite";
import { softDelete, updateRow } from "./change-log";
import {
	CANONICAL_RELATIONS,
	SPELLING_VARIANTS,
	isCanonicalRelation,
} from "./memory-relations";

export interface NormalizationSummary {
	variants_mapped: number;
	moved_to_context: number;
	collisions_merged: number;
	total_scanned: number;
}

/**
 * Normalize memory_edges relations to the canonical set.
 *
 * Must be called AFTER applySchema() (so the context column and triggers exist)
 * and AFTER siteId is available (because updateRow() needs it for changelog entries).
 *
 * Idempotent: when all rows are already canonical, returns zeros.
 */
export function normalizeEdgeRelations(
	db: Database,
	siteId: string,
): NormalizationSummary {
	const summary: NormalizationSummary = {
		variants_mapped: 0,
		moved_to_context: 0,
		collisions_merged: 0,
		total_scanned: 0,
	};

	// Build the NOT IN clause from canonical set
	const canonicalList = CANONICAL_RELATIONS.map((r) => `'${r}'`).join(", ");

	// Select all non-deleted rows with non-canonical relations
	const rows = db
		.prepare(
			`SELECT id, source_key, target_key, relation, weight, context
			 FROM memory_edges
			 WHERE relation NOT IN (${canonicalList})
			   AND deleted = 0`,
		)
		.all() as Array<{
		id: string;
		source_key: string;
		target_key: string;
		relation: string;
		weight: number;
		context: string | null;
	}>;

	summary.total_scanned = rows.length;

	for (const row of rows) {
		const lowerRel = row.relation.toLowerCase();

		// Determine the target canonical relation
		let targetRelation: string;
		let preserveInContext = false;

		if (SPELLING_VARIANTS[lowerRel]) {
			// Known spelling variant → map to canonical
			targetRelation = SPELLING_VARIANTS[lowerRel];
		} else {
			// Bespoke relation → rewrite to related_to, preserve original in context
			targetRelation = "related_to";
			preserveInContext = true;
		}

		// Check for collision: does an active row already exist with
		// (source_key, target_key, targetRelation)?
		const collisionRow = db
			.prepare(
				`SELECT id, weight, context
				 FROM memory_edges
				 WHERE source_key = ? AND target_key = ? AND relation = ?
				   AND deleted = 0 AND id != ?`,
			)
			.get(row.source_key, row.target_key, targetRelation, row.id) as {
			id: string;
			weight: number;
			context: string | null;
		} | null;

		if (collisionRow) {
			// Collision-merge path:
			// - Survivor = the pre-existing row (collisionRow)
			// - Loser = the current row being normalized

			// Compute merged weight (max of both)
			const mergedWeight = Math.max(collisionRow.weight, row.weight);

			// Compute merged context (join distinct values with " | ")
			const contextParts: string[] = [];
			if (collisionRow.context) contextParts.push(collisionRow.context);
			if (preserveInContext && row.relation) contextParts.push(row.relation);
			if (row.context) contextParts.push(row.context);
			// Deduplicate parts
			const distinctParts = [...new Set(contextParts)];
			const mergedContext = distinctParts.length > 0 ? distinctParts.join(" | ") : null;

			// Update survivor with merged data
			const survivorUpdates: Record<string, unknown> = { weight: mergedWeight };
			if (mergedContext !== null) {
				survivorUpdates.context = mergedContext;
			}
			updateRow(db, "memory_edges", collisionRow.id, survivorUpdates, siteId);

			// Soft-delete the loser
			softDelete(db, "memory_edges", row.id, siteId);

			summary.collisions_merged++;
		} else {
			// No collision — straightforward rewrite
			const updates: Record<string, unknown> = { relation: targetRelation };

			if (preserveInContext) {
				// Join original relation with any existing context
				const contextParts: string[] = [];
				contextParts.push(row.relation);
				if (row.context) contextParts.push(row.context);
				updates.context = contextParts.join(" | ");
			}

			updateRow(db, "memory_edges", row.id, updates, siteId);

			if (preserveInContext) {
				summary.moved_to_context++;
			} else {
				summary.variants_mapped++;
			}
		}
	}

	return summary;
}
```

**Key design decisions:**
- The trigger must be temporarily disabled during normalization because `updateRow()` writes `relation = targetRelation` which the trigger allows, BUT the existing row currently has a non-canonical relation. The UPDATE is setting it TO a canonical value, so the BEFORE UPDATE trigger on `relation` will check `NEW.relation` — which IS canonical. So the trigger should NOT fire. This works correctly because `BEFORE UPDATE OF relation ... WHEN NEW.relation NOT IN (...)` checks the NEW value, not the OLD value.
- Collision merge keeps the pre-existing row (survivor) and soft-deletes the row being normalized (loser). This is deterministic: the survivor is always the one with the canonical relation already in place.
- Context deduplication uses `Set` to avoid repeating the same phrase when both rows already have context.

**Verification:**
Run: `tsc -p packages/core --noEmit`
Expected: No type errors

**Commit:** `feat(core): add normalizeEdgeRelations migration function`

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Export from core barrel and integrate into bootstrap

**Verifies:** edge-graph-normalization.AC2.1, edge-graph-normalization.AC1.5

**Files:**
- Modify: `packages/core/src/index.ts` (add export)
- Modify: `packages/cli/src/commands/start/bootstrap.ts` (call migration + clearColumnCache)

**Implementation:**

**Step 1:** Add export to `packages/core/src/index.ts`:

```typescript
export { normalizeEdgeRelations, type NormalizationSummary } from "./normalize-edge-relations";
```

**Step 2:** In `packages/cli/src/commands/start/bootstrap.ts`, add imports:

```typescript
import { normalizeEdgeRelations } from "@bound/core";
import { clearColumnCache } from "@bound/sync";
```

**Step 3:** Add `clearColumnCache()` call early in the bootstrap function, right after `createAppContext()` returns (this ensures the sync reducer picks up the new `context` column added by `applySchema()`):

```typescript
// Clear column cache so sync reducer discovers the new 'context' column on memory_edges
clearColumnCache();
```

**Step 4:** Add the normalization migration call after `seedSkillAuthoring` (around step 5.5), following the same try/catch pattern:

```typescript
// 5.6. Edge graph normalization (idempotent — no-op after first run)
try {
	const normSummary = normalizeEdgeRelations(appContext.db, appContext.siteId);
	appContext.logger.info("[edges] Normalized edge relations", normSummary);
} catch (error) {
	appContext.logger.warn("[edges] Failed to normalize edge relations", {
		error: error instanceof Error ? error.message : String(error),
	});
}
```

**Verification:**
Run: `tsc -p packages/cli --noEmit`
Expected: No type errors

**Commit:** `feat(cli): call normalizeEdgeRelations and clearColumnCache at startup`

<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-5) -->

<!-- START_TASK_3 -->
### Task 3: Tests for normalization — correctness and idempotency

**Verifies:** edge-graph-normalization.AC2.2, edge-graph-normalization.AC2.3, edge-graph-normalization.AC2.4, edge-graph-normalization.AC2.5, edge-graph-normalization.AC2.7

**Files:**
- Create: `packages/core/src/__tests__/normalize-edge-relations.test.ts`

**Testing:**

Create a test file for the normalization migration function. Follow the project pattern of using real SQLite databases (not mocks): `mkdtempSync` + `createDatabase()` + `applySchema()` in `beforeEach`.

**Important setup:** The trigger installed by `applySchema()` rejects non-canonical relations on INSERT. To seed test data with non-canonical relations, either:
- Insert rows BEFORE calling `applySchema()` (using the old schema without triggers), then call `applySchema()` which adds the trigger
- Or temporarily drop the trigger, insert test data, then recreate it
- The simplest approach: create the table manually without triggers, insert test data, then call `applySchema()` which adds the column + triggers idempotently

Tests must verify:

- **edge-graph-normalization.AC2.2:** Seed rows with spelling variants (`"related-to"`, `"relates_to"`, `"relates"`, `"informed-by"`, `"summarize"`). Run `normalizeEdgeRelations(db, siteId)`. Verify each row's `relation` is now the correct canonical value. Verify `context` is NULL for these rows (variants don't preserve the original in context).

- **edge-graph-normalization.AC2.3:** Seed rows with bespoke relations (`"durable-execution-pattern"`, `"Both CRDT implementations"`). Run migration. Verify `relation = "related_to"` and `context` contains the original relation string.

- **edge-graph-normalization.AC2.4:** After running migration, query `change_log` for `table_name = 'memory_edges'`. Verify changelog entries exist for each normalized row (one per `updateRow` call). Verify the `row_data` in each entry reflects the canonical relation.

- **edge-graph-normalization.AC2.5:** Verify the return value `{ variants_mapped, moved_to_context, collisions_merged, total_scanned }` has correct counts matching the seeded data.

- **edge-graph-normalization.AC2.7:** Run migration a second time on the same DB. Verify the return value is all zeros. Verify no new changelog entries were created (the driving SELECT returns 0 rows).

- **Trigger interaction (explicit):** Verify that `updateRow()` can change a non-canonical relation to a canonical one while the trigger is active. Seed a row with non-canonical relation (by inserting before the trigger exists, then installing trigger via `applySchema()`). Call `updateRow(db, "memory_edges", id, { relation: "related_to" }, siteId)`. Verify it succeeds (the trigger checks `NEW.relation`, which IS canonical). This explicitly validates the mechanism the normalization function relies on.

**Verification:**
Run: `bun test packages/core/src/__tests__/normalize-edge-relations.test.ts`
Expected: All tests pass

**Commit:** `test(core): add normalization correctness and idempotency tests`

<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Tests for collision-merge behavior

**Verifies:** edge-graph-normalization.AC2.6

**Files:**
- Modify: `packages/core/src/__tests__/normalize-edge-relations.test.ts` (add collision test block)

**Testing:**

Add a new `describe("collision-merge")` block to the normalization test file.

- **edge-graph-normalization.AC2.6:** Seed two rows for the same `(source_key, target_key)` pair:
  - Row A: `relation = "related_to"`, `weight = 0.5`, `context = "existing note"` (already canonical)
  - Row B: `relation = "related-to"`, `weight = 0.8`, `context = null` (spelling variant that maps to `related_to`)

  Run migration. Verify:
  - Row A (survivor) has `weight = 0.8` (max of 0.5 and 0.8)
  - Row A has `context = "existing note"` (no new context to merge from variant)
  - Row B is soft-deleted (`deleted = 1`)
  - Both rows have changelog entries
  - Summary shows `collisions_merged = 1`

  Also test bespoke collision:
  - Row C: `relation = "related_to"`, `weight = 1.0`, `context = null` (canonical)
  - Row D: `relation = "durable-execution-pattern"`, `weight = 2.0`, `context = "important"` (bespoke)

  Run migration. Verify:
  - Row C (survivor) has `weight = 2.0` (max)
  - Row C has `context = "durable-execution-pattern | important"` (original relation + existing context, joined)
  - Row D is soft-deleted

**Verification:**
Run: `bun test packages/core/src/__tests__/normalize-edge-relations.test.ts`
Expected: All tests pass

**Commit:** `test(core): add collision-merge tests for edge normalization`

<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Sync round-trip integration test

**Verifies:** edge-graph-normalization.AC5.1, edge-graph-normalization.AC5.2, edge-graph-normalization.AC5.3

**Files:**
- Create: `packages/sync/src/__tests__/edge-context-sync.integration.test.ts`

**Testing:**

Create an integration test that verifies the `context` column replicates correctly through the sync layer. Use `createWsTestCluster` from the test harness with the updated FULL_SCHEMA (which now includes the `context` column and triggers from Phase 1 Task 4).

Follow the pattern from existing sync integration tests:
- `createWsTestCluster({ spokeCount: 2, basePort: random, testRunId: unique })`
- Write to spoke[0] using `insertRow()`, read from spoke[1] after replication

Tests must verify:

- **edge-graph-normalization.AC5.1:** On spoke[0], use `insertRow()` to create a `memory_edges` row with `context = "foo"` and a canonical relation. Wait for replication. On spoke[1], query the same row by ID and verify `context = "foo"`.

- **edge-graph-normalization.AC5.2:** Attempt to apply a changelog entry with a non-canonical relation to spoke[1]'s DB. Verify the trigger fires and the apply path surfaces an error. This can be tested by manually creating a `ChangeLogEntry` with non-canonical relation in `row_data` and calling `applyLWWReducer()` — the trigger should reject the INSERT.

- **edge-graph-normalization.AC5.3:** Already covered by Phase 1 Task 4 (FULL_SCHEMA update). This test validates it works end-to-end.

**Verification:**
Run: `bun test packages/sync/src/__tests__/edge-context-sync.integration.test.ts`
Expected: All tests pass

**Commit:** `test(sync): add edge context sync round-trip integration test`

<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 6) -->

<!-- START_TASK_6 -->
### Task 6: Multi-node convergence test

**Verifies:** edge-graph-normalization.AC2.8

**Files:**
- Modify: `packages/core/src/__tests__/normalize-edge-relations.test.ts` (add convergence test block)

**Testing:**

Add a `describe("multi-node convergence")` block. This tests that two independent normalizations on identical data produce the same logical end state.

- **edge-graph-normalization.AC2.8:** Create two independent databases (db1, db2) with identical seed data containing non-canonical relations. Run `normalizeEdgeRelations()` on each independently (with different siteIds). Query both databases and verify:
  - Same set of non-deleted rows (by source_key/target_key/relation triple)
  - Same weights on all surviving rows
  - Same context values on all surviving rows
  - Same soft-deleted rows
  - The only difference should be `modified_at` timestamps and changelog `site_id` values

This proves the algorithm is deterministic on inputs — two nodes converge to the same canonical state independently.

**Verification:**
Run: `bun test packages/core/src/__tests__/normalize-edge-relations.test.ts`
Expected: All tests pass

**Commit:** `test(core): add multi-node convergence test for edge normalization`

<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_C -->
