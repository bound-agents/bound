# Human Test Plan — Task Lifecycle Resilience (2026-05-26)

This is the human verification plan for the [task-lifecycle-resilience RFC](../design/specs/2026-05-26-task-lifecycle-resilience.md). It supplements automated test coverage and covers acceptance criteria that require multi-host or production-runtime validation, plus the doc/log/gate requirements (R-LR5, R-LR6, R-LR9, R-LR12) that have no automated AC per RFC §3.4.

Automated coverage is comprehensive: 14/14 acceptance criteria with observable behavior have at least one assertion-based test. See the Traceability table at the end for the mapping.

## Prerequisites

- Two-host deployment available (host A and host B), either:
  - Connected to a sync hub and each running `bun packages/cli/src/bound.ts start`, OR
  - Two `bound` instances pointing at separate `--config-dir` and `--data-dir` paths with hub-and-spoke or peer sync configured.
- `bun test packages/agent packages/core packages/cli` passing on the branch.
- Both hosts built from the same commit (HEAD = `fd6a12ad`).

### Constants

| Constant | Value | Defined in |
|---|---|---|
| `EVICTION_TIMEOUT` | 600 000 ms (10 min) | `packages/agent/src/scheduler.ts` |
| `HOST_HEARTBEAT_INTERVAL` | 120 000 ms (2 min) | `packages/core/src/host-heartbeat.ts` |
| `HOST_OFFLINE_TIMEOUT` | `max(EVICTION_TIMEOUT, 2 × HOST_HEARTBEAT_INTERVAL)` = 600 000 ms | `packages/agent/src/scheduler.ts` |
| `STUCK_THRESHOLD` | 1 200 000 ms (20 min) | `packages/agent/src/scheduler.ts` |
| `DEFERRED_RETRY_BACKOFF_MS_DEFAULT` | 5 000 ms | `packages/agent/src/scheduler.ts` |

Allow ≥ 11 minutes for staleness windows to elapse on real hosts unless otherwise noted.

---

## R-LR5: Annotation rewrites at raw-CAS sites

| Step | Action | Expected |
|---|---|---|
| 1 | `grep -rn "outbox-exempt" packages/ scripts/` | Every printed line corresponds to a row in `CONTRIBUTING.md`'s "Audit Disposition Table for `outbox-exempt` Annotations" |
| 2 | Inspect `packages/agent/src/scheduler.ts` at the six raw-CAS sites (re-locate via grep — line numbers shifted post-implementation) | Each annotation reads `// outbox-routed: explicit createChangeLogEntry follows ...` (NOT `outbox-exempt`) |
| 3 | Inspect `packages/cli/src/commands/start/bootstrap.ts:368, 391`, `packages/platforms/src/leader-election.ts:73`, `packages/cli/src/commands/drain.ts:42, 46, 83, 87, 101`, `packages/cli/src/commands/set-hub.ts:125, 129`, `packages/cli/src/commands/config-reload.ts:69, 73`, `packages/cli/src/commands/stop-resume.ts:33, 37, 66` | Each annotation reads `// outbox-routed: ...` |
| 4 | Inspect `packages/agent/src/scheduler.ts` at former heartbeat-refresh sites | No `outbox-exempt` or `outbox-routed` annotation present (Phase 2 routed those writes through `updateRowIf` directly) |

## R-LR6: PR gate referencing CONTRIBUTING.md

| Step | Action | Expected |
|---|---|---|
| 1 | Open `scripts/validate-outbox-invariant.ts` | `// outbox-routed` is in the skip-pattern list; `// outbox-exempt` lines trigger CONTRIBUTING.md cross-check per the matching strategy |
| 2 | `bun test scripts/__tests__/validate-outbox-invariant.test.ts` | All 27 tests pass; tests genuinely invoke exported helpers (not just fixture-string assertions) |
| 3 | `bun run scripts/validate-outbox-invariant.ts` | Exit code 0; "outbox invariant: all synced-table writes go through the outbox" |
| 4 | Inspect `.github/workflows/ci.yml` | Line 32 invokes `bun run scripts/validate-outbox-invariant.ts` on PRs |

