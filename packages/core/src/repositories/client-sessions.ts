import type { Database } from "bun:sqlite";

/**
 * Read repository for the `client_sessions` table (synced, LWW). See ./index.ts
 * for conventions. The row id format is `${connectionId}::${threadId}`.
 */

/**
 * List live session ids held by this host (used by the stale-session reaper to
 * cross-reference against live connection ids).
 */
export function listClientSessionIdsBySiteId(db: Database, siteId: string): Array<{ id: string }> {
	return db
		.query("SELECT id FROM client_sessions WHERE site_id = ? AND deleted = 0")
		.all(siteId) as Array<{ id: string }>;
}

/** List the site_ids of every live session attached to a thread. */
export function listClientSessionSiteIdsByThreadId(
	db: Database,
	threadId: string,
): Array<{ site_id: string }> {
	return db
		.query("SELECT site_id FROM client_sessions WHERE thread_id = ? AND deleted = 0")
		.all(threadId) as Array<{ site_id: string }>;
}

/** True when a live session for this thread exists on the given host. */
export function hasLiveClientSessionForThreadOnSite(
	db: Database,
	threadId: string,
	siteId: string,
): boolean {
	const row = db
		.query(
			"SELECT 1 FROM client_sessions WHERE thread_id = ? AND site_id = ? AND deleted = 0 LIMIT 1",
		)
		.get(threadId, siteId) as { 1: number } | null;
	return row !== null;
}

/**
 * Existence check by id WITHOUT the `deleted = 0` filter — matches the
 * upsert read-back in `recordClientSession`, which re-undeletes existing rows.
 */
export function findClientSessionIdById(db: Database, id: string): { id: string } | null {
	return db.query("SELECT id FROM client_sessions WHERE id = ?").get(id) as {
		id: string;
	} | null;
}

/** Existence check by id WITH the `deleted = 0` filter. */
export function findLiveClientSessionIdById(db: Database, id: string): { id: string } | null {
	return db.query("SELECT id FROM client_sessions WHERE id = ? AND deleted = 0").get(id) as {
		id: string;
	} | null;
}

/** List live session ids held by a single connection (cleared on disconnect). */
export function listClientSessionIdsByConnectionId(
	db: Database,
	connectionId: string,
): Array<{ id: string }> {
	return db
		.query("SELECT id FROM client_sessions WHERE connection_id = ? AND deleted = 0")
		.all(connectionId) as Array<{ id: string }>;
}
