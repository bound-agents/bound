import type { Database } from "bun:sqlite";
import { insertRow, softDelete, updateRow } from "@bound/core";
import { connectorHandleId } from "./connector-handle-id.js";

export interface ConnectorHandleCreateParams {
	serverName: string;
	eventName: string;
	eventArgs: Record<string, unknown>;
	deliveryMode: "push" | "poll";
	taskId: string | null;
	cursor?: string | null;
}

export interface ConnectorHandleRecord {
	id: string;
	server_name: string;
	event_name: string;
	event_args: string;
	delivery_mode: string;
	cursor: string | null;
	task_id: string | null;
	created_at: string;
	deleted: number;
	modified_at: string;
}

/**
 * Creates a new connector handle row via the outbox pattern.
 * Returns the deterministic ID.
 */
export function createConnectorHandle(
	db: Database,
	siteId: string,
	params: ConnectorHandleCreateParams,
): string {
	const id = connectorHandleId(params.serverName, params.eventName, params.eventArgs);
	const now = new Date().toISOString();
	insertRow(
		db,
		"connector_handles",
		{
			id,
			server_name: params.serverName,
			event_name: params.eventName,
			event_args: JSON.stringify(params.eventArgs),
			delivery_mode: params.deliveryMode,
			cursor: params.cursor ?? null,
			task_id: params.taskId,
			created_at: now,
			deleted: 0,
			modified_at: now,
		},
		siteId,
	);
	return id;
}

/**
 * Updates the cursor on a connector handle after successful batch delivery.
 */
export function updateConnectorHandleCursor(
	db: Database,
	siteId: string,
	handleId: string,
	cursor: string,
): void {
	updateRow(db, "connector_handles", handleId, { cursor }, siteId);
}

/**
 * Links a connector handle to its event task.
 */
export function linkConnectorHandleTask(
	db: Database,
	siteId: string,
	handleId: string,
	taskId: string,
): void {
	updateRow(db, "connector_handles", handleId, { task_id: taskId }, siteId);
}

/**
 * Soft-deletes a connector handle.
 */
export function deleteConnectorHandle(db: Database, siteId: string, handleId: string): void {
	softDelete(db, "connector_handles", handleId, siteId);
}

/**
 * Reads a single connector handle by ID. Returns null if not found or deleted.
 */
export function getConnectorHandle(db: Database, handleId: string): ConnectorHandleRecord | null {
	return db
		.query("SELECT * FROM connector_handles WHERE id = ? AND deleted = 0")
		.get(handleId) as ConnectorHandleRecord | null;
}

/**
 * Reads all active connector handles for a given server.
 */
export function getConnectorHandlesByServer(
	db: Database,
	serverName: string,
): ConnectorHandleRecord[] {
	return db
		.query("SELECT * FROM connector_handles WHERE server_name = ? AND deleted = 0")
		.all(serverName) as ConnectorHandleRecord[];
}

/**
 * Reads all active connector handles (used for reconnection after failover).
 */
export function getAllActiveConnectorHandles(db: Database): ConnectorHandleRecord[] {
	return db
		.query("SELECT * FROM connector_handles WHERE deleted = 0")
		.all() as ConnectorHandleRecord[];
}
