# Heartbeat Task Type Design

## Summary

This design introduces a **heartbeat task type** — a new kind of scheduled task that runs at fixed intervals (default 30 minutes) to give the agent a periodic opportunity to check system state and take autonomous action. Unlike cron tasks which execute static payloads, the heartbeat dynamically assembles its context at runtime by querying the database for pending advisories, recent task completions, and per-thread activity since the last check. This context is combined with agent-editable standing instructions (stored in semantic memory under the `_heartbeat_instructions` key) and presented to the agent loop as a user message in a persistent thread, giving the agent continuity across checks.

The implementation leverages existing scheduler infrastructure — the same CAS-based claiming, overlap prevention, and error-recovery patterns used for cron tasks. The key difference is **clock-aligned scheduling math**: instead of cron expressions, heartbeat uses modulo arithmetic to fire at clean boundaries (:00, :30 for a 30min interval), stretched by quiescence multipliers when the system is idle (5x at 4+ hours idle). The heartbeat self-reschedules after each run, soft/hard errors, and eviction, ensuring at-least-once execution per interval even in multi-host clusters. No new tables or schema migrations are required — the heartbeat task lives in the existing tasks table with `type = 'heartbeat'` and a JSON `trigger_spec` containing `interval_ms`.

## Definition of Done

1. **New `heartbeat` trigger type** in the task system — joins cron/deferred/event with its own trigger_spec format, clock-relative scheduling, and self-rescheduling after each run
2. **Heartbeat context builder** — auto-loads standing instructions from `_heartbeat_instructions` memory key, injects pending advisories, recent task completions, and per-thread activity summaries as system context
3. **Overlap prevention** — running heartbeat blocks next claim via existing CAS; quiescence stretches effective interval but never skips
4. **Operator configuration** — interval (default 30min) configurable; heartbeat auto-seeded on startup when enabled
5. **No new tables or schema migrations** — uses existing tasks table with new type value

## Acceptance Criteria

### heartbeat-task.AC1: Heartbeat scheduling
- **heartbeat-task.AC1.1 Success:** Heartbeat fires at clock-aligned boundaries (30min interval → :00, :30)
- **heartbeat-task.AC1.2 Success:** Heartbeat self-reschedules to next boundary after completion
- **heartbeat-task.AC1.3 Success:** Heartbeat self-reschedules after soft/hard errors and eviction
- **heartbeat-task.AC1.4 Success:** Arbitrary intervals work (15min, 45min, 2h)
- **heartbeat-task.AC1.5 Failure:** Invalid interval_ms (0, negative) rejected at config validation

### heartbeat-task.AC2: Context builder
- **heartbeat-task.AC2.1 Success:** Standing instructions loaded from `_heartbeat_instructions` memory key
- **heartbeat-task.AC2.2 Success:** Default prompt used when `_heartbeat_instructions` key is missing
- **heartbeat-task.AC2.3 Success:** Pending advisory titles listed in context
- **heartbeat-task.AC2.4 Success:** Advisory status changes since last run shown (approved/dismissed/applied)
- **heartbeat-task.AC2.5 Success:** Recent task completions with status and error snippets included
- **heartbeat-task.AC2.6 Success:** Per-thread activity counts since last run included
- **heartbeat-task.AC2.7 Edge:** Context builder handles zero advisories/tasks/threads gracefully

### heartbeat-task.AC3: Overlap prevention
- **heartbeat-task.AC3.1 Success:** Running heartbeat blocks next claim via CAS
- **heartbeat-task.AC3.2 Success:** Stuck heartbeat evicted after 5min, rescheduled to next boundary
- **heartbeat-task.AC3.3 Success:** Multi-host cluster claims heartbeat at-least-once per interval

### heartbeat-task.AC4: Configuration and seeding
- **heartbeat-task.AC4.1 Success:** Heartbeat seeded on startup when config is absent (default enabled)
- **heartbeat-task.AC4.2 Success:** Heartbeat seeded with custom interval_ms from config
- **heartbeat-task.AC4.3 Success:** Seeding is idempotent (no duplicate heartbeat tasks created)
- **heartbeat-task.AC4.4 Success:** `heartbeat.enabled: false` prevents seeding

