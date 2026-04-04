# Heartbeat Task Implementation Plan - Phase 4

**Goal:** Inject quiescence awareness into both heartbeat and cron task contexts when the system is idle

**Architecture:** Extracts quiescence multiplier computation from `getEffectivePollInterval()` into a reusable helper, then injects a system message into the task thread before the agent loop runs when the multiplier exceeds 1. The system message is persisted to the messages table so the agent sees it in its context window.

**Tech Stack:** TypeScript, bun:sqlite, bun:test

**Scope:** 4 phases from original design (phase 4 of 4)

**Codebase verified:** 2026-04-04

---

## Acceptance Criteria Coverage

This phase implements and tests:

### heartbeat-task.AC5: Quiescence integration
- **heartbeat-task.AC5.1 Success:** Quiescence multiplier stretches heartbeat interval (5x at 4h idle)
- **heartbeat-task.AC5.2 Success:** Quiescence note injected for heartbeat tasks when multiplier > 1
- **heartbeat-task.AC5.3 Success:** Quiescence note injected for cron tasks when multiplier > 1
- **heartbeat-task.AC5.4 Success:** No quiescence note when system is active (multiplier = 1)

---

## Important Design Note: Quiescence Tier Threshold

The current `QUIESCENCE_TIERS` constant in `scheduler.ts:63-70` has its first tier at `{ threshold: 0, multiplier: 2 }`. This means the quiescence multiplier is **always >= 2** for any idle duration (including 0ms). This conflicts with **AC5.4** ("No quiescence note when system is active, multiplier = 1"), because the multiplier can never be 1 with the current tier table.

However, the `getEffectivePollInterval()` function (line 758-783) initializes `multiplier = 1` before the tier loop, and walks tiers from highest threshold downward. With the current tier table, it always matches at threshold 0.

**For AC5.4 to work**, the quiescence note injection needs a meaningful idle threshold before considering the system "idle enough" for a note. The executor should resolve this by either:

1. **Option A (recommended):** Define a separate `QUIESCENCE_NOTE_THRESHOLD` (e.g., 1_800_000ms = 30 minutes). Only inject the note when idle duration exceeds this threshold. This preserves the existing poll interval behavior while giving the note its own activation threshold.

2. **Option B:** Change the first tier's threshold from 0 to a meaningful value (e.g., 1_800_000ms). This changes existing scheduler poll behavior — the poll interval would no longer be stretched for recently active systems. This is a behavioral change beyond the heartbeat feature scope.

The implementation below uses **Option A**.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Extract quiescence multiplier helper

**Verifies:** heartbeat-task.AC5.1, heartbeat-task.AC5.4

**Files:**
- Modify: `packages/agent/src/scheduler.ts` (near `getEffectivePollInterval` at line 758-783)

**Implementation:**

Extract the multiplier computation from `getEffectivePollInterval()` into a reusable function. The existing function (lines 758-783) computes the multiplier as a local variable, then returns `POLL_INTERVAL * multiplier`. Extract the multiplier computation so it can be reused for note injection.

Add a new function near `getEffectivePollInterval()`:

```typescript
/**
 * Compute quiescence multiplier based on idle duration.
 * Returns the multiplier from QUIESCENCE_TIERS based on how long
 * the system has been idle.
 */
function computeQuiescenceMultiplier(lastUserInteractionAt: Date): number {
	const inactivityMs = Date.now() - lastUserInteractionAt.getTime();
	let multiplier = 1;
	for (let i = QUIESCENCE_TIERS.length - 1; i >= 0; i--) {
		const tier = QUIESCENCE_TIERS[i];
		if (inactivityMs >= tier.threshold) {
			multiplier = tier.multiplier;
			break;
		}
	}
	return multiplier;
}
```

**Also refactor `rescheduleHeartbeat()`** (from Phase 1 Task 3) to use this shared helper. The Phase 1 implementation contains an inline quiescence computation that must be replaced:

```typescript
// In rescheduleHeartbeat(), replace the inline tier iteration with:
const multiplier = computeQuiescenceMultiplier(lastUserInteractionAt);
```

This eliminates the duplicated quiescence logic between `rescheduleHeartbeat` and `getEffectivePollInterval`.

Then refactor `getEffectivePollInterval()` to use it:

