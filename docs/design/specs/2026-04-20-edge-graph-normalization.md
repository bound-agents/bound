# RFC: Edge Graph Normalization

**Supplements:** `2026-04-10-hierarchical-memory.md` (defines `summarizes` relation and tier transitions); `2026-03-20-base.md` §5.5 (semantic_memory / memory_edges schema)
**Date:** 2026-04-20
**Status:** Implemented

---

## 1. Problem Statement

### 1.1 Relation Field Bloat

The `memory_edges` table has accumulated significant one-off relation bloat. Approximately 78% of non-deleted edges use relations that appear exactly once in the corpus (e.g., `"durable-execution-pattern"`, `"Both CRDT implementations"`, `"baseline-for-comparison"`). The relation column was originally designed to be an indexable discriminator — a closed set of semantic types supporting queries like "find all entries that extend concept X" — but it has drifted into a free-text annotation field.

This defeats the column's structural purpose. When nearly every edge has a unique relation, the relation column carries no indexing value and produces no clustering signal. The semantic type is lost in arbitrary phrasing, and queries must fuzzy-match relation strings rather than filter on a known enum.

### 1.2 Spelling Variants

Among relations that do recur, spelling variants proliferate. The dataset contains `"related_to"`, `"related-to"`, `"relates_to"`, `"relates"`, and `"related"` all with identical semantics. No enforcement exists to reject new variants. The lack of a canonical set makes relation-based queries fragile — code filtering on `relation = 'related_to'` silently excludes edges using one of the four equivalent spellings.

### 1.3 Lost Context

Bespoke phrasing carries useful information that would be lost under normalization if the only change were enforcing a canonical set. An edge with `relation = "durable-execution-pattern"` connects two entries via a specific thematic link that is richer than `"related_to"`. Coercing it to a canonical `"related_to"` discards the clarification.

### 1.4 Timing and Scope

This RFC normalizes the edge graph to a closed set of 10 canonical relations, adds a `context TEXT` column to carry bespoke phrasing that was previously smuggled through the relation field, enforces the canonical set via a database trigger and agent-layer validation, and runs a deterministic data-normalization migration on every node startup. The migration is idempotent and converges across nodes via LWW sync without manual coordination.

Summaries of affected entries and relations are not tracked. The `memory_edges` table is a synced table replicated via the standard change-log outbox pattern (see `docs/design/core-infrastructure.md`).

---

## 2. Proposal

### 2.1 Summary

The `memory_edges` schema gains a `context TEXT` column (nullable). The relation column is constrained to a closed set of 10 canonical relations defined in a single source-of-truth module, enforced via a `CREATE TRIGGER` at the database layer and a pre-flight validation check in `upsertEdge()` at the agent layer. A startup-time data-normalization migration runs on every node, mapping known spelling variants to canonicals and rewriting bespoke relations to `related_to` with the original relation preserved in `context`. When normalization produces duplicate `(source_key, target_key, relation)` triples under the unique index, the migration deterministically merges them — keeping one row, taking `max()` weight, joining distinct `context` values with `" | "`, and soft-deleting the loser. All writes use `updateRow()` to emit change-log entries, so multi-node deployments converge deterministically via LWW.

### 2.2 What This Changes

| Area | Change |
|---|---|
| `memory_edges` schema | New `context TEXT` column (nullable) |
| Canonical relations | Closed set of 10: `related_to`, `informs`, `supports`, `extends`, `complements`, `contrasts-with`, `competes-with`, `cites`, `summarizes`, `synthesizes` |
| Database enforcement | `CREATE TRIGGER` rejects INSERT/UPDATE with non-canonical relations |
| Agent-layer validation | `upsertEdge()` validates relation before hitting DB, throws `InvalidRelationError` |
| Startup migration | Automatic idempotent normalization runs on every node startup after schema init |
| CLI | `memory connect` accepts `--context <string>`, rejects non-canonical relations with usage help |
| Sync | `context` column replicates through the standard LWW reducer |

### 2.3 Behavioral Overview

**Canonical set is single-source-of-truth.** The 10 canonical relations are defined in `packages/core/src/memory-relations.ts` and exported as a const tuple. The schema module generates trigger SQL from this tuple. The agent layer imports `isCanonicalRelation()` for pre-flight validation. Graph queries import the same module. No other production code defines a parallel list. Adding a new canonical relation requires updating the single const, adjusting the trigger, and may require a schema-version bump.

