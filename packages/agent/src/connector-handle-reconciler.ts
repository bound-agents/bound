import type { Database } from "bun:sqlite";
import { findDarkConnectorHandles } from "@bound/core";
import type { DarkConnectorHandle } from "@bound/core";
import { createAdvisory, hasAdvisoryWithTitle } from "./advisories";

/** Logger surface this module needs — the relay-processor passes its own. */
interface ReconcilerLogger {
	info: (msg: string, meta?: Record<string, unknown>) => void;
	warn: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Default settle window. A connector handle whose backing task is dark AND
 * which has not been touched for this long is a genuine orphan, not a sync-replay
 * race (a handle synced ahead of its task row, invariant #20). 15 minutes clears
 * many scheduler ticks and sync cycles.
 */
export const DEFAULT_CONNECTOR_HANDLE_STALE_AFTER_MS = 15 * 60 * 1000;

export interface ReconcileDarkConnectorHandlesOptions {
	/** How long a handle must be settled before a dark task counts as an orphan. */
	staleAfterMs?: number;
	/** Injectable clock for deterministic tests. */
	now?: Date;
	/** Optional logger for visibility (the relay-processor passes its own). */
	logger?: ReconcilerLogger;
}

export interface ReconcileDarkConnectorHandlesResult {
	/** Dark connector handles that got a (deduplicated) advisory this sweep. */
	advisoriesRaised: number;
}

/**
 * Catch-of-last-resort for connector-handle subscriptions (the connector-side
 * analogue of `reconcileStaleWebhookIntake`).
 *
 * A platform connector subscription is a `connector_handles` row bound to a
 * `type: "event"` task (`connector_handles.task_id`). When that task goes dark —
 * cancelled, soft-deleted, or lost entirely — but the handle stays live, the
 * subscription silently stops firing: the connector still emits the event, but
 * no task consumes it. This is exactly how "file for later" (issue #196) broke —
 * the `interaction.received` handler task was cancelled during a May inference
 * outage, five weeks before the `findTaskInfraBinding` FK guard existed to
 * prevent it, and nothing noticed for six weeks.
 *
 * `findTaskInfraBinding` now PREVENTS new occurrences by refusing to cancel a
 * task a live handle points at. This sweep is the paired far-end DETECTOR for the
 * states that predate the guard or slip past it. Unlike the webhook reconciler
 * there is NO dead-letter branch: connector push events buffer in-memory on the
 * connector host (they are not written durably to `relay_inbox`), so there is no
 * backlog to drain — only a dark subscription to surface.
 *
 * Reads synced tables (`connector_handles` ⋈ `tasks`), so it can run on any host;
 * the advisory is deduped by title across ALL non-deleted statuses (same fix as
 * the webhook reconciler's apply-then-reraise churn), which also converges the
 * redundant raises when more than one host runs the sweep.
 */
export function reconcileDarkConnectorHandles(
	db: Database,
	siteId: string,
	options: ReconcileDarkConnectorHandlesOptions = {},
): ReconcileDarkConnectorHandlesResult {
	const now = options.now ?? new Date();
	const staleAfterMs = options.staleAfterMs ?? DEFAULT_CONNECTOR_HANDLE_STALE_AFTER_MS;
	const staleBeforeIso = new Date(now.getTime() - staleAfterMs).toISOString();
	const logger = options.logger;

	const dark = findDarkConnectorHandles(db, staleBeforeIso);
	if (dark.length === 0) {
		return { advisoriesRaised: 0 };
	}

	let advisoriesRaised = 0;

	for (const handle of dark) {
		const title = titleFor(handle);
		if (hasAdvisoryWithTitle(db, title)) continue;

		createAdvisory(
			db,
			{
				type: "general",
				status: "proposed",
				title,
				detail: detailFor(handle),
				action: actionFor(handle),
				impact: `Inbound '${handle.event_name}' events on connector '${handle.server_name}' go unanswered until the subscription is rebound to a live task.`,
				evidence: JSON.stringify({
					handle_id: handle.handle_id,
					server_name: handle.server_name,
					event_name: handle.event_name,
					task_id: handle.task_id,
					reason: handle.reason,
					thread_id: handle.thread_id,
					stale_after_ms: staleAfterMs,
				}),
			},
			siteId,
		);
		advisoriesRaised++;
		logger?.warn("[relay] Raised advisory for dark connector handle", {
			handleId: handle.handle_id,
			server: handle.server_name,
			event: handle.event_name,
			reason: handle.reason,
		});
	}

	return { advisoriesRaised };
}

function titleFor(handle: DarkConnectorHandle): string {
	return `Connector subscription dark: ${handle.server_name}:${handle.event_name} handle ${handle.handle_id}`;
}

function detailFor(handle: DarkConnectorHandle): string {
	const reasonText = {
		cancelled: `its backing event task (${handle.task_id}) was cancelled`,
		deleted: `its backing event task (${handle.task_id}) was soft-deleted`,
		missing: `its backing event task (${handle.task_id}) no longer exists`,
	}[handle.reason];
	return `The live connector handle ${handle.handle_id} (${handle.server_name}:${handle.event_name}) is dark: ${reasonText}. The connector still emits the event but no task consumes it, so the subscription silently stops firing. The handle is not soft-deleted, so this is an orphaned binding rather than a sanctioned teardown.`;
}

function actionFor(handle: DarkConnectorHandle): string {
	return `Rebind the '${handle.event_name}' subscription on connector '${handle.server_name}': detach the orphaned handle (${handle.handle_id}) and re-attach so a fresh live event task backs it. (If the subscription should be retired, detaching alone clears this advisory.)`;
}
