# Volatile Context Tiered Fidelity — Phase 1: Data Layer

**Goal:** Add the schema, retrieval, and tag-normalization data-layer changes that subsequent rendering phases consume.

**Architecture:** Three independent additive changes — a partial index for the new R-VC4 SELECT, a new sibling retrieval stage that enumerates detail-tier entries directly, and a one-line normalization of the existing `loadGraphEntries` tag emission. No data-shape changes; no callers re-wired in this phase.

**Tech Stack:** TypeScript, `bun:sqlite`, the project's outbox + change-log conventions (see `CONTRIBUTING.md` "Critical invariants").

**Scope:** 1 of 7 phases — data layer only. Rendering changes ship in Phases 2–5.

**Codebase verified:** 2026-05-22 against commit `36dc9f2e` via codebase-investigator. Findings: all spec line numbers accurate, partial-index syntax already used elsewhere in `schema.ts`, existing indexes (`idx_memory_key`, `idx_memory_modified`, `idx_memory_tier`) do not support the R-VC4 SELECT's `tier='detail' AND deleted=0 ORDER BY last_accessed_at DESC` access pattern.

---

## Acceptance Criteria Coverage

This phase implements:

### volatile-context.R-VC4 (data-layer half — retrieval stage and supporting index)

- **R-VC4 (literal):** "The Discoverable Archive section shall enumerate entries where `tier = 'detail' AND deleted IS NOT 1` via a new retrieval stage independent of R-HM6's L0/L1/L2/L3 slot accounting. The new stage performs a SELECT on `semantic_memory` ordered by `last_accessed_at DESC`. Each entry shall render as title-only — the `key` and a single trailing context fragment naming relative time of last access, with no value body. Bodies are accessed via `memory search` or `query`. Visibility under volume is governed by R-VC15's three-tier compression."
- **Phase 1 portion:** the SELECT and its supporting partial index are landed here. The rendering half (title-only output, R-VC15 tier compression) is Phase 3.

### volatile-context.R-HM8-norm (graph tag normalization)

- **§6.1 R-HM8 (literal):** "`loadGraphEntries` (`packages/agent/src/summary-extraction.ts:898`) currently emits `\"[seed]\"` or `` `[depth ${depth}, ${relation}]` `` (e.g. `[depth 2, informs]`) per `:959`; this is normalized to a single `\"[graph]\"` tag at the loader boundary so the §6.4 dispatch table can route on a flat tag set. The seed-vs-depth provenance is retrievable from the `memory_edges` graph if a future caller needs it; the visible string is dropped from rendered output regardless (section assignment carries the role)."

### volatile-context.AC-Deploy-Schema (literal from §2.2 table row "`semantic_memory` indexes")

- **§2.2 (literal):** "New partial index `idx_memory_detail_recency ON semantic_memory(last_accessed_at DESC) WHERE tier='detail' AND deleted=0` ships alongside the rendering change to support R-VC4's unbounded SELECT (§4.1). Existing indexes are unchanged."

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add `idx_memory_detail_recency` partial index

**Type:** Infrastructure. No new behavior; verifies operationally.

**Verifies:** None (infrastructure scaffolding for R-VC4).

**Files:**
- Modify: `packages/core/src/schema.ts` — add the index definition alongside the existing `idx_memory_*` indexes.

**Implementation:**

The index supports R-VC4's per-turn SELECT. Without it, `tier='detail' AND deleted=0 ORDER BY last_accessed_at DESC` falls back to a full tablescan + sort on each volatile-context assembly. The partial-index `WHERE` clause matches the SELECT's predicate exactly so the index stays small.

Add the following statement to the schema migration block, sequenced after the existing `idx_memory_tier` definition (verified at `schema.ts:768`). Use the existing `CREATE INDEX IF NOT EXISTS` idempotent pattern already in the file:

```sql
CREATE INDEX IF NOT EXISTS idx_memory_detail_recency
    ON semantic_memory(last_accessed_at DESC)
    WHERE tier = 'detail' AND deleted = 0;
```

