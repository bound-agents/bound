# Volatile Context Tiered Fidelity — Phase 2: Working Knowledge Renderer

**Goal:** Implement `renderWorkingKnowledge()` — the helper that produces the first of the three new top-level sections, containing pinned standing rules at full fidelity, summary entries with a 200-character gloss, R-HM7 stale children indented beneath their parent summary, and R-MV1 deltas flagged in-place.

**Architecture:** A pure function that takes the existing `loadPinnedEntries` / `loadSummaryEntries` / R-HM7 stale-child outputs plus a delta-key set and a memory-edges accessor, and returns the rendered Working Knowledge section as a string array. No I/O beyond what the caller passes in. The function is exported but not yet wired into `buildVolatileContext`; Phase 5 does the wiring.

**Tech Stack:** TypeScript, `bun:sqlite` (only for the `summarizes`-edge lookups invoked from inside the renderer).

**Scope:** 2 of 7 phases.

**Codebase verified:** 2026-05-22 against commit `36dc9f2e`. Confirmed: `loadPinnedEntries` at `summary-extraction.ts:747`, `loadSummaryEntries` at `:800` (tag `[summary]` at `:837`), `formatMemoryEntry` at `:542`, `StageEntry` at `:510`, R-MV3 `[forgotten]` rendering at `:548`–`:557`. Existing `summarizes`-edge query patterns live inside `loadSummaryEntries` (around `:855`).

---

## Acceptance Criteria Coverage

This phase implements:

### volatile-context.R-VC2 (Working Knowledge header)

- **R-VC2 (literal, Working Knowledge portion):** "Each section shall begin with a header line carrying both name and purpose: `## Working Knowledge — operational and durable` … The three top-level headers shall use uniform typography (`##`); section identity is encoded in the trailing label text, not in heading-level variation."

### volatile-context.R-VC3

- **R-VC3 (literal):** "The Working Knowledge section shall contain: every entry where `tier = 'pinned'` rendered in full text; every entry where `tier = 'summary'` rendered with key plus a 200-character gloss; and R-MV1 memory delta entries flagged in-place with a `[changed since last turn]` marker on the same line. R-HM7 stale children render as indented entries beneath their parent summary (R-VC10)."

### volatile-context.R-VC6 (Working Knowledge footer)

- **R-VC6 (literal, Working Knowledge portion):** "Working Knowledge's footer reads: `Bodies of summary entries are accessed via memory search using terms from the entry key.`."

### volatile-context.R-VC10

- **R-VC10 (literal):** "When a memory entry where `tier = 'summary'` is loaded into Working Knowledge and any of its outgoing `summarizes` children have `modified_at` later than the summary's `modified_at` (R-HM7), each such stale child shall render as an indented entry beneath the summary, with the child's key, full value (truncated to 200 characters), and a `[stale child of <summary key>]` marker."

### volatile-context.R-VC11 (a, b, c, d)

- **R-VC11 (literal):** "When a memory entry has `modified_at > baseline` (R-MV1 delta) and is loaded into Working Knowledge, the entry's render line shall include a `[changed since last turn]` marker. The standalone 'Memory: N entries (M changed)' callout line is replaced by per-entry flagging."
- **R-VC11(a) (literal):** "Marker placement on summary entries (R-VC3 200-char gloss): marker appended after the gloss on the same line."
- **R-VC11(b) (literal):** "Marker placement on pinned entries (R-VC3 full-text): marker rendered on a new indented line beneath the pinned text: `    [changed since last turn]`. This avoids ambiguity with multi-line pinned content."
- **R-VC11(c) (literal):** "Composition with R-VC10 (stale child): when an entry is both a stale child and a delta — the most common case, since staleness implies recent modification — both markers shall render in the fixed order `[stale child of <summary key>] [changed since last turn]`."
- **R-VC11(d) (literal):** "R-MV5 preservation: the marker computation is a delta-read; the implementation must not invoke any code path that updates `last_accessed_at` while building the marker."

