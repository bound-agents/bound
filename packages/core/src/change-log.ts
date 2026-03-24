import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { SyncedTableName } from "@bound/shared";

// Validate column names to prevent SQL injection
// Only allow lowercase letters, numbers, and underscores
const VALID_COLUMN_NAME = /^[a-z_]+$/;

export function validateColumnName(name: string): void {
	if (!VALID_COLUMN_NAME.test(name)) {
		throw new Error(`Invalid column name: ${name}`);
	}
}

export function createChangeLogEntry(
	db: Database,
	tableName: SyncedTableName,
	rowId: string,
	siteId: string,
	rowData: Record<string, unknown>,
): void {
	const now = new Date().toISOString();
	const rowDataJson = JSON.stringify(rowData);

	db.run(
		`INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
		VALUES (?, ?, ?, ?, ?)`,
		[tableName, rowId, siteId, now, rowDataJson],
	);
}

export function withChangeLog<T>(
	db: Database,
	siteId: string,
	fn: () => {
		tableName: SyncedTableName;
		rowId: string;
		rowData: Record<string, unknown>;
		result: T;
	},
): T {
	const transaction = db.transaction(() => {
		const { tableName, rowId, rowData, result } = fn();
		createChangeLogEntry(db, tableName, rowId, siteId, rowData);
		return result;
	});

	return transaction() as T;
}

export function insertRow(
	db: Database,
	table: SyncedTableName,
	row: Record<string, unknown>,
	siteId: string,
): void {
	const rowId = row.id as string;
	const columns = Object.keys(row);
	// Validate all column names to prevent SQL injection
	columns.forEach(validateColumnName);
	const placeholders = columns.map(() => "?").join(", ");
	const values = columns.map((c) => row[c] ?? null) as Array<string | number | null | boolean>;

	const txFn = db.transaction(() => {
		db.run(
			`INSERT INTO ${table} (${columns.join(", ")})
			VALUES (${placeholders})`,
			values,
		);

		createChangeLogEntry(db, table, rowId, siteId, row);
	});

	txFn();
}

export function updateRow(
	db: Database,
	table: SyncedTableName,
	id: string,
	updates: Record<string, unknown>,
	siteId: string,
): void {
	const txFn = db.transaction(() => {
		const now = new Date().toISOString();
		const updatesWithModified = { ...updates, modified_at: now };

		const updateKeys = Object.keys(updatesWithModified);
		// Validate all column names to prevent SQL injection
		updateKeys.forEach(validateColumnName);

		const setClause = updateKeys.map((k) => `${k} = ?`).join(", ");

		const values = [...Object.values(updatesWithModified), id];

		db.run(`UPDATE ${table} SET ${setClause} WHERE id = ?`, values);

		// Fetch the updated row to get the full snapshot
		const updatedRow = db.query(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<
			string,
			unknown
		>;

		createChangeLogEntry(db, table, id, siteId, updatedRow);
	});

	txFn();
}

export function softDelete(db: Database, table: SyncedTableName, id: string, siteId: string): void {
	const txFn = db.transaction(() => {
		const now = new Date().toISOString();

		db.run(`UPDATE ${table} SET deleted = 1, modified_at = ? WHERE id = ?`, [now, id]);

		// Fetch the deleted row to get the full snapshot
		const deletedRow = db.query(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<
			string,
			unknown
		>;

		createChangeLogEntry(db, table, id, siteId, deletedRow);
	});

	txFn();
}

export function insertMessage(
	db: Database,
	params: {
		threadId: string;
		role: string;
		content: string;
		modelId?: string | null;
		toolName?: string | null;
		hostOrigin: string;
	},
	siteId: string,
): string {
	const id = randomUUID();
	const now = new Date().toISOString();
	insertRow(
		db,
		"messages",
		{
			id,
			thread_id: params.threadId,
			role: params.role,
			content: params.content,
			model_id: params.modelId ?? null,
			tool_name: params.toolName ?? null,
			created_at: now,
			modified_at: now,
			host_origin: params.hostOrigin,
			deleted: 0,
		},
		siteId,
	);
	return id;
}
