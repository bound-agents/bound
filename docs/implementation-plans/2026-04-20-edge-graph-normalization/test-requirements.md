# Test Requirements: Edge Graph Normalization

## Automated Test Coverage

### AC1: Schema and trigger in place

**AC1.1** -- Fresh DB init creates `memory_edges` with the `context TEXT` column and canonical-relation trigger.
- Test type: unit
- Test file: `packages/core/src/__tests__/memory-edges-schema.test.ts`
- Verifies: After `createDatabase()` + `applySchema()`, `PRAGMA table_info(memory_edges)` includes a `context` column of type `TEXT`, and `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_edges'` returns both trigger names.
- Phase: 1, Task 5

**AC1.2** -- Existing DB with data gains the `context` column via `ALTER TABLE` wrapped in the duplicate-column try/catch pattern.
- Test type: unit
- Test file: `packages/core/src/__tests__/memory-edges-schema.test.ts`
- Verifies: Create the table manually without the `context` column, insert a test row, then call `applySchema()`. The `context` column now exists and the test row data survived.
- Phase: 1, Task 5

**AC1.3** -- The trigger is created via `CREATE TRIGGER IF NOT EXISTS` for BEFORE INSERT and BEFORE UPDATE OF relation, idempotent across restarts.
- Test type: unit
- Test file: `packages/core/src/__tests__/memory-edges-schema.test.ts`
- Verifies: After `applySchema()`, exactly 2 triggers on `memory_edges` exist with the names `memory_edges_canonical_relation_insert` and `memory_edges_canonical_relation_update`.
- Phase: 1, Task 5

**AC1.4** -- Running schema init twice is a no-op (no errors, no data change, trigger count unchanged).
- Test type: unit
- Test file: `packages/core/src/__tests__/memory-edges-schema.test.ts`
- Verifies: Call `applySchema()` twice on the same DB. No errors thrown, trigger count is still exactly 2, and existing row data is unchanged.
- Phase: 1, Task 5

**AC1.5** -- The reducer column cache is cleared after the ALTER runs so long-running agent processes pick up the new column without restart.
- Test type: unit
- Test file: `packages/core/src/__tests__/memory-edges-schema.test.ts`
- Verifies: After `applySchema()` completes and `clearColumnCache()` is called (from `bootstrap.ts`), the sync reducer's column discovery via `PRAGMA table_info` includes `context`. The integration point is in `bootstrap.ts` rather than `schema.ts` because `clearColumnCache` lives in `@bound/sync` and cannot be imported into `@bound/core` without creating a circular dependency. The bootstrap-level call is validated by the sync integration test (AC5.1) which exercises the full schema including the new column through the reducer.
- Phase: 1, Task 3 (schema change); Phase 3, Task 2 (bootstrap call)

---

### AC2: Data normalization runs on startup

**AC2.1** -- The normalization routine runs automatically during schema init on every startup, after the `ALTER TABLE` and `CREATE TRIGGER` steps.
- Test type: unit
- Test file: `packages/core/src/__tests__/normalize-edge-relations.test.ts`
- Verifies: Seed a DB with non-canonical relations (inserting before triggers are installed), then call `applySchema()` followed by `normalizeEdgeRelations()`. The normalization succeeds without trigger errors because it runs after both the column addition and trigger installation. The bootstrap integration point (`bootstrap.ts` calling `normalizeEdgeRelations` after `createAppContext`) is validated by the fact that `normalizeEdgeRelations` requires `siteId` as a parameter, which is only available after `createAppContext()` returns.
- Phase: 3, Task 1

**AC2.2** -- Known spelling variants are mapped to their canonical equivalent via a deterministic lookup table.
- Test type: unit
- Test file: `packages/core/src/__tests__/normalize-edge-relations.test.ts`
- Verifies: Seed rows with spelling variants (`"related-to"`, `"relates_to"`, `"relates"`, `"informed-by"`, `"summarize"`). Run `normalizeEdgeRelations()`. Each row's `relation` is the correct canonical value. The `context` column is NULL for these rows (variants do not preserve the original in context).
- Phase: 3, Task 3

