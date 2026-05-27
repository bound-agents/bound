# RFC: Task Lifecycle Resilience

**Supplements:** `2026-03-20-base.md` §5 (tasks schema), §10.4 (cancellation, stuck tasks).
**Date:** 2026-05-26
**Status:** Draft

---

## 1. Problem Statement

### 1.1 Symptom

Webhook task `d2ecf42d` (the `bound-v2` GitHub webhook handler) wedged at `status='failed'` with claim metadata preserved (`claimed_by` = hub `6873167c`, `lease_id` = `f79a986b`, `claimed_at` = `2026-05-25T20:33:24Z`). Phase1 only claims rows in `pending`; the webhook dispatch path requires `pending`; no healer runs against `failed` event tasks. The webhook stopped processing until manual repair.

Timeline: claim at 20:33:24, running at 20:33:57, eviction CAS at 20:43:57 (`heartbeat_at` + `EVICTION_TIMEOUT`). No subsequent writes to the row. The CAS (`status: 'running' → 'failed'`) committed; the recovery write (`status: 'failed' → 'pending'`, claim cleared) did not.

Post-deploy, R-LR4 recovers `d2ecf42d` (and any sibling wedges with `claimed_at` older than `STUCK_THRESHOLD = 2 × EVICTION_TIMEOUT = 20 min`) on the first phase0 tick. No manual repair needed for the historical incident.

### 1.2 Three structural failure modes

The wedge is overdetermined. Three independent gaps in the eviction path each suffice to produce it.

#### 1.2.1 Eviction reads local-only state for a cluster-wide decision

The eviction selector is:

```sql
SELECT * FROM tasks WHERE status = 'running' AND deleted = 0 AND heartbeat_at < ?
```

`tasks.heartbeat_at` is updated outbox-exempt at three sites: the running-transition CAS that publishes the claim, a timer-driven refresh while the task runs, and an activity-driven refresh from the agent loop. The running-transition CAS does emit a change_log entry that includes `heartbeat_at`, so peers see the value once at claim time. The two refresh sites write only locally and emit no change_log entry.

Refresh cadence is `HEARTBEAT_INTERVAL = 30000` (30s) on the lease-holder. Peers see the running-transition value once, then never see another update. After `EVICTION_TIMEOUT = 600_000` (10 minutes) of wall clock, every peer's local view of `heartbeat_at` crosses the eviction threshold regardless of whether the lease-holder is alive and refreshing locally. Any reaper running on a peer can fire eviction against a healthy task. Peer hosts have no path to the lease-holder's heartbeat truth at all — the outbox-exempt annotation guarantees it.

`tasks.heartbeat_at` is also an undocumented exception. The project's documented narrow-exception list contains exactly one column today: `semantic_memory.last_accessed_at`. The justification given for that exception is "a per-host relevance hint with no cross-host correctness invariant." `tasks.heartbeat_at` violates the second clause — the eviction reaper IS cross-host correctness logic.

**Bootstrap crash recovery has the same shape.** A startup-time SQL sweep resets running rows whose `heartbeat_at` is stale:

```sql
UPDATE tasks SET status = 'pending', lease_id = NULL, claimed_by = NULL, claimed_at = NULL
WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)
```

The threshold is `now - 10 min` (matches `EVICTION_TIMEOUT`). The sweep is itself outbox-exempt (justified as crash recovery) and does NOT scope to `claimed_by = self_site_id`. Today this is "safe" only because `heartbeat_at` is local-only — peer-claimed rows on a booting host carry the running-transition timestamp from the change_log entry, typically older than 10 min in practice. Once R-LR1 makes `heartbeat_at` synced, the predicate becomes meaningful cross-host: a single host's bootstrap can reset healthy peer tasks if its own sync is behind the lease-holder's recent refreshes. This is the second site of failure mode 1.2.1 and is addressed by R-LR10.

#### 1.2.2 Recovery is non-atomic with the triggering decision

The eviction loop performs two writes per evicted task:

1. The `running → failed` CAS (with `error` set and `consecutive_failures` incremented) commits one outbox-routed change_log entry in its own transaction.
2. A type-specific reschedule helper is then called. For event tasks, that helper writes `failed → pending` with claim cleared — a second outbox-routed change_log entry in its own transaction.

Anything between commit 1 and commit 2 strands the row at `failed` with claim metadata preserved:

- Process kill (OS-level, OOM, SIGTERM during scheduler tick).
- Uncaught exception inside the re-read or update path of the helper.
- For peer-host evictions: a sync RTT delivering the running→failed entry to the lease-holder before the cleanup write is generated and replicated.

The two-write structure is the fix for an earlier stuck-state ("running and completed simultaneously" on heartbeat task `455a07c1`). Skipping the failed waypoint addresses that history rather than re-introducing it; see §2.3.

The eviction loop body is fully synchronous TypeScript with no `await` between the CAS and the reschedule helper call. An uncaught synchronous exception in any helper would propagate up through the for-loop into the scheduler tick's try/catch, leaving the row consistent with the wedge state because the CAS has already committed. The reschedule helpers' early-return guards (checking task type) trigger before any DB write, and the event-task helper's pre-write re-read could find the row deleted or cancelled — but for `d2ecf42d`, neither was true. The most plausible single-occurrence mechanism is process-level interruption (SIGTERM, OOM, panic) between the CAS commit and the helper's update. R-LR3 closes the wedge regardless of which mid-loop interruption mechanism actually caused the incident, because no intermediate state remains observable.

The cost: the failed→pending transition is a separate failure point.

#### 1.2.3 Healers exist asymmetrically

