# Memory & Task Visibility in Context Assembly

## Summary

The context assembly pipeline currently gives the agent a stale view of long-term memory: a raw dump of all stored key-value pairs with no indication of what changed, and no awareness of which scheduled tasks ran since the thread or task last executed. This document specifies a new pipeline stage — Stage 5.5 (VOLATILE ENRICHMENT) — that replaces the raw dump with a focused delta: the most-recently-changed memory entries and the most-recently-run tasks since a computed baseline timestamp. The result is that the agent sees only what is new or updated relative to its last context, rather than re-reading the entire memory store on every turn.

The baseline timestamp is derived from the thread or task record depending on context mode: for ordinary conversation threads it anchors to the thread's last message; for autonomous scheduled tasks it anchors to the task's last run. Two new helper functions (`computeBaseline` and `buildVolatileEnrichment`) encapsulate the query and formatting logic, and a one-line fix to the `memorize` command ensures that newly written memory entries carry the correct source identifier so they can be resolved back to human-readable task or thread names in future delta renders.

## Definition of Done

The context assembly pipeline gains a new Stage 5.5 (VOLATILE ENRICHMENT) that injects a memory delta (up to 10 most-recently-changed semantic_memory entries since the thread's/task's last turn) and a task run digest (up to 5 most-recently-run tasks since baseline) into every assembled context, including noHistory=true autonomous tasks.

The current raw memory dump in volatile context is replaced by the new delta format (total count + changed entries).

Source resolution in the delta uses LEFT JOINs against tasks and threads to display human-readable labels (e.g. `task "pr_check"`, `thread "Daily Standup"`). Quarantined threads are excluded from title resolution.

The `memorize` command's source default is fixed from the literal `"agent"` to `ctx.taskId || ctx.threadId`, so new memory entries resolve correctly.

Two new indexes are added to `schema.ts` for `semantic_memory.modified_at` and `tasks.last_run_at`.

## Acceptance Criteria

### memory-visibility.AC1: Stage 5.5 enrichment injected into assembled context
- **memory-visibility.AC1.1 Success:** Memory delta lines appear in volatile context when entries changed since baseline
- **memory-visibility.AC1.2 Success:** Task run digest lines appear in volatile context when tasks ran since baseline
- **memory-visibility.AC1.3 Success:** noHistory=true context gets a standalone enrichment system message when delta is non-empty
- **memory-visibility.AC1.4 Edge:** noHistory=true context gets no enrichment message when delta and digest are both empty
- **memory-visibility.AC1.5 Edge:** When budget headroom falls below 2,000 tokens, enrichment is truncated to 3 memory entries + 3 task entries

### memory-visibility.AC2: Memory delta entries
- **memory-visibility.AC2.1 Success:** Entry with modified_at after baseline appears in delta
- **memory-visibility.AC2.2 Failure:** Entry with modified_at before baseline does not appear
- **memory-visibility.AC2.3 Success:** Tombstoned entry (deleted=1) appears as `[forgotten]` with relative time and source
- **memory-visibility.AC2.4 Edge:** 11 entries changed → 10 shown + "... and 1 more (query semantic_memory for full list)"
- **memory-visibility.AC2.5 Edge:** Value longer than 120 chars is truncated with "..." suffix
- **memory-visibility.AC2.6 Success:** Memory header line shows total entry count and number changed since baseline

### memory-visibility.AC3: Task run digest entries
- **memory-visibility.AC3.1 Success:** Task with last_run_at after baseline and consecutive_failures=0 shows as "ran"
- **memory-visibility.AC3.2 Success:** Task with consecutive_failures > 0 shows as "failed"
- **memory-visibility.AC3.3 Success:** Task's host_name is resolved from the hosts table via claimed_by
- **memory-visibility.AC3.4 Edge:** No matching hosts row → host label falls back to claimed_by[0:8]
- **memory-visibility.AC3.5 Edge:** 6 tasks ran since baseline → 5 shown + "... and 1 more (query tasks for full list)"
- **memory-visibility.AC3.6 Failure:** Task with last_run_at before baseline does not appear
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

### memory-visibility.AC6: Memorize source default
- **memory-visibility.AC6.1 Success:** memorize with ctx.taskId set stores source as the task ID
- **memory-visibility.AC6.2 Success:** memorize with only ctx.threadId set stores source as the thread ID
- **memory-visibility.AC6.3 Success:** memorize with neither ctx.taskId nor ctx.threadId stores source as "agent"
- **memory-visibility.AC6.4 Success:** memorize with an explicit --source argument stores the provided value

