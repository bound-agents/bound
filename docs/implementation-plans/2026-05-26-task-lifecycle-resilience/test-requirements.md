# Test Requirements: Task Lifecycle Resilience

Acceptance criteria from `docs/design/specs/2026-05-26-task-lifecycle-resilience.md` §3.4.
Each AC maps to either an automated test or a documented human-verification procedure.

## Automated Tests

### AC1.1: heartbeat_at change_log entry propagates to peer

- **Phase:** 2
- **Test files:**
  - `packages/agent/src/__tests__/heartbeat-at-sync.test.ts` (or extension of `heartbeat-scheduling.test.ts`) — single-DB change_log emission assertion (Phase 2 Task 2)
  - `packages/agent/src/__tests__/heartbeat-at-multi-host.integration.test.ts` — two-DB LWW replay (Phase 2 Task 4)
- **Type:** unit + integration
- **Test name(s):**
  - "AC1.1: timer-driven heartbeat refresh emits change_log entry containing new heartbeat_at"
  - "AC1.1: host B's tasks.heartbeat_at reflects new value after change_log replay"
- **Verifies:** Given a running task on host A with a fresh lease, when the timer-driven heartbeat refresh fires, then a change_log entry is generated containing the new `heartbeat_at` value, and host B's `tasks.heartbeat_at` reflects the value after one sync RTT.

### AC1.2: LWW resolution between close-in-time heartbeat refreshes

- **Phase:** 2
- **Test file:** `packages/agent/src/__tests__/heartbeat-at-multi-host.integration.test.ts` (Phase 2 Task 4)
- **Type:** integration
- **Test name(s):** "AC1.2: two close-in-time refreshes resolve to later heartbeat_at on host B (LWW, replay-order independent)"
- **Verifies:** Given two close-in-time heartbeat refreshes on host A, when both change_log entries replicate to host B, then host B's row reflects the later `heartbeat_at` value (LWW resolution).

### AC2.1: host-liveness eviction permitted when both signals stale

- **Phase:** 4
- **Test files:**
  - `packages/agent/src/__tests__/eviction-host-liveness.test.ts` (Phase 4 Task 2) — unit-level SQL assertion
  - `packages/agent/src/__tests__/eviction-host-liveness.integration.test.ts` (Phase 4 Task 3) — two-host end-to-end
- **Type:** unit + integration
- **Test name(s):**
  - "AC2.1: eviction selector returns row when heartbeat_at and hosts.modified_at are both stale"
  - "AC2.1: peer evicts after lease-holder host-heartbeat goes stale"
- **Verifies:** Given a running task on host A whose `heartbeat_at` has been stale for longer than `EVICTION_TIMEOUT`, and host A's `hosts.modified_at` is also stale beyond `HOST_OFFLINE_TIMEOUT`, when host B's phase0 eviction fires, then host B selects the row for eviction.

### AC2.2: no eviction while host-heartbeat is fresh

- **Phase:** 4
- **Test files:**
  - `packages/agent/src/__tests__/eviction-host-liveness.test.ts` (Phase 4 Task 2)
  - `packages/agent/src/__tests__/eviction-host-liveness.integration.test.ts` (Phase 4 Task 3)
- **Type:** unit + integration
- **Test name(s):**
  - "AC2.2: eviction selector returns 0 rows when hosts.modified_at is fresh despite stale heartbeat_at"
  - "AC2.2: peer does not evict while lease-holder host-heartbeat is fresh"
- **Verifies:** Given a running task on host A whose `heartbeat_at` is stale, but host A's `hosts.modified_at` is fresh (within `HOST_OFFLINE_TIMEOUT`), when host B's phase0 eviction fires, then host B does NOT select the row for eviction.

### AC3.1: atomic eviction recovery post-state and single change_log entry

