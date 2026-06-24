import type { Database } from "bun:sqlite";
import { findStaleUnprocessedIntake } from "@bound/core";
import { createAdvisory, getPendingAdvisories } from "./advisories";

/** Relay kind the webhook intake pipeline writes (see web/src/server/webhook-handler.ts). */
const WEBHOOK_INTAKE_KIND = "webhook_intake";

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
}

export interface ReconcileStaleWebhookIntakeResult {
	advisoriesRaised: number;
}

/**
 * Catch-of-last-resort for the webhook intake pipeline.
 *
 * Webhook events are written durably to `relay_inbox` (kind `webhook_intake`,
 * 7-day TTL) and only marked processed once a bound event handler actually runs
 * and folds them into its wakeup (`buildEventWakeupContent` → `markProcessed`).
 * If the handler is dark — cancelled, evicted-to-failed, declined by an incapable
 * host, or lost to a deploy gap — the rows sit unprocessed and silently expire.
 * The original incident (webhook:bound-v2, task d2ecf42d) went dark ~13h this way.
 *
 * This sweep is the far-end block protection paired with capability-gated claim:
 * the gate lowers the *rate* of handler death; this lowers the *blast radius* of
 * each death, turning a silent multi-hour outage into a deduplicated advisory the
 * operator (or I) can act on by reviving/rebinding the handler — at which point
 * the durable backlog drains on its own.
 *
 * Runs against the LOCAL relay_inbox (invariant #3: relay tables are local-only),
 * so it belongs on the host that received the POST. Idempotent: one proposed
 * advisory per dark `ref_id` (the handler thread), deduplicated against existing
 * pending advisories so repeated sweeps and additional queued events for the same
 * dark handler don't re-raise.
 */
export function reconcileStaleWebhookIntake(
	db: Database,
	siteId: string,
	options: ReconcileStaleWebhookIntakeOptions = {},
): ReconcileStaleWebhookIntakeResult {
	const now = options.now ?? new Date();
	const staleAfterMs = options.staleAfterMs ?? DEFAULT_WEBHOOK_INTAKE_STALE_AFTER_MS;
	const staleBeforeIso = new Date(now.getTime() - staleAfterMs).toISOString();

	const groups = findStaleUnprocessedIntake(db, WEBHOOK_INTAKE_KIND, staleBeforeIso);
	if (groups.length === 0) {
		return { advisoriesRaised: 0 };
	}

	// Dedup against advisories already awaiting operator action. Keyed on the
	// dark handler's ref_id, which is stable across sweeps and across additional
	// queued events for the same handler.
	const openTitles = new Set(getPendingAdvisories(db).map((a) => a.title));

	let advisoriesRaised = 0;
	for (const group of groups) {
		const title = titleFor(group.ref_id);
		if (openTitles.has(title)) continue;

		const ageMs = now.getTime() - new Date(group.oldest_received_at).getTime();
		const ageMinutes = Math.floor(ageMs / 60000);

		createAdvisory(
			db,
			{
				type: "general",
				status: "proposed",
				title,
				detail: `${group.count} webhook event(s) for handler thread ${group.ref_id} have sat unprocessed in relay_inbox for ~${ageMinutes}m (oldest received ${group.oldest_received_at}). A live event handler drains its intake the moment it runs, so the bound handler is dark — cancelled, evicted-to-failed, declined by an incapable host, or lost to a deploy gap. The events are durable (7-day TTL) and a handler rebound to this thread drains the backlog.`,
				action: `Revive or rebind the event handler for thread ${group.ref_id} (check the webhooks table for the registered name and its task_id). Once a pending handler exists, the queued events drain on the next wakeup; no events are lost.`,
				impact: "Inbound webhook events for this handler go unanswered until the TTL expires.",
				evidence: JSON.stringify({
					ref_id: group.ref_id,
					kind: group.kind,
					count: group.count,
					oldest_received_at: group.oldest_received_at,
					stale_after_ms: staleAfterMs,
				}),
			},
			siteId,
		);
		openTitles.add(title);
		advisoriesRaised++;
	}

	return { advisoriesRaised };
}

function titleFor(refId: string): string {
	return `Webhook intake not draining: handler thread ${refId} is dark`;
}
