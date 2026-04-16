import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { type SyncedTableName, type TypedEventEmitter, generateHlc, mergeHlc } from "@bound/shared";

// Validate column names to prevent SQL injection
// Only allow lowercase letters, numbers, and underscores
const VALID_COLUMN_NAME = /^[a-z_]+$/;

// Module-level event bus for emitting changelog:written events (optional)
let changelogEventBus: TypedEventEmitter | null = null;

/**
 * Set the event bus for emitting changelog:written events.
 * Called once at startup when WS transport is active.
 */
export function setChangelogEventBus(eventBus: TypedEventEmitter | null): void {
	changelogEventBus = eventBus;
}

// Primary key column per synced table. Defaults to "id" for all others.
const TABLE_PK_COLUMN: Partial<Record<SyncedTableName, string>> = {
	hosts: "site_id",
	cluster_config: "key",
};

function getTablePkColumn(table: SyncedTableName): string {
	return TABLE_PK_COLUMN[table] ?? "id";
}

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
	remoteHlc?: string,
): string {
	const now = new Date().toISOString();
	const rowDataJson = JSON.stringify(rowData);

	// Get last HLC for monotonicity
	const lastRow = db.query("SELECT hlc FROM change_log ORDER BY hlc DESC LIMIT 1").get() as {
		hlc: string;
	} | null;

	let hlc: string;
	if (remoteHlc) {
		hlc = mergeHlc(lastRow?.hlc ?? "0000-00-00T00:00:00.000Z_0000_0000", remoteHlc, siteId);
	} else {
		hlc = generateHlc(now, lastRow?.hlc ?? null, siteId);
	}

	db.run(
		`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
		VALUES (?, ?, ?, ?, ?, ?)`,
		[hlc, tableName, rowId, siteId, now, rowDataJson],
	);

	// Return HLC for caller to emit event after transaction commits
	return hlc;
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
		const result_obj = fn();
		const hlc = createChangeLogEntry(
			db,
			result_obj.tableName,
			result_obj.rowId,
			siteId,
			result_obj.rowData,
		);
		return { result: result_obj.result, hlc, tableName: result_obj.tableName };
	});

	const { result, hlc, tableName } = transaction() as {
		result: T;
		hlc: string;
		tableName: SyncedTableName;
	};

	// Emit event after transaction commits
	if (changelogEventBus) {
		changelogEventBus.emit("changelog:written", { hlc, tableName, siteId });
	}

	return result;
}

export function insertRow(
	db: Database,
	table: SyncedTableName,
	row: Record<string, unknown>,
	siteId: string,
): void {
	const pkColumn = getTablePkColumn(table);
	const rowId = row[pkColumn] as string;
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

		return createChangeLogEntry(db, table, rowId, siteId, row);
	});

	const hlc = txFn();

	// Emit event after transaction commits
	if (changelogEventBus) {
		changelogEventBus.emit("changelog:written", { hlc, tableName: table, siteId });
	}
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

		const pkColumn = getTablePkColumn(table);
		db.run(`UPDATE ${table} SET ${setClause} WHERE ${pkColumn} = ?`, values);

		// Fetch the updated row to get the full snapshot
		const updatedRow = db.query(`SELECT * FROM ${table} WHERE ${pkColumn} = ?`).get(id) as Record<
			string,
			unknown
		> | null;
		if (!updatedRow) {
			throw new Error(`updateRow: Row ${id} disappeared from ${table} after update`);
		}

		return createChangeLogEntry(db, table, id, siteId, updatedRow);
	});

	const hlc = txFn();

	// Emit event after transaction commits
	if (changelogEventBus) {
		changelogEventBus.emit("changelog:written", { hlc, tableName: table, siteId });
	}
}

export function softDelete(db: Database, table: SyncedTableName, id: string, siteId: string): void {
	const txFn = db.transaction(() => {
		const now = new Date().toISOString();

		const pkColumn = getTablePkColumn(table);
		db.run(`UPDATE ${table} SET deleted = 1, modified_at = ? WHERE ${pkColumn} = ?`, [now, id]);

		// Fetch the deleted row to get the full snapshot
		const deletedRow = db.query(`SELECT * FROM ${table} WHERE ${pkColumn} = ?`).get(id) as Record<
			string,
			unknown
		> | null;
		if (!deletedRow) {
			throw new Error(`softDelete: Row ${id} disappeared from ${table} after update`);
		}

		return createChangeLogEntry(db, table, id, siteId, deletedRow);
	});

	const hlc = txFn();

	// Emit event after transaction commits
	if (changelogEventBus) {
		changelogEventBus.emit("changelog:written", { hlc, tableName: table, siteId });
	}
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
