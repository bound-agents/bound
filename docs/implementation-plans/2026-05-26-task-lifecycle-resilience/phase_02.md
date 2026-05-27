# Phase 2: Bootstrap Scoping + Sync `heartbeat_at` + Sync `rescheduleHeartbeat` (R-LR10 + R-LR1 + R-LR11)

**Goal:** Land three batched changes from RFC §4.1: scope the bootstrap crash-recovery reset to `claimed_by = ?siteId` (R-LR10), route the two `tasks.heartbeat_at` refresh sites through the change-log outbox (R-LR1), and route `rescheduleHeartbeat`'s writes through the outbox at all five call sites (R-LR11). Per RFC §4.1, R-LR10 must land before or with R-LR1 to prevent cross-host bootstrap resets once `heartbeat_at` becomes synced.

**Architecture:** Three changes share the same shape: convert raw outbox-exempt SQL to outbox-routed writes via existing `updateRow` (`@bound/core`). The bootstrap reset gains a `claimed_by = ?siteId` predicate; the two refresh sites at `scheduler.ts:545-551` and `scheduler.ts:1224-1228` go from raw UPDATE to `updateRow(..., { heartbeat_at }, siteId)`; `rescheduleHeartbeat` body at `scheduler.ts:277-317` switches from raw UPDATE to `updateRow`, and the helper signature gains `siteId`. All five call sites of `rescheduleHeartbeat` (post-completion, soft-error reschedule, hard-error reschedule, eviction recovery, and the stuck-row healer's heartbeat dispatch) thread `siteId`.

**Tech Stack:** TypeScript, `bun:sqlite`, `@bound/core` outbox helpers (`updateRow`), the LWW reducer in `packages/sync/src/reducers.ts`, `bun:test`.

**Scope:** 1 phase from a 5-phase RFC implementation (Phase 2 of 5). Per RFC §4.1, this batch ships after Phase 1 (R-LR4) and before Phase 3 (R-LR3) and Phase 4 (R-LR2).

**Codebase verified:** 2026-05-26 via codebase-investigator. Key facts:
- Bootstrap reset SQL is exported as `STALE_TASK_RESET_SQL` at `packages/cli/src/commands/start/bootstrap.ts:61-62` and invoked at line 417 with `appContext.siteId` available in scope. Current SQL does NOT include `claimed_by = ?siteId`.
- Timer-driven `heartbeat_at` refresh: `scheduler.ts:545-551` inside `private refreshHeartbeats()`. Current annotation: `// outbox-exempt: heartbeat_at is local-only state, not synced` (line 549).
- Activity-driven `heartbeat_at` refresh: `scheduler.ts:1224-1228` inside `private runTask()` callback (`onActivity`). Same annotation text (line 1226).
- Running-transition CAS at `scheduler.ts:798-813` already emits a change_log entry that includes `heartbeat_at` — UNAFFECTED by R-LR1's mechanics, but R-LR5 in Phase 5 rewrites the (correct but easy-to-misread) annotation.
- `rescheduleHeartbeat` at `scheduler.ts:277-317`. Body uses raw outbox-exempt SQL at line 311. Signature: `rescheduleHeartbeat(db, task, logger, context, lastUserInteractionAt)`. Writes `next_run_at`, `status='pending'`, optional `error=''` when `context==='completion'`.
- **Five** call sites of `rescheduleHeartbeat` (RFC §3.1 R-LR11 says three; investigator found five): line 363 (in `healStuckHeartbeats`/`healStuckTasks`), line 661 (eviction recovery), line 1174 (model-validation reschedule — RFC's "hard-error" approximation), line 1322 (soft-error reschedule), line 1384 (post-completion). All five except line 363 have `this.ctx.siteId` already in scope (Scheduler instance methods); line 363 is in the exported helper from Phase 1, which now takes `siteId` as a parameter (per Phase 1 Task 2).
- `tasks` is `lww` in `TABLE_REDUCER_MAP` at `packages/shared/src/types.ts`. `updateRow` auto-injects `modified_at` so close-in-time refreshes resolve LWW correctly. Confirmed.
- `updateRow` signature in `packages/core/src/change-log.ts:158-198`: `updateRow<T>(db, table, id, updates: Partial<Row>, siteId): void`. Emits exactly one change_log entry per call. ✓

**Three RFC text divergences to follow during implementation:**
1. **Five call sites, not three.** RFC R-LR11 says "post-completion, eviction recovery, and hard-error rescheduling" — investigator found five (the three named plus model-validation reschedule plus soft-error reschedule plus the stuck-row healer's heartbeat branch from Phase 1). All five must thread `siteId`. The implementation MUST update all five.
2. **`rescheduleHeartbeat` callable from outside the Scheduler class.** Phase 1's `healStuckTasks` is an exported function that calls `rescheduleHeartbeat`. After R-LR11, `rescheduleHeartbeat` requires `siteId`; `healStuckTasks` already takes `siteId` as a parameter (per Phase 1 Task 2). Phase 2 threads it.
3. **Bootstrap reset comment.** Current annotation `// outbox-exempt: crash recovery` (bootstrap.ts:62) remains technically accurate even after scoping (the SQL is still outbox-exempt — crash recovery is justified). R-LR10 narrows the WHERE clause; R-LR5 in Phase 5 may refine the comment. Phase 2 leaves the annotation alone (Phase 5 owns annotation rewrites).

---

## Acceptance Criteria Coverage

This phase implements and tests:

### task-lifecycle-resilience.AC1: heartbeat_at writes sync via outbox (R-LR1)

- **task-lifecycle-resilience.AC1.1 Success.** Given a running task on host A with a fresh lease, when the timer-driven heartbeat refresh fires, then a change_log entry is generated containing the new `heartbeat_at` value, and host B's `tasks.heartbeat_at` reflects the value after one sync RTT.
- **task-lifecycle-resilience.AC1.2 Success.** Given two close-in-time heartbeat refreshes on host A, when both change_log entries replicate to host B, then host B's row reflects the later `heartbeat_at` value (LWW resolution).

### task-lifecycle-resilience.AC10: bootstrap scoped to local rows (R-LR10)

- **task-lifecycle-resilience.AC10.1 Success.** Given two running rows with stale `heartbeat_at`, one owned by `?siteId` and one owned by a peer, when the bootstrap reset SQL runs with `?siteId` bound, then only the local row's `status` is reset to `pending`. The peer-owned row is unmodified.

### task-lifecycle-resilience.AC11: heartbeat reschedule sync (R-LR11)

- **task-lifecycle-resilience.AC11.1 Success.** Given a heartbeat task that completes successfully, then `rescheduleHeartbeat` writes through the outbox and produces one change_log entry. Verified at all three call sites: post-completion, eviction recovery, hard-error reschedule.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Scope bootstrap reset to `claimed_by = ?siteId` (R-LR10)

**Verifies:** task-lifecycle-resilience.AC10.1.

**Files:**
- Modify: `packages/cli/src/commands/start/bootstrap.ts:61-62` (the exported `STALE_TASK_RESET_SQL` constant)
- Modify: `packages/cli/src/commands/start/bootstrap.ts:417` (the call site that runs the SQL)

**Implementation:**

Update the exported constant. Current at lines 61-62:

```typescript
export const STALE_TASK_RESET_SQL = `UPDATE tasks SET status = 'pending', lease_id = NULL, claimed_by = NULL, claimed_at = NULL WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)`; // outbox-exempt: crash recovery
```

Change to:

```typescript
export const STALE_TASK_RESET_SQL = `UPDATE tasks SET status = 'pending', lease_id = NULL, claimed_by = NULL, claimed_at = NULL WHERE status = 'running' AND claimed_by = ? AND (heartbeat_at IS NULL OR heartbeat_at < ?)`; // outbox-exempt: crash recovery, scoped to booting host (R-LR10)
```

The new bind ORDER is `(siteId, staleThreshold)` — note the order matters for the `db.prepare(...).run(...)` call site. Update the call at `bootstrap.ts:417`: pass `appContext.siteId` as the first parameter and the existing stale threshold as the second.

The R-LR1 batch makes `heartbeat_at` synced — without R-LR10's siteId scoping, a single host's bootstrap could reset healthy peer-claimed rows if its sync is behind the lease-holder's recent refreshes. Scoping to `claimed_by = ?siteId` makes the reset locally correct regardless of `heartbeat_at` freshness from peers.

**Testing:**

Tests must verify each AC listed above. Test file: extend `packages/cli/src/__tests__/startup-wiring.test.ts` if it covers the bootstrap reset, OR create `packages/cli/src/__tests__/bootstrap-stale-reset.test.ts`.

- **AC10.1.** Insert two `running` rows in a fresh test DB:
  - Row A: `claimed_by = "site-local"`, `heartbeat_at = ISO(now - 30min)` (stale).
  - Row B: `claimed_by = "site-peer"`, `heartbeat_at = ISO(now - 30min)` (stale).
  Run `db.prepare(STALE_TASK_RESET_SQL).run("site-local", ISO(now - 10min))`.
  Assert row A's `status === "pending"` AND `claimed_by === null`; assert row B unchanged (`status === "running"`, `claimed_by === "site-peer"`).

**Verification:**

```bash
bun run typecheck
bun test packages/cli/src/__tests__/  # whichever file holds the AC10.1 test
```

**Commit:**
```bash
git add packages/cli/src/commands/start/bootstrap.ts packages/cli/src/__tests__/<file>
git commit -m "fix(cli): scope bootstrap stale-task reset to local site (R-LR10)"
```
<!-- END_TASK_1 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 2-3) -->

<!-- START_TASK_2 -->
### Task 2: Route `heartbeat_at` refresh sites through outbox (R-LR1)

**Verifies:** task-lifecycle-resilience.AC1.1, AC1.2.

**Files:**
- Modify: `packages/agent/src/scheduler.ts:545-551` (timer-driven refresh in `refreshHeartbeats`)
- Modify: `packages/agent/src/scheduler.ts:1224-1228` (activity-driven refresh in `runTask`'s `onActivity` callback)

**Implementation:**

Both refresh sites currently issue:

```typescript
this.ctx.db
    .query("UPDATE tasks SET heartbeat_at = ? WHERE id = ? AND lease_id = ?")
    .run(now, taskId, leaseId);
// outbox-exempt: heartbeat_at is local-only state, not synced
```

Replace with `updateRow` from `@bound/core`. The original raw SQL had a `lease_id = ?` predicate as a defensive guard (only refresh if we still hold the lease). `updateRow` does NOT take a precondition; **swap to `updateRowIf` with `{ lease_id: leaseId }` as the precondition** so the lease guard survives the conversion:

```typescript
import { updateRowIf } from "@bound/core";

// ...inside the refresh body:
updateRowIf(
    this.ctx.db,
    "tasks",
    taskId,
    { lease_id: leaseId },           // precondition: we still hold the lease
    { heartbeat_at: now },           // updates: refresh the heartbeat
    this.ctx.siteId,
);
```

`updateRowIf` returns `boolean` (true if the precondition matched and the row was updated, false otherwise). The original raw UPDATE silently no-op'd when the lease changed; the converted version mirrors that semantically — but since this is a heartbeat refresh, a `false` return is interesting telemetry (the lease was lost between the run-loop's last heartbeat tick and now). At the timer-driven site, log a debug line if `updateRowIf` returns false; at the activity-driven site, the run loop already reacts to lost-lease conditions through other paths so just discard the return value.

Remove the `// outbox-exempt: ...` comment at both sites — `updateRowIf` IS outbox-routed by definition, no annotation needed.

**Cost considerations.** RFC §4.4 estimates worst case 10 concurrent running tasks × `HEARTBEAT_INTERVAL=30s` = ~1200 timer-driven entries/hour, plus ~1500/task/hour from activity-driven during long agent loops. Under the existing change_log volume (dominated by message inserts), this is well within budget. No coalescing introduced (Q1 deferred).

**Testing:**

Tests must verify each AC listed above. Test file: extend `packages/agent/src/__tests__/heartbeat-scheduling.test.ts` OR create `packages/agent/src/__tests__/heartbeat-at-sync.test.ts`.

- **AC1.1.** Insert a running task on host A (single test DB). Trigger a heartbeat refresh (call the refresh function directly — extract to a helper if not already callable, OR seed `runningTasks` and call `refreshHeartbeats` via reflection / `(this as any)`). Query `change_log` and assert exactly one entry has been written for the task id since the call, with `heartbeat_at` present in the change-log payload. Apply the change_log entry via the LWW reducer to a second test DB (host B simulation) and assert host B's row reflects the new `heartbeat_at`.
- **AC1.2.** Trigger two heartbeat refreshes 1ms apart (e.g., await two `updateRowIf` calls with explicit `now` values 1ms apart). Replay both change_log entries on the host-B simulation in order, then in REVERSE order (LWW must converge). Assert host B's final row reflects the LATER `heartbeat_at` value in both replay orders.

**Verification:**

```bash
bun run typecheck
bun test packages/agent/src/__tests__/<heartbeat test file>
```

**Commit:**
```bash
git add packages/agent/src/scheduler.ts packages/agent/src/__tests__/<file>
git commit -m "fix(agent): route tasks.heartbeat_at refreshes through outbox (R-LR1)"
```
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Route `rescheduleHeartbeat` through outbox; thread `siteId` to all five call sites (R-LR11)

**Verifies:** task-lifecycle-resilience.AC11.1.

**Files:**
- Modify: `packages/agent/src/scheduler.ts:277-317` (`rescheduleHeartbeat` body and signature)
- Modify: `packages/agent/src/scheduler.ts:363` (call site in `healStuckTasks` — depends on Phase 1 Task 2 having renamed and added `siteId` parameter)
- Modify: `packages/agent/src/scheduler.ts:661` (call site in eviction recovery)
- Modify: `packages/agent/src/scheduler.ts:1174` (call site in model-validation reschedule)
- Modify: `packages/agent/src/scheduler.ts:1322` (call site in soft-error reschedule)
- Modify: `packages/agent/src/scheduler.ts:1384` (call site in post-completion reschedule)

**Implementation:**

**Step A: Update helper signature and body.** Current at scheduler.ts:277-317:

```typescript
export function rescheduleHeartbeat(
    db: AppContext["db"],
    task: Task,
    logger: AppContext["logger"],
    context: string,
    lastUserInteractionAt: Date,
): void {
    // ... compute nextRunAt via quiescence-aware boundary ...
    const errorClause = context === "completion" ? ", error = ''" : "";
    db.query(`UPDATE tasks SET next_run_at = ?, status = 'pending'${errorClause} WHERE id = ?`)
        .run(nextRunAtIso, task.id);
    // outbox-exempt: heartbeat rescheduling is local-only state, not synced
}
```

Change signature and body to:

```typescript
export function rescheduleHeartbeat(
    db: AppContext["db"],
    task: Task,
    logger: AppContext["logger"],
    context: string,
    siteId: string,
    lastUserInteractionAt: Date,
): void {
    // ... existing nextRunAt computation unchanged ...
    const updates: Partial<TasksRow> = {
        next_run_at: nextRunAtIso,
        status: "pending",
    };
    if (context === "completion") {
        updates.error = "";
    }
    updateRow(db, "tasks", task.id, updates, siteId);
}
```

Add `siteId: string` AFTER `context` and BEFORE `lastUserInteractionAt` to keep the existing trailing parameter in place (less call-site churn). Remove the outbox-exempt annotation. Import `updateRow` from `@bound/core` if not already imported (the file already uses outbox helpers).

**Step B: Update all five call sites.** Each call gains `this.ctx.siteId` (or for the standalone helper, the existing `siteId` parameter from Phase 1 Task 2):

| Site | File:Line | Current call | Updated call |
|------|-----------|--------------|--------------|
| Stuck-row healer (Phase 1) | scheduler.ts:363 | `rescheduleHeartbeat(db, task, logger, "stuck-row healer", lastUserInteractionAt)` | `rescheduleHeartbeat(db, task, logger, "stuck-row healer", siteId, lastUserInteractionAt)` |
| Eviction recovery | scheduler.ts:661 | `rescheduleHeartbeat(this.ctx.db, task, this.ctx.logger, "heartbeat timeout eviction", this.lastUserInteractionAt)` | `rescheduleHeartbeat(this.ctx.db, task, this.ctx.logger, "heartbeat timeout eviction", this.ctx.siteId, this.lastUserInteractionAt)` |
| Model-validation reschedule | scheduler.ts:1174 | `rescheduleHeartbeat(this.ctx.db, task, this.ctx.logger, "model validation failure", this.lastUserInteractionAt)` | `rescheduleHeartbeat(this.ctx.db, task, this.ctx.logger, "model validation failure", this.ctx.siteId, this.lastUserInteractionAt)` |
| Soft-error reschedule | scheduler.ts:1322 | `rescheduleHeartbeat(this.ctx.db, task, this.ctx.logger, "soft error", this.lastUserInteractionAt)` | `rescheduleHeartbeat(this.ctx.db, task, this.ctx.logger, "soft error", this.ctx.siteId, this.lastUserInteractionAt)` |
| Post-completion | scheduler.ts:1384 | `rescheduleHeartbeat(this.ctx.db, task, this.ctx.logger, "completion", this.lastUserInteractionAt)` | `rescheduleHeartbeat(this.ctx.db, task, this.ctx.logger, "completion", this.ctx.siteId, this.lastUserInteractionAt)` |

`this.ctx.siteId` is in scope for the four Scheduler-instance call sites. The standalone helper from Phase 1 (`healStuckTasks`) passes its `siteId` parameter through (no scope concern).

**Step C: Verify Phase 1's healer dispatch line.** Phase 1 Task 2 specifies the heartbeat dispatch as `rescheduleHeartbeat(db, task, logger, "stuck-row healer", lastUserInteractionAt)`. Phase 2 updates this to include `siteId` between `context` and `lastUserInteractionAt`. The healer's heartbeat branch becomes:

```typescript
rescheduleHeartbeat(db, task, logger, "stuck-row healer", siteId, lastUserInteractionAt);
```

Phase 1's noted divergence (the heartbeat branch couldn't fully clear claim metadata in Phase 1 because raw UPDATE didn't write claim columns) is **automatically resolved here**: `updateRow` updates only the listed columns, so claim metadata still isn't cleared by `rescheduleHeartbeat` alone — but per RFC R-LR4 / AC4.1, the post-state requirement is `status = 'pending'`, which lets phase1 reclaim the row on the next tick. Cleared claim metadata is a Phase 3 concern (R-LR3 atomic eviction). Phase 1's note about "phase1 reclaims and overwrites stale claim columns" is the canonical answer through Phase 4.

**Testing:**

Tests must verify each AC listed above. Test file: extend `packages/agent/src/__tests__/heartbeat-scheduling.test.ts` OR create `packages/agent/src/__tests__/reschedule-heartbeat-outbox.test.ts`.

- **AC11.1.** Three sub-tests, one per call site mentioned in the AC text (post-completion, eviction recovery, hard-error reschedule):
  - **Post-completion.** Insert a heartbeat task in `running` state. Call `rescheduleHeartbeat(db, task, logger, "completion", siteId, lastUserInteractionAt)` directly. Assert: row's `status === "pending"`, `next_run_at` is non-null, `error === ""` (cleared on completion), exactly one new change_log entry for the task id.
  - **Eviction recovery.** Same, but pass `context = "heartbeat timeout eviction"`. Assert: same post-state, `error` is NOT cleared (no `errorClause` for non-completion contexts), exactly one new change_log entry.
  - **Hard-error reschedule.** Same, but pass `context = "model validation failure"` (the canonical "hard-error" call site in this codebase). Same assertions as eviction recovery.

Both AC11.1 tests can share the same harness; differences are minor (per-context `error` handling and the `context` string).

**Verification:**

```bash
bun run typecheck
bun test packages/agent/src/__tests__/<heartbeat test file>
```

**Commit:**
```bash
git add packages/agent/src/scheduler.ts packages/agent/src/__tests__/<file>
git commit -m "fix(agent): route rescheduleHeartbeat through outbox at all five call sites (R-LR11)"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Multi-host integration test for `heartbeat_at` propagation (R-LR1 LWW)

**Verifies:** task-lifecycle-resilience.AC1.1, AC1.2 end-to-end across two hosts.

**Files:**
- Create: `packages/agent/src/__tests__/heartbeat-at-multi-host.integration.test.ts`

**Implementation:**

Build a minimal two-host integration test. Pattern reference: `packages/agent/src/__tests__/relay-stream.integration.test.ts:186-192` (the WsTestCluster pattern with `spokeCount: 2, basePort: 10000 + Math.floor(Math.random() * 40000), testRunId: randomBytes(4).toString("hex")` per CONTRIBUTING.md test conventions).

**Decision pinned to Option A (in-process two-DB replay).** AC1.1/AC1.2 are deterministic LWW-reducer behaviors and do not require WebSocket sync to verify; Phase 4 Task 3 holds the WsTestCluster integration. Use:

- Two databases (host A and host B simulations) with the full schema applied.
- Manual change_log replay via the LWW reducer entry point in `packages/sync/src/reducers.ts`.
- `randomUUID()` for `siteId` per host.

This keeps Phase 2's tests fast (no port management, no async waits) and isolates the R-LR1/AC1 verification from Phase 4's host-liveness propagation concerns.

**Escalation path:** if the LWW reducer doesn't have a clean test entry point (i.e., it's not directly callable from a test without standing up the sync transport), surface this in implementation as an AskUserQuestion and propose either (a) extracting a test-friendly `applyChangeLogEntries` helper from the existing reducer, or (b) falling back to Option B (WsTestCluster) for this phase. Do not silently switch.

**Sketch of Option A:**

```typescript
// Two test DBs, both with the full schema applied.
const dbA = createTestDb();
const dbB = createTestDb();
const siteIdA = randomUUID();
const siteIdB = randomUUID();

// Insert a running task on host A.
const taskId = randomUUID();
insertRow(dbA, "tasks", { id: taskId, type: "heartbeat", status: "running", lease_id: "L1", claimed_by: siteIdA, /* ... */ }, siteIdA);

// Replay the insert to host B so host B has the row.
const insertEntries = readChangeLogSince(dbA, "0");
applyChangeLogEntries(dbB, insertEntries);

// Trigger a heartbeat refresh on host A.
const t1 = new Date().toISOString();
updateRowIf(dbA, "tasks", taskId, { lease_id: "L1" }, { heartbeat_at: t1 }, siteIdA);

// Replay to host B.
const refreshEntries = readChangeLogSince(dbA, /* hlc cursor after the insert */);
applyChangeLogEntries(dbB, refreshEntries);

// AC1.1: host B's heartbeat_at matches t1.
const rowB = dbB.query("SELECT heartbeat_at FROM tasks WHERE id = ?").get(taskId);
expect(rowB.heartbeat_at).toBe(t1);

// AC1.2: two close-in-time refreshes resolve LWW.
const t2 = new Date(Date.parse(t1) + 1).toISOString();
const t3 = new Date(Date.parse(t1) + 2).toISOString();
updateRowIf(dbA, "tasks", taskId, { lease_id: "L1" }, { heartbeat_at: t2 }, siteIdA);
updateRowIf(dbA, "tasks", taskId, { lease_id: "L1" }, { heartbeat_at: t3 }, siteIdA);
const finalEntries = readChangeLogSince(dbA, /* cursor */);
// Replay in reverse order to stress-test LWW.
applyChangeLogEntries(dbB, finalEntries.reverse());
const finalB = dbB.query("SELECT heartbeat_at FROM tasks WHERE id = ?").get(taskId);
expect(finalB.heartbeat_at).toBe(t3);  // later timestamp wins
```

The exact change-log read/apply API names depend on what's exported from `@bound/sync`. Inspect existing tests in `packages/sync/src/__tests__/` for the canonical replay shape and use that.

**Verification:**

```bash
bun run typecheck
bun test packages/agent/src/__tests__/heartbeat-at-multi-host.integration.test.ts
```

**Commit:**
```bash
git add packages/agent/src/__tests__/heartbeat-at-multi-host.integration.test.ts
git commit -m "test(agent): multi-host LWW propagation for tasks.heartbeat_at (R-LR1)"
```
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_C -->

---

## Phase 2 Done When

- `STALE_TASK_RESET_SQL` is scoped to `claimed_by = ?siteId` and the call site at `bootstrap.ts:417` passes `appContext.siteId`.
- The two `heartbeat_at` refresh sites (scheduler.ts:545 timer-driven, scheduler.ts:1224 activity-driven) write through `updateRowIf` with the `lease_id` precondition. Outbox-exempt comments removed.
- `rescheduleHeartbeat` body uses `updateRow`; signature includes `siteId`. All five call sites updated.
- Tests pass: AC10.1 (bootstrap scoped), AC1.1/AC1.2 (heartbeat_at propagates + LWW), AC11.1 (rescheduleHeartbeat outbox at all three named call sites).
- `bun run typecheck` clean. `bun run lint` clean. `bun test --recursive` baseline regression: no new failures. Existing scheduler integration tests still pass with the converted writes.
- Per RFC §4.3: no coordinated cluster upgrade required. Pre-fix peers handle the new column updates correctly via the existing LWW reducer.
