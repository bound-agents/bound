# Edge Graph Normalization Implementation Plan — Phase 1

**Goal:** Establish the single source of truth for canonical relations, add the `context` column to `memory_edges`, and install DB-layer triggers enforcing the canonical set.

**Architecture:** New `memory-relations.ts` module in `@bound/core` defines the 10 canonical relations, a type guard, an error class, and a spelling-variant lookup. Schema migrations in `schema.ts` add the column and triggers. The trigger SQL is generated from the canonical const at init time — single source of truth, no drift.

**Tech Stack:** TypeScript, bun:sqlite, bun:test

**Scope:** 3 phases from original design (phase 1 of 3)

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase implements and tests:

### edge-graph-normalization.AC1: Schema and trigger in place
- **edge-graph-normalization.AC1.1 Success:** Fresh DB init creates `memory_edges` with the `context TEXT` column and canonical-relation trigger.
- **edge-graph-normalization.AC1.2 Success:** Existing DB with data gains the `context` column via `ALTER TABLE` wrapped in the duplicate-column try/catch pattern used by other migrations in `schema.ts`.
- **edge-graph-normalization.AC1.3 Success:** The trigger is created via `CREATE TRIGGER IF NOT EXISTS` for BEFORE INSERT and BEFORE UPDATE OF relation, idempotent across restarts.
- **edge-graph-normalization.AC1.4 Success:** Running schema init twice is a no-op (no errors, no data change, trigger count unchanged).
- **edge-graph-normalization.AC1.5 Success:** The reducer column cache is cleared after the ALTER runs so long-running agent processes pick up the new column without restart.

### edge-graph-normalization.AC3: Runtime enforcement (partial — trigger-level)
- **edge-graph-normalization.AC3.2 Failure:** Direct SQL `INSERT INTO memory_edges` with a non-canonical relation fails with the trigger's `RAISE(ABORT, ...)` message listing valid relations.
- **edge-graph-normalization.AC3.3 Failure:** Direct SQL `UPDATE memory_edges SET relation = '<bespoke>'` fails with the same trigger error.
- **edge-graph-normalization.AC3.4 Success:** The canonical relation set is defined in exactly one place (`packages/core/src/memory-relations.ts`) and imported by both the schema module (to generate trigger SQL) and `graph-queries.ts` (for pre-flight validation).

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Create canonical-relation module

**Verifies:** edge-graph-normalization.AC3.4

**Files:**
- Create: `packages/core/src/memory-relations.ts`

**Implementation:**

Create the module that defines the canonical relation set, type guard, error class, and spelling-variant lookup. This is the single source of truth imported by both the schema module and agent-layer validation.

```typescript
/**
 * Canonical relation types for memory_edges.
 * This set is frozen by design — adding more requires a deliberate follow-on change
 * that updates the const, adjusts the trigger, and may require a schema-version bump.
 */
export const CANONICAL_RELATIONS = [
	"related_to",
	"informs",
	"supports",
	"extends",
	"complements",
	"contrasts-with",
	"competes-with",
	"cites",
	"summarizes",
	"synthesizes",
] as const;

export type CanonicalRelation = (typeof CANONICAL_RELATIONS)[number];

const canonicalSet = new Set<string>(CANONICAL_RELATIONS);

export function isCanonicalRelation(rel: string): rel is CanonicalRelation {
	return canonicalSet.has(rel);
}

export class InvalidRelationError extends Error {
	readonly rel: string;

	constructor(rel: string) {
		const valid = CANONICAL_RELATIONS.join(", ");
		super(
			`Invalid relation "${rel}". Must be one of: ${valid}. Use --context to attach bespoke phrasing to a canonical relation.`,
		);
		this.name = "InvalidRelationError";
		this.rel = rel;
	}
}

/**
 * Deterministic lowercased-key → canonical-value lookup for spelling variants
 * observed in production data. Keys are lowercased for case-insensitive matching.
 */
export const SPELLING_VARIANTS: Record<string, CanonicalRelation> = {
	// related_to variants
	"related-to": "related_to",
	relates_to: "related_to",
	relates: "related_to",
	related: "related_to",
	"relates-to": "related_to",
	relate: "related_to",

	// informs variants
	inform: "informs",
	informed_by: "informs",
	"informed-by": "informs",

	// supports variants
	support: "supports",
	supported_by: "supports",
	"supported-by": "supports",

	// extends variants
	extend: "extends",
	extended_by: "extends",
	"extended-by": "extends",

	// complements variants
	complement: "complements",
	complementary: "complements",
	"complementary-to": "complements",

	// contrasts-with variants
	contrasts: "contrasts-with",
	"contrasts_with": "contrasts-with",
	contrast: "contrasts-with",

	// competes-with variants
	competes: "competes-with",
	"competes_with": "competes-with",
	compete: "competes-with",

	// cites variants
	cite: "cites",
	cited_by: "cites",
	"cited-by": "cites",
	references: "cites",
	reference: "cites",

	// summarizes variants
	summarize: "summarizes",
	summary_of: "summarizes",
	"summary-of": "summarizes",
	"summarizes-to": "summarizes",

	// synthesizes variants
	synthesize: "synthesizes",
	synthesis_of: "synthesizes",
	"synthesis-of": "synthesizes",
};
```

