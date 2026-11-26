import type { Database } from "bun:sqlite";
import type { ConnectorHandleRow } from "@bound/shared";
import { type NotNull, sql } from "kysely";
import { getAll, getOne, queryBuilder } from "../query-builder";

export function findConnectorHandleById(db: Database, handleId: string): ConnectorHandleRow | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("connector_handles")
			.selectAll()
			.where("id", "=", handleId)
			.where("deleted", "=", 0),
	);
}

/**
 * Finds a handle row by ID regardless of deleted status. Handle IDs are
 * deterministic over (server, event, args), so a soft-deleted tombstone
 * occupies the same primary key as a re-created subscription — creators
 * must check for it to resurrect instead of inserting.
 */
export function findConnectorHandleIncludingDeleted(
	db: Database,
	handleId: string,
): ConnectorHandleRow | null {
	return getOne(
		db,
		queryBuilder.selectFrom("connector_handles").selectAll().where("id", "=", handleId),
	);
}

/** All active handles bound to `serverName` — e.g. every Discord subscription, when reconnecting a platform's subscriptions after a leader failover. */
export function listConnectorHandlesByServer(
	db: Database,
	serverName: string,
): ConnectorHandleRow[] {
	return getAll(
		db,
		queryBuilder
			.selectFrom("connector_handles")
			.selectAll()
			.where("server_name", "=", serverName)
			.where("deleted", "=", 0),
	);
}

/**
 * Finds the live connector handle whose event task owns `threadId`.
 *
 * Connector intake rows use the task thread as `ref_id`; this mirrors the
 * webhook and RSS binding finders used by the local stale-intake reconciler.
 * A handle's task is its routing identity, so the returned handle id recreates
 * the exact `connector:event:<handle-id>` trigger emitted at delivery time.
 */
export function findActiveConnectorHandleByThreadId(
	db: Database,
	threadId: string,
): { id: string; name: string; task_id: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("connector_handles as h")
			.innerJoin("tasks as t", "t.id", "h.task_id")
			.select(["h.id", sql<string>`h.server_name || ':' || h.event_name`.as("name"), "h.task_id"])
			.where("t.thread_id", "=", threadId)
			.where("h.deleted", "=", 0)
			.where("t.deleted", "=", 0)
			.where("t.status", "<>", "cancelled")
			.$narrowType<{ task_id: NotNull }>(),
	);
}

export interface ConnectorHandleSyncNotificationRow {
	id: string;
	server_name: string;
	deleted: number;
}

/** Includes tombstones so callers can suppress activation of deleted handles. */
export function findConnectorHandleForSyncNotification(
	db: Database,
	id: string,
): ConnectorHandleSyncNotificationRow | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("connector_handles")
			.select(["id", "server_name", "deleted"])
			.where("id", "=", id),
	);
}