**AC2.3** -- Rows with bespoke relations have `relation` rewritten to `related_to` and the original relation preserved in `context`.
- Test type: unit
- Test file: `packages/core/src/__tests__/normalize-edge-relations.test.ts`
- Verifies: Seed rows with bespoke relations (`"durable-execution-pattern"`, `"Both CRDT implementations"`). Run migration. Each row has `relation = "related_to"` and `context` contains the original relation string.
- Phase: 3, Task 3

**AC2.4** -- Normalization emits row-level change-log entries through the standard `updateRow()` path.
- Test type: unit
- Test file: `packages/core/src/__tests__/normalize-edge-relations.test.ts`
- Verifies: After running migration, query `change_log` for `table_name = 'memory_edges'`. Changelog entries exist for each normalized row. The `row_data` in each entry reflects the canonical relation.
- Phase: 3, Task 3

**AC2.5** -- Startup logs summary counts for `{variants_mapped, moved_to_context, collisions_merged, total_scanned}`.
- Test type: unit
- Test file: `packages/core/src/__tests__/normalize-edge-relations.test.ts`
- Verifies: The return value of `normalizeEdgeRelations()` is a `NormalizationSummary` with correct counts matching the seeded data. The logging itself happens at the call site in `bootstrap.ts` via `appContext.logger.info()`.
- Phase: 3, Task 3

**AC2.6** -- Collision-merge: when normalization produces a duplicate `(source_key, target_key, relation)` triple, the two rows are merged with `max()` weight, joined context, and soft-delete of the loser.
- Test type: unit
- Test file: `packages/core/src/__tests__/normalize-edge-relations.test.ts`
- Verifies two scenarios:
  1. Spelling-variant collision: Row A (`related_to`, weight 0.5, context "existing note") + Row B (`related-to`, weight 0.8, context null). After migration: Row A survives with weight 0.8 and context "existing note"; Row B is soft-deleted; summary shows `collisions_merged = 1`.
  2. Bespoke collision: Row C (`related_to`, weight 1.0, context null) + Row D (`durable-execution-pattern`, weight 2.0, context "important"). After migration: Row C survives with weight 2.0 and context `"durable-execution-pattern | important"`; Row D is soft-deleted.
- Phase: 3, Task 4

**AC2.7** -- Running startup a second time is a no-op for data.
- Test type: unit
- Test file: `packages/core/src/__tests__/normalize-edge-relations.test.ts`
- Verifies: Run migration, then run it again. Second run returns all-zero summary counts. No new changelog entries are created between the two runs.
- Phase: 3, Task 3

**AC2.8** -- Each node in a multi-node cluster runs the normalization independently and converges to the same canonical state.
- Test type: unit
- Test file: `packages/core/src/__tests__/normalize-edge-relations.test.ts`
- Verifies: Create two independent databases with identical seed data containing non-canonical relations. Run `normalizeEdgeRelations()` on each with different `siteId` values. Both databases end up with the same set of non-deleted rows (by source_key/target_key/relation triple), same weights, same context values, and same soft-deleted rows. The only differences are `modified_at` timestamps and changelog `site_id` values.
- Phase: 3, Task 6

---

### AC3: Runtime enforcement

**AC3.1** -- `upsertEdge()` called with a non-canonical relation throws `InvalidRelationError`; no row is written; no change-log entry is emitted.
- Test type: unit
- Test file: `packages/agent/src/__tests__/graph-memory-edges.test.ts`
- Verifies: Call `upsertEdge(db, src, tgt, "not-a-relation", 1.0, siteId)`. It throws `InvalidRelationError`. No row exists in `memory_edges` for the deterministic ID. No `change_log` entry was emitted for that row_id.
- Phase: 2, Task 3

**AC3.2** -- Direct SQL `INSERT INTO memory_edges` with a non-canonical relation fails with the trigger's `RAISE(ABORT, ...)` message.
- Test type: unit
- Test file: `packages/core/src/__tests__/memory-edges-schema.test.ts`
- Verifies: After `applySchema()`, attempt a direct `INSERT INTO memory_edges` with `relation = 'bespoke-thing'`. It throws an error whose message contains the list of valid relations.
- Phase: 1, Task 5

