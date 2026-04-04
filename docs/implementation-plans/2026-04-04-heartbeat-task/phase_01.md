# Heartbeat Task Implementation Plan - Phase 1

**Goal:** Add heartbeat trigger type, clock-aligned rescheduling, and startup seeding

**Architecture:** Extends the existing task system with a new `"heartbeat"` trigger type. Uses clock-aligned interval math (modulo arithmetic) instead of cron expressions. Reuses existing CAS claiming and quiescence infrastructure. Heartbeat config lives in `cron_schedules.json` as a dedicated section alongside cron entries.

**Tech Stack:** TypeScript, bun:sqlite, Zod v4, bun:test

**Scope:** 4 phases from original design (phase 1 of 4)

**Codebase verified:** 2026-04-04

---

## Acceptance Criteria Coverage

This phase implements and tests:

### heartbeat-task.AC1: Heartbeat scheduling
- **heartbeat-task.AC1.1 Success:** Heartbeat fires at clock-aligned boundaries (30min interval -> :00, :30)
- **heartbeat-task.AC1.2 Success:** Heartbeat self-reschedules to next boundary after completion
- **heartbeat-task.AC1.3 Success:** Heartbeat self-reschedules after soft/hard errors and eviction
- **heartbeat-task.AC1.4 Success:** Arbitrary intervals work (15min, 45min, 2h)
- **heartbeat-task.AC1.5 Failure:** Invalid interval_ms (0, negative) rejected at config validation

### heartbeat-task.AC3: Overlap prevention
- **heartbeat-task.AC3.1 Success:** Running heartbeat blocks next claim via CAS
- **heartbeat-task.AC3.2 Success:** Stuck heartbeat evicted after 5min, rescheduled to next boundary

### heartbeat-task.AC4: Configuration and seeding
- **heartbeat-task.AC4.1 Success:** Heartbeat seeded on startup when config is absent (default enabled)
- **heartbeat-task.AC4.2 Success:** Heartbeat seeded with custom interval_ms from config
- **heartbeat-task.AC4.3 Success:** Seeding is idempotent (no duplicate heartbeat tasks created)
- **heartbeat-task.AC4.4 Success:** `heartbeat.enabled: false` prevents seeding

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add "heartbeat" to TaskType union

**Verifies:** None (type system, verified by compiler)

**Files:**
- Modify: `packages/shared/src/types.ts:10`

**Implementation:**

At line 10, the current `TaskType` union is:

```typescript
export type TaskType = "cron" | "deferred" | "event";
```

Change to:

```typescript
export type TaskType = "cron" | "deferred" | "event" | "heartbeat";
```

**Verification:**

```bash
tsc -p packages/shared --noEmit
```

Expected: No errors.

**Commit:** `feat(shared): add heartbeat to TaskType union`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add heartbeat config schema

**Verifies:** heartbeat-task.AC1.5

**Files:**
- Modify: `packages/shared/src/config-schemas.ts:209-221`

**Implementation:**

Add a new `heartbeatConfigSchema` export above the existing `cronSchedulesSchema` definition (before line 209):

```typescript
export const heartbeatConfigSchema = z.object({
	enabled: z.boolean().default(true),
	interval_ms: z
		.number()
		.int()
		.min(60_000, "Heartbeat interval must be at least 60 seconds")
		.default(1_800_000),
});

export type HeartbeatConfig = z.infer<typeof heartbeatConfigSchema>;
```

Then modify `cronSchedulesSchema` from its current `z.record(...)` form to an object that wraps both heartbeat config and cron entries. The current definition (lines 209-221) is:

```typescript
export const cronSchedulesSchema = z.record(
	z.string(),
	z.object({
		schedule: z.string().min(1),
		thread: z.string().optional(),
		payload: z.string().optional(),
		template: z.array(z.string()).optional(),
		requires: z.array(z.string()).optional(),
		model_hint: z.string().optional(),
	}),
);
```

Extract the cron entry schema and restructure:

```typescript
export const cronEntrySchema = z.object({
	schedule: z.string().min(1),
	thread: z.string().optional(),
	payload: z.string().optional(),
	template: z.array(z.string()).optional(),
	requires: z.array(z.string()).optional(),
	model_hint: z.string().optional(),
});

export type CronEntry = z.infer<typeof cronEntrySchema>;

export const cronSchedulesSchema = z
	.object({
		heartbeat: heartbeatConfigSchema.optional(),
	})
	.catchall(cronEntrySchema);
```

This preserves backward compatibility: existing `cron_schedules.json` files with no `heartbeat` key still validate. The `catchall` handles all other keys as cron entries.

**Important:** The return type of `cronSchedulesSchema` changes from `Record<string, CronEntry>` to `{ heartbeat?: HeartbeatConfig } & Record<string, CronEntry>`. Any code iterating over cron entries must now filter out the `heartbeat` key. Check existing consumers of `CronSchedulesConfig` and update them to skip the `heartbeat` key when iterating.

