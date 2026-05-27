# Phase 3: Atomic Eviction Recovery + Lease CAS Guards (R-LR3 + R-LR8)

**Goal:** Make the eviction transition atomic — `running → pending` directly in one transaction with one change_log entry, claim cleared, `consecutive_failures++`, per-type `next_run_at` set inside the same transaction, the `relay_inbox` SELECT for event tasks folded inside. Add a thin `withTx(db, fn)` helper to `@bound/core`. Add `AND lease_id = ?caller_lease` guards to the four non-eviction `running → terminal` UPDATEs (model-validation failure, soft error, hard error, happy-path completion) so a peer's eviction reset cannot be silently overwritten. R-LR8 (post-eviction phase1 eligibility) is naturally satisfied by the new post-state.

**Architecture:** Replace the current two-step eviction (`running → failed` CAS at scheduler.ts:627-638, then per-type reschedule helpers at lines 654-674) with a single `withTx` block per evicted row that performs the per-type read (e.g., the `relay_inbox` SELECT for event tasks), computes `next_run_at`, and calls `updateRowIf` with precondition `{ status: 'running' }` and the full superset of column updates. The failure-advisory trigger fires after `withTx` commits (per invariant #6 events-after-commit). The four non-eviction `running → terminal` UPDATEs gain `AND lease_id = ?caller_lease` in their WHERE clauses; existing JS-side `lease_id` re-reads stay (defense-in-depth, not removal).

**Tech Stack:** TypeScript, `bun:sqlite` (`db.transaction()` semantics: BEGIN IMMEDIATE by default, automatic commit/rollback, nested transactions via savepoints), `@bound/core` (`updateRowIf`, new `withTx`), `bun:test`.

**Scope:** 1 phase from a 5-phase RFC implementation (Phase 3 of 5). Per RFC §4.1, this phase ships after Phase 2 (R-LR1/R-LR10/R-LR11) and before Phase 4 (R-LR2). R-LR4 from Phase 1 is canonical recovery during the deploy gap before Phase 3, defense-in-depth thereafter.

**Codebase verified:** 2026-05-26 via codebase-investigator. Key facts:
- Eviction loop body at `scheduler.ts:626-684`: fully synchronous, no `await` between CAS and reschedule helper calls. Folding into a single `withTx` is feasible.
- The four reschedule branches at scheduler.ts:654-674 cover cron, heartbeat, event. **Deferred is missing from the eviction dispatch** — investigator divergence #1. R-LR3 must add a deferred branch.
- The four non-eviction `running → terminal` UPDATEs:
  - **Happy-path completion** at scheduler.ts:1355-1369 already uses `updateRowIf(db, "tasks", task.id, { status: "running" }, { status: "completed", ... }, siteId)`. Adding `lease_id` to the precondition is one extra key in the `where` map.
  - **Model-validation failure** at scheduler.ts:1135-1157 uses raw `db.transaction()` + raw `UPDATE` + manual `createChangeLogEntry`. JS-side lease re-read at scheduler.ts:1130-1133.
  - **Soft error** at scheduler.ts:1288-1310 uses raw `db.transaction()` + raw `UPDATE` + manual `createChangeLogEntry`. JS-side lease re-read implicit (leaseId from outer scope at 1252).
  - **Hard error** at scheduler.ts:1420-1442 uses raw `db.transaction()` + raw `UPDATE` + manual `createChangeLogEntry`. JS-side lease re-read at scheduler.ts:1415-1418.
- `updateRowIf` signature in `change-log.ts:210+`: `updateRowIf<T>(db, table, id, where: Partial<Row>, updates: Partial<Row>, siteId): boolean`. Accepts `Partial<Row>` updates ✓, auto-injects `modified_at` ✓, emits exactly one change_log entry per successful precondition ✓, returns `false` when precondition fails ✓, opens its own internal `db.transaction()` (line 218) — bun:sqlite handles nested transactions via savepoints ✓.
- `db.transaction(fn)` in bun:sqlite: returns a callable, runs `fn` inside a SQLite transaction with automatic commit on success / rollback on exception. Uses BEGIN IMMEDIATE by default.
- `withTx` does NOT exist in `@bound/core`. Public exports are in `packages/core/src/index.ts`; existing surface includes `updateRow`, `updateRowIf`, `insertRow`, `softDelete`, `withChangeLog`.
- `relay_inbox` SELECT in `resetEventTask` at scheduler.ts:236-240: `SELECT COUNT(*) as c FROM relay_inbox WHERE ref_id = ? AND processed = 0 AND kind = ?` with `task.thread_id` and `"webhook_intake"`. Backoff at line 244: if `unprocessed.c > 0 AND failures < MAX_EVENT_TASK_FAILURE_BACKOFFS`, `nextRunAt = now + 60_000ms`; else `nextRunAt = null`.
- Failure-advisory trigger at scheduler.ts:676-683: `if (newConsecutiveFailures === task.alert_threshold) { this.triggerFailureAdvisory(task, "evicted due to heartbeat timeout", newConsecutiveFailures) }`. Same pattern at lines 1163, 1316, 1448. Safe to call after `withTx` commits.
- `retryDeferredTask` formula at scheduler.ts:120: `backoffMs = retryBackoffMs * consecutiveFailures` (pre-increment). RFC R-LR3 prescribes `now + DEFERRED_RETRY_BACKOFF_MS * (consecutive_failures + 1)` (post-increment). The mapping: in eviction recovery, the post-increment value `(task.consecutive_failures + 1)` is the new value being WRITTEN. The healer's existing `retryDeferredTask` call uses pre-increment because it lets `updateRow` set `consecutive_failures: consecutiveFailures + 1` separately; the multiplication direction is consistent if the caller passes the OLD value of `consecutive_failures` (pre-increment). For eviction recovery, `withTx` inside writes the new value `consecutive_failures: prev + 1` and computes `next_run_at = now + DEFERRED_RETRY_BACKOFF_MS * (prev + 1)` — equivalent semantics to the existing `retryDeferredTask` if the eviction passes the new (incremented) count.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### task-lifecycle-resilience.AC3: atomic eviction recovery (R-LR3)

- **task-lifecycle-resilience.AC3.1 Success.** Given an evictable running event task, when phase0 eviction fires, then exactly one change_log entry is written for the row, the row's post-state is `{ status: 'pending', claimed_by: null, claimed_at: null, lease_id: null, consecutive_failures: prev+1, next_run_at: <event-task reset retry value> }`, and the row is eligible for phase1 claim on the next tick.
- **task-lifecycle-resilience.AC3.2 Failure mode.** Given a running task whose eviction transaction is mid-commit, when the process is killed (simulated via test hook), then on next process startup the row is observably either still `running` (transaction rolled back) or `pending` (transaction committed). No row is observed in the wedged state `{ status: 'failed', claimed_by: NOT NULL }`.
- **task-lifecycle-resilience.AC3.3 Failure mode.** Given a running task on host A with `lease_id = L1`, and a peer eviction on host B that has already reset the row to `pending` and cleared `lease_id`, when host A attempts its terminal `running → completed` UPDATE, then the UPDATE returns `changes = 0` (lease CAS guard rejects) and the row remains in `pending`.

### task-lifecycle-resilience.AC8: post-eviction phase1 eligibility (R-LR8)

- **task-lifecycle-resilience.AC8.1 Success.** Given the eviction transaction (R-LR3) commits for any task type, when phase1 runs on the next tick, then the row is selected for claim with no additional code path required.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add `withTx(db, fn)` helper to `@bound/core`

**Verifies:** None directly (infrastructure for AC3.*).

**Files:**
- Modify: `packages/core/src/change-log.ts` (add `withTx` near `updateRowIf` and `withChangeLog`)
- Modify: `packages/core/src/index.ts` (re-export `withTx`)

**Implementation:**

`withTx` is a thin wrapper around `db.transaction(fn)` that returns the function's result and gives the caller a place to compose any sequence of reads + a single `updateRowIf` inside one SQLite transaction.

Add to `change-log.ts`:

```typescript
/**
 * Run `fn` inside a SQLite transaction. Returns whatever `fn` returns. The transaction
 * commits if `fn` returns normally and rolls back if it throws.
 *
 * Use this when you need to compose multiple reads + a single `updateRowIf` (or other
 * outbox-routed write) inside one transaction, e.g., the eviction recovery path that
 * SELECTs from `relay_inbox` to compute `next_run_at` before calling `updateRowIf`.
 *
 * `updateRowIf` opens its own internal `db.transaction()`; bun:sqlite handles nested
 * transactions via savepoints, so calling `updateRowIf` inside `withTx` is safe.
 *
 * See docs/design/specs/2026-05-26-task-lifecycle-resilience.md §3.1 R-LR3.
 */
export function withTx<T>(db: Database, fn: () => T): T {
    return db.transaction(fn)();
}
```

The double-call shape (`db.transaction(fn)()`) follows bun:sqlite's API: `db.transaction(fn)` returns a callable, and you invoke it to actually run the transaction. `withTx` collapses that into a single call.

Add to `packages/core/src/index.ts`:

```typescript
export { withTx } from "./change-log.ts";
```

(Match the existing export style in that file. Look at the surrounding `updateRowIf` export and mirror it.)

**Testing:**

Unit tests in `packages/core/src/__tests__/with-tx.test.ts` (new file):

- Successful commit: a `withTx` block that calls `updateRowIf` and returns; assert the row is updated and one change_log entry exists.
- Rollback on throw: a `withTx` block that calls `updateRowIf` and then throws; assert the row is NOT updated and zero change_log entries exist for the affected id.
- Returns the function's result: `withTx(db, () => 42)` returns `42`.
- Nested `updateRowIf`: `withTx(db, () => { updateRowIf(...); updateRowIf(...); })` produces TWO change_log entries (one per `updateRowIf` call); the eviction recovery uses exactly one `updateRowIf` per row, but the helper doesn't artificially restrict that.

**Verification:**

```bash
bun run typecheck
bun test packages/core/src/__tests__/with-tx.test.ts
```

**Commit:**
```bash
git add packages/core/src/change-log.ts packages/core/src/index.ts packages/core/src/__tests__/with-tx.test.ts
git commit -m "feat(core): add withTx(db, fn) transaction-wrapping helper (R-LR3)"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Replace eviction loop body with atomic `withTx` recovery

**Verifies:** task-lifecycle-resilience.AC3.1, AC8.1.

**Files:**
- Modify: `packages/agent/src/scheduler.ts:626-684` (eviction loop body — the CAS at 627-638 + per-type reschedule dispatch at 654-674)

**Implementation:**

Replace the two-step `running → failed` CAS + per-type reschedule with a single `withTx` block per row that goes `running → pending` directly with full claim cleared, `consecutive_failures++`, `error` set, `next_run_at` per type. The failure-advisory trigger moves to AFTER the `withTx` commit.

**Step A: Pre-`withTx` reads.** Before opening `withTx`, gather everything from outside the transaction that doesn't depend on per-row state we'll write:
- `nowMs = Date.now()` (used for deferred backoff).
- `nowIso = new Date(nowMs).toISOString()` (only if needed elsewhere).

**Step B: Per-row `withTx` block.** For each task in `tasksToEvict`:

```typescript
const newConsecutiveFailures = (task.consecutive_failures ?? 0) + 1;
let nextRunAtIso: string | null = null;

const committed = withTx(this.ctx.db, () => {
    // Per-type next_run_at computation (reads can happen here; they're inside the tx).
    switch (task.type) {
        case "cron":
            nextRunAtIso = computeNextRunAt(task.trigger_spec); // existing helper from rescheduleCronTask
            break;

        case "heartbeat":
            nextRunAtIso = computeHeartbeatNextRunAt(task, this.lastUserInteractionAt);
            // ^ extract the body of rescheduleHeartbeat's nextRunAt computation into a pure function
            // so it can be called without performing the write. See Step D below.
            break;

        case "event": {
            // R-LR3 design note: the relay_inbox SELECT lives inside the eviction transaction.
            const unprocessed = this.ctx.db
                .query<{ c: number }, [string, string]>(
                    "SELECT COUNT(*) as c FROM relay_inbox WHERE ref_id = ? AND processed = 0 AND kind = ?",
                )
                .get(task.thread_id ?? "", "webhook_intake");
            const hasUnprocessed = (unprocessed?.c ?? 0) > 0;
            const underBackoffCap = newConsecutiveFailures < MAX_EVENT_TASK_FAILURE_BACKOFFS;
            nextRunAtIso = hasUnprocessed && underBackoffCap
                ? new Date(nowMs + 60_000).toISOString()
                : null;
            break;
        }

        case "deferred": {
            // R-LR3 deferred-task parity with retryDeferredTask's linear backoff.
            // RFC formula: now + DEFERRED_RETRY_BACKOFF_MS * (consecutive_failures + 1).
            // The (consecutive_failures + 1) here is `newConsecutiveFailures` — the value
            // we are about to write. Capped at DEFERRED_MAX_RETRIES so deferred tasks that
            // continue to fail eventually park at status='failed' permanently (the next
            // healer tick won't recover them once consecutive_failures >= cap; AC4 logic
            // already excludes status='failed' rows whose claim_metadata is null after
            // recovery clears it).
            if (newConsecutiveFailures > DEFERRED_MAX_RETRIES) {
                // Don't reschedule — leave as failed permanently; recovery clears claim only.
                nextRunAtIso = null;
            } else {
                nextRunAtIso = new Date(
                    nowMs + DEFERRED_RETRY_BACKOFF_MS * newConsecutiveFailures,
                ).toISOString();
            }
            break;
        }

        default:
            this.ctx.logger.error("[scheduler] eviction: unknown task type", {
                taskId: task.id,
                type: task.type,
            });
            // Don't write — let the throw bubble up and roll back the (empty) transaction.
            throw new Error(`Unknown task type: ${task.type}`);
    }

    // Single updateRowIf — emits exactly one change_log entry. CAS precondition gates on
    // status='running' so a concurrent local write losing the lease can't double-evict.
    return updateRowIf(
        this.ctx.db,
        "tasks",
        task.id,
        { status: "running" },
        {
            status: "pending",
            error: "evicted due to heartbeat timeout",
            consecutive_failures: newConsecutiveFailures,
            next_run_at: nextRunAtIso,
            claimed_by: null,
            claimed_at: null,
            lease_id: null,
        },
        this.ctx.siteId,
    );
});

if (committed) {
    // Failure-advisory trigger AFTER commit (invariant #6: events after commit).
    if (newConsecutiveFailures === task.alert_threshold) {
        this.triggerFailureAdvisory(
            task,
            "evicted due to heartbeat timeout",
            newConsecutiveFailures,
        );
    }
}
```

**Step C: Delete the now-unused per-type reschedule dispatch in eviction.** Lines 654-674 (the existing if/else dispatch to `rescheduleCronTask` / `rescheduleHeartbeat` / `resetEventTask`) is replaced by the inline per-type computation inside `withTx`. The per-type helpers themselves stay — they're still called from the non-eviction paths (post-completion reschedule, etc.).

**Step D: Extract `computeHeartbeatNextRunAt`.** `rescheduleHeartbeat` at scheduler.ts:277-317 currently combines next_run_at computation with the write. Extract the computation into a pure function:

```typescript
export function computeHeartbeatNextRunAt(
    task: Task,
    lastUserInteractionAt: Date,
): string {
    // Move the existing computeQuiescenceMultiplier + boundary-aligned next-run-at logic
    // from rescheduleHeartbeat (currently at scheduler.ts:280-310) into this pure helper.
    // The helper returns the ISO 8601 string. rescheduleHeartbeat then becomes a thin
    // wrapper: compute via this helper, then updateRow.
    // ...
}
```

`rescheduleHeartbeat` (Phase 2) becomes:

```typescript
export function rescheduleHeartbeat(
    db: AppContext["db"],
    task: Task,
    logger: AppContext["logger"],
    context: string,
    siteId: string,
    lastUserInteractionAt: Date,
): void {
    const nextRunAtIso = computeHeartbeatNextRunAt(task, lastUserInteractionAt);
    const updates: Partial<TasksRow> = { next_run_at: nextRunAtIso, status: "pending" };
    if (context === "completion") {
        updates.error = "";
    }
    updateRow(db, "tasks", task.id, updates, siteId);
}
```

This factoring lets the eviction loop compute `next_run_at` for heartbeat tasks without performing a separate write — keeping the transaction atomic with one `updateRowIf` call.

**Cron next_run_at extraction.** Same pattern: `rescheduleCronTask` at scheduler.ts:72-103 already factors out `computeNextRunAt(cronExpr)` (Phase 1 investigator confirmed line 82). Use the existing pure helper in the eviction's `case "cron"` branch.

**Event task `relay_inbox` SELECT inside the transaction.** RFC §2.3 design note: `relay_inbox` is a non-synced table (per invariant #3), so peer hosts may compute different `next_run_at` values for the same eviction — this is correct: each host's eviction reflects what it can locally see, and the LWW reducer reconciles via `modified_at`.

**Step E: `failures < MAX_EVENT_TASK_FAILURE_BACKOFFS` constant.** Codebase-investigator confirmed: `MAX_EVENT_TASK_FAILURE_BACKOFFS = 5` is already declared at `packages/agent/src/scheduler.ts:191` and referenced by `resetEventTask` at scheduler.ts:243. The eviction's `case "event"` branch reuses the same constant — just reference the existing top-of-file declaration; no extraction needed.

**Testing:**

Tests must verify each AC listed above. Test file: extend `packages/agent/src/__tests__/scheduler.integration.test.ts` (which already has eviction tests at line 448+) AND create a focused unit-test file `packages/agent/src/__tests__/eviction-atomic.integration.test.ts` for the atomicity-specific AC3.* assertions.

- **AC3.1.** Insert a running event task with stale `heartbeat_at`. Insert one unprocessed `relay_inbox` row matching `ref_id = task.thread_id`. Run a single `phase0Eviction` tick (call directly via `(scheduler as any).phase0Eviction()` or via the public scheduler interface). Assert:
  - Row post-state: `status === "pending"`, `claimed_by === null`, `claimed_at === null`, `lease_id === null`, `consecutive_failures === prev + 1`, `next_run_at` is approximately `now + 60_000ms` (event-task backoff with unprocessed envelope).
  - Exactly one new change_log entry for the row id since the eviction call (count via SQL).
  - The row is selected by phase1's claim SELECT on the next tick (run phase1 directly or assert it via the existing `idx_tasks_pending_schedule` predicate).

- **AC3.2.** Insert a running task. Inject a test hook that throws inside `withTx`'s callback BEFORE the `updateRowIf` returns (e.g., via a mock-able sync point or a dependency-injected `withTx` that throws on a flag). Run `phase0Eviction`. Assert:
  - `withTx` rolled back: row state unchanged from `running`.
  - No change_log entries for the row id.
  - On a subsequent eviction tick (no throw), the row evicts cleanly to `pending`.

  Alternatively, a less-invasive test: directly construct the wedge state (status='failed', claim metadata preserved) — Phase 1's tests already cover this path. AC3.2's specific guarantee is "no row is observed in the wedged state". After R-LR3, the eviction NEVER produces this state, so a positive test would need to interrupt mid-transaction. Use a `withTx` wrapper that supports a throw-after-N-ops mode, or restructure the test to assert the property from existing eviction code paths. If a clean test hook isn't feasible, document in the test preamble and assert the looser property: "every eviction commit leaves the row in `pending` or `running`, never `failed` with claim metadata".

- **AC3.3.** Two-DB test (single-process, two-AppContext shape). Insert a running task on dbA owned by host A with `lease_id = L1`. Replay state to dbB. Run `phase0Eviction` on dbB → row goes to `pending` with `lease_id = null` on dbB. Replay change_log to dbA → dbA's row also goes to `pending` (LWW). NOW (with the lease CAS guard from Task 3), attempt a `running → completed` UPDATE on dbA with `caller_lease = L1`. Assert: the UPDATE matches zero rows (the precondition `lease_id = L1` fails because lease is now null). dbA's row remains in `pending`.

  This test depends on Task 3's lease CAS guards being in place — sequence Task 2 and Task 3 commits accordingly (Task 3 first if AC3.3 is asserted in Task 2's test file; otherwise put AC3.3 in Task 3's test file).

- **AC8.1.** Dedicated `it()` block adjacent to AC3.1, named `"AC8.1: post-eviction row is eligible for phase1 claim on the next tick"`. After running `phase0Eviction`, run the actual phase1 claim selector (call `(scheduler as any).phase1Schedule()` or whatever the public/test-accessible phase1 entry point is) and assert the row's `status === "claimed"` AND `claimed_by === <evicting host's siteId>` AND `lease_id !== null`. Asserting via the actual phase1 SELECT (rather than just predicate-equivalence) verifies "no additional code path is required" per AC8.1's text. Run this test separately from AC3.1 so the assertion is explicit; AC3.1's tail assertion stays as a structural check on the post-eviction row state.

**Verification:**

```bash
bun run typecheck
bun test packages/agent/src/__tests__/eviction-atomic.integration.test.ts
bun test packages/agent/src/__tests__/scheduler.integration.test.ts  # regression
```

**Commit:**
```bash
git add packages/agent/src/scheduler.ts packages/agent/src/__tests__/eviction-atomic.integration.test.ts
git commit -m "feat(agent): atomic eviction recovery via withTx + updateRowIf (R-LR3)"
```
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Add lease CAS guards to four non-eviction `running → terminal` UPDATEs

**Verifies:** task-lifecycle-resilience.AC3.3.

**Files:**
- Modify: `packages/agent/src/scheduler.ts:1135-1157` (model-validation failure)
- Modify: `packages/agent/src/scheduler.ts:1288-1310` (soft error)
- Modify: `packages/agent/src/scheduler.ts:1420-1442` (hard error)
- Modify: `packages/agent/src/scheduler.ts:1355-1369` (happy-path completion)

**Implementation:**

Add `AND lease_id = ?caller_lease` to the WHERE clause of each non-eviction `running → terminal` UPDATE. The existing JS-side `lease_id` re-read stays — defense in depth.

**Happy-path completion (scheduler.ts:1355-1369).** Already uses `updateRowIf`. Just add `lease_id` to the precondition:

Current shape:
```typescript
updateRowIf(
    this.ctx.db,
    "tasks",
    task.id,
    { status: "running" },
    { status: "completed", result: ..., /* ... */ },
    this.ctx.siteId,
);
```

Updated:
```typescript
updateRowIf(
    this.ctx.db,
    "tasks",
    task.id,
    { status: "running", lease_id: leaseId },  // ← lease CAS guard
    { status: "completed", result: ..., /* ... */ },
    this.ctx.siteId,
);
```

Where `leaseId` is the variable holding the claim-time lease (already in scope at this site — phase 3 investigator confirmed `updateRowIf`'s implicit CAS already verifies `status='running'`; adding `lease_id` is one extra precondition key).

**Model-validation failure / soft error / hard error.** These three use raw `db.transaction()` + raw `UPDATE` + manual `createChangeLogEntry`. Add `AND lease_id = ?` to the WHERE clause and bind the caller's lease.

For example, at scheduler.ts:1135-1157 (model-validation failure):

Current shape:
```typescript
this.ctx.db.transaction(() => {
    this.ctx.db
        .query(
            "UPDATE tasks SET status='failed', error=?, consecutive_failures=consecutive_failures+1 WHERE id=?",
        )
        .run(errorMessage, task.id);
    createChangeLogEntry(
        this.ctx.db,
        "tasks",
        task.id,
        { status: "failed", error: errorMessage, consecutive_failures: ..., modified_at: ... },
        this.ctx.siteId,
    );
})();
```

Updated:
```typescript
this.ctx.db.transaction(() => {
    const result = this.ctx.db
        .query(
            "UPDATE tasks SET status='failed', error=?, consecutive_failures=consecutive_failures+1 WHERE id=? AND lease_id=?",
        )
        .run(errorMessage, task.id, leaseId);
    if (result.changes === 0) {
        // Lease CAS rejected — peer eviction landed first; the row is now in `pending` with
        // claim cleared. Don't emit a misleading change_log entry. Log and bail; the
        // healer / phase1 reclaim will drive next steps.
        this.ctx.logger.warn(
            "[scheduler] running→failed UPDATE rejected by lease CAS guard",
            { taskId: task.id, expectedLease: leaseId, path: "model-validation" },
        );
        return;
    }
    createChangeLogEntry(
        this.ctx.db,
        "tasks",
        task.id,
        { status: "failed", error: errorMessage, consecutive_failures: /* re-read */, modified_at: /* now */ },
        this.ctx.siteId,
    );
})();
```

**Critical**: the `consecutive_failures` value in the change_log payload must be the post-UPDATE value. The raw SQL uses `consecutive_failures = consecutive_failures + 1`, so after the UPDATE we re-SELECT the row OR pre-compute `prev + 1` from the local task object. Match the existing pattern at each site (Phase 1 investigator showed all three sites already pre-compute or re-read; preserve that).

**Repeat for soft error (scheduler.ts:1288-1310) and hard error (scheduler.ts:1420-1442).** Same shape: add `AND lease_id = ?` to the UPDATE, bind `leaseId`, check `result.changes === 0`, log + return without emitting a change_log entry on rejection.

**`leaseId` source at each site (verified via codebase-investigator).** All four sites bind the SAME variable name `leaseId` — the non-nullable closure variable declared at scheduler.ts:793 (`const leaseId = randomUUID()`). The two sites that re-read `currentTask?.lease_id` (model-validation at 1130-1133, hard-error at 1415-1418) use that re-read for their JS-side equality check (`if (currentTask?.lease_id === leaseId)`), but the actual UPDATE bind value is the non-nullable `leaseId` — the JS check has already proven they're equal. This means:

- **Model-validation failure** (scheduler.ts:1135-1157): The conditional at line 1133 guards the block with `currentTask?.lease_id === leaseId`. Inside the block, bind `leaseId` to the SQL `AND lease_id = ?`. No nullability concern.
- **Soft error** (scheduler.ts:1288-1310): Wrapped by outer conditional at scheduler.ts:1272. Bind `leaseId` (outer-scope, non-nullable).
- **Hard error** (scheduler.ts:1420-1442): Conditional at line 1418 guards the block with `currentTask?.lease_id === leaseId`. Bind `leaseId` (non-nullable).
- **Happy-path completion** (scheduler.ts:1355-1369): Wrapped by outer conditional at scheduler.ts:1272. The existing `updateRowIf` precondition is `{ status: "running" }`. Add `lease_id: leaseId` (non-nullable).

All four sites use the same identifier `leaseId` and all four sites are guarded by JS-side equality checks before the UPDATE; no additional null guards needed at the bind point.

**Testing:**

Tests must verify each AC listed above. Test file: extend `eviction-atomic.integration.test.ts` (created in Task 2) OR create `packages/agent/src/__tests__/lease-cas-guard.test.ts`.

- **AC3.3.** For each of the four sites, simulate a peer-eviction-cleared-lease state then attempt the terminal write:

  1. Insert a running task with `lease_id = "L1"`.
  2. Simulate peer eviction: directly UPDATE the row to `status='pending', lease_id=NULL, claimed_by=NULL` (mimics what Task 2's atomic eviction produces on a peer host once its change_log lands locally).
  3. Call the terminal-write code path with `caller_lease = "L1"` (the original claim-time lease).
  4. Assert: the UPDATE matches zero rows (the precondition `lease_id = "L1"` fails). The row remains in `pending`. No change_log entry is emitted from the rejected write.

  Repeat for happy-path completion, model-validation, soft error, hard error.

For the raw-SQL paths, the test asserts `result.changes === 0` (the SQL UPDATE matched no rows). For the `updateRowIf` happy-path completion, the test asserts the function returned `false`.

**Verification:**

```bash
bun run typecheck
bun test packages/agent/src/__tests__/lease-cas-guard.test.ts
bun test packages/agent/src/__tests__/scheduler.integration.test.ts  # regression
```

**Commit:**
```bash
git add packages/agent/src/scheduler.ts packages/agent/src/__tests__/lease-cas-guard.test.ts
git commit -m "fix(agent): lease CAS guards on four running→terminal UPDATEs (R-LR3)"
```
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Process-kill atomicity assertion (AC3.2)

**Verifies:** task-lifecycle-resilience.AC3.2.

**Files:**
- Create: `packages/agent/src/__tests__/eviction-process-kill.integration.test.ts`

**Implementation:**

AC3.2 specifies: "Given a running task whose eviction transaction is mid-commit, when the process is killed (simulated via test hook), then on next process startup the row is observably either still `running` (transaction rolled back) or `pending` (transaction committed). No row is observed in the wedged state `{ status: 'failed', claimed_by: NOT NULL }`."

The cleanest way to verify this is a property assertion on the eviction code path, not a literal kill-9. After R-LR3, the eviction's only DB write is a single `updateRowIf` inside `withTx`; SQLite's transaction guarantees mean the row is atomically `running` (pre-write) or `pending` (post-write) regardless of when the process dies. The wedged `failed` state is structurally impossible with the new path.

**Approach: monkey-patched `withTx` that throws after start, before commit.**

```typescript
import * as core from "@bound/core";

it("does not produce a wedged failed-with-claim state on process kill mid-eviction", () => {
    const db = createTestDb();
    insertRow(db, "tasks", { id: "t1", type: "cron", status: "running", lease_id: "L1", claimed_by: "site-A", claimed_at: ISO(now - 30min), heartbeat_at: ISO(now - 20min), /* ... */ }, "site-A");

    // Monkey-patch: replace withTx with a version that throws inside fn() to simulate
    // a process kill before commit. The transaction must roll back.
    const origWithTx = core.withTx;
    let callCount = 0;
    (core as any).withTx = <T>(d: typeof db, fn: () => T): T => {
        callCount++;
        return d.transaction(() => {
            fn();
            throw new Error("simulated process kill");
        })();
    };

    try {
        // Run phase0Eviction directly (or invoke the scheduler tick).
        const scheduler = new Scheduler(/* ctx */);
        try { (scheduler as any).phase0Eviction(); } catch { /* expected */ }

        // Assert: row is still in `running`. No partial wedge state.
        const row = db.query("SELECT status, claimed_by FROM tasks WHERE id=?").get("t1");
        expect(row.status).toBe("running");
        expect(row.claimed_by).toBe("site-A");

        // Crucially: row is NEVER in { status: 'failed', claimed_by: NOT NULL }.
        const wedged = db.query(
            "SELECT COUNT(*) as c FROM tasks WHERE status='failed' AND claimed_by IS NOT NULL",
        ).get();
        expect(wedged.c).toBe(0);
    } finally {
        (core as any).withTx = origWithTx;
    }
});
```

If monkey-patching the imported `withTx` is hard with the codebase's import shape, alternatives:
- Extract eviction into a function that accepts `withTx` as a parameter (DI), and inject the throwing variant in the test.
- Use a less-invasive assertion: across many eviction cycles in a stress test, no row reaches `(status='failed', claimed_by NOT NULL)`. This is a weaker assertion but catches regressions.

Pick whichever is cleanest. Document the choice in the test preamble.

**Verification:**

```bash
bun run typecheck
bun test packages/agent/src/__tests__/eviction-process-kill.integration.test.ts
```

**Commit:**
```bash
git add packages/agent/src/__tests__/eviction-process-kill.integration.test.ts
git commit -m "test(agent): atomicity assertion on eviction (R-LR3 AC3.2)"
```
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

---

## Phase 3 Done When

- `withTx(db, fn)` exists in `@bound/core`, exported from `@bound/core/index.ts`, with unit tests covering commit/rollback/return-value semantics.
- Eviction loop body in `scheduler.ts` uses `withTx` + `updateRowIf` with precondition `{ status: 'running' }` and the full-superset update; produces exactly one change_log entry per evicted row going `running → pending` directly. Per-type `next_run_at` computed inside the transaction (relay_inbox SELECT for events; quiescence-aware boundary for heartbeats; cron next_run_at; deferred linear-backoff with cap).
- The four non-eviction `running → terminal` UPDATEs include `AND lease_id = ?caller_lease` (or `lease_id` in the `updateRowIf` precondition for the happy-path completion).
- Failure-advisory trigger fires after `withTx` commits (events-after-commit invariant).
- Tests pass: AC3.1 (atomic eviction post-state + change_log count + phase1 eligibility), AC3.2 (no wedged state on simulated kill), AC3.3 (lease CAS guards reject stale terminal writes), AC8.1 (post-eviction phase1 eligibility — covered by AC3.1's last assertion).
- `bun run typecheck` clean. `bun run lint` clean. `bun test --recursive` baseline regression: no new failures. Existing scheduler integration tests at scheduler.integration.test.ts:448+ still pass after the eviction loop refactor.
