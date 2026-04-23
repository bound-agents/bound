# Cache-Stable Prefix Implementation Plan — Phase 5

**Goal:** Implement the context budget check that triggers cold reassembly when warm-path growth exceeds the context window, and verify that cold-path assembly leaves adequate headroom.

**Architecture:** Before each warm-path append, estimate the total token count: stored messages + new delta messages + volatile developer message + tool tokens. If this exceeds `contextWindow`, fall through to cold path. The cold path already targets `TRUNCATION_TARGET_RATIO` (0.85) of the context window via truncation, leaving 15% headroom for warm-path growth. At 200k context window, this is ~30k tokens — enough for 20+ turns at ~500 tokens/turn.

**Tech Stack:** TypeScript, bun:test

**Scope:** 6 phases from original design (this is phase 5 of 6)

**Codebase verified:** 2026-04-23

---

## Acceptance Criteria Coverage

This phase implements and tests:

### cache-stable-prefix.AC3: Cold/high-water full reassembly
- **cache-stable-prefix.AC3.2 Success:** Context exceeding contextWindow on warm path triggers cold reassembly

### cache-stable-prefix.AC6: High-water mark headroom
- **cache-stable-prefix.AC6.1 Success:** Cold-path assembly targets 0.85 of contextWindow
- **cache-stable-prefix.AC6.2 Success:** At 200k contextWindow, at least 20 warm-path turns (at ~500 tok/turn) fit before high-water triggers
- **cache-stable-prefix.AC6.3 Failure:** Initial cold-path assembly on a long thread does not immediately exceed contextWindow (truncation handles it)
- **cache-stable-prefix.AC6.4 Edge:** Thread that grows rapidly (large tool results) triggers cold reassembly within a few turns rather than overflowing

---

<!-- START_TASK_1 -->
### Task 1: Add high-water mark check to warm path

**Verifies:** cache-stable-prefix.AC3.2, cache-stable-prefix.AC6.4

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` (warm-path branch from Phase 4)

**Implementation:**

In the warm-path branch (added in Phase 4 Task 4), before finalizing the warm-path messages, estimate the total context size and check against `contextWindow`:

```typescript
import { countContentTokens, countTokens } from "@bound/shared";

// Estimate total token count for the warm-path result
const storedTokens = storedMessages.reduce(
	(sum, msg) => sum + countContentTokens(msg.content), 0
);
const volatileTokens = volatile.tokenEstimate;
const toolTokens = toolTokenEstimate;
const estimatedTotal = storedTokens + volatileTokens + toolTokens;

if (estimatedTotal > contextWindow) {
	// High-water mark exceeded — fall through to cold path
	this.ctx.logger.info("[agent-loop] Warm path exceeded context budget, triggering cold reassembly", {
		estimatedTotal,
		contextWindow,
		storedTokens,
		volatileTokens,
		toolTokens,
	});
	// Clear cached state to force cold path
	this._cachedTurnState = undefined;
	// Fall through to cold-path assembly below
}
```

The warm-path block should be structured so that if the budget check fails, execution falls through to the cold-path block (which runs `assembleContext()` as normal).

Structure:

```typescript
let usedWarmPath = false;

if (cacheState === "warm" && this._cachedTurnState && fingerprintMatch) {
	// ... warm path logic (delta fetch, append, volatile injection) ...

	const estimatedTotal = /* computed above */;
	if (estimatedTotal <= contextWindow) {
		// Warm path succeeded
		usedWarmPath = true;
		llmMessages = storedMessages;
		// ... use warm-path messages
	} else {
		// Fall through to cold path
		this._cachedTurnState = undefined;
	}
}

if (!usedWarmPath) {
	// Cold path: full assembleContext()
	const { messages: contextMessages, debug: contextDebug } = assembleContext({ ... });
	// ... existing cold path logic from Phase 4
}
```

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

Run: `bun test packages/agent`
Expected: All existing tests pass

**Commit:** `feat(agent): add high-water mark budget check to warm path`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Export TRUNCATION_TARGET_RATIO as module constant

**Verifies:** cache-stable-prefix.AC6.1

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` (line 1632)

**Implementation:**

The `TRUNCATION_TARGET_RATIO` constant is currently defined locally inside the truncation block at line 1632. Export it as a module-level constant so tests and the warm-path logic can reference it:

```typescript
/** The cold path targets this fraction of contextWindow, leaving headroom for warm-path growth. */
export const TRUNCATION_TARGET_RATIO = 0.85;
```

Move from line 1632 to the top of the file (after imports, before interfaces). Update the local reference at line 1633 to use the module-level constant.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

Run: `bun test packages/agent/src/__tests__/context-assembly.test.ts`
Expected: All tests pass

**Commit:** `refactor(agent): export TRUNCATION_TARGET_RATIO as module constant`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Tests for high-water mark and headroom

**Verifies:** cache-stable-prefix.AC3.2, cache-stable-prefix.AC6.1, cache-stable-prefix.AC6.2, cache-stable-prefix.AC6.3, cache-stable-prefix.AC6.4

**Files:**
- Modify: `packages/agent/src/__tests__/warm-cold-path.test.ts` (created in Phase 4)
- Modify: `packages/agent/src/__tests__/context-assembly.test.ts`

**Testing:**

Add a new `describe("high-water mark and headroom")` block in `warm-cold-path.test.ts`:

- **cache-stable-prefix.AC3.2:** Simulate warm path where appended delta messages push total above contextWindow. Verify cold path fires.
- **cache-stable-prefix.AC6.1:** Verify cold-path assembly targets 0.85 of contextWindow. After cold-path runs, the total token estimate should be <= 0.85 * contextWindow.
- **cache-stable-prefix.AC6.2:** With contextWindow=200000, simulate 20 warm-path turns of ~500 tokens each. Verify all 20 succeed without triggering cold reassembly. 20 turns × 500 tokens = 10k tokens, well within 15% headroom (30k tokens).
- **cache-stable-prefix.AC6.3:** Create a thread with many messages. Verify initial cold-path assembly doesn't immediately exceed contextWindow — truncation handles it. The total token count after assembly should be <= contextWindow.
- **cache-stable-prefix.AC6.4:** Simulate a thread where each turn adds large tool results (~5k tokens). Verify cold reassembly triggers within a few turns rather than overflowing.

In `context-assembly.test.ts`:
- Verify TRUNCATION_TARGET_RATIO is 0.85 (import and assert).
- Existing truncation tests (lines 1290-1418) already verify headroom behavior — ensure they still pass.

**Verification:**
Run: `bun test packages/agent/src/__tests__/warm-cold-path.test.ts`
Expected: All tests pass

Run: `bun test packages/agent`
Expected: All tests pass, no regressions

**Commit:** `test(agent): add high-water mark and headroom tests`
<!-- END_TASK_3 -->