A heartbeat-only stuck-row healer already runs in phase0. It catches heartbeat-type tasks left in `(completed | failed | cancelled)` with a stale `next_run_at`, on the documented justification that the eviction-vs-completion race in phase0 can leave a heartbeat row terminal with `next_run_at` in the past, with no subsequent code path that resurrects it (phase1 only claims `pending`), and that without a healer a single wedge halts the cluster's heartbeat entirely until manual intervention.

The same shape applies to event tasks. Phase1 only claims `pending`; `failed` event tasks with claim metadata never re-enter the dispatch path. There is no event-task analog. Cron tasks recover naturally because their reschedule helper re-emits `next_run_at`, but the asymmetry itself is a documented invariant gap.

The healer-as-defense-in-depth principle was accepted for heartbeats. It was not generalized.

### 1.3 Lifecycle CAS coverage today

The `claimed → running` transition has a post-CAS lease re-verification (`verifyLeaseStillHeld`), invoked from the settle window after the CAS commits. It detects when a peer's claim has overwritten ours via LWW. Today's lifecycle CAS coverage:

| transition | defense |
|---|---|
| pending → claimed | local CAS only |
| claimed → running | local CAS + post-CAS lease re-verification |
| running → completed | local UPDATE; JS-level lease re-check before UPDATE; no SQL CAS on `lease_id` |
| running → failed (non-eviction) | local UPDATE; JS-level lease re-check before UPDATE; no SQL CAS on `lease_id` |
| running → failed (eviction) | local CAS only; no settle; reads outbox-exempt column |
| failed → pending (event reset) | local UPDATE in separate transaction from CAS |

Eviction is the only inbound transition whose CAS condition reads outbox-exempt state. It is one of two transitions with no defensive settle (claim being the other). The non-eviction `running → terminal` paths read `lease_id` then act on a JS-side conditional — adequate against the lease-holder's own concurrent activity, but a stale completion can race a peer's eviction reset (see §2.3 design note on `lease_id` CAS guards). The post-CAS lease re-verification's documented scope is heuristic: a sync RTT exceeding the settle wait still slips through. It is defense-in-depth, not consensus.

This RFC scopes "cluster-wide singleton coordination" down to lifecycle CAS specifically, and proposes the floor it should sit on.

---

## 2. Proposal

### 2.1 Four resilience principles

**P1: Lease-holder authority for lifecycle decisions.** Cross-host lifecycle CAS conditions must read cluster-replicated state. A lifecycle decision predicated on outbox-exempt state is incorrect by construction. Eviction is the canonical instance.

**P2: Atomic recovery.** A lifecycle CAS that requires a follow-up write to leave the row in a consistent state must commit both writes as one transaction with one change_log entry. No row may exit `running` to a non-terminal intermediate state mid-recovery.

**P3: Symmetric stuck-row healers.** Every task type whose claim path is gated on a non-terminal status must have a stuck-row healer that recovers rows with claim metadata preserved beyond a threshold. Healers are defense-in-depth for atomicity gaps, not the primary recovery path.

**P4: Documented local-only column policy.** Columns exempt from outbox sync must appear in the project's documented narrow-exception list with the same justification format. No undocumented exceptions. Exempt columns must carry no cross-host correctness invariant; they may not appear in lifecycle CAS conditions.

### 2.2 What this changes

| Area | Change |
|---|---|
| `tasks.heartbeat_at` semantics | Outbox-routed; refreshes generate change_log entries (R-LR1). |
| Eviction selector | Reads synced `heartbeat_at` AND verifies lease-holder liveness via `hosts.modified_at` (R-LR2). |
| Eviction recovery | Combined with CAS in single transaction; row goes `running → pending` directly with claim cleared and `consecutive_failures` bumped (R-LR3). |
| Non-eviction `running → terminal` writes | SQL UPDATE WHERE clauses extended to include `lease_id = ?caller_lease` (R-LR3). |
| Stuck-row healing | Generalized healer covers event and cron in addition to heartbeat (R-LR4). |
| Bootstrap crash recovery | Stale-task reset SQL scoped to `claimed_by = ?siteId` (R-LR10). |
| `rescheduleHeartbeat` writes | Routed through the change-log outbox (was raw outbox-exempt SQL); reschedule helper signature gains a `siteId` parameter (R-LR11). |
| Documented narrow-exception list | `tasks.heartbeat_at` removed from de facto exception (now synced); the list is the complete authoritative source (R-LR5, R-LR6). One-time exhaustive audit produces a documented disposition for every existing `outbox-exempt` annotation (R-LR12). |

### 2.3 Design notes

**Sync `heartbeat_at` rather than introduce a parallel column.** Drop the outbox-exempt annotation on the two refresh sites and route them through the canonical change-log outbox. Cost: at `HEARTBEAT_INTERVAL=30s` with N concurrent running tasks, N×120 change_log entries per hour from the timer-driven refresh; the activity-driven refresh can fire more often during long agent loops (cost detail in §4.4). No new column, no new table, no new sync semantics.

**Evict against synced liveness, not just stale heartbeat.** Even with `heartbeat_at` synced, a partition can leave a peer with a stale view if the partition exceeds `EVICTION_TIMEOUT`. Eviction therefore additionally requires the lease-holder's liveness signal to be stale. The right column is `hosts.modified_at`, which is refreshed every 120s by the host-heartbeat refresh loop via outbox-routed `updateRow`. `hosts.online_at` is set ONCE at host startup and never refreshed thereafter; it cannot serve as a periodic liveness signal. Existing relay-routing code already uses `COALESCE(modified_at, online_at)` on the same justification — kept fresh by heartbeat, falling back to online_at. Eviction reads the same. `HOST_OFFLINE_TIMEOUT` is set to `MAX(EVICTION_TIMEOUT, 2 × HOST_HEARTBEAT_INTERVAL)` so the gate is at least as strict as heartbeat staleness AND tolerant of one missed host-heartbeat tick.

