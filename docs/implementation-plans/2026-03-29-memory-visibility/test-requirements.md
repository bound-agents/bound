# Memory Visibility — Test Requirements

Maps every acceptance criterion to an automated test or documented human verification.

All criteria are automatable; no human verification entries are required.

---

## AC1: Stage 5.5 enrichment injected into assembled context

| Criterion | Type | Test File | Description |
|-----------|------|-----------|-------------|
| AC1.1 | Integration | `packages/agent/src/__tests__/context-assembly.test.ts` | Insert a semantic_memory entry with `modified_at` after the thread's `last_message_at`. Call `assembleContext`. Assert the system message containing `"Memory:"` includes the memory key and `"changed since your last turn"`. |
| AC1.2 | Integration | `packages/agent/src/__tests__/context-assembly.test.ts` | Insert a task with `last_run_at` after baseline and `consecutive_failures: 0`. Call `assembleContext`. Assert the volatile context message contains the task's `trigger_spec` and `" ran "`. |
| AC1.3 | Integration | `packages/agent/src/__tests__/context-assembly.test.ts` | Insert a memory entry with `modified_at` after a task's `last_run_at`. Call `assembleContext({ noHistory: true, taskId })`. Assert a standalone `role: "system"` message contains `"Memory:"` and the memory key. |
| AC1.4 | Integration | `packages/agent/src/__tests__/context-assembly.test.ts` | Set thread and task timestamps to a very recent value so no memory or task entries changed after baseline. Call `assembleContext({ noHistory: true, taskId })`. Assert no system message contains `"Memory:"`. |
| AC1.5 | Integration | `packages/agent/src/__tests__/context-assembly.test.ts` | Insert 10 memory entries after baseline. Call `assembleContext` with a very small `contextWindow` (e.g., 500) to trigger budget pressure. Assert at most 3 memory entry lines (lines starting with `"- "`) appear in the enrichment section, confirming the 3+3 fallback. |

## AC2: Memory delta entries

| Criterion | Type | Test File | Description |
|-----------|------|-----------|-------------|
| AC2.1 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a semantic_memory entry with `modified_at` after the baseline. Call `buildVolatileEnrichment`. Assert `memoryDeltaLines` contains a line starting with `- {key}:`. |
| AC2.2 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a semantic_memory entry with `modified_at` before the baseline. Call `buildVolatileEnrichment`. Assert `memoryDeltaLines` is empty. |
| AC2.3 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a semantic_memory entry then soft-delete it (via `softDelete`). Call `buildVolatileEnrichment` with baseline before the deletion. Assert the line contains `[forgotten]` and does not contain the original value. |
| AC2.4 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert 11 entries with `modified_at` after baseline. Call `buildVolatileEnrichment(db, baseline, 10)`. Assert `memoryDeltaLines` has 11 items: 10 entries plus `"... and 1 more (query semantic_memory for full list)"`. |
| AC2.5 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert an entry with a 130-character value. Call `buildVolatileEnrichment`. Assert the rendered line ends with `"..."` and the full 130-char string is absent. |
| AC2.6 | Integration | `packages/agent/src/__tests__/context-assembly.test.ts` | Insert a memory entry after baseline. Call `assembleContext`. Assert the system message contains a header line matching `Memory: N entries (M changed since your last turn in this thread)`. Covered jointly with AC1.1. |

## AC3: Task run digest entries

| Criterion | Type | Test File | Description |
|-----------|------|-----------|-------------|
| AC3.1 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a task with `last_run_at` after baseline and `consecutive_failures: 0`. Assert `taskDigestLines[0]` contains `" ran "`. |
| AC3.2 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a task with `consecutive_failures: 2`. Assert `taskDigestLines[0]` contains `" failed "`. |
| AC3.3 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a hosts row with `host_name: "my-host"`. Insert a task with `claimed_by` matching that host's `site_id`. Assert `taskDigestLines[0]` contains `"my-host"`. |
| AC3.4 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a task with `claimed_by: "abcdef1234567890"` and no matching hosts row. Assert `taskDigestLines[0]` contains `"abcdef12"` (first 8 chars). |
| AC3.5 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert 6 tasks with `last_run_at` after baseline. Call `buildVolatileEnrichment(db, baseline, 10, 5)`. Assert `taskDigestLines` has 6 items: 5 entries plus `"... and 1 more (query tasks for full list)"`. |
| AC3.6 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a task with `last_run_at` before baseline. Assert `taskDigestLines` is empty. |
| AC3.7 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a task with `last_run_at` after baseline, then `softDelete` it. Assert `taskDigestLines` is empty. |

## AC4: Baseline computation (R-MV4 fallback chain)

