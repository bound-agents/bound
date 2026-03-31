# Metro Interchange UI — Phase 1: Backend Cross-Thread Source Data

**Goal:** Surface structured cross-thread metadata through the existing context debug pipeline so the frontend can render interchange visualizations.

**Architecture:** Enrich `buildCrossThreadDigest()` to return both the existing text digest (for LLM context) and a structured `CrossThreadSource[]` array (for the UI). The sources array flows through the existing `ContextDebugInfo` → `turns.context_debug` JSON column → HTTP/WebSocket pipeline with no schema migration.

**Tech Stack:** TypeScript, bun:sqlite, @bound/shared types, @bound/agent context assembly

**Scope:** Phase 1 of 4 from original design

**Codebase verified:** 2026-03-31

---

## Acceptance Criteria Coverage

This phase implements and tests:

### metro-interchange-ui.AC3: Metro Interchange Visualization
- **metro-interchange-ui.AC3.1 Success:** `buildCrossThreadDigest` returns `{ text: string; sources: CrossThreadSource[] }` with thread ID, title, color, messageCount, lastMessageAt per source
- **metro-interchange-ui.AC3.2 Success:** `ContextDebugInfo` includes `crossThreadSources` array when cross-thread context is present
- **metro-interchange-ui.AC3.7 Edge:** Old turns without `crossThreadSources` field render gracefully (no branches, no console errors)

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Add CrossThreadSource type and extend ContextDebugInfo

**Files:**
- Modify: `packages/shared/src/types.ts:410-425`

**Implementation:**

Add the `CrossThreadSource` interface immediately before `ContextDebugInfo` (after line 416, before line 418), and add the optional `crossThreadSources` field to `ContextDebugInfo`.

```typescript
// Add after the ContextSection interface (line 416):

export interface CrossThreadSource {
	threadId: string;
	title: string;
	color: number;
	messageCount: number;
	lastMessageAt: string;
}

// Extend ContextDebugInfo (line 418-425) to add optional field:
export interface ContextDebugInfo {
	contextWindow: number;
	totalEstimated: number;
	model: string;
	sections: ContextSection[];
	budgetPressure: boolean;
	truncated: number;
	crossThreadSources?: CrossThreadSource[];
}
```

**Verification:**

Run: `tsc -p packages/shared --noEmit`
Expected: No errors — this only adds a new interface and an optional field.

**Commit:** `feat(shared): add CrossThreadSource type and extend ContextDebugInfo`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update buildCrossThreadDigest and assembleContext

**Verifies:** metro-interchange-ui.AC3.1, metro-interchange-ui.AC3.2

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts:128-174`
- Modify: `packages/agent/src/context-assembly.ts:872-876` (call site)
- Modify: `packages/agent/src/context-assembly.ts:1203-1212` and `1222-1232` (debug info construction, two return points)

**Implementation:**

**summary-extraction.ts** — Change `buildCrossThreadDigest` return type from `string` to `{ text: string; sources: CrossThreadSource[] }`.

Key changes:
1. Import `CrossThreadSource` from `@bound/shared`
2. Add optional `excludeThreadId?: string` third parameter to exclude the current thread from sources (design requirement: avoid self-referential branch)
3. Add `color` to the SQL SELECT: `SELECT id, title, color, last_message_at, summary FROM threads ...`
4. When `excludeThreadId` is provided, add `AND id != ?` to the SQL WHERE clause
5. Update the type annotation for the SQL result to include `color: number`
6. Build a `sources` array alongside the existing text lines
7. Return `{ text: lines.join("\n"), sources }` instead of `lines.join("\n")`
8. Error/empty paths: return `{ text: "No recent activity.", sources: [] }` and `{ text: "Error building digest.", sources: [] }`

The complete updated function:

```typescript
export function buildCrossThreadDigest(
	db: Database,
	userId: string,
	excludeThreadId?: string,
): { text: string; sources: CrossThreadSource[] } {
	try {
		const sql = excludeThreadId
			? "SELECT id, title, color, last_message_at, summary FROM threads WHERE user_id = ? AND id != ? AND deleted = 0 ORDER BY last_message_at DESC LIMIT 5"
			: "SELECT id, title, color, last_message_at, summary FROM threads WHERE user_id = ? AND deleted = 0 ORDER BY last_message_at DESC LIMIT 5";
		const params = excludeThreadId ? [userId, excludeThreadId] : [userId];
		const threads = db
			.prepare(sql)
			.all(...params) as Array<{
			id: string;
			title: string | null;
			color: number;
			last_message_at: string;
			summary: string | null;
		}>;

		if (threads.length === 0) {
			return { text: "No recent activity.", sources: [] };
		}

		const lines: string[] = [];
		const sources: CrossThreadSource[] = [];
		lines.push("Recent Activity Digest:");
		lines.push("");

		for (const thread of threads) {
			const title = thread.title || "(untitled)";
			const messageCount = db
				.prepare("SELECT COUNT(*) as count FROM messages WHERE thread_id = ?")
				.get(thread.id) as { count: number };

			lines.push(
				`- ${title}: ${messageCount.count} messages (last updated ${thread.last_message_at})`,
			);

			if (thread.summary) {
				const truncated =
					thread.summary.length > 300
						? `${thread.summary.slice(0, 297)}...`
						: thread.summary;
				lines.push(`  Summary: ${truncated}`);
			}

			sources.push({
				threadId: thread.id,
				title,
				color: thread.color,
				messageCount: messageCount.count,
				lastMessageAt: thread.last_message_at,
			});
		}

		return { text: lines.join("\n"), sources };
	} catch {
		return { text: "Error building digest.", sources: [] };
	}
}
```

**context-assembly.ts** — Update the call site (line 872-876) to destructure the new return type and attach sources to debug info.

At the call site (line 872):
```typescript
// Before:
const crossThreadDigest = buildCrossThreadDigest(db, userId);
if (crossThreadDigest) {
    volatileLines.push("");
    volatileLines.push(crossThreadDigest);
}

