# RFC: Heartbeat Task Type

**Supplements:** `2026-03-20-base.md` §5 (tasks schema), `agent-system.md` (Scheduler section)
**Date:** 2026-04-04
**Status:** Implemented

---

## 1. Problem Statement

### 1.1 Context

Bound supports three scheduled task types: cron tasks (operator-defined via `cron_schedules.json`), deferred tasks (agent-created retries with backoff), and event tasks (triggered by external events). All three execute static payloads — cron tasks replay stored user messages; deferred tasks re-run a fixed intent; event tasks handle specific webhook or relay scenarios. None provide the agent a mechanism to periodically assess system state and take autonomous action informed by current conditions.

The system tracks pending advisories, recent task outcomes, and per-thread activity, but the agent has no regularly scheduled opportunity to survey these signals and decide what (if anything) needs attention. The operator must explicitly query the agent or wait for the agent to notice while handling unrelated conversations. Advisories may accumulate unreviewed; failed tasks may go undiagnosed; threads may contain unanswered questions that the agent never sees because they arrived outside of interactive sessions.

### 1.2 Need

The system requires a scheduled task type that:
1. **Fires at predictable intervals** (e.g., every 30 minutes) without operator intervention.
2. **Assembles fresh context at runtime** — pending advisories, recent task outcomes, per-thread activity since the last check — rather than executing a static payload.
3. **Leverages existing scheduling infrastructure** (CAS-based claiming, overlap prevention, error recovery, quiescence stretching) without duplicating cron semantics.
4. **Maintains continuity across runs** via a persistent thread, giving the agent memory of what it observed and did in previous checks.
5. **Adapts its own behavior** via agent-editable standing instructions stored in semantic memory, not static config.

A heartbeat task type satisfies these requirements by scheduling at clean wall-clock boundaries (`:00`, `:30` for a 30-minute interval), dynamically querying the database for current system state, and presenting the assembled context to the agent loop as a user message in a dedicated persistent thread.

### 1.3 Scope

This RFC introduces:
- A new `heartbeat` task type with clock-aligned scheduling math (modulo arithmetic, not cron expressions).
- A context builder (`buildHeartbeatContext`) that queries standing instructions, pending advisories, advisory status changes since the last run, recent task completions, and per-thread activity counts.
- Self-rescheduling after completion, soft/hard errors, and eviction (at-least-once semantics).
- Quiescence integration that stretches the effective interval during idle periods without skipping scheduled checks.
- Operator configuration via `cron_schedules.json` (interval and enabled flag); startup seeding of the heartbeat task using a deterministic UUID.

This RFC does NOT introduce:
- A new database schema migration (the heartbeat task lives in the existing `tasks` table).
- A new sync protocol (heartbeat tasks replicate via the existing `change_log` mechanism for the `tasks` table).
- Changes to the agent loop state machine (heartbeat tasks execute through the same `runTask()` pipeline as cron and deferred tasks).
- A specialized LLM call path (the heartbeat generates a user message from assembled context and runs the standard agent loop).

---

## 2. Proposal

### 2.1 Summary

Introduce a `heartbeat` task type with `trigger_spec: { type: "heartbeat", interval_ms: number }`. The scheduler dispatches heartbeat tasks through the existing `runTask()` pipeline. Unlike cron tasks (which use cron expressions and replay stored payloads), heartbeat tasks use clock-aligned interval math — `Math.ceil(now / effectiveInterval) * effectiveInterval` — and generate payloads at runtime via a context builder (`buildHeartbeatContext`) that queries:

1. **Standing instructions** from `semantic_memory` key `_heartbeat_instructions` (falls back to a default prompt).
2. **Pending advisories** (titles only) and advisory status changes since `last_run_at` (approved/dismissed/applied).
3. **Recent task completions** (5 most recent) with status and error snippets.
4. **Per-thread activity** (threads with new messages since `last_run_at`, capped at 10).

The heartbeat task self-reschedules after completion, soft/hard errors, and eviction, ensuring at-least-once execution per interval even in multi-host clusters. Quiescence multipliers stretch the effective interval during idle periods — a 30-minute base interval becomes 2.5 hours (5× multiplier) after 4 hours of idle time. The scheduler injects a quiescence note into the system context when the multiplier exceeds 1, making the agent aware of the stretched cadence.

The heartbeat task is seeded on startup with a deterministic UUID (`deterministicUUID(BOUND_NAMESPACE, "heartbeat")`) for idempotent crash-safe replay. The operator configures the base interval and enabled flag via `cron_schedules.json`; when omitted, the system defaults to enabled with a 30-minute interval.

### 2.2 What This Changes

