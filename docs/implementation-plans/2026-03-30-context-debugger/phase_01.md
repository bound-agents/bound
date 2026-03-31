# Context Debugger Implementation Plan - Phase 1

**Goal:** Replace all `estimateContentLength() / 4` heuristics with tiktoken-based counting via a shared utility module.

**Architecture:** A new `tokens.ts` module in `@bound/shared` provides `countTokens(text)` and `countContentTokens(content)` using `js-tiktoken`'s `cl100k_base` encoding with lazy singleton initialization. The `@bound/agent` context assembly pipeline replaces its character-count heuristic with these functions. A structural type `TokenCountableBlock` avoids a circular dependency between `@bound/shared` and `@bound/llm` (where `ContentBlock` is defined).

**Tech Stack:** TypeScript, js-tiktoken (cl100k_base encoding), bun:test

**Scope:** 5 phases from original design (phase 1 of 5)

**Codebase verified:** 2026-03-31

**Testing reference:** CLAUDE.md lines 123-131. bun:test framework, temp SQLite databases via `randomBytes(4)`, `describe`/`it`/`expect` structure.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### context-debugger.AC1: Token Counting Utility
- **context-debugger.AC1.1 Success:** `countTokens("hello world")` returns a token count consistent with cl100k_base encoding
- **context-debugger.AC1.2 Success:** `countContentTokens(content)` handles both `string` and `ContentBlock[]` inputs correctly
- **context-debugger.AC1.3 Success:** All `estimateContentLength() / 4` call sites in context-assembly.ts replaced with `countContentTokens()`
- **context-debugger.AC1.4 Edge:** Encoding singleton initializes lazily on first call, not at import time
- **context-debugger.AC1.5 Edge:** Empty string input returns 0 tokens

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Add js-tiktoken dependency to @bound/shared

**Files:**
- Modify: `packages/shared/package.json`

**Step 1: Install the dependency**

```bash
cd packages/shared && bun add js-tiktoken
```

**Step 2: Verify installation**

Run: `bun install`
Expected: Installs without errors. `node_modules/js-tiktoken` exists and contains `lite.js` and `ranks/cl100k_base.js`.

**Step 3: Commit**

```bash
git add packages/shared/package.json bun.lockb
git commit -m "chore(shared): add js-tiktoken dependency"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create token counting module with exports

**Verifies:** context-debugger.AC1.1, context-debugger.AC1.2, context-debugger.AC1.4, context-debugger.AC1.5

**Files:**
- Create: `packages/shared/src/tokens.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./tokens.js";`)
- Test: `packages/shared/src/__tests__/tokens.test.ts` (unit)

**Implementation:**

The module must handle a cross-package constraint: `ContentBlock` is defined in `@bound/llm` (`packages/llm/src/types.ts:34-38`), but this module lives in `@bound/shared` which is upstream in the dependency graph (`shared <- llm`). Define a minimal structural type `TokenCountableBlock` that `ContentBlock` satisfies without importing it.

Use `js-tiktoken/lite` import with `js-tiktoken/ranks/cl100k_base` for efficient loading. The encoding MUST initialize lazily on first call (not at import time) to satisfy AC1.4.

```typescript
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";

/**
 * Minimal structural type for content blocks.
 * Satisfied by ContentBlock from @bound/llm without requiring the import.
 */
interface TokenCountableBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

let encoding: Tiktoken | null = null;

function getEncoding(): Tiktoken {
	if (!encoding) {
		encoding = new Tiktoken(cl100k_base);
	}
	return encoding;
}

/**
 * Count tokens in a plain text string using cl100k_base encoding.
 * Labeled "estimated" in UI because cl100k_base approximates Claude's tokenizer (~5-10% variance).
 * Returns 0 for empty strings.
 */
export function countTokens(text: string): number {
	if (text.length === 0) return 0;
	return getEncoding().encode(text).length;
}

/**
 * Count tokens in message content (string or content block array).
 * For text blocks, counts tokens of the text content.
 * For other block types (tool_use, image, document), counts tokens of the JSON representation.
 */
export function countContentTokens(content: string | TokenCountableBlock[]): number {
	if (typeof content === "string") return countTokens(content);
	return content.reduce((sum, block) => {
		if (block.type === "text" && block.text) return sum + countTokens(block.text);
		return sum + countTokens(JSON.stringify(block));
	}, 0);
}
```