**Migration runs on every startup.** The data-normalization routine is invoked during schema init, after the `ALTER TABLE` and `CREATE TRIGGER` steps so the `context` column and canonical-relation trigger are in place before any row updates. It selects all non-deleted rows whose relation is non-canonical, normalizes each via a deterministic lookup table (`SPELLING_VARIANTS`) or rewrites bespoke relations to `related_to`, and persists via `updateRow()` to emit change-log entries. The first startup post-deploy performs the real work; subsequent startups are zero-cost no-ops (the driving SELECT returns zero rows) that double as a health check.

**Collision merge is deterministic.** When normalization maps two rows to the same `(source_key, target_key, relation)` triple (e.g., `"related_to"` and `"related-to"` both normalize to `related_to`), the migration merges them: keep the surviving row's id, take `max(weight_a, weight_b)`, join distinct `context` values with `" | "`, bump `modified_at` on both, and soft-delete the loser (`deleted = 1`). The merge algorithm is deterministic on inputs, so independent runs on peer nodes produce the same logical end state (differing only in wall-clock `modified_at` timestamps). LWW convergence under sync is guaranteed.

**Runtime writes are enforced at two layers.** The database trigger rejects any INSERT or UPDATE with a non-canonical relation via `RAISE(ABORT, ...)`, listing valid relations. The agent layer's `upsertEdge()` validates the relation before any DB work and throws `InvalidRelationError` on non-canonical input. The CLI's `memory connect` command catches this error and surfaces a usage hint mentioning `--context`. Direct SQL writes (e.g., from a manual operator intervention or a future extension) hit the trigger; agent-originated writes hit the pre-flight check.

**Context is optional and free-text.** The new `context` column is nullable, not indexed, and carries no validation. It is intended for human-readable annotation of why two entries are related, filling the niche that bespoke relations were mis-filling. Graph retrieval does not filter on `context`; it is display-only. The `memory neighbors` and `memory traverse` commands include `context` in per-edge output when present.

### 2.4 Design Notes

**Why a trigger rather than a CHECK constraint.** SQLite's `ALTER TABLE` cannot add a `CHECK` constraint to an existing table without the full create-new-table / copy / drop / rename dance. `CREATE TRIGGER IF NOT EXISTS` is idempotent and works for both fresh installs and existing DBs. The cost is slightly less ergonomic error messages, addressed by an explicit `RAISE(ABORT, '<message>')` string that names the rejected value and lists valid options.

**Weight merge policy.** Collision merge takes `max(weight_a, weight_b)`. An alternative is `sum()` (treating duplicate edges as accumulated votes). `max()` is conservative — it does not inflate weights of previously-distinct-looking edges. This can be revisited if downstream consumers of edge weight start producing weaker signals post-migration.

**Column cache invalidation.** The LWW reducer in `packages/sync/src/reducers.ts` uses `PRAGMA table_info` to discover columns, with a module-level cache. Adding `context` is transparent to the reducer as long as `clearColumnCache()` runs after the ALTER. The startup sequence in `bootstrap.ts` invokes `clearColumnCache()` immediately after `createAppContext()` returns (which runs `applySchema()` internally), ensuring long-running agent processes pick up the new column without restart.

**Context is not indexed.** Storing bespoke phrasing in `context` preserves information without paying the indexing cost that the relation column was incorrectly being charged with. It is free text, searched only when explicitly requested via future `memory search` extensions (out of scope for this RFC).

**Startup cost.** The migration's driving SELECT filters by `relation NOT IN (<canonical set>) AND deleted = 0`. On nodes that have already migrated, this returns zero rows and adds microseconds to startup. On a node with ~150 non-canonical rows (current production scale at the time of this RFC), the loop does ~150 `updateRow()` calls — sub-second. Acceptable for startup; only requires revisiting if edge counts grow an order of magnitude.

**Schema version tracking.** Bound does not currently track schema version explicitly; migrations are ALTER-and-catch-duplicate plus idempotent-data-pass. Additive changes like this one are safe under that model. Destructive changes (dropping/renaming columns, tightening constraints beyond what existing data satisfies) would require real version tracking. Out of scope here but worth flagging for future destructive work.