**AC3.3** -- Direct SQL `UPDATE memory_edges SET relation = '<bespoke>'` fails with the same trigger error.
- Test type: unit
- Test file: `packages/core/src/__tests__/memory-edges-schema.test.ts`
- Verifies: Insert a row with a canonical relation, then attempt `UPDATE memory_edges SET relation = 'bespoke-thing' WHERE id = ?`. It throws an error whose message contains the list of valid relations.
- Phase: 1, Task 5

**AC3.4** -- The canonical relation set is defined in exactly one place and imported by both the schema module and `graph-queries.ts`.
- Test type: unit
- Test file: `packages/core/src/__tests__/memory-edges-schema.test.ts`
- Verifies: Query `sqlite_master` for the trigger SQL, extract the `NOT IN` list, and compare against the exported `CANONICAL_RELATIONS` constant. The sets match. This catches drift if someone adds a canonical relation but forgets to re-run schema init. The single-source-of-truth property is enforced structurally by both `schema.ts` and `graph-queries.ts` importing from the same `memory-relations.ts` module.
- Phase: 1, Task 5 (trigger-const sync check)

---

### AC4: CLI and agent interface

**AC4.1** -- `memory connect` accepts the optional `--context` flag and persists it into the new column.
- Test type: unit
- Test file: `packages/agent/src/__tests__/graph-memory-edges.test.ts`
- Verifies: Call `memory.handler({ subcommand: "connect", source: "a", target: "b", relation: "related_to", context: "both handle recurring work" }, ctx)`. Exit code 0. Query the edge row directly and verify `context = "both handle recurring work"`.
- Phase: 2, Task 3

**AC4.2** -- `memory connect a b not-a-relation` returns a `commandError` listing the 10 canonical relations and hinting at `--context`.
- Test type: unit
- Test file: `packages/agent/src/__tests__/graph-memory-edges.test.ts`
- Verifies: Call `memory.handler({ subcommand: "connect", source: "a", target: "b", relation: "not-a-relation" }, ctx)`. Exit code 1. The error message contains at least `"related_to"` and `"synthesizes"` from the canonical list, and contains `"context"` as a hint.
- Phase: 2, Task 3

**AC4.3** -- `memory neighbors` and `memory traverse` output includes `context` in the line format when present.
- Test type: unit
- Test file: `packages/agent/src/__tests__/graph-memory-edges.test.ts`
- Verifies: Create edges with and without context, then call `memory.handler({ subcommand: "neighbors", ... })` and `memory.handler({ subcommand: "traverse", ... })`. Output includes the context string in parentheses for edges that have one, and omits the context parenthetical for edges without one.
- Phase: 2, Task 3

**AC4.4** -- Existing callers of `memory connect` that do not pass `--context` remain valid.
- Test type: unit
- Test file: `packages/agent/src/__tests__/graph-memory-edges.test.ts`
- Verifies: Call `memory.handler({ subcommand: "connect", source: "a", target: "b", relation: "related_to" }, ctx)` without passing `context`. Exit code 0 and the edge exists with `context IS NULL`.
- Phase: 2, Task 3

---

### AC5: Sync round-trip

**AC5.1** -- Peer A writes an edge with `context="foo"`; peer B materializes it with `context="foo"` intact.
- Test type: integration
- Test file: `packages/sync/src/__tests__/edge-context-sync.integration.test.ts`
- Verifies: Using `createWsTestCluster({ spokeCount: 2 })`, write a `memory_edges` row with `context = "foo"` and a canonical relation on spoke[0] via `insertRow()`. Wait for replication. Query the same row by ID on spoke[1] and verify `context = "foo"`.
- Phase: 3, Task 5

**AC5.2** -- Peer B's trigger fires on replay of a non-canonical relation from peer A.
- Test type: integration
- Test file: `packages/sync/src/__tests__/edge-context-sync.integration.test.ts`
- Verifies: Manually create a `ChangeLogEntry` with a non-canonical relation in `row_data` and call `applyLWWReducer()` against a DB with the trigger installed. The trigger rejects the INSERT and the apply path surfaces the error.
- Phase: 3, Task 5

