# Model Robustness Implementation Plan — Phase 3

**Goal:** Tool call identifiers are guaranteed unique within a turn. The Ollama driver synthesizes IDs (previously it used the function name, causing duplicates when the same tool is called twice). The OpenAI-compatible driver synthesizes IDs as a fallback when a delta provides an empty `id`. The agent-loop performs a collision-detection pre-pass over assembled chunks, reassigning any duplicates before the context pipeline runs.

**Architecture:** Driver changes are isolated to each driver's `emitChunkEvents` / `parseOpenAIStream` function. The agent-loop collision detection is a pre-pass in `parseResponseChunks()` — mutates a working copy of the chunks array, does not touch persisted DB rows.

**Tech Stack:** TypeScript 6.x, bun:test

**Scope:** Phase 3 of 7

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### model-robustness.AC6: Tool call identity
- **model-robustness.AC6.1 Success:** Calling the same tool twice in a single Ollama turn produces two distinct tool-use IDs
- **model-robustness.AC6.2 Success:** Calling the same tool twice in a single OpenAI-compatible turn produces two distinct tool-use IDs
- **model-robustness.AC6.3 Success:** Anthropic and Bedrock turns propagate the provider's native IDs unchanged
- **model-robustness.AC6.4 Failure:** Duplicate tool-use IDs detected in a single turn are reassigned and logged as a warning before entering the context pipeline

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Ollama driver — synthesize unique tool call IDs

**Verifies:** model-robustness.AC6.1

**Files:**
- Modify: `packages/llm/src/ollama-driver.ts:120-161` (the `emitChunkEvents` generator)

**Problem:** The current driver uses `toolCall.function.name` as the tool-use ID (e.g., `id: "add"`). If the same tool is called twice in one turn, both calls emit `id: "add"`, causing a collision in the agent loop's `argsAccumulator` map.

**Implementation:**