**Future: promoting bespoke relations.** If the post-migration `context` column reveals that a particular phrasing appears frequently (e.g., `"durable-execution-pattern"` recurs enough to justify a canonical), that is evidence for adding a new canonical relation in a follow-on change. Not automated in this RFC — requires deliberate review of `context` distributions after migration settles.

---

## 3. Requirements (EARS Format)

Requirements use the prefix `R-EGN` (Edge Graph Normalization).

### 3.1 Ubiquitous

**R-EGN1.** The `memory_edges` table shall have a `context TEXT` column (nullable). The column shall be added via `ALTER TABLE memory_edges ADD COLUMN context TEXT` wrapped in the existing duplicate-column try/catch pattern (per `packages/core/src/schema.ts` conventions). The column shall replicate through the standard LWW reducer as part of the sync layer.

**R-EGN2.** The system shall define the canonical relation set in exactly one place: a const tuple `CANONICAL_RELATIONS` exported from `packages/core/src/memory-relations.ts`. The tuple shall contain 10 values: `"related_to"`, `"informs"`, `"supports"`, `"extends"`, `"complements"`, `"contrasts-with"`, `"competes-with"`, `"cites"`, `"summarizes"`, `"synthesizes"`. The schema module shall import this tuple to generate trigger SQL. The agent layer shall import `isCanonicalRelation(rel: string): rel is CanonicalRelation` for pre-flight validation.

**R-EGN3.** The schema shall install two database triggers via `CREATE TRIGGER IF NOT EXISTS` (idempotent across restarts):

- `memory_edges_canonical_relation_insert` BEFORE INSERT FOR EACH ROW WHEN `NEW.relation NOT IN (<canonical set>)` SHALL `SELECT RAISE(ABORT, '<message listing valid relations>')`.
- `memory_edges_canonical_relation_update` BEFORE UPDATE OF relation FOR EACH ROW WHEN `NEW.relation NOT IN (<canonical set>)` SHALL `SELECT RAISE(ABORT, '<message listing valid relations>')`.

The trigger body's `WHEN` clause shall be generated at schema-init time from `CANONICAL_RELATIONS` via template literal. The error message shall list all valid relations and hint at using `--context` for bespoke phrasing.

**R-EGN4.** The `upsertEdge()` function in `packages/agent/src/graph-queries.ts` shall accept an optional `context` parameter. Before any database work, it shall validate the relation via `isCanonicalRelation(relation)`. When the relation is non-canonical, it shall throw `InvalidRelationError` (exported from `packages/core/src/memory-relations.ts`). The error's `.message` field shall list the 10 canonical relations and hint at using `--context`. No row shall be written and no change-log entry shall be emitted when validation fails.

**R-EGN5.** The `memory connect` command shall accept an optional `--context <string>` flag. When provided, the context value shall be passed to `upsertEdge()` and persisted into the `context` column. When the command is invoked with a non-canonical relation, the existing error-mapping path in the memory command dispatcher (around `packages/agent/src/commands/memory.ts`) shall surface `InvalidRelationError.message` via `commandError()`.

**R-EGN6.** The `memory neighbors` and `memory traverse` commands shall include `context` in per-edge output when the value is non-null. The format shall be `<target> [<relation>, w=<weight> (<context>)]` when context is present, and `<target> [<relation>, w=<weight>]` when absent.

**R-EGN7.** The system shall invoke `normalizeEdgeRelations(db)` during schema init in `packages/core/src/schema.ts`, after the `ALTER TABLE` and `CREATE TRIGGER` steps so the `context` column and canonical-relation trigger are in place before the routine writes. The function shall be exported from `packages/core/src/migrations/normalize-edge-relations.ts` and shall return a summary object `{ variants_mapped: number, moved_to_context: number, collisions_merged: number, total_scanned: number }`. The schema-init call site shall log the summary at startup: `"[edges] Normalized edge relations"` with the summary object. When all counts are zero, the log line serves as a health signal that the corpus is already canonical.

**R-EGN8.** The normalization routine shall select all non-deleted rows where `relation NOT IN (<canonical set>) AND deleted = 0`. For each row:

- If the relation is in `SPELLING_VARIANTS` (a deterministic lowercased-key → canonical-value lookup table exported from `packages/core/src/memory-relations.ts`): the routine shall attempt to update the row's relation to the canonical. If that produces a `(source_key, target_key, relation)` triple that collides with an existing row under the unique index `idx_memory_edges_unique`, the routine shall follow the collision-merge path (R-EGN9).
- Otherwise (bespoke relation): the routine shall rewrite `relation = 'related_to'` and set `context` to the original relation string. If the row already has a non-null `context`, the routine shall join the two values with `" | "` (pipe surrounded by spaces). If the rewrite collides, the routine shall follow the collision-merge path (R-EGN9).

