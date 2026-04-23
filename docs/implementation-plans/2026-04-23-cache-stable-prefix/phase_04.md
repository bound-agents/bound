# Cache-Stable Prefix Implementation Plan — Phase 4

**Goal:** Implement the warm/cold path logic in the agent loop — stored turn state, append-only message growth, cache message accumulation, and tool fingerprint change detection.

**Architecture:** The agent loop gains a `CachedTurnState` instance property. Before each outer loop invocation, `predictCacheState()` determines if the cache is warm. If warm and stored state exists with unchanged tool fingerprint, the warm path reuses stored messages and only appends new ones from the DB (by `created_at > lastMessageCreatedAt`). The cold path runs the full `assembleContext()` as before. Both paths inject a fresh `developer` message at the tail for volatile enrichment. Cache messages (`role: "cache"`) are placed: one fixed at the cold-path boundary, one rolling that advances each warm-path turn.

**Tech Stack:** TypeScript, bun:test, bun:sqlite

**Scope:** 6 phases from original design (this is phase 4 of 6)

**Codebase verified:** 2026-04-23

---

## Acceptance Criteria Coverage

This phase implements and tests:

### cache-stable-prefix.AC1: Append-only message history while warm
- **cache-stable-prefix.AC1.1 Success:** Warm-path turn reuses stored messages and appends only new ones; no full reassembly occurs
- **cache-stable-prefix.AC1.2 Success:** Messages[0..fixedCP] are byte-identical (via stableStringify) across 5 consecutive warm-path turns
- **cache-stable-prefix.AC1.3 Success:** Fixed cache message stays at same index across warm turns; rolling cache message advances by 2 each turn
- **cache-stable-prefix.AC1.4 Failure:** Cold path fires when no stored state exists (first invocation)
- **cache-stable-prefix.AC1.5 Edge:** Thread with only 1 message skips cache message placement (fewer than 2 messages)

### cache-stable-prefix.AC3: Cold/high-water full reassembly
- **cache-stable-prefix.AC3.1 Success:** predictCacheState returning cold triggers full assembleContext rebuild
- **cache-stable-prefix.AC3.3 Success:** Tool fingerprint change between turns triggers cold path
- **cache-stable-prefix.AC3.4 Success:** Cold path places single fixed cache message at messages[length-2]
- **cache-stable-prefix.AC3.5 Success:** Cold path stores CachedTurnState for subsequent warm turns

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Define `CachedTurnState` interface and tool fingerprint utility

**Verifies:** None (infrastructure)

**Files:**
- Create: `packages/agent/src/cached-turn-state.ts`

**Implementation:**

Create a new module with the `CachedTurnState` interface and tool fingerprint computation:

```typescript
import type { LLMMessage, ToolDefinition } from "@bound/llm";

export interface CachedTurnState {
	/** The stored messages array from the previous turn */
	messages: LLMMessage[];
	/** The system prompt string (stable content only) */
	systemPrompt: string;
	/** Indices of cache messages in the stored array */
	cacheMessagePositions: number[];
	/** Index of the fixed cache message (set on cold path, never moves while warm) */
	fixedCacheIdx: number;
	/** created_at of the last message in the stored array (for DB delta query) */
	lastMessageCreatedAt: string;
	/** Hash of tool definitions — change triggers cold path */
	toolFingerprint: string;
}

/**
 * Compute a deterministic fingerprint for the current tool set.
 * Uses JSON.stringify with sorted keys to ensure stability.
 */
export function computeToolFingerprint(tools: ToolDefinition[] | undefined): string {
	if (!tools || tools.length === 0) return "empty";
	// Sort by tool name for determinism, then stringify
	const sorted = [...tools].sort((a, b) => a.function.name.localeCompare(b.function.name));
	const key = sorted.map((t) => `${t.function.name}:${JSON.stringify(t.function.parameters)}`).join("|");
	// Use a simple hash — Bun's crypto is available
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(key);
	return hasher.digest("hex").slice(0, 16);
}
```

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add CachedTurnState interface and tool fingerprint utility`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Tests for tool fingerprint computation

**Verifies:** cache-stable-prefix.AC3.3 (tool fingerprint change detection)

**Files:**
- Create: `packages/agent/src/__tests__/cached-turn-state.test.ts`

**Testing:**
- **cache-stable-prefix.AC3.3:** Same tools produce identical fingerprint across calls (deterministic)
- Different tool sets produce different fingerprints
- Tool order doesn't affect fingerprint (sorted internally)
- Empty/undefined tools return "empty" sentinel
- Adding a tool changes the fingerprint
- Changing a tool's parameters changes the fingerprint

**Verification:**
Run: `bun test packages/agent/src/__tests__/cached-turn-state.test.ts`
Expected: All tests pass

**Commit:** `test(agent): add tool fingerprint computation tests`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-5) -->
<!-- START_TASK_3 -->
### Task 3: Add `CachedTurnState` storage to AgentLoop and cold-path logic

**Verifies:** cache-stable-prefix.AC1.4, cache-stable-prefix.AC3.1, cache-stable-prefix.AC3.4, cache-stable-prefix.AC3.5

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` (add private property, refactor outer loop pre-assembly)