- **Phase:** 3
- **Test file:** `packages/agent/src/__tests__/eviction-atomic.integration.test.ts` (Phase 3 Task 2)
- **Type:** integration
- **Test name(s):** "AC3.1: eviction of running event task produces single change_log entry, post-state {pending, claim cleared, consecutive_failures+1, next_run_at backoff}, row eligible for phase1 claim"
- **Verifies:** Given an evictable running event task, when phase0 eviction fires, then exactly one change_log entry is written for the row, the row's post-state is `{ status: 'pending', claimed_by: null, claimed_at: null, lease_id: null, consecutive_failures: prev+1, next_run_at: <event-task reset retry value> }`, and the row is eligible for phase1 claim on the next tick.

### AC3.2: no wedged failed-with-claim state on simulated process kill

- **Phase:** 3
- **Test file:** `packages/agent/src/__tests__/eviction-process-kill.integration.test.ts` (Phase 3 Task 4)
- **Type:** integration
- **Test name(s):** "AC3.2: does not produce a wedged failed-with-claim state on process kill mid-eviction"
- **Verifies:** Given a running task whose eviction transaction is mid-commit, when the process is killed (simulated via test hook), then on next process startup the row is observably either still `running` (transaction rolled back) or `pending` (transaction committed). No row is observed in the wedged state `{ status: 'failed', claimed_by: NOT NULL }`.

### AC3.3: lease CAS guards reject stale terminal writes

- **Phase:** 3
- **Test file:** `packages/agent/src/__tests__/lease-cas-guard.test.ts` (Phase 3 Task 3) — also asserted within `eviction-atomic.integration.test.ts` per Phase 3 Task 2
- **Type:** integration
- **Test name(s):**
  - "AC3.3: happy-path completion UPDATE returns changes=0 after peer eviction cleared lease_id"
  - "AC3.3: model-validation failure UPDATE rejected by lease CAS guard"
  - "AC3.3: soft-error UPDATE rejected by lease CAS guard"
  - "AC3.3: hard-error UPDATE rejected by lease CAS guard"
- **Verifies:** Given a running task on host A with `lease_id = L1`, and a peer eviction on host B that has already reset the row to `pending` and cleared `lease_id`, when host A attempts its terminal `running → completed` UPDATE, then the UPDATE returns `changes = 0` (lease CAS guard rejects) and the row remains in `pending`.

### AC4.1: stuck-row healer recovers eligible rows per task type

- **Phase:** 1
- **Test file:** `packages/agent/src/__tests__/heal-stuck-tasks.test.ts` (Phase 1 Task 2)
- **Type:** unit
- **Test name(s):** "AC4.1: healStuckTasks recovers stuck row for type=<cron|heartbeat|event|deferred>" (one per task type), each asserting `status='pending'`, claim cleared (where applicable), `next_run_at` non-null, exactly one change_log entry, deferred backoff formula matching `retryDeferredTask`
- **Verifies:** Given a row with `claimed_by IS NOT NULL`, `claimed_at < now - STUCK_THRESHOLD`, `status = 'failed'`, when phase0 healer fires, then the row is recovered: claim metadata cleared, `status = 'pending'`, `next_run_at` set per type-specific reschedule logic, exactly one change_log entry written.

### AC4.2: healer ignores rows with recent claims or no claim metadata

- **Phase:** 1
- **Test file:** `packages/agent/src/__tests__/heal-stuck-tasks.test.ts` (Phase 1 Task 2)
- **Type:** unit
- **Test name(s):**
  - "AC4.2: healStuckTasks does not recover rows with recent claimed_at"
  - "AC4.2: healStuckTasks skips rows with null claim metadata"
- **Verifies:** Given a row with `claimed_by IS NOT NULL`, `claimed_at >= now - STUCK_THRESHOLD` (recent claim), `status = 'failed'`, when phase0 healer fires, then the row is NOT recovered. Given a row with `claimed_by IS NULL` and `status = 'failed'`, the healer skips it.

### AC4.3: cross-path coverage of all four failed-write paths