| Area | Change |
|---|---|
| Task types (`types.ts`) | Add `"heartbeat"` to `TaskType` union. |
| `trigger_spec` schema | New shape: `{ type: "heartbeat", interval_ms: number }`. |
| Scheduler dispatch (`runTask()`) | New branch: heartbeat tasks call `buildHeartbeatContext()` instead of replaying `task.payload`. |
| Rescheduling | New `rescheduleHeartbeat()` function in `scheduler.ts` with clock-aligned math and quiescence integration. |
| Seeding | New `seedHeartbeat()` in `task-resolution.ts`, called during bootstrap sequence (same pattern as `seedCronTasks`). |
| Quiescence notes | Both heartbeat and cron tasks receive a system message when quiescence is active (multiplier > 1, idle > 30 min). |
| Config schema (`config-schemas.ts`) | Add `heartbeatConfigSchema` to `cronSchedulesSchema`. |
| Context builder | New `packages/agent/src/heartbeat-context.ts` exporting `buildHeartbeatContext(db, lastRunAt)`. |

### 2.3 Design Notes

**Clock-aligned scheduling is simpler than cron expressions and supports arbitrary intervals.** Cron expressions require a parser and 5-field syntax (`0 */30 * * *`). Clock alignment is one formula: `Math.ceil(now / interval) * interval`. A 30-minute interval fires at `:00` and `:30`. A 15-minute interval fires at `:00`, `:15`, `:30`, `:45`. A 2-hour interval fires at even hours. Quiescence stretches the interval before alignment, so a 5× multiplier on a 30-minute base turns it into 2.5-hour boundaries.

**Runtime context assembly replaces static payload.** Cron tasks store a user message in `task.payload` and replay it verbatim. The heartbeat queries the database at every run: pending advisories may have changed, new tasks may have completed, new threads may have appeared. The context builder formats this into a prompt structure (standing instructions + advisories + tasks + threads) and returns it as a string. The scheduler inserts this as the user message for the heartbeat's agent loop — same path as cron injects `task.payload`.

**Standing instructions are agent-editable.** The `_heartbeat_instructions` key lives in `semantic_memory`, not static config. The agent can update its own instructions via `memorize` — e.g., adding a monitoring check after the operator mentions it. This is intentional: the heartbeat should adapt to evolving needs without config changes. The agent cannot modify `cron_schedules.json` (operator config), but it can modify its own memory.

**Self-rescheduling follows the cron pattern.** `rescheduleCronTask()` is called after completion, errors, and eviction. `rescheduleHeartbeat()` follows the same structure with different scheduling math. Both reset `status = 'pending'`, clear claim metadata, and set `next_run_at`. The scheduler's four rescheduling call sites (completion, model-validation failure, soft error, hard error) gain a type-dispatch branch that calls `rescheduleHeartbeat()` for heartbeat tasks.

**Eviction rescheduling already exists.** The phase0 eviction loop (`phase0Eviction()`) calls type-specific reschedule helpers for stuck running tasks. Heartbeat tasks follow the same path: eviction bumps `consecutive_failures`, sets `error`, and calls `rescheduleHeartbeat()` to set the next clock boundary. No new eviction logic is required.

**Quiescence stretches the interval but never skips a scheduled check.** Quiescence multipliers are defined in the scheduler (`QUIESCENCE_TIERS`): 2× at 0 idle, 3× at 30min idle, 5× at 4h idle, 10× at 12h idle. These are already applied to cron tasks. The heartbeat reuses the same tiers: `effectiveInterval = baseInterval * multiplier`. After a run completes, `rescheduleHeartbeat()` computes the next boundary using the effective interval. If the operator checks the system before the stretched boundary, the next heartbeat fires on schedule at the pre-computed time. Quiescence does not retroactively cancel or advance scheduled runs; it only affects the rescheduling math after each completion.

**Quiescence notes make the agent aware of the stretched cadence.** When idle time exceeds `QUIESCENCE_NOTE_THRESHOLD` (30 minutes), the scheduler injects a system message before starting the agent loop:

```
[System note: Quiescence is active (idle 4h 23m). Task intervals are stretched by 5x.
Normal interval: 30min, effective: 150min.]
```

This applies to both heartbeat and cron tasks. The agent sees the note and can adjust its behavior (e.g., acknowledging the reduced frequency in its response, skipping non-urgent observations). The note is injected in `runTask()` before the user message, as a system-role message prepended to the task thread.

**Heartbeat thread grows unbounded, handled by existing truncation.** The persistent thread accumulates messages over time. The existing context assembly truncation mechanisms (backward fill, token-aware truncation from the CTX-1 RFC, cold cache compaction) handle this naturally. No special cleanup is needed. The heartbeat thread is a normal thread with a predictable message pattern (alternating user + assistant pairs, one per heartbeat run).

**Persistent thread is created during seeding.** The heartbeat task row's `thread_id` is populated during seeding (same as cron tasks create threads for scheduled work). All heartbeat runs append to this thread, giving the agent continuity: it can reference what it observed and did in previous heartbeats. The agent can query prior observations ("what did I note about disk space last time?") via the standard thread history.

