# Hierarchical Memory Retrieval Implementation Plan

**Goal:** Replace the uniform `maxMemory=3` budget pressure reduction with tier-aware degradation that sheds L3 first, then reduces L2, while preserving L0+L1.

**Architecture:** A new `shedMemoryTiers()` function operates on the structured `TieredEnrichment` from Phase 4, applying a degradation sequence (shed L3 → reduce L2 to 5 → preserve L0+L1) and returning formatted output lines. Stage 7 (BUDGET_VALIDATION) in context-assembly.ts uses this instead of re-calling `buildVolatileEnrichment()` with reduced caps.

**Tech Stack:** TypeScript 6.x, bun:sqlite

**Scope:** 6 phases from original design (this is phase 5 of 6)

**Codebase verified:** 2026-04-10

---

## Acceptance Criteria Coverage

This phase implements and tests:

### hierarchical-memory.AC5: Budget shedding
- **hierarchical-memory.AC5.1 Success:** Under budget pressure, L3 entries shed entirely
- **hierarchical-memory.AC5.2 Success:** If still constrained after L3, L2 reduced to at most 5 entries
- **hierarchical-memory.AC5.3 Success:** L1 and L0 are never shed regardless of pressure
- **hierarchical-memory.AC5.4 Edge:** L0+L1 exceeding budget logs warning but does not truncate
- **hierarchical-memory.AC5.5 Success:** Shedding operates on structured tier data (no second DB call)

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Implement `shedMemoryTiers()` helper

**Verifies:** hierarchical-memory.AC5.1, hierarchical-memory.AC5.2, hierarchical-memory.AC5.3, hierarchical-memory.AC5.4, hierarchical-memory.AC5.5

**Files:**
- Create: `packages/agent/src/memory-shedding.ts` (new file for the shedding helper)

**Implementation:**

Create a standalone module for the shedding logic. This keeps it testable in isolation from context-assembly.

**Note:** The design document suggests placing this in `summary-extraction.ts` or `context-assembly.ts`. We intentionally use a standalone `memory-shedding.ts` file for better test isolation and single-responsibility — the shedding logic is distinct from both retrieval (summary-extraction) and assembly (context-assembly). This is a justified deviation from the design suggestion.

```typescript
import type { TieredEnrichment, StageEntry } from "./summary-extraction.js";

const L2_PRESSURE_CAP = 5;

export interface SheddingResult {
	memoryDeltaLines: string[];
	taskDigestLines: string[];
	warning?: string; // set when L0+L1 alone exceed what budget can accommodate
}

export function shedMemoryTiers(
	tiers: TieredEnrichment,
	taskDigestLines: string[],
	logger?: { warn: (msg: string) => void },
): SheddingResult {
```

The function applies the degradation sequence in order:

1. **Always keep L0+L1 intact** — format all L0 and L1 entries into output lines
2. **Shed L3 entirely** — drop all L3 entries
3. **Reduce L2 to at most `L2_PRESSURE_CAP` (5) entries** — keep the first 5 (preserving graph proximity ordering)
4. **Reduce task digest to 3** — same as current behavior
5. **Log warning if L0+L1 alone are large** — if L0.length + L1.length exceeds 20, emit a warning via the logger but do NOT truncate

Format entries using the same conventions as `buildVolatileEnrichment()`:
- L0: `- ${e.key}: ${valueDisplay} [pinned]`
- L1: `- ${e.key}: ${valueDisplay} ${e.tag}` (tag is `[summary]` or `[stale-detail]`)
- L2: `- ${e.key}: ${valueDisplay} ${e.tag}` (tag is `[seed]` or `[depth N, relation]`)

Value display: truncate at 200 chars with `...` suffix (same as existing `safeSlice` pattern).

The formatting helpers (`relativeTime`, `stalenessTag`, `resolveSource`) are defined in summary-extraction.ts. Either extract them to a shared location or call `shedMemoryTiers` with pre-formatted lines. The simpler approach: have `shedMemoryTiers` accept pre-formatted `StageEntry` arrays (the `tag` field already carries formatting info) and format them identically to how `buildVolatileEnrichment` does.

Return `{ memoryDeltaLines, taskDigestLines, warning }`.

**Testing:**

Tests must verify each AC:
- **hierarchical-memory.AC5.1:** Provide tiers with L0(2), L1(1), L2(5), L3(10). After shedding: L3 entries absent from output.
- **hierarchical-memory.AC5.2:** Provide tiers with L2(8). After shedding: only first 5 L2 entries present.
- **hierarchical-memory.AC5.3:** Provide tiers with L0(5), L1(3). After shedding: all 8 entries still present.
- **hierarchical-memory.AC5.4:** Provide tiers with L0(15), L1(10). After shedding: all 25 entries present, warning logged. Use a mock logger to verify.
- **hierarchical-memory.AC5.5:** Verify `shedMemoryTiers` only takes `TieredEnrichment` as input — no database handle parameter. The function signature itself proves this.

