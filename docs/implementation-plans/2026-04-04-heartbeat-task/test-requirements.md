# Heartbeat Task — Test Requirements

Maps each acceptance criterion to specific automated tests or documented human verification.

---

## AC1: Heartbeat Scheduling

### heartbeat-task.AC1.1 — Heartbeat fires at clock-aligned boundaries (30min interval -> :00, :30)

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit |
| **Test file** | `packages/agent/src/__tests__/heartbeat-scheduling.test.ts` |
| **Phase** | 1 (Task 4) |
| **Description** | Given `interval_ms = 1_800_000` and a current time of e.g. 14:17, assert `next_run_at` resolves to 14:30. Uses a controlled `now` value for determinism. Verifies the `Math.ceil(now / effectiveInterval) * effectiveInterval` formula produces clean clock boundaries. |

### heartbeat-task.AC1.2 — Heartbeat self-reschedules to next boundary after completion

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit + Integration |
| **Test file (unit)** | `packages/agent/src/__tests__/heartbeat-scheduling.test.ts` |
| **Test file (integration)** | `packages/agent/src/__tests__/heartbeat-integration.test.ts` |
| **Phase** | 1 (Task 4), 3 (Task 4) |
| **Description** | **Unit:** After calling `rescheduleHeartbeat()`, assert task status is `"pending"` and `next_run_at` is the next clock-aligned boundary. **Integration:** Seed heartbeat, run scheduler tick with mock agent loop, verify task transitions running -> pending with correct `next_run_at`. |

### heartbeat-task.AC1.3 — Heartbeat self-reschedules after soft/hard errors and eviction

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit + Integration |
| **Test file (unit)** | `packages/agent/src/__tests__/heartbeat-scheduling.test.ts` |
| **Test file (integration)** | `packages/agent/src/__tests__/heartbeat-integration.test.ts` |
| **Phase** | 1 (Task 4), 3 (Task 4) |
| **Description** | **Unit:** Call `rescheduleHeartbeat()` on a task with status `"failed"`, verify status resets to `"pending"` and `next_run_at` set to next boundary. **Integration:** Configure mock agent loop to throw, run scheduler tick, verify task reschedules to pending with next clock boundary and `consecutive_failures` incremented. |

### heartbeat-task.AC1.4 — Arbitrary intervals work (15min, 45min, 2h)

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit |
| **Test file** | `packages/agent/src/__tests__/heartbeat-scheduling.test.ts` |
| **Phase** | 1 (Task 4) |
| **Description** | Test `rescheduleHeartbeat()` with `interval_ms` values of 900,000 (15min), 2,700,000 (45min), and 7,200,000 (2h). For each, verify `next_run_at` aligns to the correct clock boundary. |

### heartbeat-task.AC1.5 — Invalid interval_ms (0, negative) rejected at config validation

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit |
| **Test file** | `packages/shared/src/__tests__/config-schemas.test.ts` |
| **Phase** | 1 (Task 2) |
| **Description** | Parse `heartbeatConfigSchema` with `interval_ms: 0`, `interval_ms: -1`, and `interval_ms: 59_999`. All must fail Zod validation (minimum 60,000ms). Also verify valid values (1,800,000) parse successfully, missing heartbeat key defaults to `{ enabled: true, interval_ms: 1_800_000 }`, and `{ enabled: false }` parses without error. |

---

## AC2: Context Builder

### heartbeat-task.AC2.1 — Standing instructions loaded from `_heartbeat_instructions` memory key

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit + Integration |
| **Test file (unit)** | `packages/agent/src/__tests__/heartbeat-context.test.ts` |
| **Test file (integration)** | `packages/agent/src/__tests__/heartbeat-integration.test.ts` |
| **Phase** | 2 (Task 2), 3 (Task 4) |
| **Description** | **Unit:** Insert a `semantic_memory` row with `key = '_heartbeat_instructions'` and a custom value. Call `buildHeartbeatContext()`, verify output contains the custom instructions in the Standing Instructions section. **Integration:** Seed heartbeat + insert memory row, run scheduler tick, verify the user message in the heartbeat thread contains the instructions. |

