# Edge Graph Normalization Design

## Summary

The `memory_edges` table has accumulated significant one-off relation bloat: ~78% of non-deleted edges use relations that appear exactly once (e.g. `"durable-execution-pattern"`, `"Both CRDT implementations"`). The relation column was meant to be an indexable discriminator but has drifted into a free-text annotation field.

This design normalizes the edge graph to a closed set of 10 canonical relations (`related_to`, `informs`, `supports`, `extends`, `complements`, `contrasts-with`, `competes-with`, `cites`, `summarizes`, `synthesizes`), adds a `context TEXT` column to `memory_edges` to carry the bespoke phrasing that was previously being smuggled through the relation field, enforces the canonical set via a database trigger (defense-in-depth) plus an agent-layer validation check, and runs a data normalization pass during schema init on every node startup — mapping known spelling variants to canonicals and moving bespoke phrasing into the new `context` column, with deterministic collision-merge behavior when normalization produces duplicates under the existing unique index.

## Definition of Done

1. `memory_edges` has a `context TEXT` column (nullable) replicated through the sync layer.
2. A `CREATE TRIGGER` on `memory_edges` rejects any INSERT or UPDATE whose `relation` is outside the canonical set, with a clear error message.
3. `upsertEdge()` in `packages/agent/src/graph-queries.ts` validates `relation` before hitting the DB and throws a typed error on invalid input.
4. The CLI `memory connect` command accepts `--context <string>`, rejects non-canonical relations with usage help, and persists `context` when provided.
5. The normalization migration runs automatically during schema init on every node startup: existing bespoke and spelling-variant relations converge to canonicals on each deployed node with no manual coordination.
6. Tests cover: trigger rejection, validation error from `upsertEdge`, CLI error path, migration idempotency, migration collision handling, and sync round-trip of the `context` column.

## Acceptance Criteria

### edge-graph-normalization.AC1: Schema and trigger in place

- **edge-graph-normalization.AC1.1 Success:** Fresh DB init creates `memory_edges` with the `context TEXT` column and canonical-relation trigger.
- **edge-graph-normalization.AC1.2 Success:** Existing DB with data gains the `context` column via `ALTER TABLE` wrapped in the duplicate-column try/catch pattern used by other migrations in `schema.ts`.
- **edge-graph-normalization.AC1.3 Success:** The trigger is created via `CREATE TRIGGER IF NOT EXISTS` for BEFORE INSERT and BEFORE UPDATE OF relation, idempotent across restarts.
- **edge-graph-normalization.AC1.4 Success:** Running schema init twice is a no-op (no errors, no data change, trigger count unchanged).
- **edge-graph-normalization.AC1.5 Success:** The reducer column cache is cleared after the ALTER runs so long-running agent processes pick up the new column without restart.

### edge-graph-normalization.AC2: Data normalization runs on startup

- **edge-graph-normalization.AC2.1 Success:** The normalization routine runs automatically during schema init on every startup, after the `ALTER TABLE` and `CREATE TRIGGER` steps so that the `context` column and canonical-relation trigger are in place before any row updates.
- **edge-graph-normalization.AC2.2 Success:** Known spelling variants (e.g. `related-to`, `relates_to`, `relates`, `related`) are mapped to their canonical equivalent via a deterministic lookup table.
- **edge-graph-normalization.AC2.3 Success:** Rows with bespoke relations (not canonical, not in the spelling-variant table) have `relation` rewritten to `related_to` and the original relation preserved in `context`.
- **edge-graph-normalization.AC2.4 Success:** Normalization emits row-level change-log entries through the standard `updateRow()` path so peers replay the same transitions deterministically.
- **edge-graph-normalization.AC2.5 Success:** Startup logs summary counts for `{variants_mapped, moved_to_context, collisions_merged, total_scanned}` (zeros logged when the table is already canonical, so the log line doubles as a health signal on subsequent restarts).
- **edge-graph-normalization.AC2.6 Edge:** When normalization produces a `(source_key, target_key, relation)` triple that collides with an existing row under the unique index, the two rows are merged: keep the surviving row's id, take `max()` of the two weights, join distinct `context` values with `" | "`, soft-delete the loser (`deleted = 1`), bump `modified_at` on both.
- **edge-graph-normalization.AC2.7 Success:** Running startup a second time is a no-op for data — all non-deleted rows already have canonical relations, the SELECT that drives the loop returns zero rows, summary counts are all zero.
- **edge-graph-normalization.AC2.8 Success:** Each node in a multi-node cluster runs the normalization independently during its own startup and converges to the same canonical state; collision-merge results are deterministic across nodes given identical input data, so change-log entries from independent runs resolve under LWW without manual coordination.

