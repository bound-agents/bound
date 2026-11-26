import type { Database } from "bun:sqlite";
import type { NotNull } from "kysely";
import { getAll, getOne, queryBuilder } from "../query-builder";

export function listClientSessionSiteIdsByThreadId(
	db: Database,
	threadId: string,
): Array<{ site_id: string }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("client_sessions")
			.select("site_id")
			.where("thread_id", "=", threadId)
			.where("deleted", "=", 0),
	);
}

/**
 * Existence check by id WITHOUT the `deleted = 0` filter — matches the
 * upsert read-back in `recordClientSession`, which re-undeletes existing rows.
 */
export function findClientSessionIdById(db: Database, id: string): { id: string } | null {
	return getOne(db, queryBuilder.selectFrom("client_sessions").select("id").where("id", "=", id));
}

export function findLiveClientSessionIdById(db: Database, id: string): { id: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("client_sessions")
			.select("id")
			.where("id", "=", id)
			.where("deleted", "=", 0),
	);
}

/** List live session ids held by a single connection (cleared on disconnect). */
export function listClientSessionIdsByConnectionId(
	db: Database,
	connectionId: string,
): Array<{ id: string }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("client_sessions")
			.select("id")
			.where("connection_id", "=", connectionId)
			.where("deleted", "=", 0),
	);
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
	const rows = getAll(
		db,
		queryBuilder
			.selectFrom("client_sessions as cs")
			.innerJoin("hosts as h", (join) =>
				join.onRef("h.site_id", "=", "cs.site_id").on("h.deleted", "=", 0),
			)
			.select([
				"cs.client_tools as client_tools",
				"h.modified_at as modified_at",
				"h.online_at as online_at",
			])
			.where("cs.thread_id", "in", threadIds)
			.where("cs.deleted", "=", 0)
			.where("cs.site_id", "!=", localSiteId)
			.where("cs.client_tools", "is not", null)
			.orderBy("cs.modified_at", "desc")
			.$narrowType<{ client_tools: NotNull }>(),
	);
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