**Skip the failed waypoint.** The current sequence `running → failed → pending` exists because `failed` carries semantic load: failure is recorded, error string set, `alert_threshold` checked, advisory possibly triggered. None of these require the row to occupy `failed` between writes — they only require `consecutive_failures++` and `error` set on the recovered row. The combined transaction writes `running → pending` directly with `consecutive_failures` incremented, `error` set, claim cleared, `next_run_at` set per the type-specific reschedule helper, and the alert-threshold check moved into the same transaction. The row is observably either `running` (work in progress) or `pending` (work to be redone), never the in-between state with claim still held.

**Lease CAS guards on non-eviction `running → terminal` paths.** R-LR3 clears `lease_id` as part of eviction, but the four non-eviction paths that write `running → failed` or `running → completed` (model-validation failure, soft error, hard error, and the happy-path `running → completed`) currently re-read `lease_id` in JS and use a conditional on the result, then UPDATE without including `lease_id` in the WHERE clause. A peer's eviction landing between the SELECT and the UPDATE produces a silent overwrite: the lease-holder's terminal status replaces the eviction's `pending`, the work disappears, and the cluster has no signal. R-LR3 extends those four UPDATEs with `AND lease_id = ?caller_lease` so the post-eviction row state is idempotent.

**Generic healer over per-type healers.** A generalized stuck-row healer selects rows where `claimed_by IS NOT NULL AND claimed_at < (now - STUCK_THRESHOLD) AND status IN ('failed', 'cancelled')`, dispatches to the type-specific reschedule helper. This covers all four `failed`-write paths (eviction, model-validation failure, soft error, hard error), not just eviction — the non-eviction soft/hard error paths preserve `claimed_by`/`claimed_at`/`lease_id` and rely on their in-loop reschedule helpers running to clear the claim. A process kill between the `failed` write and the helper produces the same wedge shape as eviction. Single-tick cost is one indexed query plus one update per recovered row.

**The host-liveness gate (R-LR2) supersedes a settle-window approach for eviction CAS.** No additional post-CAS lease re-verification is added.

**The `relay_inbox` SELECT lives inside the eviction transaction.** The existing event-task reset path performs a SELECT against `relay_inbox` gated on `task.thread_id` and `consecutive_failures`. R-LR3's combined transaction folds that SELECT inside the same transaction; the implementer must preserve this read when refactoring the event-task reset into a helper called by the eviction transaction. `relay_inbox` is a non-synced table (per invariant #3), so peer hosts may compute different `next_run_at` values for the same eviction — this is correct: each host's eviction reflects what it can locally see, and the LWW reducer reconciles via `modified_at`.

**R-LR3 reuses `updateRowIf`; the new helper is `withTx`.** Investigation showed `updateRowIf` already accepts `Partial<Row>` updates, emits a single change_log entry containing the full post-update row snapshot, and the LWW reducer applies all columns atomically on replay. The only missing piece is a transaction wrapper that lets the eviction loop read `relay_inbox` and call `updateRowIf` in the same SQLite transaction. The change is therefore a thin `withTx(db, fn)` utility in `@bound/core` that wraps `db.transaction()`. The eviction recovery opens `withTx`, reads `relay_inbox`, computes per-type `next_run_at`, then calls `updateRowIf` with the precondition `{ status: 'running' }` and the full superset of column updates: `status='pending'`, `error='evicted due to heartbeat timeout'`, `consecutive_failures=N+1`, `next_run_at=...`, `claimed_by=null`, `claimed_at=null`, `lease_id=null`. `modified_at` is injected by `updateRowIf`. The post-state for ALL task types is `pending` with claim cleared.

**Deferred tasks are treated like event tasks for recovery.** The RFC's original §3 lists reschedule semantics for cron, event, and heartbeat. Deferred tasks (the fourth task type in the codebase) have a per-failure backoff helper, `retryDeferredTask`, gated by `consecutive_failures < DEFERRED_MAX_RETRIES`. When R-LR3's eviction recovery or R-LR4's healer runs against a deferred task, the recovery clears claim metadata, sets `status='pending'`, and sets `next_run_at = now + DEFERRED_RETRY_BACKOFF_MS * (consecutive_failures + 1)` for parity with the existing per-failure backoff. After recovery, phase1 picks the row up on the next tick; if the deferred task continues to fail, `consecutive_failures` eventually caps at `DEFERRED_MAX_RETRIES` and the task remains `failed` permanently — no infinite loop, no special case.

**Lease CAS guard is the race-closer, not `modified_at`.** R-LR3's lease CAS guard on the four non-eviction `running → terminal` UPDATEs is what prevents a stale completion from silently overwriting a peer's eviction reset. `updateRowIf`'s automatic `modified_at` injection helps with LWW resolution between *peer hosts*, but on the *lease-holder's own* host, the SQL CAS (`AND lease_id = ?caller_lease`) is the primary correctness mechanism. With the lease CAS guard, the lease-holder's terminal UPDATE returns `changes = 0` after a peer eviction has cleared `lease_id`, and the row remains in the peer-eviction-set `pending` state.

**R-LR4 is a deploy-gap recovery and a defense-in-depth healer; it is NOT redundant.** Once R-LR3 ships, the eviction path no longer leaves wedges, so R-LR4 only ever fires for the four non-eviction `failed`-write paths (model-validation failure, soft error, hard error, plus any future failed-write paths). R-LR4 is canonical recovery during the deploy gap between R-LR4 ship and R-LR3 ship, and defense-in-depth thereafter.

