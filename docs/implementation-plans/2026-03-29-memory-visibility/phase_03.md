# Memory Visibility — Phase 3: Context Assembly Integration

**Goal:** Wire Stage 5.5 (VOLATILE ENRICHMENT) into `assembleContext()`, replacing the old raw memory dump, and handle both `noHistory=false` and `noHistory=true` paths with correct budget pressure fallback.

**Architecture:** `context-assembly.ts` gains four changes: (1) extended import from `summary-extraction.js`; (2) four hoisted variables to share enrichment state between Stage 6 and Stage 7; (3) replacement of lines 638–651 (raw memory dump) with baseline computation + enrichment injection inside the `if (!noHistory)` block; (4) a new `if (noHistory)` block after the existing volatile context guard that injects a standalone enrichment system message; (5) a budget pressure check in Stage 7 that reduces enrichment caps to 3+3 when headroom falls below 2,000 tokens.

**Tech Stack:** TypeScript, bun:sqlite, bun:test

**Scope:** Phase 3 of 5 from design plan

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### memory-visibility.AC1: Stage 5.5 enrichment injected into assembled context
- **memory-visibility.AC1.1 Success:** Memory delta lines appear in volatile context when entries changed since baseline
- **memory-visibility.AC1.2 Success:** Task run digest lines appear in volatile context when tasks ran since baseline
- **memory-visibility.AC1.3 Success:** noHistory=true context gets a standalone enrichment system message when delta is non-empty
- **memory-visibility.AC1.4 Edge:** noHistory=true context gets no enrichment message when delta and digest are both empty
- **memory-visibility.AC1.5 Edge:** When budget headroom falls below 2,000 tokens, enrichment is truncated to 3 memory entries + 3 task entries

### memory-visibility.AC2: Memory delta entries
- **memory-visibility.AC2.6 Success:** Memory header line shows total entry count and number changed since baseline

### memory-visibility.AC8: Cross-cutting behaviors
- **memory-visibility.AC8.1:** Delta reads do not update last_accessed_at on any semantic_memory row
- **memory-visibility.AC8.2:** Old raw memory dump format (bare "Semantic Memory:" header with key: value lines) is absent from all assembled contexts

---

<!-- START_SUBCOMPONENT_A (tasks 1-4) -->

<!-- START_TASK_1 -->
### Task 1: Extend import and hoist enrichment state variables

**Verifies:** (setup for AC1.1–1.5, AC2.6, AC8.1–8.2)

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` (~line 7 import + 4 new let declarations after params destructuring)

**Step 1: Extend the summary-extraction.js import**

Open `packages/agent/src/context-assembly.ts`. Search for the line containing `buildCrossThreadDigest` in the imports (~line 7). It currently reads:
```typescript
import { buildCrossThreadDigest } from "./summary-extraction.js";
```

Replace it with:
```typescript
import {
	buildCrossThreadDigest,
	buildVolatileEnrichment,
	computeBaseline,
} from "./summary-extraction.js";
```

**Step 2: Hoist four enrichment state variables**

Locate the destructuring block that extracts `db, threadId, userId, noHistory` from `params` (~line 106, search for `noHistory = false`). Immediately AFTER that destructuring block (after its closing `}`), add these four variables:

```typescript
// Enrichment state — shared between Stage 6 volatile context and Stage 7 budget check
let enrichmentBaseline: string | undefined;
let enrichmentMessageIndex = -1;
let preEnrichmentVolatileLines: string[] = [];
let totalMemCount = 0;
```

These must be in the outer function scope, not inside any `if` block, so Stage 7 can access them.

**Step 3: Verify TypeScript**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors. Do NOT commit yet.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Replace raw memory dump with enrichment in the noHistory=false path

**Verifies:** memory-visibility.AC1.1, memory-visibility.AC1.2, memory-visibility.AC2.6, memory-visibility.AC8.1, memory-visibility.AC8.2

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` (inside the `if (!noHistory)` block; search for `// Include semantic memory entries`)

**Step 1: Locate the raw memory dump block**

Search for the comment `// Include semantic memory entries` inside the `if (!noHistory)` block (~line 638). The full block to remove looks like:

