# Hierarchical Memory Retrieval Implementation Plan

**Goal:** Rewrite `buildVolatileEnrichment()` to chain the four stage functions and return structured tier data alongside the existing formatted output.

**Architecture:** The existing `buildVolatileEnrichment()` function (summary-extraction.ts:402-675) is refactored to internally call L0→L1→L2→L3 stage functions in sequence, threading exclusion sets between stages. The function signature gains the `tiers` field on `VolatileEnrichment` while preserving the existing `memoryDeltaLines` output format for backward compatibility. `maxMemory` now governs L2+L3 combined; L0+L1 are uncapped.

**Tech Stack:** TypeScript 6.x, bun:sqlite

**Scope:** 6 phases from original design (this is phase 4 of 6)

**Codebase verified:** 2026-04-10

---

## Acceptance Criteria Coverage

This phase implements and tests:

### hierarchical-memory.AC4: Pipeline integration
- **hierarchical-memory.AC4.1 Success:** Zero summaries produces identical output to current system
- **hierarchical-memory.AC4.2 Success:** Summaries with clean children: children excluded from L2/L3
- **hierarchical-memory.AC4.3 Success:** Summaries with stale children: annotated summary + stale children loaded at L1
- **hierarchical-memory.AC4.4 Success:** Exclusion cascade prevents same entry appearing in multiple stages
- **hierarchical-memory.AC4.5 Success:** `maxMemory` applies to L2+L3 combined, L0+L1 uncapped
- **hierarchical-memory.AC4.6 Success:** Entries appear in L0→L1→L2→L3 order in output

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Extend `VolatileEnrichment` interface with `tiers` field

**Verifies:** None (type-only)

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts:388-393` (extend VolatileEnrichment)

**Implementation:**

Add the `tiers` field to the existing `VolatileEnrichment` interface:

```typescript
export interface VolatileEnrichment {
	memoryDeltaLines: string[];
	taskDigestLines: string[];
	tiers?: TieredEnrichment; // Optional in Task 1, made required in Task 2
	graphCount?: number;
	recencyCount?: number;
}
```

The `TieredEnrichment` interface was already created in Phase 3 (Task 1). The `tiers` field is initially optional (`tiers?`) to avoid breaking the existing `buildVolatileEnrichment()` return type between tasks. Task 2 will make it required once the function is rewritten to populate it.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors (tiers is optional, existing code compiles without it)

**Commit:** `feat(agent): add tiers field to VolatileEnrichment interface`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Rewrite `buildVolatileEnrichment()` to use stage functions

**Verifies:** hierarchical-memory.AC4.1, hierarchical-memory.AC4.2, hierarchical-memory.AC4.3, hierarchical-memory.AC4.4, hierarchical-memory.AC4.5, hierarchical-memory.AC4.6

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts:402-675` (rewrite buildVolatileEnrichment body)

**Implementation:**

Replace the existing body of `buildVolatileEnrichment()` with stage function calls. The function signature remains the same for backward compatibility:

```typescript
export function buildVolatileEnrichment(
	db: Database,
	baseline: string,
	maxMemory = 25,
	maxTasks = 5,
	userMessage?: string,
	threadSummary?: string,
): VolatileEnrichment {
```

The new body structure:

1. **Extract keywords** (preserve existing logic at lines 411-425):
   - `extractKeywords()` helper stays the same
   - Merge message keywords with summary keywords

2. **Run L0: Pinned**
   ```typescript
   const l0 = loadPinnedEntries(db);
   ```

3. **Run L1: Summary**
   ```typescript
   const l1 = loadSummaryEntries(db, l0.exclusionSet);
   ```

4. **Run L2: Graph-seeded** — use remaining slots from `maxMemory`
   ```typescript
   const l2 = loadGraphEntries(db, l1.exclusionSet, mergedKeywords, maxMemory);
   ```

5. **Run L3: Recency** — fill remaining slots
   ```typescript
   const remainingSlots = Math.max(0, maxMemory - l2.entries.length);
   const l3 = loadRecencyEntries(db, l2.exclusionSet, baseline, remainingSlots);
   ```

6. **Build tiers structure:**
   ```typescript
   const tiers: TieredEnrichment = {
   	L0: l0.entries,
   	L1: l1.entries,
   	L2: l2.entries,
   	L3: l3.entries,
   };
   ```