- **Phase:** 1
- **Test file:** `packages/agent/src/__tests__/heal-stuck-tasks-cross-path.integration.test.ts` (Phase 1 Task 4)
- **Type:** integration
- **Test name(s):**
  - "AC4.3: recovers wedge from eviction path"
  - "AC4.3: recovers wedge from model-validation path"
  - "AC4.3: recovers wedge from soft-error path"
  - "AC4.3: recovers wedge from hard-error path"
- **Verifies:** The healer recovers wedges produced by EACH of the four `failed`-write paths — eviction, model-validation failure, soft error, hard error — verified by injecting the wedge state for each path's specific `error` text and `task.type`.

### AC7.1: state-driven host-liveness gate via COALESCE

- **Phase:** 4
- **Test file:** `packages/agent/src/__tests__/eviction-host-liveness.test.ts` (Phase 4 Task 2)
- **Type:** unit
- **Test name(s):**
  - "AC7.1: stale modified_at + null online_at — eviction permitted"
  - "AC7.1: null modified_at + fresh online_at — eviction not permitted"
  - "AC7.1: null modified_at + stale online_at — eviction permitted"
  - "AC7.1: LEFT JOIN missing host row (decommissioned site) — eviction permitted"
- **Verifies:** Given the lease-holder's `COALESCE(hosts.modified_at, hosts.online_at)` is stale beyond `HOST_OFFLINE_TIMEOUT` from a peer's perspective, the peer is permitted to evict via R-LR2's selector. Given the signal is fresh, the peer is not permitted to evict regardless of `heartbeat_at` staleness.

### AC8.1: post-eviction phase1 eligibility

- **Phase:** 3
- **Test file:** `packages/agent/src/__tests__/eviction-atomic.integration.test.ts` (Phase 3 Task 2)
- **Type:** integration
- **Test name(s):** "AC8.1: post-eviction row is eligible for phase1 claim on the next tick"
- **Verifies:** Given the eviction transaction (R-LR3) commits for any task type, when phase1 runs on the next tick, then the row is selected for claim with no additional code path required. Asserted by invoking the actual phase1 selector and observing `status='claimed'`, `claimed_by=<evicting host's siteId>`, `lease_id` populated.

### AC10.1: bootstrap reset scoped to local rows

- **Phase:** 2
- **Test file:** `packages/cli/src/__tests__/bootstrap-stale-reset.test.ts` (or extension of `startup-wiring.test.ts` per Phase 2 Task 1)
- **Type:** unit
- **Test name(s):** "AC10.1: STALE_TASK_RESET_SQL resets only rows owned by ?siteId; peer-owned rows unmodified"
- **Verifies:** Given two running rows with stale `heartbeat_at`, one owned by `?siteId` and one owned by a peer, when the bootstrap reset SQL runs with `?siteId` bound, then only the local row's `status` is reset to `pending`. The peer-owned row is unmodified.

### AC11.1: rescheduleHeartbeat outbox routing at all named call sites

- **Phase:** 2
- **Test file:** `packages/agent/src/__tests__/reschedule-heartbeat-outbox.test.ts` (or extension of `heartbeat-scheduling.test.ts` per Phase 2 Task 3)
- **Type:** unit
- **Test name(s):**
  - "AC11.1: rescheduleHeartbeat at post-completion produces one change_log entry with status=pending and error cleared"
  - "AC11.1: rescheduleHeartbeat at eviction recovery produces one change_log entry; error not cleared"
  - "AC11.1: rescheduleHeartbeat at hard-error reschedule (model-validation context) produces one change_log entry; error not cleared"
- **Verifies:** Given a heartbeat task that completes successfully, then `rescheduleHeartbeat` writes through the outbox and produces one change_log entry. Verified at all three named call sites: post-completion, eviction recovery, hard-error reschedule.

## Human-Verification Items

Per RFC §3.4: "R-LR5, R-LR6, R-LR9, and R-LR12 are doc / gate / logging requirements with no automated AC; they are validated by manual review."