```typescript
getEffectivePollInterval(): number {
	// Check if any pending tasks have no_quiescence set
	const noQuiescenceTasks = this.ctx.db
		.query("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending' AND no_quiescence = 1")
		.get() as { count: number } | null;

	if (noQuiescenceTasks && noQuiescenceTasks.count > 0) {
		return POLL_INTERVAL;
	}

	const multiplier = computeQuiescenceMultiplier(this.lastUserInteractionAt);
	return POLL_INTERVAL * multiplier;
}
```

Also define the note threshold constant:

```typescript
/** Minimum idle duration before quiescence note is injected into task context. */
const QUIESCENCE_NOTE_THRESHOLD = 1_800_000; // 30 minutes
```

**Verification:**

```bash
tsc -p packages/agent --noEmit && bun test packages/agent/src/__tests__/scheduler-features.test.ts
```

Expected: No errors, existing scheduler tests still pass (refactoring only, no behavior change).

**Commit:** `refactor(agent): extract computeQuiescenceMultiplier helper`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Inject quiescence note in runTask()

**Verifies:** heartbeat-task.AC5.2, heartbeat-task.AC5.3, heartbeat-task.AC5.4

**Files:**
- Modify: `packages/agent/src/scheduler.ts` (in `runTask()`, before agent loop creation around line 481)

**Implementation:**

In `runTask()`, after the user message insertion (around line 451) and before the agent loop creation (around line 481), add quiescence note injection for both heartbeat and cron tasks.

The note is injected as a system message in the task's thread. Context assembly automatically loads all messages from the thread, so the agent will see it.

```typescript
// Inject quiescence note for scheduled tasks when system is idle
if (task.type === "heartbeat" || task.type === "cron") {
	const idleMs = Date.now() - this.lastUserInteractionAt.getTime();
	if (idleMs >= QUIESCENCE_NOTE_THRESHOLD) {
		const multiplier = computeQuiescenceMultiplier(this.lastUserInteractionAt);
		const idleDuration = formatIdleDuration(idleMs);

		let baseInterval: string;
		let effectiveInterval: string;
		if (task.type === "heartbeat") {
			try {
				const spec = JSON.parse(task.trigger_spec);
				const baseMs = spec.interval_ms ?? 1_800_000;
				baseInterval = `${Math.round(baseMs / 60_000)}min`;
				effectiveInterval = `${Math.round((baseMs * multiplier) / 60_000)}min`;
			} catch {
				baseInterval = "30min";
				effectiveInterval = `${30 * multiplier}min`;
			}
		} else {
			// Cron tasks don't have a simple interval, use the schedule expression
			baseInterval = task.trigger_spec;
			effectiveInterval = `schedule stretched by ${multiplier}x`;
		}

		const quiescenceNote = `[System note: Quiescence is active (idle ${idleDuration}). Task intervals are stretched by ${multiplier}x. Normal interval: ${baseInterval}, effective: ${effectiveInterval}.]`;

		insertRow(
			this.ctx.db,
			"messages",
			{
				id: randomUUID(),
				thread_id: threadId,
				role: "system",
				content: quiescenceNote,
				model_id: null,
				tool_name: null,
				created_at: taskNow,
				modified_at: taskNow,
				host_origin: this.ctx.hostName,
				deleted: 0,
			},
			this.ctx.siteId,
		);
	}
}
```

Also add the `formatIdleDuration` helper near the quiescence functions:

```typescript
function formatIdleDuration(ms: number): string {
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}
```

**Key design decisions:**
- The note is a `role: "system"` message, persisted to the database. It will appear in the agent's context alongside the user message.
- The `QUIESCENCE_NOTE_THRESHOLD` (30 minutes) ensures AC5.4: recently active systems (< 30 min idle) don't get the note. This is separate from the `QUIESCENCE_TIERS` threshold 0 which always applies to poll interval stretching.
- For cron tasks, the "effective interval" description is less precise since cron uses expressions not fixed intervals. The note mentions the multiplier instead.
- The note is injected AFTER the user message so it appears as context for the agent, not as the primary input.
- **Intentional persistence:** The quiescence note is persisted via `insertRow()` (with changelog entry) rather than volatile context. This creates a durable record of quiescence state visible in the thread history and synced across hosts. The minor storage/sync overhead is acceptable given heartbeat frequency. If storage becomes a concern, consider switching to volatile context injection in `context-assembly.ts` (non-persisted, assembled fresh each turn).

