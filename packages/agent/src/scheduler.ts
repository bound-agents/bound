import { randomUUID } from "node:crypto";
import type { AppContext } from "@bound/core";
import {
	HOST_HEARTBEAT_INTERVAL,
	createChangeLogEntry,
	insertRow,
	markProcessed,
	updateRow,
	updateRowIf,
	withTx,
} from "@bound/core";
import type { PlatformRegisteredTool } from "@bound/platforms";
import { BOUND_NAMESPACE, deterministicUUID, formatError, parseJsonUntyped } from "@bound/shared";
import type { Task } from "@bound/shared";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import { createAdvisory } from "./advisories";
import type { AgentLoop } from "./agent-loop";
import { buildEventWakeupContent } from "./event-payload";
import { buildHeartbeatContext } from "./heartbeat-context";
import {
	canRunHere,
	computeFiringKey,
	computeNextRunAt,
	deriveFiringArtifactId,
	deriveFiringWakeupIds,
	verifyLeaseStillHeld,
} from "./task-resolution";
import type { AgentLoopConfig } from "./types";

const getTracer = () => trace.getTracer("bound.scheduler");

const LEASE_DURATION = 300000; // 5 minutes

/**
 * Settle window before re-verifying lease ownership in `runTask`.
 *
 * The phase1/phase3 CAS updates (`pending → claimed → running`) are local-only
 * on each replica's SQLite. In a multi-master cluster, two hosts polling
 * concurrently can each succeed at their local CAS. After this delay we
 * re-read the row; LWW resolution should have converged on a single winner
 * and the loser bails before any agent-loop side effects.
 *
 * Heuristic, not consensus — tracks sync RTT. Tests can set
 * BOUND_LEASE_VERIFY_SETTLE_MS=0 to disable the wait and exercise the
 * verification path synchronously.
 */
const LEASE_VERIFY_SETTLE_MS = (() => {
	const raw = process.env.BOUND_LEASE_VERIFY_SETTLE_MS;
	if (raw === undefined) return 250;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 250;
})();

/**
 * Extracts the raw cron expression from a trigger_spec string.
 * The schedule command stores trigger_spec as JSON like {"type":"cron","expression":"0 * * * *"},
 * but seedCronTasks stores raw cron strings like "0 * * * *".
 * This helper handles both formats.
 */
function extractCronExpression(triggerSpec: string): string {
	const result = parseJsonUntyped(triggerSpec, "trigger_spec");
	if (result.ok && typeof result.value === "object" && result.value !== null) {
		const obj = result.value as Record<string, unknown>;
		if (typeof obj.expression === "string") {
			return obj.expression;
		}
	}
	// Not JSON or no expression field — treat as raw cron expression
	return triggerSpec;
}
const EVICTION_TIMEOUT = 600_000; // 10 minutes

/**
 * Host-offline threshold: the wall-clock window past which a peer's view of a
 * lease-holder's `hosts.modified_at` (or `hosts.online_at` fallback) is considered
 * stale enough that the peer is permitted to evict. Defined as MAX(EVICTION_TIMEOUT,
 * 2 × HOST_HEARTBEAT_INTERVAL) so the gate is at least as strict as heartbeat staleness
 * AND tolerant of one missed host-heartbeat tick. With current values
 * (EVICTION_TIMEOUT=600_000, HOST_HEARTBEAT_INTERVAL=120_000), this evaluates to
 * 600_000 ms (10 min). See docs/design/specs/2026-05-26-task-lifecycle-resilience.md
 * §3.1 R-LR2.
 *
 * IMPORTANT INVARIANT: HOST_OFFLINE_TIMEOUT >= EVICTION_TIMEOUT is operationally
 * meaningful. With current values, EVICTION_TIMEOUT dominates. Raising
 * HOST_HEARTBEAT_INTERVAL above 300_000 ms would shift the dominant term to
 * 2 × HOST_HEARTBEAT_INTERVAL, widening the eviction window beyond R-LR2's intent.
 * Future maintainers: verify this invariant when tuning heartbeat cadence.
 */
const HOST_OFFLINE_TIMEOUT = Math.max(EVICTION_TIMEOUT, 2 * HOST_HEARTBEAT_INTERVAL);

/**
 * Stuck-row healer threshold. Rows with `claimed_at` older than this are eligible for
 * recovery via `healStuckTasks`. Set to 2× EVICTION_TIMEOUT so the healer never races
 * primary recovery: by the time a row is "stuck" by this measure, the eviction CAS or
 * the type-specific reschedule helper has had a full eviction cycle to land its
 * cleanup write. See docs/design/specs/2026-05-26-task-lifecycle-resilience.md §3.1
 * R-LR4 and §4.1 sequencing.
 */
export const STUCK_THRESHOLD = 2 * EVICTION_TIMEOUT;

/**
 * Orphaned-task eviction threshold. A `running` task whose `heartbeat_at` is stale
 * beyond this is evictable by a peer REGARDLESS of host-process liveness.
 *
 * The host-liveness gate (R-LR2) treats a fresh `hosts.modified_at` as proof the
 * lease holder is alive and protects its task from peer eviction. But host-process
 * liveness is NOT task-lease liveness: `hosts.modified_at` is bumped every
 * HOST_HEARTBEAT_INTERVAL independent of task servicing, so a host that restarted and
 * re-registered — but whose interrupted task never resumed — looks "alive" forever and
 * wedges the task indefinitely (observed: webhook task d2ecf42d, ~17h stuck after a hub
 * restart). Set to 2× EVICTION_TIMEOUT so the orphan arm never races the normal gate:
 * the host-liveness path owns the first eviction window, and the orphan arm is the
 * backstop for the host-alive-but-task-orphaned case the gate cannot see.
 */
export const ORPHAN_HEARTBEAT_TIMEOUT = 2 * EVICTION_TIMEOUT;

/**
 * Peer eviction selector for crashed/orphaned `running` tasks. Exported so tests
 * exercise the exact production statement rather than a hand-copied duplicate (the
 * divergence that previously hid a syntax error in the bootstrap SQL).
 *
 * Bind order: (evictionTime, hostOfflineThreshold, orphanThreshold).
 * - heartbeat_at < evictionTime gates all eviction (task missed its lease refresh).
 * - host offline/gone (R-LR2) OR heartbeat_at < orphanThreshold (orphan backstop)
 *   permits eviction. The orphan arm fires when heartbeat is stale past
 *   ORPHAN_HEARTBEAT_TIMEOUT even if the host process looks alive.
 * - LEFT JOIN with claimed_by=NULL: ON clause never matches → h.site_id IS NULL fires
 *   → row evicted. Covers the corruption state where status='running' but lease is unset.
 */
export const EVICTION_SELECTOR_SQL = `SELECT t.*
	 FROM tasks t
	 LEFT JOIN hosts h ON h.site_id = t.claimed_by
	 WHERE t.status = 'running'
	   AND t.deleted = 0
	   AND t.heartbeat_at < ?
	   AND (
		   h.site_id IS NULL
		   OR COALESCE(h.modified_at, h.online_at) < ?
		   OR t.heartbeat_at < ?
	   )`;
const CRON_THREAD_ROTATION_THRESHOLD = 200;
export const DEFERRED_MAX_RETRIES = 2;
export const DEFERRED_RETRY_BACKOFF_MS_DEFAULT = 5_000; // 5 seconds per consecutive failure

/**
 * Connectivity-error signatures (lowercased substrings). Matched against task
 * error strings to decide whether a failure is environmental (host offline /
 * remote inference unreachable) rather than a genuine task-config or logic fault.
 * See `isConnectivityFailure`.
 */
const CONNECTIVITY_ERROR_SIGNATURES = [
	"not available on any remote host", // relay-router: model/tool unresolvable (no reachable peer)
	"eligible host(s) timed out", // relay-stream$: relay inference timed out across all hosts
	"fetch failed", // undici/AI SDK wrapper for a failed network call
	"getaddrinfo", // DNS resolution failed (offline)
	"enotfound", // DNS: host not found
	"eai_again", // DNS: transient failure (offline)
	"econnrefused", // TCP connect refused
	"econnreset", // connection reset mid-flight
	"etimedout", // TCP/socket timeout
	"socket hang up", // connection dropped before response
	"network error", // generic transport-layer failure
	"unable to connect", // generic connect failure
	"connection refused", // generic connect failure (worded)
] as const;

/**
 * Heuristic: does this task error indicate an environmental connectivity /
 * remote-model reachability problem rather than a genuine task-configuration or
 * logic fault?
 *
 * Tasks that require a remote model fail repeatedly while the host is
 * disconnected from the internet (or the hub / remote inference host is
 * unreachable). Those failures are expected and self-resolve when connectivity
 * returns — but filing a "task has failed N times" advisory for each such task
 * floods the operator with unactionable noise (#67). We skip the advisory for
 * these; the failure is still recorded on the task row (status + error +
 * consecutive_failures) and cron/heartbeat tasks keep retrying, so nothing is
 * lost — only the redundant advisory.
 *
 * Deliberately conservative: matches only signatures that are unambiguously
 * connectivity- or remote-availability-related. A genuine task bug that happens
 * to contain one of these substrings is rare, and the cost of a missed advisory
 * (the operator can still see the failed task row) is far lower than the cost of
 * the flood the issue describes.
 */
export function isConnectivityFailure(error: string): boolean {
	const lowered = error.toLowerCase();
	return CONNECTIVITY_ERROR_SIGNATURES.some((sig) => lowered.includes(sig));
}

/**
 * Reschedules a cron task to its next run time and resets status to 'pending'.
 * Extracted as a helper because this logic is needed across the run path
 * (completion, soft errors, hard errors, model validation failures, template
 * paths) and the stuck-row healer.
 *
 * Lease-CAS guard (cron-resurrection fix). `expectedLease` is the claim token
 * the caller acquired for this run. When it is a string, the write is gated via
 * `updateRowIf` on `lease_id = expectedLease`, so the reschedule only lands if
 * THIS run still holds the claim. If a peer evicted us mid-run (eviction clears
 * `lease_id` to NULL — scheduler.ts ~926) or re-claimed the row (fresh lease),
 * the CAS misses and we do NOT clobber the peer's state by re-arming the row.
 * This closes the completion-path hole: the completion CAS at ~1687 can lose to
 * an evictor (`wrote=false`) yet the code still reaches this reschedule — without
 * the guard it would resurrect the just-evicted row to `pending`.
 *
 * `expectedLease === null` is the HEALER path: `healStuckTasks` recovers orphaned
 * rows it does not (and cannot) hold a lease on, so that call rebuilds the
 * schedule unconditionally — that is the healer's entire job. This differs from
 * `parkTask`, which refuses on a null lease because parking an unowned row could
 * clobber a peer's active task; rescheduling a stuck orphan is safe and intended.
 *
 * Scope note: the lease CAS defeats same-generation eviction/re-claim races. It
 * does NOT by itself defeat a stale peer on pre-fix code that re-pends via a
 * fresher `modified_at` — that is the separate soft-delete-tombstone-precedence
 * work tracked in bound_issue:scheduler:cron-cancel-reverted-by-peer-20260529.
 */
