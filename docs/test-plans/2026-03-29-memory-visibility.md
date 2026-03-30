# Test Plan: Memory Visibility

**Feature:** Memory Visibility (Stage 5.5 Volatile Enrichment)
**Implementation plan:** `docs/implementation-plans/2026-03-29-memory-visibility/`
**Date:** 2026-03-29

---

## Automated Coverage

All 36 acceptance criteria have passing automated tests. Run with:

```bash
bun test packages/core/src/__tests__/schema.test.ts \
         packages/agent/src/__tests__/volatile-enrichment.test.ts \
         packages/agent/src/__tests__/context-assembly.test.ts \
         packages/agent/src/__tests__/commands.test.ts
```

Expected: 98 pass, 0 fail.

---

## Prerequisites

- Working directory: `.worktrees/memory-visibility` (or merged branch)
- Bun runtime installed
- All automated tests passing

---

## Phase 1: Schema Indexes

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create a database, apply schema, run `SELECT name FROM sqlite_master WHERE type='index'`. | Output contains `idx_memory_modified` and `idx_tasks_last_run`. |
| 2 | Call `applySchema(db)` a second time on the same database. | No error thrown. Table count remains 17. |

---

## Phase 2: Volatile Enrichment Unit Behavior

| Step | Action | Expected |
|------|--------|----------|
| 1 | Insert a semantic_memory row with `modified_at` after the baseline, call `buildVolatileEnrichment(db, baseline)`. | `memoryDeltaLines` contains exactly 1 line starting with `- {key}:` and including the value. |
| 2 | Insert 11 memory entries, call `buildVolatileEnrichment(db, baseline, 10)`. | Returns 11 lines. The 11th says `"... and 1 more (query semantic_memory for full list)"`. |
| 3 | Insert a memory entry with a 130-character value. | Rendered line ends with `"..."` and the full value is absent. |
| 4 | Soft-delete a memory entry. Call `buildVolatileEnrichment` with a baseline before the deletion. | Line contains `[forgotten]` instead of the original value. |
| 5 | Insert a task with `consecutive_failures: 0` and `last_run_at` after baseline. | `taskDigestLines[0]` contains `" ran "`. |
| 6 | Insert a task with `consecutive_failures: 2`. | Line contains `" failed "`. |
| 7 | Insert a host row with `host_name: "my-host"` and a task with `claimed_by` matching the host's `site_id`. | Task digest line contains `"my-host"`. |
| 8 | Insert a task with `claimed_by: "abcdef1234567890"` and no matching hosts row. | Line contains `"abcdef12"` (first 8 chars). |

---

## Phase 3: Context Assembly Integration

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create a thread with `last_message_at` set to a past date. Insert a semantic_memory entry with `modified_at` after that date. Call `assembleContext({ db, threadId, userId })`. | A `role: "system"` message contains `"Memory:"`, the memory key, and `"changed since your last turn"`. |
| 2 | Insert a task with `last_run_at` after the thread's `last_message_at` and `consecutive_failures: 0`. Call `assembleContext`. | System message contains the task's `trigger_spec` and `" ran "`. |
| 3 | Call `assembleContext({ noHistory: true, taskId })` where the task has a recent `last_run_at` and memory entries exist after it. | A standalone `role: "system"` message contains `"Memory:"` and the memory key. |
| 4 | Call `assembleContext({ noHistory: true, taskId })` where nothing changed after the baseline. | No system message contains `"Memory:"`. |
| 5 | Insert 10 memory entries. Call `assembleContext` with `contextWindow: 500`. | At most 3 memory entry lines (lines starting with `"- "`) appear in the enrichment section. |
| 6 | Insert a memory entry. Call `assembleContext`. Inspect all messages. | No message contains the legacy format `"Semantic Memory:"`. |
| 7 | Insert a memory entry, record its `last_accessed_at`. Call `assembleContext`. Re-query the row. | `last_accessed_at` is unchanged (SELECT-only queries). |

---

## Phase 4: Memorize Source Defaults

| Step | Action | Expected |
|------|--------|----------|
| 1 | Call `memorize.handler({ key: "k1", value: "v" }, ctx)` where `ctx.taskId` is set. Query `semantic_memory.source`. | Source equals `ctx.taskId`. |
| 2 | Call `memorize.handler` with `ctx.taskId = undefined` but `ctx.threadId` set. | Source equals `ctx.threadId`. |
| 3 | Call `memorize.handler` with both `taskId` and `threadId` undefined. | Source equals `"agent"`. |
| 4 | Call `memorize.handler` with explicit `args.source: "custom-source-id"`. | Source equals `"custom-source-id"`, ignoring ctx values. |

---

## End-to-End: Full Enrichment Pipeline

**Purpose:** Validates the complete chain — baseline computation, delta query, source resolution, context assembly formatting, and budget truncation.