**Testing:**

Tests must verify:
- heartbeat-task.AC1.5: `interval_ms: 0` rejected, `interval_ms: -1` rejected, `interval_ms: 59_999` rejected (below 60s minimum)
- Valid config with `interval_ms: 1_800_000` parses successfully
- Missing heartbeat key defaults to `{ enabled: true, interval_ms: 1_800_000 }`
- `heartbeat: { enabled: false }` parses successfully
- Existing cron entries still validate alongside heartbeat config

Test file: `packages/shared/src/__tests__/config-schemas.test.ts` (create if needed, or add to existing test file for config schemas)

Follow existing test patterns: `bun:test` with `describe/it/expect`.

**Verification:**

```bash
tsc -p packages/shared --noEmit && bun test packages/shared
```

Expected: Typecheck clean, all tests pass.

**Commit:** `feat(shared): add heartbeat config schema to cron_schedules`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Implement rescheduleHeartbeat()

**Verifies:** heartbeat-task.AC1.1, heartbeat-task.AC1.2, heartbeat-task.AC1.3, heartbeat-task.AC1.4

**Files:**
- Modify: `packages/agent/src/scheduler.ts` (add new function near `rescheduleCronTask` at line 38-58)

**Implementation:**

Add `rescheduleHeartbeat()` as a sibling to the existing `rescheduleCronTask()` function (around line 60, after `rescheduleCronTask` ends). The function follows the same pattern but uses clock-aligned interval math instead of cron expressions.

```typescript
function rescheduleHeartbeat(
	db: AppContext["db"],
	task: Task,
	logger: AppContext["logger"],
	context: string,
	lastUserInteractionAt: Date,
): void {
	if (task.type !== "heartbeat") return;

	let intervalMs: number;
	try {
		const spec = JSON.parse(task.trigger_spec);
		intervalMs = spec.interval_ms;
		if (!intervalMs || intervalMs < 60_000) {
			logger.error(`[@bound/agent/scheduler] Invalid heartbeat interval_ms: ${intervalMs}`);
			return;
		}
	} catch {
		logger.error(
			`[@bound/agent/scheduler] Failed to parse heartbeat trigger_spec: ${task.trigger_spec}`,
		);
		return;
	}

	// Compute quiescence multiplier using the same backward-iteration pattern
	// as getEffectivePollInterval(). Phase 4 extracts this into a shared
	// computeQuiescenceMultiplier() helper — when that happens, replace this
	// inline computation with a call to the shared helper.
	const now = Date.now();
	const idleDuration = now - lastUserInteractionAt.getTime();
	let multiplier = 1;
	for (let i = QUIESCENCE_TIERS.length - 1; i >= 0; i--) {
		const tier = QUIESCENCE_TIERS[i];
		if (idleDuration >= tier.threshold) {
			multiplier = tier.multiplier;
			break;
		}
	}

	const effectiveInterval = intervalMs * multiplier;
	const nextBoundary = Math.ceil(now / effectiveInterval) * effectiveInterval;
	const nextRunAt = new Date(nextBoundary).toISOString();

	db.prepare("UPDATE tasks SET next_run_at = ?, status = 'pending' WHERE id = ?").run(
		nextRunAt,
		task.id,
	);

	logger.info(
		`[@bound/agent/scheduler] Rescheduled heartbeat (${context}): next_run_at=${nextRunAt}, multiplier=${multiplier}x, effective_interval=${effectiveInterval}ms`,
	);
}
```

Key design decisions:
- Uses the same backward-iteration pattern as `getEffectivePollInterval()` (line 772-780) for consistency. Phase 4 will extract this into a shared `computeQuiescenceMultiplier()` helper — **Phase 4 Task 1 MUST also refactor this function to use the shared helper** to avoid duplicated logic.
- Clock-aligned boundary: `Math.ceil(now / effectiveInterval) * effectiveInterval` ensures clean boundaries
- Uses direct `db.prepare().run()` (not `updateRow()`) because scheduler rescheduling is a local operation (same pattern as `rescheduleCronTask`)
- The function needs `lastUserInteractionAt` as a parameter since it's an instance variable on the Scheduler class
- **Note on quiescence multiplier range:** With the current `QUIESCENCE_TIERS` (threshold 0 = multiplier 2), the minimum multiplier is always 2, never 1. This is the existing scheduler behavior.

Also export `rescheduleHeartbeat` so it can be called from `phase0Eviction` and `runTask`. If the existing `rescheduleCronTask` is not exported, follow the same visibility pattern. Currently `rescheduleCronTask` is a module-level function (not exported, not a class method) — make `rescheduleHeartbeat` the same.