### R-LR5: Annotation rewrites at raw-CAS sites

- **Phase:** 5 (Task 1)
- **Procedure:**
  1. `grep -rn "outbox-exempt" packages/ scripts/` — list every surviving annotation.
  2. For each scheduler.ts raw-CAS site listed in Phase 5 Task 1's mapping table (lines 710, 800, 1138, 1291, 1423, 1530), confirm the annotation now reads `outbox-routed: explicit createChangeLogEntry follows ...` per the prescribed text.
  3. Confirm the same rewrite at `bootstrap.ts:368, 391`, `leader-election.ts:73`, `drain.ts:42, 46, 83, 87, 101`, `set-hub.ts:125, 129`, `config-reload.ts:69, 73`, `stop-resume.ts:33, 37, 66`.
  4. Confirm the heartbeat-refresh annotations at `scheduler.ts:549, 1226, 311` are absent (already removed by Phase 2).
- **Justification:** No runtime behavior to verify; the change is comment text only.

### R-LR6: PR gate referencing CONTRIBUTING.md

- **Phase:** 5 (Task 2)
- **Procedure:**
  1. Read `scripts/validate-outbox-invariant.ts`; confirm `// outbox-routed` is in the skip-pattern list and that `// outbox-exempt` lines now trigger a CONTRIBUTING.md cross-check per the matching strategy in Phase 5 Task 2.
  2. Run `bun test scripts/__tests__/validate-outbox-invariant.test.ts` and confirm all five fixture cases pass (outbox-routed not flagged; outbox-exempt with matching CONTRIBUTING.md row not flagged; outbox-exempt without match flagged; outbox-exempt on non-synced table not flagged; outbox-exempt on synced table without TODO and without CONTRIBUTING.md entry flagged).
  3. Run `bun run scripts/validate-outbox-invariant.ts` against the post-RFC repo state; confirm exit code 0.
- **Justification:** The validator's correctness is asserted by its own unit tests; the PR-gate property is structural (CI invocation) and verified by inspection of `.github/workflows/ci.yml`.

### R-LR9: Per-recovered-row warning logs

- **Phase:** 1 (Task 2)
- **Procedure:**
  1. Read `healStuckTasks` in `packages/agent/src/scheduler.ts`; confirm the `logger.warn("[scheduler] healStuckTasks: recovering stuck row", { taskId, type, previousStatus, claimedBy, elapsedMs })` call precedes each dispatch.
  2. Optionally run `heal-stuck-tasks.test.ts` with a spy logger and assert the five fields are present in the structured log object.
- **Justification:** No AC asserts log content directly; field presence is structural and verifiable by code inspection. Spy-logger assertion is optional defense-in-depth.

### R-LR12: Audit disposition table

- **Phase:** 5 (Tasks 3 and 4)
- **Procedure:**
  1. Open `CONTRIBUTING.md` and locate the "Documented Narrow Exceptions to Invariant #1" section; confirm exactly one entry: `semantic_memory.last_accessed_at`.
  2. Locate the "Audit Disposition Table for `outbox-exempt` Annotations" section; confirm every row from the Phase 5 Task 3 seed table is present with a category in `{(a), (b), (c), (d), (e)}`.
  3. Run `grep -rn "outbox-exempt" packages/ scripts/` and confirm every surviving annotation has a corresponding row in the disposition table (file:line match or file-only match per the matching strategy).
  4. Confirm the known-deferred discrepancies surfaced in Phase 5 Task 4 (`overlay-scanner.ts:128, 148, 168` and `task-resolution.ts:428`) are resolved: each either has a TODO link adjacent (Path B), has been converted to outbox helpers (Path A), or has been deleted (Path C for dead code).
  5. Run `bun run scripts/validate-outbox-invariant.ts`; confirm exit code 0.
- **Justification:** Disposition is a documentation deliverable; correctness is structural (every annotation accounted for) and is verified by grep-vs-table reconciliation rather than runtime behavior.