### heartbeat-task.AC5: Quiescence integration
- **heartbeat-task.AC5.1 Success:** Quiescence multiplier stretches heartbeat interval (5x at 4h idle)
- **heartbeat-task.AC5.2 Success:** Quiescence note injected for heartbeat tasks when multiplier > 1
- **heartbeat-task.AC5.3 Success:** Quiescence note injected for cron tasks when multiplier > 1
- **heartbeat-task.AC5.4 Success:** No quiescence note when system is active (multiplier = 1)

## Glossary

- **Agent loop**: The state machine in `packages/agent/src/agent-loop.ts` that orchestrates LLM calls, tool execution, and filesystem persistence for a single conversational turn.
- **CAS (Compare-And-Swap)**: An atomic database pattern where an UPDATE includes the expected current state in the WHERE clause and checks `changes()` to verify the update succeeded, preventing race conditions in multi-host claiming.
- **Clock-aligned scheduling**: Computing next run times as multiples of the interval (e.g., a 30min interval fires at :00 and :30), achieved with `Math.ceil(now / interval) * interval`.
- **Eviction**: The scheduler's phase 0 step that marks tasks stuck in `running` status as failed after a timeout (5 minutes) and reschedules them.
- **Quiescence**: An adaptive backoff mechanism that stretches scheduled task intervals based on how long the system has been idle, reducing LLM costs during low-activity periods.
- **Semantic memory**: The `semantic_memory` table that stores agent-generated key-value facts, synced across hosts, used here to persist standing instructions.
- **Trigger spec**: The JSON payload in a task's `trigger_spec` column that defines how and when the task should execute.

## Architecture

### Trigger Type

Add `"heartbeat"` to the `TaskType` union in `packages/shared/src/types.ts`. A heartbeat task's `trigger_spec` is JSON:

```typescript
{ type: "heartbeat", interval_ms: number }
```

The scheduler dispatches heartbeat tasks through the same `runTask()` pipeline as cron and deferred tasks. The difference is in scheduling (clock-aligned interval math instead of cron expressions) and payload generation (runtime context builder instead of static payload).

### Clock-Aligned Scheduling

New `rescheduleHeartbeat()` function in `packages/agent/src/scheduler.ts` (sibling to `rescheduleCronTask`). Given `interval_ms` and the current quiescence state:

1. Compute effective interval: `interval_ms * quiescence_multiplier`
2. Compute next boundary: `Math.ceil(Date.now() / effective_interval) * effective_interval`
3. Set `next_run_at` and reset `status = 'pending'`

This aligns to clean clock boundaries — a 30min interval fires at :00 and :30. Quiescence stretches the interval before alignment, so a 5x multiplier (4-12h idle) turns 30min into 2.5h boundaries.

`rescheduleHeartbeat()` accepts `lastUserInteractionAt` as a parameter (the scheduler already tracks this) to compute the quiescence tier. Called in the same places as `rescheduleCronTask`: after completion, after soft/hard errors, and after heartbeat timeout eviction.

### Context Builder

New `packages/agent/src/heartbeat-context.ts` module exporting `buildHeartbeatContext(db, lastRunAt)`. Assembles four data sections:

1. **Standing instructions** — Reads `_heartbeat_instructions` key from `semantic_memory`. Falls back to a default prompt if missing. The agent can update its own instructions via `memorize`.

2. **Advisories** — Two subsections:
   - Pending: all advisories with `status = 'proposed'` and `deleted = 0`, titles only
   - Updates since last run: advisories where `resolved_at > lastRunAt`, showing title + new status (approved/applied/dismissed/deferred)

3. **Recent task completions** — 5 most recent tasks with `status IN ('completed', 'failed')` ordered by `last_run_at DESC`. Shows trigger_spec, status, and error snippet if failed.