```typescript
// Include semantic memory entries
const semanticMemories = db
	.query(
		"SELECT key, value FROM semantic_memory WHERE deleted = 0 ORDER BY modified_at DESC LIMIT 10",
	)
	.all() as Array<{ key: string; value: string }>;

if (semanticMemories.length > 0) {
	volatileLines.push("");
	volatileLines.push("Semantic Memory:");
	for (const mem of semanticMemories) {
		volatileLines.push(`  ${mem.key}: ${mem.value}`);
	}
}
```

**Step 2: Before adding enrichment to volatileLines, snapshot the base content**

Find the point in the `if (!noHistory)` block just BEFORE the raw memory dump block (lines 638–651). Insert the following, replacing the entire raw memory dump block:

```typescript
		// Stage 5.5: VOLATILE ENRICHMENT (replaces raw memory dump)
		enrichmentBaseline = computeBaseline(db, threadId, params.taskId, false);
		const { memoryDeltaLines, taskDigestLines } = buildVolatileEnrichment(db, enrichmentBaseline);

		// Query total memory count for the header line
		totalMemCount = (
			db.prepare("SELECT COUNT(*) AS c FROM semantic_memory WHERE deleted = 0").get() as {
				c: number;
			}
		).c;

		// Snapshot base volatile content before enrichment (needed for budget pressure rebuild)
		preEnrichmentVolatileLines = [...volatileLines];

		// Format and append enrichment
		const memChangedCount = memoryDeltaLines.filter((l) => l.startsWith("- ")).length;
		let memHeaderLine = `Memory: ${totalMemCount} entries`;
		if (memChangedCount > 0) {
			memHeaderLine += ` (${memChangedCount} changed since your last turn in this thread)`;
		}
		volatileLines.push("");
		volatileLines.push(memHeaderLine);
		if (memoryDeltaLines.length > 0) {
			volatileLines.push(...memoryDeltaLines);
		}
		if (taskDigestLines.length > 0) {
			volatileLines.push("");
			volatileLines.push(...taskDigestLines);
		}
```

**Step 4: Track the volatile context message index before pushing**

Find the line near the end of the `if (!noHistory)` block that pushes the volatile context message (search for `volatileLines.join("\n")`; ~line 733–736):
```typescript
assembled.push({ role: "system", content: volatileLines.join("\n") });
```

Insert the index tracking immediately BEFORE this push:
```typescript
		enrichmentMessageIndex = assembled.length;
		assembled.push({ role: "system", content: volatileLines.join("\n") });
```

**Step 5: Verify TypeScript**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add enrichment injection for the noHistory=true path

**Verifies:** memory-visibility.AC1.3, memory-visibility.AC1.4

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` (after the `if (!noHistory)` block, before Stage 7)

**Step 1: Locate the end of the noHistory=false volatile context block**

The `if (!noHistory) { ... }` block ends immediately before the `// Stage 7: BUDGET_VALIDATION` comment (~line 739). Search for `// Stage 7: BUDGET_VALIDATION` to locate the boundary.

**Step 2: Insert the noHistory=true enrichment block**

Add the following code immediately AFTER the closing `}` of the `if (!noHistory)` block and BEFORE the Stage 7 comment:

```typescript
		// Stage 5.5 (noHistory path): Inject enrichment as standalone system message for autonomous tasks
		if (noHistory) {
			enrichmentBaseline = computeBaseline(db, threadId, params.taskId, true);
			const { memoryDeltaLines: noHistDelta, taskDigestLines: noHistTasks } =
				buildVolatileEnrichment(db, enrichmentBaseline);

			if (noHistDelta.length > 0 || noHistTasks.length > 0) {
				totalMemCount = (
					db
						.prepare("SELECT COUNT(*) AS c FROM semantic_memory WHERE deleted = 0")
						.get() as { c: number }
				).c;

				const noHistMemChangedCount = noHistDelta.filter((l) => l.startsWith("- ")).length;
				let noHistMemHeader = `Memory: ${totalMemCount} entries`;
				if (noHistMemChangedCount > 0) {
					noHistMemHeader += ` (${noHistMemChangedCount} changed since your last run)`;
				}

				const enrichmentLines: string[] = [];
				enrichmentLines.push(noHistMemHeader);
				if (noHistDelta.length > 0) {
					enrichmentLines.push(...noHistDelta);
				}
				if (noHistTasks.length > 0) {
					enrichmentLines.push("");
					enrichmentLines.push(...noHistTasks);
				}

				enrichmentMessageIndex = assembled.length;
				assembled.push({ role: "system", content: enrichmentLines.join("\n") });
			}
		}
```

