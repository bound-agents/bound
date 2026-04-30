import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createChangeLogEntry } from "@bound/core";
import type { ChangeLogEntry, Logger, SyncedTableName } from "@bound/shared";
import { TABLE_REDUCER_MAP, parseJsonUntyped } from "@bound/shared";

type RowData = Record<string, SQLQueryBindings>;

export interface ReducerOptions {
	/** Optional logger. Used to surface invariant violations on replay. */
	logger?: Logger;
}

/**
 * Invariant #19: role='system' is forbidden in the `messages` table.
 * insertRow() enforces this at the write boundary, but sync reducers
 * replay rows produced by remote peers — a peer running pre-fix code
 * (or a buggy fork) can still emit role='system'. Stage 2.5 of context
 * assembly silently drops such rows, producing the "agent received a
 * notification but didn't respond" symptom. Reject here so the defense
 * matches insertRow(), and log a warning so operators can trace the
 * source (site_id + row_id) and redeploy the offending peer.
 */
function violatesMessageRoleInvariant(
	event: ChangeLogEntry,
	rowData: RowData,
	logger: Logger | undefined,
): boolean {
	if (event.table_name !== "messages") return false;
	if (rowData.role !== "system") return false;
	logger?.warn("[reducers] Dropping incoming messages row with role='system' (invariant #19)", {
		row_id: event.row_id,
		site_id: event.site_id,
		hlc: event.hlc,
		host_origin: rowData.host_origin ?? null,
	});
	return true;
}

const columnCache: Record<string, string[]> = {};