**Dismissal detection is not implemented.** The original design doc considered a dismissal heuristic (if the agent responds with "nothing needs attention," skip LLM calls for subsequent runs with identical context). This is deferred. The agent loop runs on every scheduled heartbeat regardless of prior responses. The cost per heartbeat is one LLM call (~500-1000 input tokens for the assembled context). With quiescence stretching intervals during idle periods, the effective cost during low-activity hours is minimal.

**Overlap prevention uses the existing CAS mechanism.** The heartbeat task stays in `running` status during execution. `phase1Schedule` only claims `pending` tasks via `WHERE status = 'pending'` CAS. If a heartbeat is already running, the next scheduler tick's phase1 SELECT excludes it. After completion, `rescheduleHeartbeat()` sets `next_run_at` and resets to `pending`. In multi-host clusters, the CAS pattern prevents simultaneous execution. If a host crashes mid-heartbeat, eviction + rescheduling ensures the next boundary is still hit (at-least-once semantics).

**No new tables or schema migrations.** The heartbeat task lives in the existing `tasks` table with `type = 'heartbeat'` and a JSON `trigger_spec` containing `interval_ms`. The context builder queries existing tables (`semantic_memory`, `advisories`, `tasks`, `threads`, `messages`). The persistent thread is a normal row in the `threads` table. Startup seeding uses `INSERT OR IGNORE` with a deterministic UUID, same as cron task seeding.

**Default enabled with 30-minute interval.** The design doc originally proposed opt-in. This RFC defaults to enabled: when `cron_schedules.json` omits the `heartbeat` key, the system seeds a heartbeat task with `interval_ms: 1_800_000` (30 minutes). Operators who want to disable set `heartbeat: { enabled: false }` in `cron_schedules.json`. The rationale: the heartbeat provides visibility into advisories, tasks, and threads that the operator may otherwise miss. The cost is one LLM call every 30 minutes (stretched by quiescence during idle periods). For operators using cloud LLM backends, this is a few cents per day; for operators using local models (Ollama), the cost is zero.

**Cross-references to hierarchical memory RFC.** The hierarchical memory RFC (`2026-04-10-hierarchical-memory.md`) references "the heartbeat" performing consolidation (creating summary entries during periodic memory sweeps). That RFC specifies the memory retrieval system and the summary lifecycle, not the heartbeat task type itself. This RFC specifies the heartbeat task's scheduling, context builder, and lifecycle, completing the picture: the heartbeat is a scheduled task that runs the agent loop with a context that includes both fresh system state (from the context builder defined here) and hierarchical memory (from the context assembly pipeline defined in the base spec and extended by the hierarchical memory RFC).

---

## 3. Requirements (EARS Format)

Requirements use the prefix `R-HB` (Heartbeat).

### 3.1 Ubiquitous

**R-HB1.** The system shall support a `heartbeat` task type with `trigger_spec: { type: "heartbeat", interval_ms: number }`, where `interval_ms` is the base interval in milliseconds (minimum 60,000). The task shall be stored in the existing `tasks` table with no schema migration required.

**R-HB2.** The scheduler shall dispatch heartbeat tasks through the existing `runTask()` pipeline. When `task.type === "heartbeat"`, the scheduler shall call `buildHeartbeatContext(db, task.last_run_at)` to generate the payload, then insert the generated payload as the user message in the heartbeat's thread, then run the agent loop normally.

**R-HB3.** The `rescheduleHeartbeat(db, task, lastUserInteractionAt)` function shall compute the next run time as `Math.ceil(now / effectiveInterval) * effectiveInterval`, where `effectiveInterval = interval_ms * quiescenceMultiplier`. The quiescence multiplier shall be determined by `computeQuiescenceMultiplier(lastUserInteractionAt)` using the existing `QUIESCENCE_TIERS` table. The function shall update the task row with `status = 'pending'`, `next_run_at = <computed boundary>`, and clear claim metadata (`claimed_by`, `claimed_at`, `lease_id` set to NULL).

**R-HB4.** The scheduler shall call `rescheduleHeartbeat()` in the same code paths where it calls `rescheduleCronTask()`: after successful completion, after model-validation failure, after soft error with `consecutive_failures` below threshold, after hard error with `consecutive_failures` exceeding threshold, and after heartbeat timeout eviction (phase0).

**R-HB5.** The `seedHeartbeat(db, config, siteId)` function shall create a heartbeat task using a deterministic UUID (`deterministicUUID(BOUND_NAMESPACE, "heartbeat")`). It shall set `type = 'heartbeat'`, `status = 'pending'`, `trigger_spec = JSON.stringify({ type: "heartbeat", interval_ms })`, `next_run_at` to the next clock-aligned boundary, `created_by = "system"`, and `thread_id` to a newly created thread. The function shall be idempotent: calling it twice with the same config produces no duplicate rows (INSERT OR IGNORE semantics).