All writes shall use `updateRow(db, "memory_edges", id, { relation, context }, siteId)` from `packages/core/src/change-log.ts` to emit change-log entries for replication.

**R-EGN9.** When normalization produces a `(source_key, target_key, relation)` triple that collides with an existing row under the unique index, the routine shall merge the two rows deterministically:

- Keep the pre-existing row's `id` (the survivor).
- Set the survivor's `weight` to `max(weight_survivor, weight_incoming)`.
- If both rows have non-null `context` values that differ, join distinct values with `" | "`. If one is null, take the non-null value. If both are null, `context` remains null.
- Bump the survivor's `modified_at` via `updateRow()`.
- Soft-delete the incoming row (`deleted = 1`) and bump its `modified_at` via `updateRow()`.

The merge algorithm shall be deterministic on inputs: two nodes running the migration independently against the same starting data shall produce the same logical end state (differing only in wall-clock `modified_at` timestamps). LWW convergence under sync is guaranteed by the determinism.

**R-EGN10.** The column-cache clearing function `clearColumnCache()` from `packages/sync/src/reducers.ts` shall be invoked during bootstrap in `packages/cli/src/commands/start/bootstrap.ts` immediately after `createAppContext()` returns (which runs `applySchema()` internally). This ensures long-running agent processes pick up the new `context` column without restart.

### 3.2 State-driven

**R-EGN11.** When the normalization routine runs on a node whose non-deleted rows already have canonical relations (e.g., a second startup after the first migration completed), the driving SELECT shall return zero rows, the routine shall perform zero writes, and the summary counts shall all be zero. The log line serves as a no-op health check.

**R-EGN12.** When two nodes in a multi-node cluster independently run the normalization during startup (e.g., a rolling deploy where both nodes restart within the same hour), and both nodes observe overlapping non-canonical data before normalization, both nodes shall converge to the same logical state under LWW regardless of which node starts first. Redundant updates shall be absorbed (LWW on identical target values is a no-op).

### 3.3 Acceptance Criteria

Acceptance criteria use the prefix `edge-graph-normalization.AC` and map 1:1 to test names in the implementation test plan. Each R-EGN* with observable behavior has at least one success scenario. R-EGN2 (single-source-of-truth structural), R-EGN7 (bootstrap ordering), and R-EGN10 (column-cache integration) are validated by code review and manual verification in addition to automated tests.

#### edge-graph-normalization.AC1: Schema and trigger in place (R-EGN1, R-EGN3)

- **AC1.1 Success.** Fresh DB init creates `memory_edges` with the `context TEXT` column and both canonical-relation triggers.
- **AC1.2 Success.** Existing DB with data gains the `context` column via `ALTER TABLE` wrapped in the duplicate-column try/catch pattern.
- **AC1.3 Success.** The triggers are created via `CREATE TRIGGER IF NOT EXISTS` for BEFORE INSERT and BEFORE UPDATE OF relation, idempotent across restarts.
- **AC1.4 Success.** Running schema init twice is a no-op (no errors, no data change, trigger count unchanged).
- **AC1.5 Success.** The reducer column cache is cleared after the ALTER runs so long-running agent processes pick up the new column without restart.

#### edge-graph-normalization.AC2: Data normalization runs on startup (R-EGN7, R-EGN8, R-EGN9)

