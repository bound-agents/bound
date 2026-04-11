# Hierarchical Memory Retrieval Implementation Plan

**Goal:** Implement the four retrieval stage functions as standalone, testable units that will replace the monolithic retrieval logic in `buildVolatileEnrichment()`.

**Architecture:** Four pure functions (`loadPinnedEntries`, `loadSummaryEntries`, `loadGraphEntries`, `loadRecencyEntries`) each accept a database handle and an exclusion set, return loaded entries plus an expanded exclusion set. The existing `graphSeededRetrieval()` in `graph-queries.ts` gains an `excludeKeys` parameter. Each stage function operates in isolation and can be tested independently with controlled DB state.

**Tech Stack:** TypeScript 6.x, bun:sqlite, `@bound/core` change-log outbox

**Scope:** 6 phases from original design (this is phase 3 of 6)

**Codebase verified:** 2026-04-10

---

## Acceptance Criteria Coverage

This phase implements and tests:

### hierarchical-memory.AC3: Stage function isolation
- **hierarchical-memory.AC3.1 Success:** L0 loads entries by both `tier = 'pinned'` and prefix match (`_standing%`, etc.)
- **hierarchical-memory.AC3.2 Success:** L1 loads summary entries not in E₀ and adds ALL children keys to exclusion set
- **hierarchical-memory.AC3.3 Success:** L1 detects stale children (child.modified_at > summary.modified_at) and loads them with `[stale-detail]` tag
- **hierarchical-memory.AC3.4 Success:** L1 loads ALL stale children, not just the first
- **hierarchical-memory.AC3.5 Success:** L2 excludes keys in E₁ and entries with tier `detail`, `pinned`, `summary`
- **hierarchical-memory.AC3.6 Success:** L2 treats orphaned detail entries (no incoming `summarizes` edge) as `default`
- **hierarchical-memory.AC3.7 Success:** L3 excludes keys in E₂ and applies same tier filter as L2

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Define stage types and implement `loadPinnedEntries()` (L0)

**Verifies:** hierarchical-memory.AC3.1

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts:388-393` (add new interfaces near existing `VolatileEnrichment`)
- Modify: `packages/agent/src/summary-extraction.ts` (add `loadPinnedEntries()` function)

**Implementation:**

Add the following interfaces near the existing `VolatileEnrichment` interface (around line 388):

```typescript
export interface StageEntry {
	key: string;
	value: string;
	source: string | null;
	modifiedAt: string;
	tier: MemoryTier;
	tag: string; // e.g., "[pinned]", "[summary]", "[stale-detail]", "[seed]", "[recency]"
}

export interface StageResult {
	entries: StageEntry[];
	exclusionSet: Set<string>;
}