### volatile-context.R-VC22 (top-level header typography uniformity — Working Knowledge half)

- **R-VC22 (literal):** "The three top-level section headers (Working Knowledge, Discoverable Archive, Live State) shall not be rendered with typography that varies between sections. Typographic uniformity at the top-level header level prevents inadvertent authority gradients; differentiation lives in the trailing label text (R-VC2). Sub-cluster headings inside Discoverable Archive (R-VC15) are deeper-level headings (`###`) and are not subject to this rule."

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Define `renderWorkingKnowledge` types and signature

**Type:** Functionality (type-only scaffold).

**Verifies:** None directly (types are verified by the TypeScript compiler).

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts` — add new exported types alongside `StageEntry`/`StageResult`.

**Implementation:**

Define the input contract for the renderer. The renderer is pure and accepts already-loaded data, so callers (Phase 5) compose `loadPinnedEntries` + `loadSummaryEntries` + a stale-child lookup + a delta-key set and pass them in.

```typescript
export interface WorkingKnowledgeInput {
    /** From loadPinnedEntries — rendered in full text. */
    pinned: StageEntry[];
    /** From loadSummaryEntries — rendered with 200-char gloss. */
    summaries: StageEntry[];
    /**
     * Per-summary stale children, keyed by summary key.
     * Populated by Phase 5 wiring via memory_edges 'summarizes' traversal.
     * Empty array (or missing key) means no stale children for that summary.
     */
    staleChildrenBySummary: Map<string, StageEntry[]>;
    /**
     * Set of memory keys with modified_at > baseline (R-MV1 delta semantics).
     * Computed upstream by the existing R-MV1 baseline logic; passed in here
     * so the renderer is pure (no DB access for delta detection).
     */
    deltaKeys: Set<string>;
}

export interface RenderedSection {
    /** Section line array, one element per output line. Joined with "\n" by callers. */
    lines: string[];
}
```

Notes:

- `staleChildrenBySummary` is a `Map<string, StageEntry[]>`, not a flat array, so the renderer can match each summary to its children without doing graph traversal itself. Phase 5's wiring will build the map from `memory_edges` (`relation = 'summarizes'`) joining on `modified_at` per R-HM7.
- `deltaKeys` is computed upstream from the R-MV1 `modified_at > baseline` query that already exists in `buildVolatileEnrichment`. The renderer must be a pure consumer (R-VC11(d) — never touch `last_accessed_at` from the rendering path).
- `RenderedSection.lines` is an array of strings, not a single string, to match the existing `suffixLines` accumulator convention in `context-assembly.ts:182` (verified). Phase 5 spreads these into the accumulator.

Add the function signature stub:

```typescript
export function renderWorkingKnowledge(input: WorkingKnowledgeInput): RenderedSection {
    return { lines: [] };
}
```

**Step 1: Add the type definitions and the stub function.**

**Step 2: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 3: Commit**

```bash
git add packages/agent/src/summary-extraction.ts
git commit -m "feat(agent): scaffold renderWorkingKnowledge types"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Implement `renderWorkingKnowledge` body

**Type:** Functionality.

**Verifies:** volatile-context.R-VC2, volatile-context.R-VC3, volatile-context.R-VC6, volatile-context.R-VC10, volatile-context.R-VC11(a), volatile-context.R-VC11(b), volatile-context.R-VC11(c), volatile-context.R-VC11(d), volatile-context.R-VC22.

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts` — replace the stub from Task 1 with the full implementation.

**Implementation:**

Pseudocode (the task implementor adapts to actual project code style):

```typescript
const WORKING_KNOWLEDGE_HEADER = "## Working Knowledge — operational and durable";
const WORKING_KNOWLEDGE_FOOTER =
    "Bodies of summary entries are accessed via memory search using terms from the entry key.";
const SUMMARY_GLOSS_MAX = 200;
const STALE_CHILD_GLOSS_MAX = 200;
const DELTA_MARKER = "[changed since last turn]";
const PINNED_DELTA_INDENT = "    "; // four spaces, per R-VC11(b)