- **AC2.1 Success.** The normalization routine runs automatically during schema init on every startup, after the `ALTER TABLE` and `CREATE TRIGGER` steps so the `context` column and canonical-relation trigger are in place before any row updates.
- **AC2.2 Success.** Known spelling variants (e.g., `related-to`, `relates_to`, `relates`, `related`) are mapped to their canonical equivalent via the deterministic `SPELLING_VARIANTS` lookup table.
- **AC2.3 Success.** Rows with bespoke relations (not canonical, not in the spelling-variant table) have `relation` rewritten to `related_to` and the original relation preserved in `context`.
- **AC2.4 Success.** Normalization emits row-level change-log entries through the standard `updateRow()` path so peers replay the same transitions deterministically.
- **AC2.5 Success.** Startup logs summary counts for `{variants_mapped, moved_to_context, collisions_merged, total_scanned}` (zeros logged when the table is already canonical, so the log line doubles as a health signal on subsequent restarts).
- **AC2.6 Edge.** When normalization produces a `(source_key, target_key, relation)` triple that collides with an existing row under the unique index, the two rows are merged: keep the surviving row's id, take `max()` of the two weights, join distinct `context` values with `" | "`, soft-delete the loser (`deleted = 1`), bump `modified_at` on both.
- **AC2.7 Success.** Running startup a second time is a no-op for data — all non-deleted rows already have canonical relations, the SELECT that drives the loop returns zero rows, summary counts are all zero.
- **AC2.8 Success.** Each node in a multi-node cluster runs the normalization independently during its own startup and converges to the same canonical state; collision-merge results are deterministic across nodes given identical input data, so change-log entries from independent runs resolve under LWW without manual coordination.

#### edge-graph-normalization.AC3: Runtime enforcement (R-EGN3, R-EGN4)

- **AC3.1 Failure.** `upsertEdge()` called with a non-canonical relation throws `InvalidRelationError`; no row is written; no change-log entry is emitted.
- **AC3.2 Failure.** Direct SQL `INSERT INTO memory_edges` with a non-canonical relation fails with the trigger's `RAISE(ABORT, ...)` message listing valid relations.
- **AC3.3 Failure.** Direct SQL `UPDATE memory_edges SET relation = '<bespoke>'` fails with the same trigger error.
- **AC3.4 Success.** The canonical relation set is defined in exactly one place (`packages/core/src/memory-relations.ts`) and imported by both the schema module (to generate trigger SQL) and `graph-queries.ts` (for pre-flight validation).

#### edge-graph-normalization.AC4: CLI and agent interface (R-EGN5, R-EGN6)

- **AC4.1 Success.** `memory connect <source> <target> <relation> [--weight N] [--context "phrase"]` accepts the optional `context` flag and persists it into the new column.
- **AC4.2 Failure.** `memory connect a b not-a-relation` returns a `commandError` whose message lists the 10 canonical relations and hints at using `--context` for bespoke phrasing.
- **AC4.3 Success.** `memory neighbors` and `memory traverse` output includes `context` in the line format when present.
- **AC4.4 Success.** Existing callers of `memory connect` that do not pass `--context` remain valid (context is optional at both the CLI and function-signature levels).

#### edge-graph-normalization.AC5: Sync round-trip (R-EGN1, R-EGN3)

- **AC5.1 Success.** Peer A writes an edge with `context="foo"`; peer B receives the change-log entry and materializes the edge with `context="foo"` intact.
- **AC5.2 Success.** Peer B's trigger fires on replay — if peer A somehow emits a non-canonical relation, peer B's apply path surfaces the trigger error (audit path, not expected under normal deployment).
- **AC5.3 Success.** `memory_edges` in `FULL_SCHEMA` in `packages/sync/src/__tests__/test-harness.ts` includes the `context` column and the canonical-relation trigger so reducer tests exercise the full schema.

---

## 4. Implementation Notes

### 4.1 Existing Patterns

This design follows several established patterns in the Bound codebase:

- **Additive ALTER with duplicate-column try/catch** — The existing migration block in `packages/core/src/schema.ts` wraps each `ALTER TABLE ADD COLUMN` in a try/catch that swallows the "duplicate column" error, making schema init idempotent. The `context` column follows the same pattern.
- **`CREATE TRIGGER IF NOT EXISTS`** — Already used in `schema.ts` for other invariants. Idempotent across restarts.
- **Change-log outbox writes** — All mutations to synced tables go through `insertRow()` / `updateRow()` from `packages/core/src/change-log.ts`, which wrap the SQL with a change-log entry in the same transaction. The startup migration uses this path exclusively; no raw SQL writes to `memory_edges`.
- **Idempotent startup migration** — The existing schema-init block is itself an idempotent migration pass (repeated ALTERs swallowed as duplicates, `CREATE TRIGGER IF NOT EXISTS` for triggers). The data normalization pass follows the same pattern at the data layer: idempotent by being a no-op when all rows are already canonical, so it runs safely on every startup.
- **LWW reducer auto-discovers columns** — The reducer in `packages/sync/src/reducers.ts` uses `PRAGMA table_info` to drive the column list with a module-level cache. Adding `context` is transparent to the reducer as long as `clearColumnCache()` runs after the ALTER.
- **Canonical-const exported from `@bound/core`** — Follows the pattern of other cross-cutting invariants (e.g., `TABLE_PK_COLUMN` in `change-log.ts`) where a single const declared in `core` is imported by both schema-shaping code and call-site validation.
- **Error surfacing in command handlers** — The catch block in the memory command dispatcher in `packages/agent/src/commands/memory.ts` already maps thrown errors to `commandError(err.message)`. `InvalidRelationError` flows through this path without a new branch.
- **Test harness schema** — The `FULL_SCHEMA` string in `packages/sync/src/__tests__/test-harness.ts` is the canonical schema-under-test; adding the new column and triggers there is required for reducer tests to exercise the updated table shape.

