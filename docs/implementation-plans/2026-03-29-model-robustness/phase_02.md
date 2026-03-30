# Model Robustness Implementation Plan — Phase 2

**Goal:** All four LLM drivers report cache-specific token counts where the provider exposes them. The `turns` table gains `tokens_cache_write` and `tokens_cache_read` columns. A zero-usage guard prevents silent zero-cost records by estimating tokens from character counts when a provider returns all zeros on a non-empty response.

**Architecture:** Extends `StreamChunk.done.usage` with three new fields (`cache_write_tokens`, `cache_read_tokens`, `estimated`). Each driver extracts provider-specific cache fields from its stream or response events. `metrics-schema.ts` gains two idempotent `ALTER TABLE` additions and `TurnRecord` is updated. `agent-loop.ts` propagates the new fields to `recordTurn()`.

**API-verified field names (from official documentation):**
- Anthropic `message_start.message.usage`: `cache_creation_input_tokens` (write), `cache_read_input_tokens` (read)
- Bedrock `metadata.usage`: `cacheWriteInputTokens` (write), `cacheReadInputTokens` (read) — NOTE: Design doc says `...Count` suffix, but actual Bedrock API uses `...Tokens` suffix
- OpenAI final chunk `usage.prompt_tokens_details`: `cached_tokens` (read only); requires `stream_options: { include_usage: true }` in request
- Ollama: no cache fields — always `null`

**Tech Stack:** TypeScript 6.x, bun:test, bun:sqlite

**Scope:** Phase 2 of 7

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### model-robustness.AC4: Cache-aware token usage
- **model-robustness.AC4.1 Success:** Anthropic driver emits non-null `cache_write_tokens` and `cache_read_tokens` when provider returns those fields
- **model-robustness.AC4.2 Success:** Bedrock driver emits non-null cache token fields when `ConverseStream` metadata includes them
- **model-robustness.AC4.3 Success:** OpenAI driver emits non-null `cache_read_tokens` when `prompt_tokens_details.cached_tokens` is present
- **model-robustness.AC4.4 Success:** Ollama driver always emits `cache_write_tokens: null, cache_read_tokens: null`
- **model-robustness.AC4.5 Failure:** Non-empty response with all-zero token counts triggers char-ratio fallback and sets `estimated: true`
- **model-robustness.AC4.6 Success:** `turns` table gains `tokens_cache_write` and `tokens_cache_read` columns; values are persisted from the `done` chunk

---

<!-- START_SUBCOMPONENT_A (tasks 1-1) -->

<!-- START_TASK_1 -->
### Task 1: Extend `StreamChunk.done` usage type in `packages/llm/src/types.ts`

**Verifies:** None (type-only task enabling all subsequent driver changes)

**Files:**
- Modify: `packages/llm/src/types.ts:35` (the `done` variant of `StreamChunk`)

**Implementation:**

Replace the current `done` variant (line 35):
```typescript
| { type: "done"; usage: { input_tokens: number; output_tokens: number } }
```

With:
```typescript
| {
	type: "done";
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_write_tokens: number | null;
		cache_read_tokens: number | null;
		estimated: boolean;
	};
  }
```

The `null` type for cache fields means "provider does not expose this metric" — distinct from `0` which would mean "provider confirmed no cache activity."

**Note:** Do NOT run `tsc` verification after this task alone — TypeScript will report errors in all four driver files since they emit `done` chunks without the three new required fields. This is expected. Proceed immediately to tasks 2–5, which fix those errors. The typecheck verification at the end of Task 8 covers the full phase.

**Commit:** `feat(llm): extend StreamChunk done usage with cache token fields`
<!-- END_TASK_1 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 2-5) -->

<!-- START_TASK_2 -->
### Task 2: Anthropic driver — cache token extraction and zero-usage guard

**Verifies:** model-robustness.AC4.1, model-robustness.AC4.5

**Files:**
- Modify: `packages/llm/src/anthropic-driver.ts:180-283` (the `parseAnthropicStream` generator function)

**Implementation:**