**Verification:**

```bash
tsc -p packages/agent --noEmit
```

Expected: No errors.

**Commit:** `feat(agent): add rescheduleHeartbeat with clock-aligned scheduling`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Tests for rescheduleHeartbeat

**Verifies:** heartbeat-task.AC1.1, heartbeat-task.AC1.2, heartbeat-task.AC1.3, heartbeat-task.AC1.4, heartbeat-task.AC3.2

**Files:**
- Create: `packages/agent/src/__tests__/heartbeat-scheduling.test.ts`

**Implementation:**

To test `rescheduleHeartbeat()`, it needs to be testable. Since it's a module-level function in scheduler.ts (not exported), there are two approaches:
1. Export it (preferred if other functions like `rescheduleCronTask` are exported)
2. Test indirectly through scheduler integration

Check whether `rescheduleCronTask` is exported. If not, export both. If there's a pattern of keeping scheduler internals private, test through the public Scheduler class API instead.

**Testing:**

Tests must verify each AC using a real SQLite database (not mocks). Follow the pattern from `packages/agent/src/__tests__/scheduler-features.test.ts`:

```typescript
import { createDatabase } from "@bound/core";
import { applySchema } from "@bound/core";
```

Create a task row in the DB with `type = "heartbeat"` and `trigger_spec = '{"type":"heartbeat","interval_ms":1800000}'`, then call `rescheduleHeartbeat()` and verify the resulting `next_run_at` and `status`.

Test cases:
- **heartbeat-task.AC1.1** (clock alignment): Given `interval_ms = 1_800_000` (30min) and current time of 14:17, `next_run_at` should be 14:30. Use a fixed `now` value (mock `Date.now()` or pass it as a parameter) to make tests deterministic.
- **heartbeat-task.AC1.2** (self-reschedule after completion): After calling rescheduleHeartbeat, task status should be "pending" and next_run_at should be the next clock-aligned boundary.
- **heartbeat-task.AC1.3** (reschedule after errors/eviction): Same behavior — status reset to "pending", next_run_at set to next boundary. Test with task in "failed" status.
- **heartbeat-task.AC1.4** (arbitrary intervals): Test with 15min (900_000ms), 45min (2_700_000ms), 2h (7_200_000ms). Verify clock alignment for each.
- **heartbeat-task.AC3.2** (eviction reschedule): After rescheduleHeartbeat is called on an evicted task, next_run_at is set to next boundary (not immediate).

Quiescence tests:
- With `lastUserInteractionAt` 30 minutes ago (tier 0, multiplier 2x): 30min interval becomes 60min effective, boundaries at :00.
- With `lastUserInteractionAt` 2 hours ago (tier 1, multiplier 3x): 30min becomes 90min.
- With `lastUserInteractionAt` 5 hours ago (tier 2, multiplier 5x): 30min becomes 150min.
- **Important:** With the current `QUIESCENCE_TIERS` (threshold 0, multiplier 2), the minimum quiescence multiplier is **always 2, never 1** — even for a just-now interaction. Do NOT write tests expecting multiplier=1. The initial `let multiplier = 1` in the loop is dead code with the current tier table. Verify that a "just now" interaction produces multiplier=2 and effective interval of 60min (for 30min base).

Edge cases:
- Invalid trigger_spec JSON: function should log error and return without updating
- Non-heartbeat task type: function should return early without updating

**Verification:**

```bash
bun test packages/agent/src/__tests__/heartbeat-scheduling.test.ts
```

Expected: All tests pass.

**Commit:** `test(agent): add heartbeat clock-aligned scheduling tests`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Implement seedHeartbeat()

**Verifies:** heartbeat-task.AC4.1, heartbeat-task.AC4.2, heartbeat-task.AC4.3, heartbeat-task.AC4.4

**Files:**
- Modify: `packages/agent/src/task-resolution.ts` (add new function near `seedCronTasks` at line 226-280)

**Implementation:**

Add `seedHeartbeat()` following the exact pattern of `seedCronTasks()` (line 226-280). Key reference points from the existing code:

- `seedCronTasks` uses `INSERT OR IGNORE` with `deterministicUUID(BOUND_NAMESPACE, "cron-${config.name}")`
- It populates all 30 columns of the tasks table
- It computes initial `next_run_at`

