# Heartbeat Task Implementation Plan - Phase 2

**Goal:** Build heartbeat activity context from database state

**Architecture:** New `heartbeat-context.ts` module that queries four data sources (standing instructions, advisories, task completions, thread activity) and assembles them into a formatted prompt string. All queries are read-only. Uses existing query patterns from `summary-extraction.ts` and `advisories.ts`.

**Tech Stack:** TypeScript, bun:sqlite, bun:test

**Scope:** 4 phases from original design (phase 2 of 4)

**Codebase verified:** 2026-04-04

---

## Acceptance Criteria Coverage

This phase implements and tests:

### heartbeat-task.AC2: Context builder
- **heartbeat-task.AC2.1 Success:** Standing instructions loaded from `_heartbeat_instructions` memory key
- **heartbeat-task.AC2.2 Success:** Default prompt used when `_heartbeat_instructions` key is missing
- **heartbeat-task.AC2.3 Success:** Pending advisory titles listed in context
- **heartbeat-task.AC2.4 Success:** Advisory status changes since last run shown (approved/dismissed/applied)
- **heartbeat-task.AC2.5 Success:** Recent task completions with status and error snippets included
- **heartbeat-task.AC2.6 Success:** Per-thread activity counts since last run included
- **heartbeat-task.AC2.7 Edge:** Context builder handles zero advisories/tasks/threads gracefully

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Implement buildHeartbeatContext

**Verifies:** heartbeat-task.AC2.1, heartbeat-task.AC2.2, heartbeat-task.AC2.3, heartbeat-task.AC2.4, heartbeat-task.AC2.5, heartbeat-task.AC2.6, heartbeat-task.AC2.7

**Files:**
- Create: `packages/agent/src/heartbeat-context.ts`

**Implementation:**

Create a new module that exports `buildHeartbeatContext(db, lastRunAt)`. The function queries four data sections and assembles them into the prompt template from the design plan.

Reference files for query patterns:
- `packages/agent/src/summary-extraction.ts` — memory queries (line 340-355), task queries (line 452-470), thread queries (line 172-181), `relativeTime()` helper (line 247-257)
- `packages/agent/src/commands/advisories.ts` — `getPendingAdvisories()` (line 114-127)
- `packages/agent/src/commands/memorize.ts` — memory key lookup (line 22-24)

```typescript
import type { Database } from "bun:sqlite";

const DEFAULT_INSTRUCTIONS =
	"Review system state. If advisories need attention, address them. If tasks have failed, investigate. Otherwise, note what you observed.";

export function buildHeartbeatContext(db: Database, lastRunAt: string | null): string {
	const instructions = loadStandingInstructions(db);
	const advisorySection = buildAdvisorySection(db, lastRunAt);
	const taskSection = buildTaskSection(db, lastRunAt);
	const threadSection = buildThreadSection(db, lastRunAt);

	return `You are running a scheduled heartbeat check.

## Standing Instructions
${instructions}

## Advisories
${advisorySection}

## Recent Tasks
${taskSection}

## Thread Activity
${threadSection}

Review the above and take action on anything that needs attention.
If nothing needs attention, respond briefly with what you observed.`;
}
```

**Section 1: Standing instructions** (AC2.1, AC2.2)

```typescript
function loadStandingInstructions(db: Database): string {
	const row = db
		.prepare("SELECT value FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get("_heartbeat_instructions") as { value: string } | null;
	return row?.value ?? DEFAULT_INSTRUCTIONS;
}
```

**Section 2: Advisories** (AC2.3, AC2.4)