// After:
const crossThreadResult = buildCrossThreadDigest(db, userId, threadId);
if (crossThreadResult.text) {
    volatileLines.push("");
    volatileLines.push(crossThreadResult.text);
}
```

Capture the sources in a variable accessible to the debug construction. Declare `let crossThreadSources: CrossThreadSource[] | undefined;` near the top of the volatile section, then after the call:

```typescript
if (crossThreadResult.sources.length > 0) {
    crossThreadSources = crossThreadResult.sources;
}
```

At BOTH debug return points (lines 1203-1212 and 1222-1232), add the optional field:

```typescript
// In both return statements, add to the debug object:
debug: {
    contextWindow: params.contextWindow ?? 128000,
    totalEstimated,
    model: params.currentModel ?? "unknown",
    sections,
    budgetPressure,
    truncated: truncatedCount,
    ...(crossThreadSources ? { crossThreadSources } : {}),
},
```

Add the import at the top of context-assembly.ts:

```typescript
import type { CrossThreadSource } from "@bound/shared";
```

Note: `threadId` is already available in the `assembleContext` function scope via `params.threadId` (it's destructured from `ContextParams`).

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No type errors.

Run: `bun test packages/agent/src/__tests__/volatile-enrichment.test.ts`
Expected: Existing tests will FAIL because they expect `buildCrossThreadDigest` to return a string, but it now returns an object. These are fixed in Task 3.

**Commit:** `feat(agent): return structured CrossThreadSource data from buildCrossThreadDigest`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Update existing tests and add new tests for structured return

**Verifies:** metro-interchange-ui.AC3.1, metro-interchange-ui.AC3.2, metro-interchange-ui.AC3.7

**Files:**
- Modify: `packages/agent/src/__tests__/volatile-enrichment.test.ts:677-749` (existing buildCrossThreadDigest tests)
- Modify: `packages/agent/src/__tests__/context-assembly.test.ts` (add new test for crossThreadSources in debug)

**Testing:**

Tests must verify each AC listed above:

- **metro-interchange-ui.AC3.1:** `buildCrossThreadDigest` returns `{ text, sources }` where `sources` is a `CrossThreadSource[]` with correct `threadId`, `title`, `color`, `messageCount`, `lastMessageAt` for each thread. Verify the text portion still contains the same digest content (thread titles, summaries, message counts). Verify `sources.length` matches the number of threads. Verify each source has the correct `color` value from the thread row.

- **metro-interchange-ui.AC3.2:** After calling `assembleContext` with threads that have cross-thread context, verify `result.debug.crossThreadSources` is an array with the expected source entries. Create a test user with multiple threads, insert messages, then call `assembleContext` and check the debug output contains `crossThreadSources`.

- **metro-interchange-ui.AC3.7:** Parse a `ContextDebugInfo` JSON string that lacks `crossThreadSources` field (simulating old turn data). Verify `parsed.crossThreadSources` is `undefined` (not an error). This verifies backward compatibility — the field is optional.

**Existing test updates in volatile-enrichment.test.ts:**

The two existing tests at lines 693-720 and 722-748 call `buildCrossThreadDigest` and check the string result. Update them to destructure `{ text }` from the return:
- `const { text } = buildCrossThreadDigest(db, userId);` then check `text` instead of `digest`
- Add assertions on the `sources` array: verify length, verify each source has `threadId`, `title`, `color`, `messageCount`, `lastMessageAt`

**New tests to add:**

1. In volatile-enrichment.test.ts, add a test that creates threads with different `color` values (e.g., 0, 3, 7) and verifies each source in the returned array has the matching color.

2. In volatile-enrichment.test.ts, add a test that verifies empty threads list returns `{ text: "No recent activity.", sources: [] }`.

3. In context-assembly.test.ts, add a test in the volatile enrichment section that verifies `debug.crossThreadSources` is populated when cross-thread context exists.

4. In context-assembly.test.ts (or volatile-enrichment.test.ts), add a backward compat test: `JSON.parse(JSON.stringify({ contextWindow: 128000, totalEstimated: 0, model: "test", sections: [], budgetPressure: false, truncated: 0 }))` — verify accessing `.crossThreadSources` yields `undefined`.

5. In volatile-enrichment.test.ts, add a test that creates thread A (current) and thread B (other), calls `buildCrossThreadDigest(db, userId, threadA.id)`, and verifies the returned `sources` array contains only thread B — not thread A. This verifies the `excludeThreadId` parameter works correctly.

Follow project testing patterns: `bun:test` describe/it/expect, temp SQLite databases with `randomBytes(4).toString("hex")` paths, direct SQL inserts for test data.

**Verification:**

Run: `bun test packages/agent/src/__tests__/volatile-enrichment.test.ts`
Expected: All existing + new tests pass.

Run: `bun test packages/agent/src/__tests__/context-assembly.test.ts`
Expected: All existing + new tests pass.

Run: `bun test packages/agent --recursive`
Expected: All agent package tests pass (no regressions).

**Commit:** `test(agent): update and add tests for structured cross-thread source data`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
