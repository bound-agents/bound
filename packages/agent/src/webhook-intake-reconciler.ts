import type { Database } from "bun:sqlite";
import {
	deadLetterPendingDurableWork,
	findStalePendingIntakeDurableWork,
	listPendingIntakeDurableWork,
} from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { PASSIVE_INTAKE_REGISTRY } from "./intake-kind-registry";
import { RECONCILE_STALE_AFTER_MS, type ReconcilerLogger } from "./stale-reconcile";

export interface ReconcileStaleWebhookIntakeOptions {
	/** How long a pending intake row may sit before it counts as a dark handler. */
	staleAfterMs?: number;
	/** Injectable clock for deterministic tests. */
	now?: Date;
	logger?: ReconcilerLogger;
	/** Local event bus: intake rows belong to this host, not the platform leader. */
	eventBus: TypedEventEmitter;
}

export interface ReconcileStaleWebhookIntakeResult {
	/** Live bindings nudged back through their durable intake backlog. */
	redelivered: number;
	/** Orphaned intake rows dead-lettered because no live binding can ever drain them. */
	deadLettered: number;
}

/**
 * Catch-of-last-resort for the passive intake pipeline (webhook, RSS, and
 * connector intake).
 *
 * Intake events are written durably to local `durable_work` rows (7-day TTL)
 * and consumed only once a bound event handler runs and folds them into its
 * wakeup (`buildEventWakeupContent` claims, the scheduler acknowledges). A lost
 * local `connector:event` wakeup or a dark handler leaves the rows pending until
 * they expire.
 *
 * Runs against the local spool (invariant #3: durable work is local-only), so it
 * belongs on the host that accepted the intake.
 *
 * Two outcomes per stale `ref_id` (the handler thread), decided by whether a live
 * binding still owns the thread:
 *
 *  - LIVE: re-emit one `connector:event` for the binding so the scheduler drains
 *    the backlog through its normal CAS-gated wakeup.
 *  - ORPHANED (no live binding): the intake can never drain, because draining
 *    requires a task whose thread_id matches the ref_id. Dead-letter every
 *    pending row for that ref_id into workspool-redrivable state.
 */
export function reconcileStaleWebhookIntake(
	db: Database,
	options: ReconcileStaleWebhookIntakeOptions,
): ReconcileStaleWebhookIntakeResult {
	const now = options.now ?? new Date();
	const staleAfterMs = options.staleAfterMs ?? RECONCILE_STALE_AFTER_MS;
	const staleBeforeIso = new Date(now.getTime() - staleAfterMs).toISOString();
	const logger = options.logger;

	let redelivered = 0;
	let deadLettered = 0;

	// Sweep each passive intake kind that binds a thread to an external event
	// source. Webhooks and RSS feeds share the binding shape (row + thread +
	// event task) and the drain contract (ref_id = binding.thread_id), so the
	// live/orphaned classification is identical; only the binding lookup,
	// trigger construction, and wording differ. The connector handle reconciler
	// separately detects cancelled/deleted backing tasks; this sweep repairs
	// only lost local event-bus wakeups for live bindings.
	for (const sweep of PASSIVE_INTAKE_REGISTRY) {
		const staleGroups = new Map<string, { count: number; oldestReceivedAt: string }>();
		for (const group of findStalePendingIntakeDurableWork(db, sweep.kind, staleBeforeIso)) {
			const existing = staleGroups.get(group.ref_id);
			staleGroups.set(group.ref_id, {
				count: (existing?.count ?? 0) + group.count,
				oldestReceivedAt:
					existing && existing.oldestReceivedAt < group.oldest_received_at
						? existing.oldestReceivedAt
						: group.oldest_received_at,
			});
		}

		for (const [refId, group] of staleGroups) {
			const liveBinding = sweep.findBinding(db, refId);

			if (!liveBinding) {
				// An orphan cannot drain: retain durable rows as workspool-redrivable
				// dead letters.
				const durableOrphans = listPendingIntakeDurableWork(db, sweep.kind, refId);
				for (const row of durableOrphans) {
					deadLetterPendingDurableWork(
						db,
						row.id,
						`orphaned ${sweep.noun} intake binding`,
						now.toISOString(),
					);
				}
				if (durableOrphans.length > 0) {
					deadLettered += durableOrphans.length;
					logger?.warn(`[relay] Dead-lettered orphaned ${sweep.noun} intake (no live binding)`, {
						refId,
						rows: durableOrphans.length,
					});
				}
				continue;
			}

			// One nudge per binding; `batch_size` is the summed stale backlog.
			options.eventBus.emit("connector:event", {
				trigger_key: sweep.triggerKey(liveBinding),
				handle_id: liveBinding.id,
				task_id: liveBinding.task_id,
				batch_size: group.count,
			});
			redelivered++;
		}
	}

	return { redelivered, deadLettered };
}
