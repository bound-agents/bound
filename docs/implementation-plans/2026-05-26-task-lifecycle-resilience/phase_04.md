# Phase 4: Host-Liveness Eviction Selector (R-LR2 + R-LR7)

**Goal:** Tighten the eviction selector to require BOTH a stale `tasks.heartbeat_at` AND a stale lease-holder liveness signal (`COALESCE(hosts.modified_at, hosts.online_at)` past `HOST_OFFLINE_TIMEOUT`). Defends against a partition exceeding `EVICTION_TIMEOUT` by requiring the lease-holder to be observably offline before peers evict. R-LR7 is the state-driven version of the same gate. Add a supporting partial index `idx_tasks_running_heartbeat`.

**Architecture:** Replace the current eviction `SELECT FROM tasks WHERE status='running' AND deleted=0 AND heartbeat_at < ?` with `LEFT JOIN hosts ON hosts.site_id = tasks.claimed_by` and add `AND (h.site_id IS NULL OR COALESCE(h.modified_at, h.online_at) < ?host_offline_threshold)`. Define `HOST_OFFLINE_TIMEOUT = MAX(EVICTION_TIMEOUT, 2 × HOST_HEARTBEAT_INTERVAL)`. Extract `HOST_HEARTBEAT_INTERVAL` from its inline `120_000` literal at `host-heartbeat.ts:27` to a named exported constant. Add the partial index `idx_tasks_running_heartbeat ON tasks(heartbeat_at) WHERE status='running' AND deleted=0` (single-column on `heartbeat_at` because partial-WHERE pins both `status` and `deleted`).

**Tech Stack:** TypeScript, `bun:sqlite` (STRICT, WAL), `@bound/core`, `bun:test`. Multi-host integration tests follow the WsTestCluster pattern with random ports + `testRunId` per CONTRIBUTING.md.

**Scope:** 1 phase from a 5-phase RFC implementation (Phase 4 of 5). Per RFC §4.1, this phase ships AFTER Phase 3 (R-LR3 atomic eviction). R-LR1 from Phase 2 (synced `heartbeat_at`) is a hard prerequisite — without it, peer hosts have no path to the lease-holder's heartbeat truth and the host-liveness gate alone wouldn't be safe.

**Codebase verified:** 2026-05-26 via codebase-investigator. Key facts:
- Current eviction selector at `packages/agent/src/scheduler.ts:611-613`:
  ```sql
  SELECT * FROM tasks WHERE status = 'running' AND deleted = 0 AND heartbeat_at < ?
  ```
  Bound with `evictionTime = new Date(now.getTime() - EVICTION_TIMEOUT).toISOString()` at line 610. Uses ISO 8601 `toISOString()` per CONTRIBUTING gotcha. ✓
- `hosts` table at `packages/core/src/schema.ts:284-299`: `site_id TEXT PRIMARY KEY`, `modified_at TEXT NOT NULL`, `online_at TEXT` (nullable, set ONCE at startup), plus other columns (`host_name`, `version`, etc.).
- Host-heartbeat refresh at `packages/core/src/host-heartbeat.ts:22-56`: `startHostHeartbeat(db, siteId, options?)` calls `updateRow(db, "hosts", siteId, { modified_at: ts }, siteId)` at line 40. Default cadence `intervalMs = options?.intervalMs ?? 120_000` (line 27) — **inline, not a named export**. Phase 4 extracts.
- `HOST_OFFLINE_TIMEOUT` does NOT exist anywhere. Phase 4 introduces it as `Math.max(EVICTION_TIMEOUT, 2 * HOST_HEARTBEAT_INTERVAL)` = `Math.max(600_000, 240_000)` = `600_000` ms (10 min, equal to EVICTION_TIMEOUT for the current values).
- `COALESCE(modified_at, online_at)` precedent in relay/routing: `packages/core/src/platform-routing.ts:71` uses `ORDER BY COALESCE(modified_at, online_at) DESC`. Same pattern at `relay-router.ts` lines 56, 120, 256 and `model-resolution.ts:139`. Phase 4 mirrors.
- No existing index on `tasks(heartbeat_at)` (partial or otherwise) in `packages/core/src/schema.ts:659-723`. `idx_tasks_running_heartbeat` name is clear.
- `hosts.site_id` PK provides the implicit B-tree index that makes the `LEFT JOIN` constant-time.
- Multi-host test pattern: `packages/agent/src/__tests__/relay-stream.integration.test.ts` uses WsTestCluster with `spokeCount`, `basePort = 10000 + Math.floor(Math.random() * 40000)`, `testRunId = randomBytes(4).toString("hex")`.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### task-lifecycle-resilience.AC2: host-liveness eviction (R-LR2)

