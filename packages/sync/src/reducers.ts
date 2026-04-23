import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createChangeLogEntry } from "@bound/core";
import type { ChangeLogEntry, SyncedTableName } from "@bound/shared";
import { TABLE_REDUCER_MAP, parseJsonUntyped } from "@bound/shared";

type RowData = Record<string, SQLQueryBindings>;

const columnCache: Record<string, string[]> = {};

interface TableInfo {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

// Validate table name - must be a known synced table
function validateTableName(tableName: unknown): tableName is SyncedTableName {
	const validTables = Object.keys(TABLE_REDUCER_MAP);
	return typeof tableName === "string" && validTables.includes(tableName);
}

// Validate column name - must match /^[a-z_]+$/ pattern
function validateColumnName(colName: string): boolean {
	return /^[a-z_]+$/.test(colName);
}

export function getTableColumns(db: Database, tableName: string): string[] {
	if (!validateTableName(tableName)) {
		throw new Error(`Invalid table name: ${tableName}`);
	}

	if (columnCache[tableName]) {
		return columnCache[tableName];
	}

	const columns = db.query(`PRAGMA table_info(${tableName})`).all() as TableInfo[];

	const columnNames = columns.map((row) => row.name);

	columnCache[tableName] = columnNames;
	return columnNames;
}

// Export for testing - clears the column cache to avoid state leakage between tests
export function clearColumnCache(): void {
	for (const key of Object.keys(columnCache)) {
		delete columnCache[key];
	}
}

export function applyAppendOnlyReducer(db: Database, event: ChangeLogEntry): { applied: boolean } {
	// Validate table name
	if (!validateTableName(event.table_name)) {
		return { applied: false };
	}

	const parseResult = parseJsonUntyped(event.row_data, `${event.table_name}.${event.row_id}`);
	if (!parseResult.ok) {
		return { applied: false };
	}
	const value = parseResult.value;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { applied: false };
	}
	const rowData = value as RowData;
	const hasModifiedAt = rowData.modified_at !== null && rowData.modified_at !== undefined;

	const columns = Object.keys(rowData);

	// Validate all column names
	if (!columns.every((col) => validateColumnName(col))) {
		return { applied: false };
	}

	const placeholders = columns.map(() => "?").join(", ");
	const values = columns.map((k) => rowData[k]);

	if (hasModifiedAt) {
		// Hybrid reducer: if row exists, apply LWW update (for redaction). If not, insert normally.
		const existing = db
			.query(`SELECT * FROM ${event.table_name} WHERE id = ?`)
			.get(rowData.id) as Record<string, unknown> | null;

		if (!existing) {
			// Row doesn't exist — insert it (standard append-only behavior)
			db.run(
				`INSERT INTO ${event.table_name} (${columns.join(", ")})
				VALUES (${placeholders})
				ON CONFLICT(id) DO NOTHING`,
				values,
			);
			const changes = db.query("SELECT changes() as count").get() as Record<string, number>;
			return { applied: changes.count > 0 };
		}

		const existingModifiedAt = existing.modified_at;

		// Only update if incoming is newer
		if (existingModifiedAt && rowData.modified_at && rowData.modified_at <= existingModifiedAt) {
			return { applied: false };
		}

		// Update only the columns provided in the event
		const updateClauses = columns.filter((k) => k !== "id").map((k) => `${k} = ?`);
		const updateValues = columns.filter((k) => k !== "id").map((k) => rowData[k]);
		updateValues.push(rowData.id);

		db.run(`UPDATE ${event.table_name} SET ${updateClauses.join(", ")} WHERE id = ?`, updateValues);
	} else {
		// Standard append-only: insert or do nothing on conflict
		db.run(
			`INSERT INTO ${event.table_name} (${columns.join(", ")})
			VALUES (${placeholders})
			ON CONFLICT(id) DO NOTHING`,
			values,
		);
	}

	// Check if the operation actually happened
	const changes = db.query("SELECT changes() as count").get() as Record<string, number>;
	return { applied: changes.count > 0 };
}

