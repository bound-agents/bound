import type { Database } from "bun:sqlite";

export function listClientSessionSiteIdsByThreadId(
	db: Database,
	threadId: string,
): Array<{ site_id: string }> {
	return db
		.query("SELECT site_id FROM client_sessions WHERE thread_id = ? AND deleted = 0")
		.all(threadId) as Array<{ site_id: string }>;
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

/**
 * Hosts whose heartbeat (`hosts.modified_at`, falling back to `online_at`) is
 * older than this are treated as unable to serve a client session. Shared by
 * `resolveClientSessionHost` (relay routing) and `listRemoteClientToolsForThreads`
 * (tool discovery) so the two never disagree about which sessions are live.
 */
export const CLIENT_SESSION_HOST_STALE_MS = 5 * 60 * 1000;

/**
 * Serialized client tool definitions from live client sessions held by OTHER
 * hosts on any of `threadIds`, restricted to hosts whose heartbeat is fresh by
 * the same rule `resolveClientSessionHost` uses. Rows without tools are omitted.
 */
export function listRemoteClientToolsForThreads(
	db: Database,
	threadIds: string[],
	localSiteId: string,
	staleMs = CLIENT_SESSION_HOST_STALE_MS,
	now = Date.now(),
): string[] {
	if (threadIds.length === 0) return [];
	const placeholders = threadIds.map(() => "?").join(", ");
	const rows = db
		.query(
			`SELECT cs.client_tools AS client_tools, h.modified_at AS modified_at, h.online_at AS online_at
			 FROM client_sessions cs
			 JOIN hosts h ON h.site_id = cs.site_id AND h.deleted = 0
			 WHERE cs.thread_id IN (${placeholders})
			   AND cs.deleted = 0
			   AND cs.site_id != ?
			   AND cs.client_tools IS NOT NULL
			 ORDER BY cs.modified_at DESC`,
		)
		.all(...threadIds, localSiteId) as Array<{
		client_tools: string;
		modified_at: string | null;
		online_at: string | null;
	}>;
	const cutoff = now - staleMs;
	const out: string[] = [];
	for (const row of rows) {
		const tsRaw = row.modified_at ?? row.online_at;
		if (!tsRaw) continue;
		const ts = new Date(tsRaw).getTime();
		if (!(ts >= cutoff)) continue;
		out.push(row.client_tools);
	}
	return out;
}
