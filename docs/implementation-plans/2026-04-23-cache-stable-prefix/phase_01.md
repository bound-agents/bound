# Cache-Stable Prefix Implementation Plan — Phase 1

**Goal:** Introduce `developer` and `cache` roles to `LLMMessage` and update all four drivers to handle them.

**Architecture:** Two new message roles express provider-agnostic cache intent. Each driver maps these roles to its provider-specific form: Bedrock uses cachePoint blocks, Anthropic uses cache_control metadata, OpenAI passes developer natively, and Ollama maps developer to system. The `cache` role is a zero-content marker that drivers materialize or drop.

**Tech Stack:** TypeScript, bun:test, Bedrock Converse API, Anthropic Messages API, OpenAI Chat Completions API, Ollama Chat API

**Scope:** 6 phases from original design (this is phase 1 of 6)

**Codebase verified:** 2026-04-23

---

## Acceptance Criteria Coverage

This phase implements and tests:

### cache-stable-prefix.AC4: Provider-agnostic stable prefix
- **cache-stable-prefix.AC4.1 Success:** Bedrock driver materializes `cache` messages as cachePoint blocks on previous message
- **cache-stable-prefix.AC4.2 Success:** Anthropic driver materializes `cache` messages as cache_control on previous message
- **cache-stable-prefix.AC4.3 Success:** OpenAI driver drops `cache` messages entirely
- **cache-stable-prefix.AC4.4 Success:** Ollama driver drops `cache` messages entirely
- **cache-stable-prefix.AC4.5 Success:** Bedrock driver maps `developer` to user-message prepend in `<system-context>` wrapper
- **cache-stable-prefix.AC4.6 Success:** Anthropic driver maps `developer` to user-message prepend in `<system-context>` wrapper
- **cache-stable-prefix.AC4.7 Success:** OpenAI driver passes `developer` as native role
- **cache-stable-prefix.AC4.8 Success:** Ollama driver maps `developer` to `system` role
- **cache-stable-prefix.AC4.9 Success:** Bedrock places cachePoint in toolConfig when cache messages present and tools non-empty
- **cache-stable-prefix.AC4.10 Success:** Anthropic places cache_control on last tool when cache messages present and tools non-empty

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add `developer` and `cache` roles to LLMMessage type

**Verifies:** None (type-level change, compiler verifies)

**Files:**
- Modify: `packages/llm/src/types.ts:49-55`

**Implementation:**

Add `"developer"` and `"cache"` to the `LLMMessage.role` union type at line 50:

```typescript
export type LLMMessage = {
	role: "user" | "assistant" | "system" | "tool_call" | "tool_result" | "developer" | "cache";
	content: string | ContentBlock[];
	tool_use_id?: string;
	model_id?: string;
	host_origin?: string;
};
```

Also update `InferenceRequestPayload.messages` type (line 147) — it uses `LLMMessage[]` already, so no change needed there. But verify the relay types at lines 144-160 are compatible (they reference `LLMMessage[]` directly).

**Verification:**
Run: `tsc -p packages/llm --noEmit`
Expected: No type errors (existing code that switches on role may need updates — see subsequent tasks)

Run: `tsc -p packages/shared --noEmit`
Expected: No type errors

