# Memory Visibility — Phase 2: Enrichment Helpers

**Goal:** Implement `computeBaseline()` and `buildVolatileEnrichment()` in `summary-extraction.ts`, fully tested in isolation.

**Architecture:** Two new exported functions added after the existing exports in `packages/agent/src/summary-extraction.ts`. `computeBaseline` implements the R-MV4 fallback chain (thread timestamps → task timestamps → epoch). `buildVolatileEnrichment` runs two bounded queries (memory delta + task digest), applies source resolution and value truncation, and returns formatted line arrays. Two private helpers (`resolveSource`, `relativeTime`) support the formatting. A new test file covers all ACs for baseline computation, delta/digest logic, and source resolution.

**Tech Stack:** bun:sqlite, TypeScript, bun:test

**Scope:** Phase 2 of 5 from design plan

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### memory-visibility.AC2: Memory delta entries
- **memory-visibility.AC2.1 Success:** Entry with modified_at after baseline appears in delta
- **memory-visibility.AC2.2 Failure:** Entry with modified_at before baseline does not appear
- **memory-visibility.AC2.3 Success:** Tombstoned entry (deleted=1) appears as `[forgotten]` with relative time and source
- **memory-visibility.AC2.4 Edge:** 11 entries changed → 10 shown + "... and 1 more (query semantic_memory for full list)"
- **memory-visibility.AC2.5 Edge:** Value longer than 120 chars is truncated with "..." suffix

### memory-visibility.AC3: Task run digest entries
- **memory-visibility.AC3.1 Success:** Task with last_run_at after baseline and consecutive_failures=0 shows as "ran"
- **memory-visibility.AC3.2 Success:** Task with consecutive_failures > 0 shows as "failed"
- **memory-visibility.AC3.3 Success:** Task's host_name is resolved from the hosts table via claimed_by
- **memory-visibility.AC3.4 Edge:** No matching hosts row → host label falls back to claimed_by[0:8]
- **memory-visibility.AC3.5 Edge:** 6 tasks ran since baseline → 5 shown + "... and 1 more (query tasks for full list)"
- **memory-visibility.AC3.6 Failure:** Task with last_run_at before baseline does not appear in digest
- **memory-visibility.AC3.7 Failure:** Soft-deleted task (deleted=1) does not appear in digest

### memory-visibility.AC4: Baseline computation (R-MV4 fallback chain)
- **memory-visibility.AC4.1 Success:** noHistory=false → baseline is thread.last_message_at
- **memory-visibility.AC4.2 Edge:** noHistory=false, thread.last_message_at is NULL → baseline is thread.created_at
- **memory-visibility.AC4.3 Success:** noHistory=true with taskId → baseline is task.last_run_at
- **memory-visibility.AC4.4 Edge:** noHistory=true, task.last_run_at is NULL (first run) → baseline is task.created_at
- **memory-visibility.AC4.5 Edge:** noHistory=true with no taskId → baseline is epoch (1970-01-01T00:00:00.000Z)

### memory-visibility.AC5: Source resolution
- **memory-visibility.AC5.1 Success:** source matching tasks.id resolves to `task "trigger_spec_name"`
- **memory-visibility.AC5.2 Success:** source matching an active threads.id resolves to `thread "title"`
- **memory-visibility.AC5.3 Edge:** source matching an untitled thread resolves to `thread "id[0:8]"`
- **memory-visibility.AC5.4 Edge:** source matching a quarantined/deleted thread (deleted=1) falls back to truncated raw ID (title not surfaced)
- **memory-visibility.AC5.5 Edge:** source not matching any tasks or threads row resolves to source[0:8]
- **memory-visibility.AC5.6 Edge:** null source resolves to "unknown"

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Implement computeBaseline and buildVolatileEnrichment in summary-extraction.ts