4. **Per-thread activity** — Threads with new messages since `lastRunAt`. Shows thread title + unread count, capped at 10.

Output is a formatted string used as the user message content for the heartbeat's agent loop.

### Prompt Template

The context builder wraps its output in a fixed prompt:

```
You are running a scheduled heartbeat check.

## Standing Instructions
{instructions}

## Advisories
Pending ({count}): {titles}

Since last check:
{status_changes}

## Recent Tasks
{task_summaries}

## Thread Activity
{thread_summaries}

Review the above and take action on anything that needs attention.
If nothing needs attention, respond briefly with what you observed.
```

### Quiescence Note Injection

When quiescence is active (multiplier > 1), both heartbeat and cron task runs include a system-level note in the agent loop context:

```
[System note: Quiescence is active (idle {duration}). Task intervals are stretched
by {multiplier}x. Normal interval: {base}min, effective: {effective}min.]
```

This is injected in the scheduler's `runTask()` before the agent loop starts, as a system message prepended to the task thread. Applies to both heartbeat and cron tasks.

### Scheduler Dispatch

In `runTask()` (`packages/agent/src/scheduler.ts`), when `task.type === "heartbeat"`:

1. Call `buildHeartbeatContext(db, task.last_run_at)` to generate the payload
2. If quiescence is active, inject the quiescence note as a system message
3. Insert the generated payload as the user message (same path as cron injects `task.payload`)
4. Run the agent loop normally

No dismissal detection — the agent loop handles both "act" and "observe" cases naturally.

### Persistent Thread

The heartbeat task gets a dedicated persistent thread created during seeding. All heartbeat runs append to this thread, giving the agent continuity across checks — it can reference what it observed and did in previous heartbeats.

### Overlap Prevention

Uses the existing CAS claiming mechanism:

1. Heartbeat task stays in `running` status during execution
2. `phase1Schedule` only claims `pending` tasks via `WHERE status = 'pending'` CAS
3. `phase0Eviction` handles stuck heartbeats after 5min timeout
4. After completion, `rescheduleHeartbeat()` sets next clock-aligned `next_run_at` and resets to `pending`

At-least-once semantics: in a multi-host cluster, the CAS pattern prevents simultaneous execution. If a host crashes mid-heartbeat, eviction + rescheduling ensures the next boundary is still hit.

## Existing Patterns

This design follows established patterns from the existing scheduler:

- **Task type dispatch**: `runTask()` already branches on `task.type` for cron vs deferred vs event. Heartbeat adds another branch.
- **Self-rescheduling**: `rescheduleCronTask()` pattern — called after completion, errors, and eviction. `rescheduleHeartbeat()` follows the same structure with different scheduling math.
- **Startup seeding**: `seedCronTasks()` in `packages/agent/src/task-resolution.ts` seeds cron tasks from config on startup. `seedHeartbeat()` follows this pattern.
- **CAS claiming**: Phase 1 schedule uses `UPDATE ... WHERE status = 'pending'` with `changes()` check. No changes needed.
- **Quiescence tiers**: Defined in `packages/agent/src/scheduler.ts:63-70`. Heartbeat reuses the same tier table and `lastUserInteractionAt` tracking.
- **Heartbeat eviction**: `phase0Eviction()` already handles stuck running tasks. No changes needed for heartbeat type — it's just another running task.

**New pattern introduced**: Clock-aligned interval math (vs cron expression parsing). This is simpler than cron but supports arbitrary intervals.

**Divergence from existing cron**: Cron tasks use static `task.payload` as the user message. Heartbeat generates payload at runtime via the context builder. The scheduler's `runTask()` gains a new code path for this.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Type System and Scheduling Infrastructure
**Goal:** Add heartbeat trigger type and clock-aligned rescheduling

