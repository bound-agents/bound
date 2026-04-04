# Heartbeat Task Test Plan

**Feature:** Heartbeat scheduled task with clock-aligned scheduling, context builder, and quiescence awareness
**Implementation plan:** `docs/implementation-plans/2026-04-04-heartbeat-task/`
**Date:** 2026-04-04

## Automated Test Coverage

All 20 acceptance criteria are covered by automated tests across 6 test files (118 tests total):

- `packages/shared/src/__tests__/config-schemas.test.ts` — AC1.5 (schema validation)
- `packages/agent/src/__tests__/heartbeat-scheduling.test.ts` — AC1.1-AC1.4, AC3.2, AC5.1
- `packages/agent/src/__tests__/heartbeat-seeding.test.ts` — AC3.1, AC4.1-AC4.4
- `packages/agent/src/__tests__/heartbeat-context.test.ts` — AC2.1-AC2.7
- `packages/agent/src/__tests__/heartbeat-integration.test.ts` — AC1.2, AC1.3, AC2.1, AC2.3, AC3.1, AC3.3
- `packages/agent/src/__tests__/quiescence-note.test.ts` — AC5.1-AC5.4

## Prerequisites

- A working `bound` deployment (compiled or dev mode via `bun packages/cli/src/bound.ts start`)
- Access to the SQLite database at `data/bound.db`
- A configured `model_backends.json` with at least one working LLM backend
- All tests passing: `bun test packages/agent packages/shared` (118 heartbeat tests, 0 failures)

## Phase 1: Bootstrap Seeding Verification

| Step | Action | Expected |
|------|--------|----------|
| 1 | Start bound with no `cron_schedules.json` (or one that omits the `heartbeat` key). | Bound starts without errors. |
| 2 | Query `SELECT id, type, status, trigger_spec, next_run_at, created_by FROM tasks WHERE type = 'heartbeat'` in `data/bound.db`. | Exactly 1 row: `type="heartbeat"`, `status="pending"`, `created_by="system"`, `trigger_spec` contains `"interval_ms":1800000`, `next_run_at` is a future ISO timestamp on a 30-minute boundary (minutes = 00 or 30, seconds = 00). |
| 3 | Stop bound. Add `"heartbeat": { "enabled": true, "interval_ms": 900000 }` to `cron_schedules.json`. Restart. | No duplicate heartbeat task. The existing row's `trigger_spec` retains the original 1800000 (INSERT OR IGNORE semantics). |
| 4 | Stop bound. Change to `"heartbeat": { "enabled": false }`. Restart. | No new heartbeat task created. Existing task remains (disable only prevents seeding, does not delete). |

## Phase 2: Context Builder Live Verification

| Step | Action | Expected |
|------|--------|----------|
| 1 | Insert a standing instruction: `INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, deleted) VALUES (lower(hex(randomblob(16))), '_heartbeat_instructions', 'Check sync health and memory usage.', 'manual', datetime('now'), datetime('now'), 0)`. | Row inserted. |
| 2 | Create a proposed advisory via the agent (`advisory --title "Disk space low" --detail "90% full"`). | Advisory row with `status="proposed"` exists in advisories table. |
| 3 | Wait for the next heartbeat run (or manually trigger by setting `next_run_at` to `datetime('now')` and `status='pending'`). | The heartbeat thread's user message contains: "Check sync health and memory usage" in the Standing Instructions section, "Disk space low" in the Advisories section. |

## Phase 3: Scheduling and Overlap Prevention

| Step | Action | Expected |
|------|--------|----------|
| 1 | Query `SELECT status, next_run_at, claimed_by FROM tasks WHERE type = 'heartbeat'` while a heartbeat is running. | `status="running"`, `claimed_by` is the local hostname. |
| 2 | While heartbeat is running, observe the scheduler log output (or query tasks table at the next tick interval). | No second heartbeat is claimed. The running task blocks CAS. |
| 3 | After the heartbeat completes, query the tasks table. | `status="pending"`, `next_run_at` is a future clock-aligned boundary. `consecutive_failures` remains 0 on success. |
| 4 | Simulate a stuck heartbeat: `UPDATE tasks SET status='running', heartbeat_at=datetime('now', '-10 minutes') WHERE type='heartbeat'`. Wait for the next scheduler tick (~15s). | Scheduler evicts the stuck task. `status` transitions through "failed" back to "pending". `consecutive_failures` increments by 1. `next_run_at` is set to a future clock-aligned boundary (not immediate). |

## Phase 4: Quiescence Behavior

