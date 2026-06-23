import type { Database } from "bun:sqlite";

/**
 * Cross-table read joining the `_internal.file_thread.*` `semantic_memory`
 * entries to the modifying `threads` row and that thread's origin `hosts` row.
 * Powers the Live State file-modification surface (R-VC13/R-VC28) in
 * `packages/agent/src/summary-extraction.ts`.
 *
 * See ../index.ts for conventions. Reads only.
 */

/**
 * One file-modification notice. The `_internal.file_thread.<path>` entry's
 * VALUE is the modifying thread id, resolved here to the thread title and the
 * thread's origin host. Column names mirror exactly what
 * `loadFileModificationsForLiveState` destructures.
 */
export interface FileModificationNoticeRow {
	/** The full `_internal.file_thread.<path>` key. */
	key: string;
	/** semantic_memory.value — the modifying thread id. */
	thread_id: string;
	thread_title: string | null;
	/** threads.host_origin (a site_id, host_name, or "localhost:port"). */
	host_origin: string | null;
	/** hosts.host_name resolved from host_origin via the site_id JOIN. */
	host_name: string | null;
}

/**
 * File-modification notices, newest first, with local-host edits sorted ahead
 * of remote ones so a remote modification doesn't crowd out a local one under
 * the cap.
 *
 * Semantics preserved exactly:
 *  - Source is `_internal.file_thread.%` keys (live only) whose value is not the
 *    current thread.
 *  - LEFT JOIN threads on `t.id = sm.value`, LEFT JOIN hosts on
 *    `h.site_id = t.host_origin AND h.deleted = 0`.
 *  - Local-first ordering: `CASE WHEN t.host_origin IN (localSite, localHost)
 *    THEN 0 ELSE 1 END ASC`, then `sm.modified_at DESC`.
 *  - Capped at `limit`.
 *
 * Bind `localSite` / `localHost` as `""` when absent (a real host_origin never
 * equals "") so the SQL CASE and any JS isLocal check agree.
 */
export function listFileModificationNotices(
	db: Database,
	args: {
		currentThreadId: string;
		localSite: string;
		localHost: string;
		limit: number;
	},
): FileModificationNoticeRow[] {
	return db
		.query(
			`SELECT sm.key AS key, sm.value AS thread_id, t.title AS thread_title,
			        t.host_origin AS host_origin, h.host_name AS host_name
			 FROM semantic_memory sm
			 LEFT JOIN threads t ON t.id = sm.value
			 LEFT JOIN hosts h ON h.site_id = t.host_origin AND h.deleted = 0
			 WHERE sm.key LIKE '_internal.file_thread.%' AND sm.deleted = 0
			   AND sm.value != ?
			 ORDER BY (CASE WHEN t.host_origin IN (?, ?) THEN 0 ELSE 1 END) ASC,
			          sm.modified_at DESC
			 LIMIT ?`,
		)
		.all(
			args.currentThreadId,
			args.localSite,
			args.localHost,
			args.limit,
		) as FileModificationNoticeRow[];
}
