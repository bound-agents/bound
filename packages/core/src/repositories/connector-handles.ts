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
