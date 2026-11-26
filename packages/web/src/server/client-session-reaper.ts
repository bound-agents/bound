import type { Database } from "bun:sqlite";
import { softDelete } from "@bound/core";
import { parseClientSessionId } from "./lib/client-session-id";

/**
 * Soft-delete client_sessions rows whose connection is no longer live, scoped
 * to this host's site_id.
 *
 * The WebSocket `close` handler calls `clearAllClientSessions` on clean
 * disconnects, but a killed process, network drop, or host restart never
 * fires `close` — so rows stay at `deleted = 0` forever and the thread-list
 * indicator shows stale badges for every thread that ever had a session.
 *
 * This cross-references the live connection IDs against the DB rows: any
 * local session whose `connection_id` is not in the live set gets
 * soft-deleted. Remote-host sessions are never touched — the host that owns
 * them is the only one that knows which connections are still alive.
 *
 * Returns the IDs of reaped sessions (for logging).
 */
export function reapStaleClientSessions(
	db: Database,
	siteId: string,
	liveConnectionIds: Set<string>,
): string[] {
	const rows = db
		.query(
			`SELECT id FROM client_sessions
			 WHERE site_id = ? AND deleted = 0`,
		)
		.all(siteId) as Array<{ id: string }>;

	const reaped: string[] = [];
	for (const { id } of rows) {
		if (!liveConnectionIds.has(parseClientSessionId(id).connectionId)) {
			softDelete(db, "client_sessions", id, siteId);
			reaped.push(id);
		}
	}
	return reaped;
}