| Step | Action | Expected |
|------|--------|----------|
| 1 | Leave the system idle for >30 minutes (no user messages sent). Wait for the next heartbeat run. | A system message in the heartbeat thread contains "Quiescence is active", the current multiplier (2x at minimum), the base interval, and the effective interval. |
| 2 | Send a user message (any thread). Wait for the next heartbeat run. | If less than 30 minutes have passed since the user message, NO quiescence note is injected in the heartbeat thread. |
| 3 | Leave the system idle for >4 hours. Check the heartbeat task's `next_run_at` after a run completes. | `next_run_at` should be approximately 150 minutes in the future (30min base * 5x multiplier), aligned to a 150-minute clock boundary. |

## End-to-End: Full Heartbeat Lifecycle

**Purpose:** Validate the complete heartbeat lifecycle from cold start through multiple cycles, including error recovery.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Start bound fresh (empty database). | Heartbeat task seeded automatically. `next_run_at` set to next 30-minute boundary. |
| 2 | Wait for the first heartbeat to fire. | A new thread is created (heartbeat thread). A user message with the context builder output is persisted. The agent loop runs and produces an assistant response. Task transitions: pending -> running -> pending. `thread_id` is now set on the task. |
| 3 | Wait for the second heartbeat to fire. | The SAME thread is reused (thread_id unchanged). New user + assistant messages appended. `run_count` incremented. |
| 4 | Kill the bound process while a heartbeat is running (simulate crash). Restart. | On restart: `phase0Eviction` detects the stuck running task (heartbeat_at stale). Task is evicted, failures incremented, rescheduled to next boundary. The heartbeat resumes on schedule. |

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|-----------|-------|
| Context quality | Automated tests verify structure, not semantic usefulness | Read the heartbeat thread messages after several runs. Verify the LLM response demonstrates it understood the advisory list, task statuses, and thread activity counts. |
| Quiescence UX | Need to observe real timing behavior | Leave system idle >1h, verify the agent acknowledges the quiescence note in its response (mentions being in a reduced-frequency mode or similar). |
| Multi-host scheduling | True multi-host requires separate processes + sync | Deploy two bound instances sharing a sync hub. Verify only one claims the heartbeat per interval. After completion, the other can claim the next cycle. |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 | heartbeat-scheduling.test.ts: "aligns to clock boundaries" | Phase 1, Step 2 |
| AC1.2 | heartbeat-scheduling.test.ts: "resets status to pending" | Phase 3, Step 3 |
| AC1.3 | heartbeat-scheduling.test.ts: "reschedules from failed status" | Phase 3, Step 4 |
| AC1.4 | heartbeat-scheduling.test.ts: AC1.4a/b/c | Phase 1, Step 3 |
| AC1.5 | config-schemas.test.ts: heartbeatConfigSchema suite | -- (schema-only) |
| AC2.1 | heartbeat-context.test.ts: "loads standing instructions" | Phase 2, Step 3 |
| AC2.2 | heartbeat-context.test.ts: "uses default instructions" | Phase 2, Step 3 |
| AC2.3 | heartbeat-context.test.ts: "lists pending advisories" | Phase 2, Step 3 |
| AC2.4 | heartbeat-context.test.ts: "shows advisory status changes" | Phase 2, Step 3 |
| AC2.5 | heartbeat-context.test.ts: "includes recent task completions" | E2E Step 2 |
| AC2.6 | heartbeat-context.test.ts: "includes per-thread activity counts" | E2E Step 2 |
| AC2.7 | heartbeat-context.test.ts: "gracefully handles empty database" | E2E Step 1 |
| AC3.1 | heartbeat-seeding.test.ts + heartbeat-integration.test.ts: CAS tests | Phase 3, Step 2 |
| AC3.2 | heartbeat-scheduling.test.ts: "reschedules evicted task" | Phase 3, Step 4 |
| AC3.3 | heartbeat-integration.test.ts: CAS mechanism | Multi-host manual verification |
| AC4.1 | heartbeat-seeding.test.ts: "seeds with defaults" | Phase 1, Step 2 |
| AC4.2 | heartbeat-seeding.test.ts: "seeds with custom interval" | Phase 1, Step 3 |
| AC4.3 | heartbeat-seeding.test.ts: "no duplicates" | Phase 1, Step 3 |
| AC4.4 | heartbeat-seeding.test.ts: "enabled false prevents seeding" | Phase 1, Step 4 |
| AC5.1 | heartbeat-scheduling.test.ts + quiescence-note.test.ts | Phase 4, Step 3 |
| AC5.2 | quiescence-note.test.ts: "injects quiescence note for heartbeat" | Phase 4, Step 1 |
| AC5.3 | quiescence-note.test.ts: "injects quiescence note for cron" | Phase 4, Step 1 |
| AC5.4 | quiescence-note.test.ts: "does not inject when idle < 30min" | Phase 4, Step 2 |