**R-HB6.** The orchestrator bootstrap sequence shall call `seedHeartbeat(db, cronSchedulesConfig.heartbeat, siteId)` after the scheduler initialization step, in the same phase where `seedCronTasks()` is called. When `cronSchedulesConfig.heartbeat` is undefined, `seedHeartbeat` shall default to `{ enabled: true, interval_ms: 1_800_000 }`. When `cronSchedulesConfig.heartbeat.enabled` is `false`, `seedHeartbeat` shall not create a task row.

**R-HB7.** The `buildHeartbeatContext(db, lastRunAt)` function shall assemble context from four data sources:
1. **Standing instructions:** Query `semantic_memory` for `key = '_heartbeat_instructions'`. If found, use the entry's `value`. If not found, use the default instruction text: `"Review system state and take action on anything that needs attention. If nothing needs attention, respond briefly with what you observed."`
2. **Advisories:** Query all advisories with `status = 'proposed'` and `deleted = 0` (pending), and all advisories with `resolved_at > lastRunAt` (status changes since last run). Format as two subsections: "Pending (N): [titles]" and "Since last check: [title + new status]".
3. **Recent task completions:** Query the 5 most recent tasks with `status IN ('completed', 'failed')` ordered by `last_run_at DESC`. Format with trigger_spec, status, and error snippet (first 150 chars) if failed.
4. **Per-thread activity:** Query threads with new messages where `messages.created_at > lastRunAt`, ordered by most recent message, capped at 10. Format with thread title + unread count.

The function shall return a formatted string used as the user message content for the heartbeat's agent loop. When `lastRunAt` is NULL (first run), the function shall use `task.created_at` as the baseline timestamp for "since last run" queries.

**R-HB8.** When the scheduler runs a heartbeat or cron task AND idle time (`Date.now() - lastUserInteractionAt`) exceeds `QUIESCENCE_NOTE_THRESHOLD` (30 minutes) AND the quiescence multiplier is greater than 1, the scheduler shall inject a system-role message into the task thread before inserting the user message. The system message shall include: the idle duration (formatted as "Xh Ym" or "Ym"), the multiplier value, the base interval, and the effective interval. The message format shall be:

```
[System note: Quiescence is active (idle {duration}). Task intervals are stretched by {multiplier}x.
Normal interval: {base}min, effective: {effective}min.]
```

**R-HB9.** The config schema (`cronSchedulesSchema` in `config-schemas.ts`) shall include a `heartbeat` field of type `heartbeatConfigSchema`, where `heartbeatConfigSchema` is defined as:

```typescript
z.object({
  enabled: z.boolean(),
  interval_ms: z.number().int().min(60_000).optional(),
}).strict()
```

When `heartbeat` is omitted from the config, the system shall default to `{ enabled: true, interval_ms: 1_800_000 }`. When `heartbeat.interval_ms` is omitted but `enabled` is true, the system shall default `interval_ms` to `1_800_000`.

### 3.2 State-Driven

**R-HB10.** When a heartbeat task is in `status = 'running'`, the phase1 schedule CAS (`UPDATE tasks SET ... WHERE status = 'pending' AND ...`) shall exclude it (the task is not eligible for claim until it transitions back to `pending`).

**R-HB11.** When a heartbeat task has been in `status = 'running'` for longer than `EVICTION_TIMEOUT` (5 minutes) and `heartbeat_at < now - EVICTION_TIMEOUT`, the phase0 eviction loop shall evict it: set `status = 'failed'`, increment `consecutive_failures`, set `error = 'evicted due to heartbeat timeout'`, then call `rescheduleHeartbeat()` to transition to `pending` with the next clock-aligned boundary.

### 3.3 Optional

**R-HB12.** The `buildHeartbeatContext()` function may cap advisory titles, task summaries, and thread summaries to reasonable character limits to prevent unbounded context growth. The implementation may also format output with markdown headings and bullet lists for readability.

**R-HB13.** The quiescence note formatting helper may abbreviate idle durations shorter than 1 hour as "Xm" and longer than 1 hour as "Xh Ym". Zero idle time may be formatted as "0m".

### 3.4 Acceptance Criteria

Acceptance criteria use the prefix `heartbeat-task.AC` and map 1:1 to test names. Each R-HB requirement with observable behavior has at least one success scenario and one failure-mode or edge-case scenario.

#### heartbeat-task.AC1: Heartbeat Scheduling (R-HB1, R-HB3, R-HB4, R-HB5)

