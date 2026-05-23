# Volatile Context Tiered Fidelity — Phase 5: Integration

**Goal:** Wire the three renderers from Phases 2–4 into `buildVolatileContext`, remove the trailing "Do not mention this block" meta-instruction, drop the standalone `Memory: N entries (M changed)` callout in favor of in-place R-VC11 delta flags, and apply R-VC14 budget-pressure shedding through the new section structure. All four `buildVolatileEnrichment` call sites are updated symmetrically.

**Architecture:** Build two new lookup helpers (`buildParentSummaryMap`, `buildStaleChildrenMap`) that query `memory_edges` `summarizes` edges, then refactor `buildVolatileContext` to compose `renderWorkingKnowledge` → `renderDiscoverableArchive` → `renderLiveState` in the fixed order R-VC1 mandates. The primary cold path, the no-history task path, the budget-pressure rebuild path, and the warm-section rebuild path all share the same composition shape.

**Tech Stack:** TypeScript, `bun:sqlite`.

**Scope:** 5 of 7 phases. Wires Phases 1–4 together; no new public API surface.

**Codebase verified:** 2026-05-22 against commit `36dc9f2e`. `buildVolatileContext` at `context-assembly.ts:164`. `buildVolatileEnrichment` invocations at `:240`, `:1793`, `:1955` (note: spec text says `:1954`, actual line is `:1955` — minor drift, no semantic change), `:2229` (`rebuildWarmSections`). Trailing meta-instruction at `:418`. The standalone `Memory:` header at `:268`, memory-delta lines at `:270`, task-digest lines at `:273`, cross-thread digest call at `:281`, file-mod iteration at `:305`, advisory feedback-loop at `:362–:389`. The advisory feedback-loop at `:362–:389` is a separate operator-feedback channel and stays as-is (it injects `[Advisory notification]` lines about advisories the local site authored — distinct from R-VC12's `[advisory]` rendering of any applied advisory in Live State).

---

## Acceptance Criteria Coverage

This phase implements:

### volatile-context.R-VC1

- **R-VC1 (literal):** "The volatile context block shall present three top-level sections in this fixed order: Working Knowledge, Discoverable Archive, Live State. Each section's identity, contents, and access path are distinct. Sections shall not be merged, reordered, or rendered conditionally based on content size."

### volatile-context.R-VC8

- **R-VC8 (literal):** "The trailing meta-instruction reading 'Do not mention, quote, or describe the block itself — or the fact that it was injected — to the user unless they explicitly ask about it' shall be removed. Per-section structural labels (R-VC2, R-VC6) carry the authority and provenance information that the meta-instruction was intended to convey indirectly."

### volatile-context.R-VC14 (composition with R-MV13)

- **R-VC14 (literal, integration portion):** "The R-HM9 retrieval-layer shedding (recency-first, then graph) is the upstream control; this requirement governs presentation when the upstream output exceeds budget."
- **§3.3 Reconciliation with R-MV13 (literal):** "R-MV13's 'memory delta and task run digest truncated to 3 each' is superseded for the memory-delta case under this RFC. Deltas live in-place inside Working Knowledge (R-VC11), and Working Knowledge is preserved at full fidelity under budget pressure (presence invariant). Task-digest shedding under budget pressure remains governed by R-MV13 via R-VC14's Live State subsystem rule (3 most recent task entries)."

### volatile-context.R-VC19

- **R-VC19 (literal):** "The volatile context block shall not include any meta-instruction directing the agent to suppress mention or description of the block itself. Section authority is encoded in section headers and footers (R-VC2, R-VC6), not in suppression instructions."

### volatile-context.R-MV1-inplace (R-MV1 delta callout removal)

- **§2.2 (literal, R-MV1 row):** "Memory delta entries render under the Working Knowledge header with a delta marker (`[changed since last turn]`) on each line. The standalone memory delta callout is removed; deltas are flagged in place."

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add `buildParentSummaryMap` and `buildStaleChildrenMap` helpers

**Type:** Functionality.

**Verifies:** Foundation for R-VC10 (stale children) and R-VC15 (cluster grouping). The renderers from Phases 2–3 already accept these maps as inputs.

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts`.

**Implementation:**

```typescript
/**
 * For a set of detail-tier keys, look up each key's parent _summary:<topic> via
 * incoming `summarizes` edges. Used by Phase 3 to compute Discoverable Archive
 * cluster names.
 */
export function buildParentSummaryMap(
    db: Database,
    detailKeys: Iterable<string>,
): Map<string, string> {
    const result = new Map<string, string>();
    const keys = Array.from(detailKeys);
    if (keys.length === 0) return result;
    const placeholders = keys.map(() => "?").join(",");
    const rows = db
        .prepare(
            `SELECT e.target_key AS child, e.source_key AS parent
             FROM memory_edges e
             WHERE e.relation = 'summarizes'
               AND e.deleted IS NOT 1
               AND e.target_key IN (${placeholders})`,
        )
        .all(...keys) as Array<{ child: string; parent: string }>;
    for (const r of rows) {
        // If multiple summaries claim the same child, the first-seen wins. The spec is
        // silent on multi-parent semantics; the data model conventionally has one summary
        // per detail entry.
        if (!result.has(r.child)) result.set(r.child, r.parent);
    }
    return result;
}

/**
 * For a set of summary keys, return each summary's outgoing `summarizes` children
 * whose `modified_at` is later than the summary's own — i.e. R-HM7 stale children.
 */
export function buildStaleChildrenMap(
    db: Database,
    summaries: StageEntry[],
): Map<string, StageEntry[]> {
    const result = new Map<string, StageEntry[]>();
    if (summaries.length === 0) return result;
    const summaryKeyToModifiedAt = new Map(summaries.map((s) => [s.key, s.modified_at ?? ""]));
    const placeholders = summaries.map(() => "?").join(",");
    const rows = db
        .prepare(
            `SELECT e.source_key AS parent, e.target_key AS child_key,
                    m.value AS child_value, m.modified_at AS child_modified_at, m.tier AS tier
             FROM memory_edges e
             JOIN semantic_memory m ON m.key = e.target_key AND m.deleted IS NOT 1
             WHERE e.relation = 'summarizes'
               AND e.deleted IS NOT 1
               AND e.source_key IN (${placeholders})`,
        )
        .all(...summaries.map((s) => s.key)) as Array<{
        parent: string;
        child_key: string;
        child_value: string;
        child_modified_at: string;
        tier: string;
    }>;
    for (const r of rows) {
        const parentModifiedAt = summaryKeyToModifiedAt.get(r.parent) ?? "";
        // R-HM7 staleness: child.modified_at > summary.modified_at.
        if (r.child_modified_at <= parentModifiedAt) continue;
        const bucket = result.get(r.parent) ?? [];
        bucket.push({
            key: r.child_key,
            value: r.child_value,
            modified_at: r.child_modified_at,
            tier: r.tier,
            tag: "[stale-detail]",
            // Other StageEntry fields populated as needed; verify the canonical shape
            // from `summary-extraction.ts:510` at execution time.
        } as StageEntry);
        result.set(r.parent, bucket);
    }
    return result;
}
```

Notes:

- The exact column names (`source_key`, `target_key`, `relation`, `deleted`) on `memory_edges` are confirmed by codebase-investigator. The implementor should re-verify the column shape against `packages/core/src/schema.ts` before writing the SQL — if names differ, adjust.
- ISO-8601 string compare on `modified_at` is correct because both sides are stored in the same lexicographically-sortable format.
- `buildStaleChildrenMap` returns only stale children, matching the existing R-HM7 semantics that fold stale detail children into the summary's enrichment.
- `result.has(r.child)` first-seen-wins on `buildParentSummaryMap` is a defensive choice; if the data model ever produces multi-parent edges, the renderer's cluster routing degrades gracefully (one parent picked per child).

**Step 1: Add both helpers.**

**Step 2: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 3: Commit**

```bash
git add packages/agent/src/summary-extraction.ts
git commit -m "feat(agent): add parent-summary and stale-children lookup helpers"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Test `buildParentSummaryMap` and `buildStaleChildrenMap`

**Type:** Functionality.

**Verifies:** Helper correctness for R-VC10 + R-VC15 cluster grouping.

**Files:**
- Create: `packages/agent/src/__tests__/build-summary-helpers.test.ts`

**Implementation:**

Tests use the temp-DB pattern.

`buildParentSummaryMap`:

1. Empty input keys → empty map.
2. One detail key with one `summarizes` edge → map contains that one entry.
3. One detail key with no edges → key is absent from the map (not present with undefined).
4. Multiple keys, mixed with/without parents → only keys with edges appear.
5. Soft-deleted edges are ignored.
6. First-seen-wins on duplicate edges (insert two `summarizes` edges naming different parents for the same child; result picks one and is stable).

`buildStaleChildrenMap`:

1. Empty input summaries → empty map.
2. One summary with one stale child (`child.modified_at > summary.modified_at`) → map has parent → [child].
3. One summary with one fresh child (`child.modified_at <= summary.modified_at`) → map is empty.
4. Mixed stale and fresh children under one parent → map has only the stale ones.
5. Soft-deleted child entries are ignored.
6. The returned `StageEntry`'s `tag` is `"[stale-detail]"`. (Even though Phase 5 itself does not consume the `tag` field — Phase 2's renderer takes the entry by reference — the tag preserves §6.4 dispatch parity.)