The index is declared inside the same `db.exec(...)` migration block that owns the other `semantic_memory` indexes. It is additive and idempotent — running an existing database against the updated schema is a no-op when the index already exists, and a single `CREATE INDEX` statement when it does not.

**Step 1: Add the statement to the schema migration block.**

**Step 2: Verify operationally**

Run: `bun test packages/core/src/__tests__/schema.test.ts`

Expected: passes. The schema test exercises the migration path and asserts no errors on `db.exec(...)`.

Run: `bun run typecheck`

Expected: clean (no TypeScript errors).

**Step 3: Commit**

```bash
git add packages/core/src/schema.ts
git commit -m "feat(core): add idx_memory_detail_recency partial index for R-VC4"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Verify the new index is used by the R-VC4 SELECT

**Type:** Infrastructure verification.

**Verifies:** None (defensive check that Task 1 produced a usable index).

**Files:**
- Modify: `packages/core/src/__tests__/schema.test.ts` — add one test confirming `EXPLAIN QUERY PLAN` for the R-VC4 SELECT shape uses `idx_memory_detail_recency`.

**Implementation:**

Add a test in `schema.test.ts` (next to existing index tests) that:
1. Creates a database via the existing pattern (`randomBytes(4).toString("hex")` temp path, `applySchema(db)`).
2. Runs `db.prepare("EXPLAIN QUERY PLAN SELECT key, last_accessed_at FROM semantic_memory WHERE tier = 'detail' AND deleted IS NOT 1 ORDER BY last_accessed_at DESC").all()`.
3. Asserts the plan output contains the substring `idx_memory_detail_recency`. The exact `detail` row format from `EXPLAIN QUERY PLAN` is SQLite-implementation-defined, but the index name appears in the row when SQLite chooses it.

This catches a future schema regression where the index gets dropped or its `WHERE` clause drifts away from the SELECT's predicate.

**Step 1: Write the test.**

**Step 2: Verify operationally**

Run: `bun test packages/core/src/__tests__/schema.test.ts`

Expected: the new test passes.

**Step 3: Commit**

```bash
git add packages/core/src/__tests__/schema.test.ts
git commit -m "test(core): assert idx_memory_detail_recency used by R-VC4 SELECT"
```
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Implement `loadDetailEntries()` retrieval stage

**Type:** Functionality.

**Verifies:** volatile-context.R-VC4 (data-layer half — the SELECT itself; the rendering half lands in Phase 3).

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts` — add a new exported function `loadDetailEntries(db: Database): DetailRetrievalResult`.

**Implementation:**

This is the new sibling retrieval stage R-VC4 mandates — independent of R-HM6's `loadPinnedEntries` / `loadSummaryEntries` / `loadGraphEntries` / `loadRecencyEntries` slot accounting. It enumerates every non-deleted detail-tier entry in `last_accessed_at DESC` order. The query is intentionally unbounded: R-VC15's three-tier compression (Phase 3) bounds the rendered output, not the underlying retrieval.

Define the result type alongside the existing `StageEntry` / `StageResult` types (verified at `summary-extraction.ts:510`):

```typescript
export interface DetailEntry {
    key: string;
    last_accessed_at: string | null;
}

export interface DetailRetrievalResult {
    entries: DetailEntry[];
}
```

Implement the function next to the existing loaders (anchor: `loadRecencyEntries` ends around line 1051):

```typescript
export function loadDetailEntries(db: Database): DetailRetrievalResult {
    const rows = db
        .prepare(
            "SELECT key, last_accessed_at FROM semantic_memory WHERE tier = 'detail' AND deleted IS NOT 1 ORDER BY last_accessed_at DESC",
        )
        .all() as Array<{ key: string; last_accessed_at: string | null }>;

    return { entries: rows.map((r) => ({ key: r.key, last_accessed_at: r.last_accessed_at })) };
}
```

Notes:

- The SELECT projects `key` and `last_accessed_at` only — the value body is never fetched here, consistent with R-VC20 ("The Discoverable Archive section shall not render value bodies").
- The function returns a plain shape (not `StageResult`) because R-VC4 is explicit that this stage bypasses R-HM6's slot accounting and tag dispatch (§6.4: "R-VC4 sibling-stage entries route to the Discoverable Archive renderer (title-only)" — no `tag` field is needed).
- `last_accessed_at` is nullable in the schema (verified). Callers in Phase 3 must handle null with a `"never accessed"` or equivalent fragment.
- R-MV5 (delta reads must not update `last_accessed_at`) is preserved trivially: this is a pure SELECT.

Re-export the new function from any package barrel (`packages/agent/src/index.ts`) only if other functions in `summary-extraction.ts` are already re-exported there; otherwise leave un-re-exported (matches existing convention for retrieval helpers).

**Step 1: Add the type definitions.**

**Step 2: Add the `loadDetailEntries` function.**

**Step 3: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 4: Commit**

```bash
git add packages/agent/src/summary-extraction.ts
git commit -m "feat(agent): add loadDetailEntries retrieval stage for R-VC4"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Test `loadDetailEntries()`

**Type:** Functionality.

**Verifies:** volatile-context.R-VC4 (data-layer half).

**Files:**
- Create: `packages/agent/src/__tests__/load-detail-entries.test.ts`

**Implementation:**

Tests must verify the SELECT's behavior, not the wiring. Write the test against a real temp `bun:sqlite` database, following the project pattern (`randomBytes(4).toString("hex")` temp path, `applySchema(db)`, `cleanupTmpDir()` from `packages/shared/src/test-utils.ts`).

Tests must cover the following cases (one `it()` block each):

1. **Empty table → empty result.** A fresh schema-applied database has zero rows; `loadDetailEntries(db).entries` is `[]`.

2. **Tier filtering.** Insert one row each for `tier IN ('pinned', 'summary', 'detail', 'default')` via `insertRow` (per outbox invariant #1; never raw SQL on synced tables). Result contains exactly the `detail` row.

3. **Deleted filtering.** Insert two `tier='detail'` rows; soft-delete one via `softDelete` from `@bound/core`. Result contains only the surviving row.

4. **Ordering by `last_accessed_at DESC`.** Insert three `tier='detail'` rows with distinct `last_accessed_at` timestamps. Result is sorted by `last_accessed_at` descending.

5. **Null `last_accessed_at` is preserved on the result entry.** Insert one `tier='detail'` row with `last_accessed_at = NULL`. The returned `DetailEntry.last_accessed_at` is `null` (not undefined, not the empty string). SQLite places NULL last in DESC order by default; the test should assert the row is returned in the result regardless of relative position.

6. **No `last_accessed_at` mutation (R-MV5).** Capture the `last_accessed_at` value of an inserted row before calling `loadDetailEntries`. Re-read the row after the call. The value must be unchanged.

Insert helper to share across cases:

```typescript
function insertMemory(
    db: Database,
    siteId: string,
    key: string,
    tier: "pinned" | "summary" | "detail" | "default",
    lastAccessedAt: string | null,
) {
    insertRow(db, "semantic_memory", {
        id: deterministicUUID(BOUND_NAMESPACE, key),
        key,
        value: `body of ${key}`,
        tier,
        source: "test",
        last_accessed_at: lastAccessedAt,
        // ... other required columns per schema
    }, siteId);
}
```

The exact column set for `semantic_memory` is verified by codebase-investigator findings — `key, value, tier, source, last_accessed_at, modified_at, deleted, id` are the relevant columns. The task implementor should look up the full insert shape from `packages/core/src/schema.ts` at execution time.

**Step 1: Write the failing tests.**

**Step 2: Verify they fail**

Run: `bun test packages/agent/src/__tests__/load-detail-entries.test.ts`

Expected: tests fail because `loadDetailEntries` is the new function under test — but Task 3 already landed it. All tests should pass on first run unless a behavior bug exists.

**Step 3: Verify they pass**

Run: `bun test packages/agent/src/__tests__/load-detail-entries.test.ts`

Expected: 6 tests pass.

**Step 4: Commit**

```bash
git add packages/agent/src/__tests__/load-detail-entries.test.ts
git commit -m "test(agent): cover loadDetailEntries (R-VC4 retrieval stage)"
```
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Normalize `loadGraphEntries` tag emission to `[graph]`

**Type:** Functionality.

**Verifies:** volatile-context.R-HM8-norm.

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts:959` — replace the conditional tag string with the literal `"[graph]"`.

