# Volatile Context Tiered Fidelity — Phase 3: Discoverable Archive Renderer

**Goal:** Implement `renderDiscoverableArchive()` — the title-only catalog of detail-tier entries with three-tier compression (flat / clustered / heading-only) gated on entry count via the tunables `BOUND_VC15_N` (default 1000) and `BOUND_VC15_M` (default 20).

**Architecture:** Pure-function renderer that takes the R-VC4 retrieval output (Phase 1's `loadDetailEntries`), a parent-summary lookup map (built by Phase 5 wiring from `memory_edges` `summarizes` edges), a stale-children-key set (for dedup against Working Knowledge), a budget-pressure flag, and the resolved tunables. Returns a structured `RenderedSection` plus an optional synthesis-backlog signal that Phase 4 / Phase 5 fold into Live State.

**Tech Stack:** TypeScript. No new dependencies; relative-time formatting is a small local helper unless an existing util is discovered in Phase 3B's earlier investigation.

**Scope:** 3 of 7 phases.

**Codebase verified:** 2026-05-22 against commit `36dc9f2e`. R-VC4 retrieval (`loadDetailEntries`) is shipped in Phase 1. Existing `summarizes`-edge query patterns live in `loadSummaryEntries` (`summary-extraction.ts:855` neighborhood); Phase 5 will reuse them to build the parent-summary lookup map.

---

## Acceptance Criteria Coverage

This phase implements:

### volatile-context.R-VC2 (Discoverable Archive header)

- **R-VC2 (literal, Discoverable Archive portion):** "`## Discoverable Archive — title-only; bodies via memory search`".

### volatile-context.R-VC4 (rendering half)

- **R-VC4 (literal, rendering portion):** "Each entry shall render as title-only — the `key` and a single trailing context fragment naming relative time of last access, with no value body. Bodies are accessed via `memory search` or `query`. Visibility under volume is governed by R-VC15's three-tier compression."

### volatile-context.R-VC6 (Discoverable Archive footer)

- **R-VC6 (literal, Discoverable Archive portion):** "Discoverable Archive's footer reads: `Bodies are accessed via memory search or query against semantic_memory.`."

### volatile-context.R-VC14 (budget-pressure path — Discoverable Archive half)

- **R-VC14 (literal, Discoverable Archive half):** "While the context budget (§13.1 Stage 7) is critically constrained, the rendering layer shall apply tier-aware shedding without violating the presence invariant: … Discoverable Archive entries continue to render as titles but their per-entry context fragment is dropped … This requirement governs presentation when the upstream output exceeds budget."

### volatile-context.R-VC15 (three-tier compression)

- **R-VC15 (literal):** "The Discoverable Archive renders entries under a three-tier compression scheme based on entry count. Tunables: `BOUND_VC15_N` (default 1000), `BOUND_VC15_M` (default 20)."
- **Tier 1 (literal):** "**Tier 1 (≤200 entries):** flat title list, sorted by `last_accessed_at DESC`. No cluster headings."
- **Tier 2 (literal):** "**Tier 2 (>200, ≤N entries):** cluster compression. Each cluster renders under `### <cluster_name> (<count> entries)` with all entry titles listed beneath, sorted by `last_accessed_at DESC` within cluster. Clusters sorted by entry count descending, ties broken by cluster name ascending. Cluster names are derived from `summarizes` edges: an entry whose parent summary is `_summary:<topic>` belongs to the `<topic>` cluster. Entries without a parent summary render under `### Uncategorized (<count> entries)`."
- **Tier 3 (literal):** "**Tier 3 (>N entries):** cluster heading-only compression. Each cluster renders under `### <cluster_name> (<total_count> entries, showing M most recent)` with the M most recent entry titles (by `last_accessed_at DESC`) listed beneath. The long tail is not rendered. Discoverability for unrendered entries depends on R-VC9b sub-topic vocabulary in the parent summary's gloss in Working Knowledge."
- **R-VC15 trailing rule (literal):** "When Tier 3 is active, the `Uncategorized` cluster surfaces a `[synthesis-backlog] {N} uncategorized detail entries` line in Live State if N exceeds 50 … The `[synthesis-backlog]` label distinguishes this synthetic line from `[advisory]` entries, which are backed by rows in the `advisories` table."

### volatile-context.R-VC20 (no value bodies)

- **R-VC20 (literal):** "The Discoverable Archive section shall not render value bodies (truncated or otherwise) for any entry. Title-only is the contract; body access is via `memory search` or `query`."

### volatile-context.R-VC21 (no title omission under budget)

- **R-VC21 (literal):** "The rendering layer shall not omit a memory entry's title from the volatile context based on budget pressure. Titles render at all budget levels; only fidelity (gloss vs. title-only vs. context fragment) varies. This preserves the presence invariant from §1.5."

### volatile-context.R-VC22 (sub-cluster typography exemption)

- **R-VC22 (literal, Discoverable Archive half):** "Sub-cluster headings inside Discoverable Archive (R-VC15) are deeper-level headings (`###`) and are not subject to this rule."

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Define `renderDiscoverableArchive` types, tunables, and signature

**Type:** Functionality (type-only scaffold + tunable resolution).

**Verifies:** None directly.

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts` — add types, tunable resolution helper, and stub function alongside the Phase 2 additions.

**Implementation:**

```typescript
export interface DiscoverableArchiveInput {
    /** From loadDetailEntries — already sorted by last_accessed_at DESC. */
    entries: DetailEntry[];
    /**
     * Map from a detail-tier entry key to its parent summary key (e.g.
     * "_summary:transit-systems"). Built by Phase 5 wiring from memory_edges
     * 'summarizes' edges. Entries without a parent are absent from the map.
     */
    parentSummaryByKey: Map<string, string>;
    /**
     * Set of detail-tier keys already routed to Working Knowledge as R-HM7
     * stale children. These are dropped from Discoverable Archive output to
     * prevent duplicate rendering (§6.4 dedup rule).
     */
    staleChildKeysInWorkingKnowledge: Set<string>;
    /** True when the upstream budget gate (R-VC14) signals critical pressure. */
    budgetPressure: boolean;
    /** Wall-clock anchor for relative-time formatting. Pass Date.now() at assembly time. */
    nowMs: number;
    /** Resolved at assembly time from BOUND_VC15_N / BOUND_VC15_M (see resolveVc15Tunables). */
    tunables: Vc15Tunables;
}

export interface Vc15Tunables {
    /** BOUND_VC15_N — Tier 2/3 boundary. Default 1000. */
    n: number;
    /** BOUND_VC15_M — Tier 3 per-cluster cap. Default 20. */
    m: number;
}

export const VC15_DEFAULT_N = 1000;
export const VC15_DEFAULT_M = 20;
export const VC15_TIER1_THRESHOLD = 200;
export const VC15_UNCATEGORIZED_BACKLOG_THRESHOLD = 50;
export const UNCATEGORIZED_CLUSTER_NAME = "Uncategorized";

export function resolveVc15Tunables(env: NodeJS.ProcessEnv = process.env): Vc15Tunables {
    const n = parsePositiveInt(env.BOUND_VC15_N, VC15_DEFAULT_N);
    const m = parsePositiveInt(env.BOUND_VC15_M, VC15_DEFAULT_M);
    return { n, m };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

export interface DiscoverableArchiveOutput {
    section: RenderedSection;
    /**
     * When Tier 3 is active and the Uncategorized cluster exceeds the backlog
     * threshold, this carries the count for Phase 4 / Phase 5 to fold into
     * Live State as `- [synthesis-backlog] {N} uncategorized detail entries`.
     * `null` otherwise.
     */
    synthesisBacklogCount: number | null;
}

export function renderDiscoverableArchive(
    input: DiscoverableArchiveInput,
): DiscoverableArchiveOutput {
    return { section: { lines: [] }, synthesisBacklogCount: null };
}
```

Notes:

- The 200-entry Tier-1/Tier-2 boundary is fixed in the spec ("≤200 entries"); only the Tier-2/Tier-3 boundary (`N`) and the Tier-3 per-cluster cap (`M`) are tunable. Encoded as a const, not an env var.
- `parsePositiveInt` rejects non-numeric, zero, and negative values — defensive against operator typos. Test fixtures override via env to exercise tier transitions.
- The synthesis-backlog signal is returned alongside the section, not pushed into the section, because the spec routes that line into Live State, not Discoverable Archive (§5.3 subsystem 5).
- `nowMs` is passed in (rather than read inside) so tests can control relative-time output deterministically.

**Step 1: Add the type definitions, the constants, the `resolveVc15Tunables` helper, and the stub function.**

**Step 2: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 3: Commit**

```bash
git add packages/agent/src/summary-extraction.ts
git commit -m "feat(agent): scaffold renderDiscoverableArchive types and tunables"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Test `resolveVc15Tunables`

**Type:** Functionality.

**Verifies:** Tunable parsing for R-VC15 (foundation for tier-transition tests in Tasks 4–8).

**Files:**
- Create: `packages/agent/src/__tests__/resolve-vc15-tunables.test.ts`

**Implementation:**

Tests:

1. Empty env → defaults `{ n: 1000, m: 20 }`.
2. `BOUND_VC15_N=300` → `n: 300`. Default `m`.
3. `BOUND_VC15_M=5` → `m: 5`. Default `n`.
4. Non-numeric value → fallback to default with no throw. Verifies operator-typo defense.
5. Zero or negative → fallback to default. Verifies positive-only invariant.

Use plain `Record<string, string>` for env input — no `process.env` mutation.

**Step 1: Write the tests.**

**Step 2: Verify they pass**

Run: `bun test packages/agent/src/__tests__/resolve-vc15-tunables.test.ts`

Expected: 5 tests pass.

**Step 3: Commit**

```bash
git add packages/agent/src/__tests__/resolve-vc15-tunables.test.ts
git commit -m "test(agent): cover resolveVc15Tunables parsing edge cases"
```
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-5) -->

<!-- START_TASK_3 -->
### Task 3: Implement Tier 1 (flat list)

**Type:** Functionality.

**Verifies:** volatile-context.R-VC2, R-VC4 (rendering half), R-VC6, R-VC15 Tier 1, R-VC20.

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts` — replace the stub with Tier-1 logic. Tier 2 and Tier 3 land in Tasks 5 and 7.

**Implementation:**

```typescript
const DISCOVERABLE_HEADER = "## Discoverable Archive — title-only; bodies via memory search";
const DISCOVERABLE_FOOTER = "Bodies are accessed via memory search or query against semantic_memory.";

export function renderDiscoverableArchive(
    input: DiscoverableArchiveInput,
): DiscoverableArchiveOutput {
    const lines: string[] = [];
    lines.push(DISCOVERABLE_HEADER);
    lines.push("");

    // §5.2 step 2 — drop entries also rendered as stale children in Working Knowledge.
    const visible = input.entries.filter(
        (e) => !input.staleChildKeysInWorkingKnowledge.has(e.key),
    );

    const total = visible.length;

    if (total === 0) {
        lines.push("");
        lines.push(DISCOVERABLE_FOOTER);
        return { section: { lines }, synthesisBacklogCount: null };
    }

    if (total <= VC15_TIER1_THRESHOLD) {
        // Tier 1: flat list, last_accessed_at DESC (already sorted upstream by R-VC4 SELECT).
        for (const entry of visible) {
            lines.push(formatDetailLine(entry, input.budgetPressure, input.nowMs));
        }
        lines.push("");
        lines.push(DISCOVERABLE_FOOTER);
        return { section: { lines }, synthesisBacklogCount: null };
    }

    // Tier 2 and Tier 3 land in subsequent tasks.
    throw new Error("renderDiscoverableArchive: Tier 2/3 not yet implemented");
}

function formatDetailLine(entry: DetailEntry, budgetPressure: boolean, nowMs: number): string {
    if (budgetPressure) {
        return `- ${entry.key}`;
    }
    const fragment = relativeTimeFragment(entry.last_accessed_at, nowMs);
    return `- ${entry.key} (last accessed ${fragment})`;
}

function relativeTimeFragment(iso: string | null, nowMs: number): string {
    if (!iso) return "never";
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return "never";
    const deltaMs = nowMs - ts;
    if (deltaMs < 60_000) return "just now";
    const minutes = Math.floor(deltaMs / 60_000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(months / 12);
    return `${years}y ago`;
}
```

Notes:

- `relativeTimeFragment` is a small local helper. Before adding it, search the codebase (`packages/shared`, `packages/agent`) for an existing relative-time formatter. If one exists, reuse it. The investigator did not find one in the verification pass.
- `formatDetailLine` is the single seam where R-VC14 budget-pressure shedding applies (`(last accessed …)` fragment dropped). R-VC21 is preserved structurally: the title line is always rendered.
- The dedup against `staleChildKeysInWorkingKnowledge` runs first so the count check (`total <= 200`) reflects the rendered-not-redundant set, not the raw retrieval count. This matters because a corpus heavy in stale-child overlap could otherwise straddle a tier boundary on an entry that won't render.
- The thrown error in the Tier 2/3 branch is intentional: it ensures Tasks 4–7 must land before any caller can hit Tier 2/3. Phase 5 wiring will not be exercised against Tier 2/3 corpora until Task 7 ships.

**Step 1: Implement Tier 1 plus the formatting helpers.**

**Step 2: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 3: Commit**

```bash
git add packages/agent/src/summary-extraction.ts
git commit -m "feat(agent): renderDiscoverableArchive Tier 1 (flat list)"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Test Tier 1 + relative-time helper + dedup

**Type:** Functionality.

**Verifies:** volatile-context.R-VC2, R-VC4 (rendering), R-VC6, R-VC15 Tier 1, R-VC20.

**Files:**
- Create: `packages/agent/src/__tests__/render-discoverable-archive.test.ts`

**Implementation:**

Tests for Tier 1 only (Tier 2 and Tier 3 land in Tasks 6 and 8 respectively to keep test files growing in step with implementation).

1. **Empty input.** No entries, no stale-child overlap. Output is `[header, "", "", footer]`.

2. **Single entry, no budget pressure.** One detail entry, `last_accessed_at` = nowMs - 90 minutes. Output line: `- {key} (last accessed 1h ago)`.

3. **Single entry with null `last_accessed_at`.** Output fragment: `(last accessed never)`.

4. **Sorting preserved.** Three entries already sorted DESC by `last_accessed_at` (matches R-VC4 SELECT shape). Output preserves order.

5. **Budget-pressure mode drops the context fragment but preserves the title.** Same input as case 2 with `budgetPressure: true`. Output is `- {key}` (no parenthetical fragment). Verifies R-VC14 + R-VC21.

6. **Stale-child dedup.** Three entries; one of their keys is in `staleChildKeysInWorkingKnowledge`. Output omits that entry. Verifies §6.4 dedup.

7. **At threshold (200 entries).** 200 entries; output is Tier 1 (flat list). Verifies the boundary.

8. **R-VC20: no value bodies.** Construct a fixture and assert the output contains no occurrence of `entry.value`-shaped content (the renderer never receives `value` — verified by type, but the test pins this contract by asserting against substrings unique to the fictional value body).

9. **`synthesisBacklogCount` is `null` in Tier 1.** Tier 1 never raises the synthesis-backlog signal. Verifies the signal is gated to Tier 3.

10. **Header and footer literals.** Assert the exact header and footer strings, including em-dash and capitalization.

**Step 1: Write the failing tests.**

**Step 2: Verify they pass**

Run: `bun test packages/agent/src/__tests__/render-discoverable-archive.test.ts`

Expected: 10 tests pass.

**Step 3: Commit**

```bash
git add packages/agent/src/__tests__/render-discoverable-archive.test.ts
git commit -m "test(agent): cover renderDiscoverableArchive Tier 1 + dedup"
```
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Implement Tier 2 (cluster grouping)

**Type:** Functionality.

**Verifies:** volatile-context.R-VC15 Tier 2, R-VC22 (sub-cluster `###` typography).

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts` — replace the Tier 2 throw with the implementation.

**Implementation:**

Replace the `throw new Error("renderDiscoverableArchive: Tier 2/3 not yet implemented")` branch with a Tier-2 implementation:

```typescript
if (total <= input.tunables.n) {
    // Tier 2: cluster compression.
    const clusters = groupByCluster(visible, input.parentSummaryByKey);
    const sorted = sortClusters(clusters);
    for (const cluster of sorted) {
        lines.push(`### ${cluster.name} (${cluster.entries.length} entries)`);
        for (const entry of cluster.entries) {
            lines.push(formatDetailLine(entry, input.budgetPressure, input.nowMs));
        }
        lines.push(""); // blank line between clusters for readability
    }
    // Drop trailing blank if any cluster was rendered.
    if (lines[lines.length - 1] === "") lines.pop();
    lines.push("");
    lines.push(DISCOVERABLE_FOOTER);
    return { section: { lines }, synthesisBacklogCount: null };
}

// Tier 3 lands in Task 7.
throw new Error("renderDiscoverableArchive: Tier 3 not yet implemented");
```

Helpers:

```typescript
interface Cluster {
    name: string;
    entries: DetailEntry[];
}

function clusterNameForEntry(
    entry: DetailEntry,
    parentSummaryByKey: Map<string, string>,
): string {
    const parent = parentSummaryByKey.get(entry.key);
    if (!parent) return UNCATEGORIZED_CLUSTER_NAME;
    // Parent key shape is "_summary:<topic>" per R-HM1 / R-HM3. Strip the prefix.
    const colonIdx = parent.indexOf(":");
    if (colonIdx < 0) return UNCATEGORIZED_CLUSTER_NAME; // defensive
    return parent.slice(colonIdx + 1) || UNCATEGORIZED_CLUSTER_NAME;
}

function groupByCluster(
    entries: DetailEntry[],
    parentSummaryByKey: Map<string, string>,
): Cluster[] {
    const map = new Map<string, DetailEntry[]>();
    for (const entry of entries) {
        const name = clusterNameForEntry(entry, parentSummaryByKey);
        const bucket = map.get(name) ?? [];
        bucket.push(entry);
        map.set(name, bucket);
    }
    // Within-cluster ordering is preserved from `entries`, which is already
    // last_accessed_at DESC from the R-VC4 SELECT. R-VC15 Tier 2 step (d).
    return Array.from(map.entries()).map(([name, entries]) => ({ name, entries }));
}

function sortClusters(clusters: Cluster[]): Cluster[] {
    return clusters.slice().sort((a, b) => {
        // Primary: entry count descending.
        if (a.entries.length !== b.entries.length) {
            return b.entries.length - a.entries.length;
        }
        // Tiebreak: cluster name ascending.
        return a.name.localeCompare(b.name);
    });
}
```

Notes:

- The "_summary:<topic>" prefix-strip is the spec's literal mapping (§5.2 Tier 2 step a). Any parent whose key shape is unexpected falls through to `Uncategorized` defensively.
- Within-cluster ordering: `groupByCluster` preserves input order, which is already `last_accessed_at DESC` from R-VC4. No re-sort needed inside clusters.
- The blank-line-between-clusters formatting choice matches the `§4.2` example's visual block structure. The trailing-blank-pop avoids a double blank before the footer.

**Step 1: Add the helpers and the Tier 2 branch.**

**Step 2: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 3: Commit**

```bash
git add packages/agent/src/summary-extraction.ts
git commit -m "feat(agent): renderDiscoverableArchive Tier 2 (cluster compression)"
```
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 6-7) -->

<!-- START_TASK_6 -->
### Task 6: Test Tier 2

**Type:** Functionality.

**Verifies:** volatile-context.R-VC15 Tier 2, R-VC22.

**Files:**
- Modify: `packages/agent/src/__tests__/render-discoverable-archive.test.ts` — add Tier 2 cases.

**Implementation:**

Tests:

1. **Just over threshold (201 entries) → Tier 2.** 201 entries, parent-summary map empty. Output uses `### Uncategorized (201 entries)` heading. Verifies the boundary.

2. **Cluster grouping by topic.** 250 entries split across two parents (`_summary:cooking`, `_summary:transit`). Output has `### cooking (count)` and `### transit (count)` headings. Verifies §5.2 Tier 2 step (a).

3. **Uncategorized routing.** 250 entries, half mapped to `_summary:cooking`, half with no parent. Output has both `### cooking (...)` and `### Uncategorized (...)` headings. Verifies §5.2 Tier 2 step (b).

4. **Cluster ordering — count desc, name asc tiebreak.** Three clusters with sizes 100/100/50. Sorted output has the two 100-count clusters first (alphabetical), then the 50-count. Verifies §5.2 Tier 2 step (c).

5. **Within-cluster ordering by `last_accessed_at` DESC.** Within one cluster, entries appear in the input order (already sorted upstream). Verifies §5.2 Tier 2 step (d).

6. **Sub-cluster `###` typography.** Assert each sub-cluster header begins with `### `, not `## ` or `#### `. Verifies R-VC22 sub-cluster exemption.

7. **At BOUND_VC15_N boundary.** Use `tunables: { n: 250, m: 20 }` and 250 entries → Tier 2. Then 251 entries → Tier 3 (this case is structural pre-check; the assertion against Tier 3's specific output lands in Task 8).

8. **Budget-pressure mode preserves cluster sub-headers and titles, drops only the per-entry context fragment.** Verifies R-VC14 within Tier 2.

9. **`synthesisBacklogCount` is `null` in Tier 2.** Even when Uncategorized exceeds 50, Tier 2 does not raise the signal — the spec gates it to Tier 3 only.

**Step 1: Write the tests.**

**Step 2: Verify they pass**

Run: `bun test packages/agent/src/__tests__/render-discoverable-archive.test.ts`

Expected: previous 10 + 9 new = 19 tests pass.

**Step 3: Commit**

```bash
git add packages/agent/src/__tests__/render-discoverable-archive.test.ts
git commit -m "test(agent): cover renderDiscoverableArchive Tier 2"
```
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Implement Tier 3 (heading-only with M-most-recent + synthesis-backlog signal)

**Type:** Functionality.

**Verifies:** volatile-context.R-VC15 Tier 3, R-VC15 trailing rule (synthesis-backlog signal).

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts` — replace the Tier 3 throw with the implementation.

**Implementation:**

Replace the final `throw new Error("renderDiscoverableArchive: Tier 3 not yet implemented")` with:

```typescript
// Tier 3: heading-only compression with M most-recent per cluster.
const clusters = groupByCluster(visible, input.parentSummaryByKey);
const sorted = sortClusters(clusters);
let synthesisBacklogCount: number | null = null;
for (const cluster of sorted) {
    const totalCount = cluster.entries.length;
    const tail = cluster.entries.slice(0, input.tunables.m);
    lines.push(
        `### ${cluster.name} (${totalCount} entries, showing ${input.tunables.m} most recent)`,
    );
    for (const entry of tail) {
        lines.push(formatDetailLine(entry, input.budgetPressure, input.nowMs));
    }
    lines.push("");
    if (
        cluster.name === UNCATEGORIZED_CLUSTER_NAME &&
        totalCount > VC15_UNCATEGORIZED_BACKLOG_THRESHOLD
    ) {
        synthesisBacklogCount = totalCount;
    }
}
if (lines[lines.length - 1] === "") lines.pop();
lines.push("");
lines.push(DISCOVERABLE_FOOTER);
return { section: { lines }, synthesisBacklogCount };
```

Notes:

- `cluster.entries.slice(0, m)` works because `groupByCluster` preserves the input's `last_accessed_at DESC` order.
- The synthesis-backlog signal is gated on Tier 3 + `Uncategorized` cluster + `count > 50`. Phase 4's Live State renderer consumes the count to emit `- [synthesis-backlog] {N} uncategorized detail entries`.
- The header literal `"showing M most recent"` interpolates `input.tunables.m` directly. Test fixtures override M to small values for deterministic expected output.

**Step 1: Replace the Tier 3 throw with the full implementation.**

**Step 2: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 3: Commit**

```bash
git add packages/agent/src/summary-extraction.ts
git commit -m "feat(agent): renderDiscoverableArchive Tier 3 + synthesis-backlog signal"
```
<!-- END_TASK_7 -->

<!-- END_SUBCOMPONENT_C -->

<!-- START_SUBCOMPONENT_D (task 8) -->

<!-- START_TASK_8 -->
### Task 8: Test Tier 3 + synthesis-backlog signal

**Type:** Functionality.

**Verifies:** volatile-context.R-VC15 Tier 3, R-VC15 trailing rule, R-VC21 (no title omission per cluster).

**Files:**
- Modify: `packages/agent/src/__tests__/render-discoverable-archive.test.ts` — add Tier 3 cases.

**Implementation:**

Tests:

1. **Just over BOUND_VC15_N (1001 entries by default; use a smaller `tunables.n=10`, 11 entries → Tier 3).** Heading uses the `entries, showing M most recent` format. Verifies §5.2 Tier 3 step (c).

2. **M-cap respected.** `tunables.m=3`. Each cluster renders only its 3 most-recent entries. Long tail not rendered. Verifies §5.2 Tier 3 step (b).

3. **Header includes total count and M.** With `tunables.m=5` and a cluster of 100 entries, the heading is `### foo (100 entries, showing 5 most recent)`.

4. **Within-cluster ordering by `last_accessed_at` DESC.** Confirms `slice(0, m)` takes the most-recent entries (input is sorted DESC).

5. **`synthesisBacklogCount` raised when Uncategorized > 50.** Tier 3 + Uncategorized cluster of 60 entries → `synthesisBacklogCount = 60`.

6. **`synthesisBacklogCount` not raised when Uncategorized ≤ 50.** Tier 3 + Uncategorized cluster of 30 entries → `synthesisBacklogCount = null`.

7. **`synthesisBacklogCount` not raised when there is no Uncategorized cluster (all entries have parents).** Tier 3 with 0 uncategorized → `synthesisBacklogCount = null`.

8. **Budget-pressure mode preserves cluster sub-headers and per-cluster M-cap; drops only the per-entry context fragment.**

9. **R-VC21 — every rendered entry's title is present.** Across all clusters, every `entry.key` from the M-tail appears verbatim in the output lines. Verifies the presence invariant for rendered entries.

**Step 1: Write the tests.**

**Step 2: Verify they pass**

Run: `bun test packages/agent/src/__tests__/render-discoverable-archive.test.ts`

Expected: 19 + 9 = 28 tests pass.

**Step 3: Commit**

```bash
git add packages/agent/src/__tests__/render-discoverable-archive.test.ts
git commit -m "test(agent): cover renderDiscoverableArchive Tier 3 + synthesis-backlog"
```
<!-- END_TASK_8 -->

<!-- END_SUBCOMPONENT_D -->

---

## Phase 3 Done When

- All eight tasks committed.
- `bun test packages/agent/src/__tests__/render-discoverable-archive.test.ts` passes 28 tests.
- `bun test packages/agent/src/__tests__/resolve-vc15-tunables.test.ts` passes 5 tests.
- `bun run typecheck` passes.
- `renderDiscoverableArchive` is exported but not yet wired into `buildVolatileContext`. Phase 5 will compose the parent-summary lookup, the stale-child key set, the budget-pressure flag, and call into it.
- The Tier 3 → synthesis-backlog signal is computed but not yet routed to Live State; Phase 4 (Live State renderer) accepts it via the Live State input contract.
