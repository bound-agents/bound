# Heartbeat Task Implementation Plan - Phase 3

**Goal:** Wire heartbeat dispatch into the scheduler's runTask pipeline and bootstrap sequence

**Architecture:** Integrates the heartbeat context builder (Phase 2) into the scheduler's `runTask()` dispatch, adds `rescheduleHeartbeat()` calls to all 7 rescheduling paths, and calls `seedHeartbeat()` during bootstrap. Creates a persistent thread for heartbeat continuity across runs.

**Tech Stack:** TypeScript, bun:sqlite, bun:test

**Scope:** 4 phases from original design (phase 3 of 4)

**Codebase verified:** 2026-04-04

---

## Acceptance Criteria Coverage

This phase implements and tests:

### heartbeat-task.AC1: Heartbeat scheduling
- **heartbeat-task.AC1.2 Success:** Heartbeat self-reschedules to next boundary after completion
- **heartbeat-task.AC1.3 Success:** Heartbeat self-reschedules after soft/hard errors and eviction

### heartbeat-task.AC2: Context builder
- **heartbeat-task.AC2.1 Success:** Standing instructions loaded from `_heartbeat_instructions` memory key
- **heartbeat-task.AC2.3 Success:** Pending advisory titles listed in context

### heartbeat-task.AC3: Overlap prevention
- **heartbeat-task.AC3.1 Success:** Running heartbeat blocks next claim via CAS
- **heartbeat-task.AC3.2 Success:** Stuck heartbeat evicted after 5min, rescheduled to next boundary
- **heartbeat-task.AC3.3 Success:** Multi-host cluster claims heartbeat at-least-once per interval

### heartbeat-task.AC4: Configuration and seeding
- **heartbeat-task.AC4.1 Success:** Heartbeat seeded on startup when config is absent (default enabled)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Wire heartbeat dispatch into runTask()

**Verifies:** heartbeat-task.AC2.1, heartbeat-task.AC2.3

**Files:**
- Modify: `packages/agent/src/scheduler.ts:332-598` (runTask function)
- Import: `buildHeartbeatContext` from `./heartbeat-context`

**Implementation:**

The current `runTask()` (line 332-598) inserts a user message at line 435-451 with content `task.payload ?? "Execute scheduled task."`. For heartbeat tasks, replace the static payload with the dynamically generated context.

**Step 1:** Add import at top of scheduler.ts:

```typescript
import { buildHeartbeatContext } from "./heartbeat-context";
```

**Step 2:** In `runTask()`, modify the user message content (around line 442). The current code is:

```typescript
content: task.payload ?? "Execute scheduled task.",
```

Change to:

```typescript
content: task.type === "heartbeat"
    ? buildHeartbeatContext(this.ctx.db, task.last_run_at)
    : (task.payload ?? "Execute scheduled task."),
```

This ensures heartbeat tasks get freshly built context each run, while cron/deferred/event tasks continue using their static payload.

**Step 3:** For persistent thread creation — the heartbeat task is seeded with `thread_id = null` in Phase 1. On the first run, `runTask()` already creates a thread when `task.thread_id` is null (lines 395-430). After creating it, the existing code at line 425-430 updates the task's `thread_id`:

```typescript
db.prepare("UPDATE tasks SET thread_id = ? WHERE id = ?").run(threadId, task.id);
```

Verify this existing code path works for heartbeat tasks. The thread will persist across all future heartbeat runs because:
- First run: `task.thread_id` is null -> creates thread -> updates task with new thread_id
- Subsequent runs: `task.thread_id` is set -> reuses existing thread

No additional changes needed for persistent thread behavior.

**Verification:**

```bash
tsc -p packages/agent --noEmit
```

Expected: No errors.

**Commit:** `feat(agent): wire heartbeat context builder into scheduler runTask`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add rescheduleHeartbeat() to all rescheduling paths