In `emitChunkEvents`, the function receives `chunk: OllamaStreamResponse`. To synthesize turn-scoped unique IDs, capture a timestamp at the moment the streaming begins (outside the chunk loop) and use a counter for each tool call within the turn. Since `emitChunkEvents` is called per-chunk (it's a `function*` called in a loop), the timestamp and counter need to be managed at the caller level.

Examine how `emitChunkEvents` is called in the driver. If it's called per-chunk in a loop, refactor to pass a turn-scoped counter and timestamp. If it is called once per turn, add them as parameters.

The synthesized ID format: `ollama-{turnTs}-{index}` where:
- `turnTs` = `Date.now()` captured once before the streaming loop starts
- `index` = 0-based counter incremented for each tool call emitted in this turn

**Concrete implementation approach:**

In the `OllamaDriver.chat()` method (wherever `emitChunkEvents` is called in a loop), add:
```typescript
const turnTs = Date.now();
let toolCallIndex = 0;
```

Pass these into `emitChunkEvents` (update its signature):
```typescript
function* emitChunkEvents(
	chunk: OllamaStreamResponse,
	params: ChatParams,     // needed by Phase 2's zero-usage guard
	turnTs: number,
	getNextToolIndex: () => number,
): IterableIterator<StreamChunk> {
```

In the tool call section (currently around lines 128-148), replace:
```typescript
yield {
	type: "tool_use_start",
	id: toolCall.function.name,  // BUG: not unique
	name: toolCall.function.name,
};
yield {
	type: "tool_use_args",
	id: toolCall.function.name,
	partial_json: toolCall.function.arguments,
};
yield {
	type: "tool_use_end",
	id: toolCall.function.name,
};
```

With:
```typescript
const toolId = `ollama-${turnTs}-${getNextToolIndex()}`;
yield {
	type: "tool_use_start",
	id: toolId,
	name: toolCall.function.name,
};
yield {
	type: "tool_use_args",
	id: toolId,
	partial_json: toolCall.function.arguments,
};
yield {
	type: "tool_use_end",
	id: toolId,
};
```

At the call site in `chat()`, pass `() => toolCallIndex++` as `getNextToolIndex`.

**Testing (in `packages/llm/src/__tests__/ollama-driver.test.ts`):**

**Note:** This test file mocks `global.fetch` — MUST save and restore in `afterAll` (check if this is already done before editing).

Add a test: "calling the same tool twice produces distinct IDs":
```typescript
it("calling the same tool twice in one turn produces distinct IDs (AC6.1)", async () => {
    // Mock an Ollama response that calls "search" twice in the same turn
    const ndjson = [
        JSON.stringify({
            model: "llama2",
            created_at: "2024-01-01T00:00:00Z",
            message: {
                role: "assistant",
                content: "",
                tool_calls: [
                    { function: { name: "search", arguments: '{"q":"foo"}' } },
                    { function: { name: "search", arguments: '{"q":"bar"}' } },
                ],
            },
            done: true,
            prompt_eval_count: 5,
            eval_count: 3,
        }),
    ].join("\n");
    // ... mock global.fetch to return ndjson ...
    const chunks = [];
    for await (const chunk of driver.chat({ messages: [], model: "llama2" })) {
        chunks.push(chunk);
    }
    const startChunks = chunks.filter((c) => c.type === "tool_use_start");
    expect(startChunks).toHaveLength(2);
    // Both IDs must be distinct
    const ids = startChunks.map((c) => (c as { id: string }).id);
    expect(ids[0]).not.toEqual(ids[1]);
    // IDs should follow the ollama-{ts}-{index} pattern
    expect(ids[0]).toMatch(/^ollama-\d+-0$/);
    expect(ids[1]).toMatch(/^ollama-\d+-1$/);
});
```

**Verification:**
```bash
bun test packages/llm --test-name-pattern "ollama"
```
Expected: all tests pass, including the new AC6.1 test

**Commit:** `feat(llm/ollama): synthesize unique tool call IDs per turn`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: OpenAI-compatible driver — fallback ID synthesis for empty/missing IDs

**Verifies:** model-robustness.AC6.2

**Files:**
- Modify: `packages/llm/src/openai-driver.ts:130-226` (the `parseOpenAIStream` generator)

**Context:** OpenAI streaming deltas carry an `id` field in the FIRST delta for each tool call. Subsequent deltas for the same tool call may have an empty `id`. The `toolStates` map already handles this correctly for standard OpenAI endpoints. However, OpenAI-compatible backends (e.g., local LLM servers) may not provide IDs at all. The fix: synthesize `openai-{turnTs}-{index}` when `toolCall.id` is absent or empty.

**Implementation:**

In `parseOpenAIStream`, add a turn timestamp and per-turn tool index (the function already gets `params: ChatParams` from the Phase 2 change):
```typescript
async function* parseOpenAIStream(
	response: Response,
	params: ChatParams,
): AsyncIterable<StreamChunk> {
	const toolStates = new Map<number, { id: string; name: string; args: string }>();
	let capturedUsage: OpenAIStreamEvent["usage"] = null;
	let outputText = "";
	const turnTs = Date.now();
	let toolCallIndex = 0;
```

In the tool call delta handler (currently around lines 175-222), when initializing a new tool state (the `!toolStates.has(toolIndex)` branch), synthesize an ID if none is provided:
```typescript
if (!toolStates.has(toolIndex)) {
	// Use provider-supplied ID if present and non-empty; otherwise synthesize
	const providedId = toolCall.id;
	const toolId = providedId ? providedId : `openai-${turnTs}-${toolCallIndex++}`;

	if (toolCall.function?.name) {
		state.id = toolId;
		state.name = toolCall.function.name;
		yield {
			type: "tool_use_start",
			id: toolId,
			name: toolCall.function.name,
		};
	}
}
```

And when retrieving the state for subsequent deltas, use the stored `state.id` (already correct — `toolStates.get(toolIndex)` returns the state with the synthesized ID):
```typescript
const state = toolStates.get(toolIndex) || {
	id: toolCall.id || `openai-${turnTs}-${toolCallIndex++}`,
	name: "",
	args: "",
};
```

Ensure `tool_use_args` and `tool_use_end` use `state.id` (from the map), not `toolCall.id` (from the delta), so the synthesized ID is consistent throughout the tool's lifecycle.

**Testing (in `packages/llm/src/__tests__/openai-driver.test.ts`):**

Add a test for two tool calls:
```typescript
it("two tool calls with distinct IDs from provider produce distinct IDs (AC6.2)", async () => {
    // Mock stream with two tool_use_start events with distinct IDs from provider
    // ...
    const startChunks = chunks.filter(c => c.type === "tool_use_start");
    expect(startChunks).toHaveLength(2);
    const ids = startChunks.map(c => c.id);
    expect(ids[0]).not.toEqual(ids[1]);
});

it("tool calls with missing IDs from provider get synthesized IDs (AC6.2)", async () => {
    // Mock stream where tool_calls deltas have id: "" (empty)
    // ...
    const startChunks = chunks.filter(c => c.type === "tool_use_start");
    expect(startChunks).toHaveLength(2);
    const ids = startChunks.map(c => c.id);
    expect(ids[0]).not.toEqual(ids[1]);
    expect(ids[0]).toMatch(/^openai-\d+-\d+$/);
});
```

**Verification:**
```bash
bun test packages/llm --test-name-pattern "openai"
```
Expected: all tests pass

**Commit:** `feat(llm/openai): synthesize fallback tool call IDs when provider does not supply them`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Agent-loop — collision detection pre-pass in `parseResponseChunks()`

**Verifies:** model-robustness.AC6.3, model-robustness.AC6.4

**Files:**
- Modify: `packages/agent/src/agent-loop.ts:1016-1055` (the `parseResponseChunks()` method)

**Problem:** If duplicate tool-use IDs somehow reach `parseResponseChunks()` (e.g., from an upstream provider bug or a driver that fails to synthesize correctly), the `argsAccumulator` and `nameMap` Maps will silently overwrite earlier entries, causing data loss.

**Solution:** Add a pre-pass that detects duplicate IDs, reassigns them to unique values, and logs a warning. This is a defensive measure — after Phases 1–2, Ollama and OpenAI drivers should produce unique IDs, but this provides a safety net and satisfies AC6.4.

**Implementation:**

Add a collision detection pre-pass at the beginning of `parseResponseChunks()`. The pre-pass rewrites the chunks array (working copy, does not affect persisted data):

```typescript
private parseResponseChunks(chunks: StreamChunk[]): ParsedResponse {
	// Collision detection pre-pass: reassign duplicate tool-use IDs within this turn.
	// This is a defensive measure — drivers should produce unique IDs, but if duplicates
	// slip through, log a warning and reassign rather than silently corrupting data.
	const seenIds = new Set<string>();
	// idRemap: maps original duplicate ID → new synthesized ID.
	// Works correctly for 2+ duplicate IDs because tool_use_args and tool_use_end chunks
	// for a given tool call ALWAYS appear sequentially after their tool_use_start (the LLM
	// streaming protocol guarantees start → args* → end ordering within a single tool call).
	// If the same ID appears a 3rd time (another tool_use_start with the same id), idRemap
	// is overwritten, but by that point the 2nd tool's args/end have already been remapped.
	const idRemap = new Map<string, string>(); // old id → new id (for remapping args/end chunks)
	const remappedChunks = chunks.map((chunk) => {
		if (chunk.type === "tool_use_start") {
			if (seenIds.has(chunk.id)) {
				const newId = `${chunk.id}-dedup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
				this.ctx.logger.warn("[agent-loop] Duplicate tool-use ID detected in turn, reassigning", {
					originalId: chunk.id,
					newId,
				});
				idRemap.set(chunk.id, newId);
				seenIds.add(newId);
				return { ...chunk, id: newId };
			}
			seenIds.add(chunk.id);
		} else if (chunk.type === "tool_use_args" || chunk.type === "tool_use_end") {
			const remappedId = idRemap.get(chunk.id);
			if (remappedId) {
				return { ...chunk, id: remappedId };
			}
		}
		return chunk;
	});

	// Continue with remappedChunks instead of chunks
	let textContent = "";
	const toolCalls: ParsedToolCall[] = [];
	const argsAccumulator = new Map<string, string>();
	const nameMap = new Map<string, string>();
	// ... (existing logic, using remappedChunks) ...