### edge-graph-normalization.AC3: Runtime enforcement

- **edge-graph-normalization.AC3.1 Failure:** `upsertEdge()` called with a non-canonical relation throws `InvalidRelationError`; no row is written; no change-log entry is emitted.
- **edge-graph-normalization.AC3.2 Failure:** Direct SQL `INSERT INTO memory_edges` with a non-canonical relation fails with the trigger's `RAISE(ABORT, ...)` message listing valid relations.
- **edge-graph-normalization.AC3.3 Failure:** Direct SQL `UPDATE memory_edges SET relation = '<bespoke>'` fails with the same trigger error.
- **edge-graph-normalization.AC3.4 Success:** The canonical relation set is defined in exactly one place (`packages/core/src/memory-relations.ts`) and imported by both the schema module (to generate trigger SQL) and `graph-queries.ts` (for pre-flight validation).

### edge-graph-normalization.AC4: CLI and agent interface

- **edge-graph-normalization.AC4.1 Success:** `memory connect <source> <target> <relation> [--weight N] [--context "phrase"]` accepts the optional `context` flag and persists it into the new column.
- **edge-graph-normalization.AC4.2 Failure:** `memory connect a b not-a-relation` returns a `commandError` whose message lists the 10 canonical relations and hints at using `--context` for bespoke phrasing.
- **edge-graph-normalization.AC4.3 Success:** `memory neighbors` and `memory traverse` output includes `context` in the line format when present.
- **edge-graph-normalization.AC4.4 Success:** Existing callers of `memory connect` that do not pass `--context` remain valid (context is optional at both the CLI and function-signature levels).

### edge-graph-normalization.AC5: Sync round-trip

- **edge-graph-normalization.AC5.1 Success:** Peer A writes an edge with `context="foo"`; peer B receives the change-log entry and materializes the edge with `context="foo"` intact.
- **edge-graph-normalization.AC5.2 Success:** Peer B's trigger fires on replay — if peer A somehow emits a non-canonical relation, peer B's apply path surfaces the trigger error (audit path, not expected under normal deployment).
- **edge-graph-normalization.AC5.3 Success:** `memory_edges` in `FULL_SCHEMA` in `packages/sync/src/__tests__/test-harness.ts` includes the `context` column and the canonical-relation trigger so reducer tests exercise the full schema.

## Glossary

- **Canonical relation:** One of the 10 values in the exported `CANONICAL_RELATIONS` tuple. The set is frozen by this plan; adding more requires a deliberate follow-on change that updates the const, adjusts the trigger, and may require a schema-version bump.
- **Spelling variant:** A non-canonical relation string semantically equivalent to a canonical one, appearing frequently enough in existing data to justify an automatic mapping (e.g. `related-to` → `related_to`).
- **Bespoke relation:** A non-canonical relation string that carries information not captured by any canonical value (e.g. `"durable-execution-pattern"`). Preserved verbatim in the new `context` column after migration, with the row's `relation` rewritten to `related_to`.
- **Context (column):** Free-text field attached to an edge. Not indexed, not validated. Intended for human-readable annotation of *why* two entries are related; fills the niche that bespoke relations were mis-filling.
- **Collision merge:** When normalization would produce a duplicate under the unique index `(source_key, target_key, relation) WHERE deleted = 0`, the migration collapses the two rows into one rather than erroring.
- **Change-log outbox pattern:** Bound's write path where mutations to synced tables go through `insertRow()` / `updateRow()` helpers in `packages/core/src/change-log.ts`, wrapping the DB write with a change-log entry in a single transaction for replication.
- **LWW reducer:** The sync-side reducer (`packages/sync/src/reducers.ts`) that applies change-log entries by last-writer-wins on `modified_at`. Columns are discovered dynamically via `PRAGMA table_info` and cached, so additive schema changes are transparent once the cache is cleared.

## Architecture

### Contracts

**New module — `packages/core/src/memory-relations.ts`:**