interface TableInfo {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

const PK_COLUMN_MAP: Record<string, string> = { hosts: "site_id", cluster_config: "key" };

export function getPkColumn(tableName: string): string {
	return PK_COLUMN_MAP[tableName] || "id";
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

export function applyAppendOnlyReducer(
	db: Database,
	event: ChangeLogEntry,
	options?: ReducerOptions,
): { applied: boolean } {
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

	if (violatesMessageRoleInvariant(event, rowData, options?.logger)) {
		return { applied: false };
	}

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

export function applyLWWReducer(
	db: Database,
	event: ChangeLogEntry,
	options?: ReducerOptions,
): { applied: boolean } {
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

	if (violatesMessageRoleInvariant(event, rowData, options?.logger)) {
		return { applied: false };
	}

	const schemaColumns = getTableColumns(db, event.table_name);

	const pkColumn = getPkColumn(event.table_name);
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

export function applyEvent(
	db: Database,
	event: ChangeLogEntry,
	options?: ReducerOptions,
): { applied: boolean } {
	const reducerType = TABLE_REDUCER_MAP[event.table_name];

	if (reducerType === "append-only") {
		return applyAppendOnlyReducer(db, event, options);
	}

	return applyLWWReducer(db, event, options);
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
	options?: {
		onApplied?: (info: AppliedEventInfo) => void;
		/** Optional logger, forwarded to reducers to surface invariant violations. */
		logger?: Logger;
	},
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

			const result = applyEvent(db, event, { logger: options?.logger });

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

/**
 * Bulk-apply snapshot rows directly into the DB without creating changelog entries.
 *
 * Used when a new spoke joins the cluster and the hub seeds it with a full copy
 * of the synced tables. These rows represent historical state that predates the
 * spoke's existence — they MUST NOT generate change_log entries (which would
 * cause the hub to echo them back and create an infinite replication loop).
 *
 * Each row is upserted via INSERT OR REPLACE so replayed chunks are idempotent
 * (safe on reconnect / resume after partial application).
 *
 * @returns Number of rows successfully applied.
 */
export function applySnapshotRows(
	db: Database,
	tableName: string,
	rows: Array<Record<string, unknown>>,
	logger?: Logger,
): number {
	if (!validateTableName(tableName)) {
		logger?.warn("[snapshot] Invalid table name in snapshot chunk", { tableName });
		return 0;
	}

	if (rows.length === 0) return 0;

	// Gather column names from the first row (all rows in a table share columns).
	const firstRow = rows[0];
	const columns = Object.keys(firstRow);

	// Validate all column names
	for (const col of columns) {
		if (!validateColumnName(col)) {
			logger?.warn("[snapshot] Invalid column name in snapshot row", { tableName, column: col });
			return 0;
		}
	}

	let applied = 0;

	// Wrap everything in a single transaction for atomicity.
	db.exec("BEGIN IMMEDIATE");
	try {
		const placeholders = columns.map(() => "?").join(", ");
		const stmt = db.prepare(
			`INSERT OR REPLACE INTO ${tableName} (${columns.join(", ")})
			 VALUES (${placeholders})`,
		);

		for (const row of rows) {
			// Map row values to SQL-compatible bindings (string | number | bigint | boolean | Uint8Array | null).
			// bun:sqlite rejects arbitrary objects, so we coerce unknown values.
			const values: Array<string | number | bigint | boolean | Uint8Array | null> = columns.map(
				(k) => {
					const v = row[k];
					if (v === null || v === undefined) return null;
					if (
						typeof v === "string" ||
						typeof v === "number" ||
						typeof v === "bigint" ||
						typeof v === "boolean" ||
						v instanceof Uint8Array
					) {
						return v;
					}
					// Coerce objects (e.g. JSON columns) to their string representation.
					return JSON.stringify(v);
				},
			);
			stmt.run(...values);
			applied++;
		}

		stmt.finalize();
		db.exec("COMMIT");
	} catch (err) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// ROLLBACK failure — original error takes priority.
		}
		logger?.warn("[snapshot] Batch apply failed, retrying per-row", {
			tableName,
			rowCount: rows.length,
			error: err instanceof Error ? err.message : String(err),
		});
		return applySnapshotRowsPerRow(db, tableName, columns, rows, logger);
	}

	logger?.debug("[snapshot] Applied snapshot chunk", { tableName, applied });
	return applied;
}

function applySnapshotRowsPerRow(
	db: Database,
	tableName: string,
	columns: string[],
	rows: Array<Record<string, unknown>>,
	logger?: Logger,
): number {
	let applied = 0;
	const placeholders = columns.map(() => "?").join(", ");
	const sql = `INSERT OR REPLACE INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders})`;

	for (const row of rows) {
		try {
			const values: Array<string | number | bigint | boolean | Uint8Array | null> = columns.map(
				(k) => {
					const v = row[k];
					if (v === null || v === undefined) return null;
					if (
						typeof v === "string" ||
						typeof v === "number" ||
						typeof v === "bigint" ||
						typeof v === "boolean" ||
						v instanceof Uint8Array
					) {
						return v;
					}
					return JSON.stringify(v);
				},
			);
			db.run(sql, values);
			applied++;
		} catch {
			// skip individual row — trigger rejection or constraint violation
		}
	}

	if (applied < rows.length) {
		logger?.warn("[snapshot] Per-row fallback: skipped rows", {
			tableName,
			applied,
			skipped: rows.length - applied,
		});
	}

	return applied;
}

export function applyColumnChunk(
	db: Database,
	tableName: string,
	pkValue: string,
	columnName: string,
	chunkIndex: number,
	chunkData: string,
	logger?: Logger,
): void {
	if (!validateTableName(tableName)) {
		logger?.warn("[snapshot] Invalid table name in column chunk", { tableName });
		return;
	}
	if (!validateColumnName(columnName)) {
		logger?.warn("[snapshot] Invalid column name in column chunk", { tableName, columnName });
		return;
	}
	const pkColumn = getPkColumn(tableName);
	if (chunkIndex === 0) {
		db.run(`UPDATE ${tableName} SET ${columnName} = ? WHERE ${pkColumn} = ?`, [chunkData, pkValue]);
	} else {
		db.run(`UPDATE ${tableName} SET ${columnName} = ${columnName} || ? WHERE ${pkColumn} = ?`, [
			chunkData,
			pkValue,
		]);
	}
}
