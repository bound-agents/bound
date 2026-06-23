import type { Database } from "bun:sqlite";

/**
 * Cross-table read joining `tasks` to `hosts` to resolve the host display name
 * of the host that last claimed each task. Powers the Live State task digest in
 * `packages/agent/src/summary-extraction.ts`.
 *
 * See ../index.ts for conventions. Reads only.
 */

/**
 * A recent task run with its claiming host resolved. Column names mirror
 * exactly what the task-digest builder destructures.
 */
export interface RecentTaskRunWithHostRow {
	id: string;
	type: string;
	trigger_spec: string;
	last_run_at: string;
	run_count: number;
	consecutive_failures: number;
	claimed_by: string | null;
	/** hosts.host_name for the claiming host (null when unresolved / unclaimed). */
	host_name: string | null;
}

/**
 * Most-recently-run live tasks (with a non-null `last_run_at` strictly after
 * `baseline`), LEFT JOINed to the claiming host for its display name. Ordered
 * `t.last_run_at DESC`, capped at `limit`. Callers typically pass `maxTasks + 1`
 * to detect overflow.
 */
export function listRecentTaskRunsWithHost(
	db: Database,
	baseline: string,
	limit: number,
): RecentTaskRunWithHostRow[] {
	return db
		.prepare(
			`SELECT t.id, t.type, t.trigger_spec, t.last_run_at, t.run_count, t.consecutive_failures, t.claimed_by,
			        h.host_name
			 FROM   tasks t
			 LEFT JOIN hosts h ON t.claimed_by = h.site_id AND h.deleted = 0
			 WHERE  t.last_run_at > ?
			   AND  t.last_run_at IS NOT NULL
			   AND  t.deleted = 0
			 ORDER  BY t.last_run_at DESC
			 LIMIT  ?`,
		)
		.all(baseline, limit) as RecentTaskRunWithHostRow[];
}