**Components:**
- `packages/shared/src/types.ts` — add `"heartbeat"` to `TaskType` union
- `packages/shared/src/config-schemas.ts` — add heartbeat section to `cronSchedulesSchema`
- `packages/agent/src/scheduler.ts` — add `rescheduleHeartbeat()` function with clock-aligned math and quiescence integration
- `packages/agent/src/task-resolution.ts` — add `seedHeartbeat()` following `seedCronTasks` pattern

**Dependencies:** None (first phase)

**Done when:** Heartbeat tasks can be seeded on startup, claimed by the scheduler, and rescheduled to the next clock-aligned boundary. Quiescence multiplier stretches the effective interval. Tests verify clock alignment math, quiescence interaction, and seeding idempotency.

**Covers:** heartbeat-task.AC1, heartbeat-task.AC3, heartbeat-task.AC4
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Context Builder
**Goal:** Build heartbeat activity context from database state

**Components:**
- `packages/agent/src/heartbeat-context.ts` — new module exporting `buildHeartbeatContext(db, lastRunAt)`. Queries standing instructions, advisories (pending + recent changes), task completions, and thread activity. Returns formatted prompt string.

**Dependencies:** Phase 1 (heartbeat task exists to provide `last_run_at`)

**Done when:** Context builder produces correct output for each data source. Tests verify: standing instructions loaded from memory (with fallback), advisory pending/change queries, task completion summaries, thread activity counts. Tests use real DB fixtures, not mocks.

**Covers:** heartbeat-task.AC2
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Scheduler Integration
**Goal:** Wire heartbeat dispatch into the scheduler's runTask pipeline

**Components:**
- `packages/agent/src/scheduler.ts` — add heartbeat branch in `runTask()`: calls context builder, injects quiescence note when active, inserts generated payload as user message
- `packages/agent/src/scheduler.ts` — call `rescheduleHeartbeat()` in all rescheduling paths (completion, soft error, hard error, eviction)
- `packages/cli/src/commands/start.ts` — call `seedHeartbeat()` during bootstrap sequence

**Dependencies:** Phase 1 (scheduling), Phase 2 (context builder)

**Done when:** A heartbeat task fires on schedule, generates context from DB state, runs the agent loop, and reschedules. Quiescence note appears in system context when idle. Integration test verifies full cycle: seed → claim → build context → run → reschedule.

**Covers:** heartbeat-task.AC1, heartbeat-task.AC2, heartbeat-task.AC3, heartbeat-task.AC5
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Quiescence Note for All Scheduled Tasks
**Goal:** Inject quiescence awareness into both heartbeat and cron task contexts

**Components:**
- `packages/agent/src/scheduler.ts` — in `runTask()`, compute quiescence state and inject system note for any scheduled task (heartbeat or cron) when multiplier > 1

**Dependencies:** Phase 3 (scheduler integration)

**Done when:** Both heartbeat and cron tasks receive a quiescence note when the system is idle. Tests verify note presence/absence based on idle time, and correct multiplier/interval values in the note text.

**Covers:** heartbeat-task.AC5
<!-- END_PHASE_4 -->

## Additional Considerations

**Standing instructions are agent-editable.** The `_heartbeat_instructions` memory key lives in `semantic_memory`, not static config. The agent can update its own instructions via `memorize` — e.g., adding a monitoring check after the operator mentions it. This is intentional: heartbeat should adapt to evolving needs without config changes.

**Heartbeat thread grows unbounded.** The persistent thread accumulates messages over time. The existing truncation and compaction mechanisms (backward fill, cold cache compaction, and the new truncation summary from CTX-1) handle this naturally. No special cleanup needed.

**Cost per heartbeat.** Each heartbeat is one LLM call. With quiescence stretching intervals during idle periods, the effective cost during low-activity hours is minimal. The full activity context (advisories, tasks, threads) adds ~500-1000 tokens per heartbeat.

**Default enabled.** Unlike the RFC which proposed opt-in, this design defaults to enabled with 30min interval. Operators who want to disable can set `heartbeat.enabled: false` in `cron_schedules.json`.