### heartbeat-task.AC2.2 — Default prompt used when `_heartbeat_instructions` key is missing

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit |
| **Test file** | `packages/agent/src/__tests__/heartbeat-context.test.ts` |
| **Phase** | 2 (Task 2) |
| **Description** | Call `buildHeartbeatContext()` with no `_heartbeat_instructions` row in `semantic_memory`. Verify output contains the default instruction text (`"Review system state"`). |

### heartbeat-task.AC2.3 — Pending advisory titles listed in context

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit + Integration |
| **Test file (unit)** | `packages/agent/src/__tests__/heartbeat-context.test.ts` |
| **Test file (integration)** | `packages/agent/src/__tests__/heartbeat-integration.test.ts` |
| **Phase** | 2 (Task 2), 3 (Task 4) |
| **Description** | **Unit:** Insert 2 advisory rows with `status = 'proposed'` and `deleted = 0`. Call `buildHeartbeatContext()`, verify output contains `"Pending (2):"` and both titles. Also verify a soft-deleted advisory (`deleted = 1`) is excluded. **Integration:** Insert a proposed advisory, run heartbeat, verify the advisory title appears in the persisted user message. |

### heartbeat-task.AC2.4 — Advisory status changes since last run shown (approved/dismissed/applied)

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit |
| **Test file** | `packages/agent/src/__tests__/heartbeat-context.test.ts` |
| **Phase** | 2 (Task 2) |
| **Description** | Insert an advisory with `status = 'approved'` and `resolved_at` set after the `lastRunAt` parameter. Call `buildHeartbeatContext()`, verify output includes the advisory title and `"approved"` in the "Since last check" subsection. |

### heartbeat-task.AC2.5 — Recent task completions with status and error snippets included

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit |
| **Test file** | `packages/agent/src/__tests__/heartbeat-context.test.ts` |
| **Phase** | 2 (Task 2) |
| **Description** | Insert 2 task rows: one `status = 'completed'`, one `status = 'failed'` with a 500-char error message, both with `last_run_at` after the `lastRunAt` parameter. Verify both appear in output, the failed task includes an error snippet truncated to 150 chars. |

### heartbeat-task.AC2.6 — Per-thread activity counts since last run included

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit |
| **Test file** | `packages/agent/src/__tests__/heartbeat-context.test.ts` |
| **Phase** | 2 (Task 2) |
| **Description** | Insert a thread row and 3 message rows with `created_at` after `lastRunAt`. Verify output contains the thread title and `"3 new message(s)"`. Also test the 10-thread cap: insert 15 threads with recent messages, verify only 10 appear. |

### heartbeat-task.AC2.7 — Context builder handles zero advisories/tasks/threads gracefully

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit |
| **Test file** | `packages/agent/src/__tests__/heartbeat-context.test.ts` |
| **Phase** | 2 (Task 2) |
| **Description** | Call `buildHeartbeatContext()` with an empty database. Verify output contains `"Pending (0): None"`, `"No recent task completions."`, and `"No thread activity since last check."`. Also test null `lastRunAt` (first run) produces appropriate "First heartbeat run" messages. |

---

## AC3: Overlap Prevention

### heartbeat-task.AC3.1 — Running heartbeat blocks next claim via CAS

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit + Integration |
| **Test file (unit)** | `packages/agent/src/__tests__/heartbeat-seeding.test.ts` |
| **Test file (integration)** | `packages/agent/src/__tests__/heartbeat-integration.test.ts` |
| **Phase** | 1 (Task 6), 3 (Task 4) |
| **Description** | **Unit:** Seed heartbeat, manually UPDATE status to `"running"` via direct SQL. Simulate the CAS claim query (`UPDATE ... WHERE status = 'pending'`), verify `changes() === 0` (task not re-claimed). **Integration:** Seed heartbeat, set to running, run `phase1Schedule`, verify the running task is not claimed. |