## R-LR9: Per-recovered-row warning logs

| Step | Action | Expected |
|---|---|---|
| 1 | Open `packages/agent/src/scheduler.ts` and locate `healStuckTasks` | A `logger.warn("[scheduler] healStuckTasks: recovering stuck row", { taskId, type, previousStatus, claimedBy, elapsedMs })` is emitted before each per-row dispatch |
| 2 | (Optional, live) On host A, manually wedge a row: `UPDATE tasks SET status='failed', claimed_by='dead-host', claimed_at=datetime('now', '-25 minutes'), lease_id='abc' WHERE id=<test-task-id>;` then trigger `phase0Eviction` and tail logs | A `[scheduler] healStuckTasks: recovering stuck row` line appears containing all five fields with elapsedMs > STUCK_THRESHOLD |

## R-LR12: Audit disposition table

| Step | Action | Expected |
|---|---|---|
| 1 | Open `CONTRIBUTING.md` "Section A: Documented Narrow Exceptions to Invariant #1" | Two entries: `semantic_memory.last_accessed_at` and `tasks bootstrap reset (bootstrap.ts:62)` |
| 2 | Locate "Audit Disposition Table for `outbox-exempt` Annotations" | Every row from the Phase 5 audit table is present; each has a category in `{(a), (b), (c), (d), (e)}` |
| 3 | `grep -rn "outbox-exempt" packages/ scripts/` and cross-reference each surviving annotation against the disposition table | Every annotation has a corresponding row |
| 4 | Inspect `packages/sandbox/src/overlay-scanner.ts:128, 149, 170` and `packages/agent/src/task-resolution.ts:428` | Each is accompanied by a TODO link comment to a follow-up RFC (Path B) |
| 5 | `bun run scripts/validate-outbox-invariant.ts` | Exit code 0 |

---

## End-to-End Scenario 1: Two-host eviction with host-liveness gate (AC2.1 + AC2.2 + AC8.1)

**Purpose**: Validates the full R-LR2 + R-LR3 + R-LR8 pipeline — heartbeat refresh propagation, host-liveness gate, atomic eviction, and post-eviction phase1 claim eligibility — against real running schedulers rather than just the SQL selector.

### Steps

1. Start host A and host B as described in Prerequisites; confirm both write to `hosts` and that each sees the other in `SELECT site_id, modified_at FROM hosts;`.
2. Schedule a long-running cron task on host A:
   ```
   boundctl task add --cron '*/5 * * * *' --thread <thread-id> --payload '{"sleep_ms": 1800000}'
   ```
   (or any payload that runs ≥ 30 minutes).
3. Wait for host A to claim and start the task. Confirm via host A:
   ```sql
   SELECT status, claimed_by, lease_id, heartbeat_at FROM tasks WHERE id=<task>;
   ```
   shows `status='running'`, `claimed_by=<siteA>`, `heartbeat_at` ≈ now.
4. Wait ~30 seconds and re-run the same query on host A — `heartbeat_at` should advance (timer-driven refresh).
5. On host B run the same query — values should match host A within one sync RTT (LWW propagation, AC1.1).
6. **AC2.2 phase**: While host A is alive and running, on host B trigger `phase0Eviction` (via scheduler tick). Re-query host B's tasks row — `status` is still `running`, `claimed_by=<siteA>`, `lease_id` unchanged. **No eviction occurred** because host A's `hosts.modified_at` is fresh.
7. **AC2.1 phase**: Hard-kill host A (`kill -9 <pid>`). Do not let it restart. Wait ≥ 11 minutes (longer than `HOST_OFFLINE_TIMEOUT`). On host B, observe scheduler logs.
8. After the timeout: on host B run:
   ```sql
   SELECT status, claimed_by, lease_id, consecutive_failures, next_run_at, error
   FROM tasks WHERE id=<task>;
   ```
   Expected: `status='pending'`, `claimed_by=NULL`, `lease_id=NULL`, `consecutive_failures=1`, `error='evicted due to heartbeat timeout'`, `next_run_at` non-null. Exactly one new `change_log` entry exists for this row created by host B.