**Verifies:** heartbeat-task.AC1.2, heartbeat-task.AC1.3, heartbeat-task.AC3.2

**Files:**
- Modify: `packages/agent/src/scheduler.ts` (multiple locations)

**Implementation:**

The existing `rescheduleCronTask()` is called in 7 places. Each call site needs a parallel `rescheduleHeartbeat()` call. The `rescheduleHeartbeat()` function (from Phase 1) returns early if `task.type !== "heartbeat"`, so it's safe to call alongside `rescheduleCronTask()` which returns early if `task.type !== "cron"`.

**Rescheduling call sites to modify:**

1. **phase0Eviction() — line 236:** After the existing `rescheduleCronTask(db, evictedTask, logger, "heartbeat timeout eviction")` call, add:
   ```typescript
   rescheduleHeartbeat(db, evictedTask, logger, "heartbeat timeout eviction", this.lastUserInteractionAt);
   ```

2. **runTask() model validation failure — line 476:** After `rescheduleCronTask(...)`, add:
   ```typescript
   rescheduleHeartbeat(this.ctx.db, task, this.ctx.logger, "model validation failure", this.lastUserInteractionAt);
   ```

3. **runTask() soft error — line 519:** After `rescheduleCronTask(...)`, add:
   ```typescript
   rescheduleHeartbeat(this.ctx.db, task, this.ctx.logger, "soft error", this.lastUserInteractionAt);
   ```

4. **runTask() completion — line 529:** After `rescheduleCronTask(...)`, add:
   ```typescript
   rescheduleHeartbeat(this.ctx.db, task, this.ctx.logger, "completion", this.lastUserInteractionAt);
   ```

5. **runTask() hard error — line 592:** After `rescheduleCronTask(...)`, add:
   ```typescript
   rescheduleHeartbeat(this.ctx.db, task, this.ctx.logger, "hard error", this.lastUserInteractionAt);
   ```

6. **runTemplateTask() completion — line 735:** After `rescheduleCronTask(...)`, add:
   ```typescript
   rescheduleHeartbeat(this.ctx.db, task, this.ctx.logger, "template completion", this.lastUserInteractionAt);
   ```
   Note: Heartbeat tasks don't use templates, so this will be a no-op. Include for completeness.

7. **runTemplateTask() hard error — line 749:** After `rescheduleCronTask(...)`, add:
   ```typescript
   rescheduleHeartbeat(this.ctx.db, task, this.ctx.logger, "template hard error", this.lastUserInteractionAt);
   ```
   Same note: no-op for heartbeat tasks.

**Key considerations:**
- `rescheduleHeartbeat()` requires `lastUserInteractionAt` as a parameter. Since it's an instance variable on the `Scheduler` class (`this.lastUserInteractionAt`), both `phase0Eviction` and `runTask` have access to it. Verify that `runTemplateTask` also has access (it should, since it's also a method on the Scheduler class).
- **max_runs assumption:** Heartbeat tasks are seeded with `max_runs = NULL` (Phase 1 Task 5). Verify that the scheduler's completion path does NOT short-circuit rescheduling when `max_runs` is NULL. If there's a `max_runs` check that prevents rescheduling when the limit is reached, confirm that NULL means "unlimited" and always falls through to the reschedule call.

**Verification:**

```bash
tsc -p packages/agent --noEmit
```

Expected: No errors.

**Commit:** `feat(agent): add rescheduleHeartbeat to all scheduler rescheduling paths`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Add seedHeartbeat() to bootstrap sequence

**Verifies:** heartbeat-task.AC4.1

**Files:**
- Modify: `packages/cli/src/commands/start.ts:1245-1268`
- Modify: `packages/agent/src/index.ts` (if seedHeartbeat needs to be re-exported)

**Implementation:**

In `start.ts`, the cron task seeding block is at lines 1245-1268. Add heartbeat seeding immediately after the cron seeding block.