- **AC1.1 Success (R-HB3).** Given `interval_ms = 1_800_000` and a current time of 14:17, when `rescheduleHeartbeat()` is called, then `next_run_at` resolves to 14:30 (next 30-minute boundary). Verified for arbitrary intervals (15min, 45min, 2h).
- **AC1.2 Success (R-HB3, R-HB4).** Given a heartbeat task that completes successfully, when `rescheduleHeartbeat()` is called, then the task's `status` is reset to `"pending"` and `next_run_at` is set to the next clock-aligned boundary. Integration test: full scheduler tick with mock agent loop, verify task transitions `running → pending` with correct `next_run_at`.
- **AC1.3 Success (R-HB4).** Given a heartbeat task that fails (soft error, hard error, or eviction), when the scheduler calls `rescheduleHeartbeat()`, then the task's `status` is reset to `"pending"`, `consecutive_failures` is incremented, and `next_run_at` is set to the next clock-aligned boundary (not immediate).
- **AC1.4 Success (R-HB3).** Given `interval_ms` values of 900,000 (15min), 2,700,000 (45min), and 7,200,000 (2h), when `rescheduleHeartbeat()` is called, then `next_run_at` aligns to the correct clock boundary for each interval.
- **AC1.5 Failure (R-HB9).** Given `interval_ms` values of 0, -1, or 59,999, when `heartbeatConfigSchema` is parsed, then validation fails. Valid values (1,800,000) parse successfully. Missing `heartbeat` key defaults to `{ enabled: true, interval_ms: 1_800_000 }`. `{ enabled: false }` parses without error.

#### heartbeat-task.AC2: Context Builder (R-HB7)

- **AC2.1 Success (R-HB7.1).** Given a `semantic_memory` row with `key = '_heartbeat_instructions'` and a custom value, when `buildHeartbeatContext()` is called, then the output contains the custom instructions in the "Standing Instructions" section. Integration test: seed heartbeat + insert memory row, run scheduler tick, verify user message contains the instructions.
- **AC2.2 Success (R-HB7.1).** Given no `_heartbeat_instructions` row in `semantic_memory`, when `buildHeartbeatContext()` is called, then the output contains the default instruction text ("Review system state...").
- **AC2.3 Success (R-HB7.2).** Given 2 advisory rows with `status = 'proposed'` and `deleted = 0`, when `buildHeartbeatContext()` is called, then the output contains `"Pending (2):"` and both titles. Soft-deleted advisories (`deleted = 1`) are excluded.
- **AC2.4 Success (R-HB7.2).** Given an advisory with `status = 'approved'` and `resolved_at > lastRunAt`, when `buildHeartbeatContext()` is called, then the output includes the advisory title and `"approved"` in the "Since last check" subsection.
- **AC2.5 Success (R-HB7.3).** Given 2 task rows (one `completed`, one `failed` with a 500-char error), both with `last_run_at > lastRunAt`, when `buildHeartbeatContext()` is called, then both appear in the output, and the failed task includes an error snippet truncated to 150 chars.
- **AC2.6 Success (R-HB7.4).** Given a thread with 3 messages where `created_at > lastRunAt`, when `buildHeartbeatContext()` is called, then the output contains the thread title and `"3 new message(s)"`. With 15 threads, only 10 appear (cap).
- **AC2.7 Edge (R-HB7).** Given an empty database (no advisories, tasks, or threads), when `buildHeartbeatContext()` is called, then the output contains `"Pending (0): None"`, `"No recent task completions."`, and `"No thread activity since last check."`. With `lastRunAt = NULL`, the output includes "First heartbeat run" messages.

#### heartbeat-task.AC3: Overlap Prevention (R-HB10, R-HB11)

- **AC3.1 Success (R-HB10).** Given a heartbeat task with `status = 'running'`, when the scheduler's phase1 CAS claim query runs (`UPDATE ... WHERE status = 'pending'`), then the UPDATE returns `changes() === 0` (task not re-claimed). Integration test: set task to running, run `phase1Schedule`, verify the running task is not claimed.
- **AC3.2 Success (R-HB11).** Given a heartbeat task with `status = 'running'` and `heartbeat_at` older than 5 minutes, when phase0 eviction runs, then the task is evicted: `status` transitions `failed → pending`, `consecutive_failures` is incremented, and `next_run_at` is set to the next clock-aligned boundary (not immediate).
- **AC3.3 Success (R-HB10).** Given two scheduler instances sharing the same database (simulated in-process), when both run `phase1Schedule` concurrently, then exactly one claims the heartbeat task (CAS ensures single-writer). After completion, `next_run_at` is set for the next interval.

#### heartbeat-task.AC4: Configuration and Seeding (R-HB5, R-HB6, R-HB9)