```typescript
export const CANONICAL_RELATIONS = [
  "related_to", "informs", "supports", "extends", "complements",
  "contrasts-with", "competes-with", "cites", "summarizes", "synthesizes",
] as const;

export type CanonicalRelation = (typeof CANONICAL_RELATIONS)[number];

export function isCanonicalRelation(rel: string): rel is CanonicalRelation;

export class InvalidRelationError extends Error {
  readonly rel: string;
  // message lists valid relations and hints at --context for bespoke phrasing
}

// Deterministic lowercased-key → canonical-value lookup for variants observed in production data.
export const SPELLING_VARIANTS: Record<string, CanonicalRelation>;
```

**`memory_edges` schema additions:**

```sql
ALTER TABLE memory_edges ADD COLUMN context TEXT;

CREATE TRIGGER IF NOT EXISTS memory_edges_canonical_relation_insert
BEFORE INSERT ON memory_edges
FOR EACH ROW WHEN NEW.relation NOT IN (/* canonical set */)
BEGIN SELECT RAISE(ABORT, '<message>'); END;

CREATE TRIGGER IF NOT EXISTS memory_edges_canonical_relation_update
BEFORE UPDATE OF relation ON memory_edges
FOR EACH ROW WHEN NEW.relation NOT IN (/* canonical set */)
BEGIN SELECT RAISE(ABORT, '<message>'); END;
```

The trigger body is generated at schema-init time from `CANONICAL_RELATIONS` via template literal — single source of truth, no drift.

**`upsertEdge` signature change (`packages/agent/src/graph-queries.ts`):**

```typescript
export function upsertEdge(
  db: Database,
  sourceKey: string,
  targetKey: string,
  relation: string,
  weight: number,
  context?: string,  // new optional parameter
): void;  // throws InvalidRelationError on non-canonical `relation`
```

**CLI `memory connect` signature:**

```
memory connect <source> <target> <relation> [--weight N] [--context "phrase"]
```

### Why a trigger rather than a CHECK constraint

SQLite's `ALTER TABLE` cannot add a `CHECK` constraint to an existing table without the full create-new-table / copy / drop / rename dance. `CREATE TRIGGER IF NOT EXISTS` is idempotent and works for both fresh installs and existing DBs. The cost is slightly less ergonomic error messages, addressed by an explicit `RAISE(ABORT, ...)` string that names the rejected value and lists valid options.

### Migration behavior

The data normalization runs automatically during schema init on every node startup, in the same place that `ALTER TABLE` and `CREATE TRIGGER` currently live. It is idempotent by construction: once all non-deleted rows have canonical relations, the driving `SELECT` returns zero rows and the pass becomes a no-op, logging zeros for all summary counts. This makes every startup after the first a cheap health check rather than a repeat migration.

Per non-deleted row whose relation is non-canonical:

1. If the relation is in `SPELLING_VARIANTS`: attempt to update the row's relation to the canonical. If that would collide with an existing row under the unique index, follow the collision-merge path.
2. Otherwise (bespoke): rewrite `relation = 'related_to'` and set `context` to the original relation string (joined with any existing `context` via `" | "`). Apply the same collision-merge path if needed.
3. Collision-merge path: keep the pre-existing row, update its weight to `max()` of the two, extend its `context` with distinct joined values, bump `modified_at`; soft-delete the losing row (`deleted = 1`, bump `modified_at`).

All writes go through `updateRow()` from `change-log.ts` so peers replay the transitions deterministically. The algorithm is deterministic on inputs: two nodes running the migration independently against the same starting data produce the same logical end state, differing only in `modified_at` wall-clock timestamps. LWW convergence under sync is therefore guaranteed regardless of which node runs startup first.

### Multi-node convergence

Each node runs the normalization pass during its own startup after deployment. Three scenarios, all safe:

1. **All nodes deploy roughly simultaneously:** Each runs migration locally, emits change-log entries, receives peer entries. Because the algorithm is deterministic and writes are LWW, the cluster converges to a single canonical state. Redundant updates are absorbed (LWW on identical target values is a no-op).
2. **Rolling deploy, new node first:** New node migrates its local view. Old nodes receive the change-log entries; their reducer applies them (old-node SQLite has no `context` column yet, so the reducer drops that field per its dynamic column-discovery behavior — see Existing Patterns below). When an old node is upgraded, its startup migration finds most rows already canonical (from replicated updates) and processes only any rows it wrote locally since.
3. **New-node trigger vs. old-node write:** An old node writing a bespoke relation produces a change-log entry that the new node's apply path rejects via the trigger, stalling sync for that row. This is the same failure mode called out in AC5.2 and is independent of the migration-on-startup change. Mitigation: the agent-layer validation in `upsertEdge` (Phase 2) prevents new bespoke writes once the new agent is deployed, so this window is bounded by "how long old agents continue writing."

