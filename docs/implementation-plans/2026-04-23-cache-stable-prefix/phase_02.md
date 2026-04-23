# Cache-Stable Prefix Implementation Plan — Phase 2

**Goal:** Factor volatile enrichment out of `assembleContext()` into a standalone function and relocate it from `systemSuffix` to a `developer`-role message at the tail of the messages array. Remove `system_suffix` from `ChatParams`.

**Architecture:** The volatile enrichment (~17k tokens of memory deltas, task digests, cross-thread summaries, etc.) currently lives in `systemSuffix`, which drivers place in system blocks after the cache boundary. Moving it to a `developer` message at the tail of the messages array means it never appears in any cached segment — Bedrock includes all system content in message-level cache keys, so system_suffix busts message caching even when placed after the system cachePoint.

**Tech Stack:** TypeScript, bun:test

**Scope:** 6 phases from original design (this is phase 2 of 6)

**Codebase verified:** 2026-04-23

---

## Acceptance Criteria Coverage

This phase implements and tests:

### cache-stable-prefix.AC2: System suffix moved out of cached prefix
- **cache-stable-prefix.AC2.1 Success:** Volatile enrichment appears as a `developer`-role message at the tail of the messages array, after all `cache` messages
- **cache-stable-prefix.AC2.2 Success:** Bedrock request system blocks contain only `[prefix, cachePoint]` (no suffix block)
- **cache-stable-prefix.AC2.3 Success:** Anthropic request system blocks contain only `[{text, cache_control}]` (no suffix block)
- **cache-stable-prefix.AC2.4 Success:** `system_suffix` field removed from ChatParams; no driver references it
- **cache-stable-prefix.AC2.5 Success:** Volatile enrichment is freshly computed on every turn (warm and cold)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Extract `buildVolatileContext()` from `assembleContext()` Stage 5.5

**Verifies:** cache-stable-prefix.AC2.5

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` (lines 1159-1431 volatile enrichment section)

**Implementation:**

Create a new exported function `buildVolatileContext()` that encapsulates the volatile enrichment construction currently spread across lines 1164-1415 in `assembleContext()`.

The function signature:

```typescript
export interface VolatileContext {
	content: string;
	tokenEstimate: number;
	/** Enrichment section boundaries for budget pressure rebuild */
	enrichmentStartIdx: number;
	enrichmentEndIdx: number;
	/** Snapshot of all volatile lines for budget pressure splicing */
	allVolatileLines: string[];
	/** Memory and task digest lines for tier-aware shedding */
	memoryDeltaLines: string[];
	taskDigestLines: string[];
	/** Tiered enrichment for shedding */
	tiers?: TieredEnrichment;
	/** Cross-thread sources for debug */
	crossThreadSources?: CrossThreadSource[];
	/** Total memory count for header reconstruction */
	totalMemCount: number;
}

export function buildVolatileContext(params: {
	db: Database;
	threadId: string;
	taskId?: string;
	userId: string;
	siteId?: string;
	hostName?: string;
	currentModel?: string;
	relayInfo?: ContextParams["relayInfo"];
	platformContext?: ContextParams["platformContext"];
	systemPromptAddition?: string;
	/** Last user message text for relevance-aware memory boosting */
	userMessageText?: string;
	/** Thread summary for keyword seeding */
	threadSummary?: string;
	/** Referenced inactive skill name, if any */
	inactiveSkillRef?: string;
}): VolatileContext
```

Extract the following logic from `assembleContext()` into `buildVolatileContext()`:
- User ID / Thread ID line (line 1167)
- Relay location info (lines 1170-1173)
- Platform context / silence semantics (lines 1177-1209)
- Current model name (lines 1211-1214)
- Memory delta + enrichment via `buildVolatileEnrichment()` (lines 1216-1269)
- Cross-thread digest (lines 1273-1281)
- File thread notifications (lines 1283-1310)
- Active skill index (lines 1312-1330)
- Operator retirement notifications (lines 1332-1355)
- Advisory resolution notifications (lines 1357-1399)
- Inactive skill reference (lines 1401-1405)
- systemPromptAddition (lines 1407-1411)

The function builds `suffixLines`, computes `enrichmentStartIdx`/`enrichmentEndIdx`, captures `allVolatileLines`, and returns the joined content with a token estimate.

Then refactor `assembleContext()` to call `buildVolatileContext()` instead of inlining this logic. The `noHistory` path (lines 1434-1484) remains separate for now — it has different logic (standalone enrichment system message, no cross-thread digest).

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

Run: `bun test packages/agent/src/__tests__/context-assembly.test.ts`
Expected: All 60+ existing tests pass — this is a pure refactor, no behavioral change yet

**Commit:** `refactor(agent): extract buildVolatileContext from assembleContext Stage 5.5`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Return volatile enrichment as `developer` message instead of `systemSuffix`

**Verifies:** cache-stable-prefix.AC2.1

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` (ContextAssemblyResult interface, return statements)