In `parseAnthropicStream` (the generator function that is called from the `AnthropicDriver.chat()` method around line 179), extend the token tracking variables and extraction logic:

```typescript
// Add alongside existing let inputTokens = 0; outputTokens = 0; (lines 182-183)
let cacheWriteTokens: number | null = null;
let cacheReadTokens: number | null = null;
let outputText = ""; // Track for zero-usage guard
```

In the `message_start` handler (currently lines 206-209), also extract cache fields:
```typescript
if (event.type === "message_start" && event.message?.usage) {
	const usage = event.message.usage as Record<string, unknown>;
	inputTokens = (usage.input_tokens as number) || 0;
	const cw = usage.cache_creation_input_tokens;
	const cr = usage.cache_read_input_tokens;
	if (typeof cw === "number") cacheWriteTokens = cw;
	if (typeof cr === "number") cacheReadTokens = cr;
}
```

In the text delta handler (lines 218-224), accumulate output text for the zero-usage guard:
```typescript
if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
	const text = event.delta.text || "";
	outputText += text;
	yield { type: "text", content: text };
}
```

Replace the `message_stop` done chunk emission (lines 273-282) with:
```typescript
if (event.type === "message_stop") {
	// Zero-usage guard: if tokens are zero but there is output, estimate from char counts
	let estimated = false;
	if (inputTokens === 0 && outputTokens === 0 && outputText.length > 0) {
		inputTokens = Math.ceil(
			params.messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0) / 4,
		);
		outputTokens = Math.ceil(outputText.length / 4);
		estimated = true;
	}
	yield {
		type: "done",
		usage: {
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			cache_write_tokens: cacheWriteTokens,
			cache_read_tokens: cacheReadTokens,
			estimated,
		},
	};
}
```