**Index for the host-liveness eviction selector.** The R-LR2 SELECT filters `status='running' AND deleted=0 AND heartbeat_at < ?`. The supporting index is `idx_tasks_running_heartbeat ON tasks(heartbeat_at) WHERE status='running' AND deleted=0` — single-column on `heartbeat_at` because the partial-WHERE filter pins both `status` and `deleted`, so a multi-column `(status, heartbeat_at)` index would degenerate. The R-LR4 healer SELECT filters `claimed_by IS NOT NULL AND claimed_at < ? AND status IN ('failed', 'cancelled')`; supporting index `idx_tasks_claimed_at ON tasks(claimed_at) WHERE deleted=0 AND claimed_by IS NOT NULL`.

**Existing scheduler.ts CAS sites that use raw SQL + manual `createChangeLogEntry` are not exemptions.** Six call sites (`pending → claimed`, `claimed → running`, the three non-eviction `running → failed` paths, and the post-eviction reclaim) currently issue raw UPDATE inside a `db.transaction()` with an explicit `createChangeLogEntry` follow-up. They are correct today — the change_log entry IS emitted — but the `outbox-exempt` annotation comment is misleading. R-LR5 rewrites these annotations to make the structure self-documenting (e.g., `outbox-routed: explicit createChangeLogEntry follows the CAS UPDATE in this transaction`). R-LR12's audit confirms each rewritten site against the documented narrow-exception list.

### 2.4 Documented narrow exceptions to invariant #1 (post-RFC state)