export function renderWorkingKnowledge(input: WorkingKnowledgeInput): RenderedSection {
    const lines: string[] = [];
    lines.push(WORKING_KNOWLEDGE_HEADER);
    lines.push("");

    // R-VC3: pinned entries in full text. R-VC11(b): delta marker on indented new line.
    for (const entry of input.pinned) {
        lines.push(`- ${entry.key}: ${entry.value}`);
        if (input.deltaKeys.has(entry.key)) {
            lines.push(`${PINNED_DELTA_INDENT}${DELTA_MARKER}`);
        }
    }

    // R-VC3: summary entries with 200-char gloss. R-VC11(a): delta marker on same line.
    for (const summary of input.summaries) {
        const gloss = truncate(summary.value, SUMMARY_GLOSS_MAX);
        const summaryDelta = input.deltaKeys.has(summary.key) ? ` ${DELTA_MARKER}` : "";
        lines.push(`- ${summary.key}: ${gloss}${summaryDelta}`);

        // R-VC10: stale children indented beneath their parent.
        const staleChildren = input.staleChildrenBySummary.get(summary.key) ?? [];
        for (const child of staleChildren) {
            const childGloss = truncate(child.value, STALE_CHILD_GLOSS_MAX);
            const staleMarker = `[stale child of ${summary.key}]`;
            // R-VC11(c): when stale + delta, fixed order is [stale child …] [changed since last turn].
            const childDelta = input.deltaKeys.has(child.key) ? ` ${DELTA_MARKER}` : "";
            lines.push(`  - ${child.key}: ${childGloss} ${staleMarker}${childDelta}`);
        }
    }

    lines.push("");
    lines.push(WORKING_KNOWLEDGE_FOOTER);

    return { lines };
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    // Project convention: existing truncations append "(truncated)" in some places and bare
    // ellipsis in others. Verify the convention used in the existing
    // `formatMemoryEntry` / 200-char gloss code at `summary-extraction.ts:548`–:557 and
    // match it (do NOT introduce a third truncation style).
    return s.slice(0, max) + "...";
}
```

Implementation notes:

- The `truncate` helper exists in spirit elsewhere in the file. Before adding a new local helper, search for an existing 200-char truncation utility in `summary-extraction.ts` and reuse it. If none exists, the local helper above is acceptable.
- The leading `## Working Knowledge — operational and durable` uses the exact em-dash character (U+2014), matching the spec. The string is a single literal — no string concatenation. Test assertions in Task 3 must use the same exact characters.
- The blank line after the header and before the footer mirrors the prose example in spec §4.2.
- The four-space indent in R-VC11(b) is verified literal: spec §3.2 (b) reads `    [changed since last turn]` (four spaces).
- R-VC11(d) is preserved structurally: this function is a pure transform over its `WorkingKnowledgeInput`; no DB access happens here, no `last_accessed_at` is touched.
- R-MV3 forgotten-entry rendering (`[forgotten]` for soft-deleted entries) is the responsibility of `formatMemoryEntry` upstream — `loadPinnedEntries` and `loadSummaryEntries` already filter `WHERE deleted=0`, so forgotten entries should not reach the renderer in the first place. If future code paths surface forgotten entries here, the renderer's `entry.value` field will already carry the `[forgotten]` rendering and pass through unchanged.

**Step 1: Implement the function.**

**Step 2: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 3: Commit**