7. **Format `memoryDeltaLines`** — iterate through L0→L1→L2→L3 order, applying the existing formatting helpers (`relativeTime()`, `stalenessTag()`, `resolveSource()`):

   For L0 entries: `- ${e.key}: ${valueDisplay} [pinned]`
   For L1 entries: `- ${e.key}: ${valueDisplay} ${e.tag}` (tag is `[summary]` or `[stale-detail]`)
   For L2 entries: `- ${e.key}: ${valueDisplay} ${e.tag}${stale}` (tag is `[seed]` or `[depth N, relation]`)
   For L3 entries: `- ${e.key}: ${valueDisplay} (${relTime}, via ${sourceLabel}) [recency]${stale}`

   **Source resolution for all tiers:** The `resolveSource()` helper needs `task_name`/`thread_title` from LEFT JOIN queries. L3's `loadRecencyEntries()` already joins tasks/threads. For consistency, L0 and L1 stage functions (from Phase 3) should also LEFT JOIN tasks and threads in their queries, matching the L3 pattern. Update `loadPinnedEntries()` and `loadSummaryEntries()` to include the same LEFT JOIN on tasks and threads tables, and extend `StageEntry` to carry the resolved source label. This ensures uniform source resolution across all tiers without a separate batch resolution pass.

8. **Preserve existing task digest logic** — the task query portion of `buildVolatileEnrichment()` (after the memory section) remains unchanged. Keep the `taskDigestLines` generation as-is.

9. **Return:**
   ```typescript
   return {
   	memoryDeltaLines,
   	taskDigestLines,
   	tiers,
   	graphCount: l2.entries.length,
   	recencyCount: l3.entries.length,
   };
   ```

**Make `tiers` required:** Now that `buildVolatileEnrichment()` always populates `tiers`, update the `VolatileEnrichment` interface to make `tiers` required (remove the `?` from `tiers?: TieredEnrichment` that was added in Task 1).

**Key backward compatibility concern (AC4.1):** When zero summaries exist, L1 returns empty, L0 loads the same pinned entries as before, and L2+L3 function identically to the current graph-seeded + recency path. The `memoryDeltaLines` output format must remain identical.

**Testing:**

Tests must verify each AC:
- **hierarchical-memory.AC4.1:** Set up a DB with no summary-tier entries. Compare `memoryDeltaLines` output of new implementation vs expected output matching current format.
- **hierarchical-memory.AC4.2:** Create summaries with clean (non-stale) children. Children should NOT appear in L2 or L3 output.
- **hierarchical-memory.AC4.3:** Create summaries with stale children. Output should contain the summary + `[stale-detail]` tagged children in L1.
- **hierarchical-memory.AC4.4:** Create entries that could match multiple stages (e.g., a pinned entry that's also recent). Verify it appears exactly once.
- **hierarchical-memory.AC4.5:** Set `maxMemory=3`. Have 2 pinned entries (L0) + 1 summary (L1) + 5 default entries. L0+L1 should have all 3 entries. L2+L3 combined should have at most 3 entries.
- **hierarchical-memory.AC4.6:** Verify memoryDeltaLines array has all L0 entries first, then L1, then L2, then L3.

Create test file at `packages/agent/src/__tests__/pipeline-orchestrator.test.ts`.

**Verification:**
Run: `bun test packages/agent/src/__tests__/pipeline-orchestrator.test.ts`
Expected: All tests pass

Run: `bun test packages/agent/src/__tests__/volatile-enrichment.test.ts`
Expected: Existing volatile enrichment tests still pass (backward compatibility)

Run: `bun test packages/agent`
Expected: All existing agent tests still pass

**Commit:** `feat(agent): rewrite buildVolatileEnrichment to chain L0→L1→L2→L3 stages (AC4.1-AC4.6)`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Update context-assembly.ts to pass `tiers` through enrichment result

**Verifies:** None (infrastructure wiring — verified by existing tests continuing to pass)

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` (wherever `buildVolatileEnrichment()` result is used)

**Implementation:**

The context assembly pipeline currently calls `buildVolatileEnrichment()` in two places:
1. Interactive path (~line 1033-1045): injects enrichment into volatile message array
2. Autonomous/noHistory path (~line 1230-1245): injects as standalone system message

Both paths currently only use `memoryDeltaLines` and `taskDigestLines` from the result. The `tiers` field is new and will be used by Phase 5 (budget shedding). For now, ensure:

1. The enrichment result variable captures the full `VolatileEnrichment` return value (including `tiers`)
2. Store the `tiers` field alongside the existing `enrichmentStartIdx`/`enrichmentEndIdx` tracking so Phase 5 can access it during budget validation

Add a local variable to hold the tiers:

```typescript
let enrichmentTiers: TieredEnrichment | undefined;
// ... after calling buildVolatileEnrichment():
enrichmentTiers = enrichment.tiers;
```

No other changes to context-assembly needed in this phase.

**Verification:**
Run: `bun test packages/agent/src/__tests__/context-assembly.test.ts`
Expected: All existing context assembly tests still pass

**Commit:** `chore(agent): capture tiers from enrichment result in context-assembly`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