**Step 1:** Add import. The existing import from `@bound/agent` (around line 17) includes `seedCronTasks`. Add `seedHeartbeat`:

```typescript
import {
    // ... existing imports
    seedCronTasks,
    seedHeartbeat,
    // ...
} from "@bound/agent";
```

Ensure `seedHeartbeat` is exported from `packages/agent/src/index.ts`. Check if the package barrel file re-exports from `task-resolution.ts`. If `seedCronTasks` is exported there, add `seedHeartbeat` alongside it.

**Step 2:** After the cron seeding block (after line 1268), add heartbeat seeding:

```typescript
// 16b. Seed heartbeat task
{
    const cronResult = appContext.optionalConfig.cronSchedules;
    // Use Zod-inferred type for type-safe access to heartbeat config.
    // After Phase 1's schema change, cronSchedulesSchema produces:
    //   { heartbeat?: HeartbeatConfig } & Record<string, CronEntry>
    // Access .heartbeat directly from the parsed value.
    const parsed = cronResult?.ok ? cronResult.value : undefined;
    const heartbeatConfig = parsed?.heartbeat;
    try {
        seedHeartbeat(appContext.db, heartbeatConfig, appContext.siteId);
        console.log("[scheduler] Heartbeat task seeded");
    } catch (error) {
        console.warn("[scheduler] Failed to seed heartbeat:", formatError(error));
    }
}
```

Import `type { CronSchedulesConfig }` from `@bound/shared` at the top of start.ts if needed for explicit typing.

**Important:** The `cronSchedulesSchema` was changed in Phase 1 to include an optional `heartbeat` field via `.object({ heartbeat: ... }).catchall(cronEntrySchema)`. The Zod-inferred type gives direct typed access to `.heartbeat` — do NOT use unsafe cast chains like `(cronResult.value as Record<string, unknown>).heartbeat`. The executor should verify the actual inferred type and use it directly. If the config loader wraps the result in a `Result<T, E>`, the `.value` property should already carry the correct type.

**Verification:**

```bash
tsc -p packages/cli --noEmit
```

Expected: No errors.

**Commit:** `feat(cli): seed heartbeat task during bootstrap`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Integration test for full heartbeat cycle

**Verifies:** heartbeat-task.AC1.2, heartbeat-task.AC1.3, heartbeat-task.AC3.1, heartbeat-task.AC3.2, heartbeat-task.AC3.3

**Files:**
- Create: `packages/agent/src/__tests__/heartbeat-integration.test.ts`

**Implementation:**

This is the integration test that verifies the full heartbeat lifecycle: seed -> claim -> build context -> run agent loop -> reschedule. Follow the pattern from `packages/agent/src/__tests__/scheduler.integration.test.ts`.

Setup requires:
- Real SQLite database with full schema
- Mock agent loop factory (returns successfully without doing real LLM calls)
- `seedHeartbeat()` to create the task
- Scheduler instance with the mock agent loop factory

Reference: `packages/agent/src/__tests__/scheduler-features.test.ts` lines 97-108 for the mock agent loop factory pattern.

**Testing:**

Test cases:

- **Full lifecycle (AC1.2):** Seed heartbeat task. Run scheduler tick (phase1Schedule + runTask). Verify:
  - Task was claimed (status transitioned to running)
  - Agent loop was invoked (mock factory called)
  - Task was rescheduled (status back to pending, next_run_at set to next clock boundary)
  - Thread was created (thread_id populated on task)

- **Self-reschedule after error (AC1.3):** Seed heartbeat task. Configure mock agent loop to throw. Run scheduler tick. Verify:
  - Task status is "failed" (or rescheduled to pending depending on soft vs hard error)
  - next_run_at is set to next clock boundary
  - consecutive_failures incremented

- **CAS blocking (AC3.1):** Seed heartbeat task. Manually set status to "running" via direct SQL. Run phase1Schedule. Verify the task is NOT claimed (CAS WHERE status='pending' prevents it).