Add to `packages/shared/src/index.ts` (currently 18 lines, append after last export):
```typescript
export * from "./tokens.js";
```

**Testing:**

Tests must verify each AC listed above:
- **context-debugger.AC1.1:** `countTokens("hello world")` returns a positive integer. cl100k_base encodes "hello world" as 2 tokens — verify `expect(countTokens("hello world")).toBe(2)`.
- **context-debugger.AC1.2 (string):** `countContentTokens("hello world")` returns same result as `countTokens("hello world")`.
- **context-debugger.AC1.2 (ContentBlock[]):** `countContentTokens([{ type: "text", text: "hello" }, { type: "tool_use", id: "1", name: "test", input: {} }])` returns sum of text token count + JSON-stringified tool_use token count.
- **context-debugger.AC1.4:** Import the module, verify encoding is null before first call. This can be tested by calling `countTokens` and verifying it returns a result (lazy init happened). A stricter test: verify the module-level `encoding` variable is null at import time — this requires the module to export a test helper or use a separate test that checks timing. Pragmatic approach: verify `countTokens` works on first call (proves lazy init works).
- **context-debugger.AC1.5:** `countTokens("")` returns exactly `0`. Also test `countContentTokens("")` returns `0`.

Additional edge cases:
- `countContentTokens([])` (empty array) returns 0
- Long text string returns reasonable token count (e.g., 1000-char string returns ~250 tokens)

Follow project testing patterns: `bun:test`, `describe`/`it`/`expect`. Test file at `packages/shared/src/__tests__/tokens.test.ts`.

**Verification:**

Run: `bun test packages/shared`
Expected: All tests pass

**Commit:** `feat(shared): add tiktoken-based token counting utility`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Replace estimateContentLength()/4 call sites in context-assembly.ts

**Verifies:** context-debugger.AC1.3

**Files:**
- Modify: `packages/agent/src/context-assembly.ts:5` (add import)
- Modify: `packages/agent/src/context-assembly.ts:992` (replace token estimation)
- Modify: `packages/agent/src/context-assembly.ts:1054` (replace token estimation)
- Modify: `packages/agent/src/context-assembly.ts:44-57` (add deprecation notice)

**Implementation:**

1. Add import near existing `@bound/shared` imports (currently line 5: `import type { Message } from "@bound/shared"`):

```typescript
import { countContentTokens } from "@bound/shared";
```

2. Replace line 992 (Stage 7 BUDGET_VALIDATION token sum):

```typescript
// BEFORE:
return sum + Math.ceil(estimateContentLength(msg.content) / 4);
// AFTER:
return sum + countContentTokens(msg.content);
```

3. Replace line 1054 (final truncation token sum):

```typescript
// BEFORE:
return sum + Math.ceil(estimateContentLength(msg.content) / 4);
// AFTER:
return sum + countContentTokens(msg.content);
```

4. Add `@deprecated` JSDoc to `estimateContentLength()` (lines 44-57). The function is still exported and tested directly, but is no longer used for token estimation:

```typescript
/**
 * Estimate the character length of message content.
 * @deprecated Use countContentTokens() from @bound/shared for token counting.
 * This function returns character counts, not token counts.
 */
export function estimateContentLength(content: string | ContentBlock[]): number {
```

**Testing:**

Tests must verify:
- **context-debugger.AC1.3:** Run existing context-assembly tests. The 6 existing tests for `estimateContentLength()` at `packages/agent/src/__tests__/context-assembly.test.ts:2303-2348` should still pass (they test the function itself, not the `/4` call sites). Budget validation and truncation tests exercise the replaced code paths.

No new tests needed for this task — existing tests cover the behavior. The replacement is a drop-in that changes token estimation accuracy, not behavior.

**Verification:**

Run: `bun test packages/agent`
Expected: All existing tests pass

Run: `bun test --recursive`
Expected: All tests across the project pass (no regressions)

**Commit:** `refactor(agent): replace token estimation heuristic with tiktoken counting`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