No divergences — this design is entirely additive and reuses existing infrastructure.

### 4.2 Sequencing

The implementation proceeds in three phases, each with a clear done-when condition. Phases are not independently deployable; the full change lands as one batch.

1. **Phase 1: Canonical-relation module and schema changes.** Establish the single source of truth for canonical relations, add the `context` column, and install the DB-layer trigger. Fresh and existing DBs reach the same post-state. Done when: Fresh DB init produces a `memory_edges` table with the new column and both triggers; existing DB init is idempotent; direct SQL `INSERT` with a non-canonical relation is rejected by the trigger.

2. **Phase 2: Agent-layer validation and CLI context flag.** Every agent-originated write path validates the relation before the DB call, and the CLI exposes `--context` as a first-class flag. Done when: Unit test verifies `upsertEdge()` with a non-canonical relation throws and emits no change-log entry; CLI test verifies `memory connect a b not-a-relation` returns an error listing canonicals and the `--context` hint, and `memory connect a b related_to --context "foo"` succeeds with the edge carrying `context="foo"`.

3. **Phase 3: Startup data-normalization migration.** Every node, on every startup, converges its `memory_edges` rows to the canonical state. First boot after deploy performs the real work; subsequent boots are zero-cost no-ops that double as a health check. Done when: Migration test seeds a DB with mixed canonical, spelling-variant, and bespoke relations; runs schema init; asserts canonicals untouched, variants mapped correctly, bespoke rewritten with `context` populated, collisions merged with max-weight and joined context, and a second schema-init call is a data-level no-op. Sync round-trip test passes. Multi-node convergence test passes.

### 4.3 Multi-node Convergence

Each node runs the normalization pass during its own startup after deployment. Three scenarios, all safe:

1. **All nodes deploy roughly simultaneously.** Each runs migration locally, emits change-log entries, receives peer entries. Because the algorithm is deterministic and writes are LWW, the cluster converges to a single canonical state. Redundant updates are absorbed (LWW on identical target values is a no-op).

2. **Rolling deploy, new node first.** New node migrates its local view. Old nodes receive the change-log entries; their reducer applies them (old-node SQLite has no `context` column yet, so the reducer drops that field per its dynamic column-discovery behavior). When an old node is upgraded, its startup migration finds most rows already canonical (from replicated updates) and processes only any rows it wrote locally since.

3. **New-node trigger vs. old-node write.** An old node writing a bespoke relation produces a change-log entry that the new node's apply path rejects via the trigger, stalling sync for that row. This is the same failure mode called out in AC5.2 and is independent of the migration-on-startup change. Mitigation: the agent-layer validation in `upsertEdge()` (Phase 2) prevents new bespoke writes once the new agent is deployed, so this window is bounded by "how long old agents continue writing."

### 4.4 Test Plan