- **AC4.1 Success (R-HB5, R-HB6).** Given no `cron_schedules.json` (or one that omits the `heartbeat` key), when the orchestrator starts, then a heartbeat task is seeded with `type = "heartbeat"`, `status = "pending"`, `trigger_spec` containing `interval_ms: 1_800_000`, `next_run_at` at a 30-minute boundary, and `created_by = "system"`.
- **AC4.2 Success (R-HB5).** Given `{ heartbeat: { enabled: true, interval_ms: 900_000 } }` in config, when `seedHeartbeat()` is called, then `trigger_spec` contains `interval_ms: 900_000`.
- **AC4.3 Success (R-HB5).** Given `seedHeartbeat()` called twice with the same config, when the database is queried, then `SELECT COUNT(*) FROM tasks WHERE type = 'heartbeat'` returns 1 (INSERT OR IGNORE semantics). The deterministic UUID ensures idempotency.
- **AC4.4 Success (R-HB6).** Given `{ heartbeat: { enabled: false, interval_ms: 1_800_000 } }` in config, when `seedHeartbeat()` is called, then no heartbeat task row exists in the tasks table.

#### heartbeat-task.AC5: Quiescence Integration (R-HB3, R-HB8)

- **AC5.1 Success (R-HB3).** Given `lastUserInteractionAt` set to 5 hours ago (quiescence tier 2, multiplier 5×), when `rescheduleHeartbeat()` is called, then the effective interval is 150 minutes (30 min × 5×) and `next_run_at` aligns to a 150-minute boundary. Verified for all quiescence tiers: 0ms idle (2×), 1h idle (3×), 4h idle (5×), 12h idle (10×).
- **AC5.2 Success (R-HB8).** Given `lastUserInteractionAt` set to 2 hours ago (above `QUIESCENCE_NOTE_THRESHOLD`), when a heartbeat task runs, then a system message is inserted containing `"Quiescence is active"`, the multiplier value, and the base/effective interval values.
- **AC5.3 Success (R-HB8).** Given `lastUserInteractionAt` set to 2 hours ago, when a cron task runs, then a system message is inserted containing `"Quiescence is active"` and the multiplier.
- **AC5.4 Success (R-HB8).** Given `lastUserInteractionAt` set to 5 minutes ago (below `QUIESCENCE_NOTE_THRESHOLD` of 30 minutes), when a heartbeat task runs, then NO system message containing `"Quiescence is active"` is inserted.

---

## 4. Implementation Notes

### 4.1 Phasing

The implementation proceeds in four phases, each delivering a testable unit of functionality:

1. **Phase 1: Type System and Scheduling Infrastructure.** Add the `heartbeat` trigger type to `types.ts`. Add `heartbeatConfigSchema` to `config-schemas.ts`. Implement `rescheduleHeartbeat()` with clock-aligned math and quiescence integration in `scheduler.ts`. Implement `seedHeartbeat()` in `task-resolution.ts`. Tests verify clock alignment math, quiescence interaction, and seeding idempotency.

2. **Phase 2: Context Builder.** Implement `buildHeartbeatContext()` in a new `packages/agent/src/heartbeat-context.ts` module. Tests verify standing instructions loading (with fallback), advisory queries (pending + recent changes), task completion summaries, and thread activity counts. Tests use real DB fixtures, not mocks.

3. **Phase 3: Scheduler Integration.** Wire heartbeat dispatch into `runTask()`: add heartbeat branch that calls context builder, injects quiescence note when active, inserts generated payload as user message. Call `rescheduleHeartbeat()` in all rescheduling paths (completion, soft error, hard error, eviction). Call `seedHeartbeat()` during bootstrap sequence in `start.ts`. Integration tests verify full cycle: seed → claim → build context → run → reschedule.

4. **Phase 4: Quiescence Note for All Scheduled Tasks.** In `runTask()`, compute quiescence state and inject system note for any scheduled task (heartbeat or cron) when multiplier > 1 and idle > `QUIESCENCE_NOTE_THRESHOLD`. Tests verify note presence/absence based on idle time, and correct multiplier/interval values in the note text.

### 4.2 Test Coverage

All 20 acceptance criteria are covered by automated tests across 6 test files (118 tests total):

- `packages/shared/src/__tests__/config-schemas.test.ts` — AC1.5 (schema validation)
- `packages/agent/src/__tests__/heartbeat-scheduling.test.ts` — AC1.1-AC1.4, AC3.2, AC5.1 (clock alignment, quiescence math)
- `packages/agent/src/__tests__/heartbeat-seeding.test.ts` — AC3.1, AC4.1-AC4.4 (seeding idempotency, CAS)
- `packages/agent/src/__tests__/heartbeat-context.test.ts` — AC2.1-AC2.7 (context builder queries)
- `packages/agent/src/__tests__/heartbeat-integration.test.ts` — AC1.2, AC1.3, AC2.1, AC2.3, AC3.1, AC3.3 (end-to-end cycles)
- `packages/agent/src/__tests__/quiescence-note.test.ts` — AC5.1-AC5.4 (quiescence note injection)

