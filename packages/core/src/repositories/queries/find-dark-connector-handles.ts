import type { Database } from "bun:sqlite";

/**
 * Why a connector handle counts as "dark".
 *
 *  - `cancelled` — the backing event task was cancelled. Terminal: the scheduler
 *    never reschedules a cancelled task, so the subscription can never fire again.
 *  - `deleted`   — the backing task row was soft-deleted out from under the handle.
 *  - `missing`   — no task row with that id exists at all.
 *
 * Note the states deliberately NOT here: a `failed` cron/event task is
 * RECOVERABLE, not dark — the scheduler's healer (`listStuckRecoverableTasks`)
 * reschedules `type IN ('cron','event') AND status = 'failed'`, so flagging it
 * would raise a churn advisory for a task that self-heals on the next tick.
 */
export type DarkConnectorHandleReason = "cancelled" | "deleted" | "missing";

export interface DarkConnectorHandle {
	handle_id: string;
	server_name: string;
	event_name: string;
	task_id: string;
	reason: DarkConnectorHandleReason;
	/** The backing task's thread, when a task row still exists; null when missing. */
	thread_id: string | null;
}

/**
 * Finds live (`deleted = 0`) connector-handle subscriptions whose backing event
 * task is dark — cancelled, soft-deleted, or missing entirely — and which have
 * been settled long enough (`modified_at < staleBeforeIso`) that a sync-replay
 * race is not a plausible explanation.
 *
 * This is the connector-side analogue of the webhook intake reconciler's
 * RECOVERABLE detection. The application-level FK guard `findTaskInfraBinding`
 * already PREVENTS cancelling a task while a live handle points at it, so new
 * live-handle/dead-task pairs should not arise through the sanctioned paths.
 * This query is the catch-of-last-resort for the states that predate the guard
 * or slip past it (legacy orphans, an out-of-band cancellation, a task deleted
 * without first soft-deleting its handle).
 *
 * The `modified_at < staleBeforeIso` clause is load-bearing for the `missing`
 * case: synced replay inserts rows out of order (invariant #20), so a handle can
 * legitimately arrive on a spoke before its task row does. A freshly-modified
 * handle whose task is not yet visible is a transient, not an orphan; the window
 * lets it settle before we treat "no task row" as dark.
 *
 * Reads two synced tables (`connector_handles` ⋈ `tasks`), so it lives in the
 * repository query layer per the read-centralization gate.
 */
export function findDarkConnectorHandles(
	db: Database,
	staleBeforeIso: string,
): DarkConnectorHandle[] {
	const rows = db
		.query(
			`SELECT
			   h.id          AS handle_id,
			   h.server_name AS server_name,
			   h.event_name  AS event_name,
			   h.task_id     AS task_id,
			   t.id          AS task_found,
			   t.status      AS task_status,
			   t.deleted     AS task_deleted,
			   t.thread_id   AS thread_id
			 FROM connector_handles h
			 LEFT JOIN tasks t ON t.id = h.task_id
			 WHERE h.deleted = 0
			   AND h.task_id IS NOT NULL
			   AND h.modified_at < ?
			   AND (
			     t.id IS NULL
			     OR t.deleted = 1
			     OR t.status = 'cancelled'
			   )`,
		)
		.all(staleBeforeIso) as Array<{
		handle_id: string;
		server_name: string;
		event_name: string;
		task_id: string;
		task_found: string | null;
		task_status: string | null;
		task_deleted: number | null;
		thread_id: string | null;
	}>;

	return rows.map((r) => {
		let reason: DarkConnectorHandleReason;
		if (r.task_found === null) {
			reason = "missing";
		} else if (r.task_deleted === 1) {
			reason = "deleted";
		} else {
			reason = "cancelled";
		}
		return {
			handle_id: r.handle_id,
			server_name: r.server_name,
			event_name: r.event_name,
			task_id: r.task_id,
			reason,
			thread_id: r.thread_id,
		};
	});
}
