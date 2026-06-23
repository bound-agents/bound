import type { Database } from "bun:sqlite";

/**
 * Read repository for the `cluster_config` table. See ./index.ts for conventions.
 * Note: `cluster_config` is keyed by `key`, not `id`, and has no `deleted` column.
 */

/**
 * Resolve a single cluster_config row's `value` by key, or null if absent.
 * (leader-election leader lookup, context-assembly persona load, scheduler emergency_stop check)
 */
export function findClusterConfigValueByKey(db: Database, key: string): { value: string } | null {
	return db
		.query<{ value: string }, [string]>("SELECT value FROM cluster_config WHERE key = ? LIMIT 1")
		.get(key) as { value: string } | null;
}

/**
 * Resolve a single cluster_config row's `value` and `modified_at` by key, or null if absent.
 * (web persona route read)
 */
export function findClusterConfigValueWithModifiedAtByKey(
	db: Database,
	key: string,
): { value: string; modified_at: string } | null {
	return db.query("SELECT value, modified_at FROM cluster_config WHERE key = ?").get(key) as {
		value: string;
		modified_at: string;
	} | null;
}

/**
 * Existence check for a cluster_config row, returning its `key` or null.
 * (stop-resume, set-persona, config-reload, set-hub, drain existence probes)
 */
export function findClusterConfigKeyByKey(db: Database, key: string): { key: string } | null {
	return db.query("SELECT key FROM cluster_config WHERE key = ?").get(key) as {
		key: string;
	} | null;
}