No manual verification is required. All acceptance criteria have success and failure/edge-case scenarios.

### 4.3 Backwards Compatibility

No coordinated upgrade is required. The heartbeat task is a new task type that does not affect existing cron, deferred, or event tasks. Hosts without the heartbeat code continue to operate normally — they ignore the heartbeat task row (unrecognized task type). Once upgraded, the heartbeat task is seeded on next startup and begins firing on schedule.

Multi-host clusters can roll hosts one at a time. The heartbeat task replicates via the existing `tasks` table sync mechanism. The first upgraded host seeds the heartbeat; subsequent upgrades see the deterministic UUID and skip seeding (INSERT OR IGNORE). The CAS claim pattern ensures only one host executes the heartbeat per interval, even in mixed-version clusters (pre-upgrade hosts skip the unrecognized task type; post-upgrade hosts claim and execute).

### 4.4 Cost and Noise Budget

- **LLM cost per heartbeat.** Each heartbeat is one LLM call. Assembled context is ~500-1000 tokens (standing instructions + advisories + tasks + threads). With a 30-minute base interval and quiescence stretching to 2.5 hours during idle periods, the effective cost is approximately 48 calls per active day, 16 calls per idle day. For cloud backends (e.g., Claude via AWS Bedrock at $3/M input tokens), this is $0.048/day active, $0.016/day idle. For local backends (Ollama), the cost is zero.

- **Change_log volume.** The heartbeat task row generates change_log entries on reschedule (every 30 minutes, or stretched by quiescence). Each reschedule updates `status`, `next_run_at`, `heartbeat_at`, and clears claim metadata — one change_log entry per heartbeat cycle. At 30-minute intervals, this is 48 entries/day. During idle periods (5× multiplier), this drops to ~10 entries/day. This is negligible compared to the existing message, memory, and task change_log volume (hundreds per day during active periods).

- **Message table growth.** The heartbeat thread accumulates one user + one assistant message per heartbeat run. At 48 runs/day active (30-minute interval), this is 96 messages/day. Over 30 days, this is ~2,880 messages. The existing context assembly truncation mechanisms handle this: backward fill loads as many messages as fit the token budget, and token-aware truncation (from the CTX-1 RFC) injects a truncation summary when the history exceeds the budget. The heartbeat thread is no different from a long-lived interactive thread — truncation applies naturally.

- **Disk space.** Heartbeat messages are text-only (no file uploads, no large content blocks). Assembled context is ~1KB per user message. Assistant responses vary by model but are typically ~500 bytes ("observed X advisories, Y tasks, Z threads; nothing needs immediate attention"). At 96 messages/day × 1.5KB average = ~144KB/day. Over 30 days, ~4.3MB. This is negligible compared to the existing message corpus (hundreds of MB for active deployments).

### 4.5 Cross-References

**Hierarchical memory RFC (`2026-04-10-hierarchical-memory.md`).** That RFC specifies the memory retrieval system (tiered retrieval: pinned → summary → graph-seeded → recency) and the summary lifecycle (summary entries with `summarizes` edges to detail entries). It references "the heartbeat" as the entity performing consolidation (creating summaries during periodic sweeps). This RFC completes the picture: the heartbeat is a scheduled task (defined here) that runs the agent loop with a context that includes hierarchical memory (from the context assembly pipeline defined in the base spec and extended by the hierarchical memory RFC).

**Task lifecycle resilience RFC (`2026-05-26-task-lifecycle-resilience.md`).** That RFC specifies eviction resilience (synced `heartbeat_at`, host-liveness gate, atomic recovery, stuck-row healer). It treats the heartbeat task as one of four task types subject to eviction and recovery. This RFC specifies the heartbeat task's OWN behavior (clock-aligned scheduling, context builder, self-rescheduling), which is orthogonal to the eviction resilience mechanisms.

**Base spec (`2026-03-20-base.md` §5).** The base spec defines the `tasks` table schema and the four task types (cron, deferred, event, heartbeat). This RFC extends §5 by specifying the heartbeat task type's trigger_spec format, scheduling math, and lifecycle in detail.

**Agent system doc (`agent-system.md` Scheduler section).** The agent system doc describes the 4-phase scheduler tick (eviction, schedule, execute, settle) and the quiescence tiers. This RFC extends the scheduler by adding a new task type dispatch branch in `runTask()` and a new rescheduling function (`rescheduleHeartbeat()`) that reuses the existing quiescence tier table.

---

## 5. Open Questions

**Q1.** Future optimization: dismissal heuristic. If the agent responds with "nothing needs attention" and the context is identical to the previous run (no new advisories, tasks, or threads), should the system skip LLM calls for subsequent runs with unchanged context? This would reduce cost during idle periods. Deferred because (a) quiescence already stretches intervals during idle periods, reducing the number of redundant runs, and (b) the agent may want to observe and acknowledge the system's continued healthy state, even if nothing has changed.

