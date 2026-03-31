# Context Debugger Implementation Plan - Phase 2

**Goal:** Instrument `assembleContext()` to return structured metadata alongside messages with per-section token counts.

**Architecture:** `assembleContext()` changes its return type from `LLMMessage[]` to `ContextAssemblyResult { messages, debug }`. Token counting (from Phase 1's `countContentTokens`) is performed inline during each assembly stage, accumulating per-section token counts into a `ContextDebugInfo` structure. The agent loop destructures the new return type. A `toolTokenEstimate` field on `ContextParams` lets the caller pass tool definition token counts (since tools are at `ChatParams` level, not in the assembled messages).

**Tech Stack:** TypeScript, bun:test

**Scope:** 5 phases from original design (phase 2 of 5)

**Codebase verified:** 2026-03-31

**Testing reference:** CLAUDE.md lines 123-131. bun:test framework, temp SQLite databases via `randomBytes(4)`, `describe`/`it`/`expect` structure. Existing test file: `packages/agent/src/__tests__/context-assembly.test.ts`.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### context-debugger.AC2: Context Assembly Instrumentation
- **context-debugger.AC2.1 Success:** `assembleContext()` returns `{ messages, debug }` where debug contains `contextWindow`, `totalEstimated`, `model`, and `sections`
- **context-debugger.AC2.2 Success:** Sections include system, tools, history (with user/assistant/tool_result children), memory, task-digest, skill-context, volatile-other
- **context-debugger.AC2.3 Success:** Sum of all section tokens equals `totalEstimated`
- **context-debugger.AC2.4 Success:** `budgetPressure` is true when Stage 7 triggers enrichment reduction
- **context-debugger.AC2.5 Success:** `truncated` reflects number of messages dropped during history truncation
- **context-debugger.AC2.6 Edge:** Assembly with empty thread (no history) returns sections with 0-token history and no children

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add context debug types to @bound/shared

**Files:**
- Modify: `packages/shared/src/types.ts` (append new types at end of file, currently ~407 lines)

**Implementation:**

Add these types at the end of `packages/shared/src/types.ts`:

```typescript
// --- Context Debug Types (Phase 2: Context Debugger) ---

export interface ContextSection {
	name: string;
	tokens: number;
	children?: ContextSection[];
}

export interface ContextDebugInfo {
	contextWindow: number;
	totalEstimated: number;
	model: string;
	sections: ContextSection[];
	budgetPressure: boolean;
	truncated: number;
}

export interface ContextAssemblyResult {
	messages: LLMMessage[];
	debug: ContextDebugInfo;
}
```

Note: `LLMMessage` is imported from `@bound/llm`. Check if `packages/shared/src/types.ts` already imports from `@bound/llm`. If not, this type must use a forward reference or be placed in `@bound/agent` instead. **Resolution:** Since `@bound/shared` cannot import from `@bound/llm` (shared is upstream), define `ContextAssemblyResult` without referencing `LLMMessage` directly. Use a generic or place only `ContextSection` and `ContextDebugInfo` in shared, and define `ContextAssemblyResult` locally in `@bound/agent`.

Corrected approach — add to `packages/shared/src/types.ts`:

```typescript
// --- Context Debug Types (Phase 2: Context Debugger) ---

export interface ContextSection {
	name: string;
	tokens: number;
	children?: ContextSection[];
}

export interface ContextDebugInfo {
	contextWindow: number;
	totalEstimated: number;
	model: string;
	sections: ContextSection[];
	budgetPressure: boolean;
	truncated: number;
}
```

Then define `ContextAssemblyResult` in `packages/agent/src/context-assembly.ts` (where `LLMMessage` is already imported):

```typescript
import type { ContextDebugInfo, ContextSection } from "@bound/shared";

export interface ContextAssemblyResult {
	messages: LLMMessage[];
	debug: ContextDebugInfo;
}
```

**Verification:**

Run: `tsc -p packages/shared --noEmit`
Expected: No type errors

**Commit:** `feat(shared): add context debug types`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add toolTokenEstimate to ContextParams

**Files:**
- Modify: `packages/agent/src/context-assembly.ts:13-42` (add field to ContextParams)

**Implementation:**

Add `toolTokenEstimate` field to the `ContextParams` interface (at `packages/agent/src/context-assembly.ts:13-42`):

```typescript
export interface ContextParams {
	// ... existing fields ...
	/** Estimated token count for tool definitions (counted by caller since tools are at ChatParams level) */
	toolTokenEstimate?: number;
}
```

This field allows the agent loop to pass in the tool definition token count (since tool definitions are not part of the assembled messages — they exist at the `ChatParams` level in `packages/llm/src/types.ts`). The debug info uses this value for the `tools` section.

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No type errors (field is optional, no callers need updating yet)

**Commit:** `feat(agent): add toolTokenEstimate to ContextParams`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Instrument assembleContext() to return ContextAssemblyResult

**Verifies:** context-debugger.AC2.1, context-debugger.AC2.2, context-debugger.AC2.3, context-debugger.AC2.4, context-debugger.AC2.5, context-debugger.AC2.6

**Files:**
- Modify: `packages/agent/src/context-assembly.ts:226` (change return type)
- Modify: `packages/agent/src/context-assembly.ts:650-1095` (instrument Stages 6-8)

**Implementation:**

This is the core instrumentation change. The strategy: track token counts for each section as messages are added during assembly, then return both the messages array and the accumulated debug metadata.

1. **Change function signature** (line 226):

```typescript
// BEFORE:
export function assembleContext(params: ContextParams): LLMMessage[] {
// AFTER:
export function assembleContext(params: ContextParams): ContextAssemblyResult {
```

2. **Initialize debug tracking** (add after line 226, inside the function):

```typescript
const sections: ContextSection[] = [];
let budgetPressure = false;
let truncatedCount = 0;
```

3. **Track system prompt tokens** (after system messages are pushed to `assembled`, around line 687):

After the orientation system message is pushed, count all system messages so far:

```typescript
const systemTokens = assembled.reduce(
	(sum, msg) => sum + countContentTokens(msg.content),
	0,
);
sections.push({ name: "system", tokens: systemTokens });
```

4. **Track skill context tokens** (after skill injection, around line 742):

Count any skill system message that was just pushed:

```typescript
const skillTokens = assembled.length > systemMsgCount
	? countContentTokens(assembled[assembled.length - 1].content)
	: 0;
if (skillTokens > 0) {
	sections.push({ name: "skill-context", tokens: skillTokens });
}
```

Note: You will need to capture `systemMsgCount = assembled.length` right after the system prompt section (after line 687) to know if a skill message was added.

5. **Track history tokens with role children** (after `assembled.push(...finalAnnotated)` at line 745):

```typescript
const historyChildren: ContextSection[] = [];
let userTokens = 0;
let assistantTokens = 0;
let toolResultTokens = 0;

for (const msg of finalAnnotated) {
	const tokens = countContentTokens(msg.content);
	if (msg.role === "user") userTokens += tokens;
	else if (msg.role === "assistant") assistantTokens += tokens;
	else if (msg.role === "tool_result") toolResultTokens += tokens;
}

if (userTokens > 0) historyChildren.push({ name: "user", tokens: userTokens });
if (assistantTokens > 0) historyChildren.push({ name: "assistant", tokens: assistantTokens });
if (toolResultTokens > 0) historyChildren.push({ name: "tool_result", tokens: toolResultTokens });

sections.push({
	name: "history",
	tokens: userTokens + assistantTokens + toolResultTokens,
	children: historyChildren.length > 0 ? historyChildren : undefined,
});
```

6. **Track volatile section tokens** (after volatile content is pushed as a system message, around line 950):

The volatile content is assembled into `volatileLines` and pushed as a single system message. Parse the volatile lines to separate memory, task-digest, and other volatile content:

```typescript
// Count memory section tokens (between enrichmentStartIdx and enrichmentEndIdx)
const memoryLines = volatileLines.slice(enrichmentStartIdx, enrichmentEndIdx);
const memoryTokens = memoryLines.length > 0
	? countTokens(memoryLines.join("\n"))
	: 0;

// Count task digest tokens (taskDigestLines from buildVolatileEnrichment)
const taskDigestTokens = taskDigestLines.length > 0
	? countTokens(taskDigestLines.join("\n"))
	: 0;

// Volatile-other = total volatile - memory - task digest
const totalVolatileTokens = volatileLines.length > 0
	? countTokens(volatileLines.join("\n"))
	: 0;
const volatileOtherTokens = totalVolatileTokens - memoryTokens - taskDigestTokens;

if (memoryTokens > 0) sections.push({ name: "memory", tokens: memoryTokens });
if (taskDigestTokens > 0) sections.push({ name: "task-digest", tokens: taskDigestTokens });
if (volatileOtherTokens > 0) sections.push({ name: "volatile-other", tokens: volatileOtherTokens });
```

7. **Track tools section** (using the ContextParams field):

```typescript
const toolTokens = params.toolTokenEstimate ?? 0;
if (toolTokens > 0) sections.push({ name: "tools", tokens: toolTokens });
```

8. **Track budget pressure** (in Stage 7, around line 996 where `headroom < 2000`):

```typescript
if (headroom < 2000) {
	budgetPressure = true;
	// ... existing enrichment reduction code ...
}
```

9. **Track truncation and handle early-return path** (in the truncation block, around lines 1057-1092):

The truncation block has an **early return** at line 1090 (`return [...systemMessages, ...remaining]`). Since the function now returns `ContextAssemblyResult`, this return path MUST also return the debug metadata. Update the entire truncation block:

```typescript
if (totalTokens > contextWindow) {
	// ... existing truncation code to compute systemMessages, historyMessages, remaining ...
	truncatedCount = historyMessages.length - remaining.length;

	// Recompute totalEstimated after truncation
	const truncatedMessages = [...systemMessages, ...remaining];
	const totalEstimated = sections.reduce((sum, s) => sum + s.tokens, 0);

	return {
		messages: truncatedMessages,
		debug: {
			contextWindow: params.contextWindow ?? 128000,
			totalEstimated,
			model: params.currentModel ?? "unknown",
			sections,
			budgetPressure,
			truncated: truncatedCount,
		},
	};
}
```

**Critical:** Do NOT leave the original `return [...systemMessages, ...remaining]` at line 1090 — it must be replaced with the `ContextAssemblyResult` return above. Otherwise TypeScript will error because the function signature expects `ContextAssemblyResult` but the early return produces `LLMMessage[]`.

10. **Compute total and return** (replace the final `return assembled;` at end of function — the non-truncation path):

```typescript
const totalEstimated = sections.reduce((sum, s) => sum + s.tokens, 0);

return {
	messages: assembled,
	debug: {
		contextWindow: params.contextWindow ?? 128000,
		totalEstimated,
		model: params.currentModel ?? "unknown",
		sections,
		budgetPressure,
		truncated: truncatedCount,
	},
};
```

**6b. Track noHistory volatile enrichment path** (lines 952-985 of context-assembly.ts):

When `noHistory` is true (autonomous task runs), the enrichment code at lines 952-985 pushes memory and task-digest content as a standalone system message. This path is SEPARATE from the `!noHistory` volatile enrichment at lines 748-950. It must also be instrumented:

```typescript
// After the noHistory enrichment message is pushed (around line 984):
if (noHistDelta.length > 0) {
	const noHistMemTokens = countTokens(noHistDelta.join("\n"));
	if (noHistMemTokens > 0) sections.push({ name: "memory", tokens: noHistMemTokens });
}
if (noHistTasks.length > 0) {
	const noHistTaskTokens = countTokens(noHistTasks.join("\n"));
	if (noHistTaskTokens > 0) sections.push({ name: "task-digest", tokens: noHistTaskTokens });
}
```

Where `noHistDelta` and `noHistTasks` are the memory delta lines and task digest lines computed in the noHistory path. Check the exact variable names in the source code at lines 952-985.

**Important implementation notes:**
- `tool_call` role messages should be counted under `history` (alongside the role they pair with, or as a separate child). Since `tool_call` is a synthetic role used for tool_use blocks, count it under `assistant` since it represents the assistant's tool use intent.
- The `noHistory` path (autonomous tasks) needs section tracking via step 6b above. When `noHistory` is true AND no enrichment content exists, the history section should be `{ name: "history", tokens: 0 }`.
- After budget pressure rebuilds volatile content, re-count the memory and task-digest sections with the reduced values.

**Testing:**

Tests must verify each AC:
- **context-debugger.AC2.1:** Call `assembleContext()` with a thread that has messages. Result has `.messages` (array) and `.debug` with `contextWindow`, `totalEstimated`, `model`, `sections`.
- **context-debugger.AC2.2:** Debug sections include entries named `system`, `history` (with `user`/`assistant`/`tool_result` children). When tool tokens and volatile content present, also includes `tools`, `memory`, `task-digest`, `volatile-other`, `skill-context`.
- **context-debugger.AC2.3:** `debug.sections.reduce((s, sec) => s + sec.tokens, 0)` equals `debug.totalEstimated`.
- **context-debugger.AC2.4:** Set `contextWindow` to a very small value that triggers budget pressure. Verify `debug.budgetPressure === true`.
- **context-debugger.AC2.5:** Set `contextWindow` very small to force truncation. Verify `debug.truncated > 0` and equals the number of dropped messages.
- **context-debugger.AC2.6:** Call with an empty thread (no messages). History section has `tokens: 0` and no children.

Test file: `packages/agent/src/__tests__/context-assembly.test.ts` (unit). Add a new `describe("context debug metadata", ...)` block.

Database setup: Follow existing pattern in the same test file — create temp DB with `randomBytes(4)`, apply schema, insert test thread/user/messages with `db.run()`.

**Verification:**

Run: `bun test packages/agent`
Expected: All tests pass (both existing and new)

**Commit:** `feat(agent): instrument assembleContext with per-section token counting`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Update agent-loop.ts to use ContextAssemblyResult

**Verifies:** context-debugger.AC2.1

**Files:**
- Modify: `packages/agent/src/agent-loop.ts:210-229` (destructure new return type)
- Modify: `packages/agent/src/agent-loop.ts` (import ContextAssemblyResult type)

**Implementation:**

1. Add import for `ContextAssemblyResult` (or just use inline destructuring — the type is local to context-assembly.ts):

```typescript
import { assembleContext, type ContextAssemblyResult } from "./context-assembly.js";
```

2. Update the call site at lines 210-229. Change from:

```typescript
const contextMessages = assembleContext({
	// ... params ...
});
```

To:

```typescript
const { messages: contextMessages, debug: contextDebug } = assembleContext({
	// ... all existing params stay the same ...
	toolTokenEstimate: toolTokenEstimate, // new: pass tool token count
});
```

3. **Compute toolTokenEstimate before the assembleContext call.** Tool definitions are available via `this.tools` or the command registry. Use `countContentTokens` (or `countTokens(JSON.stringify(tools))`) to estimate:

```typescript
import { countTokens } from "@bound/shared";

// Before the assembleContext call:
const toolTokenEstimate = this.tools
	? countTokens(JSON.stringify(this.tools))
	: 0;
```

Find where `this.tools` (or equivalent tool definitions) are available in the agent loop's run method context. The exact variable name may differ — look for where `ChatParams.tools` is populated.

4. **Store contextDebug for Phase 3** (persistence). For now, just log it or store it on the instance:

```typescript
this.lastContextDebug = contextDebug;
```

Add a class field:

```typescript
private lastContextDebug?: ContextDebugInfo;
```

This field will be used by Phase 3 to persist debug data after recording the turn.

**Testing:**

Tests must verify:
- **context-debugger.AC2.1:** The agent loop successfully destructures the result and passes `contextMessages` to the LLM call. Existing agent loop tests (if any) should still pass since the messages array is unchanged.

No new dedicated tests needed — the agent loop's existing test coverage exercises the code path. If agent loop tests break due to the return type change, update them to destructure `{ messages }` from `assembleContext()`.

**Verification:**

Run: `bun test packages/agent`
Expected: All tests pass

Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): update agent loop to consume context debug metadata`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->
