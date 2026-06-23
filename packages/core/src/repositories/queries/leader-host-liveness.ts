import type { Database } from "bun:sqlite";

/**
 * Cross-table read joining `cluster_config` to `hosts`: resolve the host
 * referenced by a cluster_config key (whose value is a site_id) to that host's
 * heartbeat timestamp. Powers leader-liveness checks in
 * `packages/platforms/src/leader-election.ts`.
 *
 * See ../index.ts for conventions. Reads only; bun:sqlite `.get()` returns
 * `null` on empty reads.
 */

/** Projection: the referenced host's heartbeat timestamp. */
export interface LeaderHostLivenessRow {
	modified_at: string;
}

/**
 * For a cluster_config `key` whose value is a host site_id, return that live
 * host's `modified_at` (heartbeat) via `cluster_config JOIN hosts`. Both a
 * tombstoned cluster_config row and a deleted host are excluded. Returns `null`
 * when the key is unset/tombstoned or the host is absent/deleted.
 */
export function getLeaderHostLiveness(db: Database, key: string): LeaderHostLivenessRow | null {
	return db
		.prepare(
			"SELECT h.modified_at FROM cluster_config cc JOIN hosts h ON h.site_id = cc.value WHERE cc.key = ? AND cc.deleted = 0 AND h.deleted = 0 LIMIT 1",
		)
		.get(key) as LeaderHostLivenessRow | null;
}