export function applyLWWReducer(db: Database, event: ChangeLogEntry): { applied: boolean } {
	// Validate table name
	if (!validateTableName(event.table_name)) {
		return { applied: false };
	}

	const parseResult = parseJsonUntyped(event.row_data, `${event.table_name}.${event.row_id}`);
	if (!parseResult.ok) {
		return { applied: false };
	}
	const value = parseResult.value;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { applied: false };
	}
	const rowData = value as RowData;
	const schemaColumns = getTableColumns(db, event.table_name);

	// Determine primary key column from schema (most tables use 'id', but some don't)
	const pkMap: Record<string, string> = { hosts: "site_id", cluster_config: "key" };
	const pkColumn = pkMap[event.table_name] || "id";
	const pkValue = rowData[pkColumn] ?? event.row_id;

	// Check if row already exists
	const existing = db
		.query(`SELECT * FROM ${event.table_name} WHERE ${pkColumn} = ?`)
		.get(pkValue) as Record<string, unknown> | null;

	// If row doesn't exist, do a simple insert with all provided columns.
	// Partial row_data (e.g. heartbeat-only updates missing NOT NULL fields) may fail —
	// skip gracefully since a later event with full data will succeed.
	if (!existing) {
		const columnsToInsert = Object.keys(rowData).filter(
			(col) => validateColumnName(col) && schemaColumns.includes(col),
		);
		const valuesToInsert = columnsToInsert.map((col) => rowData[col]);
		try {
			db.run(
				`INSERT INTO ${event.table_name} (${columnsToInsert.join(", ")})
				VALUES (${columnsToInsert.map(() => "?").join(", ")})`,
				valuesToInsert,
			);
			const changes = db.query("SELECT changes() as count").get() as Record<string, number>;
			return { applied: changes.count > 0 };
		} catch {
			// Partial row_data missing NOT NULL columns — skip, a later event will have full data
			return { applied: false };
		}
	}

	// Row exists - apply LWW: only update if incoming modified_at > existing modified_at
	if (rowData.modified_at !== undefined && rowData.modified_at !== null) {
		const existingModifiedAt = existing.modified_at;

		// Only proceed if incoming is newer
		if (existingModifiedAt && rowData.modified_at && rowData.modified_at <= existingModifiedAt) {
			return { applied: false };
		}
	}

	// Update only columns that are in both the event and the schema (except the PK)
	const columnsToUpdate = Object.keys(rowData).filter(
		(col) => validateColumnName(col) && schemaColumns.includes(col) && col !== pkColumn,
	);

	if (columnsToUpdate.length === 0) {
		return { applied: false };
	}

	const updateSetClauses = columnsToUpdate.map((col) => `${col} = ?`);
	const valuesToUpdate = columnsToUpdate.map((col) => rowData[col]);
	valuesToUpdate.push(pkValue);

	db.run(
		`UPDATE ${event.table_name} SET ${updateSetClauses.join(", ")} WHERE ${pkColumn} = ?`,
		valuesToUpdate,
	);

	const changes = db.query("SELECT changes() as count").get() as Record<string, number>;
	return { applied: changes.count > 0 };
}

export function applyEvent(db: Database, event: ChangeLogEntry): { applied: boolean } {
	const reducerType = TABLE_REDUCER_MAP[event.table_name];

	if (reducerType === "append-only") {
		return applyAppendOnlyReducer(db, event);
	}

	return applyLWWReducer(db, event);
}

/**
 * Information about a single event that was successfully applied during replay.
 * Used by transport-layer callers to emit local event-bus notifications so
 * UI subscribers (TUI / web) see synced-in rows without needing to poll.
 */
export interface AppliedEventInfo {
	table_name: string;
	row_id: string;
	site_id: string;
	hlc: string;
	row_data: RowData;
}

export function replayEvents(
	db: Database,
	events: ChangeLogEntry[],
	options?: { onApplied?: (info: AppliedEventInfo) => void },
): { applied: number; skipped: number } {
	let applied = 0;
	let skipped = 0;
	// Queue applied-event notifications and fire them AFTER COMMIT so that
	// subscribers querying the DB in response see the committed state (and a
	// reducer exception can't mislead listeners about rows that got rolled back).
	const appliedInfos: AppliedEventInfo[] = [];

	// Wrap in transaction so partial failures don't leave the DB in an
	// inconsistent state (all-or-nothing for each sync batch).
	db.exec("BEGIN");
	try {
		for (const event of events) {
			const parseResult = parseJsonUntyped(event.row_data, `${event.table_name}.${event.row_id}`);
			if (!parseResult.ok) {
				skipped++;
				continue; // Skip malformed events rather than crashing the batch
			}
			const value = parseResult.value;
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				skipped++;
				continue;
			}
			const rowData = value as RowData;

			const result = applyEvent(db, event);

			if (result.applied) {
				applied++;
				// Create a change_log entry preserving the original site_id
				// Pass remoteHlc so the local HLC advances past the remote event
				createChangeLogEntry(db, event.table_name, event.row_id, event.site_id, rowData, event.hlc);
				if (options?.onApplied) {
					appliedInfos.push({
						table_name: event.table_name,
						row_id: event.row_id,
						site_id: event.site_id,
						hlc: event.hlc,
						row_data: rowData,
					});
				}
			} else {
				skipped++;
			}
		}
		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// ROLLBACK failed, original error takes priority
		}
		throw error;
	}

	// Fire applied-event notifications AFTER successful commit. Individual
	// listener failures must not poison the batch result or other listeners.
	if (options?.onApplied && appliedInfos.length > 0) {
		for (const info of appliedInfos) {
			try {
				options.onApplied(info);
			} catch {
				// Swallow listener errors — callers own their own error handling.
			}
		}
	}

	return { applied, skipped };
}