**AC5.3** -- `FULL_SCHEMA` in the sync test harness includes the `context` column and canonical-relation triggers.
- Test type: unit
- Test file: `packages/sync/src/__tests__/edge-context-sync.integration.test.ts` (implicitly via test harness)
- Verifies: The updated `FULL_SCHEMA` in `test-harness.ts` includes `context TEXT` in the `memory_edges` CREATE TABLE and both `CREATE TRIGGER IF NOT EXISTS` statements. This is validated structurally by the AC5.1 and AC5.2 tests succeeding -- they exercise the full schema through the reducer, and would fail if the column or triggers were missing from `FULL_SCHEMA`.
- Phase: 1, Task 4 (schema update); Phase 3, Task 5 (end-to-end validation)

---

## Human Verification

### AC1.5 -- clearColumnCache bootstrap integration

**Why:** The call to `clearColumnCache()` happens in `packages/cli/src/commands/start/bootstrap.ts`, not in the schema module itself. While the unit tests validate that the column exists and the sync integration test validates that the reducer picks it up, the specific ordering guarantee (clearColumnCache runs after applySchema and before any sync operations) is an integration point that depends on the bootstrap call sequence. The automated tests cover the functional outcome (column is discovered), but the placement correctness is a code-review concern.

**Verification approach:**
1. Read `packages/cli/src/commands/start/bootstrap.ts` after Phase 3, Task 2 is complete.
2. Confirm `clearColumnCache()` is called after `createAppContext()` (which calls `applySchema()` internally via `bootstrapContainer()`) and before any sync operations begin.
3. Confirm the import comes from `@bound/sync`.

### AC2.1 -- Bootstrap ordering guarantee

**Why:** The normalization migration must run after `applySchema()` (so the `context` column and triggers exist) but the call site is in `bootstrap.ts`, not `schema.ts`. The automated tests validate the function works correctly when called in the right order, but the ordering guarantee in the bootstrap sequence is a code-review concern.

**Verification approach:**
1. Read `packages/cli/src/commands/start/bootstrap.ts` after Phase 3, Task 2 is complete.
2. Confirm `normalizeEdgeRelations(appContext.db, appContext.siteId)` is called after `createAppContext()` returns (which means `applySchema()` has already run) and after `seedSkillAuthoring`.
3. Confirm the function is wrapped in a try/catch that logs warnings on failure without crashing startup.

### AC2.5 -- Startup log output

**Why:** The `NormalizationSummary` return value is tested automatically, but the actual log line emitted at startup (via `appContext.logger.info("[edges] Normalized edge relations", normSummary)`) is a bootstrap integration point. The automated tests verify the return value is correct; the log formatting is a code-review item.

**Verification approach:**
1. After deploying, check startup logs for a line containing `[edges] Normalized edge relations`.
2. On first startup after deploy, verify the summary contains non-zero counts matching the expected number of non-canonical edges.
3. On subsequent startups, verify the summary contains all zeros (confirming idempotency in production).

### AC2.8 -- Multi-node convergence under real sync

**Why:** The automated test (Phase 3, Task 6) validates that two independent databases with identical seed data converge to the same logical state. However, it does not exercise real WebSocket sync between nodes -- it only proves the algorithm is deterministic. True multi-node convergence under LWW also depends on the sync layer correctly replicating the changelog entries, which is partially covered by AC5.1 but not with overlapping normalization runs.

**Verification approach:**
1. Deploy the new code to the hub and at least one spoke.
2. Check `memory_edges` on both nodes after both have started.
3. Verify the same set of non-deleted rows with canonical relations exists on both nodes.
4. Check for any sync errors in logs related to `memory_edges` changelog entries.

### AC3.4 -- Single source of truth (structural)

**Why:** The automated trigger-const sync check (Phase 1, Task 5) validates that the trigger SQL matches `CANONICAL_RELATIONS` at test time. The structural guarantee that `graph-queries.ts` imports from the same module is a code-review item -- there is no runtime test that `upsertEdge`'s validation set and the trigger's `NOT IN` set are the same (they are the same by construction via shared import, but this is verified by reading the code, not by a test).

**Verification approach:**
1. Confirm `packages/core/src/schema.ts` imports `CANONICAL_RELATIONS` from `./memory-relations`.
2. Confirm `packages/agent/src/graph-queries.ts` imports `isCanonicalRelation` from `@bound/core`, which re-exports from `memory-relations.ts`.
3. Confirm no other file defines a parallel list of canonical relations.
