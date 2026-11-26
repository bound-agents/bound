import type { Database } from "bun:sqlite";
import type { NotNull } from "kysely";
import { getAll, queryBuilder } from "../../query-builder";

/**
 * Cross-table read joining `tasks` to `hosts` to resolve the host display name
 * of the host that last claimed each task, for the Live State task digest.
 */

/** A recent task run with its claiming host resolved. */
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
	return getAll(
		db,
		queryBuilder
			.selectFrom("tasks as t")
			.leftJoin("hosts as h", (join) =>
				join.onRef("t.claimed_by", "=", "h.site_id").on("h.deleted", "=", 0),
			)
			.select([
				"t.id",
				"t.type",
				"t.trigger_spec",
				"t.last_run_at",
				"t.run_count",
				"t.consecutive_failures",
				"t.claimed_by",
				"h.host_name",
			])
			.where("t.last_run_at", ">", baseline)
			.where("t.last_run_at", "is not", null)
			.where("t.deleted", "=", 0)
			.orderBy("t.last_run_at", "desc")
			.limit(limit)
			// last_run_at is filtered non-null above; run_count and consecutive_failures
			// are `INTEGER DEFAULT 0` columns every task insert populates.
			.$narrowType<{ last_run_at: NotNull; run_count: NotNull; consecutive_failures: NotNull }>(),
	);
}