## Existing Patterns

This design follows several established patterns in the bound codebase:

- **Additive ALTER with duplicate-column try/catch** (`packages/core/src/schema.ts`) — the existing migration block around the `memory_edges` / `semantic_memory` / `thread_messages` additions wraps each `ALTER TABLE ADD COLUMN` in a try/catch that swallows the "duplicate column" error, making schema init idempotent. The `context` column follows the same pattern.
- **`CREATE TRIGGER IF NOT EXISTS`** — already used in `schema.ts` for other invariants. Idempotent across restarts.
- **Change-log outbox writes** (`packages/core/src/change-log.ts`) — all mutations to synced tables go through `insertRow()` / `updateRow()`, which wrap the SQL with a change-log entry in the same transaction. The startup migration uses this path exclusively; no raw SQL writes to `memory_edges`.
- **Idempotent startup migration** — the existing schema-init block is itself an idempotent migration pass (repeated ALTERs swallowed as duplicates, `CREATE TRIGGER IF NOT EXISTS` for triggers). The data normalization pass follows the same pattern at the data layer: idempotent by being a no-op when all rows are already canonical, so it runs safely on every startup.
- **LWW reducer auto-discovers columns** (`packages/sync/src/reducers.ts`) — `PRAGMA table_info` drives the column list with a module-level cache. Adding `context` is transparent to the reducer as long as `clearColumnCache()` runs after the ALTER.
- **Canonical-const exported from `@bound/core`** — follows the pattern of other cross-cutting invariants (e.g. `TABLE_PK_COLUMN` in `change-log.ts`) where a single const declared in `core` is imported by both schema-shaping code and call-site validation.
- **Error surfacing in command handlers** (`packages/agent/src/commands/memory.ts`) — the catch block in the memory command dispatcher around line 449 already maps thrown errors to `commandError(err.message)`. `InvalidRelationError` flows through this path without a new branch.
- **Test harness schema** (`packages/sync/src/__tests__/test-harness.ts`) — the `FULL_SCHEMA` string is the canonical schema-under-test; adding the new column and triggers there is required for reducer tests to exercise the updated table shape.

No divergences — this design is entirely additive and reuses existing infrastructure.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Canonical-relation module and schema changes
**Goal:** Establish the single source of truth for canonical relations, add the `context` column, and install the DB-layer trigger. Fresh and existing DBs reach the same post-state.

**Components:**
- New module `packages/core/src/memory-relations.ts` — exports `CANONICAL_RELATIONS`, `CanonicalRelation` type, `isCanonicalRelation()`, `InvalidRelationError`, and `SPELLING_VARIANTS` lookup.
- Schema changes in `packages/core/src/schema.ts` — `ALTER TABLE memory_edges ADD COLUMN context TEXT` (wrapped in the existing duplicate-column try/catch), plus the two `CREATE TRIGGER IF NOT EXISTS` statements whose `WHEN NEW.relation NOT IN (...)` lists are generated from `CANONICAL_RELATIONS` via template literal.
- Column-cache invalidation — call `clearColumnCache()` (from `packages/sync/src/reducers.ts`) at the same point in schema init where the ALTER runs.
- Test-harness schema update — add the `context` column and triggers to `FULL_SCHEMA` in `packages/sync/src/__tests__/test-harness.ts`.

**Dependencies:** None (first phase).

**Done when:** Fresh DB init produces a `memory_edges` table with the new column and both triggers; existing DB init is idempotent; direct SQL `INSERT` with a non-canonical relation is rejected by the trigger. Covers AC1.1, AC1.2, AC1.3, AC1.4, AC1.5, AC3.2, AC3.3, AC3.4.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Agent-layer validation and CLI context flag
**Goal:** Every agent-originated write path validates the relation before the DB call, and the CLI exposes `--context` as a first-class flag.