**Important:** The `parseAnthropicStream` function must receive `params: ChatParams` (for the zero-usage guard's input message estimation). Check how it is called from `AnthropicDriver.chat()` — pass `params` to it if it does not already receive it. Inspect the function signature and calling code before editing.

**Testing (in `packages/llm/src/__tests__/anthropic-driver.test.ts`):**

The test file currently has a `"should parse SSE stream correctly"` test (around lines 247-317). Add cache token tests alongside it. The test mocks `global.fetch` (or equivalent) to return mock SSE events.

Add a `describe("cache token extraction")` block with:

1. **AC4.1 — cache tokens present:** Mock a `message_start` event where `usage` includes `cache_creation_input_tokens: 150` and `cache_read_input_tokens: 200`. Assert the `done` chunk has `cache_write_tokens: 150` and `cache_read_tokens: 200`.

2. **AC4.5 — zero-usage guard:** Mock a `message_start` with zero tokens, a `content_block_delta` with `text_delta` content, and a `message_stop`. Assert that the `done` chunk has `estimated: true` and non-zero `input_tokens`/`output_tokens`.

3. **Normal case — no cache:** Mock `message_start` with only `input_tokens` set, no cache fields. Assert `done` chunk has `cache_write_tokens: null` and `cache_read_tokens: null` and `estimated: false`.

**Verification:**
```bash
bun test packages/llm --test-name-pattern "anthropic"
```
Expected: all tests pass, including new cache tests

**Commit:** `feat(llm/anthropic): extract cache tokens, add zero-usage guard`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Bedrock driver — cache token extraction and zero-usage guard

**Verifies:** model-robustness.AC4.2, model-robustness.AC4.5

**Files:**
- Modify: `packages/llm/src/bedrock-driver.ts:234-242` (the `metadata` event handler in the streaming section)

**Implementation:**

The Bedrock driver currently extracts token counts at the `metadata` event (lines 234-242):
```typescript
} else if (event.metadata) {
	const usage = event.metadata.usage;
	yield {
		type: "done",
		usage: {
			input_tokens: usage?.inputTokens ?? 0,
			output_tokens: usage?.outputTokens ?? 0,
		},
	};
}
```

Also track output text for the zero-usage guard (add accumulation wherever text content is yielded in the Bedrock driver's streaming section — look for where `type: "text"` chunks are yielded and add `outputText += content`).

Replace the `done` chunk emission with:
```typescript
} else if (event.metadata) {
	const usage = event.metadata.usage as Record<string, unknown> | undefined;
	let inputTokens = (usage?.inputTokens as number) ?? 0;
	let outputTokens = (usage?.outputTokens as number) ?? 0;
	const cw = usage?.cacheWriteInputTokens; // NOTE: "Tokens" not "Count" per AWS API
	const cr = usage?.cacheReadInputTokens;  // NOTE: "Tokens" not "Count" per AWS API
	const cacheWriteTokens = typeof cw === "number" ? cw : null;
	const cacheReadTokens = typeof cr === "number" ? cr : null;

	// Zero-usage guard
	let estimated = false;
	if (inputTokens === 0 && outputTokens === 0 && outputText.length > 0) {
		inputTokens = Math.ceil(
			params.messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0) / 4,
		);
		outputTokens = Math.ceil(outputText.length / 4);
		estimated = true;
	}
	yield {
		type: "done",
		usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_write_tokens: cacheWriteTokens, cache_read_tokens: cacheReadTokens, estimated },
	};
}
```

Declare `let outputText = ""` at the start of the streaming section and accumulate it wherever text chunks are yielded.

**Testing (in `packages/llm/src/__tests__/bedrock-driver.test.ts`):**

The existing test at lines 69-95 mocks `BedrockRuntimeClient.prototype.send` with `{ inputTokens: 10, outputTokens: 5 }` in the metadata event. Extend this test and add new ones:

1. **AC4.2 — cache tokens present:** Add `cacheWriteInputTokens: 80, cacheReadInputTokens: 120` to the mocked `metadata.usage`. Assert `done` chunk has `cache_write_tokens: 80` and `cache_read_tokens: 120`.

2. **AC4.5 — zero-usage guard:** Mock metadata with `inputTokens: 0, outputTokens: 0` and a text chunk in the stream. Assert `done` has `estimated: true`.

3. **Normal case — no cache:** Mock metadata with only `inputTokens`/`outputTokens`. Assert `cache_write_tokens: null`, `cache_read_tokens: null`, `estimated: false`.

**Verification:**
```bash
bun test packages/llm --test-name-pattern "bedrock"
```
Expected: all tests pass

**Commit:** `feat(llm/bedrock): extract cache tokens, add zero-usage guard`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: OpenAI driver — real token extraction via `stream_options`, cache tokens, zero-usage guard

**Verifies:** model-robustness.AC4.3, model-robustness.AC4.5

**Files:**
- Modify: `packages/llm/src/openai-driver.ts:25-57` (add `stream_options` to `OpenAIRequest` interface)
- Modify: `packages/llm/src/openai-driver.ts:41-57` (add `usage` field to `OpenAIStreamEvent` interface)
- Modify: `packages/llm/src/openai-driver.ts:130-226` (update `parseOpenAIStream` to capture usage from final chunk)
- Modify: `packages/llm/src/openai-driver.ts:249-255` (add `stream_options` to request body in `chat()`)

**Implementation:**

**1. Update `OpenAIRequest` interface to include `stream_options`:**
```typescript
interface OpenAIRequest {
	model: string;
	messages: OpenAIMessage[];
	stream: boolean;
	stream_options?: { include_usage: boolean };
	temperature?: number;
	max_tokens?: number;
	tools?: Array<{...}>;
}
```

**2. Update `OpenAIStreamEvent` to include `usage`:**
```typescript
interface OpenAIStreamEvent {
	choices?: Array<{
		delta?: {
			content?: string;
			tool_calls?: Array<{...}>;
		};
		finish_reason?: string;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: {
			cached_tokens?: number;
		};
	} | null;
}
```

**3. Update `parseOpenAIStream` to capture usage from the final chunk:**

Add variable declarations at the top of `parseOpenAIStream`:
```typescript
async function* parseOpenAIStream(
	response: Response,
	params: ChatParams,
): AsyncIterable<StreamChunk> {
	const toolStates = new Map<number, { id: string; name: string; args: string }>();
	let capturedUsage: OpenAIStreamEvent["usage"] = null;
	let outputText = ""; // Track for zero-usage guard
```

In the loop, after parsing the event, capture usage before the `[DONE]` check:
```typescript
// Capture usage from final usage chunk (comes before [DONE] when stream_options.include_usage is true)
if (event.usage !== undefined) {
	capturedUsage = event.usage;
}
```

In the `[DONE]` sentinel handler (currently lines 139-148), extract real usage:
```typescript
if (eventData === SSE_DONE_SENTINEL) {
	const promptTokens = capturedUsage?.prompt_tokens ?? 0;
	const completionTokens = capturedUsage?.completion_tokens ?? 0;
	const cachedTokens = capturedUsage?.prompt_tokens_details?.cached_tokens ?? null;

	// Zero-usage guard
	let inputTokens = promptTokens;
	let outputTokens = completionTokens;
	let estimated = false;
	if (inputTokens === 0 && outputTokens === 0 && outputText.length > 0) {
		inputTokens = Math.ceil(
			params.messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0) / 4,
		);
		outputTokens = Math.ceil(outputText.length / 4);
		estimated = true;
	}

	yield {
		type: "done",
		usage: {
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			cache_write_tokens: null, // OpenAI does not report cache writes
			cache_read_tokens: typeof cachedTokens === "number" ? cachedTokens : null,
			estimated,
		},
	};
	continue;
}
```

Accumulate `outputText` in the text content handler:
```typescript
if (delta?.content) {
	outputText += delta.content;
	yield { type: "text", content: delta.content };
}
```

**4. In `chat()`, add `stream_options` to the request and pass `params` to `parseOpenAIStream`:**

```typescript
const request: OpenAIRequest = {
	model: params.model || this.model,
	messages: openaiMessages,
	stream: true,
	stream_options: { include_usage: true },
	temperature: params.temperature,
	max_tokens: params.max_tokens,
};
// ...
yield* parseOpenAIStream(response, params);
```

**Testing (in `packages/llm/src/__tests__/openai-driver.test.ts`):**

The existing test suite uses `global.fetch` mocking. Extend with:

1. **AC4.3 — cache tokens present:** Mock SSE stream with a usage chunk (before `[DONE]`) containing `prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 50 }`. Assert `done` chunk has `input_tokens: 100, output_tokens: 25, cache_read_tokens: 50, cache_write_tokens: null, estimated: false`.

2. **AC4.5 — zero-usage guard:** Mock stream with text events but no usage chunk. Assert `done` chunk has `estimated: true`.

3. **Normal case — usage chunk without cache:** Mock with `prompt_tokens: 100, completion_tokens: 25` but no `prompt_tokens_details`. Assert `cache_read_tokens: null, estimated: false`.

**Verification:**
```bash
bun test packages/llm --test-name-pattern "openai"
```
Expected: all tests pass

**Commit:** `feat(llm/openai): add stream_options for real token counts, extract cache tokens, zero-usage guard`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Ollama driver — null cache tokens and zero-usage guard

**Verifies:** model-robustness.AC4.4, model-robustness.AC4.5

**Files:**
- Modify: `packages/llm/src/ollama-driver.ts:152-161` (the `done` chunk emission in `emitChunkEvents`)

**Implementation:**

The current `done` chunk emission uses `prompt_eval_count` and `eval_count` from the Ollama response. Extend it:

Locate the `done` chunk emission and its surrounding text accumulation. Add an `outputText` tracker where text chunks are yielded (look for where `type: "text"` is yielded in `emitChunkEvents` or its equivalent). Also pass `params: ChatParams` to the function if not already present.

Replace the `done` chunk emission with:
```typescript
if (chunk.done) {
	let inputTokens = chunk.prompt_eval_count || 0;
	let outputTokens = chunk.eval_count || 0;
	let estimated = false;

	// Zero-usage guard
	if (inputTokens === 0 && outputTokens === 0 && outputText.length > 0) {
		inputTokens = Math.ceil(
			params.messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0) / 4,
		);
		outputTokens = Math.ceil(outputText.length / 4);
		estimated = true;
	}

	yield {
		type: "done",
		usage: {
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			cache_write_tokens: null, // Ollama does not report cache metrics
			cache_read_tokens: null,
			estimated,
		},
	};
}
```

**Important:** The Ollama driver tests mock `global.fetch` globally. Per CLAUDE.md: "Ollama driver tests mock `global.fetch` — MUST save/restore original in afterAll or other integration tests break." Check the existing test file's `afterAll` teardown before editing.

**Testing (in `packages/llm/src/__tests__/ollama-driver.test.ts`):**

The existing test (around lines 192-246) checks for a `done` chunk but does not assert usage values. Add tests:

1. **AC4.4 — always null cache tokens:** Mock Ollama response with `prompt_eval_count: 5, eval_count: 3, done: true`. Assert `done` chunk has `cache_write_tokens: null, cache_read_tokens: null, estimated: false`.

2. **AC4.5 — zero-usage guard:** Mock Ollama response with `prompt_eval_count: 0, eval_count: 0, done: true` but include a text response chunk earlier. Assert `done` chunk has `estimated: true`.

3. **Normal case — tokens present:** Mock with `prompt_eval_count: 10, eval_count: 8, done: true`. Assert `input_tokens: 10, output_tokens: 8, estimated: false`.

**Verification:**
```bash
bun test packages/llm --test-name-pattern "ollama"
```
Expected: all tests pass, global.fetch restored in afterAll

**Commit:** `feat(llm/ollama): emit null cache tokens, add zero-usage guard`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 6-7) -->

<!-- START_TASK_6 -->
### Task 6: Extend `metrics-schema.ts` with cache token columns

**Verifies:** model-robustness.AC4.6 (partial — schema and interface; agent-loop wiring in task 7)

**Files:**
- Modify: `packages/core/src/metrics-schema.ts:3-12` (TurnRecord interface)
- Modify: `packages/core/src/metrics-schema.ts:29-39` (idempotent ALTER TABLE section)
- Modify: `packages/core/src/metrics-schema.ts:52-90` (recordTurn function)

**Implementation:**

**1. Extend `TurnRecord` interface** (add after `tokens_out: number`):
```typescript
export interface TurnRecord {
	thread_id?: string;
	task_id?: string;
	dag_root_id?: string;
	model_id: string;
	tokens_in: number;
	tokens_out: number;
	tokens_cache_write: number | null;
	tokens_cache_read: number | null;
	cost_usd?: number;
	created_at: string;
	relay_target?: string | null;
	relay_latency_ms?: number | null;
}
```

**2. Add idempotent ALTER TABLE for cache columns** (after the existing `relay_latency_ms` block at lines 35-39):
```typescript
try {
	db.run("ALTER TABLE turns ADD COLUMN tokens_cache_write INTEGER");
} catch {
	// Column already exists
}
try {
	db.run("ALTER TABLE turns ADD COLUMN tokens_cache_read INTEGER");
} catch {
	// Column already exists
}
```

**3. Update `recordTurn()` to include cache token columns** in the INSERT:
```typescript
export function recordTurn(db: Database, turn: TurnRecord): number {
	const result = db
		.prepare(
			`INSERT INTO turns (thread_id, task_id, dag_root_id, model_id, tokens_in, tokens_out, tokens_cache_write, tokens_cache_read, cost_usd, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			turn.thread_id || null,
			turn.task_id || null,
			turn.dag_root_id || null,
			turn.model_id,
			turn.tokens_in,
			turn.tokens_out,
			turn.tokens_cache_write ?? null,
			turn.tokens_cache_read ?? null,
			turn.cost_usd || 0,
			turn.created_at,
		);
	// ... rest of daily_summary update unchanged
```

Note: `relay_target` and `relay_latency_ms` are added via ALTER TABLE (not in the INSERT) so they keep their existing pattern. The new cache columns follow the same pattern as relay columns — added via ALTER TABLE to existing DBs, but can also be included in INSERT for new DBs. For consistency with the existing relay columns pattern, also add them via ALTER TABLE only (and let them default to NULL). However, since we want them easily persisted, include them in the INSERT statement.

**Verification:**
```bash
tsc -p packages/core --noEmit
bun test packages/core
```
Expected: all tests pass

**Commit:** `feat(core): add tokens_cache_write/read columns to turns table and TurnRecord`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Update `agent-loop.ts` to propagate cache tokens through to `recordTurn()`

**Verifies:** model-robustness.AC4.6 (completes the end-to-end wiring)

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` — `parseResponseChunks()` return type and the `recordTurn()` call site

**Implementation:**

**1. In `parseResponseChunks()`** — extend the return type to include cache fields and extract them from the `done` chunk:

Find the `done` chunk handler in `parseResponseChunks` (around line 1024 area based on investigation):
```typescript
} else if (chunk.type === "done") {
	inputTokens = chunk.usage.input_tokens;
	outputTokens = chunk.usage.output_tokens;
```

Extend to also capture the new fields:
```typescript
} else if (chunk.type === "done") {
	inputTokens = chunk.usage.input_tokens;
	outputTokens = chunk.usage.output_tokens;
	cacheWriteTokens = chunk.usage.cache_write_tokens;
	cacheReadTokens = chunk.usage.cache_read_tokens;
	usageEstimated = chunk.usage.estimated;
```

Add declarations at the top of `parseResponseChunks`:
```typescript
let cacheWriteTokens: number | null = null;
let cacheReadTokens: number | null = null;
let usageEstimated = false;
```

Include them in the returned `usage` object:
```typescript
return {
	textContent,
	toolCalls,
	usage: { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, usageEstimated },
};
```

**2. At the `recordTurn()` call site** (around line 331), pass the cache fields:
```typescript
currentTurnId = recordTurn(this.ctx.db, {
	thread_id: this.config.threadId,
	task_id: this.config.taskId || undefined,
	dag_root_id: undefined,
	model_id: resolvedModelId,
	tokens_in: parsed.usage.inputTokens,
	tokens_out: parsed.usage.outputTokens,
	tokens_cache_write: parsed.usage.cacheWriteTokens,
	tokens_cache_read: parsed.usage.cacheReadTokens,
	cost_usd,
	created_at: new Date().toISOString(),
});
```

**Testing:**

Add an integration test (or extend `packages/core/src/__tests__/phase1.integration.test.ts`) that:
1. Creates an in-memory SQLite DB and applies the schema
2. Calls `recordTurn()` with cache token values (e.g., `tokens_cache_write: 100, tokens_cache_read: 50`)
3. Queries the `turns` table and asserts the `tokens_cache_write` and `tokens_cache_read` columns have the expected values
4. Calls `recordTurn()` with `null` values and asserts `NULL` is stored

The test file is: `packages/core/src/__tests__/phase1.integration.test.ts` (the existing integration test) — check if there's a more appropriate test file first. If there is a `packages/core/src/__tests__/metrics-schema.test.ts`, add tests there. If not, create `packages/core/src/__tests__/metrics-schema.test.ts`.

**Verification:**
```bash
bun test packages/agent
bun test packages/core
```
Expected: all tests pass, 0 fail

**Commit:** `feat(agent): propagate cache token fields from done chunk to recordTurn`
<!-- END_TASK_7 -->

<!-- END_SUBCOMPONENT_C -->

<!-- START_TASK_8 -->
### Task 8: Full Phase 2 verification

**Verifies:** All AC4 criteria end-to-end

**Step 1: Run all affected packages**
```bash
bun test packages/llm
bun test packages/core
bun test packages/agent
```
Expected: all pass, 0 fail

**Step 2: Run full typecheck**
```bash
bun run typecheck
```
Expected: exits 0

**Commit:** (only if any fixups needed) `fix(phase2): address typecheck issues from cache token changes`
<!-- END_TASK_8 -->