**Step 3: Verify TypeScript**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Add budget pressure check in Stage 7

**Verifies:** memory-visibility.AC1.5

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` (inside Stage 7, BEFORE existing truncation logic)

**Step 1: Understand the current Stage 7 structure**

Stage 7 starts with the comment `// Stage 7: BUDGET_VALIDATION` (~line 739). It computes `totalTokens` as a heuristic (character length / 4), then trims history messages if over budget. The existing truncation block contains an **early return** (`return [...systemMessages, ...remaining]`) that exits the function before any code placed after the block can run.

**This means:** the budget pressure check MUST be inserted BEFORE the existing `if (totalTokens > contextWindow) { ... }` block — not after it. The correct order is:
1. Check headroom; if < 2000 tokens, reduce enrichment in `assembled` in place
2. Then let existing history trimming run on the (now smaller) `assembled`
3. The early return in the trimming block returns the correct final array

**Step 2: Locate the START of the existing truncation logic**

Find the line `const totalTokens = assembled.reduce(...)` at the start of Stage 7. The enrichment reduction block must be inserted BEFORE this line (i.e., as the very first thing in Stage 7, before `totalTokens` is even computed).

**Step 3: Add budget pressure enrichment reduction BEFORE the existing truncation**

Insert the following as the FIRST code inside Stage 7 (immediately after the `// Stage 7: BUDGET_VALIDATION` comment and before `const totalTokens = ...`):

```typescript
		// Budget pressure check: reduce enrichment caps if headroom < 2,000 tokens
		if (enrichmentBaseline !== undefined && enrichmentMessageIndex >= 0) {
			const currentTotal = assembled.reduce((sum, msg) => {
				const contentLength =
					typeof msg.content === "string" ? msg.content.length : 0;
				return sum + Math.ceil(contentLength / 4);
			}, 0);
			const headroom = contextWindow - currentTotal;

			if (headroom < 2000) {
				const { memoryDeltaLines: shortDelta, taskDigestLines: shortDigest } =
					buildVolatileEnrichment(db, enrichmentBaseline, 3, 3);

				const shortMemChangedCount = shortDelta.filter((l) => l.startsWith("- ")).length;
				let shortMemHeader = `Memory: ${totalMemCount} entries`;
				if (shortMemChangedCount > 0) {
					shortMemHeader +=
						!params.noHistory
							? ` (${shortMemChangedCount} changed since your last turn in this thread)`
							: ` (${shortMemChangedCount} changed since your last run)`;
				}

				if (!params.noHistory) {
					// Rebuild volatile context with reduced enrichment
					const shortVolatileLines = [...preEnrichmentVolatileLines];
					shortVolatileLines.push("");
					shortVolatileLines.push(shortMemHeader);
					if (shortDelta.length > 0) {
						shortVolatileLines.push(...shortDelta);
					}
					if (shortDigest.length > 0) {
						shortVolatileLines.push("");
						shortVolatileLines.push(...shortDigest);
					}
					if (enrichmentMessageIndex < assembled.length) {
						assembled[enrichmentMessageIndex] = {
							role: "system",
							content: shortVolatileLines.join("\n"),
						};
					}
				} else {
					// Rebuild standalone enrichment message with reduced enrichment
					const shortEnrichmentLines: string[] = [shortMemHeader];
					if (shortDelta.length > 0) {
						shortEnrichmentLines.push(...shortDelta);
					}
					if (shortDigest.length > 0) {
						shortEnrichmentLines.push("");
						shortEnrichmentLines.push(...shortDigest);
					}
					if (enrichmentMessageIndex < assembled.length) {
						assembled[enrichmentMessageIndex] = {
							role: "system",
							content: shortEnrichmentLines.join("\n"),
						};
					}
				}
			}
		}
```

**Step 4: Verify TypeScript**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.

**Step 5: Run agent tests before adding new tests**

Run: `bun test packages/agent`
Expected: Same baseline (331 pass, 1 pre-existing just-bash error) — no regressions from pipeline changes.
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Add context-assembly.test.ts cases for Stage 5.5