Create test file at `packages/agent/src/__tests__/memory-shedding.test.ts`.

**Verification:**
Run: `bun test packages/agent/src/__tests__/memory-shedding.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): add shedMemoryTiers helper for tier-aware budget degradation (AC5.1-AC5.5)`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Wire `shedMemoryTiers()` into context-assembly Stage 7

**Verifies:** None (integration wiring — verified by tests in Task 3)

**Files:**
- Modify: `packages/agent/src/context-assembly.ts:1288-1324` (budget pressure section)

**Implementation:**

Replace the current budget pressure handler that re-calls `buildVolatileEnrichment(db, enrichmentBaseline, 3, 3)` with the tier-aware shedding approach.

**Current code (lines 1288-1324):**
```typescript
if (headroom < 2000) {
	budgetPressure = true;
	const { memoryDeltaLines: shortDelta, taskDigestLines: shortDigest } =
		buildVolatileEnrichment(db, enrichmentBaseline, 3, 3);
	// ... splice logic ...
}
```

**New code:**
```typescript
if (headroom < 2000) {
	budgetPressure = true;

	if (enrichmentTiers) {
		// Tier-aware shedding (Phase 5) — operates on structured data, no DB call
		const shedResult = shedMemoryTiers(enrichmentTiers, taskDigestLinesSnapshot, logger);
		if (shedResult.warning) {
			logger?.warn(shedResult.warning);
		}
		const shortEnrichmentLines = buildEnrichmentHeader(shedResult);
		// ... splice into volatile array ...
	} else {
		// Fallback: no tiers available (shouldn't happen after Phase 4, but defensive)
		const { memoryDeltaLines: shortDelta, taskDigestLines: shortDigest } =
			buildVolatileEnrichment(db, enrichmentBaseline, 3, 3);
		// ... existing splice logic ...
	}
}
```

The `enrichmentTiers` variable was stored in Phase 4 (Task 3). The `taskDigestLinesSnapshot` should be captured alongside `allVolatileLines` after the initial enrichment call.

The splice logic (lines 1311-1324) remains the same — it replaces the enrichment section in the volatile message array. The only change is WHERE the reduced enrichment lines come from (shedMemoryTiers instead of a second buildVolatileEnrichment call).

Import `shedMemoryTiers` from `./memory-shedding.js` at the top of context-assembly.ts.

**Verification:**
Run: `bun test packages/agent/src/__tests__/context-assembly.test.ts`
Expected: All existing context assembly tests pass, including the budget pressure test at lines 3638-3698

**Commit:** `feat(agent): wire shedMemoryTiers into Stage 7 budget validation`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Integration tests for tier-aware budget shedding

**Verifies:** hierarchical-memory.AC5.1, hierarchical-memory.AC5.2, hierarchical-memory.AC5.3, hierarchical-memory.AC5.4

**Files:**
- Modify: `packages/agent/src/__tests__/context-assembly.test.ts` (add new describe block)

**Implementation:**

Add a new `describe("hierarchical-memory budget shedding")` block to the existing context-assembly test file. These tests exercise the full pipeline: create memory entries with various tiers, assemble context with a small contextWindow to trigger budget pressure, and verify the output.

**Testing:**

Tests must verify via the full context assembly pipeline:
- **hierarchical-memory.AC5.1:** Insert 5 default-tier memories + 5 summary-tier entries. Set contextWindow small enough to trigger budget pressure. Verify L3 (recency) entries are absent from the assembled context.
- **hierarchical-memory.AC5.2:** Insert enough graph-connected default entries to fill L2 beyond 5. Trigger budget pressure. Verify at most 5 L2 entries in output.
- **hierarchical-memory.AC5.3:** Insert pinned + summary entries. Trigger budget pressure. Verify all L0+L1 entries survive.
- **hierarchical-memory.AC5.4:** Insert many pinned entries (15+) and many summaries (10+). Trigger budget pressure. Verify warning in logs (mock the logger), all entries present.

Follow the existing budget pressure test pattern (lines 3638-3698): create test DB, populate, call `assembleContext()` with restricted `contextWindow`, check `result.debug.budgetPressure === true`.

**Verification:**
Run: `bun test packages/agent/src/__tests__/context-assembly.test.ts`
Expected: All tests pass (new + existing)

Run: `bun test packages/agent`
Expected: All agent tests pass

**Commit:** `test(agent): add integration tests for tier-aware budget shedding (AC5.1-AC5.4)`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
