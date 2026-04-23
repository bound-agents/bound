# Cache-Stable Prefix Implementation Plan — Phase 6

**Goal:** End-to-end verification that the cache-stable prefix produces the expected improvements. Add integration tests, update debug logging, and run a full regression sweep.

**Architecture:** This phase adds comprehensive test coverage across three layers: (1) driver-level tests for `cache` and `developer` message materialization in the existing `cache-stability.test.ts`, (2) agent-loop integration tests simulating multi-turn warm/cold path cycles, and (3) updated debug logging to report warm/cold path selection and cachePoint positions.

**Tech Stack:** TypeScript, bun:test

**Scope:** 6 phases from original design (this is phase 6 of 6)

**Codebase verified:** 2026-04-23

---

## Acceptance Criteria Coverage

This phase implements and tests:

### cache-stable-prefix.AC5: Unit tests enforcing invariants
- **cache-stable-prefix.AC5.1 Success:** Tests exist for each AC in AC1-AC4 and AC6
- **cache-stable-prefix.AC5.2 Success:** Existing test suites pass with no regressions

---

<!-- START_TASK_1 -->
### Task 1: Extend cache-stability.test.ts with multi-turn warm-path prefix stability tests

**Verifies:** cache-stable-prefix.AC5.1 (tests for AC1.2, AC1.3, AC4.1, AC4.2, AC4.9, AC4.10)

**Files:**
- Modify: `packages/llm/src/__tests__/cache-stability.test.ts`

**Testing:**

Add new describe blocks to the existing 599-line test file:

**`describe("cache stability: developer and cache role handling")`:**
- `toBedrockRequest` with `cache` messages produces cachePoint on previous message content
- `toBedrockRequest` with `developer` messages maps to user-message prepend in `<system-context>`
- `toBedrockRequest` with cache messages + tools places cachePoint in toolConfig
- Anthropic `toAnthropicMessages` with `cache` messages adds cache_control to previous message
- Anthropic with `developer` messages maps to user-message prepend
- Anthropic with cache messages + tools places cache_control on last tool

**`describe("cache stability: warm-path prefix preservation with cache messages")`:**
- Simulate the warm-path by building a message array, appending 2 messages (tool_call + tool_result), inserting a rolling cache message, and verifying the prefix is byte-identical via `stableStringify()`.
- Run 5 iterations. After each append:
  - Fixed cache message stays at original index
  - Rolling cache message is at `messages.length - 2`
  - Prefix up to fixed cache is identical to previous turn
- Verify cachePoint accumulation: after 5 warm-path turns, there should be 2 cache messages in the message array (1 fixed + 1 rolling that was advanced 5 times, but only the latest rolling remains).

Follow existing patterns: use `makeInput()`, `stableStringify()`, `toBedrockRequest()`.

**Verification:**
Run: `bun test packages/llm/src/__tests__/cache-stability.test.ts`
Expected: All 27+ existing tests pass, new tests pass

**Commit:** `test(llm): add cache-stability tests for developer/cache roles and warm-path prefix`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Agent loop integration tests simulating multiple loop invocations

**Verifies:** cache-stable-prefix.AC5.1 (tests for AC1.1, AC1.4, AC2.5, AC3.1, AC3.3, AC3.5)

**Files:**
- Modify: `packages/agent/src/__tests__/warm-cold-path.test.ts` (created in Phase 4)

**Testing:**

Add a `describe("integration: multi-invocation warm/cold cycles")` block that:

1. Creates a real DB, inserts test data, creates an AgentLoop with MockLLMBackend
2. Runs the agent loop twice (first invocation = cold, second = warm if cache is warm)
3. Verifies:
   - **AC1.1:** Second invocation with warm cache doesn't call `assembleContext` (verify via mock/spy)
   - **AC1.4:** First invocation always takes cold path
   - **AC2.5:** Volatile developer message at tail is fresh on every turn (content differs if DB state changes)
   - **AC3.1:** When `predictCacheState` returns cold, full reassembly occurs
   - **AC3.3:** Changing tools between invocations forces cold path
   - **AC3.5:** After cold path, `CachedTurnState` is stored (verify by checking second invocation takes warm path)

Use the existing agent-loop test setup pattern:
- `MockLLMBackend` with `setTextResponse()` / `setToolThenTextResponse()`
- `makeCtx()` for AppContext
- Fresh `threadId` per test
- Real SQLite DB with schema applied

**Verification:**
Run: `bun test packages/agent/src/__tests__/warm-cold-path.test.ts`
Expected: All tests pass

**Commit:** `test(agent): add multi-invocation warm/cold cycle integration tests`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Update debug logging for warm/cold path

**Verifies:** None (infrastructure — observability)

**Files:**
- Modify: `packages/llm/src/bedrock-driver.ts` (lines 86-134 emitCacheDebug — note: main driver file, not bedrock/convert.ts)
- Modify: `packages/agent/src/agent-loop.ts` (warm/cold path logging)

**Implementation:**

**Bedrock driver** — Update `emitCacheDebug()` to include new fields when `BOUND_DEBUG_BEDROCK_CACHE` is set:

Add fields for:
- `cacheMessageCount`: number of `cache` role messages materialized as cachePoints
- `developerMessageCount`: number of `developer` role messages mapped to user prepend
- `toolConfigCached`: boolean — whether toolConfig has a cachePoint

These fields help diagnose cache stability by showing how many cache markers were placed.

**Agent loop** — Add logging at the warm/cold path decision point:

```typescript
this.ctx.logger.info("[agent-loop] Cache path selected", {
	path: usedWarmPath ? "warm" : "cold",
	reason: !this._cachedTurnState ? "no-stored-state"
		: cacheState === "cold" ? "cache-expired"
		: !fingerprintMatch ? "tool-change"
		: estimatedTotal > contextWindow ? "budget-exceeded"
		: "warm-eligible",
	storedMessageCount: this._cachedTurnState?.messages.length,
	deltaMessageCount: deltaRows?.length,
	cacheMessagePositions: this._cachedTurnState?.cacheMessagePositions,
});
```

**Verification:**
Run: `bun test packages/llm packages/agent`
Expected: All tests pass (logging changes don't affect behavior)

**Commit:** `feat(llm,agent): update debug logging for warm/cold path and cache messages`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Full regression test sweep

**Verifies:** cache-stable-prefix.AC5.2

**Files:** None (verification only)

**Step 1: Run all tests**

Run: `bun test --recursive`
Expected: Exit code 0, all tests pass

**Step 2: Typecheck all packages**

Run: `bun run typecheck`
Expected: All packages typecheck clean

**Step 3: Lint check**

Run: `bun run lint`
Expected: No lint errors

If any failures, fix before proceeding. This is the final verification that all 6 phases integrate correctly.

**Commit:** No commit needed if all passes. If fixes required: `fix: resolve integration regressions`
<!-- END_TASK_4 -->