**Implementation:**

Add a private property to `AgentLoop` (after `_inferenceTimeoutMs` at line ~155):

```typescript
private _cachedTurnState?: CachedTurnState;
```

Import `CachedTurnState`, `computeToolFingerprint` from the new module, and `predictCacheState`, `selectCacheTtl`, `CACHE_TTL_MS` from cache-prediction.ts.

Refactor the area before the `while (continueLoop)` loop (around lines 320-395). The current flow:
1. `assembleContext()` — always runs
2. Copy messages
3. Enter while loop

The new flow:
1. Determine cache state via `predictCacheState()`
2. Compute tool fingerprint
3. Check if warm path is eligible (stored state exists, fingerprint unchanged)
4. **Cold path**: run `assembleContext()`, place fixed `cache` message at `messages[length-2]`, store `CachedTurnState`
5. **Warm path**: handled in Task 4

For the cold path after `assembleContext()`:
- Extract system messages → systemPrompt (existing logic at lines 430-434)
- Place a fixed `cache` message at `messages[length-2]` (before the last message):

```typescript
// Cold path: place fixed cache message
const fixedCacheIdx = nonSystemMessages.length >= 2 ? nonSystemMessages.length - 2 : -1;
if (fixedCacheIdx >= 0) {
	nonSystemMessages.splice(fixedCacheIdx + 1, 0, { role: "cache", content: "" });
}
```

Wait — the cache message goes at index `messages.length - 2` in the full array (including system messages). But after Phase 3, system messages are extracted separately. The cache message should be placed in the non-system message array relative to its length.

After assembly and system extraction, store the state:

```typescript
this._cachedTurnState = {
	messages: [...nonSystemMessages],
	systemPrompt,
	cacheMessagePositions: fixedCacheIdx >= 0 ? [fixedCacheIdx + 1] : [],
	fixedCacheIdx: fixedCacheIdx >= 0 ? fixedCacheIdx + 1 : -1,
	lastMessageCreatedAt: getLastCreatedAt(contextMessages),
	toolFingerprint: currentFingerprint,
};
```

Note: `LLMMessage` doesn't have a `created_at` field. The cold path should query the DB for the latest `created_at` in the thread:

```typescript
const lastRow = this.ctx.db.query(
	"SELECT created_at FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1"
).get(this.config.threadId) as { created_at: string } | null;
const lastMessageCreatedAt = lastRow?.created_at ?? new Date().toISOString();
```

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

Run: `bun test packages/agent`
Expected: Existing tests pass (cold path is the default when no stored state)

**Commit:** `feat(agent): add CachedTurnState to AgentLoop with cold-path logic`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Implement warm-path logic in agent loop

**Verifies:** cache-stable-prefix.AC1.1, cache-stable-prefix.AC1.3, cache-stable-prefix.AC1.5

**Files:**
- Modify: `packages/agent/src/agent-loop.ts`

**Implementation:**

When the warm path is eligible (stored state exists, cache warm, tool fingerprint unchanged):

1. **Fetch delta messages from DB** — messages created after `lastMessageCreatedAt`:

```typescript
const deltaRows = this.ctx.db.query(
	"SELECT id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin FROM messages WHERE thread_id = ? AND deleted = 0 AND created_at > ? ORDER BY created_at ASC, rowid ASC"
).all(this.config.threadId, this._cachedTurnState.lastMessageCreatedAt) as Message[];
```

2. **Convert and sanitize delta rows** — The warm-path delta messages MUST go through the same sanitization that `assembleContext()` applies in Stages 2-4. Without this, delta messages could contain orphaned tool pairs, unsanitized content blocks, or purge markers that cause driver errors.

**Extract a `sanitizeDeltaMessages()` helper** from the relevant stages of `assembleContext()`:
- **Stage 2 (PURGE_SUBSTITUTION):** Check if any delta messages are purge markers and substitute them
- **Stage 3 (TOOL_PAIR_SANITIZATION):** Ensure tool_call/tool_result pairs are valid — drop orphaned tool_results with no matching tool_call, ensure adjacency
- **Stage 4 (ANNOTATION):** Add timestamp annotations to user messages, model-switch markers

The delta is typically small (2 messages per tool-use cycle: tool_call + tool_result from the previous turn, or user message + assistant response). The sanitization is lightweight on small deltas.