- **task-lifecycle-resilience.AC2.1 Success.** Given a running task on host A whose `heartbeat_at` has been stale for longer than `EVICTION_TIMEOUT`, and host A's `hosts.modified_at` is also stale beyond `HOST_OFFLINE_TIMEOUT`, when host B's phase0 eviction fires, then host B selects the row for eviction.
- **task-lifecycle-resilience.AC2.2 Failure mode.** Given a running task on host A whose `heartbeat_at` is stale, but host A's `hosts.modified_at` is fresh (within `HOST_OFFLINE_TIMEOUT`), when host B's phase0 eviction fires, then host B does NOT select the row for eviction.

### task-lifecycle-resilience.AC7: state-driven host-liveness gate (R-LR7)

- **task-lifecycle-resilience.AC7.1 Success.** Given the lease-holder's `COALESCE(hosts.modified_at, hosts.online_at)` is stale beyond `HOST_OFFLINE_TIMEOUT` from a peer's perspective, the peer is permitted to evict via R-LR2's selector. Given the signal is fresh, the peer is not permitted to evict regardless of `heartbeat_at` staleness.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Extract `HOST_HEARTBEAT_INTERVAL`; define `HOST_OFFLINE_TIMEOUT`; add eviction index

**Verifies:** None directly (infrastructure for AC2.*, AC7.1).

**Files:**
- Modify: `packages/core/src/host-heartbeat.ts:27` (extract inline `120_000` to named exported constant)
- Modify: `packages/core/src/index.ts` (re-export `HOST_HEARTBEAT_INTERVAL`)
- Modify: `packages/agent/src/scheduler.ts` (define `HOST_OFFLINE_TIMEOUT` near `EVICTION_TIMEOUT` at line 62)
- Modify: `packages/core/src/schema.ts` (add partial index near existing `tasks` indexes at lines 659-720)

**Implementation:**

**Step A: Extract `HOST_HEARTBEAT_INTERVAL`.** In `packages/core/src/host-heartbeat.ts`, near the top of the file, add:

```typescript
/**
 * Host-heartbeat refresh cadence. Bumps `hosts.modified_at` via outbox-routed `updateRow`
 * every HOST_HEARTBEAT_INTERVAL ms. Used by R-LR2's host-liveness gate as the freshness
 * signal that peers consult to decide whether the lease-holder is alive.
 */
export const HOST_HEARTBEAT_INTERVAL = 120_000;
```

Update `startHostHeartbeat` at line 27 to use the constant:

```typescript
const intervalMs = options?.intervalMs ?? HOST_HEARTBEAT_INTERVAL;
```

Re-export from `packages/core/src/index.ts` alongside other public exports:

```typescript
export { HOST_HEARTBEAT_INTERVAL, startHostHeartbeat } from "./host-heartbeat.ts";
```

(Match the existing export style in that file. If `startHostHeartbeat` is already exported, just add `HOST_HEARTBEAT_INTERVAL` to the same export line.)

**Step B: Define `HOST_OFFLINE_TIMEOUT`.** In `packages/agent/src/scheduler.ts`, near `EVICTION_TIMEOUT` at line 62 and `STUCK_THRESHOLD` (added in Phase 1), add:

```typescript
import { HOST_HEARTBEAT_INTERVAL } from "@bound/core";

/**
 * Host-offline threshold: the wall-clock window past which a peer's view of a
 * lease-holder's `hosts.modified_at` (or `hosts.online_at` fallback) is considered
 * stale enough that the peer is permitted to evict. Defined as MAX(EVICTION_TIMEOUT,
 * 2 × HOST_HEARTBEAT_INTERVAL) so the gate is at least as strict as heartbeat staleness
 * AND tolerant of one missed host-heartbeat tick. With current values
 * (EVICTION_TIMEOUT=600_000, HOST_HEARTBEAT_INTERVAL=120_000), this evaluates to
 * 600_000 ms (10 min). See docs/design/specs/2026-05-26-task-lifecycle-resilience.md
 * §3.1 R-LR2.
 */
const HOST_OFFLINE_TIMEOUT = Math.max(EVICTION_TIMEOUT, 2 * HOST_HEARTBEAT_INTERVAL);
```

**Step C: Add partial index.** In `packages/core/src/schema.ts`, near the existing `tasks` indexes at lines 659-720 (after `idx_tasks_pending_schedule`), add:

```sql
CREATE INDEX IF NOT EXISTS idx_tasks_running_heartbeat
ON tasks(heartbeat_at)
WHERE status = 'running' AND deleted = 0;
```

The partial-WHERE filter pins both `status` and `deleted`, so a multi-column `(status, heartbeat_at)` index would degenerate (RFC §4.4). Single-column on `heartbeat_at` is correct.

**Verification:**