The automated test suite covers the acceptance criteria across unit and integration tests; each acceptance criterion maps to one or more test cases. Two areas additionally warrant human verification: bootstrap-integration concerns (the normalization migration's call ordering during startup) and real multi-node sync behavior (overlapping normalization runs converging under WebSocket replication).

- **R-EGN1 unit**: `memory-edges-schema.test.ts` — "Fresh DB has context column and triggers", "ALTER TABLE adds context column", "Triggers are created idempotently", "applySchema is idempotent".
- **R-EGN3 unit**: `memory-edges-schema.test.ts` — "direct INSERT with non-canonical relation raises trigger error", "UPDATE SET relation to non-canonical value raises trigger error", "trigger SQL reflects CANONICAL_RELATIONS exactly".
- **R-EGN4 unit**: `graph-memory-edges.test.ts` — "should throw InvalidRelationError" + no row + no changelog.
- **R-EGN5, R-EGN6 unit**: `graph-memory-edges.test.ts` — "should accept and persist context via --context flag", "error message should list valid relations" + "hint at --context", "should include context in traverse/neighbors output", "should allow memory connect without --context flag".
- **R-EGN7, R-EGN8, R-EGN9 unit**: `normalize-edge-relations.test.ts` — "spelling variant mapping", "maps related_to variants" + "maps other canonical variants", "rewrites bespoke relations" + "joins new context with existing", "emits changelog entries", "returns correct counts", "merges variant collision" + "merges bespoke collision" + "deduplicates context", "second run returns all zeros", "two independent normalizations converge".
- **R-EGN1, R-EGN3, R-EGN10 integration**: `edge-context-sync.integration.test.ts` — "Context column replicates correctly", "Trigger fires on replay of non-canonical relation", "FULL_SCHEMA includes context column and triggers", clearColumnCache in beforeEach.

---

## 5. Open Questions

No open questions at RFC-close. The 10-relation canonical set was chosen based on observed usage patterns in the production corpus at the time of design. If post-migration `context` distributions reveal frequently-recurring bespoke relations, promoting them to canonicals is a follow-on change that updates the const, adjusts the trigger, and may require a schema-version bump.

---

## 6. Migration

No operator-initiated data migration is required. The normalization routine runs automatically on every node startup after the `ALTER TABLE` and `CREATE TRIGGER` steps, so deployment is a simple binary replacement.

Existing `memory_edges` rows with canonical relations are untouched. Rows with spelling variants are normalized deterministically to canonicals. Rows with bespoke relations have `relation` rewritten to `related_to` and the original relation preserved in `context`. When normalization produces collisions under the unique index, the rows are merged deterministically (keep one id, `max(weight)`, join distinct contexts, soft-delete the loser).

Multi-node clusters converge automatically via LWW sync. No coordinated cluster upgrade is required. Nodes may be rolled one at a time; partial deployment leaves post-fix nodes correctly behaved while pre-fix nodes retain the original behavior. The normalization window is bounded by the time it takes for the last old-agent write to propagate through sync and be normalized by a new node.

---

## 7. Glossary

- **Canonical relation** — One of the 10 values in the exported `CANONICAL_RELATIONS` tuple: `related_to`, `informs`, `supports`, `extends`, `complements`, `contrasts-with`, `competes-with`, `cites`, `summarizes`, `synthesizes`. The set is frozen by this RFC; adding more requires a deliberate follow-on change that updates the const, adjusts the trigger, and may require a schema-version bump.
- **Spelling variant** — A non-canonical relation string semantically equivalent to a canonical one, appearing frequently enough in existing data to justify an automatic mapping (e.g., `related-to` → `related_to`). Defined in the `SPELLING_VARIANTS` deterministic lowercased-key → canonical-value lookup table.
- **Bespoke relation** — A non-canonical relation string that carries information not captured by any canonical value (e.g., `"durable-execution-pattern"`). Preserved verbatim in the new `context` column after migration, with the row's `relation` rewritten to `related_to`.
- **Context (column)** — Free-text field attached to an edge. Not indexed, not validated. Intended for human-readable annotation of why two entries are related; fills the niche that bespoke relations were mis-filling.
- **Collision merge** — When normalization would produce a duplicate under the unique index `(source_key, target_key, relation) WHERE deleted = 0`, the migration collapses the two rows into one: keep one id, `max(weight)`, join distinct contexts, soft-delete the loser.
- **Change-log outbox pattern** — Bound's write path where mutations to synced tables go through `insertRow()` / `updateRow()` helpers in `packages/core/src/change-log.ts`, wrapping the DB write with a change-log entry in a single transaction for replication.
- **LWW reducer** — The sync-side reducer in `packages/sync/src/reducers.ts` that applies change-log entries by last-writer-wins on `modified_at`. Columns are discovered dynamically via `PRAGMA table_info` and cached, so additive schema changes are transparent once the cache is cleared.
- **Idempotent startup migration** — A data-normalization pass that runs on every node startup and is a no-op when the data is already in the target state. The driving SELECT returns zero rows after the first migration completes, so subsequent startups add zero cost and serve as a health check.
