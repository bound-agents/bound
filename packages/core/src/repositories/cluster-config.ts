import type { Database } from "bun:sqlite";
import { getOne, queryBuilder } from "../query-builder";

/**
 * `cluster_config` is keyed by `key`, not `id`.
 *
 * cluster_config now soft-deletes (invariant #2): live reads filter `deleted = 0`.
 * The existence-probe variant below intentionally does NOT filter — writers use it
 * to detect a tombstoned row so a re-set UPDATEs (un-tombstones) rather than
 * colliding on the `key` PK with an INSERT.
 */

/**
 * Resolve a single LIVE cluster_config row's `value` by key, or null if absent/tombstoned.
 * (context-assembly persona load, leader lookup, scheduler emergency_stop check)
 */
export function findClusterConfigValueByKey(db: Database, key: string): { value: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("cluster_config")
			.select("value")
			.where("key", "=", key)
			.where("deleted", "=", 0)
			.limit(1),
	);
}

/**
 * Existence check for a LIVE cluster_config row, returning its `key` or null.
 */
export function findClusterConfigKeyByKey(db: Database, key: string): { key: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("cluster_config")
			.select("key")
			.where("key", "=", key)
			.where("deleted", "=", 0),
	);
}

/**
 * Existence check that INCLUDES tombstoned rows. Use this on the write path to
 * decide UPDATE-vs-INSERT: a soft-deleted row still occupies the `key` PK, so a
 * re-set must UPDATE (setting deleted = 0) rather than INSERT a colliding row.
 */
export function findClusterConfigKeyByKeyIncludingDeleted(
	db: Database,
	key: string,
): { key: string } | null {
	return getOne(db, queryBuilder.selectFrom("cluster_config").select("key").where("key", "=", key));
}