**Verifies:** memory-visibility.AC1.1–1.5, memory-visibility.AC2.6, memory-visibility.AC8.1, memory-visibility.AC8.2

**Files:**
- Modify: `packages/agent/src/__tests__/context-assembly.test.ts` (append new describe block at the end)

**Test setup needed:**

The test file already sets up a database, thread, and user. For these tests you need to also insert `semantic_memory` rows and `tasks` rows. Use `insertRow` from `@bound/core`. Import it if not already imported.

Check the existing import at the top of `context-assembly.test.ts` — add `insertRow, softDelete` if not present:
```typescript
import { applySchema, createDatabase, insertRow, softDelete } from "@bound/core";
```

**Tests to add (append a new `describe("Stage 5.5: volatile enrichment", ...)` block):**

For all tests in this block, use a baseline-friendly setup: insert the thread with `last_message_at` set to a timestamp in the past (e.g., `"2026-01-01T00:00:00.000Z"`) so that any memory entries inserted with `modified_at` after that timestamp appear in the delta.

- **AC1.1 + AC2.6** — `it("includes memory delta lines and header in volatile context when entries changed since baseline")`:
  1. Insert a memory entry with `modified_at` AFTER the thread's `last_message_at`
  2. Call `assembleContext({ db, threadId, userId })`
  3. Find the system message whose content contains `"Memory:"`
  4. Assert it contains `"changed since your last turn"`
  5. Assert it contains the key of the inserted memory entry

- **AC8.2** — `it("does not include raw 'Semantic Memory:' format in any assembled message")`:
  1. Insert a memory entry
  2. Call `assembleContext`
  3. Assert NO message in the result has content containing `"Semantic Memory:"`

- **AC1.2** — `it("includes task digest lines when tasks ran since baseline")`:
  1. Insert a task row with `last_run_at` AFTER the thread's `last_message_at`, `consecutive_failures: 0`
  2. Call `assembleContext`
  3. Find the message containing `"Memory:"`
  4. Assert it contains the task's `trigger_spec` and `" ran "`

- **AC1.3** — `it("noHistory=true: pushes standalone enrichment system message when delta is non-empty")`:
  1. Insert a memory entry with `modified_at` after a recent baseline (use a task with known `last_run_at` as baseline, or use a thread with `last_message_at` set — for noHistory=true with taskId, the baseline is `task.last_run_at`)
  2. Insert a task record to act as the context task (with `last_run_at` set to a past timestamp)
  3. Call `assembleContext({ db, threadId, userId, noHistory: true, taskId: someTaskId })`
  4. Find messages with `role: "system"`
  5. Assert at least one of them contains `"Memory:"` and the memory key

- **AC1.4** — `it("noHistory=true: no enrichment message when delta and digest are both empty")`:
  1. Create a fresh thread with `last_message_at` set to a VERY recent timestamp (so no memory entries changed after it)
  2. Insert a task with `last_run_at` = same recent timestamp
  3. Call `assembleContext({ db, freshThreadId, userId, noHistory: true, taskId: taskId })`
  4. Assert NO system message in the result contains `"Memory:"`

- **AC8.1** — `it("delta reads do not update last_accessed_at on semantic_memory rows")`:
  1. Insert a memory entry; note its current `last_accessed_at` value (may be null)
  2. Call `assembleContext`
  3. Re-query the memory entry from the database
  4. Assert `last_accessed_at` has not changed

- **AC1.5 (budget pressure)** — `it("reduces to 3+3 enrichment when headroom is below 2000 tokens")`:
  1. Insert 10 memory entries all with `modified_at` after the thread's `last_message_at`
  2. Set a very small `contextWindow` (e.g., 500) that forces budget pressure
  3. Call `assembleContext({ db, threadId, userId, contextWindow: 500 })`
  4. Find the system message containing `"Memory:"`
  5. Assert at most 3 memory entry lines (lines starting with `"- "`) appear in the enrichment section (plus possible "... and N more" overflow line)

**Step 2: Run the full agent test suite**

Run: `bun test packages/agent`
Expected: All new tests pass plus the existing 331 pass baseline.

**Step 3: Commit**

```bash
git add packages/agent/src/context-assembly.ts packages/agent/src/__tests__/context-assembly.test.ts
git commit -m "feat(agent): wire Stage 5.5 volatile enrichment into assembleContext"
```
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->