### memory-visibility.AC7: Schema indexes
- **memory-visibility.AC7.1 Success:** idx_memory_modified index exists on semantic_memory(modified_at DESC) after applySchema()
- **memory-visibility.AC7.2 Success:** idx_tasks_last_run index exists on tasks(last_run_at DESC) after applySchema()
- **memory-visibility.AC7.3 Edge:** Calling applySchema() twice does not throw (indexes are idempotent)

### memory-visibility.AC8: Cross-cutting behaviors
- **memory-visibility.AC8.1:** Delta reads do not update last_accessed_at on any semantic_memory row
- **memory-visibility.AC8.2:** Old raw memory dump format (bare "Semantic Memory:" header with key: value lines) is absent from all assembled contexts

## Glossary

- **Context assembly pipeline**: The 8-stage process (`assembleContext()` in `packages/agent/src/context-assembly.ts`) that constructs the ordered list of messages sent to the LLM on each agent turn. Stages run in strict sequence and produce a final message array within a token budget.
- **VOLATILE ENRICHMENT (Stage 5.5)**: The new pipeline stage introduced by this document, inserted between Stage 5 (ANNOTATION) and Stage 6 (ASSEMBLY). It injects a memory delta and task run digest into the assembled context.
- **Volatile context**: A synthetic system message assembled fresh on each turn (not persisted as a thread message) that carries ephemeral state: current time, active tasks, memory summary, and now the enrichment delta.
- **Memory delta**: The subset of `semantic_memory` entries whose `modified_at` timestamp is strictly after the baseline. Contrasted with the old raw dump, which returned all entries unconditionally.
- **Task run digest**: A summary of tasks whose `last_run_at` is after the baseline, including outcome (ran / failed) and which host ran them.
- **Baseline**: A computed ISO timestamp that serves as the lower bound for delta queries. Derived from the thread or task record via the R-MV4 fallback chain; never NULL.
- **R-MV4 fallback chain**: The ordered set of rules for computing the baseline: `thread.last_message_at` → `thread.created_at` for normal contexts; `task.last_run_at` → `task.created_at` for scheduled tasks; epoch for autonomous tasks with no task record.
- **`noHistory=true`**: A context assembly mode used for autonomous scheduled tasks where no prior conversation messages are loaded. Enrichment is injected as a standalone system message in this mode rather than appended to existing volatile lines.
- **`semantic_memory`**: The SQLite table that stores the agent's persistent key-value memory entries, written by the `memorize` command and queryable by the agent.
- **Tombstone / `deleted=1`**: The soft-delete pattern used across all synced tables. A tombstoned memory entry still appears in the delta but renders as `[forgotten]` rather than its value.
- **Source resolution**: The process of translating a raw `source` identifier (stored on a `semantic_memory` row) into a human-readable label by JOIN-ing against the `tasks` and `threads` tables.
- **`last_run_at`**: The timestamp column on the `tasks` table recording when the task most recently executed. Used as the baseline anchor for scheduled task contexts and as the filter for the task run digest.
- **`consecutive_failures`**: A counter column on `tasks` incremented on each failed run and reset to zero on success. Used by the digest to label a task as "ran" (0) or "failed" (> 0).
- **`claimed_by`**: A column on the `tasks` table storing the `site_id` of the host that last executed the task. Joined against the `hosts` table to resolve a human-readable `host_name` in the task digest.
- **LWW (Last Write Wins)**: The conflict-resolution strategy used by the sync protocol for most tables. The row with the latest `modified_at` timestamp wins during merge. Relevant here because clock skew between hosts can transiently hide recently synced memory entries from the delta.
- **`applySchema()`**: The function in `packages/core/src/schema.ts` that creates tables and indexes when the database is initialized. New `CREATE INDEX IF NOT EXISTS` statements are idempotent and safe to add here without a migration entry.
- **`bun:sqlite`**: The SQLite driver built into the Bun runtime. Uses `.all()` for multi-row queries, `.get()` for single-row lookups (returns `null` when no row is found), and named parameters (`:baseline`) for safe value binding.
- **Budget validation (Stage 7)**: The pipeline stage that checks whether the assembled context fits within the model's token window. This feature adds a re-invocation path that reduces enrichment caps to 3+3 entries when headroom falls below 2,000 tokens.
- **`trigger_spec`**: The human-readable name/schedule string stored on a `tasks` row. Used as the display label for tasks in the run digest and in source resolution.

---

## Architecture

Stage 5.5 (VOLATILE ENRICHMENT) is inserted into the context assembly pipeline (`packages/agent/src/context-assembly.ts`) between the existing Stage 5 (ANNOTATION) and Stage 6 (ASSEMBLY). It computes a baseline timestamp, queries the local database for memory entries and tasks that changed since that baseline, and injects the results into the volatile context block.

Two new helper functions are added to `packages/agent/src/summary-extraction.ts`:

- `computeBaseline(db, threadId, taskId?, noHistory?)` — implements the R-MV4 fallback chain, returning an ISO timestamp string used as the lower bound for both delta queries. Never returns NULL.
- `buildVolatileEnrichment(db, baseline, maxMemory?, maxTasks?)` — executes both queries (memory delta and task run digest), applies source resolution, value truncation, and overflow detection, and returns formatted line arrays ready to splice into the volatile context block.

For `noHistory=false` contexts the enrichment is appended to the existing `volatileLines` array, replacing the old raw memory dump. For `noHistory=true` contexts (autonomous scheduled tasks) a new standalone system message is pushed when the enrichment is non-empty. The Stage 7 budget check can re-invoke `buildVolatileEnrichment` with reduced caps (`maxMemory=3`, `maxTasks=3`) if headroom falls below 2,000 tokens.

The `memorize` command in `packages/agent/src/commands/memorize.ts` is updated to default `source` to `ctx.taskId || ctx.threadId` instead of the literal string `"agent"`, enabling source resolution to work for new memory entries.

## Existing Patterns

The `buildVolatileEnrichment` helper follows the same extraction pattern as `buildCrossThreadDigest` in `summary-extraction.ts`: a standalone exported function that takes `db` and parameters, executes bounded queries, and returns formatted text. The caller (`assembleContext`) splices the result into `volatileLines`.

Indexes in `schema.ts` are added as `CREATE INDEX IF NOT EXISTS` calls in `applySchema()`, matching every other index in that file (idempotent, no migration table needed).

Volatile context is assembled as `string[]` joined by `"\n"` and pushed as a single `{ role: "system" }` message — matching the existing `volatileLines` pattern exactly.

Bun SQLite queries use `.all()` for multi-row results and `.get()` for single-row lookups, with named parameters (`:baseline`) for the delta queries, consistent with existing query patterns throughout the codebase.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Schema indexes

**Goal:** Add the two indexes required for efficient delta queries.

**Components:**
- `packages/core/src/schema.ts` — two new `db.run()` calls at the end of `applySchema()`:
  - `CREATE INDEX IF NOT EXISTS idx_memory_modified ON semantic_memory(modified_at DESC)` — not partial-filtered on `deleted = 0` (tombstones must be included in the delta per R-MV3)
  - `CREATE INDEX IF NOT EXISTS idx_tasks_last_run ON tasks(last_run_at DESC) WHERE deleted = 0 AND last_run_at IS NOT NULL`

**Dependencies:** None.

**Done when:** `bun test packages/core` passes; schema test confirms both indexes exist after `applySchema()`.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Enrichment helpers

**Goal:** Implement `computeBaseline` and `buildVolatileEnrichment` in `summary-extraction.ts`, fully tested in isolation.

**Components:**
- `packages/agent/src/summary-extraction.ts` — two new exported functions:
  - `computeBaseline(db, threadId, taskId?, noHistory?)` — R-MV4 fallback chain. For `noHistory=false`: returns `thread.last_message_at ?? thread.created_at`. For `noHistory=true` with `taskId`: returns `task.last_run_at ?? task.created_at`. For `noHistory=true` without `taskId`: returns epoch `"1970-01-01T00:00:00.000Z"`.
  - `buildVolatileEnrichment(db, baseline, maxMemory=10, maxTasks=5)` — executes memory delta query (LIMIT `maxMemory+1`) and task digest query (LIMIT `maxTasks+1`). Applies source resolution (task name → `task "..."`, thread title → `thread "..."`, untitled thread → `thread "{id[0:8]}"`, quarantined/deleted thread falls back to truncated ID, null source → `"unknown"`). Truncates values at 120 chars. Tombstoned entries render as `[forgotten]`. Returns `{ memoryDeltaLines: string[], taskDigestLines: string[] }`.

**Memory delta SQL:**
```sql
SELECT m.key, m.value, m.modified_at, m.deleted,
       t_src.trigger_spec AS task_name,
       th_src.title       AS thread_title
FROM   semantic_memory m
LEFT JOIN tasks   t_src  ON m.source = t_src.id
LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0
WHERE  m.modified_at > :baseline
ORDER  BY m.modified_at DESC
LIMIT  :limit
```

**Task digest SQL:**
```sql
SELECT t.trigger_spec, t.last_run_at, t.consecutive_failures,
       SUBSTR(t.result, 1, 100) AS result_summary,
       h.host_name
FROM   tasks t
LEFT JOIN hosts h ON t.claimed_by = h.site_id
WHERE  t.last_run_at > :baseline
  AND  t.last_run_at IS NOT NULL
  AND  t.deleted = 0
ORDER  BY t.last_run_at DESC
LIMIT  :limit
```