1. Create a fresh SQLite database, apply schema.
2. Create a user, a thread (with `last_message_at` set to 24 hours ago), and a task (`trigger_spec: "health_check"`, `last_run_at` 1 hour ago, `consecutive_failures: 0`).
3. Insert 5 semantic_memory entries: 2 with `modified_at` after the thread's `last_message_at` (one sourced from the task ID, one from the thread ID), 3 with `modified_at` before.
4. Soft-delete one of the 2 recent memory entries.
5. Call `assembleContext({ db, threadId, userId })`.
6. Verify: the volatile system message contains a `"Memory:"` header with the total count and delta count.
7. Verify: the 2 recent entries appear as delta lines (1 active, 1 `[forgotten]`). The 3 old entries do not appear.
8. Verify: the task-sourced entry says `via task "health_check"`. The thread-sourced entry says `via thread "..."` with the thread title or ID prefix.
9. Verify: the task digest line says `"health_check ran"`.
10. Verify: no message contains `"Semantic Memory:"`.
11. Call `assembleContext` with `contextWindow: 500`. Verify at most 3 memory delta lines and that skill/cross-thread content is still present in the volatile message.

---

## End-to-End: Task-Context Enrichment (noHistory Path)

**Purpose:** Validates the autonomous task execution path where `noHistory=true` and baseline is derived from `task.last_run_at`.

1. Create a task with `last_run_at` set to 2 hours ago.
2. Insert 2 memory entries with `modified_at` after the task's `last_run_at`.
3. Call `assembleContext({ db, threadId, userId, noHistory: true, taskId })`.
4. Verify: a standalone `role: "system"` message contains `"Memory:"` and both memory keys.
5. Update the task's `last_run_at` to the current time and re-call.
6. Verify: no `"Memory:"` message appears (nothing changed after the new baseline).

---

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 | `context-assembly.test.ts` "AC1.1 + AC2.6" | Phase 3 Step 1 |
| AC1.2 | `context-assembly.test.ts` "AC1.2" | Phase 3 Step 2 |
| AC1.3 | `context-assembly.test.ts` "AC1.3" | Phase 3 Step 3 |
| AC1.4 | `context-assembly.test.ts` "AC1.4" | Phase 3 Step 4 |
| AC1.5 | `context-assembly.test.ts` "AC1.5" | Phase 3 Step 5 |
| AC2.1 | `volatile-enrichment.test.ts` "AC2.1" | Phase 2 Step 1 |
| AC2.2 | `volatile-enrichment.test.ts` "AC2.2" | Phase 2 Step 1 (inverse) |
| AC2.3 | `volatile-enrichment.test.ts` "AC2.3" | Phase 2 Step 4 |
| AC2.4 | `volatile-enrichment.test.ts` "AC2.4" | Phase 2 Step 2 |
| AC2.5 | `volatile-enrichment.test.ts` "AC2.5" | Phase 2 Step 3 |
| AC2.6 | `context-assembly.test.ts` "AC1.1 + AC2.6" | Phase 3 Step 1 |
| AC3.1 | `volatile-enrichment.test.ts` "AC3.1" | Phase 2 Step 5 |
| AC3.2 | `volatile-enrichment.test.ts` "AC3.2" | Phase 2 Step 6 |
| AC3.3 | `volatile-enrichment.test.ts` "AC3.3" | Phase 2 Step 7 |
| AC3.4 | `volatile-enrichment.test.ts` "AC3.4" | Phase 2 Step 8 |
| AC3.5 | `volatile-enrichment.test.ts` "AC3.5" | Phase 2 Step 2 (task variant) |
| AC3.6 | `volatile-enrichment.test.ts` "AC3.6" | — (automated) |
| AC3.7 | `volatile-enrichment.test.ts` "AC3.7" | — (automated) |
| AC4.1 | `volatile-enrichment.test.ts` "AC4.1" | — (automated) |
| AC4.2 | `volatile-enrichment.test.ts` "AC4.2" | — (automated) |
| AC4.3 | `volatile-enrichment.test.ts` "AC4.3" | — (automated) |
| AC4.4 | `volatile-enrichment.test.ts` "AC4.4" | — (automated) |
| AC4.5 | `volatile-enrichment.test.ts` "AC4.5" | — (automated) |
| AC5.1 | `volatile-enrichment.test.ts` "AC5.1" | E2E Step 8 |
| AC5.2 | `volatile-enrichment.test.ts` "AC5.2" | E2E Step 8 |
| AC5.3 | `volatile-enrichment.test.ts` "AC5.3" | — (automated) |
| AC5.4 | `volatile-enrichment.test.ts` "AC5.4" | — (automated) |
| AC5.5 | `volatile-enrichment.test.ts` "AC5.5" | — (automated) |
| AC5.6 | `volatile-enrichment.test.ts` "AC5.6" | — (automated) |
| AC6.1 | `commands.test.ts` "AC6.1" | Phase 4 Step 1 |
| AC6.2 | `commands.test.ts` "AC6.2" | Phase 4 Step 2 |
| AC6.3 | `commands.test.ts` "AC6.3" | Phase 4 Step 3 |
| AC6.4 | `commands.test.ts` "AC6.4" | Phase 4 Step 4 |
| AC7.1 | `schema.test.ts` "creates all indexes" | Phase 1 Step 1 |
| AC7.2 | `schema.test.ts` "creates all indexes" | Phase 1 Step 1 |
| AC7.3 | `schema.test.ts` "allows idempotent schema application" | Phase 1 Step 2 |
| AC8.1 | `context-assembly.test.ts` "AC8.1" | Phase 3 Step 7 |
| AC8.2 | `context-assembly.test.ts` "AC8.2" | Phase 3 Step 6 |
