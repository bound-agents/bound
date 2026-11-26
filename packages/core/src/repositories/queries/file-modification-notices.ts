import type { Database } from "bun:sqlite";
import { getAll, queryBuilder } from "../../query-builder";

/**
 * Cross-table read joining the `_internal.file_thread.*` `semantic_memory`
 * entries to the modifying `threads` row and that thread's origin `hosts` row.
 * Backs the Live State file-modification surface (R-VC13/R-VC28).
 */

/**
 * One file-modification notice. The `_internal.file_thread.<path>` entry's
 * VALUE is the modifying thread id, resolved here to the thread title and the
 * thread's origin host.
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
 * Semantics:
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
	return getAll(
		db,
		queryBuilder
			.selectFrom("semantic_memory as sm")
			.leftJoin("threads as t", "t.id", "sm.value")
			.leftJoin("hosts as h", (join) =>
				join.onRef("h.site_id", "=", "t.host_origin").on("h.deleted", "=", 0),
			)
			.select([
				"sm.key as key",
				"sm.value as thread_id",
				"t.title as thread_title",
				"t.host_origin as host_origin",
				"h.host_name as host_name",
			])
			.where("sm.key", "like", "_internal.file_thread.%")
			.where("sm.deleted", "=", 0)
			.where("sm.value", "!=", args.currentThreadId)
			.orderBy(
				(eb) =>
					eb
						.case()
						.when("t.host_origin", "in", [args.localSite, args.localHost])
						.then(0)
						.else(1)
						.end(),
				"asc",
			)
			.orderBy("sm.modified_at", "desc")
			.limit(args.limit),
	);
}