```

**Note on ID remapping:** When a `tool_use_start` with a duplicate ID is found, we need to also remap the subsequent `tool_use_args` and `tool_use_end` chunks that belong to that same tool call. The `idRemap` map handles this: it maps `original_id → new_id` for the LATEST duplicate occurrence. This correctly handles the common case of sequential duplicates (same tool called twice). For interleaved duplicates (less likely), the remapping may be incomplete — but this is an edge case beyond the design scope.

**Testing (in `packages/agent/src/__tests__/agent-loop.test.ts` or a new test file):**

Find the existing agent-loop tests and add a test for collision detection. The test can directly invoke `parseResponseChunks` by making it public/internal-visible for testing, OR by setting up a mock LLM backend that returns chunks with duplicate IDs.

If `parseResponseChunks` is `private`, create a minimal mock backend that yields chunks with duplicate tool IDs, run the agent loop on it, and verify the resulting tool calls have distinct IDs and a warning was logged.

AC6.4 test:
```typescript
it("reassigns duplicate tool-use IDs and logs a warning (AC6.4)", async () => {
    // Set up mock backend that yields:
    //   tool_use_start id="search", tool_use_args id="search", tool_use_end id="search"
    //   tool_use_start id="search", tool_use_args id="search", tool_use_end id="search"
    //   done
    // Run one agent loop turn
    // Assert: two distinct tool calls emitted to executeToolCall
    // Assert: logger.warn called with "Duplicate tool-use ID detected"
});

it("handles 3+ duplicate tool-use IDs correctly (ordering guarantee)", () => {
    // Three back-to-back calls with the same ID: "search"
    // Expected: 3 distinct tool calls — each reassigned correctly
    //   Call 1: id="search" (first seen, no remap)
    //   Call 2: id="search-dedup-..." (remapped)
    //   Call 3: id="search-dedup-..." (remapped to different new id)
    // Assert: all 3 ParsedToolCall items have distinct IDs
    // Assert: logger.warn called 2 times (once per duplicate)
});
```

AC6.3 test (Anthropic/Bedrock propagate native IDs):
```typescript
it("Anthropic native tool IDs are passed through unchanged (AC6.3)", async () => {
    // Mock backend yields tool_use_start with id="toolu_01" and id="toolu_02"
    // Assert: tool calls have ids "toolu_01" and "toolu_02" (no reassignment)
});
```

**Verification:**
```bash
bun test packages/agent
bun test packages/llm
```
Expected: all tests pass

**Commit:** `feat(agent): add collision detection pre-pass for duplicate tool-use IDs in parseResponseChunks`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