**Components:**
- `upsertEdge()` in `packages/agent/src/graph-queries.ts` — gains optional `context` parameter; guards on `isCanonicalRelation(relation)` and throws `InvalidRelationError` before any DB work; threads `context` into the row data passed to `insertRow()` / `updateRow()`.
- `handleConnect` in `packages/agent/src/commands/memory.ts` — reads `args.context`, passes it through to `upsertEdge()`; the existing error-mapping path surfaces `InvalidRelationError.message` via `commandError()`.
- `memory connect` command definition — adds `context` to the `args` schema as non-required.
- Output formatting in `memory neighbors` and `memory traverse` — includes `context` in the per-edge line format when present.

**Dependencies:** Phase 1 (the canonical-relation module and the `context` column must exist).

**Done when:** Unit test verifies `upsertEdge()` with a non-canonical relation throws and emits no change-log entry; CLI test verifies `memory connect a b not-a-relation` returns an error listing canonicals and the `--context` hint, and `memory connect a b related_to --context "foo"` succeeds with the edge carrying `context="foo"`. Covers AC3.1, AC4.1, AC4.2, AC4.3, AC4.4.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Startup data-normalization migration
**Goal:** Every node, on every startup, converges its `memory_edges` rows to the canonical state. First boot after deploy performs the real work; subsequent boots are zero-cost no-ops that double as a health check.

**Components:**
- Migration module `packages/core/src/migrations/normalize-edge-relations.ts` — exposes `normalizeEdgeRelations(db)` returning `{ variants_mapped, moved_to_context, collisions_merged, total_scanned }`. Uses `updateRow()` for every mutation; implements the collision-merge semantics from AC2.6.
- Schema-init integration — call `normalizeEdgeRelations(db)` from `packages/core/src/schema.ts` after the `ALTER TABLE` and `CREATE TRIGGER` steps so the `context` column and trigger are in place before the routine writes. Summary counts logged at the call site.
- Sync round-trip integration test — seeds two peers, writes an edge with `context` on peer A, asserts peer B materializes it with `context` intact.
- Multi-node convergence test — seeds two peers with overlapping non-canonical data, runs startup on both, asserts both converge to the same logical state under LWW regardless of startup order.

**Dependencies:** Phases 1 and 2 (the `context` column, trigger, canonical-relation module, and agent-layer validation must all be in place; Phase 2 is what prevents new bespoke writes from being produced after the schema is updated, bounding the convergence window).

**Done when:** Migration test seeds a DB with mixed canonical, spelling-variant, and bespoke relations; runs `initializeSchema()`; asserts canonicals untouched, variants mapped correctly, bespoke rewritten with `context` populated, collisions merged with max-weight and joined context, and a second `initializeSchema()` call is a data-level no-op. Sync round-trip test passes. Multi-node convergence test passes. Covers AC2.1, AC2.2, AC2.3, AC2.4, AC2.5, AC2.6, AC2.7, AC2.8, AC5.1, AC5.2, AC5.3.
<!-- END_PHASE_3 -->

## Additional Considerations

**Weight merge policy.** Collision merge takes `max(weight_a, weight_b)`. Alternative is `sum()` (treats duplicate edges as accumulated votes). `max()` is conservative — it doesn't inflate weights of previously-distinct-looking edges. Revisit if downstream consumers of edge weight start producing weaker signals post-migration.

**`context` is not indexed.** It's free text, searched only when explicitly requested via future `memory search` extensions (out of scope). Storing bespoke phrasing here preserves information without paying the indexing cost that the relation column was incorrectly being charged with.

**Startup cost.** The migration's driving `SELECT` filters by `relation NOT IN (<canonical set>) AND deleted = 0`. On nodes that have already migrated, this returns zero rows and adds microseconds to startup. On a node with ~150 non-canonical rows (current production scale), the loop does ~150 `updateRow()` calls — sub-second. Acceptable for startup; revisit only if edge counts grow an order of magnitude.

**Schema version tracking.** Nothing in bound currently tracks schema version explicitly; migrations are ALTER-and-catch-duplicate plus idempotent-data-pass. Additive changes like this one are safe under that model. Destructive changes (dropping/renaming columns, tightening constraints beyond what existing data satisfies) would require real version tracking. Out of scope here but worth flagging for future destructive work.

**Future: promoting bespoke relations.** If the post-migration `context` column reveals that a particular phrasing appears frequently (e.g. `"durable-execution-pattern"` recurs enough to justify a canonical), that's evidence for adding a new canonical relation in a follow-on change. Not automated in this plan — requires deliberate review of `context` distributions after migration settles.