**Verification:**

```bash
tsc -p packages/agent --noEmit
```

Expected: No errors.

**Commit:** `feat(agent): inject quiescence note for scheduled tasks`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Tests for quiescence note injection

**Verifies:** heartbeat-task.AC5.2, heartbeat-task.AC5.3, heartbeat-task.AC5.4

**Files:**
- Create: `packages/agent/src/__tests__/quiescence-note.test.ts`

**Implementation:**

Tests verify that the quiescence note is correctly injected (or not injected) based on idle duration. Use real SQLite databases following the existing test patterns.

Since the note injection happens inside `runTask()` (a method on the Scheduler class), tests need to either:
1. Use the full Scheduler with a mock agent loop factory (integration-style, like `scheduler-features.test.ts`)
2. Extract the note injection logic into a testable function and test it directly

The executor should choose the approach that best matches existing test patterns. Option 1 is more realistic; option 2 is more targeted.

**Testing:**

Test cases:

- **heartbeat-task.AC5.2** (heartbeat quiescence note): Set `lastUserInteractionAt` to 2 hours ago. Seed a heartbeat task. Run the scheduler tick. Query messages for the heartbeat thread. Verify a system message exists containing `"Quiescence is active"`, the multiplier value, and the interval values.

- **heartbeat-task.AC5.3** (cron quiescence note): Set `lastUserInteractionAt` to 2 hours ago. Seed a cron task with a known schedule. Run the scheduler tick. Query messages for the cron thread. Verify a system message exists containing `"Quiescence is active"` and the multiplier.

- **heartbeat-task.AC5.4** (no note when active): Set `lastUserInteractionAt` to 5 minutes ago (below QUIESCENCE_NOTE_THRESHOLD of 30 minutes). Seed a heartbeat task. Run the scheduler tick. Query messages for the thread. Verify NO system message with `"Quiescence is active"` exists.

- **Multiplier accuracy**: Set `lastUserInteractionAt` to 5 hours ago (tier 2: multiplier 5x). Verify the note contains `"5x"` and the correct effective interval (e.g., 150min for a 30min heartbeat).

- **Format idle duration**: Test the helper: 30 minutes -> "30m", 2 hours 15 minutes -> "2h 15m", 0 minutes -> "0m".

- **computeQuiescenceMultiplier unit tests**: Test each tier boundary:
  - 0ms idle -> multiplier 2 (tier 0)
  - 1h idle -> multiplier 3 (tier 1)
  - 4h idle -> multiplier 5 (tier 2)
  - 12h idle -> multiplier 10 (tier 3)
  - 30 min idle -> multiplier 2 (still tier 0)

**Verification:**

```bash
bun test packages/agent/src/__tests__/quiescence-note.test.ts
```

Expected: All tests pass.

**Commit:** `test(agent): add quiescence note injection tests`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Verify AC5.1 — quiescence stretches heartbeat interval

**Verifies:** heartbeat-task.AC5.1

**Files:**
- Modify: `packages/agent/src/__tests__/heartbeat-scheduling.test.ts` (add to existing tests from Phase 1)

**Implementation:**

AC5.1 specifically verifies that the quiescence multiplier stretches the heartbeat interval. This was partially tested in Phase 1's `rescheduleHeartbeat` tests, but now that the full pipeline is wired (Phase 3), add an end-to-end test.

**Testing:**

Test case:
- Seed a heartbeat task with `interval_ms = 1_800_000` (30min). Set `lastUserInteractionAt` to 5 hours ago (tier 2, multiplier 5x). Run the heartbeat task through the scheduler. After completion, verify `next_run_at` is clock-aligned to a 150-minute boundary (30min * 5x = 150min = 2.5h).

This test may already exist from Phase 1. If so, verify it covers the quiescence interaction. If not, add it.

**Verification:**

```bash
bun test packages/agent/src/__tests__/heartbeat-scheduling.test.ts
```

Expected: All tests pass.

**Commit:** `test(agent): verify quiescence stretches heartbeat interval end-to-end`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->