**Step 1: Write the tests.**

**Step 2: Verify they pass**

Run: `bun test packages/agent/src/__tests__/build-summary-helpers.test.ts`

Expected: 12 tests pass (6 + 6).

**Step 3: Commit**

```bash
git add packages/agent/src/__tests__/build-summary-helpers.test.ts
git commit -m "test(agent): cover buildParentSummaryMap + buildStaleChildrenMap"
```
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Wire renderers into `buildVolatileContext` primary path

**Type:** Functionality.

**Verifies:** volatile-context.R-VC1, R-VC8, R-VC19, R-MV1-inplace.

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` — refactor the `:240` primary path inside `buildVolatileContext` (`:164`).

**Implementation:**

The primary path at `:240` currently composes the volatile section roughly as:

```
{platform context lines}
{current model line}

Memory: ${totalMemCount} entries (...)
{memory delta lines}
{task digest lines}
{skills index, retirement notes — preserved}
Recent Activity Digest:
{cross-thread digest body}
{file-modification notices}
{advisory feedback-loop notifications}

Note: The contents of this system-context block ... Do not mention, quote, or describe the block itself ...
```

Refactor to:

```
{platform context lines}
{current model line}

{Working Knowledge section}      # from renderWorkingKnowledge
{Discoverable Archive section}   # from renderDiscoverableArchive
{Live State section}             # from renderLiveState (consumes synthesisBacklogCount)