export interface TieredEnrichment {
	L0: StageEntry[];
	L1: StageEntry[];
	L2: StageEntry[];
	L3: StageEntry[];
}
```

Import `MemoryTier` from `@bound/shared` at the top of the file.

Then implement `loadPinnedEntries()`. This function uses **dual detection** for backward compatibility: loads entries where `tier = 'pinned'` OR key matches a pinned prefix. The existing prefix query pattern is already at lines 436-440.

```typescript
export function loadPinnedEntries(db: Database): StageResult {
	// IMPORTANT: ESCAPE syntax must match summary-extraction.ts lines 467-470 exactly.
	// Copy the escape sequence from the existing codebase, do NOT derive from scratch.
	const rows = db
		.prepare(
			`SELECT key, value, source, modified_at, tier FROM semantic_memory
			 WHERE deleted = 0
			   AND (tier = 'pinned'
			     OR key LIKE '\\_standing%' ESCAPE '\\'
			     OR key LIKE '\\_feedback%' ESCAPE '\\'
			     OR key LIKE '\\_policy%' ESCAPE '\\'
			     OR key LIKE '\\_pinned%' ESCAPE '\\')`,
		)
		.all() as Array<{
		key: string;
		value: string;
		source: string | null;
		modified_at: string;
		tier: string;
	}>;

	const entries: StageEntry[] = rows.map((r) => ({
		key: r.key,
		value: r.value,
		source: r.source,
		modifiedAt: r.modified_at,
		tier: (r.tier || "pinned") as MemoryTier,
		tag: "[pinned]",
	}));

	const exclusionSet = new Set(entries.map((e) => e.key));

	return { entries, exclusionSet };
}
```

**Critical: ESCAPE syntax** — Copy the exact ESCAPE clause from existing prefix queries in `summary-extraction.ts` lines 467-470. Do NOT derive from scratch. The string escaping differs between template literals and `prepare()` strings. Verify against a test DB before committing.

**SQL deduplication note:** The OR conditions in the WHERE clause return unique rows (not duplicate condition matches), so an entry matching both `tier = 'pinned'` AND a prefix key will appear exactly once in results. No JavaScript-level deduplication is needed.

**Testing:**

Tests must verify:
- **hierarchical-memory.AC3.1:** Insert entries with `tier = 'pinned'` AND entries with prefix keys (that may have `tier = 'default'` if migration hasn't run). Both should be loaded by L0. Verify deduplication (an entry matching both criteria appears only once — SQL handles this).

Create test file at `packages/agent/src/__tests__/stage-functions.test.ts`.

**Verification:**
Run: `bun test packages/agent/src/__tests__/stage-functions.test.ts`
Expected: L0 tests pass

**Commit:** `feat(agent): add StageEntry/StageResult types and loadPinnedEntries (AC3.1)`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Implement `loadSummaryEntries()` (L1) with stale-child detection

**Verifies:** hierarchical-memory.AC3.2, hierarchical-memory.AC3.3, hierarchical-memory.AC3.4

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts` (add `loadSummaryEntries()` function)

**Implementation:**

`loadSummaryEntries()` loads all summary-tier entries not in the exclusion set, then queries their `summarizes` edges to find children. All children are added to the exclusion set regardless of staleness. Stale children (modified after the summary) are loaded alongside the summary with a `[stale-detail]` tag.

```typescript
export function loadSummaryEntries(
	db: Database,
	excludeKeys: Set<string>,
): StageResult {
	// Load all summary entries not already in exclusion set
	const summaries = db
		.prepare(
			`SELECT key, value, source, modified_at, tier FROM semantic_memory
			 WHERE tier = 'summary' AND deleted = 0`,
		)
		.all() as Array<{
		key: string;
		value: string;
		source: string | null;
		modified_at: string;
		tier: string;
	}>;

	const entries: StageEntry[] = [];
	const newExclusion = new Set(excludeKeys);

	for (const summary of summaries) {
		if (excludeKeys.has(summary.key)) continue;

		entries.push({
			key: summary.key,
			value: summary.value,
			source: summary.source,
			modifiedAt: summary.modified_at,
			tier: "summary",
			tag: "[summary]",
		});
		newExclusion.add(summary.key);

		// Find all children via outgoing summarizes edges
		const children = db
			.prepare(
				`SELECT m.key, m.value, m.source, m.modified_at, m.tier
				 FROM memory_edges e
				 JOIN semantic_memory m ON m.key = e.target_key AND m.deleted = 0
				 WHERE e.source_key = ? AND e.relation = 'summarizes' AND e.deleted = 0`,
			)
			.all(summary.key) as Array<{
			key: string;
			value: string;
			source: string | null;
			modified_at: string;
			tier: string;
		}>;

		for (const child of children) {
			// ALL children go into exclusion set — stale or not
			newExclusion.add(child.key);

			// Stale children: modified after the summary
			if (child.modified_at > summary.modified_at) {
				entries.push({
					key: child.key,
					value: child.value,
					source: child.source,
					modifiedAt: child.modified_at,
					tier: child.tier as MemoryTier,
					tag: "[stale-detail]",
				});
			}
		}
	}

	return { entries, exclusionSet: newExclusion };
}
```

**Testing:**