9. **AC8.1 phase**: Wait one scheduler tick on host B. Re-query — the row is now `status='claimed'` (or `running`), `claimed_by=<siteB>`, `lease_id` repopulated. Phase1 selected the row with no extra code path required.
10. (Optional) Restart host A. Inspect the `tasks` row — host A does not trample host B's claim; host A's stale completion/error UPDATEs (if any in flight when killed) are rejected by the lease CAS guard (no row reaches `{failed, claimed_by=<siteA>}`).

---

## End-to-End Scenario 2: Healer recovery from real wedged state (AC4.1 + AC4.3 + R-LR9)

**Purpose**: Validates that the phase0 healer recovers wedges from real failed-write paths in a running deployment.

### Steps

1. On host A with at least one cron, heartbeat, event, and deferred task created, manually inject the four wedge fixtures (one per task type and failure path):
   ```sql
   UPDATE tasks SET status='failed',
                    claimed_by='dead-host-X',
                    claimed_at=datetime('now', '-25 minutes'),
                    lease_id='wedged-1',
                    error='evicted due to heartbeat timeout'
    WHERE id=<cron-task-id>;

   UPDATE tasks SET status='failed',
                    claimed_by='dead-host-X',
                    claimed_at=datetime('now', '-25 minutes'),
                    lease_id='wedged-2',
                    error='model validation failed: Model unknown not available in current config'
    WHERE id=<heartbeat-task-id>;

   UPDATE tasks SET status='failed',
                    claimed_by='dead-host-X',
                    claimed_at=datetime('now', '-25 minutes'),
                    lease_id='wedged-3',
                    error='Error: Task run completed with error field'
    WHERE id=<event-task-id>;

   UPDATE tasks SET status='failed',
                    claimed_by='dead-host-X',
                    claimed_at=datetime('now', '-25 minutes'),
                    lease_id='wedged-4',
                    error='Error: Task encountered unexpected error during execution',
                    consecutive_failures=1
    WHERE id=<deferred-task-id>;
   ```
   Use `datetime('now', '-25 minutes')` because `STUCK_THRESHOLD = 20 minutes`.
2. Trigger `phase0Eviction` (next scheduler tick).
3. Tail scheduler logs. Expected: four lines of `[scheduler] healStuckTasks: recovering stuck row` with `{ taskId, type, previousStatus="failed", claimedBy="dead-host-X", elapsedMs > 1_200_000 }` (R-LR9).
4. Re-query each row. Expected:
   - All four rows: `status='pending'`, exactly one new `change_log` entry per row.
   - Cron / event / deferred rows: `claimed_by=NULL`, `claimed_at=NULL`, `lease_id=NULL`. (The heartbeat row may retain claim metadata per the documented Phase 1 transition note in `heal-stuck-tasks.test.ts:153`; phase1 claim CAS will overwrite it.)
   - Cron, heartbeat, deferred rows: `next_run_at` non-null. Event row may have `next_run_at=NULL` if no `relay_inbox` entries were present.
   - Deferred row: `next_run_at ≈ now + DEFERRED_RETRY_BACKOFF_MS_DEFAULT * (consecutive_failures + 1) = now + 10 s`.
5. Wait one tick. Expected: phase1 picks up each pending row and a new lease holder claims it.

---

## End-to-End Scenario 3: Bootstrap stale reset is local-only (AC10.1)

**Purpose**: Validates R-LR10 in a real two-host scenario.

### Steps

1. With host A and host B running and a cron task claimed and running on host A, hard-kill host A (`kill -9`).
2. Wait ≥ 10 minutes so host A's `heartbeat_at` becomes stale beyond the bootstrap reset threshold.
3. Restart host A. On startup, host A's bootstrap runs `STALE_TASK_RESET_SQL` with its own `?siteId` bound. Inspect logs and the row.
4. Expected: host A's previously-running row is reset to `status='pending'`, `claimed_by=NULL`, `lease_id=NULL`. Any peer-claimed rows on host B are unmodified (still `running` with their original `claimed_by` and `lease_id`).
5. Verify by querying both DBs for any rows owned by host B's siteId: those rows are unchanged.

