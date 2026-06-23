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

export function findConnectorHandleServerNameByTaskId(
	db: Database,
	taskId: string,
): { server_name: string } | null {
	return db
		.query("SELECT server_name FROM connector_handles WHERE task_id = ? AND deleted = 0")
		.get(taskId) as { server_name: string } | null;
}