export function rescheduleCronTask(
	db: AppContext["db"],
	task: Task,
	logger: AppContext["logger"],
	context: string,
	siteId: string,
	expectedLease: string | null,
): void {
	if (task.type !== "cron" || !task.trigger_spec) return;
	try {
		const cronExpr = extractCronExpression(task.trigger_spec);
		const nextRunAt = computeNextRunAt(cronExpr, new Date());
		const updates: Partial<Task> = {
			next_run_at: nextRunAt.toISOString(),
			status: "pending",
			claimed_by: null,
			claimed_at: null,
			lease_id: null,
			// Clear stale error string once a successful run has completed.
			// Soft/hard-error reschedules intentionally omit this so the error
			// persists for diagnostic purposes until the task actually succeeds.
			...(context === "completion" ? { error: "" } : {}),
		};
		if (expectedLease === null) {
			// Healer path: recover an orphaned/stuck row unconditionally.
			updateRow(db, "tasks", task.id, updates, siteId);
			return;
		}
		const wrote = updateRowIf(db, "tasks", task.id, { lease_id: expectedLease }, updates, siteId);
		if (!wrote) {
			// Peer evicted or re-claimed this row after we started the run; the
			// evictor already set next_run_at. Do not re-arm and clobber its state.
			logger.info(`Cron reschedule skipped after ${context}: lease no longer held`, {
				taskId: task.id,
				expectedLease,
			});
		}
	} catch (cronError) {
		logger.error(`Failed to compute next cron time after ${context}`, {
			error: formatError(cronError),
			taskId: task.id,
		});
	}
}

/**
 * Poison-pill parking (cron-resurrection fix). Parks a task whose model_hint is
 * PERMANENTLY unresolvable cluster-wide (a decommissioned model). A parked task is
 * left in terminal `failed` status with `next_run_at` and ALL claim metadata
 * (`claimed_by` / `claimed_at` / `lease_id`) cleared, so:
 *   - the phase-1 pending sweep skips it (status is `failed`, not `pending`), and
 *   - `healStuckTasks` skips it (it selects only rows with `claimed_by IS NOT NULL`).
 *
 * The write is lease-CAS guarded via `updateRowIf`: if a peer re-claimed the row
 * after eviction, the CAS misses and we do NOT clobber the peer's claim. Heartbeats
 * are never parked — callers gate on `task.type !== "heartbeat"`.
 *
 * Scope note: parking stops THIS node from re-arming a dead-model task on every
 * tick. It propagates via the change log, but does not by itself defeat a stale
 * peer that re-pends the row with a fresher `modified_at` — that is the separate
 * soft-delete-tombstone-precedence work tracked in
 * bound_issue:scheduler:cron-cancel-reverted-by-peer-20260529.
 */
function parkTask(
	db: AppContext["db"],
	task: Task,
	logger: AppContext["logger"],
	errorMsg: string,
	siteId: string,
	expectedLease: string | null,
): void {
	if (expectedLease === null) {
		// No lease to guard against; refuse to park rather than risk clobbering an
		// unowned row. Callers only reach here under a held lease in practice.
		logger.warn("[scheduler] parkTask: no lease to guard, skipping park", {
			taskId: task.id,
		});
		return;
	}
	const parked = updateRowIf(
		db,
		"tasks",
		task.id,
		{ lease_id: expectedLease },
		{
			status: "failed",
			next_run_at: null,
			claimed_by: null,
			claimed_at: null,
			lease_id: null,
			error: `parked (model unresolvable cluster-wide): ${errorMsg}`,
		},
		siteId,
	);
	if (!parked) {
		logger.warn("[scheduler] parkTask: lease CAS rejected, task not parked", {
			taskId: task.id,
			expectedLease,
		});
		return;
	}
	logger.warn("[scheduler] parked task: model unresolvable cluster-wide", {
		taskId: task.id,
		type: task.type,
		modelHint: task.model_hint,
		error: errorMsg,
	});
}

/**
 * Auto-retries a failed deferred task if consecutiveFailures (already post-incremented by the
 * caller) does not exceed DEFERRED_MAX_RETRIES. Uses linear backoff:
 * backoffMs = retryBackoffMs * consecutiveFailures (default retryBackoffMs =
 * DEFERRED_RETRY_BACKOFF_MS_DEFAULT = 5_000ms). Returns true if the row was rewritten to pending
 * with a future next_run_at.
 */
function retryDeferredTask(
	db: AppContext["db"],
	task: Task,
	consecutiveFailures: number,
	logger: AppContext["logger"],
	siteId: string,
	retryBackoffMs: number = DEFERRED_RETRY_BACKOFF_MS_DEFAULT,
): boolean {
	if (task.type !== "deferred") return false;
	if (consecutiveFailures > DEFERRED_MAX_RETRIES) return false;
	try {
		const backoffMs = retryBackoffMs * consecutiveFailures;
		const nextRunAt = new Date(Date.now() + backoffMs).toISOString();
		updateRow(
			db,
			"tasks",
			task.id,
			{
				status: "pending",
				next_run_at: nextRunAt,
				consecutive_failures: consecutiveFailures,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
			},
			siteId,
		);
		logger.info(
			`Retrying deferred task ${task.id} (attempt ${consecutiveFailures}/${DEFERRED_MAX_RETRIES})`,
			{
				taskId: task.id,
				backoffMs,
			},
		);
		return true;
	} catch (retryError) {
		logger.error("Failed to retry deferred task", {
			error: formatError(retryError),
			taskId: task.id,
		});
		return false;
	}
}

/**
 * Resets a failed/completed event task back to 'pending' so it can be triggered
 * again on the next event emission. Event tasks are persistent listeners that
 * should always return to pending after execution.
 *
 * Success path: leaves `next_run_at = NULL`. Event tasks must only be woken by
 * real `connector:event` emissions (the `onEvent` path in this scheduler), not
 * by `phase1Schedule`. Setting a periodic fallback caused phase1 to re-claim
 * completed event tasks every N minutes with no new event payload, which
 * produced the spin observed in advisory 0b9441e5-c47a (2026-05-16: thread
 * 6a9d56aa, 1 real interaction → 29 wake-ups over 70min). The original
 * comment cited "AC4.6 periodic fallback" — that AC applies to the connector
 * **dispatcher** ("Periodic cron fallback wakes dispatcher even without
 * list_changed", per docs/test-plans/2026-05-08-mcp-platform-connectors-
 * test-requirements.md), not to per-event handler tasks. The two were conflated.
 *
 * Failure path: 60s retry IF AND ONLY IF the relay_inbox still has unprocessed
 * envelopes for this task's thread. Capped at MAX_FAILURE_BACKOFFS to avoid
 * permanent self-spin on a broken handler. After the cap (or with no pending
 * envelopes), the task waits in pending for a real event.
 *
 * The unprocessed-inbox precondition is load-bearing: scheduler.ts:895 calls
 * markProcessed BEFORE the agent loop runs (after the wakeup developer/
 * tool_call/tool_result triple is durably persisted), so by the time we reach
 * resetEventTask the common-case inbox is already drained. An unconditional
 * retry would re-fire the agent loop on an empty buildEventWakeupContent
 * payload — the "Execute scheduled task." fallback — giving the agent context-
 * free phantom wakeups. Observed 2026-05-18 in thread d0372be6 (task
 * 4b1d85f9, webhook:bound): a single soft-fail produced a 5-wakeup cluster at
 * 21:33→21:41 with no new event content on any retry. The narrow case the
 * retry still serves: persistence failed BEFORE markProcessed (DB error
 * during message inserts), so the inbox is genuinely unprocessed and the
 * retry replays the actual event payload.
 *
 * Re-reads current DB state before resetting to avoid resurrecting tasks that
 * were cancelled or soft-deleted externally during execution, and to read the
 * post-failure consecutive_failures count (incremented by the soft/hard-error
 * UPDATE that runs before this function).
 */
const MAX_EVENT_TASK_FAILURE_BACKOFFS = 5;

function resetEventTask(
	db: AppContext["db"],
	task: Task,
	logger: AppContext["logger"],
	context: string,
	siteId: string,
): void {
	if (task.type !== "event") return;

	// Re-read current state — task may have been cancelled/deleted during
	// execution; consecutive_failures may have been bumped by the failure path.
	const current = db
		.query("SELECT status, deleted, consecutive_failures FROM tasks WHERE id = ?")
		.get(task.id) as {
		status: string;
		deleted: number;
		consecutive_failures: number | null;
	} | null;
	if (!current || current.deleted === 1 || current.status === "cancelled") {
		logger.info(
			`[@bound/agent/scheduler] Skipping event task reset — task externally ${current?.status ?? "removed"} (${context})`,
			{ taskId: task.id },
		);
		return;
	}

	const isCompletion = context === "completion" || context === "template completion";
	let nextRunAt: string | null = null;
	if (!isCompletion && task.thread_id) {
		// Only retry if the inbox has unprocessed webhook envelopes for this
		// thread. markProcessed (scheduler.ts:895) drains the inbox BEFORE the
		// agent loop runs, so the common-case retry would replay an empty
		// wakeup (the "Execute scheduled task." fallback in
		// buildEventWakeupContent) and produce phantom wakeups. The retry
		// remains useful only when persistence failed BEFORE markProcessed,
		// leaving the inbox genuinely pending and the retry replaying the
		// actual event payload.
		//
		// kind is filtered to match buildEventWakeupContent's reader — only
		// webhook_intake rows are foldable into the wakeup, so only those
		// rows can produce a non-empty retry. A stray platform-MCP `intake`
		// row sharing this thread_id would NOT survive a retry into the
		// helper, so retrying on its presence would be a phantom wakeup.
		const unprocessed = db
			.query(
				"SELECT COUNT(*) as c FROM relay_inbox WHERE ref_id = ? AND processed = 0 AND kind = ?",
			)
			.get(task.thread_id, "webhook_intake") as { c: number } | null;
		if (unprocessed && unprocessed.c > 0) {
			const failures = current.consecutive_failures ?? 0;
			if (failures < MAX_EVENT_TASK_FAILURE_BACKOFFS) {
				nextRunAt = new Date(Date.now() + 60_000).toISOString();
			}
		}
	}

	updateRow(
		db,
		"tasks",
		task.id,
		{
			status: "pending",
			claimed_by: null,
			claimed_at: null,
			lease_id: null,
			next_run_at: nextRunAt,
		},
		siteId,
	);
	logger.info(`[@bound/agent/scheduler] Reset event task to pending (${context})`, {
		taskId: task.id,
		triggerSpec: task.trigger_spec,
		nextRunAt,
	});
}