```typescript
// Extract from assembleContext stages 2-4 into a reusable function:
export function sanitizeDeltaMessages(
	messages: Message[],
	previousTailRole?: string,
): LLMMessage[] {
	// 1. Convert DB rows to LLMMessage (parse JSON content for tool_call)
	// 2. Apply purge substitution (Stage 2)
	// 3. Validate tool pairs — drop orphaned results (Stage 3)
	// 4. Add timestamp annotations (Stage 4)
	// Return sanitized LLMMessage[]
}
```

The conversion from DB `Message` rows to `LLMMessage`:

```typescript
const deltaMessages = sanitizeDeltaMessages(deltaRows, lastStoredRole);
```

If extracting a full sanitization helper is too complex for the initial implementation, a minimum viable approach: convert directly and validate tool pairs:

```typescript
const deltaMessages: LLMMessage[] = deltaRows.map((row) => ({
	role: row.role as LLMMessage["role"],
	content: row.content,
	tool_use_id: row.tool_name ?? undefined,
	model_id: row.model_id ?? undefined,
	host_origin: row.host_origin ?? undefined,
}));
// Validate: if first delta is tool_result, ensure previous stored message is tool_call
// Drop any orphaned tool_results at the start of the delta
```

3. **Append delta to stored messages**, removing the old developer tail and rolling cache:

```typescript
// Remove old developer message at tail (will be replaced with fresh one)
const storedMessages = [...this._cachedTurnState.messages];
const lastIdx = storedMessages.length - 1;
if (storedMessages[lastIdx]?.role === "developer") {
	storedMessages.pop();
}

// Append delta messages
storedMessages.push(...deltaMessages);

// Place rolling cache message at messages[length-2] (before the last delta message)
if (storedMessages.length >= 2) {
	storedMessages.splice(storedMessages.length - 1, 0, { role: "cache", content: "" });
}
```

4. **Inject fresh volatile developer message at tail**:

```typescript
const volatile = buildVolatileContext({ /* params from this loop iteration */ });
storedMessages.push({ role: "developer", content: volatile.content });
```

5. **Update stored state**:

```typescript
const newLastRow = this.ctx.db.query(
	"SELECT created_at FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1"
).get(this.config.threadId) as { created_at: string } | null;

this._cachedTurnState = {
	...this._cachedTurnState,
	messages: storedMessages,
	cacheMessagePositions: [
		...this._cachedTurnState.cacheMessagePositions,
		storedMessages.length - 2, // rolling cache position
	],
	lastMessageCreatedAt: newLastRow?.created_at ?? new Date().toISOString(),
};
```

6. **Use the warm-path messages for the LLM call** instead of assembleContext results.

**Edge case (AC1.5):** If the stored messages + delta have fewer than 2 messages, skip cache message placement.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

Run: `bun test packages/agent`
Expected: Existing tests pass

**Commit:** `feat(agent): implement warm-path append-only message reuse`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Tests for warm/cold path selection and message accumulation

**Verifies:** cache-stable-prefix.AC1.1, cache-stable-prefix.AC1.2, cache-stable-prefix.AC1.3, cache-stable-prefix.AC1.4, cache-stable-prefix.AC1.5, cache-stable-prefix.AC3.1, cache-stable-prefix.AC3.3, cache-stable-prefix.AC3.4, cache-stable-prefix.AC3.5

**Files:**
- Create: `packages/agent/src/__tests__/warm-cold-path.test.ts`
- Modify: `packages/agent/src/__tests__/agent-loop.test.ts`

**Testing:**

Create `warm-cold-path.test.ts` with a mock LLM backend to test the path selection logic:

Tests must verify each AC:
- **cache-stable-prefix.AC1.1:** Warm-path turn reuses stored messages and appends only new ones. Mock `predictCacheState` to return "warm", verify `assembleContext` is NOT called on the second turn.
- **cache-stable-prefix.AC1.2:** Messages[0..fixedCP] are byte-identical across 5 consecutive warm-path turns. Use `stableStringify` to compare prefix segments.
- **cache-stable-prefix.AC1.3:** Fixed cache message stays at same index across warm turns. Rolling cache message advances by 2 each turn (one tool_call + one tool_result per turn).
- **cache-stable-prefix.AC1.4:** Cold path fires when no stored state exists (first invocation). Verify `assembleContext` IS called on first turn.
- **cache-stable-prefix.AC1.5:** Thread with only 1 message — no cache messages placed.
- **cache-stable-prefix.AC3.1:** `predictCacheState` returning "cold" triggers full assembleContext rebuild even when stored state exists.
- **cache-stable-prefix.AC3.3:** Tool fingerprint change between turns triggers cold path.
- **cache-stable-prefix.AC3.4:** Cold path places fixed cache message at `messages[length-2]`.
- **cache-stable-prefix.AC3.5:** Cold path stores `CachedTurnState` for subsequent warm turns.