**Verification:**
Run: `tsc -p packages/core --noEmit`
Expected: No type errors

**Commit:** `feat(core): add canonical-relation module for memory_edges`

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Export memory-relations from @bound/core barrel

**Files:**
- Modify: `packages/core/src/index.ts:80` (append after last export)

**Implementation:**

Add the re-export at the end of the barrel file:

```typescript
export {
	CANONICAL_RELATIONS,
	type CanonicalRelation,
	isCanonicalRelation,
	InvalidRelationError,
	SPELLING_VARIANTS,
} from "./memory-relations";
```

**Verification:**
Run: `tsc -p packages/core --noEmit`
Expected: No type errors

**Commit:** `feat(core): export memory-relations from barrel`

<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Add context column and canonical-relation triggers to schema.ts

**Verifies:** edge-graph-normalization.AC1.1, edge-graph-normalization.AC1.2, edge-graph-normalization.AC1.3, edge-graph-normalization.AC1.5

**Files:**
- Modify: `packages/core/src/schema.ts:1` (add import at top)
- Modify: `packages/core/src/schema.ts` (add migration block before closing `}` of `applySchema()`)

**Implementation:**

At the top of `schema.ts`, add the import for `CANONICAL_RELATIONS`:

```typescript
import { CANONICAL_RELATIONS } from "./memory-relations";
```

Also add the import for `clearColumnCache` from the sync package. Check whether schema.ts already imports from `@bound/sync` — if not, add:

```typescript
import { clearColumnCache } from "@bound/sync";
```

**Important:** If importing from `@bound/sync` would create a circular dependency (core → sync), call `clearColumnCache` from the call site in `start.ts` instead. Investigate whether `packages/core/package.json` lists `@bound/sync` as a dependency. If it does not, the import must live elsewhere.

**Alternative approach if circular dependency exists:** Export a `getColumnCacheClearer` registration function or have `start.ts` call `clearColumnCache()` after `applySchema()`. The design notes that the call should happen "at the same point in schema init where the ALTER runs" — if cross-package import is not possible, the closest equivalent is immediately after `applySchema(db)` returns in `start.ts`.

Add the following migration block at the end of `applySchema()`, just before the closing `}` (after the `model_hint` ALTER TABLE block):

```typescript
// ── Edge graph normalization ─────────────────────────────────────────────────

// Add context column to memory_edges (nullable free-text annotation)
try {
	db.run("ALTER TABLE memory_edges ADD COLUMN context TEXT");
} catch {
	/* already exists */
}

// Generate trigger SQL from canonical set — single source of truth.
// Safety: CANONICAL_RELATIONS values are string literals defined in memory-relations.ts.
// None contain single quotes, so interpolation into SQL string literals is safe.
// If a value with a single quote were ever added to the set, the trigger CREATE
// would fail loudly at startup (SQL syntax error), not silently inject.
const canonicalList = CANONICAL_RELATIONS.map((r) => `'${r}'`).join(", ");
const triggerMsg = `Invalid relation. Must be one of: ${CANONICAL_RELATIONS.join(", ")}. Use context column for bespoke phrasing.`;

db.run(`
	CREATE TRIGGER IF NOT EXISTS memory_edges_canonical_relation_insert
	BEFORE INSERT ON memory_edges
	FOR EACH ROW WHEN NEW.relation NOT IN (${canonicalList})
	BEGIN SELECT RAISE(ABORT, '${triggerMsg}'); END
`);

db.run(`
	CREATE TRIGGER IF NOT EXISTS memory_edges_canonical_relation_update
	BEFORE UPDATE OF relation ON memory_edges
	FOR EACH ROW WHEN NEW.relation NOT IN (${canonicalList})
	BEGIN SELECT RAISE(ABORT, '${triggerMsg}'); END
`);
```

