import type { Database } from "bun:sqlite";
import {
	findActiveConnectorHandleByThreadId,
	findActiveRssFeedByThreadId,
	findActiveWebhookByThreadId,
	findStaleUnprocessedIntake,
	markProcessed,
	readUnprocessedInboxByRefId,
} from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { createAdvisory, hasAdvisoryWithTitle } from "./advisories";

/** Logger surface this module needs — the relay-processor passes its own. */
interface ReconcilerLogger {
	info: (msg: string, meta?: Record<string, unknown>) => void;
	warn: (msg: string, meta?: Record<string, unknown>) => void;
}

/** Relay kind the webhook intake pipeline writes (see web/src/server/webhook-handler.ts). */
const WEBHOOK_INTAKE_KIND = "webhook_intake";

/** Relay kind the leader-gated RSS poller writes (see platforms/src/rss-poller.ts). */
const RSS_INTAKE_KIND = "rss_intake";

/**
 * Default staleness window. A healthy event handler drains its intake the moment
 * it runs, so anything still unprocessed after 15 minutes has missed several
 * scheduler ticks and event firings — long enough to be a dark binding rather
 * than a row mid-flight.
 */
export const DEFAULT_WEBHOOK_INTAKE_STALE_AFTER_MS = 15 * 60 * 1000;

export interface ReconcileStaleWebhookIntakeOptions {
	/** How long an unprocessed intake row may sit before it counts as a dark handler. */
	staleAfterMs?: number;
	/** Injectable clock for deterministic tests. */
	now?: Date;
	/** Optional logger for dead-letter visibility (the relay-processor passes its own). */
	logger?: ReconcilerLogger;
	/** Local event bus: intake rows belong to this host, not the platform leader. */
	eventBus?: TypedEventEmitter;
}

export interface ReconcileStaleWebhookIntakeResult {
	/** Recoverable dark handlers that got a (deduplicated) advisory this sweep. */
	advisoriesRaised: number;
	/** Live bindings nudged back through their durable inbox backlog. */
	redelivered: number;
	/** Orphaned intake rows marked processed because no live binding can ever drain them. */
	deadLettered: number;
}

/**
 * Catch-of-last-resort for the webhook intake pipeline.
 *
 * Webhook events are written durably to `relay_inbox` (kind `webhook_intake`,
 * 7-day TTL) and only marked processed once a bound event handler actually runs
 * and folds them into its wakeup (`buildEventWakeupContent` → `markProcessed`).
 * If the handler is dark — cancelled, evicted-to-failed, declined by an incapable
 * host, or lost to a deploy gap — the rows sit unprocessed and silently expire.
 * (Observed in production: a handler went dark for ~13h before anyone noticed,
 * with events queued the entire time.)
 *
 * This sweep is the far-end block protection paired with capability-gated claim:
 * the gate lowers the *rate* of handler death; this lowers the *blast radius* of
 * each death, turning a silent multi-hour outage into a deduplicated advisory the
 * operator can act on by reviving/rebinding the handler — at which point the
 * durable backlog drains on its own.
 *
 * Runs against the LOCAL relay_inbox (invariant #3: relay tables are local-only),
 * so it belongs on the host that received the POST.
 *
 * Two outcomes per stale `ref_id` (the handler thread), decided by whether a LIVE
 * webhook binding still owns the thread (`findActiveWebhookByThreadId`):
 *
 *  - RECOVERABLE (live binding, dark handler task): raise ONE advisory, dedup'd
 *    by title across ALL non-deleted advisory statuses. The earlier version
 *    deduped only against `getPendingAdvisories` (proposed + due-deferred), so the
 *    moment an operator *applied* the advisory it dropped out of that set and the
 *    next sweep re-raised it — an apply-then-reraise churn loop. Reviving the
 *    handler drains the durable backlog on its own.
 *
 *  - ORPHANED (no live binding — webhook deregistered or never existed): the
 *    intake can NEVER drain, because draining requires a task whose thread_id
 *    matches the ref_id to run `buildEventWakeupContent`. Advising "revive the
 *    handler" is futile and is exactly what churned. Dead-letter it for real:
 *    mark every unprocessed `webhook_intake` row for that ref_id processed, which
 *    drains the queue and ends the churn. No advisory — there is nothing to act on.
 */