**Implementation:**

Change `assembleContext()` to append the volatile context as a `developer`-role message at the tail of the messages array, instead of returning it as `systemSuffix`.

1. After calling `buildVolatileContext()`, append a developer message to the assembled messages:

```typescript
const volatile = buildVolatileContext({ /* params */ });
// Append as developer message at tail
assembled.push({
	role: "developer",
	content: volatile.content,
});
```

2. Remove `systemSuffix` from the return type. Update `ContextAssemblyResult`:

```typescript
export interface ContextAssemblyResult {
	messages: LLMMessage[];
	debug: ContextDebugInfo;
	/** Volatile context metadata for warm-path reuse */
	volatileTokenEstimate?: number;
}
```

3. Update both return statements (lines 1755 and 1776) to remove the `systemSuffix` spread.

4. Update the budget pressure `applyReducedEnrichment()` helper (lines 1498-1572). Instead of modifying `suffixContent`, it must now find and replace the developer message at the tail of `assembled`:

```typescript
// Find the developer message at the tail
const devIdx = assembled.findLastIndex((m) => m.role === "developer");
if (devIdx >= 0) {
	// Rebuild volatile content with reduced enrichment
	const rebuiltLines = [
		...volatile.allVolatileLines.slice(0, volatile.enrichmentStartIdx),
		...shortEnrichmentLines,
		...volatile.allVolatileLines.slice(volatile.enrichmentEndIdx),
	];
	assembled[devIdx] = { role: "developer", content: rebuiltLines.join("\n") };
}
```

5. For the `noHistory` path (lines 1434-1484): change the enrichment message from `role: "system"` to `role: "developer"` and append at tail instead of inline.

**Verification:**
Run: `bun test packages/agent/src/__tests__/context-assembly.test.ts`
Expected: Some tests may need updating to expect developer messages instead of systemSuffix. Update test assertions.

Run: `tsc -p packages/agent --noEmit`
Expected: Compilation errors where systemSuffix is referenced — addressed in Task 3

**Commit:** `feat(agent): return volatile enrichment as developer message instead of systemSuffix`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Remove `system_suffix` from ChatParams and all callers

**Verifies:** cache-stable-prefix.AC2.4

**Files:**
- Modify: `packages/llm/src/types.ts` (lines 19-27 ChatParams, lines 144-160 InferenceRequestPayload)
- Modify: `packages/agent/src/agent-loop.ts` (lines 337, 451, 522)
- Modify: `packages/agent/src/relay-processor.ts` (line 1267)
- Modify: `packages/shared/src/relay-schemas.ts` (line 46 if system_suffix is in schema)

**Implementation:**

1. Remove `system_suffix` from `ChatParams` (types.ts line 26 and its JSDoc lines 20-25):

```typescript
// DELETE these lines:
// /**
//  * Varying system context placed AFTER the cached system prefix.
//  * ...
//  */
// system_suffix?: string;
```

2. Remove `system_suffix` from `InferenceRequestPayload` (types.ts line 150):

```typescript
// DELETE: system_suffix?: string;
```

3. In `agent-loop.ts`:
   - Remove `systemSuffix` from the destructured result at line 337
   - Remove `system_suffix: systemSuffix || undefined` from remote payload (line 451)
   - Remove `system_suffix: systemSuffix || undefined` from local chat call (line 522)

4. In `relay-processor.ts`:
   - Remove `system_suffix: payload.system_suffix` from the backend call (line 1267)

5. In `relay-schemas.ts`:
   - Remove `system_suffix` from the relay schema validation if present

6. Search for any remaining `system_suffix` or `systemSuffix` references and remove them.

**IMPORTANT:** Do NOT remove `cache_breakpoints` in this task. The old `cache_breakpoints`-based caching logic in both drivers must continue to function until Phase 4 Task 6 replaces it with cache-message-based caching. Only `system_suffix` is removed here.