**Note on column cache:** The LWW reducer in `packages/sync/src/reducers.ts` discovers columns via `PRAGMA table_info` with a module-level cache. After adding the `context` column, this cache must be invalidated so existing processes pick up the new column. See the dependency investigation note above regarding where to call `clearColumnCache()`.

**Verification:**
Run: `tsc -p packages/core --noEmit`
Expected: No type errors

Run: `bun test packages/core/src/__tests__/database.test.ts`
Expected: Existing schema tests still pass

**Commit:** `feat(core): add context column and canonical-relation triggers to memory_edges`

<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Update FULL_SCHEMA in sync test harness

**Verifies:** edge-graph-normalization.AC1.1 (partial — test harness matches production schema)

**Files:**
- Modify: `packages/sync/src/__tests__/test-harness.ts:156-170` (memory_edges block)

**Implementation:**

Update the `memory_edges` CREATE TABLE in `FULL_SCHEMA` to include the `context` column, and add the two trigger definitions after the indexes:

Replace the current memory_edges block (lines 156-170):

```sql
CREATE TABLE memory_edges (
	id          TEXT PRIMARY KEY,
	source_key  TEXT NOT NULL,
	target_key  TEXT NOT NULL,
	relation    TEXT NOT NULL,
	weight      REAL DEFAULT 1.0,
	context     TEXT,
	created_at  TEXT NOT NULL,
	modified_at TEXT NOT NULL,
	deleted     INTEGER DEFAULT 0
);

CREATE UNIQUE INDEX idx_edges_triple
	ON memory_edges(source_key, target_key, relation) WHERE deleted = 0;
CREATE INDEX idx_edges_source ON memory_edges(source_key) WHERE deleted = 0;
CREATE INDEX idx_edges_target ON memory_edges(target_key) WHERE deleted = 0;
```

Then add the trigger definitions. The trigger SQL must use the same canonical set. Since the test harness is a raw SQL string (not generated from the const), hardcode the 10 values here. This is acceptable because the test will fail if a value is added to `CANONICAL_RELATIONS` but not to the harness, serving as a safety net.

```sql
CREATE TRIGGER IF NOT EXISTS memory_edges_canonical_relation_insert
BEFORE INSERT ON memory_edges
FOR EACH ROW WHEN NEW.relation NOT IN ('related_to','informs','supports','extends','complements','contrasts-with','competes-with','cites','summarizes','synthesizes')
BEGIN SELECT RAISE(ABORT, 'Invalid relation. Must be one of: related_to, informs, supports, extends, complements, contrasts-with, competes-with, cites, summarizes, synthesizes. Use context column for bespoke phrasing.'); END;

CREATE TRIGGER IF NOT EXISTS memory_edges_canonical_relation_update
BEFORE UPDATE OF relation ON memory_edges
FOR EACH ROW WHEN NEW.relation NOT IN ('related_to','informs','supports','extends','complements','contrasts-with','competes-with','cites','summarizes','synthesizes')
BEGIN SELECT RAISE(ABORT, 'Invalid relation. Must be one of: related_to, informs, supports, extends, complements, contrasts-with, competes-with, cites, summarizes, synthesizes. Use context column for bespoke phrasing.'); END;
```

**Verification:**
Run: `bun test packages/sync`
Expected: All sync/reducer tests still pass

**Commit:** `test(sync): add context column and canonical-relation triggers to FULL_SCHEMA`

<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Tests for schema, trigger rejection, and idempotency

**Verifies:** edge-graph-normalization.AC1.1, edge-graph-normalization.AC1.2, edge-graph-normalization.AC1.3, edge-graph-normalization.AC1.4, edge-graph-normalization.AC3.2, edge-graph-normalization.AC3.3

**Files:**
- Create: `packages/core/src/__tests__/memory-edges-schema.test.ts`

**Testing:**

Create a new test file focused on the schema-level invariants for the edge graph normalization. Follow the existing pattern from `packages/core/src/__tests__/database.test.ts` (temp dir, `createDatabase()`, `applySchema()`, direct SQL queries).

Tests must verify each AC listed above:

- **edge-graph-normalization.AC1.1:** Fresh DB from `createDatabase()` + `applySchema()` has `context` column on `memory_edges` (check via `PRAGMA table_info(memory_edges)`) and both triggers exist (check via `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_edges'`).

- **edge-graph-normalization.AC1.2:** Simulate existing DB by first creating the table without the `context` column (using the old schema SQL directly), inserting a test row, then calling `applySchema()`. Verify the `context` column now exists and the test row data survived.