**Implementation:**

Codebase-investigator confirmed line 959 currently emits one of two tag shapes depending on whether the entry was a graph seed or a graph descendant:

- `"[seed]"` for the seed entries
- `` `[depth ${depth}, ${r.viaRelation}]` `` (e.g. `[depth 2, informs]`) for graph descendants

§6.1 R-HM8 (verified literal in spec) directs that this collapse to a single `"[graph]"` value at the loader boundary. The seed/depth/relation provenance remains retrievable from `memory_edges` if a future caller needs it; the visible tag string is dropped because section assignment (Phase 5 wiring) carries the routing role.

The change is a one-line string replacement. No behavior depends on the old tag values inside `loadGraphEntries` itself; the only consumer of the tag is the rendering layer (replaced by Phases 2–5). To keep the change forward-compatible, the implementation should:

1. Replace the old expression at line 959 with the literal string `"[graph]"`.
2. If the surrounding code computes `depth` or `r.viaRelation` solely to build that tag, leave the surrounding code unchanged — those locals may also feed the returned `StageEntry` (verify via Read of the surrounding 30-line window before editing). Do not delete data unless it is unambiguously dead.

**Step 1: Read the 30-line window around line 959 to confirm scope.**

**Step 2: Replace the tag expression.**

**Step 3: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 4: Commit**

```bash
git add packages/agent/src/summary-extraction.ts
git commit -m "refactor(agent): normalize loadGraphEntries tag emission to [graph]"
```
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Test the graph-tag normalization

**Type:** Functionality.

**Verifies:** volatile-context.R-HM8-norm.

**Files:**
- Modify or create: `packages/agent/src/__tests__/load-graph-entries.test.ts` (create if not present; if an equivalent test file already exists, augment it).

**Implementation:**

Two test cases:

1. **Seed entry tag.** Construct a fixture with one summary entry that has at least one outgoing graph edge. Call `loadGraphEntries` with the seed key in the keyword set. Assert that the seed entry's `tag` field is exactly `"[graph]"`.

2. **Graph descendant tag.** Same fixture, but assert the descendant entry's `tag` field is exactly `"[graph]"` — not `"[depth 1, informs]"` or any depth-keyed string.

Use the same temp-DB pattern as Task 4. The test must construct enough memory + edge data to exercise both the seed and the graph-descent code paths inside `loadGraphEntries`.

**Step 1: Write the failing tests.**

**Step 2: Verify they pass after Task 5**

Run: `bun test packages/agent/src/__tests__/load-graph-entries.test.ts`

Expected: 2 tests pass.

**Step 3: Commit**

```bash
git add packages/agent/src/__tests__/load-graph-entries.test.ts
git commit -m "test(agent): cover graph-tag normalization to [graph]"
```
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_C -->

---

## Phase 1 Done When

- All six tasks committed.
- `bun test packages/core packages/agent` passes.
- `bun run typecheck` passes.
- `idx_memory_detail_recency` exists in fresh-schema databases and is used by `EXPLAIN QUERY PLAN` for the R-VC4 SELECT shape.
- `loadDetailEntries(db)` returns the expected shape under all six tested cases.
- `loadGraphEntries` tag emission is exclusively `"[graph]"`.

No rendering callers consume the new function or normalized tag yet; Phase 5 wires them.