```typescript
export function seedHeartbeat(
	db: Database,
	heartbeatConfig: HeartbeatConfig | undefined,
	siteId: string,
): void {
	// Default: enabled with 30min interval
	const config = heartbeatConfig ?? { enabled: true, interval_ms: 1_800_000 };

	if (!config.enabled) return;

	const id = deterministicUUID(BOUND_NAMESPACE, "heartbeat");
	const now = new Date();
	const intervalMs = config.interval_ms;
	const nextBoundary = Math.ceil(now.getTime() / intervalMs) * intervalMs;
	const nextRunAt = new Date(nextBoundary).toISOString();
	const triggerSpec = JSON.stringify({ type: "heartbeat", interval_ms: intervalMs });

	db.prepare(
		`INSERT OR IGNORE INTO tasks (
			id, type, status, trigger_spec, payload, created_at, created_by,
			thread_id, claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
			run_count, max_runs, requires, model_hint, no_history, inject_mode,
			depends_on, require_success, alert_threshold, consecutive_failures,
			event_depth, no_quiescence, heartbeat_at, result, error, modified_at, deleted
		) VALUES (
			?, 'heartbeat', 'pending', ?, NULL, ?, 'system',
			NULL, NULL, NULL, NULL, ?, NULL,
			0, NULL, NULL, NULL, 0, 'status',
			NULL, 0, 5, 0,
			0, 0, NULL, NULL, NULL, ?, 0
		)`,
	).run(id, triggerSpec, now.toISOString(), nextRunAt, now.toISOString());
}
```

Key design decisions:
- Deterministic UUID uses `"heartbeat"` key (single heartbeat task, not per-name)
- `INSERT OR IGNORE` ensures idempotent seeding (AC4.3)
- `thread_id` is NULL initially — Phase 3 creates the persistent thread during scheduler integration
- `no_quiescence = 0` — heartbeat respects quiescence (the rescheduling function handles stretching)
- `alert_threshold = 5` — same default as cron tasks
- When `heartbeatConfig` is undefined (config absent), defaults to enabled with 30min interval (AC4.1)
- When `config.enabled === false`, returns early without seeding (AC4.4)

**Sync implications of direct SQL:** This uses `INSERT OR IGNORE` (direct SQL, not `insertRow()`) following the same pattern as `seedCronTasks()`. `insertRow()` does not support `OR IGNORE` semantics needed for idempotent seeding. Consequence: the heartbeat task row will NOT have a changelog entry, so it will NOT sync to other hosts via the change-log outbox. In a multi-host cluster, **each host seeds its own heartbeat task locally**. This is the intended behavior — each host runs its own scheduler and seeds its own tasks. The existing CAS claiming pattern ensures only one host executes the heartbeat at any given time (AC3.1, AC3.3).

Import `HeartbeatConfig` from `@bound/shared` at the top of the file.

**Verification:**

```bash
tsc -p packages/agent --noEmit
```

Expected: No errors.

**Commit:** `feat(agent): add seedHeartbeat for startup heartbeat seeding`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Tests for seedHeartbeat

**Verifies:** heartbeat-task.AC4.1, heartbeat-task.AC4.2, heartbeat-task.AC4.3, heartbeat-task.AC4.4, heartbeat-task.AC3.1

**Files:**
- Create: `packages/agent/src/__tests__/heartbeat-seeding.test.ts`

**Implementation:**

Follow the same database test pattern as other agent tests. Create a temp SQLite database, apply schema, call `seedHeartbeat()`, and verify task state via direct DB queries.

**Testing:**

Test cases:
- **heartbeat-task.AC4.1** (default seeding): Call `seedHeartbeat(db, undefined, siteId)`. Verify a task row exists with `type = "heartbeat"`, `status = "pending"`, `trigger_spec` containing `interval_ms: 1_800_000`, and `next_run_at` set to a clock-aligned boundary.
- **heartbeat-task.AC4.2** (custom interval): Call `seedHeartbeat(db, { enabled: true, interval_ms: 900_000 }, siteId)`. Verify `trigger_spec` contains `interval_ms: 900_000`.
- **heartbeat-task.AC4.3** (idempotency): Call `seedHeartbeat` twice with the same config. Verify only one task row exists (count tasks with `type = "heartbeat"`).
- **heartbeat-task.AC4.4** (disabled): Call `seedHeartbeat(db, { enabled: false, interval_ms: 1_800_000 }, siteId)`. Verify no heartbeat task row exists.
- **heartbeat-task.AC3.1** (CAS blocking): Seed a heartbeat task, manually UPDATE its status to "running". Call `phase1Schedule` or simulate the CAS claim query. Verify the running task is NOT re-claimed (the CAS `WHERE status = 'pending'` prevents it).

Additional tests:
- Verify deterministic UUID: calling seedHeartbeat with different configs produces the same task ID (same `deterministicUUID(BOUND_NAMESPACE, "heartbeat")` key).
- Verify `next_run_at` is clock-aligned: for a 30min interval, the next_run_at should be at a :00 or :30 boundary.
- Verify `created_by = "system"` and other default field values.

**Verification:**

```bash
bun test packages/agent/src/__tests__/heartbeat-seeding.test.ts
```

Expected: All tests pass.

**Commit:** `test(agent): add heartbeat seeding tests`
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_C -->