```typescript
interface AdvisoryRow {
	title: string;
	status: string;
	resolved_at: string | null;
}

function buildAdvisorySection(db: Database, lastRunAt: string | null): string {
	// Pending advisories
	const pending = db
		.prepare(
			"SELECT title FROM advisories WHERE deleted = 0 AND status = 'proposed' ORDER BY proposed_at ASC",
		)
		.all() as Array<{ title: string }>;

	const pendingText =
		pending.length > 0
			? `Pending (${pending.length}): ${pending.map((a) => a.title).join(", ")}`
			: "Pending (0): None";

	// Status changes since last run
	let changesText = "";
	if (lastRunAt) {
		const changes = db
			.prepare(
				"SELECT title, status FROM advisories WHERE deleted = 0 AND resolved_at > ? ORDER BY resolved_at DESC",
			)
			.all(lastRunAt) as AdvisoryRow[];

		if (changes.length > 0) {
			changesText = changes.map((a) => `- ${a.title}: ${a.status}`).join("\n");
		} else {
			changesText = "No changes since last check.";
		}
	} else {
		changesText = "First heartbeat run - no previous check to compare against.";
	}

	return `${pendingText}\n\nSince last check:\n${changesText}`;
}
```

**Section 3: Recent task completions** (AC2.5)

```typescript
interface TaskRow {
	trigger_spec: string;
	status: string;
	error: string | null;
	last_run_at: string;
}

function buildTaskSection(db: Database, lastRunAt: string | null): string {
	const cutoff = lastRunAt ?? new Date(0).toISOString();
	const tasks = db
		.prepare(
			`SELECT trigger_spec, status, error, last_run_at
			 FROM tasks
			 WHERE status IN ('completed', 'failed')
			   AND last_run_at > ?
			   AND deleted = 0
			 ORDER BY last_run_at DESC
			 LIMIT 5`,
		)
		.all(cutoff) as TaskRow[];

	if (tasks.length === 0) return "No recent task completions.";

	return tasks
		.map((t) => {
			let name: string;
			try {
				const spec = JSON.parse(t.trigger_spec);
				name = spec.type ?? t.trigger_spec;
			} catch {
				name = t.trigger_spec;
			}
			const errorSnippet = t.error ? ` - Error: ${t.error.slice(0, 150)}` : "";
			return `- [${t.status}] ${name} (${t.last_run_at})${errorSnippet}`;
		})
		.join("\n");
}
```

**Section 4: Per-thread activity** (AC2.6)

```typescript
interface ThreadActivityRow {
	id: string;
	title: string | null;
	msg_count: number;
}

function buildThreadSection(db: Database, lastRunAt: string | null): string {
	if (!lastRunAt) return "First heartbeat run - no previous check to compare against.";

	const threads = db
		.prepare(
			`SELECT t.id, t.title,
			        (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.created_at > ?) as msg_count
			 FROM threads t
			 WHERE t.deleted = 0
			   AND t.last_message_at > ?
			 ORDER BY t.last_message_at DESC
			 LIMIT 10`,
		)
		.all(lastRunAt, lastRunAt) as ThreadActivityRow[];

	if (threads.length === 0) return "No thread activity since last check.";

	return threads
		.map((t) => `- ${t.title ?? "(untitled)"}: ${t.msg_count} new message(s)`)
		.join("\n");
}
```

**Key design decisions:**
- All queries are read-only — no outbox pattern needed
- `lastRunAt` is nullable for the first heartbeat run (no previous check)
- Thread activity query is user-agnostic (system-wide heartbeat sees all threads)
- Error snippets truncated to 150 chars to keep context compact
- Thread activity capped at 10 (per design spec)
- Task completions capped at 5 (per design spec)
- Advisory query uses `proposed_at ASC` ordering (oldest first, so agent addresses them in priority order)
- ISO8601 timestamps used for all comparisons (per CLAUDE.md: never use SQLite `datetime()` against JS timestamps)
- **Design deviation (task section):** The design says "5 most recent tasks with `status IN ('completed', 'failed')` ordered by `last_run_at DESC`" without a since-last-run filter. This implementation adds `AND last_run_at > ?` to only show tasks completed since the last heartbeat. This is intentionally more useful — showing all-time completions would include stale historical data. On first run (lastRunAt = null, cutoff = epoch), all completions appear as a natural bootstrap.
- **File conventions:** `heartbeat-context.ts` is a functional module (pure database queries, no side effects, no state). Follow existing module conventions in `packages/agent/src/` for file header comments and export patterns.