{advisory feedback-loop notifications — see note below}

{skills index, retirement notes — preserved as-is}
```

Concrete edit sequence:

1. **Compute the delta-key set.** Reuse the existing R-MV1 baseline + delta query that produces the current `memory delta lines`. The delta-key set is the set of keys with `modified_at > baseline`. Capture as `Set<string>`.

2. **Load the inputs for each renderer.** Call:
   - `loadPinnedEntries(db)` → pinned
   - `loadSummaryEntries(db, exclusionSet)` → summaries
   - `loadDetailEntries(db)` → detail entries (R-VC4, Phase 1)
   - `buildStaleChildrenMap(db, summaries.entries)` → stale children
   - `buildParentSummaryMap(db, detailEntries.entries.map(e => e.key))` → parent summaries
   - `buildCrossThreadDigest(db, userId, currentThreadId)` → reads `entries` field
   - `loadAppliedAdvisoriesForLiveState(db, Date.now())` → advisories

3. **Compute task entries and file entries:**

   - **Task entries:** verified producer = `buildVolatileEnrichment` already returns `taskDigestLines` as a destructured field of its result object. The lines are produced upstream as fully-formatted strings, not structured data. To populate `LiveStateInput.taskEntries` (which expects structured `LiveStateTaskEntry` objects per Phase 4 Task 5), extend `buildVolatileEnrichment`'s return shape additively: add `taskDigestEntries: LiveStateTaskEntry[]` alongside the existing `taskDigestLines`. The producer that builds `taskDigestLines` already has structured data in flight — it formats it to strings; the extension captures the structured form before formatting. Do NOT parse `taskDigestLines` back into structure — that's lossy and fragile.
   - **File entries:** verified producer = the inline `_internal.file_thread.%` loop currently in `buildVolatileContext` itself (`context-assembly.ts:300`–`:325`-ish, the `try { const FILE_NOTIF_CAP = 10; const threadFiles = ...` block). There is no separate producer function — the loop reads from `semantic_memory` keys prefixed `_internal.file_thread.`, looks up the last thread for each via `getLastThreadForFile`, and formats via `getFileThreadNotificationMessage`. Factor this loop into a new helper `loadFileModificationsForLiveState(db, currentThreadId): LiveStateFileEntry[]` that returns structured entries (path + threadTitle), and call it from the wiring. The existing `FILE_NOTIF_CAP = 10` cap stays in the helper. The `try/catch` continues to swallow query errors (current behavior).

4. **Compute `staleChildKeysInWorkingKnowledge`** as `new Set(Array.from(staleChildrenMap.values()).flat().map(e => e.key))`. Pass to `renderDiscoverableArchive` for its dedup.

5. **Render in fixed order** per R-VC1:

```typescript
const wk = renderWorkingKnowledge({
    pinned: pinned.entries,
    summaries: summaries.entries,
    staleChildrenBySummary: staleChildrenMap,
    deltaKeys,
});
suffixLines.push(...wk.lines);

const da = renderDiscoverableArchive({
    entries: detailEntries.entries,
    parentSummaryByKey: parentSummaryMap,
    staleChildKeysInWorkingKnowledge,
    budgetPressure,
    nowMs,
    tunables: resolveVc15Tunables(),
});
suffixLines.push(...da.section.lines);

const ls = renderLiveState({
    crossThreadEntries: digest.entries,
    taskEntries,
    fileEntries,
    advisories,
    synthesisBacklogCount: da.synthesisBacklogCount,
    budgetPressure,
    nowMs,
});
suffixLines.push(...ls.lines);
```

6. **Delete the obsolete code:**
   - Memory header line at `:268` (`Memory: ${totalMemCount} entries`).
   - Memory-delta lines push at `:270` (deltas now flow inline through Working Knowledge).
   - Task-digest lines push at `:273` (now in Live State).
   - `Recent Activity Digest:` header consumption (cross-thread is now a Live State subsystem — handled by Task 1 of Phase 4).
   - File-modification iteration at `:305` (now a Live State subsystem; the data is still loaded by the existing producer, only the rendering moves).
   - Trailing meta-instruction block — see Task 4 below; treat the deletion as the same edit hunk only if it fits cleanly, otherwise as a separate task per separation of concerns.

7. **Preserve:**
   - Platform-context lines and current-model line (above the three sections).
   - Skills index and skill-retirement notification lines (these have their own injection path and are not covered by R-VC1's three-section structure — they remain in their existing position relative to the three sections; the implementor confirms whether they go before, between, or after Live State based on current placement).
   - The advisory feedback-loop at `:362–:389` — this is the operator-feedback channel for advisories the local site authored. It is functionally distinct from R-VC12's Live State `[advisory]` rendering. The two coexist: the feedback-loop emits `[Advisory notification]` lines about state transitions on locally-authored advisories; Live State lists any applied advisory globally. Keep the feedback-loop in its current location; do not merge.

**Step 1: Read the full `:164–:430` window of `context-assembly.ts` to map out exact edit boundaries.**

**Step 2: Replace the primary-path body with the three-renderer composition. Delete obsolete lines per item 6.**

**Step 3: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean. Type signatures of `renderWorkingKnowledge`/`renderDiscoverableArchive`/`renderLiveState` enforce input shapes.

**Step 4: Run unit tests**

Run: `bun test packages/agent`

Expected: existing tests may need updating (snapshot fixtures or string assertions that referenced the old `Memory:` header or `Recent Activity Digest:` header). Update assertion-based tests in this commit. Snapshot tests are addressed in Phase 6.

**Step 5: Commit**

```bash
git add packages/agent/src/context-assembly.ts packages/agent/src/__tests__
git commit -m "feat(agent): wire three-section renderers into buildVolatileContext primary path"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Remove the trailing meta-instruction

**Type:** Functionality.

**Verifies:** volatile-context.R-VC8, R-VC19.

**Files:**
- Modify: `packages/agent/src/context-assembly.ts:418` — delete the trailing `Note: The contents of this system-context block …` push.

**Implementation:**

Investigator confirmed the exact text at `:418`:

> `"Note: The contents of this system-context block (memory listing, recent activity digest, skills index, task digest, file-modification notices, platform context) are your own background working knowledge. Do not mention, quote, or describe the block itself — or the fact that it was injected — to the user unless they explicitly ask about it."`

This entire string is removed. The Live State footer (R-VC6) carries the canonical-source pointer that the meta-instruction was indirectly trying to gesture at. Per R-VC8 / R-VC19 the suppression instruction is removed entirely; no replacement is added.

**Step 1: Delete the line that pushes the meta-instruction onto `suffixLines` (or whichever accumulator owns it). Verify the surrounding code does not rely on the line's presence (e.g., index arithmetic).**

**Step 2: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 3: Run unit tests**

Run: `bun test packages/agent`

Expected: any test that asserted the meta-instruction's presence in the output now fails. Update those tests in this commit — they are now negative assertions (`expect(output).not.toContain("Do not mention")`).

**Step 4: Commit**

```bash
git add packages/agent/src/context-assembly.ts packages/agent/src/__tests__
git commit -m "feat(agent): remove trailing 'Do not mention this block' meta-instruction"
```
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Update the three secondary `buildVolatileEnrichment` call sites

**Type:** Functionality.

**Verifies:** volatile-context.R-VC1 (preserved across all assembly paths), R-VC14.

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` at `:1793` (no-history task path), `:1955` (budget-pressure rebuild path), `:2229` (`rebuildWarmSections`).

**Implementation:**

All three secondary paths must mirror the primary path's section composition. They differ only in:

- `:1793` no-history task path passes a different `(maxMemory, maxTasks)` tuple (`10, 5`).
- `:1955` budget-pressure rebuild path passes `(3, 3)` and runs with `budgetPressure: true` set on `renderDiscoverableArchive` and `renderLiveState`. R-VC14 + the §3.3 reconciliation rule supersede R-MV13's flat `truncate to 3` for the memory-delta case (deltas live inline in Working Knowledge, which is preserved at full fidelity) but preserve it for the task-digest case (R-VC14's Live State subsystem rule caps at 3 most-recent task entries).
- `:2229` `rebuildWarmSections` is the warm-cache rebuild path; it composes the same three sections from the same inputs.

For each call site:

1. Identify the existing volatile-section assembly code (likely a smaller variant of the primary path's logic).
2. Replace with the same three-renderer composition pattern from Task 3.
3. Pass `budgetPressure: true` only on the `:1955` path; the others pass `false`.
4. The no-history task path may pass a smaller `maxMemory` to upstream loaders; this affects how many summary entries reach the renderer, which is acceptable and consistent with the current shape.

**Important:** Do not replicate the full code three times. Extract a shared helper inside `context-assembly.ts` (e.g., `composeVolatileSections(deps, opts)`) that all four call sites use. The helper takes the loaded inputs + the `budgetPressure` + `nowMs` and returns the line array. Each call site calls the helper after preparing its loader inputs.

**Step 1: Extract a shared `composeVolatileSections` helper inside `context-assembly.ts`. Refactor the primary path (Task 3 result) to call it.**

**Step 2: Update each of the three secondary call sites to call the helper.**

**Step 3: Verify with typecheck**

Run: `bun run typecheck`

Expected: clean.

**Step 4: Run unit tests**

Run: `bun test packages/agent`

Expected: pass. Any test exercising no-history-task / budget-pressure-rebuild / warm-rebuild paths now sees the new section structure.

**Step 5: Commit**

```bash
git add packages/agent/src/context-assembly.ts
git commit -m "refactor(agent): factor composeVolatileSections; mirror across all 4 paths"
```
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Integration test — end-to-end `buildVolatileContext` shape

**Type:** Functionality.

**Verifies:** volatile-context.R-VC1, R-VC8, R-VC14 (composition), R-VC19, R-MV1-inplace.

**Files:**
- Create: `packages/agent/src/__tests__/volatile-context-integration.test.ts`

**Implementation:**

Use a real temp `bun:sqlite` DB with `applySchema(db)`. Use `insertRow` from `@bound/core` for all writes (synced-table outbox invariant).

Tests:

1. **Three sections render in the fixed order R-VC1.** Construct a fixture with at least one pinned, one summary, one detail, one cross-thread sibling, one applied advisory, one file mod. Run `buildVolatileContext`. Assert:
   - The string contains `"## Working Knowledge — operational and durable"` BEFORE `"## Discoverable Archive — title-only; bodies via memory search"` BEFORE `"## Live State — pointers to canonical sources"`.
   - The three top-level headers all use `## ` (double hash + space), no `### `.

2. **No trailing meta-instruction.** Assert the output does NOT contain `"Do not mention"`.

3. **No standalone `Memory: N entries` callout.** Assert the output does NOT contain `"Memory: "` (exactly that prefix on its own line).

4. **No `Recent Activity Digest:` header.** Assert the output does NOT contain `"Recent Activity Digest:"`.

5. **In-place delta marker on a summary entry.** Insert a summary entry with `modified_at` after the baseline; assert its line carries ` [changed since last turn]`. Assert no separate `Memory: N entries (M changed)` callout exists.

6. **Footer for each section is present.** Assert the three exact footer literals appear (one per section) at their respective positions.

7. **Budget-pressure path produces shed Live State.** Construct a fixture with 10 cross-thread siblings, simulate the budget-pressure rebuild path. Assert Live State contains exactly 3 `[thread]` lines.

8. **Working Knowledge preserved at full fidelity under budget pressure (presence invariant).** Same fixture as case 7; assert all pinned + summary entries still render with their full / 200-char gloss content. Verifies R-VC14 + §3.3.

9. **Discoverable Archive Tier-2 cluster transition.** Construct 250 detail-tier entries split across two parent `_summary:<topic>` keys. Assert output has `### topic1 (...)` and `### topic2 (...)` sub-cluster headings.

10. **Discoverable Archive Tier-3 with synthesis-backlog.** Construct 1100 detail-tier entries with 60 of them uncategorized. Override `BOUND_VC15_N=1000` (default) and `BOUND_VC15_M=20`. Assert Live State contains `- [synthesis-backlog] 60 uncategorized detail entries`.

11. **Cross-thread digest summary excerpt absent.** Construct two sibling threads with non-empty `summary` columns. Assert the output does NOT contain `"Summary: "`. Verifies R-VC23 end-to-end.

12. **Skills index and skill retirement notes preserved.** Construct a fixture with one active skill and one retirement note. Assert both still render in the assembled string (current placement preserved).

13. **Advisory feedback-loop preserved.** Construct one approved advisory authored by the local site within 24h. Assert the output contains `[Advisory notification]` (the existing feedback-loop format), distinct from any `[advisory]` Live State entry. Verifies the feedback-loop is preserved.

**Step 1: Write the tests.**

**Step 2: Verify they pass**

Run: `bun test packages/agent/src/__tests__/volatile-context-integration.test.ts`

Expected: 13 tests pass.

**Step 3: Run the full agent suite to catch any regressions**

Run: `bun test packages/agent`

Expected: pass.

**Step 4: Commit**

```bash
git add packages/agent/src/__tests__/volatile-context-integration.test.ts
git commit -m "test(agent): integration coverage of three-section buildVolatileContext"
```
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_C -->

---

## Phase 5 Done When

- All six tasks committed.
- `bun test packages/agent` passes.
- `bun run typecheck` passes.
- The three sections render in fixed order across all four `buildVolatileEnrichment` call paths (primary, no-history task, budget-pressure rebuild, warm rebuild).
- The trailing `"Do not mention …"` meta-instruction is gone everywhere.
- The standalone `Memory: N entries (M changed)` callout is gone; deltas render in-place per R-VC11.
- `buildCrossThreadDigest` no longer emits `Summary: …` lines.
- The skills index, skill retirement notes, and the operator-feedback advisory channel (`:362–:389`) are preserved unchanged.