```bash
git add packages/agent/src/summary-extraction.ts
git commit -m "feat(agent): implement renderWorkingKnowledge"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Test `renderWorkingKnowledge`

**Type:** Functionality.

**Verifies:** volatile-context.R-VC2, R-VC3, R-VC6, R-VC10, R-VC11(a), R-VC11(b), R-VC11(c), R-VC22.

**Files:**
- Create: `packages/agent/src/__tests__/render-working-knowledge.test.ts`

**Implementation:**

The renderer is pure and takes plain inputs, so tests do not need a database. Construct `WorkingKnowledgeInput` literals.

Tests required (one `describe` block per scenario family, one `it` per AC case):

1. **Empty input.** All four input arrays/sets/maps are empty. Output is `[header, "", "", footer]` (four lines: the header, a blank line, a blank line, the footer). Verifies R-VC2 + R-VC6.

2. **Pinned only, no deltas.** Two pinned entries with multi-character keys and bodies. Output contains `- {key}: {full-value}` for each, no delta markers. Verifies R-VC3 (pinned full-text).

3. **Summary only, no deltas, no stale children.** Two summary entries with 250-character bodies. Output contains `- {key}: {first-200-chars}{truncation-marker}` for each. Verifies R-VC3 (summary 200-char gloss).

4. **Summary with stale children.** One summary entry with two stale-child entries in the `staleChildrenBySummary` map. Output indents the children beneath the parent with two leading spaces and the `[stale child of {summary_key}]` marker. Verifies R-VC10.

5. **Delta on a summary entry (R-VC11(a)).** One summary entry whose key is in `deltaKeys`. Output line ends with ` [changed since last turn]` after the gloss. Verifies R-VC11(a).

6. **Delta on a single-line pinned entry (R-VC11(b)).** One pinned entry whose key is in `deltaKeys`. Output renders the pinned line, then a separate line with exactly four leading spaces and `[changed since last turn]`. Verifies R-VC11(b).

7. **Delta on a multi-line pinned entry (R-VC11(b) edge case).** One pinned entry whose `value` contains an embedded `\n`. The delta marker still renders on its own indented new line beneath the entry. Verifies R-VC11(b)'s "avoids ambiguity with multi-line pinned content" rationale.

8. **Stale child + delta composition (R-VC11(c)).** One summary entry whose stale child's key is also in `deltaKeys`. Output renders the child line with markers in the fixed order `[stale child of {parent}] [changed since last turn]`. Verifies R-VC11(c).

9. **Stale child without delta (R-VC11(c) negative case).** Same setup as case 8 but the child key is NOT in `deltaKeys`. Output renders only `[stale child of {parent}]`, no delta marker. Verifies that the marker is conditional, not unconditional.

10. **Full mixed input.** Pinned + summary + stale children + deltas combined. Assert against a pinned snapshot of the expected line array. Smoke test that nothing collides.

11. **Header typography uniformity (R-VC22).** Assert the section header is exactly `"## Working Knowledge — operational and durable"` — `##`, no `###` or `#`. Verifies R-VC22.

12. **Footer text (R-VC6).** Assert the last non-blank line is exactly `"Bodies of summary entries are accessed via memory search using terms from the entry key."`. Verifies R-VC6.

13. **R-VC11(d) — no last_accessed_at side effects.** This case is structural: the test passes a frozen `WorkingKnowledgeInput` and asserts no thrown exceptions and no calls to any DB API (no DB is provided). Document the intent in the test description; the structural guarantee comes from the function signature accepting only data, not a `Database` instance.

Each test should construct a minimal `StageEntry` object literal (use `as any` only if a column outside the renderer's read set requires it).

**Step 1: Write the failing tests.**

**Step 2: Verify they pass**

Run: `bun test packages/agent/src/__tests__/render-working-knowledge.test.ts`

Expected: all 13 tests pass.

**Step 3: Commit**

```bash
git add packages/agent/src/__tests__/render-working-knowledge.test.ts
git commit -m "test(agent): cover renderWorkingKnowledge for R-VC2/3/6/10/11/22"
```
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

---

## Phase 2 Done When

- All three tasks committed.
- `bun test packages/agent/src/__tests__/render-working-knowledge.test.ts` passes 13 tests.
- `bun run typecheck` passes.
- The function is exported but not yet wired into `buildVolatileContext`. Phase 5 will compose `loadPinnedEntries` + `loadSummaryEntries` + the new stale-children Map and the delta-key set, and call `renderWorkingKnowledge`.
- R-VC11(d) is structurally guaranteed: the renderer accepts no `Database` parameter, so it cannot touch `last_accessed_at`.