Tests must verify:
- **hierarchical-memory.AC3.2:** Create a summary S with two children C1, C2 (via `summarizes` edges). L1 loads S, adds S, C1, C2 keys to exclusion set.
- **hierarchical-memory.AC3.3:** Set C1's `modified_at` to be newer than S's `modified_at`. L1 loads C1 with `[stale-detail]` tag alongside S.
- **hierarchical-memory.AC3.4:** Set both C1 and C2 as stale. L1 loads BOTH stale children, not just the first one.

Add tests to `packages/agent/src/__tests__/stage-functions.test.ts`.

**Verification:**
Run: `bun test packages/agent/src/__tests__/stage-functions.test.ts`
Expected: L1 tests pass

**Commit:** `feat(agent): add loadSummaryEntries with stale-child detection (AC3.2-AC3.4)`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Add `excludeKeys` parameter to `graphSeededRetrieval()` and implement `loadGraphEntries()` (L2)

**Verifies:** hierarchical-memory.AC3.5, hierarchical-memory.AC3.6

**Files:**
- Modify: `packages/agent/src/graph-queries.ts:295-369` (add `excludeKeys` param to `graphSeededRetrieval()`)
- Modify: `packages/agent/src/summary-extraction.ts` (add `loadGraphEntries()` function)

**Implementation:**

**Step 1: Modify `graphSeededRetrieval()` signature** (graph-queries.ts:295):

Add an optional `excludeKeys` parameter:

```typescript
export function graphSeededRetrieval(
	db: Database,
	keywords: string[],
	maxResults: number,
	depth = 2,
	excludeKeys?: Set<string>,
): GraphRetrievalResult[]
```

In the seed query (around line 314), add exclusion and tier filtering:
- Exclude keys in `excludeKeys` set
- Exclude entries with `tier IN ('detail', 'pinned', 'summary')` — L2 only retrieves `default` tier entries
- Add orphaned detail fallback: entries with `tier = 'detail'` that have NO incoming `summarizes` edge should be treated as `default` (retrievable)

The orphaned detail check uses a NOT EXISTS subquery:

```sql
AND (
  m.tier NOT IN ('detail', 'pinned', 'summary')
  OR (m.tier = 'detail' AND NOT EXISTS (
    SELECT 1 FROM memory_edges e
    WHERE e.target_key = m.key AND e.relation = 'summarizes' AND e.deleted = 0
  ))
)
```

For the `excludeKeys` filtering, since SQLite doesn't support bind-parameter arrays easily, build a comma-separated list of quoted keys for an IN clause, or use a temp table. The simplest approach: filter results in JavaScript after the query. Since `maxResults` is typically small (10-25), post-filtering is acceptable for initial implementation.

**Known limitation:** The post-filtering heuristic (requesting `maxSlots + excludeKeys.size` from the query) may under-deliver results in pathological cases where many excluded keys are concentrated in the top results. If this proves insufficient in practice, escalate to SQL-level filtering (dynamically build a NOT IN clause for exclude keys, or use a temp table for large exclusion sets).

Also apply the same tier/exclusion filters to the traversal results (after `traverseGraph()` returns).

**Step 2: Implement `loadGraphEntries()`** in summary-extraction.ts:

```typescript
export function loadGraphEntries(
	db: Database,
	excludeKeys: Set<string>,
	keywords: string[],
	maxSlots: number,
): StageResult {
	if (keywords.length === 0 || maxSlots <= 0) {
		return { entries: [], exclusionSet: new Set(excludeKeys) };
	}

	const graphResults = graphSeededRetrieval(db, keywords, maxSlots + excludeKeys.size, 2, excludeKeys);

	const entries: StageEntry[] = [];
	const newExclusion = new Set(excludeKeys);

	for (const r of graphResults) {
		if (newExclusion.has(r.key)) continue;
		if (entries.length >= maxSlots) break;

		const tag =
			r.retrievalMethod === "seed"
				? "[seed]"
				: `[depth ${r.depth}, ${r.viaRelation}]`;

		entries.push({
			key: r.key,
			value: r.value,
			source: r.source,
			modifiedAt: r.modifiedAt,
			tier: "default",
			tag,
		});
		newExclusion.add(r.key);
	}

	return { entries, exclusionSet: newExclusion };
}
```