**Commit:** `feat(llm): add developer and cache roles to LLMMessage type`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Fix exhaustiveness checks after role addition

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/llm/src/bedrock/convert.ts` (lines 42-56 role guard)
- Modify: `packages/llm/src/anthropic-driver.ts` (lines 99-265 role handling)
- Modify: `packages/llm/src/openai-driver.ts` (lines 71-247 role handling)
- Modify: `packages/llm/src/ollama-driver.ts` (lines 62-130 role handling)

**Implementation:**

After adding the new roles, typecheck may fail because existing role guards don't handle the new variants. Each driver's message converter needs to skip `developer` and `cache` messages for now (they'll be properly handled in tasks 3-6). This task ensures the codebase compiles cleanly.

In `toBedrockMessages()` (convert.ts), the defensive guard at lines 49-56 already skips non-standard roles via the `if` chain. The new `developer` and `cache` roles will fall through to the `continue` at line 55. No changes needed here.

In `toAnthropicMessages()` (anthropic-driver.ts), the converter processes all messages. Add a guard at the top of the loop to skip `developer` and `cache`:

```typescript
// At the top of the for loop (after line 102):
if (msg.role === "developer" || msg.role === "cache") {
	continue;
}
```

In `toOpenAIMessages()` (openai-driver.ts), same pattern — add skip guard after line 74:

```typescript
if (msg.role === "developer" || msg.role === "cache") {
	continue;
}
```

In `toOllamaMessages()` (ollama-driver.ts), the function uses `.map()` so filtering is different — convert to filter+map or add a pre-filter:

```typescript
export function toOllamaMessages(messages: LLMMessage[]): OllamaMessage[] {
	return messages
		.filter((msg) => msg.role !== "developer" && msg.role !== "cache")
		.map((msg) => {
			// ... existing logic unchanged
		});
}
```

**Verification:**
Run: `tsc -p packages/llm --noEmit`
Expected: No type errors

Run: `bun test packages/llm`
Expected: All existing tests pass (no behavioral change — these roles don't appear in existing test data)

**Commit:** `feat(llm): handle developer and cache roles in all driver converters`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Implement `developer` and `cache` role mapping in Bedrock converter

**Verifies:** cache-stable-prefix.AC4.1, cache-stable-prefix.AC4.5, cache-stable-prefix.AC4.9

**Files:**
- Modify: `packages/llm/src/bedrock/convert.ts` (toBedrockMessages lines 38-209, toBedrockRequest lines 226-338)
- Modify: `packages/llm/src/bedrock/validate.ts` (validateBedrockRequest — accept cachePoint content blocks)

**Implementation:**

Replace the simple skip guards from Task 2 with proper handling in `toBedrockMessages()`:

**Developer role mapping** — Prepend developer content to the next user message, wrapped in `<system-context>` tags. If there's no subsequent user message, create one. Insert this logic in the `for` loop before the existing role handling:

```typescript
if (msg.role === "developer") {
	const text = typeof msg.content === "string"
		? msg.content
		: extractTextFromBlocks(msg.content);
	// Buffer to prepend to the next user message
	pendingDeveloperContent.push(`<system-context>${text}</system-context>`);
	continue;
}
```

Add a `pendingDeveloperContent: string[]` array before the loop. When processing a user message, check if there's pending developer content and prepend it as a text block. After the loop, if there's still buffered developer content, inject it as a user message.

**Cache role mapping** — The `cache` message is a zero-content marker. When encountered, append a `{ cachePoint: { type: "default" } }` block to the previous message's content array:

```typescript
if (msg.role === "cache") {
	const prev = result.at(-1);
	if (prev && Array.isArray(prev.content)) {
		(prev.content as Array<Record<string, unknown>>).push({
			cachePoint: { type: "default" },
		});
	}
	continue;
}
```

**Tool caching in toBedrockRequest()** — When the input messages contain any `cache` role messages and tools are non-empty, place a cachePoint in the toolConfig. After the existing toolConfig construction (lines 281-292):

```typescript
// Place cachePoint in toolConfig when cache messages are present and tools exist
const hasCacheMessages = params.messages.some((m) => m.role === "cache");
if (hasCacheMessages && toolConfig) {
	(toolConfig as Record<string, unknown>).cachePoint = { type: "default" };
}
```

**Validator update** — `validateBedrockRequest()` in validate.ts must accept `cachePoint` blocks in message content arrays. The validator currently validates content blocks against known types. Add `cachePoint` as an accepted block type in the content validation logic.

**Verification:**
Run: `tsc -p packages/llm --noEmit`
Expected: No type errors

Run: `bun test packages/llm`
Expected: All existing tests pass

**Commit:** `feat(llm): implement developer and cache role mapping in Bedrock converter`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Tests for Bedrock developer and cache role mapping

**Verifies:** cache-stable-prefix.AC4.1, cache-stable-prefix.AC4.5, cache-stable-prefix.AC4.9

**Files:**
- Modify: `packages/llm/src/__tests__/bedrock-driver.test.ts`
- Modify: `packages/llm/src/__tests__/cache-stability.test.ts`

**Testing:**

Add a new `describe("developer and cache role mapping")` block in `bedrock-driver.test.ts`:

Tests must verify each AC listed above:
- **cache-stable-prefix.AC4.5:** Developer message content is prepended to the next user message in a `<system-context>` wrapper. Test with: developer msg followed by user msg → single user msg with system-context prefix + original content.
- **cache-stable-prefix.AC4.5 edge case:** Developer message with no subsequent user message → creates new user message with the system-context content.
- **cache-stable-prefix.AC4.5 edge case:** Multiple consecutive developer messages → all prepended to next user message.
- **cache-stable-prefix.AC4.1:** Cache message appends cachePoint block to previous message's content array. Test with: user msg, cache msg, user msg → first user msg has cachePoint appended.
- **cache-stable-prefix.AC4.1 edge case:** Cache message with no previous message → cachePoint is dropped (no crash).
- **cache-stable-prefix.AC4.9:** When cache messages exist and tools are provided, toolConfig contains a cachePoint. Test via `toBedrockRequest()` with cache messages + tools → toolConfig has cachePoint field.
- **cache-stable-prefix.AC4.9 edge case:** Cache messages present but no tools → no toolConfig, no crash.

Add cache-stability tests in `cache-stability.test.ts`:
- Deterministic output with developer and cache messages: `stableStringify(toBedrockRequest(input))` is identical across calls.
- CachePoint placement is correct index after developer/cache injection.

Follow existing test patterns: use `toBedrockMessages()` for message-level tests, `toBedrockRequest()` for full-request tests, `stableStringify()` for determinism.

**Verification:**
Run: `bun test packages/llm/src/__tests__/bedrock-driver.test.ts`
Expected: All tests pass including new ones

Run: `bun test packages/llm/src/__tests__/cache-stability.test.ts`
Expected: All tests pass including new ones

**Commit:** `test(llm): add Bedrock developer and cache role mapping tests`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->
<!-- START_TASK_5 -->
### Task 5: Implement `developer` and `cache` role mapping in Anthropic driver

**Verifies:** cache-stable-prefix.AC4.2, cache-stable-prefix.AC4.6, cache-stable-prefix.AC4.10

**Files:**
- Modify: `packages/llm/src/anthropic-driver.ts` (toAnthropicMessages lines 99-265, chat method lines 432-539)

**Implementation:**

Replace the skip guard from Task 2 with proper handling in `toAnthropicMessages()`:

**Developer role mapping** — Same pattern as Bedrock: buffer developer content, prepend to next user message wrapped in `<system-context>` tags. Uses the same buffering approach.

```typescript
if (msg.role === "developer") {
	const text = typeof msg.content === "string"
		? msg.content
		: extractTextFromBlocks(msg.content);
	pendingDeveloperContent.push(`<system-context>${text}</system-context>`);
	continue;
}
```

**Cache role mapping** — Append `cache_control: { type: "ephemeral" }` to the previous message:

```typescript
if (msg.role === "cache") {
	const prev = result.at(-1);
	if (prev) {
		prev.cache_control = { type: "ephemeral" };
	}
	continue;
}
```

Note: For Anthropic, `cache_control` goes on the message object itself (not on content blocks). The existing cache_control placement at line 447 uses the same shape.

**Tool caching in chat()** — When cache messages are present in the input and tools exist, add `cache_control: { type: "ephemeral" }` to the last tool definition:

```typescript
const hasCacheMessages = params.messages.some((m) => m.role === "cache");
if (hasCacheMessages && request.tools && request.tools.length > 0) {
	const lastTool = request.tools[request.tools.length - 1];
	(lastTool as Record<string, unknown>).cache_control = { type: "ephemeral" };
}
```

**Verification:**
Run: `tsc -p packages/llm --noEmit`
Expected: No type errors

Run: `bun test packages/llm`
Expected: All existing tests pass

**Commit:** `feat(llm): implement developer and cache role mapping in Anthropic driver`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Tests for Anthropic developer and cache role mapping

**Verifies:** cache-stable-prefix.AC4.2, cache-stable-prefix.AC4.6, cache-stable-prefix.AC4.10

**Files:**
- Modify: `packages/llm/src/__tests__/anthropic-driver.test.ts`

**Testing:**

Add a new `describe("developer and cache role mapping")` block:

Tests must verify each AC listed above:
- **cache-stable-prefix.AC4.6:** Developer message prepended to next user message in `<system-context>` wrapper.
- **cache-stable-prefix.AC4.6 edge case:** Developer with no subsequent user message → creates user message.
- **cache-stable-prefix.AC4.6 edge case:** Multiple consecutive developer messages.
- **cache-stable-prefix.AC4.2:** Cache message adds `cache_control: { type: "ephemeral" }` to previous message.
- **cache-stable-prefix.AC4.2 edge case:** Cache message with no previous message → dropped.
- **cache-stable-prefix.AC4.10:** When cache messages present and tools provided, last tool gets `cache_control`.
- **cache-stable-prefix.AC4.10 edge case:** Cache messages present but no tools → no crash.

Follow existing patterns: use `toAnthropicMessages()` for message conversion tests. For tool caching, mock fetch and verify the request body includes cache_control on the last tool.

**Verification:**
Run: `bun test packages/llm/src/__tests__/anthropic-driver.test.ts`
Expected: All tests pass including new ones

**Commit:** `test(llm): add Anthropic developer and cache role mapping tests`
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_C -->

<!-- START_SUBCOMPONENT_D (tasks 7-8) -->
<!-- START_TASK_7 -->
### Task 7: Implement `developer` and `cache` role mapping in OpenAI and Ollama drivers

**Verifies:** cache-stable-prefix.AC4.3, cache-stable-prefix.AC4.4, cache-stable-prefix.AC4.7, cache-stable-prefix.AC4.8

**Files:**
- Modify: `packages/llm/src/openai-driver.ts` (toOpenAIMessages lines 71-247)
- Modify: `packages/llm/src/ollama-driver.ts` (toOllamaMessages lines 62-130)

**Implementation:**

**OpenAI** — Replace the skip guard from Task 2:

For `developer`: pass through as native `developer` role. OpenAI supports this natively. Replace the skip guard with:

```typescript
if (msg.role === "developer") {
	const text = typeof msg.content === "string"
		? msg.content
		: extractTextFromBlocks(msg.content);
	result.push({
		role: "developer",
		content: text,
	});
	continue;
}
```

For `cache`: drop entirely (already handled by the skip guard from Task 2). Just ensure the `continue` is still there.

Note: The system-message-to-user conversion loop at lines 200-205 must NOT convert `developer` messages. Update the loop to check `msg.role === "system"` only (it already does, so no change needed — `developer` is a separate role).

**Ollama** — Replace the `.filter()` from Task 2:

For `developer`: map to `system` role:

```typescript
if (msg.role === "developer") {
	const text = typeof msg.content === "string"
		? msg.content
		: extractTextFromBlocks(msg.content);
	return { role: "system", content: text };
}
```

For `cache`: filter out entirely (keep the `.filter()` for cache only):

```typescript
export function toOllamaMessages(messages: LLMMessage[]): OllamaMessage[] {
	return messages
		.filter((msg) => msg.role !== "cache")
		.map((msg) => {
			if (msg.role === "developer") {
				const text = typeof msg.content === "string"
					? msg.content
					: extractTextFromBlocks(msg.content);
				return { role: "system" as const, content: text };
			}
			// ... rest of existing logic
		});
}
```

**Verification:**
Run: `tsc -p packages/llm --noEmit`
Expected: No type errors

Run: `bun test packages/llm`
Expected: All existing tests pass

**Commit:** `feat(llm): implement developer and cache role mapping in OpenAI and Ollama drivers`
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: Tests for OpenAI and Ollama developer and cache role mapping

**Verifies:** cache-stable-prefix.AC4.3, cache-stable-prefix.AC4.4, cache-stable-prefix.AC4.7, cache-stable-prefix.AC4.8

**Files:**
- Modify: `packages/llm/src/__tests__/openai-driver.test.ts`
- Modify: `packages/llm/src/__tests__/ollama-driver.test.ts`

**Testing:**

**OpenAI tests** — Add `describe("developer and cache role mapping")`:
- **cache-stable-prefix.AC4.7:** Developer message passed through with `role: "developer"` and text content.
- **cache-stable-prefix.AC4.7 edge case:** Developer message with array content → extracted to text string.
- **cache-stable-prefix.AC4.3:** Cache messages dropped entirely from output (not present in converted messages).
- **cache-stable-prefix.AC4.3 edge case:** Cache message between user messages → both user messages preserved, cache gone.

**Ollama tests** — Add `describe("developer and cache role mapping")`:
- **cache-stable-prefix.AC4.8:** Developer message mapped to `role: "system"` with text content.
- **cache-stable-prefix.AC4.8 edge case:** Developer with array content → extracted to text.
- **cache-stable-prefix.AC4.4:** Cache messages filtered out entirely from output.
- **cache-stable-prefix.AC4.4 edge case:** Cache message between user messages → both preserved, cache gone.

Follow existing patterns: Ollama tests mock `global.fetch` — save/restore in afterAll. OpenAI tests use `toOpenAIMessages()` directly for conversion tests.

**Verification:**
Run: `bun test packages/llm/src/__tests__/openai-driver.test.ts`
Expected: All tests pass including new ones

Run: `bun test packages/llm/src/__tests__/ollama-driver.test.ts`
Expected: All tests pass including new ones

**Commit:** `test(llm): add OpenAI and Ollama developer and cache role mapping tests`
<!-- END_TASK_8 -->
<!-- END_SUBCOMPONENT_D -->

<!-- START_TASK_9 -->
### Task 9: Run full test suite and verify no regressions

**Verifies:** None (infrastructure verification)

**Files:** None (verification only)

**Step 1: Run all LLM package tests**

Run: `bun test packages/llm`
Expected: All tests pass, zero failures

**Step 2: Run full test suite**

Run: `bun test --recursive`
Expected: Exit code 0, no regressions

**Step 3: Typecheck all packages**

Run: `bun run typecheck`
Expected: All packages typecheck clean

If any failures occur, fix them before committing.

**Commit:** No commit needed if all passes. If fixes were required, commit with: `fix(llm): resolve test regressions from role addition`
<!-- END_TASK_9 -->