---

## Human Verification Required (no AC, doc/log/gate)

| Requirement | Why Manual | Reference |
|---|---|---|
| R-LR5 | Comment text only, no runtime behavior | "R-LR5" table above |
| R-LR6 | Structural CI-gate property + validator unit tests | "R-LR6" table above |
| R-LR9 | Field presence in structured log object; not asserted by AC | "R-LR9" table above + E2E §"Healer recovery" step 3 |
| R-LR12 | Documentation deliverable; correctness verified by grep-vs-table reconciliation | "R-LR12" table above |

---

## Traceability

| Acceptance Criterion | Automated Test | Manual Verification |
|---|---|---|
| `task-lifecycle-resilience.AC1.1` | `heartbeat-scheduling.test.ts` (R-LR1 block) + `heartbeat-at-multi-host.integration.test.ts` | E2E Scenario 1 step 5 |
| `task-lifecycle-resilience.AC1.2` | `heartbeat-at-multi-host.integration.test.ts` | — |
| `task-lifecycle-resilience.AC2.1` | `eviction-host-liveness.test.ts` + `eviction-host-liveness.integration.test.ts` | E2E Scenario 1 steps 7–8 |
| `task-lifecycle-resilience.AC2.2` | `eviction-host-liveness.test.ts` + `eviction-host-liveness.integration.test.ts` | E2E Scenario 1 step 6 |
| `task-lifecycle-resilience.AC3.1` | `eviction-atomic.integration.test.ts` | E2E Scenario 1 step 8 |
| `task-lifecycle-resilience.AC3.2` | `eviction-process-kill.integration.test.ts` (structural — no row reaches wedged state) | E2E Scenario 1 step 10 (lease CAS rejects post-kill writes; no wedge appears) |
| `task-lifecycle-resilience.AC3.3` | `lease-cas-guard.test.ts` | E2E Scenario 1 step 10 |
| `task-lifecycle-resilience.AC4.1` | `heal-stuck-tasks.test.ts` | E2E Scenario 2 steps 4–5 |
| `task-lifecycle-resilience.AC4.2` | `heal-stuck-tasks.test.ts` | — |
| `task-lifecycle-resilience.AC4.3` | `heal-stuck-tasks-cross-path.integration.test.ts` | E2E Scenario 2 steps 1–4 |
| `task-lifecycle-resilience.AC7.1` | `eviction-host-liveness.test.ts` | E2E Scenario 1 steps 6–8 |
| `task-lifecycle-resilience.AC8.1` | `eviction-atomic.integration.test.ts` | E2E Scenario 1 step 9 |
| `task-lifecycle-resilience.AC10.1` | `startup-wiring.test.ts` (`STALE_TASK_RESET_SQL` block) | E2E Scenario 3 |
| `task-lifecycle-resilience.AC11.1` | `heartbeat-scheduling.test.ts` (R-LR11 block) | — |
| R-LR5 | — | "R-LR5" table |
| R-LR6 | `validate-outbox-invariant.test.ts` (auxiliary — 27 tests on exported helpers) | "R-LR6" table |
| R-LR9 | `heal-stuck-tasks.test.ts` (logger fields verified via spy) | "R-LR9" table + E2E Scenario 2 step 3 |
| R-LR12 | — | "R-LR12" table |

### Notes

- The "null `modified_at`" branch of AC7.1 is unreachable in production because `hosts.modified_at` is `NOT NULL` in the schema. The test file documents this and asserts the equivalent observable behavior via "stale `modified_at` + null `online_at`" instead. Documented test deviation rather than a coverage gap.
- AC3.2 verifies the property structurally (no row ever reaches `{failed, claimed_by NOT NULL}`) rather than by simulating a SIGKILL mid-COMMIT. This is justified by R-LR3's `withTx`/`updateRowIf` atomicity contract: SQLite's BEGIN IMMEDIATE transaction guarantees an evicted row is atomically `running` (pre-write) or `pending` (post-write) regardless of when the process dies. The structural assertion would catch any regression where eviction wrote `failed` separately from clearing `claimed_by`.
