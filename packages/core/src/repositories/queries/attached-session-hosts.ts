import type { Database } from "bun:sqlite";

/**
 * Cross-table read joining `client_sessions` to `hosts` to label the holding
 * host of each live session on a thread. Used by the per-thread status surface
 * in `packages/web/src/server/routes/threads.ts`.
 *
 * See ../index.ts for conventions. Reads only.
 */

/** One holding-host label projection. */
export interface AttachedSessionHostRow {
	/** host_name when known, else the raw site_id. */
	label: string;
}

/**
 * Distinct holding-host labels for live client sessions on a thread, ordered
 * `label ASC`. Each label is `COALESCE(h.host_name, cs.site_id)`; deleted hosts
 * and deleted sessions are excluded, and rows are grouped by `(site_id, label)`
 * so one label appears per distinct holding host.
 */
export function getAttachedSessionHosts(db: Database, threadId: string): AttachedSessionHostRow[] {
	return db
		.query(`
			SELECT label
			FROM (
				SELECT COALESCE(h.host_name, cs.site_id) as label
				FROM client_sessions cs
				LEFT JOIN hosts h ON h.site_id = cs.site_id AND h.deleted = 0
				WHERE cs.thread_id = ? AND cs.deleted = 0
				GROUP BY cs.site_id, label
				ORDER BY label ASC
			)
		`)
		.all(threadId) as AttachedSessionHostRow[];
}