**Verification:**

```bash
tsc -p packages/agent --noEmit
```

Expected: No errors.

**Commit:** `feat(agent): add heartbeat context builder`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Tests for buildHeartbeatContext

**Verifies:** heartbeat-task.AC2.1, heartbeat-task.AC2.2, heartbeat-task.AC2.3, heartbeat-task.AC2.4, heartbeat-task.AC2.5, heartbeat-task.AC2.6, heartbeat-task.AC2.7

**Files:**
- Create: `packages/agent/src/__tests__/heartbeat-context.test.ts`

**Implementation:**

Tests use real SQLite databases with full schema applied (not mocks). Follow existing patterns from `packages/agent/src/__tests__/scheduler-features.test.ts` and `packages/core/src/__tests__/change-log.test.ts`.

Setup pattern:
```typescript
import { createDatabase, applySchema, insertRow } from "@bound/core";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

Create temp DB in `beforeEach`, apply schema, populate test fixtures via `insertRow()` (for synced tables) or direct SQL (for local-only data), clean up in `afterEach`.

**Testing:**

Test cases (each maps to an AC):

- **heartbeat-task.AC2.1** (standing instructions from memory): Insert a `semantic_memory` row with `key = '_heartbeat_instructions'` and `value = 'Check disk space and report.'`. Call `buildHeartbeatContext(db, null)`. Verify the output contains `'Check disk space and report.'` in the Standing Instructions section.

- **heartbeat-task.AC2.2** (default prompt fallback): Call `buildHeartbeatContext(db, null)` with NO `_heartbeat_instructions` row in semantic_memory. Verify the output contains the default instruction text (`'Review system state'`).

- **heartbeat-task.AC2.3** (pending advisories): Insert 2 advisory rows with `status = 'proposed'` and `deleted = 0`. Call `buildHeartbeatContext(db, null)`. Verify output contains `'Pending (2):'` and both advisory titles.

- **heartbeat-task.AC2.4** (advisory status changes): Insert an advisory with `status = 'approved'` and `resolved_at` set to a time after `lastRunAt`. Call `buildHeartbeatContext(db, lastRunAt)`. Verify output contains the advisory title and `'approved'` in the "Since last check" section.

- **heartbeat-task.AC2.5** (task completions): Insert 2 task rows — one with `status = 'completed'` and one with `status = 'failed'` + an `error` message. Both with `last_run_at` after the lastRunAt parameter. Call `buildHeartbeatContext(db, lastRunAt)`. Verify output contains both tasks, the failed one including its error snippet.

- **heartbeat-task.AC2.6** (thread activity): Insert a thread row and 3 message rows with `created_at` after `lastRunAt`. Call `buildHeartbeatContext(db, lastRunAt)`. Verify output contains the thread title and `'3 new message(s)'`.

- **heartbeat-task.AC2.7** (graceful empty state): Call `buildHeartbeatContext(db, someTimestamp)` with an empty database (no advisories, no tasks, no threads). Verify output contains `'Pending (0): None'`, `'No recent task completions.'`, and `'No thread activity since last check.'`.

Additional test cases:
- Soft-deleted advisory with `status = 'proposed'` and `deleted = 1` is NOT included in pending count.
- Error snippet truncation: insert a task with a 500-char error message. Verify only first 150 chars appear.
- Thread activity cap: insert 15 threads with recent messages. Verify only 10 appear in output.
- First run (null lastRunAt): verify appropriate "First heartbeat run" messages in sections that depend on lastRunAt.

**Verification:**

```bash
bun test packages/agent/src/__tests__/heartbeat-context.test.ts
```

Expected: All tests pass.

**Commit:** `test(agent): add heartbeat context builder tests`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->