**Testing:**

Tests must verify:
- **hierarchical-memory.AC3.5:** Create entries with various tiers. L2 (via loadGraphEntries) only returns `default` tier entries. Keys in exclusion set from L0/L1 are skipped.
- **hierarchical-memory.AC3.6:** Create a `detail` tier entry with NO incoming `summarizes` edge (orphan). L2 should include it. Create another `detail` entry WITH a `summarizes` edge — L2 should exclude it.

Add tests to `packages/agent/src/__tests__/stage-functions.test.ts`.

**Verification:**
Run: `bun test packages/agent/src/__tests__/stage-functions.test.ts`
Expected: L2 tests pass

Run: `bun test packages/agent/src/__tests__/graph-memory-traversal.test.ts`
Expected: Existing graph traversal tests still pass (excludeKeys is optional)

**Commit:** `feat(agent): add excludeKeys to graphSeededRetrieval and loadGraphEntries (AC3.5-AC3.6)`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Implement `loadRecencyEntries()` (L3)

**Verifies:** hierarchical-memory.AC3.7

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts` (add `loadRecencyEntries()` function)

**Implementation:**

L3 fills remaining slots with recent entries, applying the same tier/exclusion filters as L2. Uses the existing recency query pattern (lines 455-483) as a reference.

```typescript
export function loadRecencyEntries(
	db: Database,
	excludeKeys: Set<string>,
	baseline: string,
	maxSlots: number,
): StageResult {
	if (maxSlots <= 0) {
		return { entries: [], exclusionSet: new Set(excludeKeys) };
	}

	// Query recent entries, excluding pinned/summary/detail tiers
	// (same filter as L2 — orphaned details also pass through)
	const rows = db
		.prepare(
			`SELECT m.key, m.value, m.source, m.modified_at, m.tier,
			        t.name AS task_name, th_src.title AS thread_title
			 FROM semantic_memory m
			 LEFT JOIN tasks t ON m.source = t.id AND t.deleted = 0
			 LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0
			 WHERE m.deleted = 0
			   AND m.modified_at > ?
			   AND (
			     m.tier NOT IN ('detail', 'pinned', 'summary')
			     OR (m.tier = 'detail' AND NOT EXISTS (
			       SELECT 1 FROM memory_edges e
			       WHERE e.target_key = m.key AND e.relation = 'summarizes' AND e.deleted = 0
			     ))
			   )
			 ORDER BY m.modified_at DESC
			 LIMIT ?`,
		)
		.all(baseline, maxSlots + excludeKeys.size) as Array<{
		key: string;
		value: string;
		source: string | null;
		modified_at: string;
		tier: string;
		task_name: string | null;
		thread_title: string | null;
	}>;

	const entries: StageEntry[] = [];
	const newExclusion = new Set(excludeKeys);

	for (const row of rows) {
		if (newExclusion.has(row.key)) continue;
		if (entries.length >= maxSlots) break;

		entries.push({
			key: row.key,
			value: row.value,
			source: row.source,
			modifiedAt: row.modified_at,
			tier: (row.tier || "default") as MemoryTier,
			tag: "[recency]",
		});
		newExclusion.add(row.key);
	}

	return { entries, exclusionSet: newExclusion };
}
```

**Testing:**

Tests must verify:
- **hierarchical-memory.AC3.7:** Create entries with mixed tiers and various `modified_at` timestamps. Provide an exclusion set from L0+L1+L2. L3 returns only `default` tier entries (plus orphaned details) not in the exclusion set, ordered by recency, respecting `maxSlots`.

Add tests to `packages/agent/src/__tests__/stage-functions.test.ts`.

**Verification:**
Run: `bun test packages/agent/src/__tests__/stage-functions.test.ts`
Expected: All stage function tests pass (L0, L1, L2, L3)

Run: `bun test packages/agent`
Expected: All existing agent tests still pass

**Commit:** `feat(agent): add loadRecencyEntries for L3 stage (AC3.7)`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->