The authoritative narrow-exception list lives in `CONTRIBUTING.md` (the project's `CLAUDE.md` is gitignored and is local-only operator context, not a source of truth that travels with the repo). After this RFC lands, the list contains exactly one entry (no change to the existing entry; just confirmation that the list is complete):

- `semantic_memory.last_accessed_at`, bumped on every cold context assembly (debounced 1h per entry). Justified because (a) per-host relevance hint with no cross-host correctness invariant, (b) routing through the outbox would advance `modified_at` and cascade into stale-child detection, (c) per-cold-assembly bumps would generate wasteful change-log volume.

`tasks.heartbeat_at` is removed from the de facto list (R-LR1 makes it synced). No new exceptions are added.

R-LR12 documents one **known-deferred** site separately: `relay-metrics.ts:48` writes `turns.relay_target` and `turns.relay_latency_ms` outbox-exempt. `turns` is a synced table, but the relay-metrics columns are local-only observability writes. This site is out of scope for this RFC (per the DoD, non-task fixes file separately) and is recorded with a TODO comment referencing the follow-up RFC. R-LR6's PR gate accepts known-deferred sites in this category provided they carry a TODO link.

---

## 3. Requirements (EARS Format)

Requirements use the prefix `R-LR` (Lifecycle Resilience).

### 3.1 Ubiquitous

**R-LR1.** The system shall route writes to `tasks.heartbeat_at` through the change-log outbox. The two refresh sites currently annotated outbox-exempt — the timer-driven refresh and the activity-driven refresh — shall instead generate change_log entries. Refresh cadence (`HEARTBEAT_INTERVAL = 30000`) is unchanged; coalescing is not introduced. The running-transition CAS already emits `heartbeat_at` in its change_log entry and is unaffected by R-LR1 beyond removing the now-misleading exemption comment.

**R-LR2.** The eviction selector in phase0 shall require BOTH a stale `heartbeat_at` AND a stale lease-holder liveness signal. Specifically:

```sql
SELECT t.* FROM tasks t
LEFT JOIN hosts h ON h.site_id = t.claimed_by
WHERE t.status = 'running'
  AND t.deleted = 0
  AND t.heartbeat_at < ?eviction_threshold
  AND (h.site_id IS NULL OR COALESCE(h.modified_at, h.online_at) < ?host_offline_threshold)
```

`HOST_OFFLINE_TIMEOUT` shall be set to `MAX(EVICTION_TIMEOUT, 2 × HOST_HEARTBEAT_INTERVAL)` so the host-liveness gate is at least as strict as heartbeat staleness. The `LEFT JOIN` permits eviction when the lease-holder is missing from `hosts` entirely (decommissioned host). `hosts.modified_at` is refreshed every 120s by the host-heartbeat refresh loop via outbox-routed writes; `hosts.online_at` is the not-yet-heartbeated fallback.

**R-LR3.** The eviction action shall commit the lifecycle transition and recovery in a single transaction with one change_log entry. The combined write shall:

- Move `status` from `running` directly to `pending` (skipping the `failed` waypoint).
- Set `error` to `'evicted due to heartbeat timeout'` and increment `consecutive_failures`.
- Clear `claimed_by`, `claimed_at`, `lease_id`.
- For event tasks: set `next_run_at` per the existing event-task reset retry logic. The existing `relay_inbox` SELECT in that path shall be folded into the same transaction.
- For cron tasks: set `next_run_at` per the cron reschedule helper.
- For heartbeat tasks: set `next_run_at` per the quiescence-aware boundary calculation in the heartbeat reschedule helper.
- For deferred tasks: set `next_run_at = now + DEFERRED_RETRY_BACKOFF_MS * (consecutive_failures + 1)` for parity with the existing `retryDeferredTask` linear backoff.

The combined transaction shall use a new helper `withTx(db, fn)` in `@bound/core` that wraps `db.transaction()`. Inside `withTx`, the eviction path performs any per-type read (e.g., the `relay_inbox` SELECT for event tasks) and then calls existing `updateRowIf` with precondition `{ status: 'running' }` and the full superset of column updates: `status='pending'`, `error='evicted due to heartbeat timeout'`, `consecutive_failures=N+1`, `next_run_at=...`, `claimed_by=null`, `claimed_at=null`, `lease_id=null`. `updateRowIf` injects `modified_at` and emits exactly one change_log entry containing the full post-update row snapshot. No new `updateRowIfAtomic` helper is introduced.

The failure-advisory trigger shall fire after the transaction commits, per invariant #6 (events after commit).

In addition, the four non-eviction `running → terminal status` UPDATEs (model-validation failure, soft error, hard error, plus the happy-path `running → completed`) shall extend their SQL WHERE clauses to include `AND lease_id = ?caller_lease`, where `?caller_lease` is the `lease_id` value the caller acquired at claim time. This guarantees a peer's eviction reset (which clears `lease_id`) cannot be silently overwritten by a stale completion from the original lease-holder.

**R-LR4.** A new `healStuckTasks(db, logger, lastUserInteractionAt)` function shall replace the existing heartbeat-only stuck-row healer and run from phase0 every tick. It shall select rows matching:

```sql
SELECT * FROM tasks
WHERE deleted = 0
  AND claimed_by IS NOT NULL
  AND claimed_at < ?stuck_threshold
  AND status IN ('failed', 'cancelled')
```

For each recovered row, it shall dispatch to the type-specific reschedule helper (cron, heartbeat, event-task reset, or deferred-task reset). All four task types — `cron`, `event`, `heartbeat`, `deferred` — are covered. This catches wedges produced by ANY of the four `failed`-write paths — eviction, model-validation failure, soft error, and hard error — not just the eviction path that R-LR3 closes. `STUCK_THRESHOLD` shall be set to `2 × EVICTION_TIMEOUT` to provide a margin over the primary recovery path. After R-LR3 ships, the eviction path is atomic and no longer leaves wedges; R-LR4 is then defense-in-depth for the four non-eviction `failed`-write paths.

The legacy `next_run_at < now`-only criterion in the heartbeat-only healer is subsumed by the claim-presence criterion: a heartbeat row with stale `next_run_at` and no claim metadata is recoverable through phase1's normal path and does not need a healer.

**R-LR5.** The outbox-exempt annotations on the timer-driven and activity-driven `heartbeat_at` refresh sites shall be removed. The annotation on the running-transition CAS site shall be rewritten to reflect that the change_log entry IS emitted (the existing comment is accurate but easy to misread as exemption).

**R-LR6.** Any future column proposed as outbox-exempt shall be added to the documented narrow-exception list with (a) the rationale that no cross-host correctness invariant depends on it, and (b) explicit confirmation that no lifecycle CAS condition reads it. PR review shall block on a missing entry. The documented list is the authoritative source of truth; an `outbox-exempt` comment in code references it but does not establish exemption on its own.

**R-LR10.** The bootstrap crash-recovery reset shall scope its UPDATE to rows owned by the booting host:

```sql
UPDATE tasks SET status = 'pending', lease_id = NULL, claimed_by = NULL, claimed_at = NULL
WHERE status = 'running'
  AND claimed_by = ?siteId
  AND (heartbeat_at IS NULL OR heartbeat_at < ?)
```

This change is required before R-LR1 ships (or in the same batch). Without it, once `heartbeat_at` becomes synced, a single host's bootstrap can reset healthy peer tasks if its sync is behind the lease-holder's recent refreshes. After R-LR10, the booting host only resets tasks it owns, and peer-claimed rows are out of scope regardless of `heartbeat_at` staleness.

**R-LR11.** The `rescheduleHeartbeat` helper shall route writes through the change-log outbox. It currently issues raw outbox-exempt SQL (`UPDATE tasks SET next_run_at = ?, status = 'pending'` with optional error clause) from three call sites: post-completion, eviction recovery, and hard-error rescheduling. Each shall be replaced with `updateRow(db, "tasks", task.id, { next_run_at, status: "pending", ...errorClause }, siteId)` (or `updateRowIf` when called from the eviction recovery path that already gates on `status='running'`). The helper signature shall gain a `siteId` parameter; callers thread it through. Once R-LR11 lands, multi-host heartbeat scheduling is correctly synced — peer hosts learn about reschedule decisions via the change_log instead of inferring from local-only state.

**R-LR12.** A one-time exhaustive audit of every `outbox-exempt` annotation in the repository shall produce a documented disposition for each site. The audit categorizes existing annotations as: (a) **justified-and-documented exception** (already in `CONTRIBUTING.md`'s narrow-exception list), (b) **fixed by this RFC** (e.g., heartbeat refresh sites under R-LR1, `rescheduleHeartbeat` under R-LR11), (c) **non-synced table** (valid by definition — `cluster_config`, `overlay_index`, `relay_*`, etc.), (d) **known-deferred** (synced-table writes not fixed by this RFC, recorded with a TODO referencing a follow-up RFC), or (e) **comment-only** (not an active annotation). Going forward, R-LR6's PR gate shall accept new `outbox-exempt` annotations only if they fit one of (a), (c), or (d) with TODO link. The narrow-exception list and audit disposition table live in `CONTRIBUTING.md` (the project's `CLAUDE.md` is gitignored and is local-only operator context, not authoritative). At RFC-close, the audit shall record exactly one known-deferred site: `relay-metrics.ts:48` (`turns.relay_target` and `turns.relay_latency_ms` writes).

### 3.2 State-driven

**R-LR7.** When a peer host's view of `COALESCE(hosts.modified_at, hosts.online_at)` for the lease-holder is stale (the lease-holder has not refreshed within `HOST_OFFLINE_TIMEOUT`), the peer shall be permitted to evict via R-LR2. When the lease-holder's liveness signal is fresh, the peer shall not evict regardless of `heartbeat_at` staleness.

**R-LR8.** When the eviction transition (R-LR3) commits, the row shall be eligible for normal phase1 claiming on the next tick. No additional code path shall be required to "unstick" the row.

### 3.3 Optional

**R-LR9.** The `healStuckTasks` healer shall log a warning per recovered row including `taskId`, `type`, `previousStatus`, `claimed_by`, and the elapsed time since `claimed_at`. Every healer fire signals an atomicity-gap incident: the primary recovery path missed.

### 3.4 Acceptance criteria

Acceptance criteria use the prefix `task-lifecycle-resilience.AC` and map 1:1 to test names in §4.2. Each R-LR* with observable behavior has at least one success scenario and one failure-mode scenario. R-LR5, R-LR6, R-LR9, and R-LR12 are doc / gate / logging requirements with no automated AC; they are validated by manual review.

#### task-lifecycle-resilience.AC1: heartbeat_at writes sync via outbox (R-LR1)

- **AC1.1 Success.** Given a running task on host A with a fresh lease, when the timer-driven heartbeat refresh fires, then a change_log entry is generated containing the new `heartbeat_at` value, and host B's `tasks.heartbeat_at` reflects the value after one sync RTT.
- **AC1.2 Success.** Given two close-in-time heartbeat refreshes on host A, when both change_log entries replicate to host B, then host B's row reflects the later `heartbeat_at` value (LWW resolution).

#### task-lifecycle-resilience.AC2: host-liveness eviction (R-LR2)

- **AC2.1 Success.** Given a running task on host A whose `heartbeat_at` has been stale for longer than `EVICTION_TIMEOUT`, and host A's `hosts.modified_at` is also stale beyond `HOST_OFFLINE_TIMEOUT`, when host B's phase0 eviction fires, then host B selects the row for eviction.
- **AC2.2 Failure mode.** Given a running task on host A whose `heartbeat_at` is stale, but host A's `hosts.modified_at` is fresh (within `HOST_OFFLINE_TIMEOUT`), when host B's phase0 eviction fires, then host B does NOT select the row for eviction.

#### task-lifecycle-resilience.AC3: atomic eviction recovery (R-LR3)

- **AC3.1 Success.** Given an evictable running event task, when phase0 eviction fires, then exactly one change_log entry is written for the row, the row's post-state is `{ status: 'pending', claimed_by: null, claimed_at: null, lease_id: null, consecutive_failures: prev+1, next_run_at: <event-task reset retry value> }`, and the row is eligible for phase1 claim on the next tick.
- **AC3.2 Failure mode.** Given a running task whose eviction transaction is mid-commit, when the process is killed (simulated via test hook), then on next process startup the row is observably either still `running` (transaction rolled back) or `pending` (transaction committed). No row is observed in the wedged state `{ status: 'failed', claimed_by: NOT NULL }`.
- **AC3.3 Failure mode.** Given a running task on host A with `lease_id = L1`, and a peer eviction on host B that has already reset the row to `pending` and cleared `lease_id`, when host A attempts its terminal `running → completed` UPDATE, then the UPDATE returns `changes = 0` (lease CAS guard rejects) and the row remains in `pending`.

#### task-lifecycle-resilience.AC4: stuck-row healer (R-LR4)

- **AC4.1 Success.** Given a row with `claimed_by IS NOT NULL`, `claimed_at < now - STUCK_THRESHOLD`, `status = 'failed'`, when phase0 healer fires, then the row is recovered: claim metadata cleared, `status = 'pending'`, `next_run_at` set per type-specific reschedule logic, exactly one change_log entry written.
- **AC4.2 Failure mode.** Given a row with `claimed_by IS NOT NULL`, `claimed_at >= now - STUCK_THRESHOLD` (recent claim), `status = 'failed'`, when phase0 healer fires, then the row is NOT recovered. Given a row with `claimed_by IS NULL` and `status = 'failed'` (no claim metadata to clear), the healer skips it.
- **AC4.3 Cross-path coverage.** The healer recovers wedges produced by EACH of the four `failed`-write paths — eviction, model-validation failure, soft error, hard error — verified by injecting a process-kill hook before each path's downstream cleanup.

#### task-lifecycle-resilience.AC7: state-driven host-liveness gate (R-LR7)

- **AC7.1 Success.** Given the lease-holder's `COALESCE(hosts.modified_at, hosts.online_at)` is stale beyond `HOST_OFFLINE_TIMEOUT` from a peer's perspective, the peer is permitted to evict via R-LR2's selector. Given the signal is fresh, the peer is not permitted to evict regardless of `heartbeat_at` staleness.

#### task-lifecycle-resilience.AC8: post-eviction phase1 eligibility (R-LR8)

- **AC8.1 Success.** Given the eviction transaction (R-LR3) commits for any task type, when phase1 runs on the next tick, then the row is selected for claim with no additional code path required.

#### task-lifecycle-resilience.AC10: bootstrap scoped to local rows (R-LR10)

- **AC10.1 Success.** Given two running rows with stale `heartbeat_at`, one owned by `?siteId` and one owned by a peer, when the bootstrap reset SQL runs with `?siteId` bound, then only the local row's `status` is reset to `pending`. The peer-owned row is unmodified.

#### task-lifecycle-resilience.AC11: heartbeat reschedule sync (R-LR11)

- **AC11.1 Success.** Given a heartbeat task that completes successfully, then `rescheduleHeartbeat` writes through the outbox and produces one change_log entry. Verified at all three call sites: post-completion, eviction recovery, hard-error reschedule.

---

## 4. Implementation Notes

### 4.1 Sequencing

Numerical order is not deployment order: R-LR4 ships before R-LR3 to recover existing wedges before closing the production gap, and R-LR10 ships with or before R-LR1 so synced `heartbeat_at` cannot trigger cross-host bootstrap resets.

1. **R-LR4 first** (heal stuck tasks, all four task types). Catches existing wedges left by the pre-fix code path AND any new wedges produced before R-LR3 lands. Runtime-only change, single-host deploy. Recovers `d2ecf42d` on first phase0 tick.
2. **R-LR10 + R-LR1 + R-LR11 batched** (bootstrap scoping + sync `heartbeat_at` + sync `rescheduleHeartbeat` writes). All in `scheduler.ts` and `bootstrap.ts`, all the same shape (raw outbox-exempt SQL → `updateRow` / `updateRowIf`). R-LR10 must land before or with R-LR1 to prevent cross-host bootstrap resets once `heartbeat_at` is synced. R-LR11 has no upstream dependency that R-LR1 doesn't already have. Single-host clusters work either way; multi-host needs the batch before R-LR2.
3. **R-LR3 next** (atomic recovery via `withTx` + `updateRowIf`, lease CAS guards on the four non-eviction terminal paths). Closes the primary atomicity gap and the `running → terminal` race. Adds the `withTx(db, fn)` helper to `@bound/core`.
4. **R-LR2 next** (host-liveness eviction). Defense in depth on top of synced `heartbeat_at`.
5. **R-LR5 / R-LR6 / R-LR12 last** (documentation cleanup, audit gate, one-time exhaustive disposition table). Cleanup pass once the runtime changes are in. R-LR5 rewrites the now-misleading `outbox-exempt` comments at the six raw-CAS-with-explicit-changelog sites. R-LR6 codifies the PR gate referencing `CONTRIBUTING.md`. R-LR12 produces the exhaustive disposition table for every existing annotation, recording the one known-deferred site (`relay-metrics.ts:48`).

### 4.2 Test plan

- **R-LR1 unit**: a write to `heartbeat_at` produces a change_log entry; the change-log read API returns it; the LWW reducer applies it on a peer.
- **R-LR2 integration**: two-host harness, claim task on host A, simulate host A's `heartbeat_at` freezing while keeping `hosts.modified_at` fresh, assert host B does NOT evict. Then advance host A's `hosts.modified_at` past `HOST_OFFLINE_TIMEOUT` and assert host B DOES evict.
- **R-LR3 unit**: eviction commit produces exactly one change_log entry with row going `running → pending`; failure to update is rolled back atomically (no partial state).
- **R-LR3 integration (atomicity)**: simulate process kill between CAS and reset (via a test hook that throws before the cleanup write); assert next process startup observes the row in `pending`, not stuck `failed`.
- **R-LR3 integration (lease CAS)**: claim task on host A with `lease_id = L1`, simulate peer eviction clearing `lease_id` and resetting status to `pending`, then attempt host A's terminal `running → completed/failed` UPDATE; assert the UPDATE returns `changes = 0` (CAS rejected) and the row remains in `pending`.
- **R-LR4 unit**: insert a row in `failed` with `claimed_at` older than `STUCK_THRESHOLD`; healer recovers it. Insert a row in `failed` without claim metadata; healer ignores it. Insert a row in `failed` with recent `claimed_at`; healer ignores it.
- **R-LR4 integration**: end-to-end claim → eviction → wedge (simulated) → healer → re-claim → completion.
- **R-LR4 cross-path**: assert healer recovers wedges produced by EACH of the four `failed`-write sites (eviction, model-validation, soft error, hard error) by injecting a process-kill hook before each helper call.
- **R-LR3 deferred-task integration**: claim a deferred task with `consecutive_failures = 2`; simulate eviction; assert the recovery sets `next_run_at = now + DEFERRED_RETRY_BACKOFF_MS * 3` (linear backoff parity with `retryDeferredTask`) and `consecutive_failures = 3`.
- **R-LR4 deferred coverage**: assert healer's dispatch table covers deferred tasks. Insert a wedged deferred row; healer recovers it with the same backoff calculation as R-LR3.
- **R-LR10 unit**: insert two `running` rows with stale `heartbeat_at`, one owned by `siteId`, one owned by a peer; run the bootstrap reset SQL with `?siteId` bound; assert only the local row was reset.
- **R-LR11 unit**: invoke `rescheduleHeartbeat` from each of its three call sites (post-completion, eviction recovery, hard-error reschedule) and assert each produces exactly one change_log entry containing the new `next_run_at` and `status='pending'`.
- **R-LR12 audit deliverable**: a markdown disposition table in `CONTRIBUTING.md` (or a dedicated section) enumerates every existing `outbox-exempt` annotation with its category (justified / fixed / non-synced / known-deferred / comment-only). At RFC close, the table contains exactly one known-deferred entry: `relay-metrics.ts:48`.
- **Regression**: existing heartbeat-eviction tests pass with the heartbeat-only healer replaced by `healStuckTasks`.

### 4.3 Backwards compatibility

No coordinated upgrade is required across the cluster, provided R-LR10 ships with or before R-LR1 (per §4.1). R-LR1 and R-LR11 are protocol-affecting changes, introducing change_log entries from previously-silent writes; pre-fix peers handle the additional column updates correctly via the existing LWW reducer. R-LR2 is a SQL change on the evicting host alone; peers don't need to know. R-LR3 reorders local writes within one host and adds a single `withTx` wrapper around the existing eviction loop body. R-LR4 is a per-tick local healer. R-LR5, R-LR6, and R-LR12 are documentation and PR-gate changes with no runtime effect.

### 4.4 Cost and noise budget

- **Change_log volume.** Steady-state write rate is dominated by message inserts and memory writes. Worst case for `heartbeat_at` syncing: ten concurrent running tasks at `HEARTBEAT_INTERVAL=30s` yield ≤1200 entries/hour from the timer-driven refresh. The activity-driven refresh can fire more often than 30s during long agent loops — a single 60-turn loop firing every few seconds adds up to ~1500/task/hour at the upper bound. Both bounds remain below the existing per-hour change_log rate during active periods. Coalescing is deferred (Q1) and can be added if the noise becomes load-bearing.
- **Healer cost.** One indexed query per phase0 tick. The supporting index `idx_tasks_claimed_at ON tasks(claimed_at) WHERE deleted=0 AND claimed_by IS NOT NULL` is not in the current schema; it must be added as part of R-LR4.
- **Eviction selector cost.** R-LR2's selector benefits from a partial index `idx_tasks_running_heartbeat ON tasks(heartbeat_at) WHERE status='running' AND deleted=0` — single-column on `heartbeat_at` because the partial-WHERE pins both `status` and `deleted` (a multi-column `(status, heartbeat_at)` would degenerate). Added in the R-LR2 batch.
- **Eviction join cost.** `hosts` is a small table (one row per cluster member); the `LEFT JOIN` is constant-time. No new index expectation beyond the existing `hosts.site_id` PK.
- **R-LR11 change_log cost.** `rescheduleHeartbeat` fires once per heartbeat completion / eviction recovery / hard-error retry. Steady-state rate is bounded by the heartbeat task's own cadence; even at the upper bound this is a small fraction of the R-LR1 refresh-write rate. No coalescing needed.
- **No interaction with stale-child detection.** R-LR1 bumps `tasks.modified_at` only; stale-child detection operates exclusively on `semantic_memory` rows linked by `summarizes` edges. `tasks` is outside the stale-children scan's scope.

---

## 5. Open Questions

**Q1.** Future optimization: debounce `heartbeat_at` refresh writes if change_log volume becomes load-bearing. R-LR1 ships at every-refresh cadence. The activity-driven refresh is the more likely candidate for coalescing; the timer-driven refresh is already 30s-bounded.

---

## 6. Migration

No data migration required. Existing `tasks.heartbeat_at` values are valid under both old (local-only) and new (synced) semantics — the column type and semantics are unchanged; only the write path changes.

Existing wedged rows (e.g., `d2ecf42d`) are recovered automatically by R-LR4 on the first phase0 tick after deployment, provided their `claimed_at` is older than `STUCK_THRESHOLD = 2 × EVICTION_TIMEOUT = 20 min`. For rows with very recent `claimed_at` (< 20 min old), manual `updateRow` clearing the claim remains the recovery path until the threshold elapses.

No coordinated cluster upgrade required (see §4.3), provided R-LR10 ships with or before R-LR1. Hosts may be rolled one at a time; partial deployment leaves the post-fix host correctly behaved while pre-fix hosts retain the original behavior.

---

## 7. Glossary

- **change-log outbox** — the project's invariant-#1 sync pattern: every write to a synced table emits one `change_log` row through `insertRow` / `updateRow` / `updateRowIf` / `softDelete`. Peers replay the log via reducers (LWW or append-only) to converge state. See `CONTRIBUTING.md` for the canonical description.
- **deferred task** — a task type that runs once per scheduling decision; on failure, `retryDeferredTask` increments `consecutive_failures` and reschedules with linear backoff until `consecutive_failures >= DEFERRED_MAX_RETRIES`.
- **eviction reaper / phase0 eviction** — the scheduler-tick code that selects `running` rows with stale heartbeats and resets them. After R-LR3, eviction is atomic (single transaction, single change_log entry).
- **`EVICTION_TIMEOUT`** — the wall-clock threshold (currently 600s = 10 min) past which a `running` row's stale `heartbeat_at` makes it eligible for eviction.
- **healer / `healStuckTasks`** — the generalized stuck-row recovery introduced by R-LR4. Replaces the heartbeat-only healer, covers all four task types, recovers wedges from any of the four `failed`-write paths.
- **`HOST_HEARTBEAT_INTERVAL`** — the cadence (currently 120s) at which the host-heartbeat refresh loop bumps `hosts.modified_at` via outbox-routed `updateRow`.
- **`HOST_OFFLINE_TIMEOUT`** — defined by R-LR2 as `MAX(EVICTION_TIMEOUT, 2 × HOST_HEARTBEAT_INTERVAL)`. The threshold past which a peer is allowed to evict on the basis that the lease-holder's host-liveness signal is stale.
- **host-liveness gate** — R-LR2's additional eviction precondition: `COALESCE(hosts.modified_at, hosts.online_at) < ?host_offline_threshold`. The `LEFT JOIN` permits eviction when the lease-holder is decommissioned.
- **lease CAS guard** — the `AND lease_id = ?caller_lease` clause added by R-LR3 to the four non-eviction `running → terminal` UPDATEs. Prevents the lease-holder's stale completion from silently overwriting a peer's eviction reset.
- **LWW reducer** — last-writer-wins reducer in `packages/sync/src/reducers.ts`. Compares `modified_at` between incoming change_log entry and current row; applies the entry if incoming is newer, atomically updating all columns.
- **lease holder** — the host whose `lease_id` matches the row's `lease_id`. Authoritative for that row's lifecycle until the lease is cleared (by completion, by peer eviction, or by R-LR4 healer).
- **outbox-exempt** — a comment annotation in code that historically marked a write as bypassing the change-log outbox. R-LR12 audits every annotation and assigns it a category (justified / fixed / non-synced / known-deferred / comment-only).
- **stuck threshold (`STUCK_THRESHOLD`)** — `2 × EVICTION_TIMEOUT` (= 1_200_000 ms = 20 min). The healer's eligibility window: rows with `claimed_at < now - STUCK_THRESHOLD` are eligible for recovery.
- **`updateRowIf`** — existing CAS-then-update helper in `@bound/core/change-log.ts`. Accepts `Partial<Row>` updates; emits exactly one change_log entry containing the full post-update row snapshot iff the precondition matched. Used by R-LR3.
- **`withTx`** — new thin transaction-wrapping utility in `@bound/core` (added by R-LR3). Wraps `db.transaction(fn)` and gives the caller a place to compose any sequence of reads + a single `updateRowIf` inside one SQLite transaction.