- **Eviction + reschedule (AC3.2):** Seed heartbeat task. Set status to "running" and heartbeat_at to > 5 minutes ago. Run phase0Eviction. Verify:
  - Task status set to "failed" then rescheduled to "pending"
  - next_run_at set to next clock boundary
  - consecutive_failures incremented

- **Context builder integration:** Seed heartbeat task. Insert a semantic_memory row with `key = '_heartbeat_instructions'`. Insert a proposed advisory. Run the heartbeat task. Verify the user message inserted into the thread contains both the standing instructions and the advisory title.

- **Persistent thread reuse:** Run heartbeat twice. Verify both runs used the same thread_id (thread created on first run, reused on second).

**Verification:**

```bash
bun test packages/agent/src/__tests__/heartbeat-integration.test.ts
```

Expected: All tests pass.

**Commit:** `test(agent): add heartbeat integration tests`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Update cron entry iteration to filter heartbeat key

**Verifies:** None (infrastructure, prevents regression in existing cron seeding)

**Files:**
- Modify: `packages/cli/src/commands/start.ts:1245-1268` (cron seeding block)

**Implementation:**

After Phase 1's schema change, `cronSchedulesSchema` now uses `.catchall()` which means the parsed config object has both the `heartbeat` key and cron entry keys at the same level. The existing cron seeding code at lines 1249-1260 iterates over ALL entries:

```typescript
const cronConfigs = Object.entries(cronSchedules).map(([name, cfg]) => ({
    name,
    cron: cfg.schedule,
    payload: cfg.payload,
}));
```

This would include the `heartbeat` key, causing `cfg.schedule` to be undefined and breaking cron seeding. Filter it out:

```typescript
const cronConfigs = Object.entries(cronSchedules)
    .filter(([name]) => name !== "heartbeat")
    .map(([name, cfg]) => ({
        name,
        cron: (cfg as CronEntry).schedule,
        payload: (cfg as CronEntry).payload,
    }));
```

Import `CronEntry` from `@bound/shared` if needed for the type cast.

**Verification:**

```bash
tsc -p packages/cli --noEmit && bun test packages/cli
```

Expected: No errors, existing cron seeding tests still pass.

**Commit:** `fix(cli): filter heartbeat key from cron schedule iteration`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Update existing cron schedule consumers

**Verifies:** None (infrastructure, prevents regression)

**Files:**
- Search for all consumers of `CronSchedulesConfig` type across the codebase

**Implementation:**

The `cronSchedulesSchema` type changed from `Record<string, CronEntry>` to `{ heartbeat?: HeartbeatConfig } & Record<string, CronEntry>`. Any code that iterates over cron entries needs to filter out the `heartbeat` key.

Search the codebase for:
1. `CronSchedulesConfig` usage
2. `optionalConfig.cronSchedules` access
3. `Object.entries` or `Object.keys` on cron schedule configs

For each consumer found, verify it either:
- Already filters by key (safe)
- Needs a `name !== "heartbeat"` filter added

**Known consumer that MUST be updated:** `packages/agent/src/scheduler.ts:682` — the `resolveTemplate()` method iterates over `cronResult.value` with `Object.entries(schedules)` to match cron task names against templates. After the Phase 1 schema change, this will iterate over the `heartbeat` key too, causing `schedule.schedule` to be `undefined` on the heartbeat config object. Add the `name !== "heartbeat"` filter here.

Search for additional consumers beyond start.ts and scheduler.ts.

**Verification:**

```bash
grep -r "CronSchedulesConfig\|cronSchedules" packages/ --include="*.ts" -l
```

Review each file and confirm no unfiltered iteration exists.

```bash
bun test --recursive
```

Expected: All tests pass.

**Commit:** `fix: filter heartbeat key from all cron schedule consumers`

(Skip commit if no changes needed beyond Task 5.)
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_C -->
