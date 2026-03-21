import type { Database } from "bun:sqlite";
import type { SyncedTableName } from "@bound/shared";
import { randomUUID } from "crypto";

export interface ConfigError {
	filename: string;
	message: string;
	fieldErrors: Record<string, string[]>;
}

export function createChangeLogEntry(
	db: Database,
	tableName: SyncedTableName,
	rowId: string,
	siteId: string,
	rowData: Record<string, unknown>
): void {
	const now = new Date().toISOString();
	const rowDataJson = JSON.stringify(rowData);

	db.run(
		`INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
		VALUES (?, ?, ?, ?, ?)`,
		[tableName, rowId, siteId, now, rowDataJson]
	);
}

export function withChangeLog<T>(
	db: Database,
	siteId: string,
	fn: (tx: Database) => {
		tableName: SyncedTableName;
		rowId: string;
		rowData: Record<string, unknown>;
		result: T;
	}
): T {
	const transaction = db.transaction((innerDb: Database) => {
		const { tableName, rowId, rowData, result } = fn(innerDb);
		createChangeLogEntry(innerDb, tableName, rowId, siteId, rowData);
		return result;
	});

	return transaction() as T;
}

export function insertRow(
	db: Database,
	table: SyncedTableName,
	row: Record<string, unknown>,
	siteId: string
): void {
	const rowId = row.id as string;
	const columns = Object.keys(row);
	const placeholders = columns.map(() => "?").join(", ");
	const values = columns.map((c) => row[c]);

	const txFn = db.transaction(() => {
		db.run(
			`INSERT INTO ${table} (${columns.join(", ")})
			VALUES (${placeholders})`,
			values
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
	siteId: string
): void {
	const txFn = db.transaction(() => {
		const now = new Date().toISOString();
		const updatesWithModified = { ...updates, modified_at: now };

		const setClause = Object.keys(updatesWithModified)
			.map((k) => `${k} = ?`)
			.join(", ");

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

export function softDelete(
	db: Database,
	table: SyncedTableName,
	id: string,
	siteId: string
): void {
	const txFn = db.transaction(() => {
		const now = new Date().toISOString();

		db.run(`UPDATE ${table} SET deleted = 1, modified_at = ? WHERE id = ?`, [now, id]);

		// Fetch the deleted row to get the full snapshot
		const deletedRow = db
			.query(`SELECT * FROM ${table} WHERE id = ?`)
			.get(id) as Record<string, unknown>;

		createChangeLogEntry(db, table, id, siteId, deletedRow);
	});

	txFn();
}