/**
 * Pure function to compute the next run time for a heartbeat task.
 * Returns an ISO 8601 timestamp for the next clock-aligned boundary.
 * Clock alignment ensures heartbeats fire at predictable times (e.g., every 30 minutes at :00 and :30).
 * Respects quiescence multipliers to reduce frequency during idle periods.
 *
 * Extracted so eviction recovery can compute next_run_at inside a transaction without writing.
 */
export function computeHeartbeatNextRunAt(task: Task, lastUserInteractionAt: Date): string {
	const specResult = parseJsonUntyped(task.trigger_spec, "heartbeat trigger_spec");
	if (!specResult.ok) {
		// On parse error, return current time (fail-safe: task will run immediately on next scheduler tick)
		return new Date().toISOString();
	}

	const spec = specResult.value as Record<string, unknown>;
	const intervalMs = typeof spec.interval_ms === "number" ? spec.interval_ms : 0;
	if (!intervalMs || intervalMs < 60_000) {
		// On invalid interval, return current time (fail-safe)
		return new Date().toISOString();
	}

	const multiplier = computeQuiescenceMultiplier(lastUserInteractionAt);

	const now = Date.now();
	const effectiveInterval = intervalMs * multiplier;
	const nextBoundary = Math.ceil(now / effectiveInterval) * effectiveInterval;
	return new Date(nextBoundary).toISOString();
}

/**
 * Reschedules a heartbeat task to the next clock-aligned boundary and resets status to 'pending'.
 * Clock alignment ensures heartbeats fire at predictable times (e.g., every 30 minutes at :00 and :30).
 * Respects quiescence multipliers to reduce frequency during idle periods.
 *
 * NOTE: Routes through @bound/core updateRow (Phase 2 R-LR11), so the next_run_at + status change
 * is captured in the change_log and replicated via LWW. Errors are cleared on completion context.
 */
export function rescheduleHeartbeat(
	db: AppContext["db"],
	task: Task,
	logger: AppContext["logger"],
	context: string,
	siteId: string,
	lastUserInteractionAt: Date,
): void {
	if (task.type !== "heartbeat") return;

	const specResult = parseJsonUntyped(task.trigger_spec, "heartbeat trigger_spec");
	if (!specResult.ok) {
		logger.error("[@bound/agent/scheduler] Failed to parse heartbeat trigger_spec", {
			error: specResult.error,
		});
		return;
	}

	const spec = specResult.value as Record<string, unknown>;
	const intervalMs = typeof spec.interval_ms === "number" ? spec.interval_ms : 0;
	if (!intervalMs || intervalMs < 60_000) {
		logger.error(`[@bound/agent/scheduler] Invalid heartbeat interval_ms: ${intervalMs}`);
		return;
	}

	const nextRunAtIso = computeHeartbeatNextRunAt(task, lastUserInteractionAt);

	// Clear stale error string on successful completion — see rescheduleCronTask for rationale.
	const updates: Partial<Record<string, unknown>> = {
		next_run_at: nextRunAtIso,
		status: "pending",
	};
	if (context === "completion") {
		updates.error = "";
	}
	updateRow(db, "tasks", task.id, updates, siteId);

	logger.info(
		`[@bound/agent/scheduler] Rescheduled heartbeat (${context}): next_run_at=${nextRunAtIso}`,
	);
}

/**
 * Generalized stuck-row healer (R-LR4). Recovers rows with claim metadata left
 * in a failed/cancelled state across all task types (cron, heartbeat, event, deferred).
 *
 * The four `failed`-write paths (eviction CAS, model-validation failure, soft error,
 * hard error) all leave `status = 'failed'`, `claimed_by`, `claimed_at`, `lease_id`
 * populated, `consecutive_failures` incremented, and `error` set. If a process dies
 * after the `failed` write but before the type-specific cleanup write, the row
 * remains wedged. This healer selects those rows and dispatches to the matching
 * reschedule helper.
 *
 * Called from phase0 every tick. Per-row dispatch via existing reschedule helpers
 * ensures consistency with primary recovery paths (eviction, completion).
 * See docs/design/specs/2026-05-26-task-lifecycle-resilience.md §3.1 R-LR4.
 *
 * lastUserInteractionAt is forwarded to rescheduleHeartbeat only; other dispatch
 * arms ignore it.
 *
 * Returns the number of rows healed.
 */
export function healStuckTasks(
	db: AppContext["db"],
	logger: AppContext["logger"],
	siteId: string,
	lastUserInteractionAt: Date,
): number {
	const stuckThreshold = new Date(Date.now() - STUCK_THRESHOLD).toISOString();
	const stuck = db
		.query(
			// Type-aware recovery predicate (#87). The old predicate was
			// `status IN ('failed', 'cancelled')` for every type, which had two
			// defects:
			//   1. Heartbeats are uncancellable by design, so a cancelled heartbeat
			//      must be revived — that is the ONLY type for which 'cancelled' is
			//      a recoverable state. For cron/event/deferred, cancellation is a
			//      deliberate terminal action and re-dispatching them resurrects
			//      work the operator explicitly stopped.
			//   2. A deferred task whose retries are exhausted
			//      (consecutive_failures >= DEFERRED_MAX_RETRIES) can no longer be
			//      retried — retryDeferredTask refuses at prev+1 > MAX and leaves the
			//      row failed + claimed. Re-selecting it every cycle produced no
			//      recovery, only a repeated WARN ("recovering stuck row") — the
			//      reported log spam. Such rows are excluded so they settle.
			//
			// Heartbeats also recover from 'completed' (#104). A heartbeat passes
			// transiently through status='completed' between the completion write and
			// rescheduleHeartbeat; if a crash/eviction lands in that window (or
			// rescheduleHeartbeat early-returns), the heartbeat is left stuck in
			// 'completed' with nothing to re-arm it. Heartbeats are perpetual, so
			// 'completed' is a recoverable wedge for them — but NOT for cron/event,
			// whose completion is terminal. The claimed_at < threshold guard keeps a
			// healthy heartbeat (claim always fresh, completed for only microseconds)
			// from ever matching.
			`SELECT * FROM tasks
			WHERE deleted = 0
			  AND claimed_by IS NOT NULL
			  AND claimed_at < ?
			  AND (
			    (type = 'heartbeat' AND status IN ('failed', 'cancelled', 'completed'))
			    OR (type IN ('cron', 'event') AND status = 'failed')
			    OR (type = 'deferred' AND status = 'failed' AND consecutive_failures < ?)
			  )`,
		)
		.all(stuckThreshold, DEFERRED_MAX_RETRIES) as Task[];

	let recovered = 0;
	for (const task of stuck) {
		try {
			logger.warn("[scheduler] healStuckTasks: recovering stuck row", {
				taskId: task.id,
				type: task.type,
				previousStatus: task.status,
				claimedBy: task.claimed_by,
				elapsedMs: task.claimed_at ? Date.now() - new Date(task.claimed_at).getTime() : 0,
			});

			switch (task.type) {
				case "cron":
					// Healer path: orphaned/stuck row, no lease held — rebuild schedule unconditionally.
					rescheduleCronTask(db, task, logger, "stuck-row healer", siteId, null);
					recovered++;
					break;
				case "heartbeat":
					rescheduleHeartbeat(db, task, logger, "stuck-row healer", siteId, lastUserInteractionAt);
					// NOTE: rescheduleHeartbeat updates next_run_at + status + (optionally) error via outbox.
					// It does NOT clear claim metadata; that is left to the next phase1 claim CAS, which
					// overwrites stale claim columns. AC4.1's 'claim metadata cleared' is fully satisfied
					// via that pathway. Stale columns are visible to peers via sync but harmless: phase1
					// reclaim semantics are CAS-on-status='pending'.
					recovered++;
					break;
				case "event":
					resetEventTask(db, task, logger, "stuck-row healer", siteId);
					recovered++;
					break;
				case "deferred":
					retryDeferredTask(
						db,
						task,
						(task.consecutive_failures ?? 0) + 1,
						logger,
						siteId,
						DEFERRED_RETRY_BACKOFF_MS_DEFAULT,
					);
					recovered++;
					break;
				default:
					// warn for expected recovery activity, error for unexpected schema/state —
					// unknown task.type indicates corrupted data and warrants error-level logging.
					logger.error("[scheduler] healStuckTasks: unknown task type", {
						taskId: task.id,
						type: task.type,
					});
					// Do not increment recovered; do not throw — continue to next row
					break;
			}
		} catch (err) {
			logger.error("[scheduler] healStuckTasks: error dispatching row", {
				taskId: task.id,
				type: task.type,
				error: formatError(err),
			});
			// Do not increment recovered; continue to next row
		}
	}

	return recovered;
}

const POLL_INTERVAL = 5000; // 5 seconds
const MAX_EVENT_DEPTH = 5;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Graduated quiescence tiers (idle duration in ms → multiplier)
// Thresholds are the lower bound of each idle band
const QUIESCENCE_TIERS: Array<{ threshold: number; multiplier: number }> = [
	{ threshold: 0, multiplier: 1 }, // 0-30m idle: ×1 (active user, use configured interval)
	{ threshold: 1_800_000, multiplier: 2 }, // 30m-1h idle: ×2
	{ threshold: 3_600_000, multiplier: 3 }, // 1-4h idle: ×3
	{ threshold: 14_400_000, multiplier: 5 }, // 4-12h idle: ×5
	{ threshold: 43_200_000, multiplier: 10 }, // 12-24h idle: ×10
];

/** Minimum idle duration before quiescence note is injected into task context. */
const QUIESCENCE_NOTE_THRESHOLD = 1_800_000; // 30 minutes

/**
 * Compute quiescence multiplier based on idle duration.
 * Returns the multiplier from QUIESCENCE_TIERS based on how long
 * the system has been idle.
 */
