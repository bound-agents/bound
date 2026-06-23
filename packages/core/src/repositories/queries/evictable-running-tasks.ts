import type { Database } from "bun:sqlite";
import type { Task } from "@bound/shared";

/**
 * Cross-table read joining `tasks` to `hosts` to find `running` tasks whose
 * lease has lapsed and whose claiming host is offline/gone (or whose heartbeat
 * is stale past the orphan backstop). Powers heartbeat eviction in
 * `packages/agent/src/scheduler.ts`.
 *
 * See ../index.ts for conventions. Reads only.
 */

/**
 * Full `tasks` row (`t.*`) for an evictable running task. The host JOIN is used
 * only in the predicate; the projection is the task row itself.
 */
export type EvictableRunningTaskRow = Task;

/**
 * Running, non-deleted tasks eligible for heartbeat eviction.
 *
 * Bind order / semantics preserved exactly from `EVICTION_SELECTOR_SQL`:
 *  - `evictionTime` — gates ALL eviction (`t.heartbeat_at < evictionTime`).
 *  - `hostOfflineThreshold` — host offline/gone (R-LR2):
 *    `COALESCE(h.modified_at, h.online_at) < hostOfflineThreshold`.
 *  - `orphanThreshold` — orphan backstop (`t.heartbeat_at < orphanThreshold`).
 *
 * The LEFT JOIN with `claimed_by = NULL` never matches → `h.site_id IS NULL`
 * fires → the row is evicted, covering the corrupted state where
 * `status = 'running'` but the lease is unset.
 */
export function listEvictableRunningTasks(
	db: Database,
	args: { evictionTime: string; hostOfflineThreshold: string; orphanThreshold: string },
): EvictableRunningTaskRow[] {
	return db
		.prepare(
			`SELECT t.*
	 FROM tasks t
	 LEFT JOIN hosts h ON h.site_id = t.claimed_by
	 WHERE t.status = 'running'
	   AND t.deleted = 0
	   AND t.heartbeat_at < ?
	   AND (
		   h.site_id IS NULL
		   OR COALESCE(h.modified_at, h.online_at) < ?
		   OR t.heartbeat_at < ?
	   )`,
		)
		.all(
			args.evictionTime,
			args.hostOfflineThreshold,
			args.orphanThreshold,
		) as EvictableRunningTaskRow[];
}