**Verification:**
Run: `tsc -p packages/llm --noEmit && tsc -p packages/agent --noEmit && tsc -p packages/shared --noEmit`
Expected: No type errors (all references removed)

Run: `bun test packages/agent packages/llm`
Expected: Tests that reference system_suffix will need updating — see Task 4

**Commit:** `feat(llm): remove system_suffix from ChatParams and InferenceRequestPayload`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Simplify driver system block construction

**Verifies:** cache-stable-prefix.AC2.2, cache-stable-prefix.AC2.3

**Files:**
- Modify: `packages/llm/src/bedrock/convert.ts` (lines 246-278 system blocks)
- Modify: `packages/llm/src/anthropic-driver.ts` (lines 450-484 system handling)

**Implementation:**

**Bedrock** (`toBedrockRequest()` lines 246-278): Remove the three-block layout. System blocks now only need:
- No system → undefined
- System only, no cache → `[{text}]`
- System only, cache → `[{text}, {cachePoint}]`

Remove all `system_suffix` branches. The simplified logic:

```typescript
const systemBlocks: Array<Record<string, unknown>> | undefined = (() => {
	if (!params.system) return undefined;
	const blocks: Array<Record<string, unknown>> = [{ text: params.system }];
	if (hasCacheBreakpoints) blocks.push({ cachePoint: { type: "default" } });
	return blocks;
})();
```

**Anthropic** (`chat()` lines 450-484): Remove the two-block system payload with suffix. Simplify to:
- No system → undefined
- System, no cache → plain string
- System, cache → `[{type: "text", text, cache_control: {type: "ephemeral"}}]`

Remove all `system_suffix` branches:

```typescript
const systemPayload = effectiveSystem && params.cache_breakpoints?.length
	? [{
		type: "text" as const,
		text: effectiveSystem,
		cache_control: { type: "ephemeral" as const },
	}]
	: effectiveSystem;
```

Also remove the `effectiveSystem` suffix concatenation (lines 451-455) since system_suffix no longer exists.

**Verification:**
Run: `bun test packages/llm`
Expected: Update tests that verify three-block system layout. They should now expect two-block layout.

Run: `bun test --recursive`
Expected: All tests pass

**Commit:** `feat(llm): simplify driver system blocks after system_suffix removal`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_5 -->
### Task 5: Update all affected tests

**Verifies:** cache-stable-prefix.AC2.1, cache-stable-prefix.AC2.2, cache-stable-prefix.AC2.3, cache-stable-prefix.AC2.4

**Files:**
- Modify: `packages/agent/src/__tests__/context-assembly.test.ts`
- Modify: `packages/agent/src/__tests__/agent-loop.test.ts`
- Modify: `packages/llm/src/__tests__/anthropic-driver.test.ts`
- Modify: `packages/llm/src/__tests__/bedrock-driver.test.ts`
- Modify: `packages/llm/src/__tests__/cache-stability.test.ts`

**Testing:**

Update existing tests and add new ones:

**context-assembly.test.ts:**
- Tests that previously asserted `result.systemSuffix` must now assert a `developer`-role message at the tail of `result.messages`
- Volatile enrichment tests (lines 2144-2757) must verify the developer message contains the expected content
- Budget pressure tests must verify the developer message is rebuilt correctly after shedding
- **cache-stable-prefix.AC2.1:** Verify developer message is the last message in the array
- **cache-stable-prefix.AC2.5:** Verify volatile content is present and correctly structured

**agent-loop.test.ts:**
- Tests at lines 1758-1857 that verify cache_breakpoints passed to backend — update to not expect system_suffix
- **cache-stable-prefix.AC2.4:** Verify no system_suffix in chat call params

**driver tests:**
- **cache-stable-prefix.AC2.2:** Bedrock system blocks are `[{text}, {cachePoint}]` (no suffix block)
- **cache-stable-prefix.AC2.3:** Anthropic system is `[{text, cache_control}]` (no suffix block)
- Remove tests for three-block system layout
- Update cache-stability.test.ts determinism tests to account for simplified system blocks

**Verification:**
Run: `bun test --recursive`
Expected: All tests pass, zero failures

Run: `bun run typecheck`
Expected: All packages typecheck clean

**Commit:** `test(agent,llm): update tests for developer message and system_suffix removal`
<!-- END_TASK_5 -->
