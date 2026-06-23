import type { Database } from "bun:sqlite";

/**
 * Read repository for the `cluster_config` table. See ./index.ts for conventions.
 * Note: `cluster_config` is keyed by `key`, not `id`.
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
	return db
		.query<{ value: string }, [string]>(
			"SELECT value FROM cluster_config WHERE key = ? AND deleted = 0 LIMIT 1",
		)
		.get(key) as { value: string } | null;
}

/**
 * Resolve a single LIVE cluster_config row's `value` and `modified_at` by key, or null
 * if absent/tombstoned. (web persona route read)
 */
export function findClusterConfigValueWithModifiedAtByKey(
	db: Database,
	key: string,
): { value: string; modified_at: string } | null {
	return db
		.query("SELECT value, modified_at FROM cluster_config WHERE key = ? AND deleted = 0")
		.get(key) as {
		value: string;
		modified_at: string;
	} | null;
}

/**
 * Existence check for a LIVE cluster_config row, returning its `key` or null.
 */
export function findClusterConfigKeyByKey(db: Database, key: string): { key: string } | null {
	return db.query("SELECT key FROM cluster_config WHERE key = ? AND deleted = 0").get(key) as {
		key: string;
	} | null;
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
	return db.query("SELECT key FROM cluster_config WHERE key = ?").get(key) as {
		key: string;
	} | null;
}