export function computeQuiescenceMultiplier(lastUserInteractionAt: Date): number {
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

/**
 * Format idle duration in milliseconds to a human-readable string.
 * Examples: "30m", "2h 15m", "0m".
 */
export function formatIdleDuration(ms: number): string {
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

interface SchedulerConfig {
	pollInterval?: number;
	syncEnabled?: boolean;
	/**
	 * Optional model-hint validator called before each task run.
	 * Returns { ok: true } when the model is available, { ok: false, error } otherwise.
	 * When absent, model hints are not validated at run time (existing behaviour).
	 *
	 * `permanent: true` signals that the model is unresolvable cluster-wide (not merely
	 * transiently unavailable). The scheduler parks such tasks instead of rescheduling them
	 * forever — see `parkTask`.
	 */
	modelValidator?: (
		modelId: string,
	) => { ok: true } | { ok: false; error: string; permanent?: boolean };
	/** Optional tier resolver for cost-equivalent fallback. Returns the tier (1-5)
	 *  for a model ID, or null if the model is not in the local router. */
	modelTierResolver?: (modelId: string) => number | null;
	/**
	 * Optional callback to generate a thread title after a task's agent loop completes.
	 * Called with the thread ID; fire-and-forget (errors are logged, not propagated).
	 */
	generateTitle?: (threadId: string) => Promise<void>;
	/** Optional resolver for platform tools available for a thread. */
	platformToolResolver?: (threadId: string) => PlatformRegisteredTool[];
	/**
	 * Optional resolver for connector-authored server instructions available
	 * for a thread. Returns undefined for threads not bound to a connector.
	 */
	platformInstructionsResolver?: (threadId: string) => string | undefined;
	/** Override deferred retry backoff (default 5000ms). Useful for tests. */
	retryBackoffMs?: number;
	/** Override base poll interval for getEffectivePollInterval (default 5000ms). Useful for tests. */
	basePollIntervalMs?: number;
}

export class Scheduler {
	private running = false;
	private intervalId: ReturnType<typeof setTimeout> | null = null;
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private lastUserInteractionAt = new Date();
	private eventDepth = 0;
	private runningTasks = new Map<string, { leaseId: string; startedAt: Date }>();
	private operatorUserId: string;

	constructor(
		private ctx: AppContext,
		private agentLoopFactory: (config: AgentLoopConfig) => AgentLoop,
		private config: SchedulerConfig = {},
		private sandbox?: {
			exec?: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
		},
	) {
		// Resolve operator user ID so scheduler threads are visible in the operator's cross-thread digest.
		// allowlist is a required config — startup fails without it, so default_web_user is always present.
		this.operatorUserId = deterministicUUID(BOUND_NAMESPACE, ctx.config.allowlist.default_web_user);

		// Register event handler for all event types
		ctx.eventBus.on("message:created", () => this.onUserInteraction());
	}

	start(pollInterval: number = POLL_INTERVAL): { stop: () => void } {
		if (this.running) {
			throw new Error("Scheduler already running");
		}

		this.running = true;
		this.lastUserInteractionAt = new Date();

		// Start heartbeat updates for running tasks
		this.heartbeatInterval = setInterval(() => {
			try {
				this.updateHeartbeats();
			} catch (err: unknown) {
				if (err instanceof RangeError && String(err.message).includes("closed database")) {
					this.running = false;
					if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
					if (this.intervalId) clearTimeout(this.intervalId);
					return;
				}
				throw err;
			}
		}, HEARTBEAT_INTERVAL);

		// Start main scheduler loop with dynamic quiescence-based interval
		const scheduleTick = () => {
			if (!this.running) return;

			try {
				this.tick();

				// Recalculate interval based on quiescence and reset timer
				const effectiveInterval = this.getEffectivePollInterval();
				this.intervalId = setTimeout(scheduleTick, effectiveInterval);
			} catch (err: unknown) {
				// Auto-stop on closed database — prevents leaked timers from
				// crashing the process when a test closes the DB before stop().
				if (err instanceof RangeError && String(err.message).includes("closed database")) {
					this.running = false;
					return;
				}
				throw err;
			}
		};

		this.intervalId = setTimeout(scheduleTick, pollInterval);

		this.ctx.logger.info("Scheduler started");

		return {
			stop: () => this.stop(),
		};
	}

	stop(): void {
		if (!this.running) {
			return;
		}

		this.running = false;

		if (this.intervalId) {
			clearTimeout(this.intervalId);
			this.intervalId = null;
		}

		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}

		this.ctx.logger.info("Scheduler stopped");
	}

	private onUserInteraction(): void {
		this.lastUserInteractionAt = new Date();
		this.eventDepth = 0;
	}

	private updateHeartbeats(): void {
		if (!this.running) return;

		const now = new Date().toISOString();
		for (const [taskId, info] of this.runningTasks.entries()) {
			const updated = updateRowIf(
				this.ctx.db,
				"tasks",
				taskId,
				{ lease_id: info.leaseId },
				{ heartbeat_at: now },
				this.ctx.siteId,
			);
			if (!updated) {
				this.ctx.logger.debug(
					`[@bound/agent/scheduler] Heartbeat refresh failed: lease lost for task ${taskId}`,
				);
			}
		}
	}

	private tick(): void {
		if (!this.running) return;

		try {
			// Check for emergency stop
			const emergencyStop = this.ctx.db
				.query("SELECT value FROM cluster_config WHERE key = 'emergency_stop'")
				.get() as { value: string } | undefined;

			if (emergencyStop) {
				this.ctx.logger.info("[scheduler] Emergency stop active, skipping tick");
				return;
			}

			// Phase 0: Eviction
			this.phase0Eviction();

			// Phase 1: Schedule
			this.phase1Schedule();

			// Phase 2: Sync (deferred for Phase 5)
			// this.phase2Sync();

			// Phase 3: Run
			this.phase3Run();
		} catch (error) {
			const errorMsg = formatError(error);
			this.ctx.logger.error("Scheduler tick failed", { error: errorMsg });
		}
	}

	private phase0Eviction(): void {
		const now = new Date();
		const leaseExpiry = new Date(now.getTime() - LEASE_DURATION).toISOString();

		// (a) Expire stale claimed tasks
		const staleClaimedTasks = this.ctx.db
			.query("SELECT * FROM tasks WHERE status = 'claimed' AND deleted = 0 AND claimed_at < ?")
			.all(leaseExpiry) as Task[];

		for (const task of staleClaimedTasks) {
			updateRow(
				this.ctx.db,
				"tasks",
				task.id,
				{
					status: "pending",
					claimed_by: null,
					claimed_at: null,
					lease_id: null,
				},
				this.ctx.siteId,
			);
		}

		// (b) Evict crashed running tasks
		const evictionTime = new Date(now.getTime() - EVICTION_TIMEOUT).toISOString();
		const hostOfflineThreshold = new Date(now.getTime() - HOST_OFFLINE_TIMEOUT).toISOString();
		const orphanThreshold = new Date(now.getTime() - ORPHAN_HEARTBEAT_TIMEOUT).toISOString();
		const tasksToEvict = this.ctx.db
			.query<Task, [string, string, string]>(EVICTION_SELECTOR_SQL)
			.all(evictionTime, hostOfflineThreshold, orphanThreshold) as Task[];

		if (tasksToEvict.length > 0) {
			this.ctx.logger.warn("[scheduler] Evicting crashed tasks", {
				count: tasksToEvict.length,
				tasks: tasksToEvict.map((t) => ({
					id: t.id,
					triggerSpec: t.trigger_spec,
					type: t.type,
					consecutiveFailures: (t.consecutive_failures ?? 0) + 1,
				})),
			});

			const nowMs = Date.now();

			for (const task of tasksToEvict) {
				try {
					const newConsecutiveFailures = (task.consecutive_failures ?? 0) + 1;
					let nextRunAtIso: string | null = null;

					const committed = withTx(this.ctx.db, () => {
						// Per-type next_run_at computation (reads and computation happen here; they're inside the tx).
						switch (task.type) {
							case "cron": {
								if (task.trigger_spec) {
									try {
										const cronExpr = extractCronExpression(task.trigger_spec);
										nextRunAtIso = computeNextRunAt(cronExpr, new Date()).toISOString();
									} catch (e) {
										this.ctx.logger.error(
											"[scheduler] Failed to compute next cron time during eviction",
											{
												error: formatError(e),
												taskId: task.id,
											},
										);
										nextRunAtIso = null;
									}
								}
								break;
							}

							case "heartbeat": {
								nextRunAtIso = computeHeartbeatNextRunAt(task, this.lastUserInteractionAt);
								break;
							}

							case "event": {
								// R-LR3 design note: the relay_inbox SELECT lives inside the eviction transaction.
								const unprocessed = this.ctx.db
									.query<{ c: number }, [string, string]>(
										"SELECT COUNT(*) as c FROM relay_inbox WHERE ref_id = ? AND processed = 0 AND kind = ?",
									)
									.get(task.thread_id ?? "", "webhook_intake");
								const hasUnprocessed = (unprocessed?.c ?? 0) > 0;
								const underBackoffCap = newConsecutiveFailures < MAX_EVENT_TASK_FAILURE_BACKOFFS;
								nextRunAtIso =
									hasUnprocessed && underBackoffCap ? new Date(nowMs + 60_000).toISOString() : null;
								break;
							}

							case "deferred": {
								// R-LR3 deferred-task parity with retryDeferredTask's linear backoff.
								// RFC formula: now + DEFERRED_RETRY_BACKOFF_MS_DEFAULT * (consecutive_failures + 1).
								// The (consecutive_failures + 1) here is `newConsecutiveFailures` — the value
								// we are about to write. Capped at DEFERRED_MAX_RETRIES so deferred tasks that
								// continue to fail eventually park at status='failed' permanently.
								if (newConsecutiveFailures > DEFERRED_MAX_RETRIES) {
									// Don't reschedule — leave as failed permanently; recovery clears claim only.
									nextRunAtIso = null;
								} else {
									nextRunAtIso = new Date(
										nowMs + DEFERRED_RETRY_BACKOFF_MS_DEFAULT * newConsecutiveFailures,
									).toISOString();
								}
								break;
							}

							default: {
								this.ctx.logger.error("[scheduler] eviction: unknown task type", {
									taskId: task.id,
									type: task.type,
								});
								// Don't write — let the throw bubble up and roll back the (empty) transaction.
								throw new Error(`Unknown task type: ${task.type}`);
							}
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
					} else {
						// CAS lost: the agent loop's completion path already won the race
						// and transitioned status='running' → 'completed'. Do NOT trample
						// the result row with a phantom eviction error.
						this.ctx.logger.info(
							"[scheduler] Eviction CAS lost — task already completed before reaper ran",
							{ taskId: task.id, type: task.type, triggerSpec: task.trigger_spec },
						);
					}
				} catch (err) {
					this.ctx.logger.error("[scheduler] eviction failed for task; continuing batch", {
						taskId: task.id,
						type: task.type,
						error: err instanceof Error ? err.message : String(err),
					});
					// Do not rethrow; continue to next task in the batch
				}
			}
		}

		// (c) Heal stuck rows in terminal state with stale next_run_at.
		// Generalized healer covering all four task types and all failed-write paths.
		// Defends against any future eviction-vs-completion race that escapes the
		// CAS in (b), and recovers existing stuck rows on restart (e.g., d2ecf42d).
		healStuckTasks(this.ctx.db, this.ctx.logger, this.ctx.siteId, this.lastUserInteractionAt);
	}

	private phase1Schedule(): void {
		const now = new Date().toISOString();

		const pendingTasks = this.ctx.db
			.query(
				`SELECT * FROM tasks WHERE status = 'pending' AND deleted = 0 AND next_run_at IS NOT NULL AND next_run_at <= ?
			 ORDER BY next_run_at ASC LIMIT 100`,
			)
			.all(now) as Task[];

		for (const task of pendingTasks) {
			if (canRunHere(this.ctx.db, task, this.ctx.hostName, this.ctx.siteId)) {
				const claimedAt = new Date().toISOString();
				// CAS: only claim if still pending (prevents duplicate scheduling from other hosts)
				const txFn = this.ctx.db.transaction(() => {
					const result = this.ctx.db
						.query(
							"UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ? AND status = 'pending'", // outbox-routed: explicit createChangeLogEntry follows the CAS UPDATE in this transaction (pending → claimed)
						)
						.run(this.ctx.siteId, claimedAt, task.id);
					if (result.changes > 0) {
						// Generate changelog entry for the successful claim
						return createChangeLogEntry(this.ctx.db, "tasks", task.id, this.ctx.siteId, {
							status: "claimed",
							claimed_by: this.ctx.siteId,
							claimed_at: claimedAt,
							modified_at: new Date().toISOString(),
						});
					}
					return null;
				});

				const hlc = txFn();
				if (!hlc) {
					this.ctx.logger.info("[scheduler] Task already claimed by another host", {
						taskId: task.id,
					});
				}
			}
		}
	}

	private phase3Run(): void {
		const claimedTasks = this.ctx.db
			.query(
				`SELECT * FROM tasks WHERE status = 'claimed' AND claimed_by = ?
			 ORDER BY created_at ASC LIMIT 10`,
			)
			.all(this.ctx.siteId) as Task[];

		for (const task of claimedTasks) {
			// Check daily budget for autonomous tasks (R-U35)
			if (this.shouldSkipDueToBudget(task)) {
				this.ctx.logger.warn("[scheduler] Skipping autonomous task due to daily budget", {
					taskId: task.id,
				});
				// Release the claim so it can be re-evaluated later
				updateRow(
					this.ctx.db,
					"tasks",
					task.id,
					{ status: "pending", claimed_by: null, claimed_at: null },
					this.ctx.siteId,
				);
				continue;
			}

			this.runTask(task);
		}
	}

	private shouldSkipDueToBudget(task: Task): boolean {
		// Only check budget for autonomous (non-interactive) tasks
		// Interactive tasks (created by a user) should always run even when over budget
		const isInteractive = task.created_by !== null && task.created_by !== "system";
		if (isInteractive) {
			return false;
		}

		const modelBackends = this.ctx.config.modelBackends;
		const dailyBudget = modelBackends.daily_budget_usd;

		// If no budget configured, allow all tasks
		if (dailyBudget === undefined || dailyBudget === null) {
			return false;
		}

		// Query today's spend from turns table
		const today = new Date().toISOString().split("T")[0];
		const result = this.ctx.db
			.query("SELECT SUM(cost_usd) as total FROM turns WHERE date(created_at) = ?")
			.get(today) as { total: number | null } | null;

		const todaySpend = result?.total ?? 0;

		// Skip task if over budget
		return todaySpend >= dailyBudget;
	}

	private runTask(task: Task): void {
		const leaseId = randomUUID();
		const now = new Date().toISOString();

		// Mark as running (CAS: only if still claimed by this host)
		const txFn = this.ctx.db.transaction(() => {
			const result = this.ctx.db
				.query(
					"UPDATE tasks SET status = 'running', lease_id = ?, heartbeat_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ?", // outbox-routed: explicit createChangeLogEntry follows the CAS UPDATE in this transaction (claimed → running, includes heartbeat_at)
				)
				.run(leaseId, now, task.id, this.ctx.siteId);
			if (result.changes === 0) {
				return null;
			}

			// Generate changelog entry for the successful CAS
			return createChangeLogEntry(this.ctx.db, "tasks", task.id, this.ctx.siteId, {
				status: "running",
				lease_id: leaseId,
				heartbeat_at: now,
				modified_at: now,
			});
		});

		const hlc = txFn();
		if (!hlc) {
			this.ctx.logger.warn("[scheduler] CAS failed: task was reclaimed before runTask", {
				taskId: task.id,
			});
			return;
		}

		this.runningTasks.set(task.id, {
			leaseId,
			startedAt: new Date(),
		});

		this.ctx.logger.info("[scheduler] Task starting", {
			taskId: task.id,
			triggerSpec: task.trigger_spec,
			type: task.type,
			modelHint: task.model_hint ?? "default",
			threadId: task.thread_id ?? null,
			runCount: task.run_count ?? 0,
		});

		// Check if this is a cron task with a template (R-U28)
		const template = this.getCronTemplate(task);
		if (template && template.length > 0) {
			this.runTemplateTask(task, leaseId, template);
			return;
		}

		// Create agent loop and run asynchronously
		setImmediate(async () => {
			// Cross-host lease verification: the phase1/phase3 CAS updates above
			// (`pending → claimed → running`) are local-only on each replica's
			// SQLite. In a multi-master cluster, two hosts polling concurrently
			// can both succeed at their local CAS, both proceed to runTask, and
			// both insert `[Task wakeup]` developer rows on the same thread.
			//
			// Wait for sync to settle, re-read the row, and bail if LWW resolution
			// has overwritten our claim with a peer's. This is defense-in-depth —
			// the settle wait is heuristic (sync RTT-bound), not consensus. The
			// proper fix is cluster-wide singleton coordination (tracked separately).
			if (LEASE_VERIFY_SETTLE_MS > 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, LEASE_VERIFY_SETTLE_MS));
			}
			const verification = verifyLeaseStillHeld(this.ctx.db, task.id, this.ctx.siteId, leaseId);
			if (!verification.held) {
				this.ctx.logger.warn(
					"[scheduler] Lease verification failed after settle; aborting runTask to avoid split-brain",
					{
						taskId: task.id,
						leaseId,
						reason: verification.reason,
						actual: verification.actual,
					},
				);
				this.runningTasks.delete(task.id);
				return;
			}

			try {
				let threadId = task.thread_id || randomUUID();
				const taskNow = new Date().toISOString();

				// Rotate cron task threads that have grown too large.
				// Large threads cause slow context assembly and long LLM calls,
				// making them vulnerable to heartbeat timeout eviction.
				if (task.type === "cron" && task.thread_id) {
					const countRow = this.ctx.db
						.query("SELECT COUNT(*) as count FROM messages WHERE thread_id = ?")
						.get(task.thread_id) as { count: number };

					if (countRow.count > CRON_THREAD_ROTATION_THRESHOLD) {
						const newThreadId = randomUUID();
						this.ctx.logger.info(
							`[scheduler] Rotating cron task thread: ${countRow.count} messages exceeds threshold of ${CRON_THREAD_ROTATION_THRESHOLD}`,
							{ taskId: task.id, oldThreadId: task.thread_id, newThreadId },
						);
						updateRow(this.ctx.db, "tasks", task.id, { thread_id: newThreadId }, this.ctx.siteId);
						threadId = newThreadId;
					}
				}

				// Persist thread_id back to the task row so the UI can find the
				// thread later. Without this, tasks created without a thread_id
				// would run fine but the detail view couldn't show their messages.
				if (!task.thread_id) {
					updateRow(this.ctx.db, "tasks", task.id, { thread_id: threadId }, this.ctx.siteId);
				}

				// Bug #4: Ensure a thread row exists for the threadId.
				// The thread may not exist if this is a system task with no pre-created thread.
				const existingThread = this.ctx.db
					.query("SELECT id FROM threads WHERE id = ?")
					.get(threadId) as { id: string } | null;

				if (!existingThread) {
					insertRow(
						this.ctx.db,
						"threads",
						{
							id: threadId,
							user_id: this.operatorUserId,
							interface: "scheduler",
							host_origin: this.ctx.siteId,
							color: 0,
							title: null,
							summary: null,
							summary_through: null,
							summary_model_id: null,
							extracted_through: null,
							created_at: taskNow,
							last_message_at: taskNow,
							modified_at: taskNow,
							deleted: 0,
							model_hint: task.model_hint ?? null,
						},
						this.ctx.siteId,
					);
				}

				// Deliver the task payload as a synthetic retrieve_task tool call.
				// The model treats tool results as factual context it retrieved,
				// so it follows the instructions naturally (unlike system messages
				// which it may ignore as background context). The conversation
				// structure is: developer(wakeup) -> tool_call(retrieve_task) ->
				// tool_result(payload). No user message exists in this path by
				// design — providers that require a user-first message (Bedrock,
				// Anthropic direct) receive a synthetic leading user message
				// carrying the wakeup content, constructed in the ai-sdk-bridge's
				// toModelMessages() conversation-start invariant.
				// Deterministic idempotency key for this firing (#46 split-brain
				// blast-radius bound). When two hosts race the same pending row they
				// read the same (id, next_run_at) snapshot and derive the same wakeup
				// message ids, so the triplets they each insert LWW-collapse to one
				// set on sync rather than doubling the synthetic wakeup structure in
				// the thread. Converges the persisted effect of a double-dispatch; it
				// does not prevent the second run (that needs consensus over claims —
				// tracked in #46). Null for firings with no scheduled instant (event
				// tasks: next_run_at NULL) → random ids, i.e. current behavior.
				const firingKey = computeFiringKey(task.id, task.next_run_at);
				const firingIds = firingKey ? deriveFiringWakeupIds(firingKey) : null;
				const toolCallId =
					firingIds?.toolUseId ?? `tooluse_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
				const wakeupMessageId = firingIds?.wakeupMessageId ?? randomUUID();
				const toolCallMessageId = firingIds?.toolCallMessageId ?? randomUUID();
				const toolResultMessageId = firingIds?.toolResultMessageId ?? randomUUID();
				let taskContent: string;
				let inboxIdsToMarkProcessed: string[] = [];
				if (task.type === "heartbeat") {
					taskContent = buildHeartbeatContext(this.ctx.db, task.last_run_at, {
						siteId: this.ctx.siteId,
						logger: this.ctx.logger,
					});
				} else if (task.type === "event") {
					// Event tasks (e.g. webhook-triggered) carry their dynamic
					// payload in relay_inbox keyed by thread_id, written at
					// intake time by webhook-handler.ts. Without this branch
					// the agent would just see "Execute scheduled task." with
					// no clue what fired the trigger — see the 2026-05-18
					// d0372be6 incident where a GitHub-issue webhook woke a
					// task and the agent had to do MCP archaeology to figure
					// out what happened. Helper returns processedIds for
					// post-insert draining (below).
					const eventResult = buildEventWakeupContent(this.ctx.db, task);
					taskContent = eventResult.content;
					inboxIdsToMarkProcessed = eventResult.processedIds;
				} else {
					taskContent = task.payload ?? "Execute scheduled task.";
				}

				// 1. System notification establishing the wakeup context.
				// Formerly a user message with "." — changed to system to avoid
				// confusing models and polluting history/memory generation.
				insertRow(
					this.ctx.db,
					"messages",
					{
						id: wakeupMessageId,
						thread_id: threadId,
						role: "developer",
						content: `[Task wakeup] Scheduled ${task.type} task ${task.id} triggered.`,
						model_id: null,
						tool_name: null,
						created_at: taskNow,
						modified_at: taskNow,
						host_origin: this.ctx.siteId,
						deleted: 0,
						exit_code: null,
						metadata: null,
					},
					this.ctx.siteId,
				);

				// 2. Synthetic assistant tool_call
				insertRow(
					this.ctx.db,
					"messages",
					{
						id: toolCallMessageId,
						thread_id: threadId,
						role: "tool_call",
						content: JSON.stringify([
							{
								type: "tool_use",
								id: toolCallId,
								name: "retrieve_task",
								input: {},
							},
						]),
						model_id: null,
						tool_name: null,
						created_at: taskNow,
						modified_at: taskNow,
						host_origin: this.ctx.siteId,
						deleted: 0,
						exit_code: null,
						metadata: null,
					},
					this.ctx.siteId,
				);

				// 3. Synthetic tool_result with task payload.
				// Prefixed with a system-injected banner so the model recognizes the
				// preceding tool_call as machinery, not as something it itself chose
				// to do. Without this banner, models pattern-match off the injected
				// retrieve_task call and emit their own redundant retrieve_task({})
				// calls mid-session — see _feedback:correction:retrieve_task_spin_*
				// and the 2026-05-16 incident in advisory 0b9441e5-c47a.
				const systemInjectedBanner =
					"[System-injected on task wakeup — the preceding `retrieve_task` " +
					"tool_call was forged by the scheduler, not issued by you. The " +
					"task payload follows below; treat it as your instructions for " +
					"this run. Do not call `retrieve_task` yourself; it is a no-op " +
					"stub that exists only to absorb pattern-matched reflex calls.]\n\n";
				insertRow(
					this.ctx.db,
					"messages",
					{
						id: toolResultMessageId,
						thread_id: threadId,
						role: "tool_result",
						content: systemInjectedBanner + taskContent,
						model_id: null,
						tool_name: toolCallId,
						created_at: taskNow,
						modified_at: taskNow,
						host_origin: this.ctx.siteId,
						deleted: 0,
						exit_code: null,
						metadata: null,
					},
					this.ctx.siteId,
				);

				// Drain the inbox entries we folded into the wakeup so the same
				// envelopes don't surface again on the next event-task wakeup.
				// Marked AFTER the tool_result message is durably persisted, so
				// a mid-write failure leaves the inbox unprocessed (redundant
				// event on a later run is strictly better than silent loss).
				if (inboxIdsToMarkProcessed.length > 0) {
					markProcessed(this.ctx.db, inboxIdsToMarkProcessed);
				}

				// Inject quiescence note for scheduled tasks when system is idle
				if (task.type === "heartbeat" || task.type === "cron") {
					const idleMs = Date.now() - this.lastUserInteractionAt.getTime();
					if (idleMs >= QUIESCENCE_NOTE_THRESHOLD) {
						const multiplier = computeQuiescenceMultiplier(this.lastUserInteractionAt);
						const idleDuration = formatIdleDuration(idleMs);

						let baseInterval: string;
						let effectiveInterval: string;
						if (task.type === "heartbeat") {
							const specResult = parseJsonUntyped(task.trigger_spec, "heartbeat trigger_spec");
							let baseMs = 1_800_000;
							if (
								specResult.ok &&
								typeof specResult.value === "object" &&
								specResult.value !== null
							) {
								const spec = specResult.value as Record<string, unknown>;
								if (typeof spec.interval_ms === "number") {
									baseMs = spec.interval_ms;
								}
							}
							baseInterval = `${Math.round(baseMs / 60_000)}min`;
							effectiveInterval = `${Math.round((baseMs * multiplier) / 60_000)}min`;
						} else {
							// Cron tasks don't have a simple interval, extract and use the schedule expression
							baseInterval = extractCronExpression(task.trigger_spec);
							effectiveInterval = `schedule stretched by ${multiplier}x`;
						}

						const quiescenceNote = `[System note: Quiescence is active (idle ${idleDuration}). Task intervals are stretched by ${multiplier}x. Normal interval: ${baseInterval}, effective: ${effectiveInterval}.]`;

						insertRow(
							this.ctx.db,
							"messages",
							{
								// Same firing-key convergence as the wakeup triplet (#46): two
								// hosts racing this firing derive the same id, so the quiescence
								// note they each insert LWW-collapses to one row instead of
								// doubling in the thread. Random fallback for event firings.
								id: firingKey ? deriveFiringArtifactId(firingKey, "quiescence") : randomUUID(),
								thread_id: threadId,
								role: "developer",
								content: quiescenceNote,
								model_id: null,
								tool_name: null,
								created_at: taskNow,
								modified_at: taskNow,
								host_origin: this.ctx.siteId,
								deleted: 0,
								exit_code: null,
								metadata: null,
							},
							this.ctx.siteId,
						);
					}
				}

				// Validate model hint at run time before creating the agent loop.
				// This catches models that became unavailable after the task was scheduled.
				if (task.model_hint && this.config.modelValidator) {
					const validation = this.config.modelValidator(task.model_hint);
					if (!validation.ok) {
						this.ctx.logger.warn("[scheduler] Task model validation failed", {
							taskId: task.id,
							triggerSpec: task.trigger_spec,
							modelHint: task.model_hint,
							error: validation.error,
						});
						const errorMsg = validation.error;
						const currentTask = this.ctx.db
							.query("SELECT * FROM tasks WHERE id = ?")
							.get(task.id) as (Task & { lease_id: string | null }) | undefined;
						if (currentTask?.lease_id === leaseId) {
							// Use raw SQL to handle concurrent updates to consecutive_failures properly
							const txFn = this.ctx.db.transaction(() => {
								const result = this.ctx.db
									.query(
										"UPDATE tasks SET status = 'failed', error = ?, consecutive_failures = consecutive_failures + 1, modified_at = ? WHERE id = ? AND lease_id = ?", // outbox-routed: explicit createChangeLogEntry follows the UPDATE in this transaction (running → failed, model-validation path)
									)
									.run(errorMsg, new Date().toISOString(), task.id, leaseId);

								if (result.changes === 0) {
									// Lease CAS rejected — peer eviction landed first; the row is now in `pending` with
									// claim cleared. Don't emit a misleading change_log entry. Log and bail; the
									// healer / phase1 reclaim will drive next steps.
									this.ctx.logger.warn(
										"[scheduler] running→failed UPDATE rejected by lease CAS guard",
										{ taskId: task.id, expectedLease: leaseId, path: "model-validation" },
									);
									return -1; // Sentinel: lease CAS rejected
								}

								// Get the updated row to check new failure count
								const updatedTask = this.ctx.db
									.query("SELECT * FROM tasks WHERE id = ?")
									.get(task.id) as Task | null;
								if (!updatedTask) {
									throw new Error(`Task ${task.id} disappeared after model validation failure`);
								}

								// Generate changelog entry with full row snapshot
								createChangeLogEntry(
									this.ctx.db,
									"tasks",
									task.id,
									this.ctx.siteId,
									updatedTask as unknown as Record<string, unknown>,
								);

								return updatedTask.consecutive_failures ?? 0;
							});

							const newConsecutiveFailures = txFn();
							if (newConsecutiveFailures === -1) {
								// Lease CAS guard rejected the update; bail without advisory
								return;
							}
							if (newConsecutiveFailures === task.alert_threshold) {
								this.triggerFailureAdvisory(task, errorMsg, newConsecutiveFailures);
							}
							// Poison-pill parking (cron-resurrection fix): a PERMANENT validation
							// failure means the model_hint is registered nowhere in the cluster
							// (decommissioned). Rescheduling re-arms the task forever — the
							// fire→reschedule loop that resurrects cancelled crons cluster-wide.
							// Park it instead (terminal `failed`, next_run_at + claim cleared) so
							// neither the pending sweep nor healStuckTasks revives it. Heartbeats
							// are NEVER parked (they must always re-arm), so the type guard routes
							// them to rescheduleHeartbeat below regardless of permanence.
							if (validation.permanent && task.type !== "heartbeat") {
								parkTask(this.ctx.db, task, this.ctx.logger, errorMsg, this.ctx.siteId, leaseId);
							} else {
								// Retryable (transient model unavailability) or heartbeat: reschedule
								// on the normal cadence so the task retries when the model returns.
								rescheduleCronTask(
									this.ctx.db,
									task,
									this.ctx.logger,
									"model validation failure",
									this.ctx.siteId,
									leaseId,
								);
								rescheduleHeartbeat(
									this.ctx.db,
									task,
									this.ctx.logger,
									"model validation failure",
									this.ctx.siteId,
									this.lastUserInteractionAt,
								);
								retryDeferredTask(
									this.ctx.db,
									task,
									newConsecutiveFailures,
									this.ctx.logger,
									this.ctx.siteId,
									this.config.retryBackoffMs,
								);
								resetEventTask(
									this.ctx.db,
									task,
									this.ctx.logger,
									"model validation failure",
									this.ctx.siteId,
								);
							}
						}
						return; // exit runTask — agent loop is not created
					}
				}

				const modelId = task.model_hint || undefined;
				const modelTier =
					modelId && this.config.modelTierResolver
						? (this.config.modelTierResolver(modelId) ?? undefined)
						: undefined;

				const loopConfig: AgentLoopConfig = {
					threadId,
					taskId: task.id,
					taskType: task.type,
					userId: "system",
					modelId,
					modelTier,
					noHistory: task.no_history === 1,
					systemPromptAddition: task.system_prompt_addition ?? undefined,
					// Progress-driven heartbeat. The setInterval-driven heartbeat at
					// scheduler.ts:357 covers the common case but can stall when the
					// in-memory runningTasks Map is lost (process restart, host
					// transition, or a long sync block on the main event loop).
					// onActivity fires from the agent loop itself at meaningful
					// progress points (turn boundaries, post-tool, periodic during
					// long tool execution — see agent-loop.ts call sites), so as long
					// as work is happening, heartbeat refreshes regardless of the
					// timer's health.
					onActivity: () => {
						updateRowIf(
							this.ctx.db,
							"tasks",
							task.id,
							{ lease_id: leaseId },
							{ heartbeat_at: new Date().toISOString() },
							this.ctx.siteId,
						);
					},
				};

				// Inject platform tools if resolver is available
				if (this.config.platformToolResolver) {
					const platformTools = this.config.platformToolResolver(threadId);
					if (platformTools.length > 0) {
						loopConfig.platformTools = platformTools;
					}
				}

				// Inject connector-authored instructions for connector-bound threads
				if (this.config.platformInstructionsResolver) {
					loopConfig.platformInstructions = this.config.platformInstructionsResolver(threadId);
				}

				const agentLoop = this.agentLoopFactory(loopConfig);

				const tracer = getTracer();
				const rootSpan = tracer.startSpan("scheduler.execute-task", {
					attributes: {
						"task.id": task.id,
						"task.type": task.type,
						"task.trigger_spec": task.trigger_spec ?? "",
						"thread.id": loopConfig.threadId,
					},
				});

				let result: Awaited<ReturnType<typeof agentLoop.run>>;
				// Emit "thinking" so WebSocket clients (web UI / TUI) watching this
				// thread show an active indicator while a scheduler-driven wakeup
				// (event, cron, deferred) runs its agent loop. Without this the web
				// UI shows the thread as idle for event wakeups, since the scheduler
				// path never went through the web/relay status:forward emitters (#42).
				this.ctx.eventBus.emit("status:forward", {
					thread_id: loopConfig.threadId,
					status: "thinking",
					tokens: 0,
					detail: null,
				});
				try {
					result = await context.with(trace.setSpan(context.active(), rootSpan), () =>
						agentLoop.run(),
					);
					rootSpan.setStatus({ code: SpanStatusCode.OK });
				} catch (err) {
					rootSpan.setStatus({
						code: SpanStatusCode.ERROR,
						message: err instanceof Error ? err.message : String(err),
					});
					throw err;
				} finally {
					rootSpan.end();
					// Signal completion regardless of success/failure so the indicator
					// clears. Cross-host watchers (web on a different host than the one
					// running the task) rely on the synced tasks.status='running' poll
					// instead; this local emit covers same-host live updates.
					this.ctx.eventBus.emit("status:forward", {
						thread_id: loopConfig.threadId,
						status: "idle",
						tokens: 0,
						detail: null,
					});
				}

				// Verify lease_id still matches
				const currentTask = this.ctx.db
					.query("SELECT lease_id FROM tasks WHERE id = ?")
					.get(task.id) as { lease_id: string | null } | undefined;

				if (currentTask?.lease_id === leaseId) {
					const resultStr = JSON.stringify(result);
					const completedAt = new Date().toISOString();

					if (result.error) {
						this.ctx.logger.warn("[scheduler] Task soft-failed", {
							taskId: task.id,
							triggerSpec: task.trigger_spec,
							type: task.type,
							error: result.error,
							messagesCreated: result.messagesCreated,
							toolCallsMade: result.toolCallsMade,
						});

						// Soft error: run() returned normally but with an error field
						// Use raw SQL to handle concurrent updates to consecutive_failures properly
						const txFn = this.ctx.db.transaction(() => {
							const updateResult = this.ctx.db
								.query(
									"UPDATE tasks SET status = 'failed', error = ?, result = ?, run_count = run_count + 1, last_run_at = ?, consecutive_failures = consecutive_failures + 1, modified_at = ? WHERE id = ? AND lease_id = ?", // outbox-routed: explicit createChangeLogEntry follows the UPDATE in this transaction (running → failed, soft-error path)
								)
								.run(
									result.error ?? "",
									resultStr,
									completedAt,
									new Date().toISOString(),
									task.id,
									leaseId,
								);

							if (updateResult.changes === 0) {
								// Lease CAS rejected — peer eviction landed first; the row is now in `pending` with
								// claim cleared. Don't emit a misleading change_log entry. Log and bail; the
								// healer / phase1 reclaim will drive next steps.
								this.ctx.logger.warn(
									"[scheduler] running→failed UPDATE rejected by lease CAS guard",
									{ taskId: task.id, expectedLease: leaseId, path: "soft-error" },
								);
								return -1; // Sentinel: lease CAS rejected
							}

							// Get the updated row to check new failure count
							const updatedTask = this.ctx.db
								.query("SELECT * FROM tasks WHERE id = ?")
								.get(task.id) as Task | null;
							if (!updatedTask) {
								throw new Error(`Task ${task.id} disappeared after soft error update`);
							}

							// Generate changelog entry with full row snapshot
							createChangeLogEntry(
								this.ctx.db,
								"tasks",
								task.id,
								this.ctx.siteId,
								updatedTask as unknown as Record<string, unknown>,
							);

							return updatedTask.consecutive_failures ?? 0;
						});

						const newConsecutiveFailures = txFn();
						if (newConsecutiveFailures === -1) {
							// Lease CAS guard rejected the update; bail without advisory
							return;
						}
						if (newConsecutiveFailures === task.alert_threshold) {
							this.triggerFailureAdvisory(task, result.error, newConsecutiveFailures);
						}

						// Cron tasks still reschedule even after soft errors so they keep retrying
						rescheduleCronTask(
							this.ctx.db,
							task,
							this.ctx.logger,
							"soft error",
							this.ctx.siteId,
							leaseId,
						);
						rescheduleHeartbeat(
							this.ctx.db,
							task,
							this.ctx.logger,
							"soft error",
							this.ctx.siteId,
							this.lastUserInteractionAt,
						);
						retryDeferredTask(
							this.ctx.db,
							task,
							newConsecutiveFailures,
							this.ctx.logger,
							this.ctx.siteId,
							this.config.retryBackoffMs,
						);
						resetEventTask(this.ctx.db, task, this.ctx.logger, "soft error", this.ctx.siteId);
					} else {
						this.ctx.logger.info("[scheduler] Task completed", {
							taskId: task.id,
							triggerSpec: task.trigger_spec,
							type: task.type,
							messagesCreated: result.messagesCreated,
							toolCallsMade: result.toolCallsMade,
							filesChanged: result.filesChanged,
						});

						// Mark as completed and reset consecutive failure counter.
						// CAS on status='running' so a prior heartbeat-timeout eviction
						// (which sets status='failed') stays sticky — the agent loop runs
						// independently of scheduler tick, so a long-stalled conversation
						// could otherwise overwrite eviction state on completion. Clearing
						// `error` pairs with the CAS: if we win the race the task is
						// genuinely complete and any prior error is stale.
						const wrote = updateRowIf(
							this.ctx.db,
							"tasks",
							task.id,
							{ status: "running", lease_id: leaseId },
							{
								status: "completed",
								result: resultStr,
								error: "",
								run_count: (task.run_count ?? 0) + 1,
								last_run_at: completedAt,
								consecutive_failures: 0,
							},
							this.ctx.siteId,
						);

						if (!wrote) {
							this.ctx.logger.warn(
								"[scheduler] Completion update skipped — task no longer running (likely evicted)",
								{
									taskId: task.id,
									triggerSpec: task.trigger_spec,
									type: task.type,
								},
							);
						}

						// If cron task, compute next run time
						rescheduleCronTask(
							this.ctx.db,
							task,
							this.ctx.logger,
							"completion",
							this.ctx.siteId,
							leaseId,
						);
						rescheduleHeartbeat(
							this.ctx.db,
							task,
							this.ctx.logger,
							"completion",
							this.ctx.siteId,
							this.lastUserInteractionAt,
						);
						resetEventTask(this.ctx.db, task, this.ctx.logger, "completion", this.ctx.siteId);
					}
				}

				// Fire-and-forget: generate a proper thread title (replaces the
				// null placeholder set during thread creation).
				if (this.config.generateTitle) {
					this.config
						.generateTitle(threadId)
						.catch((err) =>
							this.ctx.logger.warn(`Title generation failed for thread ${threadId}: ${err}`),
						);
				}
			} catch (error) {
				const errorMsg = formatError(error);

				this.ctx.logger.error("[scheduler] Task hard-failed", {
					taskId: task.id,
					triggerSpec: task.trigger_spec,
					type: task.type,
					error: errorMsg,
				});

				const currentTask = this.ctx.db
					.query("SELECT lease_id FROM tasks WHERE id = ?")
					.get(task.id) as { lease_id: string | null } | undefined;

				if (currentTask?.lease_id === leaseId) {
					// Use raw SQL to handle concurrent updates to consecutive_failures properly
					const txFn = this.ctx.db.transaction(() => {
						const updateResult = this.ctx.db
							.query(
								"UPDATE tasks SET status = 'failed', error = ?, consecutive_failures = consecutive_failures + 1, modified_at = ? WHERE id = ? AND lease_id = ?", // outbox-routed: explicit createChangeLogEntry follows the UPDATE in this transaction (running → failed, hard-error path)
							)
							.run(errorMsg, new Date().toISOString(), task.id, leaseId);

						if (updateResult.changes === 0) {
							// Lease CAS rejected — peer eviction landed first; the row is now in `pending` with
							// claim cleared. Don't emit a misleading change_log entry. Log and bail; the
							// healer / phase1 reclaim will drive next steps.
							this.ctx.logger.warn(
								"[scheduler] running→failed UPDATE rejected by lease CAS guard",
								{ taskId: task.id, expectedLease: leaseId, path: "hard-error" },
							);
							return -1; // Sentinel: lease CAS rejected
						}

						// Get the updated row to check new failure count
						const updatedTask = this.ctx.db
							.query("SELECT * FROM tasks WHERE id = ?")
							.get(task.id) as Task | null;
						if (!updatedTask) {
							throw new Error(`Task ${task.id} disappeared after hard error update`);
						}

						// Generate changelog entry with full row snapshot
						createChangeLogEntry(
							this.ctx.db,
							"tasks",
							task.id,
							this.ctx.siteId,
							updatedTask as unknown as Record<string, unknown>,
						);

						return updatedTask.consecutive_failures ?? 0;
					});

					const newConsecutiveFailures = txFn();
					if (newConsecutiveFailures === -1) {
						// Lease CAS guard rejected the update; bail without advisory
						return;
					}
					if (newConsecutiveFailures === task.alert_threshold) {
						this.triggerFailureAdvisory(task, errorMsg, newConsecutiveFailures);
					}

					// Persist alert message per R-E15
					if (task.thread_id) {
						try {
							const now = new Date().toISOString();
							// Recompute the firing key here: the one in runTask's try block
							// is out of scope in this catch, but task.next_run_at still holds
							// the claim-time instant (the reschedule below runs after this and
							// does not mutate the in-memory task), so it yields the same key.
							const firingKey = computeFiringKey(task.id, task.next_run_at);
							insertRow(
								this.ctx.db,
								"messages",
								{
									// Firing-key convergence (#46): a split-brain double-dispatch
									// that fails on both hosts derives the same alert id, so the
									// "Task failed" rows LWW-collapse to one instead of doubling.
									// Random fallback for event firings (no scheduled instant).
									id: firingKey ? deriveFiringArtifactId(firingKey, "failalert") : randomUUID(),
									thread_id: task.thread_id,
									role: "alert",
									content: `Task ${task.id} failed: ${errorMsg}`,
									model_id: null,
									tool_name: null,
									created_at: now,
									modified_at: now,
									host_origin: this.ctx.siteId,
									deleted: 0,
									exit_code: null,
									metadata: null,
								},
								this.ctx.siteId,
							);
						} catch (alertError) {
							this.ctx.logger.error("Failed to persist task failure alert", {
								error: alertError instanceof Error ? alertError.message : String(alertError),
							});
						}
					}

					// Cron tasks must reschedule even after hard errors so they keep running on schedule
					rescheduleCronTask(
						this.ctx.db,
						task,
						this.ctx.logger,
						"hard error",
						this.ctx.siteId,
						leaseId,
					);
					rescheduleHeartbeat(
						this.ctx.db,
						task,
						this.ctx.logger,
						"hard error",
						this.ctx.siteId,
						this.lastUserInteractionAt,
					);
					retryDeferredTask(
						this.ctx.db,
						task,
						newConsecutiveFailures,
						this.ctx.logger,
						this.ctx.siteId,
						this.config.retryBackoffMs,
					);
					resetEventTask(this.ctx.db, task, this.ctx.logger, "hard error", this.ctx.siteId);
				}
			} finally {
				this.runningTasks.delete(task.id);
			}
		});
	}

	// Event handler to be called when an event is emitted
	onEvent(eventType: string, _payload: unknown): void {
		if (this.eventDepth >= MAX_EVENT_DEPTH) {
			this.ctx.logger.warn("Max event depth exceeded");
			return;
		}

		this.eventDepth++;

		try {
			const eventTasks = this.ctx.db
				.query(
					"SELECT * FROM tasks WHERE type = 'event' AND status = 'pending' AND deleted = 0 AND trigger_spec = ?",
				)
				.all(eventType) as Task[];

			for (const task of eventTasks) {
				if (canRunHere(this.ctx.db, task, this.ctx.hostName, this.ctx.siteId)) {
					const claimedAt = new Date().toISOString();
					// CAS: only claim if still pending (prevents duplicate event execution)
					const txFn = this.ctx.db.transaction(() => {
						const result = this.ctx.db
							.query(
								"UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ? AND status = 'pending'", // outbox-routed: explicit createChangeLogEntry follows the CAS UPDATE in this transaction (post-eviction reclaim)
							)
							.run(this.ctx.siteId, claimedAt, task.id);
						if (result.changes > 0) {
							// Generate changelog entry for the successful claim
							return createChangeLogEntry(this.ctx.db, "tasks", task.id, this.ctx.siteId, {
								status: "claimed",
								claimed_by: this.ctx.siteId,
								claimed_at: claimedAt,
								modified_at: new Date().toISOString(),
							});
						}
						return null;
					});

					txFn(); // hlc return value not used here
				}
			}
		} finally {
			this.eventDepth--;
		}
	}

	private triggerFailureAdvisory(task: Task, error: string, consecutiveFailures: number): void {
		// #67: suppress advisories for environmental connectivity failures. A host
		// disconnected from the internet fails every remote-model task at once, which
		// would otherwise file one unactionable "task failed N times" advisory per
		// task — a flood. The failure remains recorded on the task row; only the
		// redundant advisory is skipped, and it self-resolves when connectivity returns.
		if (isConnectivityFailure(error)) {
			this.ctx.logger.info(
				"[scheduler] Suppressing failure advisory for connectivity-class error (#67)",
				{ taskId: task.id, consecutiveFailures, error: error.slice(0, 200) },
			);
			return;
		}
		try {
			createAdvisory(
				this.ctx.db,
				{
					type: "general",
					status: "proposed",
					title: `Task has failed ${consecutiveFailures} times consecutively`,
					detail: `Task ${task.id} has failed ${consecutiveFailures} consecutive times. Latest error: ${error.slice(0, 500)}`,
					action: "Review the task configuration, model availability, and error details.",
					impact:
						"Scheduled task is not completing. Cron tasks will continue retrying on schedule.",
					evidence: JSON.stringify({
						taskId: task.id,
						consecutiveFailures,
						error: error.slice(0, 500),
					}),
				},
				this.ctx.siteId,
				task.thread_id ?? null,
			);
		} catch (advisoryError) {
			this.ctx.logger.error("[scheduler] Failed to create task failure advisory", {
				error: formatError(advisoryError),
				taskId: task.id,
			});
		}
	}

	private getCronTemplate(task: Task): string[] | null {
		// Only check cron tasks
		if (task.type !== "cron") {
			return null;
		}

		// Parse trigger_spec to get cron expression
		const specResult = parseJsonUntyped(task.trigger_spec, "cron trigger_spec");
		if (!specResult.ok || typeof specResult.value !== "object" || specResult.value === null) {
			return null;
		}
		const cronSpec = specResult.value as { type?: string; expression?: string; name?: string };

		// Look up in cron_schedules config if available
		const cronResult = this.ctx.optionalConfig.cronSchedules;
		if (!cronResult || !cronResult.ok) {
			return null;
		}

		// Find matching schedule by expression or name
		const schedules = cronResult.value as Record<string, { schedule: string; template?: string[] }>;
		for (const [name, schedule] of Object.entries(schedules)) {
			// Skip non-cron entries (e.g., heartbeat config)
			if (name === "heartbeat" || !schedule.schedule) continue;
			if (schedule.schedule === cronSpec.expression && schedule.template) {
				return schedule.template;
			}
		}

		return null;
	}

	private runTemplateTask(task: Task, leaseId: string, template: string[]): void {
		setImmediate(async () => {
			try {
				// Execute template commands directly (no LLM call)
				const outputs: string[] = [];

				if (this.sandbox?.exec) {
					for (const cmd of template) {
						const result = await this.sandbox.exec(cmd);
						outputs.push(result.stdout || result.stderr);
						if (result.exitCode !== 0) {
							this.ctx.logger.warn("[scheduler] Template command failed", {
								taskId: task.id,
								cmd,
								exitCode: result.exitCode,
								stderr: result.stderr,
							});
						}
					}
				} else {
					this.ctx.logger.warn("[scheduler] No sandbox available for template execution", {
						taskId: task.id,
					});
				}

				// Verify lease_id still matches
				const currentTask = this.ctx.db
					.query("SELECT lease_id FROM tasks WHERE id = ?")
					.get(task.id) as { lease_id: string | null } | undefined;

				if (currentTask?.lease_id === leaseId) {
					const result = JSON.stringify({
						template_executed: true,
						commands: template,
						outputs,
					});

					// CAS on status='running' so a prior heartbeat-timeout eviction
					// stays sticky. Clearing `error` pairs with the CAS.
					const wrote = updateRowIf(
						this.ctx.db,
						"tasks",
						task.id,
						{ status: "running" },
						{
							status: "completed",
							result,
							error: "",
							run_count: (task.run_count ?? 0) + 1,
							last_run_at: new Date().toISOString(),
						},
						this.ctx.siteId,
					);

					if (!wrote) {
						this.ctx.logger.warn(
							"[scheduler] Template completion skipped — task no longer running (likely evicted)",
							{
								taskId: task.id,
								triggerSpec: task.trigger_spec,
								type: task.type,
							},
						);
					}

					// If cron task, compute next run time
					rescheduleCronTask(
						this.ctx.db,
						task,
						this.ctx.logger,
						"completion",
						this.ctx.siteId,
						leaseId,
					);
					rescheduleHeartbeat(
						this.ctx.db,
						task,
						this.ctx.logger,
						"template completion",
						this.ctx.siteId,
						this.lastUserInteractionAt,
					);
					resetEventTask(
						this.ctx.db,
						task,
						this.ctx.logger,
						"template completion",
						this.ctx.siteId,
					);
				}
			} catch (error) {
				const errorMsg = formatError(error);
				const currentTask = this.ctx.db
					.query("SELECT lease_id FROM tasks WHERE id = ?")
					.get(task.id) as { lease_id: string | null } | undefined;

				if (currentTask?.lease_id === leaseId) {
					updateRow(
						this.ctx.db,
						"tasks",
						task.id,
						{ status: "failed", error: errorMsg },
						this.ctx.siteId,
					);

					// Cron template tasks must reschedule even after hard errors
					rescheduleCronTask(
						this.ctx.db,
						task,
						this.ctx.logger,
						"template hard error",
						this.ctx.siteId,
						leaseId,
					);
					rescheduleHeartbeat(
						this.ctx.db,
						task,
						this.ctx.logger,
						"template hard error",
						this.ctx.siteId,
						this.lastUserInteractionAt,
					);
					resetEventTask(
						this.ctx.db,
						task,
						this.ctx.logger,
						"template hard error",
						this.ctx.siteId,
					);
				}
			} finally {
				this.runningTasks.delete(task.id);
			}
		});
	}

	// Get current quiescence-adjusted poll interval using 4-tier graduated table
	getEffectivePollInterval(): number {
		const baseInterval = this.config.basePollIntervalMs ?? POLL_INTERVAL;

		// Check if any pending tasks have no_quiescence set
		const noQuiescenceTasks = this.ctx.db
			.query("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending' AND no_quiescence = 1")
			.get() as { count: number } | null;

		// If any task requires immediate attention, use base interval
		if (noQuiescenceTasks && noQuiescenceTasks.count > 0) {
			return baseInterval;
		}

		// Compute quiescence multiplier using the shared helper
		const multiplier = computeQuiescenceMultiplier(this.lastUserInteractionAt);

		return baseInterval * multiplier;
	}
}