- **edge-graph-normalization.AC1.3:** After `applySchema()`, query `sqlite_master` for triggers on `memory_edges`. Verify exactly 2 triggers with the expected names (`memory_edges_canonical_relation_insert`, `memory_edges_canonical_relation_update`).

- **edge-graph-normalization.AC1.4:** Call `applySchema()` twice on the same DB. Verify no errors thrown, trigger count is still exactly 2, and existing data is unchanged.

- **edge-graph-normalization.AC3.2:** After `applySchema()`, attempt a direct `INSERT INTO memory_edges` with `relation = 'bespoke-thing'`. Verify it throws an error whose message contains the list of valid relations.

- **edge-graph-normalization.AC3.3:** Insert a row with a canonical relation (`related_to`), then attempt `UPDATE memory_edges SET relation = 'bespoke-thing' WHERE id = ?`. Verify it throws an error whose message contains the list of valid relations.

- **Trigger-const sync check (nice-to-have):** Query `sqlite_master` for the trigger SQL, extract the NOT IN list, and compare against `CANONICAL_RELATIONS`. Verify the sets match. This catches drift if someone adds a canonical relation but forgets to re-run schema init.

Follow project testing patterns:
- `beforeEach`: `mkdtempSync` + `createDatabase(dbPath)` + `applySchema(db)`
- `afterEach`: `db.close()` + cleanup temp dir
- Direct SQL queries for verification (PRAGMA, sqlite_master, INSERT/UPDATE)

**Verification:**
Run: `bun test packages/core/src/__tests__/memory-edges-schema.test.ts`
Expected: All tests pass

**Commit:** `test(core): add schema and trigger tests for edge graph normalization`

<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Update ALL existing edge tests for canonical relations

**Verifies:** edge-graph-normalization.AC3.2 (integration-level — existing tests use non-canonical relations)

**Files:**
- Modify: `packages/agent/src/__tests__/graph-memory-edges.test.ts` (34 occurrences of `"relates_to"`, plus `"governs"`, `"depends_on"`)
- Modify: `packages/agent/src/__tests__/graph-memory-traversal.test.ts` (`"relates_to"`, `"governs"`, `"part_of"`, `"derived_from"`)
- Modify: `packages/agent/src/__tests__/graph-memory-lifecycle.test.ts` (`"depends_on"`, `"relates_to"`, `"references"`)
- Modify: `packages/agent/src/__tests__/graph-memory-context.test.ts` (`"refers_to"`, `"example_of"`, `"uses"`, `"enables"`, `"leads_to"`, `"relates_to"`, `"relates"`)

**NOT affected** (these files call `applySchema()` but already use canonical relations like `"summarizes"` and `"related_to"`):
- `hierarchical-memory-sync.test.ts`
- `hierarchical-memory-compat.test.ts`
- `memory-tier-forget.test.ts`
- `memory-tier-disconnect.test.ts`
- `pipeline-orchestrator.test.ts`

**NOT affected** (these create their own inline schema without triggers):
- `stage-functions.test.ts`

**Implementation:**

**CRITICAL:** `"relates_to"` is NOT canonical. The canonical form is `"related_to"` (with a `d`). The spelling variant map explicitly lists `relates_to → related_to`.

Across ALL 4 files listed above, apply these replacements:
- `"relates_to"` → `"related_to"` (canonical)
- `"relates"` → `"related_to"` (canonical)
- `"governs"` → `"informs"` (closest semantic match)
- `"depends_on"` → `"supports"` (closest semantic match)
- `"part_of"` → `"extends"` (closest semantic match)
- `"derived_from"` → `"cites"` (closest semantic match)
- `"refers_to"` → `"cites"` (closest semantic match)
- `"example_of"` → `"supports"` (closest semantic match)
- `"uses"` → `"informs"` (closest semantic match)
- `"enables"` → `"supports"` (closest semantic match)
- `"leads_to"` → `"informs"` (closest semantic match)
- `"references"` → `"cites"` (closest semantic match)

**Note on test semantics:** These tests verify graph CRUD operations, traversal, and lifecycle — not the semantic meaning of relations. Changing the relation strings to canonical values does not affect what the tests are testing (edge creation, weight updates, soft-delete, traversal depth, etc.).

**Verification:**
Run: `bun test packages/agent/src/__tests__/graph-memory-edges.test.ts packages/agent/src/__tests__/graph-memory-traversal.test.ts packages/agent/src/__tests__/graph-memory-lifecycle.test.ts packages/agent/src/__tests__/graph-memory-context.test.ts`
Expected: All existing tests pass with canonical relation values

**Commit:** `test(agent): update all edge test relations to canonical set`

<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_C -->