| Criterion | Type | Test File | Description |
|-----------|------|-----------|-------------|
| AC4.1 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a thread with a known `last_message_at`. Call `computeBaseline(db, threadId)`. Assert return equals `last_message_at`. |
| AC4.2 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a thread via raw SQL with `last_message_at = NULL` (bypasses NOT NULL schema constraint for defensive-path testing). Call `computeBaseline(db, threadId)`. Assert return equals `created_at`. |
| AC4.3 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a task with a known `last_run_at`. Call `computeBaseline(db, "", taskId, true)`. Assert return equals `last_run_at`. |
| AC4.4 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a task with `last_run_at: null`. Call `computeBaseline(db, "", taskId, true)`. Assert return equals `created_at`. |
| AC4.5 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Call `computeBaseline(db, "", undefined, true)` with no taskId. Assert return equals `"1970-01-01T00:00:00.000Z"`. |

## AC5: Source resolution

| Criterion | Type | Test File | Description |
|-----------|------|-----------|-------------|
| AC5.1 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a task with `trigger_spec: "my_cron"`. Insert a memory entry with `source` set to that task's ID. Assert the delta line contains `via task "my_cron"`. |
| AC5.2 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a non-deleted thread with `title: "My Thread"`. Insert a memory entry with `source` set to that thread's ID. Assert the delta line contains `via thread "My Thread"`. |
| AC5.3 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a thread with `title: null`. Insert a memory entry with `source` set to that thread's ID. Assert the delta line contains `via thread "{id[0:8]}"`. |
| AC5.4 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a thread with a title, insert a memory entry referencing it, then `softDelete` the thread. Assert the delta line contains the first 8 chars of the thread ID and does NOT contain `thread "` (the LEFT JOIN's `th_src.deleted = 0` clause excludes deleted threads from title resolution). |
| AC5.5 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a memory entry with `source: "zzzzzzzz1234"` (no matching task or thread). Assert the delta line contains `via zzzzzzzz`. |
| AC5.6 | Unit | `packages/agent/src/__tests__/volatile-enrichment.test.ts` | Insert a memory entry with `source: null`. Assert the delta line contains `via unknown`. |

## AC6: Memorize source default

| Criterion | Type | Test File | Description |
|-----------|------|-----------|-------------|
| AC6.1 | Unit | `packages/agent/src/__tests__/commands.test.ts` | Call `memorize.handler` with a `ctx` that has `taskId` set. Query `semantic_memory.source` from DB. Assert it equals `ctx.taskId`. |
| AC6.2 | Unit | `packages/agent/src/__tests__/commands.test.ts` | Call `memorize.handler` with a `ctx` that has `threadId` but `taskId: undefined`. Assert stored `source` equals `ctx.threadId`. |
| AC6.3 | Unit | `packages/agent/src/__tests__/commands.test.ts` | Call `memorize.handler` with `taskId: undefined, threadId: undefined`. Assert stored `source` equals `"agent"`. |
| AC6.4 | Unit | `packages/agent/src/__tests__/commands.test.ts` | Call `memorize.handler` with explicit `args.source: "custom-source-id"`. Assert stored `source` equals `"custom-source-id"`, ignoring `ctx.taskId`/`ctx.threadId`. |

## AC7: Schema indexes

| Criterion | Type | Test File | Description |
|-----------|------|-----------|-------------|
| AC7.1 | Unit | `packages/core/src/__tests__/schema.test.ts` | Call `applySchema(db)`. Query `sqlite_master` for indexes. Assert `indexNames` contains `"idx_memory_modified"`. |
| AC7.2 | Unit | `packages/core/src/__tests__/schema.test.ts` | Same query as AC7.1. Assert `indexNames` contains `"idx_tasks_last_run"`. |
| AC7.3 | Unit | `packages/core/src/__tests__/schema.test.ts` | Existing idempotence test already calls `applySchema(db)` twice and asserts no throw. Both indexes use `CREATE INDEX IF NOT EXISTS`, so this is covered with no additional changes. |

## AC8: Cross-cutting behaviors

| Criterion | Type | Test File | Description |
|-----------|------|-----------|-------------|
| AC8.1 | Integration | `packages/agent/src/__tests__/context-assembly.test.ts` | Insert a memory entry, note its `last_accessed_at`. Call `assembleContext`. Re-query the row. Assert `last_accessed_at` has not changed. This is structurally guaranteed (both delta queries are SELECT-only) but the test provides a regression guard. |
| AC8.2 | Integration | `packages/agent/src/__tests__/context-assembly.test.ts` | Insert a memory entry. Call `assembleContext`. Assert no message in the result contains the legacy `"Semantic Memory:"` header. |

---

## Summary

- **Total acceptance criteria:** 36
- **Automated tests:** 36 (all criteria are automatable)
- **Human verification required:** 0
- **Test files touched:** 4
  - `packages/core/src/__tests__/schema.test.ts` (Phase 1 — 2 new assertions + existing idempotence test)
  - `packages/agent/src/__tests__/volatile-enrichment.test.ts` (Phase 2 — new file, ~20 test cases)
  - `packages/agent/src/__tests__/context-assembly.test.ts` (Phase 3 — new describe block, ~7 test cases)
  - `packages/agent/src/__tests__/commands.test.ts` (Phase 4 — 4 new test cases)