### heartbeat-task.AC3.2 — Stuck heartbeat evicted after 5min, rescheduled to next boundary

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit + Integration |
| **Test file (unit)** | `packages/agent/src/__tests__/heartbeat-scheduling.test.ts` |
| **Test file (integration)** | `packages/agent/src/__tests__/heartbeat-integration.test.ts` |
| **Phase** | 1 (Task 4), 3 (Task 4) |
| **Description** | **Unit:** Call `rescheduleHeartbeat()` on an evicted task, verify `next_run_at` is set to the next clock boundary (not immediate). **Integration:** Set heartbeat to running with `heartbeat_at` > 5 minutes ago. Run `phase0Eviction`, verify task status transitions to failed then rescheduled to pending with next clock boundary, `consecutive_failures` incremented. |

### heartbeat-task.AC3.3 — Multi-host cluster claims heartbeat at-least-once per interval

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Integration |
| **Test file** | `packages/agent/src/__tests__/heartbeat-integration.test.ts` |
| **Phase** | 3 (Task 4) |
| **Description** | Simulate two scheduler instances sharing the same database (same process, two Scheduler objects). Seed one heartbeat task. Run `phase1Schedule` on both schedulers. Verify exactly one claims the task (CAS ensures single-writer). After the claiming scheduler completes the task, verify `next_run_at` is set for the next interval. |
| **Justification** | True multi-host testing with separate processes and network sync is an e2e concern. This integration test validates the CAS mechanism that underpins multi-host safety using a shared in-process database, which is sufficient for the concurrency invariant. |

---

## AC4: Configuration and Seeding

### heartbeat-task.AC4.1 — Heartbeat seeded on startup when config is absent (default enabled)

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit + Integration |
| **Test file (unit)** | `packages/agent/src/__tests__/heartbeat-seeding.test.ts` |
| **Test file (integration)** | `packages/agent/src/__tests__/heartbeat-integration.test.ts` |
| **Phase** | 1 (Task 6), 3 (Task 4) |
| **Description** | **Unit:** Call `seedHeartbeat(db, undefined, siteId)`. Verify a task row exists with `type = "heartbeat"`, `status = "pending"`, `trigger_spec` containing `interval_ms: 1_800_000`, `next_run_at` at a clock-aligned boundary, and `created_by = "system"`. **Integration:** Verify the bootstrap sequence calls `seedHeartbeat` and the task is schedulable. |

### heartbeat-task.AC4.2 — Heartbeat seeded with custom interval_ms from config

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit |
| **Test file** | `packages/agent/src/__tests__/heartbeat-seeding.test.ts` |
| **Phase** | 1 (Task 6) |
| **Description** | Call `seedHeartbeat(db, { enabled: true, interval_ms: 900_000 }, siteId)`. Verify `trigger_spec` contains `interval_ms: 900_000`. |

### heartbeat-task.AC4.3 — Seeding is idempotent (no duplicate heartbeat tasks created)

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit |
| **Test file** | `packages/agent/src/__tests__/heartbeat-seeding.test.ts` |
| **Phase** | 1 (Task 6) |
| **Description** | Call `seedHeartbeat()` twice with the same config. Query `SELECT COUNT(*) FROM tasks WHERE type = 'heartbeat'`, verify count is 1. Also verify that calling with different configs produces the same deterministic UUID (`deterministicUUID(BOUND_NAMESPACE, "heartbeat")`). |

### heartbeat-task.AC4.4 — `heartbeat.enabled: false` prevents seeding

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit |
| **Test file** | `packages/agent/src/__tests__/heartbeat-seeding.test.ts` |
| **Phase** | 1 (Task 6) |
| **Description** | Call `seedHeartbeat(db, { enabled: false, interval_ms: 1_800_000 }, siteId)`. Verify no heartbeat task row exists in the tasks table. |

---

## AC5: Quiescence Integration

### heartbeat-task.AC5.1 — Quiescence multiplier stretches heartbeat interval (5x at 4h idle)

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Unit + Integration |
| **Test file (unit)** | `packages/agent/src/__tests__/heartbeat-scheduling.test.ts` |
| **Test file (integration)** | `packages/agent/src/__tests__/quiescence-note.test.ts` |
| **Phase** | 1 (Task 4), 4 (Task 4) |
| **Description** | **Unit (Phase 1):** Call `rescheduleHeartbeat()` with `lastUserInteractionAt` set to 5 hours ago (tier 2, multiplier 5x). Verify effective interval is 150min (30min * 5x) and `next_run_at` aligns to a 150-minute boundary. Test all quiescence tiers: 0ms idle (multiplier 2x), 1h idle (3x), 4h idle (5x), 12h idle (10x). **Integration (Phase 4):** Seed heartbeat, set idle time to 5 hours, run full scheduler tick, verify `next_run_at` after completion aligns to the stretched interval. |