```bash
bun run typecheck
bun test packages/core/src/__tests__/schema.test.ts  # whichever test exercises schema
```

**Commit:**
```bash
git add packages/core/src/host-heartbeat.ts packages/core/src/index.ts packages/core/src/schema.ts packages/agent/src/scheduler.ts
git commit -m "feat(core,agent): HOST_HEARTBEAT_INTERVAL/HOST_OFFLINE_TIMEOUT constants + idx_tasks_running_heartbeat (R-LR2)"
```
<!-- END_TASK_1 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 2-3) -->

<!-- START_TASK_2 -->
### Task 2: Rewrite eviction selector with host-liveness LEFT JOIN

**Verifies:** task-lifecycle-resilience.AC2.1, AC2.2, AC7.1.

**Files:**
- Modify: `packages/agent/src/scheduler.ts:610-613` (eviction `evictionTime` computation + SELECT)

**Implementation:**

Replace the current eviction selector with the host-liveness-gated query.

Current at scheduler.ts:610-613:

```typescript
const evictionTime = new Date(now.getTime() - EVICTION_TIMEOUT).toISOString();
const tasksToEvict = this.ctx.db
    .query("SELECT * FROM tasks WHERE status = 'running' AND deleted = 0 AND heartbeat_at < ?")
    .all(evictionTime) as Task[];
```

Updated:

```typescript
const evictionTime = new Date(now.getTime() - EVICTION_TIMEOUT).toISOString();
const hostOfflineThreshold = new Date(now.getTime() - HOST_OFFLINE_TIMEOUT).toISOString();
const tasksToEvict = this.ctx.db
    .query<Task, [string, string]>(
        `SELECT t.*
         FROM tasks t
         LEFT JOIN hosts h ON h.site_id = t.claimed_by
         WHERE t.status = 'running'
           AND t.deleted = 0
           AND t.heartbeat_at < ?
           AND (
               h.site_id IS NULL
               OR COALESCE(h.modified_at, h.online_at) < ?
           )`,
    )
    .all(evictionTime, hostOfflineThreshold) as Task[];
```

The `LEFT JOIN` permits eviction when the lease-holder is missing from `hosts` entirely (decommissioned host) — that's why the `OR h.site_id IS NULL` branch is required.

`SELECT t.*` (instead of `SELECT *`) is necessary to avoid column collisions between `tasks` and `hosts` columns of the same name (e.g., both have `modified_at`). Without `t.*`, the result rows have ambiguous column ordering.

**Note: ISO 8601 timestamps for both bindings.** Per CONTRIBUTING.md, never compare `datetime('now', '-N')` against JS-ISO timestamps. Both `evictionTime` and `hostOfflineThreshold` are computed in JS with `toISOString()`. The existing code already follows this convention.

**Testing:**

Tests must verify each AC listed above.

**Test file: `packages/agent/src/__tests__/eviction-host-liveness.test.ts` (new file).**

The host-liveness gate is testable as a single-process unit test against a fresh DB — no multi-host harness needed for AC2.1/AC2.2/AC7.1 because the SQL itself is the unit under test. The two-host integration variant (Task 3) covers end-to-end propagation.

For each AC, insert a `tasks` row + a `hosts` row (matching `claimed_by = hosts.site_id`) and run the new SELECT directly:

- **AC2.1 (success).** Insert a running task with `claimed_by = "site-A"`, `heartbeat_at = ISO(now - 30min)` (stale). Insert host row `site_id = "site-A"`, `modified_at = ISO(now - 30min)` (also stale beyond HOST_OFFLINE_TIMEOUT). Run the eviction SELECT. Assert: returns 1 row.
- **AC2.2 (failure mode).** Same setup but `hosts.modified_at = ISO(now - 30s)` (fresh). Run the eviction SELECT. Assert: returns 0 rows.
- **AC7.1 (state-driven).** Two parameterized cases:
  - Stale `modified_at`, NULL `online_at`: `COALESCE(modified_at, online_at) = stale modified_at` → eviction permitted.
  - NULL `modified_at`, fresh `online_at`: `COALESCE(modified_at, online_at) = fresh online_at` → eviction NOT permitted.
  - NULL `modified_at`, stale `online_at`: `COALESCE = stale online_at` → eviction permitted.
- **LEFT JOIN: missing host row.** Insert running task with `claimed_by = "decommissioned-site"`. Do NOT insert a `hosts` row for that site_id. Run the eviction SELECT. Assert: returns 1 row (the `OR h.site_id IS NULL` branch fires).

**Verification:**

```bash
bun run typecheck
bun test packages/agent/src/__tests__/eviction-host-liveness.test.ts
bun test packages/agent/src/__tests__/scheduler.integration.test.ts  # regression
```

