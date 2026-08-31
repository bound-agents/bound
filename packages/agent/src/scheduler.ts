import { randomUUID } from "node:crypto";
import type { AppContext } from "@bound/core";
import {
	HOST_HEARTBEAT_INTERVAL,
	acknowledgeDurableWork,
	claimLocalDurableWork,
	countPendingIntakeDurableWork,
	createChangeLogEntry,
	deadLetterClaimedDurableWork,
	hasDroppedLegacyRelayTables,
	insertRow,
	listHostsWithLiveness,
	markProcessed,
	resolveEffectiveModelHint,
	updateRow,
	updateRowIf,
	withTx,
} from "@bound/core";
import type { PlatformRegisteredTool } from "@bound/platforms";
import {
	BOUND_NAMESPACE,
	counter,
	deterministicUUID,
	formatError,
	parseJsonUntyped,
} from "@bound/shared";
import type { Task } from "@bound/shared";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import { createAdvisory } from "./advisories";
import type { MainAgentLoop } from "./agent-loop";
import { buildConsolidationContext } from "./consolidation-context";
import { buildEventWakeupContent } from "./event-payload";
import { buildHeartbeatContext } from "./heartbeat-context";
import { PASSIVE_INTAKE_KINDS } from "./intake-kind-registry";
import {
	recordAgentOperationalMetric,
	recordSchedulerClaimDelay,
	recordSchedulerExecutionDuration,
	recordSchedulerQueueDelay,
} from "./operational-metrics";
import {
	FIRING_HOST_STALE_MS,
	canRunHere,
	computeFiringKey,
	computeNextRunAt,
	deriveFiringArtifactId,
	deriveFiringWakeupIds,
	shouldDispatchHere,
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
 * Producer mode for task_fire durable-work rows (slice 5B, R-DW15–R-DW21).
 *
 * Three states, read once from `BOUND_TASK_FIRE_MODE` at module init and
 * overridable in tests via {@link setTaskFireModeForTesting}:
 *  - `"legacy"`   — byte-identical to pre-5B behaviour: the phase-1 CAS + run,
 *    no comparison computation, no telemetry. The rollback posture.
 *  - `"compare"`  — DEFAULT. The legacy path still executes; in addition the
 *    scheduler computes the would-be durable enqueue decision and emits a
 *    `task_fire_comparison` telemetry record. NO durable_work row is inserted
 *    — comparison mode never runs two execution paths for one artifact.
 *  - `"durable"`  — accepted so a premature flip is safe, but durable task
 *    firing does not arrive until a later release: it warns once per process
 *    then behaves exactly as `"compare"`.
 *
 * Follows the BOUND_DURABLE_* toggle pattern (packages/core/src/durable-work.ts)
 * as a three-state string rather than a boolean. Lives at scheduler module
 * scope — the scheduler is the only producer/consumer of task_fire.
 */
export type TaskFireMode = "legacy" | "compare" | "durable";

function parseTaskFireMode(raw: string | undefined): TaskFireMode {
	switch (raw?.toLowerCase()) {
		case "legacy":
			return "legacy";
		case "durable":
			return "durable";
		default:
			// Unset, "compare", or any unrecognized value defaults to compare — the
			// safe migration-window posture (legacy still runs; no durable rows).
			return "compare";
	}
}

let TASK_FIRE_MODE: TaskFireMode = parseTaskFireMode(process.env.BOUND_TASK_FIRE_MODE);
/** Process-wide one-shot latch for the unavailable durable task_fire producer warning. */
let warnedDurableTaskFireUnavailable = false;

/** Test seam: override the task_fire producer mode and reset its warning latch. */
export function setTaskFireModeForTesting(mode: TaskFireMode | undefined): void {
	TASK_FIRE_MODE = mode ?? parseTaskFireMode(process.env.BOUND_TASK_FIRE_MODE);
	warnedDurableTaskFireUnavailable = false;
}

/** OTel counter for task_fire comparison records (slice 5B dual-execution proof). */
const taskFireComparisonCounter = counter("bound.scheduler.task_fire.comparison", {
	description: "task_fire producer comparison-mode decisions by decision_match (slice 5B)",
});

/**
 * Extracts the raw cron expression from a trigger_spec string.
 * The schedule command stores trigger_spec as JSON like {"type":"cron","expression":"0 * * * *"},
 * but older rows may carry a raw cron string like "0 * * * *".
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
 * wedges the task indefinitely. (Observed in production: a webhook task sat stuck for
 * ~17h after its host restarted mid-run.) Set to 2× EVICTION_TIMEOUT so the orphan arm
 * never races the normal gate:
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
 * does NOT by itself defeat a stale peer that re-pends the row via a fresher
 * `modified_at` — that requires soft-delete tombstones to take LWW precedence
 * over a plain field update, which is separate, not-yet-done work.
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
 * peer that re-pends the row with a fresher `modified_at` — that requires
 * soft-delete tombstones to take LWW precedence over a plain field update,
 * which is separate, not-yet-done work.
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
 * completed event tasks every N minutes with no new event payload — a spin
 * observed in production as one real interaction producing 29 wake-ups over
 * 70 minutes with no new content on any of them. The periodic-fallback idea
 * came from a spec note about the connector **dispatcher** ("periodic cron
 * fallback wakes the dispatcher even without list_changed"); that note
 * applies to the dispatcher, not to per-event handler tasks like this one —
 * the two got conflated. (The dispatcher itself was later removed; see the
 * MCP Platform Connectors RFC.)
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
 * free phantom wakeups. Observed in production: a single soft-fail produced a
 * 5-wakeup cluster within minutes with no new event content on any retry. The
 * narrow case the
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
	if (task.thread_id) {
		// Re-arm if EITHER store has pending foldable intake for this thread.
		// markProcessed / acknowledgeDurableWork (below, post-wakeup-insert) drain
		// what this run folded BEFORE the agent loop runs, so a pending row here
		// can only be (a) an event that arrived MID-RUN — onEvent's CAS claim
		// fails while the task is claimed/running, so without this re-arm the
		// event strands until the next event happens to fire — or (b) a wakeup
		// that failed before draining, where the retry replays the actual payload.
		//
		// Kinds match buildEventWakeupContent's readers exactly: webhook_intake,
		// connector_intake, AND rss_intake all fold into the wakeup, from both the
		// legacy relay_inbox and the new durable_work intake store (4C-2). Since
		// the single-delivery-vehicle change, connector_intake rows are the ONLY
		// leader-local record of a platform event, so missing them here loses
		// events outright (observed: Discord messages during an active loop
		// produced no response). The completion path runs this check too —
		// completing the CURRENT wakeup says nothing about rows that arrived
		// after its fold drained the stores.
		//
		// A stray platform-MCP `intake` row sharing this thread_id would NOT
		// survive a retry into the helper, so it is deliberately not counted
		// (retrying on its presence would be a phantom wakeup).
		// Post-drop (slice 4E): relay_inbox is gone on this host — the durable
		// spool is the sole intake store, so skip the legacy read (it would throw).
		const pendingRelay = hasDroppedLegacyRelayTables(db)
			? 0
			: ((
					db
						.query(
							`SELECT COUNT(*) as c FROM relay_inbox WHERE ref_id = ? AND processed = 0 AND kind IN (${PASSIVE_INTAKE_KINDS.map(() => "?").join(", ")})`,
						)
						.get(task.thread_id, ...PASSIVE_INTAKE_KINDS) as { c: number } | null
				)?.c ?? 0);
		const pendingDurable = countPendingIntakeDurableWork(db, task.thread_id);
		if (pendingRelay > 0 || pendingDurable > 0) {
			const failures = current.consecutive_failures ?? 0;
			if (isCompletion) {
				// Success path with pending rows: immediate re-arm — this is a
				// live event waiting, not a retry backoff.
				nextRunAt = new Date().toISOString();
			} else if (failures < MAX_EVENT_TASK_FAILURE_BACKOFFS) {
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

	// Consolidation runs on a fixed 4h schedule — idle time is ideal for
	// memory maintenance, so quiescence stretching provides no benefit.
	const multiplier =
		task.type === "consolidation" ? 1 : computeQuiescenceMultiplier(lastUserInteractionAt);

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
	if (task.type !== "heartbeat" && task.type !== "consolidation") return;

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
			// 'completed' is a recoverable wedge for them. Cron's own 'completed' wedge
			// is truly terminal (cron re-arms via next_run_at, not by needing a status
			// flip) so it is deliberately excluded here.
			//
			// Event tasks also recover from 'completed', for a different reason than
			// heartbeats: resetEventTask's own status='pending' write (immediately
			// following completion) can be clobbered by a concurrent sync changeset
			// for the same row from a peer host that raced the same delivery — the
			// peer's LWW-newer snapshot of the row (itself mid- or post-completion,
			// carrying its own 'completed' status and a stale next_run_at) wins the
			// merge and overwrites the local pending-reset after the fact. Unlike a
			// crash mid-window, this is not self-healing — nothing re-runs
			// resetEventTask once the row settles in 'completed', and the pending-task
			// sweep never selects it, so the webhook/connector handler goes dark for
			// every subsequent delivery. Observed in production: task f862e622
			// (webhook:bound) stuck in 'completed' with next_run_at pinned to a stale
			// pre-run timestamp from a peer host's earlier firing. The claimed_at <
			// threshold guard (same as heartbeats) keeps a healthy in-flight event task
			// from ever matching. Cron intentionally stays excluded — its 'completed'
			// state is written by the SAME rescheduleCronTask call that sets
			// next_run_at in one step, so cron never wedges in 'completed' the way
			// event's two-step (complete, then separately resetEventTask) can.
			// from ever matching.
			`SELECT * FROM tasks
			WHERE deleted = 0
			  AND claimed_by IS NOT NULL
			  AND claimed_at < ?
			  AND (
			    (type = 'heartbeat' AND status IN ('failed', 'cancelled', 'completed'))
			    OR (type = 'event' AND status IN ('failed', 'completed'))
			    OR (type = 'cron' AND status = 'failed')
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
				case "consolidation":
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

/**
 * Identity payload of a single deterministic task firing (slice 5A, R-DW15–21).
 *
 * A `task_fire` durable_work row carries ONLY the firing's identity — the
 * `(task_id, scheduled_at)` pair that names one due instant of a synced
 * schedule binding. It deliberately does not snapshot the binding: the `tasks`
 * row is synced and locally readable, so the consumer reads the live row at
 * claim time. A binding that was deleted, paused, re-armed, or already claimed
 * elsewhere makes this firing STALE — the consumer no-ops it (structured log,
 * not an error), never re-executing a moved-on binding.
 *
 * `scheduled_at` is the task's `next_run_at` at enqueue time — the same due
 * instant `computeFiringKey` keys on — so a firing whose live `next_run_at` has
 * advanced past it is detectably stale.
 */
export interface TaskFirePayload {
	task_id: string;
	scheduled_at: string;
}

/**
 * Deterministic `(kind, idempotency_key)` fence for a task firing, matching the
 * registry declaration in {@link DURABLE_WORK_REGISTRY} (`task_fire`). Two
 * enqueues of the same `(task_id, scheduled_at)` collapse to one durable row.
 */
export function taskFireIdempotencyKey(payload: TaskFirePayload): string {
	return `task-fire:${payload.task_id}:${payload.scheduled_at}`;
}

/** Attempt budget before an infrastructure-failing firing is dead-lettered. */
const TASK_FIRE_MAX_ATTEMPTS = 3;

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
	/** Live node default used after task and thread model hints. */
	modelDefaultResolver?: () => string;
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
		private agentLoopFactory: (config: AgentLoopConfig) => MainAgentLoop,
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
			// Check for emergency stop. deleted = 0 so a cleared (soft-deleted) flag
			// does not keep halting the scheduler.
			const emergencyStop = this.ctx.db
				.query("SELECT value FROM cluster_config WHERE key = 'emergency_stop' AND deleted = 0")
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

			// Slice 5A: task_fire consumer lane. A durable pass mirroring the relay
			// processor's — claims pending task_fire rows targeted at this host,
			// bridges the legacy CAS into runTask, and consumes the firing. In 5A no
			// production code enqueues task_fire rows (the producer flip is 5B/5C),
			// so this carries only test traffic; it is fire-and-forget on the tick
			// cadence and never blocks the synchronous phases above.
			void this.processPendingTaskFire().catch((error) => {
				this.ctx.logger.error("[scheduler] task_fire consumer pass escaped", {
					error: formatError(error),
				});
			});
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

							case "heartbeat":
							case "consolidation": {
								nextRunAtIso = computeHeartbeatNextRunAt(task, this.lastUserInteractionAt);
								break;
							}

							case "event": {
								// R-LR3 design note: the relay_inbox SELECT lives inside the eviction transaction.
								// Post-drop (slice 4E): relay_inbox is gone — the durable spool is the
								// sole intake store, so treat legacy as having nothing unprocessed.
								const unprocessed = hasDroppedLegacyRelayTables(this.ctx.db)
									? null
									: this.ctx.db
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
			// Rendezvous winner. Reused verbatim by the 5B comparison computation
			// below so the legacy dispatch decision and the would-be durable enqueue
			// decision derive from ONE evaluation — a mismatch is therefore
			// structurally impossible while 5C's producer has not yet diverged from
			// this gate, which is exactly the invariant the telemetry proves.
			const legacyDispatched = shouldDispatchHere(
				this.ctx.db,
				task,
				this.ctx.hostName,
				this.ctx.siteId,
			);
			let legacyClaimWon = false;
			if (legacyDispatched) {
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
				} else {
					legacyClaimWon = true;
					if (task.next_run_at) {
						recordSchedulerQueueDelay(
							new Date(claimedAt).getTime() - new Date(task.next_run_at).getTime(),
							{ type: task.type },
						);
					}
				}
			}

			// Slice 5B: task_fire PRODUCER in comparison mode. The legacy CAS above
			// ran EXACTLY as at HEAD; here we additionally record the would-be durable
			// enqueue decision. In "compare"/"durable" mode NO durable_work row is
			// inserted — the migration plan forbids running both execution paths for
			// one artifact without the shared idempotency fence, so the dual-execution
			// proof is a comparison, not a second execution. "legacy" mode skips this
			// entirely (the rollback posture, byte-identical to HEAD).
			this.recordTaskFireComparison(task, legacyDispatched, legacyClaimWon);
		}
	}

	/**
	 * Emit the slice-5B task_fire comparison record for one due scheduled firing.
	 *
	 * `would_enqueue` is the rendezvous winner result — the SAME value the legacy
	 * gate used ({@link shouldDispatchHere}'s output, threaded in as
	 * `legacyDispatched`), not a recomputation — so `decision_match` is
	 * structurally true today. The record exists to (a) count real firings that
	 * flow through the comparison window and (b) catch drift if 5C's producer ever
	 * diverges from this gate. Logs + a low-cardinality OTel counter only; never
	 * persisted to a synced table (bounded namespace). Event tasks never reach
	 * here (phase-1 scans `next_run_at IS NOT NULL`), preserving R-DW18.
	 */
	private recordTaskFireComparison(
		task: Task,
		legacyDispatched: boolean,
		legacyClaimWon: boolean,
	): void {
		if (TASK_FIRE_MODE === "legacy") return;
		if (TASK_FIRE_MODE === "durable") this.warnDurableTaskFireUnavailable();

		// Phase-1 already filtered to next_run_at non-null, but keep the guard so a
		// future caller can't slip an event firing into the comparison lane.
		const scheduledAt = task.next_run_at;
		if (scheduledAt === null) return;

		const firingKey = computeFiringKey(task.id, scheduledAt);
		if (firingKey === null) return;
		const idempotencyKey = taskFireIdempotencyKey({
			task_id: task.id,
			scheduled_at: scheduledAt,
		});
		// Rendezvous candidate-set size — the same live-host set shouldDispatchHere
		// scored — recorded for window observability, not decision logic.
		const candidateCount = this.countFiringCandidates(task);
		// The new path's decision IS the rendezvous winner the legacy gate computed.
		const wouldEnqueue = legacyDispatched;
		const decisionMatch = legacyDispatched === wouldEnqueue;

		this.ctx.logger.info("[scheduler] task_fire comparison", {
			event: "task_fire_comparison",
			task_id: task.id,
			scheduled_at: scheduledAt,
			firing_key: firingKey,
			idempotency_key: idempotencyKey,
			legacy_dispatched: legacyDispatched,
			legacy_claim_won: legacyClaimWon,
			would_enqueue: wouldEnqueue,
			candidate_count: candidateCount,
			decision_match: decisionMatch,
		});
		// Low-cardinality counter: decision_match only (IDs live in the log line).
		taskFireComparisonCounter.add(1, {
			"bound.task_fire.decision_match": String(decisionMatch),
		});
	}

	/** Warn once per process that a premature `durable` flip degrades to compare. */
	private warnDurableTaskFireUnavailable(): void {
		if (warnedDurableTaskFireUnavailable) return;
		warnedDurableTaskFireUnavailable = true;
		this.ctx.logger.warn(
			"[scheduler] BOUND_TASK_FIRE_MODE=durable set, but durable task firing arrives in a later release; behaving as compare",
			{ event: "task_fire_durable_mode_unavailable" },
		);
	}

	/**
	 * Count the live-host rendezvous candidate set for a firing, mirroring
	 * {@link shouldDispatchHere}'s candidate construction (live hosts passing the
	 * task's own affinity gate, plus self). Observability only — the winner
	 * decision is reused from the gate, never recomputed here.
	 */
	private countFiringCandidates(task: Task): number {
		const cutoff = Date.now() - FIRING_HOST_STALE_MS;
		const seen = new Set<string>();
		for (const row of listHostsWithLiveness(this.ctx.db)) {
			if (seen.has(row.site_id)) continue;
			const ts = row.modified_at ?? row.online_at;
			if (!ts || new Date(ts).getTime() < cutoff) continue;
			const peerHostName = row.host_name ?? row.site_id;
			if (!canRunHere(this.ctx.db, task, peerHostName, row.site_id)) continue;
			seen.add(row.site_id);
		}
		if (!seen.has(this.ctx.siteId)) seen.add(this.ctx.siteId);
		return seen.size;
	}

	/**
	 * Slice 5A consumer lane for `task_fire` durable-work rows.
	 *
	 * Mirrors the relay processor's `processPendingDurableWork`: claim a pending
	 * row targeted at this host (local-exclusive, BEGIN IMMEDIATE), execute it,
	 * then token-fenced ack. The execution bridge is deliberately minimal so
	 * that {@link runTask} stays UNTOUCHED (5C refactors it): the consumer
	 * validates the payload, re-reads the LIVE `tasks` binding, verifies the
	 * firing is still due for the payload's `scheduled_at`, performs the legacy
	 * `pending → claimed` CAS, and invokes `runTask`. The firing is consumed
	 * only after `runTask` returns — its completion/failure write-backs ARE the
	 * task outcome, so the firing was executed either way.
	 *
	 * Disposition matrix:
	 *  - malformed payload (not `{task_id, scheduled_at}`) → token-fenced
	 *    dead-letter (redrivable after a producer fix); mirrors 4D-A's
	 *    null-source_site handling.
	 *  - binding gone / paused / re-armed / claimed elsewhere / next_run_at moved
	 *    / event task (next_run_at NULL) → STALE: consume as a no-op with a
	 *    structured log, never an error, never re-executing a moved-on binding.
	 *  - legacy `pending → claimed` CAS loses (a peer claimed first) → STALE:
	 *    consume as a no-op.
	 *  - infrastructure failure BEFORE `runTask` starts → leave the row
	 *    `processing` (claim-owned) for boot recovery; only after the attempt
	 *    budget is exhausted across reclaims do we token-fence it into a dead
	 *    letter.
	 */
	async processPendingTaskFire(): Promise<void> {
		let claimed: ReturnType<typeof claimLocalDurableWork> | undefined;
		try {
			claimed = claimLocalDurableWork(this.ctx.db, this.ctx.siteId, "task_fire");
			if (!claimed) return;

			const token = claimed.claim_token ?? "";

			// Payload validation: malformed input is a producer defect, not an
			// infrastructure failure — dead-letter it immediately (workspool-redrivable
			// after a fix) rather than cycling forever or consuming it silently.
			const parsedPayload = this.parseTaskFirePayload(claimed.payload);
			if (!parsedPayload.payload) {
				deadLetterClaimedDurableWork(
					this.ctx.db,
					claimed.id,
					token,
					`malformed task_fire payload: ${parsedPayload.error}`,
				);
				this.ctx.logger.warn("[scheduler] Dead-lettered malformed task_fire row", {
					durableWorkId: claimed.id,
				});
				return;
			}
			const payload = parsedPayload.payload;

			// Read the LIVE binding. The row is synced and locally readable; the
			// payload carries identity only (R-DW15), so staleness is decided against
			// the current row, never a snapshot.
			const task = this.ctx.db
				.query("SELECT * FROM tasks WHERE id = ? AND deleted = 0")
				.get(payload.task_id) as Task | null;

			const stale = this.classifyStaleFiring(task, payload);
			if (stale) {
				this.ctx.logger.info("[scheduler] task_fire is stale; consuming as no-op", {
					durableWorkId: claimed.id,
					taskId: payload.task_id,
					scheduledAt: payload.scheduled_at,
					reason: stale,
				});
				if (!acknowledgeDurableWork(this.ctx.db, claimed.id, token)) {
					this.ctx.logger.warn("[scheduler] Lost task_fire claim before stale no-op ack", {
						durableWorkId: claimed.id,
					});
				}
				return;
			}
			// classifyStaleFiring returning null guarantees a live, due, scheduled task.
			const dueTask = task as Task;

			try {
				// Legacy pending → claimed CAS (the phase1 shape). This is the exclusion
				// point: if a peer already claimed/ran this firing, the CAS no-ops and we
				// treat it as a stale firing rather than double-running. runTask's own
				// claimed → running lease CAS then works unchanged.
				const claimedAt = new Date().toISOString();
				const bridged = this.ctx.db.transaction(() => {
					const result = this.ctx.db
						.query(
							"UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ? AND status = 'pending'", // outbox-routed: explicit createChangeLogEntry follows the CAS UPDATE in this transaction (pending → claimed)
						)
						.run(this.ctx.siteId, claimedAt, dueTask.id);
					if (result.changes > 0) {
						return createChangeLogEntry(this.ctx.db, "tasks", dueTask.id, this.ctx.siteId, {
							status: "claimed",
							claimed_by: this.ctx.siteId,
							claimed_at: claimedAt,
							modified_at: new Date().toISOString(),
						});
					}
					return null;
				})();

				if (!bridged) {
					// CAS lost — a peer claimed the binding between our read and here.
					// Stale firing: consume as a no-op.
					this.ctx.logger.info(
						"[scheduler] task_fire bridge CAS lost (binding claimed elsewhere); consuming as no-op",
						{ durableWorkId: claimed.id, taskId: dueTask.id },
					);
					if (!acknowledgeDurableWork(this.ctx.db, claimed.id, token)) {
						this.ctx.logger.warn("[scheduler] Lost task_fire claim before stale no-op ack", {
							durableWorkId: claimed.id,
						});
					}
					return;
				}

				// Bridge into the UNTOUCHED execution body. runTask launches the agent
				// loop asynchronously (setImmediate); its completion/failure write-backs
				// land the task outcome independently. We hand off with the freshly-
				// claimed row snapshot so runTask's claimed → running lease CAS matches.
				this.runTask({
					...dueTask,
					status: "claimed",
					claimed_by: this.ctx.siteId,
					claimed_at: claimedAt,
				});

				// Ack (→ consumed) after runTask RETURNS. runTask returns synchronously
				// once it has committed the claimed → running CAS and scheduled the async
				// loop; the firing is executed either way (its outcome is the task
				// completion/failure write-back), so this consumes the firing.
				if (!acknowledgeDurableWork(this.ctx.db, claimed.id, token)) {
					this.ctx.logger.warn("[scheduler] Lost task_fire claim before acknowledgement", {
						durableWorkId: claimed.id,
					});
				}
			} catch (error) {
				// Infrastructure failure before the firing was durably driven. Leave the
				// row `processing` (claim-owned) so boot recovery reclaims it — NO
				// consume, NO immediate dead-letter. Only after the attempt budget is
				// exhausted across reclaims do we token-fence it into a dead letter.
				this.ctx.logger.error("[scheduler] task_fire processing failed before completion", {
					error: formatError(error),
					durableWorkId: claimed.id,
				});
				if (claimed.attempt_count >= TASK_FIRE_MAX_ATTEMPTS) {
					deadLetterClaimedDurableWork(this.ctx.db, claimed.id, token, formatError(error));
				}
			}
		} catch (error) {
			// Includes failures before the bridge (claim/payload/binding/staleness). A
			// claimed row stays processing for recovery; do not consume it here.
			this.ctx.logger.error("[scheduler] task_fire processing failed before completion", {
				error: formatError(error),
				durableWorkId: claimed?.id,
			});
			if (claimed && claimed.attempt_count >= TASK_FIRE_MAX_ATTEMPTS) {
				deadLetterClaimedDurableWork(
					this.ctx.db,
					claimed.id,
					claimed.claim_token ?? "",
					formatError(error),
				);
			}
		}
	}

	/** Parse and validate a task_fire payload, including scheduled_at timestamp syntax. */
	private parseTaskFirePayload(raw: string): { payload: TaskFirePayload | null; error: string } {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { payload: null, error: "payload is not valid JSON" };
		}
		if (typeof parsed !== "object" || parsed === null)
			return { payload: null, error: "payload must be an object" };
		const { task_id, scheduled_at } = parsed as Record<string, unknown>;
		if (typeof task_id !== "string" || task_id.length === 0) {
			return { payload: null, error: "task_id must be a non-empty string" };
		}
		if (typeof scheduled_at !== "string" || scheduled_at.length === 0) {
			return { payload: null, error: "scheduled_at must be a non-empty string" };
		}
		if (Number.isNaN(Date.parse(scheduled_at))) {
			return { payload: null, error: "scheduled_at must be a valid ISO-8601 timestamp" };
		}
		return { payload: { task_id, scheduled_at }, error: "" };
	}

	/**
	 * Classify whether a firing is stale against its live binding. Returns a
	 * reason string when stale (caller no-op-consumes) or null when the firing is
	 * live, due, and safe to execute.
	 */
	private classifyStaleFiring(task: Task | null, payload: TaskFirePayload): string | null {
		if (!task) return "binding_missing";
		// Event tasks (next_run_at NULL) fire through onEvent, never this lane
		// (R-DW18 preserves event semantics). Producers never mint task_fire rows
		// for them; guard by payload/binding shape anyway.
		if (task.next_run_at === null) return "event_task";
		// The binding must still be pending to fire. A claimed/running/failed/
		// completed row means another host (or a prior run) already owns this
		// firing's instant.
		if (task.status !== "pending") return "binding_not_pending";
		// The live due instant must still match the firing we were minted for. A
		// re-arm (cron/heartbeat advance, reschedule) moves next_run_at forward,
		// making this firing a stale duplicate of a past instant.
		if (new Date(task.next_run_at).toISOString() !== new Date(payload.scheduled_at).toISOString()) {
			return "next_run_at_moved";
		}
		return null;
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

		// Query today's spend from turns table. Use a sargable half-open range on
		// created_at rather than wrapping the column in date() — the latter is
		// non-sargable and forces a full SCAN of the (ever-growing) turns table on
		// every budgeted tick. created_at is an ISO-8601 UTC string that sorts
		// lexicographically, so the bounds are computed in JS as ISO strings and
		// compare correctly against the stored `2026-07-18T...Z` format (never
		// SQLite's space-separated datetime()). Covered by idx_turns_created_at.
		const now = Date.now();
		const dayStart = `${new Date(now).toISOString().split("T")[0]}T00:00:00.000Z`;
		const dayEnd = `${new Date(now + 86_400_000).toISOString().split("T")[0]}T00:00:00.000Z`;
		const result = this.ctx.db
			.query("SELECT SUM(cost_usd) as total FROM turns WHERE created_at >= ? AND created_at < ?")
			.get(dayStart, dayEnd) as { total: number | null } | null;

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

		// Create agent loop and run asynchronously
		setImmediate(async () => {
			const executionStartedAt = performance.now();
			let schedulerOutcome = "hard_failed";
			let rootSpan: import("@opentelemetry/api").Span | undefined;
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
				let durableClaimsToAck: { id: string; token: string }[] = [];
				if (task.type === "heartbeat") {
					taskContent = buildHeartbeatContext(this.ctx.db, task.last_run_at, {
						siteId: this.ctx.siteId,
						logger: this.ctx.logger,
					});
				} else if (task.type === "consolidation") {
					taskContent = buildConsolidationContext(this.ctx.db);
				} else if (task.type === "event") {
					// Event tasks (e.g. webhook-triggered) carry their dynamic
					// payload in relay_inbox keyed by thread_id, written at
					// intake time by webhook-handler.ts. Without this branch
					// the agent would just see "Execute scheduled task." with no
					// clue what fired the trigger, and would have to reconstruct
					// the event by hand from external state (GitHub, etc.).
					// Helper reads BOTH stores (relay_inbox + durable_work intake),
					// merges oldest-first, dedupes twins, and CLAIMS the durable rows
					// it folds. It returns relay ids to markProcessed and durable
					// claims to acknowledge, both drained post-persist (below).
					const eventResult = buildEventWakeupContent(this.ctx.db, task, this.ctx.siteId);
					// `next_run_at` on an event task is the mid-run re-arm path. The
					// relay inbox is local-only, but the re-armed task row syncs; a peer
					// can therefore claim this firing without the envelope that caused
					// it. Do not persist a synthetic wakeup or invoke the loop without a
					// locally foldable envelope from EITHER store. Resetting returns the
					// listener to its normal pending state; the host holding the rows
					// will still consume them on its own re-arm.
					if (
						(task.run_count ?? 0) > 0 &&
						eventResult.processedIds.length === 0 &&
						eventResult.durableClaims.length === 0
					) {
						this.ctx.logger.info(
							"[scheduler] Skipping re-armed event task with no local inbox payload",
							{
								taskId: task.id,
								threadId: task.thread_id,
							},
						);
						resetEventTask(this.ctx.db, task, this.ctx.logger, "empty re-arm", this.ctx.siteId);
						this.runningTasks.delete(task.id);
						return;
					}
					taskContent = eventResult.content;
					inboxIdsToMarkProcessed = eventResult.processedIds;
					durableClaimsToAck = eventResult.durableClaims;
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
				// calls mid-session — observed to cause spin loops where the model
				// re-issues the acknowledgment call instead of acting on the payload.
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

				// Acknowledge (-> consumed) the durable_work intake rows we claimed
				// and folded, under the same post-persist gate as markProcessed. On a
				// persistence failure we NEVER reach here, so the rows stay
				// `processing` and boot recovery (resetProcessingDurableWork) returns
				// them to `pending` for a redundant re-fold — never a silent loss.
				// Token-fenced: only our own claim generation is retired.
				for (const claim of durableClaimsToAck) {
					acknowledgeDurableWork(this.ctx.db, claim.id, claim.token);
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
							if (
								validation.permanent &&
								task.type !== "heartbeat" &&
								task.type !== "consolidation"
							) {
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

				const modelId = resolveEffectiveModelHint(
					this.ctx.db,
					threadId,
					this.config.modelDefaultResolver?.() ?? "default",
					task.id,
				);
				const modelTier = this.config.modelTierResolver
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
				if (task.claimed_at) {
					recordSchedulerClaimDelay(Date.now() - new Date(task.claimed_at).getTime(), {
						type: task.type,
					});
				}

				const tracer = getTracer();
				rootSpan = tracer.startSpan("scheduler.execute-task", {
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
				} catch (err) {
					rootSpan.recordException(err instanceof Error ? err : new Error(String(err)));
					rootSpan.addEvent("bound.scheduler.outcome", {
						"scheduler.outcome": "hard_failed",
					});
					rootSpan.setStatus({
						code: SpanStatusCode.ERROR,
						message: err instanceof Error ? err.message : String(err),
					});
					throw err;
				} finally {
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
						rootSpan.addEvent("bound.scheduler.outcome", { "scheduler.outcome": "soft_failed" });
						rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: result.error });
						schedulerOutcome = "soft_failed";
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
							schedulerOutcome = "lease_lost";
							rootSpan.addEvent("bound.scheduler.outcome", {
								"scheduler.outcome": "lease_lost",
							});
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
						rootSpan.addEvent("bound.scheduler.outcome", { "scheduler.outcome": "completed" });
						rootSpan.setStatus({ code: SpanStatusCode.OK });
						schedulerOutcome = "completed";
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
							schedulerOutcome = "lease_lost";
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
				} else {
					schedulerOutcome = "lease_lost";
					rootSpan.addEvent("bound.scheduler.outcome", {
						"scheduler.outcome": "lease_lost",
					});
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
				} else {
					schedulerOutcome = "lease_lost";
				}
			} finally {
				if (rootSpan) rootSpan.end();
				const metricAttributes = { outcome: schedulerOutcome, type: task.type };
				recordAgentOperationalMetric("scheduler", metricAttributes);
				recordSchedulerExecutionDuration(performance.now() - executionStartedAt, metricAttributes);
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
				if (!shouldDispatchHere(this.ctx.db, task, this.ctx.hostName, this.ctx.siteId)) {
					continue;
				}
				// Capability-gated claim (chain BEGINNING fix): never claim an
				// inference-bearing task this host cannot resolve a model for. The
				// injected validator closes over the LOCAL ModelRouter, so this is a
				// per-host self-check — a backend-less hub whose empty model_hint
				// resolves to an unservable default declines the claim and leaves the
				// task pending for a capable host (or the durable-intake drain) rather
				// than claiming it and burning the failure budget. Validate the
				// EFFECTIVE model: an empty/"default" hint resolves to the host's
				// default inside the validator, so it is checked here too (unlike the
				// run-time validator at phase3Run, which short-circuits on a falsy
				// hint and so never caught this case). Event firings have no HRW
				// rendezvous, so a self-decline cannot deadlock a sole capable host.
				if (this.config.modelValidator) {
					const validation = this.config.modelValidator(task.model_hint ?? "");
					if (!validation.ok) {
						this.ctx.logger.info(
							"[scheduler] Declining event-task claim: model unresolvable on this host",
							{
								taskId: task.id,
								triggerSpec: task.trigger_spec,
								modelHint: task.model_hint ?? "",
								error: validation.error,
							},
						);
						continue;
					}
				}
				{
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