export function reconcileStaleWebhookIntake(
	db: Database,
	siteId: string,
	options: ReconcileStaleWebhookIntakeOptions = {},
): ReconcileStaleWebhookIntakeResult {
	const now = options.now ?? new Date();
	const staleAfterMs = options.staleAfterMs ?? DEFAULT_WEBHOOK_INTAKE_STALE_AFTER_MS;
	const staleBeforeIso = new Date(now.getTime() - staleAfterMs).toISOString();
	const logger = options.logger;

	let advisoriesRaised = 0;
	let redelivered = 0;
	let deadLettered = 0;

	// Sweep each passive intake kind that binds a thread to an external event
	// source. Webhooks and RSS feeds share the binding shape (row + thread +
	// event task) and the drain contract (ref_id = binding.thread_id), so the
	// recoverable/orphaned classification is identical — only the binding
	// lookup, trigger construction, and operator-facing wording differ.
	// `connector_intake` is also local durable intake. The separate connector
	// handle reconciler still detects cancelled/deleted backing tasks; this
	// sweep repairs only lost local event-bus wakeups for live bindings.
	for (const sweep of INTAKE_SWEEPS) {
		const groups = findStaleUnprocessedIntake(db, sweep.kind, staleBeforeIso);

		for (const group of groups) {
			const liveBinding = sweep.findBinding(db, group.ref_id);

			if (!liveBinding) {
				// Orphaned: no handler can ever drain this. Dead-letter every unprocessed
				// intake row for the ref_id (the whole binding is gone, not just the stale
				// rows), which removes it from future sweeps and stops the advisory churn.
				const orphaned = readUnprocessedInboxByRefId(db, group.ref_id, sweep.kind);
				if (orphaned.length > 0) {
					markProcessed(
						db,
						orphaned.map((row) => row.id),
					);
					deadLettered += orphaned.length;
					logger?.warn(`[relay] Dead-lettered orphaned ${sweep.noun} intake (no live binding)`, {
						refId: group.ref_id,
						rows: orphaned.length,
					});
				}
				continue;
			}

			// Recoverable: durable intake is the source of truth, not the original
			// in-memory wakeup. Re-emit locally; scheduler claims and inbox processing
			// make repeated nudges harmless.
			options.eventBus?.emit("connector:event", {
				trigger_key: sweep.triggerKey(liveBinding),
				handle_id: liveBinding.id,
				task_id: liveBinding.task_id,
				batch_size: group.count,
			});
			if (options.eventBus) {
				redelivered++;
				continue;
			}

			// No event bus is only possible in a diagnostic caller; preserve the
			// former advisory instead of silently losing visibility.
			const title = sweep.titleFor(group.ref_id);
			if (hasAdvisoryWithTitle(db, title)) continue;

			const ageMs = now.getTime() - new Date(group.oldest_received_at).getTime();
			const ageMinutes = Math.floor(ageMs / 60000);

			createAdvisory(
				db,
				{
					type: "general",
					status: "proposed",
					title,
					detail: `${group.count} ${sweep.noun} event(s) for handler thread ${group.ref_id} (${sweep.noun} '${liveBinding.name}') have sat unprocessed in relay_inbox for ~${ageMinutes}m (oldest received ${group.oldest_received_at}). The ${sweep.noun} binding is live but its event handler is dark — cancelled, evicted-to-failed, or declined by an incapable host. The events are durable (7-day TTL) and reviving the handler drains the backlog.`,
					action: `Revive the event handler for ${sweep.noun} '${liveBinding.name}' (thread ${group.ref_id}) — recreate its pending event task. Once a pending handler exists, the queued events drain on the next wakeup; no events are lost. (If the ${sweep.noun} itself should be retired, deregister it — that dead-letters the intake instead.)`,
					impact: `Inbound ${sweep.noun} events for this live ${sweep.noun} go unanswered until the handler is revived.`,
					evidence: JSON.stringify({
						ref_id: group.ref_id,
						[sweep.noun]: liveBinding.name,
						kind: group.kind,
						count: group.count,
						oldest_received_at: group.oldest_received_at,
						stale_after_ms: staleAfterMs,
					}),
				},
				siteId,
			);
			advisoriesRaised++;
		}
	}

	return { advisoriesRaised, redelivered, deadLettered };
}

/**
 * One sweep config per passive intake kind owned by an external-source
 * binding. The webhook `titleFor` string is byte-identical to the pre-RSS
 * version — it is the advisory dedup key across all non-deleted statuses,
 * so changing it would re-raise an advisory for every binding that already
 * has an applied/dismissed one.
 */
interface IntakeSweep {
	kind: "webhook_intake" | "rss_intake" | "connector_intake";
	/** Operator-facing noun used in advisory prose ("webhook" / "RSS feed" / "connector"). */
	noun: string;
	findBinding: (
		db: Database,
		threadId: string,
	) => { id: string; name: string; task_id: string } | null;
	triggerKey: (binding: { id: string; name: string; task_id: string }) => string;
	titleFor: (refId: string) => string;
}

const INTAKE_SWEEPS: IntakeSweep[] = [
	{
		kind: WEBHOOK_INTAKE_KIND,
		noun: "webhook",
		findBinding: findActiveWebhookByThreadId,
		triggerKey: (binding) => `webhook:${binding.name}`,
		titleFor: (refId) => `Webhook intake not draining: handler thread ${refId} is dark`,
	},
	{
		kind: RSS_INTAKE_KIND,
		noun: "RSS feed",
		findBinding: findActiveRssFeedByThreadId,
		triggerKey: (binding) => `rss:${binding.name}`,
		titleFor: (refId) => `RSS intake not draining: handler thread ${refId} is dark`,
	},
	{
		kind: "connector_intake",
		noun: "connector",
		findBinding: findActiveConnectorHandleByThreadId,
		triggerKey: (binding) => `connector:event:${binding.id}`,
		titleFor: (refId) => `Connector intake not draining: handler thread ${refId} is dark`,
	},
];