**Commit:**
```bash
git add packages/agent/src/scheduler.ts packages/agent/src/__tests__/eviction-host-liveness.test.ts
git commit -m "fix(agent): host-liveness eviction gate via LEFT JOIN hosts (R-LR2)"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Two-host integration test for host-liveness gate

**Verifies:** task-lifecycle-resilience.AC2.1, AC2.2 end-to-end across two hosts via the WsTestCluster.

**Files:**
- Create: `packages/agent/src/__tests__/eviction-host-liveness.integration.test.ts`

**Implementation:**

A two-host integration test that exercises the full propagation path: host A's `hosts.modified_at` updates sync to host B; host B's eviction selector consults the synced row.

Pattern reference: `packages/agent/src/__tests__/relay-stream.integration.test.ts:186-192`. Use the WsTestCluster harness with `spokeCount: 2, basePort: 10000 + Math.floor(Math.random() * 40000), testRunId: randomBytes(4).toString("hex")`.

Sketch:

```typescript
it("AC2.2: peer does not evict while lease-holder host-heartbeat is fresh", async () => {
    const cluster = await createTestCluster({ spokeCount: 2, basePort: ..., testRunId: ... });
    const [hostA, hostB] = cluster.spokes;

    // Insert a running task claimed by host A with stale heartbeat_at.
    const taskId = randomUUID();
    insertRow(hostA.db, "tasks", {
        id: taskId,
        type: "cron",
        status: "running",
        claimed_by: hostA.siteId,
        heartbeat_at: ISO(now - 30min),  // stale
        lease_id: "L1",
        /* ... */
    }, hostA.siteId);

    // Bump host A's hosts.modified_at to fresh (simulate active host-heartbeat).
    updateRow(hostA.db, "hosts", hostA.siteId, { modified_at: ISO(now - 30s) }, hostA.siteId);

    // Wait for sync RTT.
    await cluster.waitForSync();

    // Run host B's eviction tick.
    await hostB.runPhase0Eviction();

    // Assert: host B did NOT evict the task. Row state on host B is still running.
    const rowB = hostB.db.query("SELECT status FROM tasks WHERE id=?").get(taskId);
    expect(rowB.status).toBe("running");

    await cluster.dispose();
});

it("AC2.1: peer evicts after lease-holder host-heartbeat goes stale", async () => {
    // Same setup, but bump host A's hosts.modified_at to ISO(now - 30min) (stale).
    // Expected: host B's eviction selects the row.
    // Run host B's eviction → row goes to `pending` (post-Phase-3 atomic recovery).
    // Assert via host B's local row state.
});
```

The `runPhase0Eviction` call may need to be exposed publicly on the Scheduler class (or accessed via `(scheduler as any).phase0Eviction()`) — match whatever pattern the existing scheduler integration tests use to invoke phase0 directly.

If the WsTestCluster harness doesn't yet exist (Phase 1 investigator referenced `relay-stream.integration.test.ts` patterns; verify during implementation), use the simpler in-process two-DB pattern from Phase 2 Task 4 (manual change_log replay). The host-liveness gate's correctness is verifiable both ways; Phase 4's value-add over the unit test in Task 2 is the cross-host propagation of `hosts.modified_at`.

**Verification:**

```bash
bun run typecheck
bun test packages/agent/src/__tests__/eviction-host-liveness.integration.test.ts
```

**Commit:**
```bash
git add packages/agent/src/__tests__/eviction-host-liveness.integration.test.ts
git commit -m "test(agent): two-host integration for R-LR2 host-liveness gate"
```
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_B -->

---

## Phase 4 Done When

- `HOST_HEARTBEAT_INTERVAL` extracted from inline literal to named exported constant in `@bound/core`.
- `HOST_OFFLINE_TIMEOUT` defined in scheduler.ts as `Math.max(EVICTION_TIMEOUT, 2 * HOST_HEARTBEAT_INTERVAL)`.
- Eviction selector at scheduler.ts:610-613 rewritten with `LEFT JOIN hosts ON hosts.site_id = tasks.claimed_by` and the dual stale-heartbeat + stale-host-liveness predicate. `SELECT t.*` to avoid column collisions.
- Partial index `idx_tasks_running_heartbeat ON tasks(heartbeat_at) WHERE status='running' AND deleted=0` added to schema.
- Tests pass: AC2.1 (eviction permitted when both stale), AC2.2 (no eviction when host-heartbeat fresh), AC7.1 (state-driven gate via COALESCE), plus the LEFT JOIN missing-host edge case. Two-host integration test exercises end-to-end propagation.
- `bun run typecheck` clean. `bun run lint` clean. `bun test --recursive` baseline regression: no new failures. Existing scheduler integration tests at scheduler.integration.test.ts still pass after the SELECT refactor.