### heartbeat-task.AC5.2 — Quiescence note injected for heartbeat tasks when multiplier > 1

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Integration |
| **Test file** | `packages/agent/src/__tests__/quiescence-note.test.ts` |
| **Phase** | 4 (Task 3) |
| **Description** | Set `lastUserInteractionAt` to 2 hours ago (above QUIESCENCE_NOTE_THRESHOLD). Seed heartbeat task. Run scheduler tick with mock agent loop. Query messages for the heartbeat thread. Verify a system message exists containing `"Quiescence is active"`, the multiplier value, and the base/effective interval values. |

### heartbeat-task.AC5.3 — Quiescence note injected for cron tasks when multiplier > 1

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Integration |
| **Test file** | `packages/agent/src/__tests__/quiescence-note.test.ts` |
| **Phase** | 4 (Task 3) |
| **Description** | Set `lastUserInteractionAt` to 2 hours ago. Seed a cron task with a known schedule. Run scheduler tick. Query messages for the cron thread. Verify a system message exists containing `"Quiescence is active"` and the multiplier. |

### heartbeat-task.AC5.4 — No quiescence note when system is active (multiplier = 1)

| Field | Value |
|---|---|
| **Verification** | Automated |
| **Test type** | Integration + Unit |
| **Test file (integration)** | `packages/agent/src/__tests__/quiescence-note.test.ts` |
| **Test file (unit)** | `packages/agent/src/__tests__/quiescence-note.test.ts` |
| **Phase** | 4 (Task 3) |
| **Description** | **Integration:** Set `lastUserInteractionAt` to 5 minutes ago (below `QUIESCENCE_NOTE_THRESHOLD` of 30 minutes). Seed heartbeat task. Run scheduler tick. Query messages for the thread. Verify NO system message containing `"Quiescence is active"` exists. **Unit:** Verify `formatIdleDuration` helper outputs correct strings: 30min -> `"30m"`, 2h15m -> `"2h 15m"`, 0 -> `"0m"`. Verify `computeQuiescenceMultiplier` returns correct values at each tier boundary. |
| **Note** | The existing `QUIESCENCE_TIERS` has threshold 0 with multiplier 2, so the multiplier is never literally 1. AC5.4 is satisfied by the `QUIESCENCE_NOTE_THRESHOLD` (30 minutes of idle time required before the note is injected), not by the multiplier value itself. |

---

## Test File Summary

| Test file | Type | Phase | ACs covered |
|---|---|---|---|
| `packages/shared/src/__tests__/config-schemas.test.ts` | Unit | 1 | AC1.5 |
| `packages/agent/src/__tests__/heartbeat-scheduling.test.ts` | Unit | 1, 4 | AC1.1, AC1.2, AC1.3, AC1.4, AC3.2, AC5.1 |
| `packages/agent/src/__tests__/heartbeat-seeding.test.ts` | Unit | 1 | AC3.1, AC4.1, AC4.2, AC4.3, AC4.4 |
| `packages/agent/src/__tests__/heartbeat-context.test.ts` | Unit | 2 | AC2.1, AC2.2, AC2.3, AC2.4, AC2.5, AC2.6, AC2.7 |
| `packages/agent/src/__tests__/heartbeat-integration.test.ts` | Integration | 3 | AC1.2, AC1.3, AC2.1, AC2.3, AC3.1, AC3.2, AC3.3, AC4.1 |
| `packages/agent/src/__tests__/quiescence-note.test.ts` | Integration + Unit | 4 | AC5.1, AC5.2, AC5.3, AC5.4 |

All 20 acceptance criteria are covered by automated tests. No human verification is required.
