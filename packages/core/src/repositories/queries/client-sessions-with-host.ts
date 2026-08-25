import type { Database } from "bun:sqlite";

/**
 * Cross-table read joining `client_sessions` to `hosts` and `threads` to
 * surface, per session, the holding host's display name + heartbeat timestamps
 * and the held thread's interface. Powers `getClientSessions` in
 * `packages/agent/src/delegation.ts` (the `hostinfo` tool surface).
 *
 * See ../index.ts for conventions. Reads only.
 */

/**
 * One client session joined to its holding host and held thread. Column names
 * mirror exactly what `getClientSessions` destructures. The caller dedups by
 * `(thread_id, site_id)` and derives a `live` verdict from the host timestamps.
 */
export interface ClientSessionWithHostRow {
	thread_id: string;
	site_id: string;
	/** hosts.host_name (null when the host is unknown / soft-deleted). */
	host_name: string | null;
	/** hosts.modified_at (heartbeat freshness signal). */
	modified_at: string | null;
	/** hosts.online_at (fallback freshness signal). */
	online_at: string | null;
	/** threads.interface of the held thread (null when unknown / deleted). */
	interface: string | null;
}

/**
 * All live client sessions joined to their holding host (for name + heartbeat
 * timestamps) and held thread (for interface). Soft-deleted sessions are
 * excluded; deleted hosts/threads are excluded from the JOIN (their columns
 * come back null). No ordering — the caller dedups and sorts.
 */
export function listClientSessionsWithHost(db: Database): ClientSessionWithHostRow[] {
	return db
		.query(
			`SELECT cs.thread_id, cs.site_id, h.host_name, h.modified_at, h.online_at, t.interface
			 FROM client_sessions cs
			 LEFT JOIN hosts h ON h.site_id = cs.site_id AND h.deleted = 0
			 LEFT JOIN threads t ON t.id = cs.thread_id AND t.deleted = 0
			 WHERE cs.deleted = 0`,
		)
		.all() as ClientSessionWithHostRow[];
}