**Verifies:** AC2.1–2.5, AC3.1–3.7, AC4.1–4.5, AC5.1–5.6 (implementation step; tests in Task 2)

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts` (append new exports and private helpers after the last existing function)

**Step 1: Open the file and locate the insertion point**

Open `packages/agent/src/summary-extraction.ts`. The file currently ends after the `buildCrossThreadDigest` function (~line 155). Append all new code after the final `}` of that function.

**Step 2: Add the two private helper functions**

These helpers are not exported — they are module-private utilities used only by `buildVolatileEnrichment`.

```typescript
function resolveSource(
	taskName: string | null,
	threadId: string | null,
	threadTitle: string | null,
	source: string | null,
): string {
	if (taskName !== null) return `task "${taskName}"`;
	if (threadId !== null) {
		// source matched a non-deleted thread (may or may not have a title)
		return `thread "${threadTitle ?? threadId.slice(0, 8)}"`;
	}
	if (source === null) return "unknown";
	return source.slice(0, 8);
}

function relativeTime(isoString: string): string {
	const diffMs = Date.now() - new Date(isoString).getTime();
	const diffSeconds = Math.floor(diffMs / 1000);
	if (diffSeconds < 60) return "just now";
	const diffMinutes = Math.floor(diffSeconds / 60);
	if (diffMinutes < 60) return `${diffMinutes}m ago`;
	const diffHours = Math.floor(diffMinutes / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	const diffDays = Math.floor(diffHours / 24);
	return `${diffDays}d ago`;
}
```

**Step 3: Add computeBaseline**

```typescript
/**
 * Computes the baseline timestamp (ISO string) for delta queries.
 * Implements the R-MV4 fallback chain:
 *   noHistory=false → thread.last_message_at ?? thread.created_at
 *   noHistory=true + taskId → task.last_run_at ?? task.created_at
 *   noHistory=true + no taskId → epoch
 */
export function computeBaseline(
	db: Database,
	threadId: string,
	taskId?: string,
	noHistory?: boolean,
): string {
	const EPOCH = "1970-01-01T00:00:00.000Z";

	if (noHistory) {
		if (taskId) {
			const row = db
				.prepare("SELECT last_run_at, created_at FROM tasks WHERE id = ?")
				.get(taskId) as { last_run_at: string | null; created_at: string } | null;
			if (row === null) return EPOCH;
			return row.last_run_at ?? row.created_at;
		}
		return EPOCH;
	}

	const row = db
		.prepare("SELECT last_message_at, created_at FROM threads WHERE id = ?")
		.get(threadId) as { last_message_at: string | null; created_at: string } | null;
	if (row === null) return EPOCH;
	return row.last_message_at ?? row.created_at;
}
```

**Step 4: Add buildVolatileEnrichment**

```typescript
export interface VolatileEnrichment {
	memoryDeltaLines: string[];
	taskDigestLines: string[];
}

/**
 * Queries the database for memory entries and tasks that changed since
 * the given baseline timestamp. Returns formatted line arrays for
 * injection into the volatile context block.
 *
 * Delta reads do NOT update last_accessed_at (queries are SELECT-only).
 */
export function buildVolatileEnrichment(
	db: Database,
	baseline: string,
	maxMemory = 10,
	maxTasks = 5,
): VolatileEnrichment {
	// Memory delta query — fetch maxMemory+1 to detect overflow
	const memoryRows = db
		.prepare(
			`SELECT m.key, m.value, m.modified_at, m.deleted,
			        t_src.trigger_spec AS task_name,
			        th_src.id          AS thread_id,
			        th_src.title       AS thread_title,
			        m.source
			 FROM   semantic_memory m
			 LEFT JOIN tasks   t_src  ON m.source = t_src.id
			 LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0
			 WHERE  m.modified_at > ?
			 ORDER  BY m.modified_at DESC
			 LIMIT  ?`,
		)
		.all(baseline, maxMemory + 1) as Array<{
		key: string;
		value: string;
		modified_at: string;
		deleted: number;
		task_name: string | null;
		thread_id: string | null;
		thread_title: string | null;
		source: string | null;
	}>;

	const hasMoreMemory = memoryRows.length > maxMemory;
	const visibleMemoryRows = hasMoreMemory ? memoryRows.slice(0, maxMemory) : memoryRows;

	const memoryDeltaLines: string[] = [];
	for (const row of visibleMemoryRows) {
		const sourceLabel = resolveSource(row.task_name, row.thread_id, row.thread_title, row.source);
		const relTime = relativeTime(row.modified_at);
		if (row.deleted) {
			memoryDeltaLines.push(`- ${row.key}: [forgotten] (${relTime}, via ${sourceLabel})`);
		} else {
			const value = row.value.length > 120 ? `${row.value.slice(0, 120)}...` : row.value;
			memoryDeltaLines.push(`- ${row.key}: ${value} (${relTime}, via ${sourceLabel})`);
		}
	}
	if (hasMoreMemory) {
		memoryDeltaLines.push(
			`... and ${memoryRows.length - maxMemory} more (query semantic_memory for full list)`,
		);
	}

	// Task digest query — fetch maxTasks+1 to detect overflow
	const taskRows = db
		.prepare(
			`SELECT t.trigger_spec, t.last_run_at, t.consecutive_failures, t.claimed_by,
			        h.host_name
			 FROM   tasks t
			 LEFT JOIN hosts h ON t.claimed_by = h.site_id
			 WHERE  t.last_run_at > ?
			   AND  t.last_run_at IS NOT NULL
			   AND  t.deleted = 0
			 ORDER  BY t.last_run_at DESC
			 LIMIT  ?`,
		)
		.all(baseline, maxTasks + 1) as Array<{
		trigger_spec: string;
		last_run_at: string;
		consecutive_failures: number;
		claimed_by: string | null;
		host_name: string | null;
	}>;

	const hasMoreTasks = taskRows.length > maxTasks;
	const visibleTaskRows = hasMoreTasks ? taskRows.slice(0, maxTasks) : taskRows;

	const taskDigestLines: string[] = [];
	for (const row of visibleTaskRows) {
		const status = row.consecutive_failures === 0 ? "ran" : "failed";
		const hostLabel =
			row.host_name ?? (row.claimed_by ? row.claimed_by.slice(0, 8) : "unknown");
		const relTime = relativeTime(row.last_run_at);
		taskDigestLines.push(`- ${row.trigger_spec} ${status} (${relTime} on ${hostLabel})`);
	}
	if (hasMoreTasks) {
		taskDigestLines.push(
			`... and ${taskRows.length - maxTasks} more (query tasks for full list)`,
		);
	}

	return { memoryDeltaLines, taskDigestLines };
}
```

**Step 5: Verify TypeScript**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors. If there are import errors for `Database`, it is already imported at the top of the file (`import type { Database } from "bun:sqlite"`).

Do NOT commit yet — wait for tests to pass in Task 2.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create volatile-enrichment.test.ts covering all ACs

**Verifies:** memory-visibility.AC2.1–2.5, memory-visibility.AC3.1–3.7, memory-visibility.AC4.1–4.5, memory-visibility.AC5.1–5.6

**Files:**
- Create: `packages/agent/src/__tests__/volatile-enrichment.test.ts`

**Test file imports to use:**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow, softDelete } from "@bound/core";
import type { Database } from "bun:sqlite";
import { buildVolatileEnrichment, computeBaseline } from "../summary-extraction.js";
```

**Test database setup pattern (use in beforeEach/afterEach):**

```typescript
let db: Database;
let dbPath: string;

beforeEach(() => {
    dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
    db = createDatabase(dbPath);
    applySchema(db);
});

afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
});
```

**Test helper for a fake siteId:** Use `randomBytes(8).toString("hex")` once per test if needed as a siteId argument to `insertRow`.

**Tests to write:**

#### describe("computeBaseline")

- **AC4.1** — `it("returns thread.last_message_at when noHistory is false")`: Insert a thread with a specific `last_message_at` timestamp. Call `computeBaseline(db, threadId)`. Assert the return value equals `last_message_at`.

- **AC4.2** — `it("returns thread.created_at when last_message_at is null (defensive path)")`: **Note:** `threads.last_message_at` is `TEXT NOT NULL` in the schema, so this state cannot occur via `insertRow`. Use a raw SQL INSERT to bypass the constraint: `db.run("INSERT INTO threads (id, user_id, interface, host_origin, color, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, 'web', 'test', 0, ?, NULL, ?, 0)", [threadId, userId, created_at, created_at])`. Call `computeBaseline(db, threadId)`. Assert the return value equals `created_at`. This tests the defensive `?? row.created_at` fallback in the implementation.

- **AC4.3** — `it("returns task.last_run_at when noHistory is true and taskId given")`: Insert a task with a known `last_run_at`. Call `computeBaseline(db, "", taskId, true)`. Assert the return equals `last_run_at`.

- **AC4.4** — `it("returns task.created_at when last_run_at is null (first run)")`: Insert a task with `last_run_at: null` and a known `created_at`. Call `computeBaseline(db, "", taskId, true)`. Assert the return equals `created_at`.

- **AC4.5** — `it("returns epoch when noHistory is true and no taskId")`: Call `computeBaseline(db, "")` with `noHistory=true` and no taskId. Assert the return equals `"1970-01-01T00:00:00.000Z"`.

#### describe("buildVolatileEnrichment — memory delta")

Use a baseline of e.g. `"2026-03-01T00:00:00.000Z"` and insert entries with modified_at before and after it.

- **AC2.1** — `it("includes entry with modified_at after baseline")`: Insert a memory entry with `modified_at` after baseline. Call `buildVolatileEnrichment(db, baseline)`. Assert `memoryDeltaLines` has one entry starting with `- ${key}:`.

- **AC2.2** — `it("excludes entry with modified_at before baseline")`: Insert a memory entry with `modified_at` before baseline. Assert `memoryDeltaLines` is empty.

- **AC2.3** — `it("renders tombstoned entry as [forgotten]")`: Insert a memory entry, then call `softDelete(db, "semantic_memory", id, siteId)`. Insert with a `modified_at` after baseline (note: softDelete updates `modified_at`; ensure the resulting `modified_at` is after baseline by setting a past baseline). Assert `memoryDeltaLines[0]` contains `[forgotten]` and does not contain the original value.

- **AC2.4** — `it("shows overflow line when more than maxMemory entries changed")`: Insert 11 entries all with `modified_at` after baseline. Call `buildVolatileEnrichment(db, baseline, 10)`. Assert `memoryDeltaLines` has 11 items: 10 entries + `"... and 1 more (query semantic_memory for full list)"`.

- **AC2.5** — `it("truncates value longer than 120 chars")`: Insert an entry whose `value` is exactly 130 characters. Assert the corresponding line in `memoryDeltaLines` contains a value ending with `"..."` and the full 130-char value is NOT present.

#### describe("buildVolatileEnrichment — task digest")

Use the same baseline pattern.

- **AC3.1** — `it("shows 'ran' for task with consecutive_failures=0")`: Insert a task with `last_run_at` after baseline and `consecutive_failures: 0`. Assert `taskDigestLines[0]` contains ` ran `.

- **AC3.2** — `it("shows 'failed' for task with consecutive_failures>0")`: Insert a task with `consecutive_failures: 2`. Assert `taskDigestLines[0]` contains ` failed `.

- **AC3.3** — `it("resolves host_name from hosts table")`: Insert a hosts row with `site_id` and `host_name: "my-host"`. Insert a task with `claimed_by` set to that `site_id`. Assert `taskDigestLines[0]` contains `my-host`.

- **AC3.4** — `it("falls back to claimed_by[0:8] when no hosts row")`: Insert a task with `claimed_by: "abcdef1234567890"` and no matching hosts row. Assert `taskDigestLines[0]` contains `abcdef12` (first 8 chars).

- **AC3.5** — `it("shows overflow line when more than maxTasks tasks ran")`: Insert 6 tasks all with `last_run_at` after baseline. Call `buildVolatileEnrichment(db, baseline, 10, 5)`. Assert `taskDigestLines` has 6 items: 5 tasks + `"... and 1 more (query tasks for full list)"`.

- **AC3.6** — `it("excludes task with last_run_at before baseline")`: Insert a task with `last_run_at` before baseline. Assert `taskDigestLines` is empty.

- **AC3.7** — `it("excludes soft-deleted tasks")`: Insert a task with `last_run_at` after baseline, then `softDelete(db, "tasks", id, siteId)`. Assert `taskDigestLines` is empty.

#### describe("buildVolatileEnrichment — source resolution")

Insert a memory entry after baseline with a specific `source` value for each case.

- **AC5.1** — `it("resolves source matching task id to task name")`: Insert a task row with `id = someTaskId, trigger_spec: "my_cron"`. Insert a memory entry with `source: someTaskId, modified_at > baseline`. Assert the delta line contains `via task "my_cron"`.

- **AC5.2** — `it("resolves source matching active thread id to thread title")`: Insert a thread row with `id = someThreadId, title: "My Thread", deleted: 0`. Insert memory entry with `source: someThreadId`. Assert delta line contains `via thread "My Thread"`.

- **AC5.3** — `it("resolves untitled thread source to thread id prefix")`: Insert a thread with `title: null`. Assert delta line contains `via thread "${someThreadId.slice(0, 8)}"`.

- **AC5.4** — `it("falls back to id prefix for deleted thread source")`: Insert a thread (with a title), then insert a memory entry with `source` set to that thread's id and `modified_at` after baseline, THEN call `softDelete(db, "threads", threadId, siteId)`. The order matters — the memory entry must exist before the thread is deleted. Assert the delta line contains the first 8 chars of the thread id AND does NOT contain `thread "` (the LEFT JOIN excludes `th_src.deleted = 1` rows, so `thread_id` is null and resolution falls back to `source.slice(0, 8)`).

- **AC5.5** — `it("falls back to source[0:8] for unmatched source")`: Insert memory entry with `source: "zzzzzzzz1234"` (no matching task or thread). Assert delta line contains `via zzzzzzzz`.

- **AC5.6** — `it("resolves null source to 'unknown'")`: Insert memory entry with `source: null`. Assert delta line contains `via unknown`.

**Key notes for test data insertion:**

When inserting into `semantic_memory`, include all required columns:
```typescript
insertRow(db, "semantic_memory", {
    id: randomBytes(8).toString("hex"),
    key: "test-key",
    value: "test-value",
    source: null,
    created_at: new Date().toISOString(),
    modified_at: "2026-03-15T12:00:00.000Z",  // set explicitly for timing tests
    deleted: 0,
}, siteId);
```

When inserting into `tasks`, include all required NOT NULL columns. Minimum viable task row:
```typescript
insertRow(db, "tasks", {
    id: randomBytes(8).toString("hex"),
    type: "cron",
    status: "active",
    trigger_spec: "test-task",
    created_at: new Date().toISOString(),
    modified_at: new Date().toISOString(),
    last_run_at: "2026-03-15T12:00:00.000Z",
    consecutive_failures: 0,
    claimed_by: null,
    deleted: 0,
}, siteId);
```

For `hosts` rows:
```typescript
insertRow(db, "hosts", {
    site_id: "test-site-id",
    host_name: "my-host",
    modified_at: new Date().toISOString(),
    deleted: 0,
}, siteId);
```

For `threads` rows (minimum required columns — check schema.ts for exact list):
```typescript
insertRow(db, "threads", {
    id: threadId,
    user_id: "test-user",
    interface: "web",
    host_origin: "test",
    color: 0,
    title: "My Thread",
    created_at: new Date().toISOString(),
    last_message_at: "2026-03-20T00:00:00.000Z",
    modified_at: new Date().toISOString(),
    deleted: 0,
}, siteId);
```

**Step 3: Run tests**

Run: `bun test packages/agent/src/__tests__/volatile-enrichment.test.ts`
Expected: All tests pass, 0 failures.

**Step 4: Run full agent suite to ensure no regressions**

Run: `bun test packages/agent`
Expected: Same pass count as before (331 pass, 1 pre-existing just-bash error), plus the new volatile-enrichment tests.

**Step 5: Commit**

```bash
git add packages/agent/src/summary-extraction.ts packages/agent/src/__tests__/volatile-enrichment.test.ts
git commit -m "feat(agent): add computeBaseline and buildVolatileEnrichment helpers"
```
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->
