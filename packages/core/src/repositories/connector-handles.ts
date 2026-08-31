import type { Database } from "bun:sqlite";
import type { ConnectorHandleRow } from "@bound/shared";

/**
 * Read repository for the `connector_handles` table. See ./index.ts for conventions.
 */

export function findConnectorHandleById(db: Database, handleId: string): ConnectorHandleRow | null {
	return db
		.query("SELECT * FROM connector_handles WHERE id = ? AND deleted = 0")
		.get(handleId) as ConnectorHandleRow | null;
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
	return db
		.query("SELECT * FROM connector_handles WHERE id = ?")
		.get(handleId) as ConnectorHandleRow | null;
}

/** All active handles bound to `serverName` — e.g. every Discord subscription, when reconnecting a platform's subscriptions after a leader failover. */
export function listConnectorHandlesByServer(
	db: Database,
	serverName: string,
): ConnectorHandleRow[] {
	return db
		.query("SELECT * FROM connector_handles WHERE server_name = ? AND deleted = 0")
		.all(serverName) as ConnectorHandleRow[];
}

export function listActiveConnectorHandles(db: Database): ConnectorHandleRow[] {
	return db
		.query("SELECT * FROM connector_handles WHERE deleted = 0")
		.all() as ConnectorHandleRow[];
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
	return db
		.query(
			`SELECT h.id, h.server_name || ':' || h.event_name AS name, h.task_id
			 FROM connector_handles h
			 JOIN tasks t ON t.id = h.task_id
			 WHERE t.thread_id = ?
			   AND h.deleted = 0
			   AND t.deleted = 0
			   AND t.status <> 'cancelled'`,
		)
		.get(threadId) as { id: string; name: string; task_id: string } | null;
}

/**
 * Looks up which connector server owns the event handler task `taskId` was
 * created for. Used to resolve tool scoping for an event-task thread: the
 * server name tells `getToolsForThread` which platform's tools to expose.
 */
export function findConnectorHandleServerNameByTaskId(
	db: Database,
	taskId: string,
): { server_name: string } | null {
	return db
		.query("SELECT server_name FROM connector_handles WHERE task_id = ? AND deleted = 0")
		.get(taskId) as { server_name: string } | null;
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
	return db
		.query("SELECT id, server_name, deleted FROM connector_handles WHERE id = ?")
		.get(id) as ConnectorHandleSyncNotificationRow | null;
}