Follow existing agent-loop test patterns: use `MockBackend` implementing `LLMBackend` with `setTextResponse()`/`setToolThenTextResponse()`.

**Verification:**
Run: `bun test packages/agent/src/__tests__/warm-cold-path.test.ts`
Expected: All tests pass

Run: `bun test packages/agent`
Expected: All tests pass, no regressions

**Commit:** `test(agent): add warm/cold path selection and accumulation tests`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_6 -->
### Task 6: Remove `cache_breakpoints` and update all drivers/relay for cache-message-based caching

**Verifies:** None (cleanup, but critical for correctness)

**Files:**
- Modify: `packages/llm/src/types.ts` (remove `cache_breakpoints` from ChatParams and InferenceRequestPayload, remove `cache_ttl`)
- Modify: `packages/agent/src/agent-loop.ts` (remove cache_breakpoints computation at lines 502-503, remove from chat call)
- Modify: `packages/llm/src/bedrock/convert.ts` (remove old cachePoint placement at lines 233-244 that uses cache_breakpoints)
- Modify: `packages/llm/src/anthropic-driver.ts` (remove old cache_control placement at lines 441-448, update beta header gating at lines 514-516)
- Modify: `packages/agent/src/relay-processor.ts` (remove `cache_breakpoints` passthrough at line 1270)
- Modify: `packages/shared/src/relay-schemas.ts` (remove `cache_breakpoints` from relay schema)
- Modify: All affected test files

**Implementation:**

This task consolidates the complete removal of the old `cache_breakpoints`-based caching mechanism, now superseded by `cache` role messages from Phase 1.

**Step 1: Remove from types.ts**

Remove `cache_breakpoints` field from `ChatParams` (line 27) and its JSDoc.
Remove `cache_ttl` field (lines 29-33) — deprecated and unimplemented.
Remove `cache_breakpoints` from `InferenceRequestPayload` (line 153).

**Step 2: Remove old Bedrock cachePoint placement**

In `toBedrockRequest()` (convert.ts lines 233-244), remove the block that places cachePoint based on `cache_breakpoints`:

```typescript
// DELETE this entire block:
if (params.cache_breakpoints && params.cache_breakpoints.length > 0 && messages.length >= 2) {
	const idx = messages.length - 2;
	const m = messages[idx];
	if (Array.isArray(m.content)) {
		(m.content as Array<Record<string, unknown>>).push({
			cachePoint: { type: "default" },
		});
	}
}
```

The new `cache` role handling from Phase 1 Task 3 now handles cachePoint placement.

Also simplify `hasCacheBreakpoints` usage in system blocks — replace with a check for `cache` messages in the input:

```typescript
const hasCacheMessages = params.messages.some((m) => m.role === "cache");
```

**Step 3: Remove old Anthropic cache_control placement and update beta header**

In `chat()` (anthropic-driver.ts):

Remove the old cache_control block (lines 441-448):
```typescript
// DELETE this block:
if (params.cache_breakpoints && ...) {
	const idx = anthropicMessages.length - 2;
	anthropicMessages[idx].cache_control = { type: "ephemeral" };
}
```

**CRITICAL: Update beta header gating** (lines 514-516). Change from:
```typescript
if (params.cache_breakpoints?.length) {
	headers["anthropic-beta"] = "prompt-caching-2024-07-31";
}
```
To:
```typescript
const hasCacheMessages = params.messages.some((m) => m.role === "cache");
if (hasCacheMessages) {
	headers["anthropic-beta"] = "prompt-caching-2024-07-31";
}
```

Also update the system payload gating to use `hasCacheMessages` instead of `params.cache_breakpoints?.length`.

**Step 4: Remove from agent-loop.ts**

Remove the cache_breakpoints computation at lines 502-503 and stop passing it to `backend.chat()`.

**Step 5: Remove from relay path**

In `relay-processor.ts` (line 1270): remove `cache_breakpoints: payload.cache_breakpoints`.
In `relay-schemas.ts` (line 46): remove `cache_breakpoints` from the schema.

**Step 6: Update all tests**

Search for all `cache_breakpoints` in test files and update:
- `agent-loop.test.ts`: Remove tests that verify cache_breakpoints passing
- `cache-stability.test.ts`: Update `makeInput()` helper — remove `cache_breakpoints` from default input, add `cache` role messages instead
- `anthropic-driver.test.ts`: Update cache-related tests
- `bedrock-driver.test.ts`: Update cache-related tests
- `relay-stream.integration.test.ts`: Remove cache_breakpoints from payloads

**Verification:**
Run: `bun test --recursive`
Expected: All tests pass

Run: `bun run typecheck`
Expected: All packages typecheck clean

**Commit:** `refactor(llm,agent): remove legacy cache_breakpoints in favor of cache role messages`
<!-- END_TASK_6 -->