- `packages/agent/src/__tests__/volatile-enrichment.test.ts` — unit tests covering: baseline fallback chain (all four cases), delta entry inclusion/exclusion by timestamp, tombstoned entry rendering, overflow detection (N+1 entries → N shown + "... and M more"), all source resolution branches, value truncation at 120 chars, task outcome labels (`ran` / `failed`), host name fallback.

**Dependencies:** Phase 1 (indexes exist for query performance, though tests pass without them).

**Done when:** All `volatile-enrichment.test.ts` tests pass; covers memory-visibility.AC2 and memory-visibility.AC3 cases.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Context assembly integration

**Goal:** Wire Stage 5.5 into `assembleContext()`, replacing the old raw memory dump.

**Components:**
- `packages/agent/src/context-assembly.ts` — Stage 5.5 block inserted between Stage 5 (ANNOTATION) and Stage 6 (ASSEMBLY):
  1. Call `computeBaseline(db, threadId, params.taskId, noHistory)` → `baseline`
  2. Call `buildVolatileEnrichment(db, baseline)` → `{ memoryDeltaLines, taskDigestLines }`
  3. Query total memory count: `SELECT COUNT(*) FROM semantic_memory WHERE deleted = 0`
  4. Format memory header line: `Memory: N entries` (append `(M changed since your last turn in this thread)` when `memoryDeltaLines.length > 0`)
  - For `noHistory=false`: remove the existing raw memory dump query (lines ~577–589), add memory header + `memoryDeltaLines` + `taskDigestLines` to `volatileLines`
  - For `noHistory=true`: if enrichment non-empty, push `{ role: "system", content: ... }` with header + delta + digest lines
  - Stage 7 budget check: if `totalTokens > contextWindow` and estimated remaining headroom < 2,000 tokens, re-call `buildVolatileEnrichment(db, baseline, 3, 3)` and substitute the truncated result

**Dependencies:** Phase 2 (helper functions available).

**Done when:** Context assembly tests pass including new cases for delta presence, noHistory=true enrichment injection, and absence of old raw dump format; covers memory-visibility.AC1, memory-visibility.AC4, memory-visibility.AC5.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Memorize source fix

**Goal:** Fix `memorize.ts` so new entries resolve correctly in source resolution.

**Components:**
- `packages/agent/src/commands/memorize.ts` — change `const source = args.source || "agent"` to `const source = args.source || ctx.taskId || ctx.threadId || "agent"`

**Dependencies:** None (independent one-line change; can be done in any order).

**Done when:** Memorize command tests confirm source is stored as task ID when `ctx.taskId` is set, thread ID when only `ctx.threadId` is set, and `"agent"` when neither is set; covers memory-visibility.AC6.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Tests and coverage

**Goal:** Ensure all acceptance criteria are covered by automated tests; fill any gaps from earlier phases.

**Components:**
- `packages/agent/src/__tests__/volatile-enrichment.test.ts` — created in Phase 2; verify completeness
- `packages/agent/src/__tests__/context-assembly.test.ts` — additions:
  - Delta section present in assembled context when entries changed since baseline
  - Raw memory dump format (`Semantic Memory:` / `key: value`) absent from output
  - `noHistory=true` context gets enrichment system message when delta non-empty
  - `noHistory=true` context gets no enrichment message when delta is empty
  - Context pressure path: budget-constrained context produces 3+3 truncation
- `packages/agent/src/__tests__/commands.test.ts` (or equivalent) — memorize source storage assertions

**Dependencies:** Phases 1–4.

**Done when:** `bun test packages/agent --recursive` passes; `bun test packages/core` passes; all memory-visibility ACs have at least one corresponding test.
<!-- END_PHASE_5 -->

## Additional Considerations

**`last_accessed_at` is not updated by delta reads.** Both delta queries are SELECT-only and do not touch `last_accessed_at`. Only explicit `memorize` writes and agent `query` calls update that field (R-MV5). No special guard is needed — the queries are read-only by design.

**Existing memory rows with `source = "agent"`.** The Phase 4 fix applies to new writes only. Historical entries that already have `source = "agent"` will fall through all JOIN branches and render as `unknown` in the source label. No migration is required; the display degrades gracefully.

**`--quiet` flag.** The `schedule` command accepts `--quiet` but does not currently store it (the column does not exist in the tasks schema). This RFC does not add the column — the task run digest naturally includes all tasks via `last_run_at` regardless of quiet intent, satisfying R-MV8 for the current implementation.

**Clock skew.** Delta queries use `modified_at > :baseline` where both timestamps are from the local host's clock. Cross-host skew can transiently hide synced entries (up to ±5 minutes per §13.4). This is a known limitation shared with all LWW operations and is not addressed here.