**Q2.** Future extension: per-heartbeat task priority. Should heartbeat tasks support a priority field (e.g., "daily summary" heartbeat at higher priority than "check disk space" heartbeat)? Deferred because the current design assumes a single system-wide heartbeat. Multiple heartbeat tasks with different intervals and instructions could be supported by extending the seeding logic to accept a task name and using a deterministic UUID per name, but this is not required for the initial deployment.

---

## 6. Migration

No database migration required. The heartbeat task lives in the existing `tasks` table. The `type` column already accepts arbitrary text. The `trigger_spec` column already accepts arbitrary JSON. The context builder queries existing tables (`semantic_memory`, `advisories`, `tasks`, `threads`, `messages`). The persistent thread is a normal row in the `threads` table.

Startup seeding uses `INSERT OR IGNORE` with a deterministic UUID (`deterministicUUID(BOUND_NAMESPACE, "heartbeat")`), ensuring idempotent crash-safe replay. The first startup after deployment creates the heartbeat task row. Subsequent startups see the existing row and skip seeding.

For multi-host clusters, the heartbeat task replicates via the existing `tasks` table sync mechanism. The first upgraded host seeds the heartbeat; subsequent upgrades see the deterministic UUID and skip seeding. The CAS claim pattern ensures only one host executes the heartbeat per interval.

Operators who want to disable the heartbeat set `heartbeat: { enabled: false }` in `cron_schedules.json` and restart. The existing heartbeat task row is not automatically deleted; it remains in the database with `status = 'pending'` and is never claimed (the seeding logic skips creation when `enabled = false`, but does not tombstone existing rows). To fully remove a heartbeat task, the operator can run `DELETE FROM tasks WHERE type = 'heartbeat'` directly in SQLite or via the `query` command.

---

## 7. Glossary

- **Agent loop** — The state machine in `packages/agent/src/agent-loop.ts` that orchestrates LLM calls, tool execution, and filesystem persistence for a single conversational turn. The heartbeat task executes through the same agent loop as interactive conversations and cron tasks.
- **CAS (Compare-And-Swap)** — An atomic database pattern where an UPDATE includes the expected current state in the WHERE clause and checks `changes()` to verify the update succeeded, preventing race conditions in multi-host claiming. Used by phase1 schedule to claim tasks.
- **Clock-aligned scheduling** — Computing next run times as multiples of the interval (e.g., a 30min interval fires at :00 and :30), achieved with `Math.ceil(now / interval) * interval`. The heartbeat uses this instead of cron expressions.
- **Context builder** — The `buildHeartbeatContext()` function that queries the database for standing instructions, advisories, tasks, and threads, and formats them into a prompt string used as the user message for the heartbeat's agent loop.
- **Deterministic UUID** — A UUID computed from a namespace and a name using `deterministicUUID(BOUND_NAMESPACE, "heartbeat")`. Used for idempotent seeding: calling `seedHeartbeat()` multiple times produces the same UUID, and INSERT OR IGNORE prevents duplicates.
- **Eviction** — The scheduler's phase0 step that marks tasks stuck in `running` status as failed after a timeout (5 minutes for heartbeat tasks) and reschedules them. Eviction handles crashed hosts or hung agent loops.
- **Quiescence** — An adaptive backoff mechanism that stretches scheduled task intervals based on how long the system has been idle, reducing LLM costs during low-activity periods. Multipliers: 2× at 0 idle, 3× at 30min idle, 5× at 4h idle, 10× at 12h idle.
- **Quiescence note** — A system-role message injected by the scheduler when running a heartbeat or cron task during idle periods (multiplier > 1, idle > 30 min). The note informs the agent of the stretched interval and the idle duration.
- **Reschedule** — Setting `status = 'pending'`, computing the next `next_run_at` value, and clearing claim metadata after a task completes or fails. The heartbeat uses `rescheduleHeartbeat()` with clock-aligned math; cron uses `rescheduleCronTask()` with cron expression parsing.
- **Semantic memory** — The `semantic_memory` table that stores agent-generated key-value facts, synced across hosts. The heartbeat's standing instructions are stored under the `_heartbeat_instructions` key, making them agent-editable via the `memorize` command.
- **Standing instructions** — The content stored in the `_heartbeat_instructions` semantic memory key. The agent can update its own standing instructions via `memorize`, allowing the heartbeat's behavior to adapt without changing operator config files.
- **Trigger spec** — The JSON payload in a task's `trigger_spec` column that defines how and when the task should execute. For heartbeat tasks: `{ type: "heartbeat", interval_ms: number }`. For cron tasks: `{ type: "cron", expression: string }`.
