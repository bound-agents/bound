import type { Database } from "bun:sqlite";
import { createChangeLogEntry } from "@bound/core";
import type { ChangeLogEntry } from "@bound/shared";
import { TABLE_REDUCER_MAP } from "@bound/shared";

const columnCache: Record<string, string[]> = {};

interface TableInfo {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

export function getTableColumns(db: Database, tableName: string): string[] {
	if (columnCache[tableName]) {
		return columnCache[tableName];
	}

	const columns = db
		.query(`PRAGMA table_info(${tableName})`)
		.all()
		.map((row: TableInfo) => row.name);

	columnCache[tableName] = columns;
	return columns;
}

export function applyAppendOnlyReducer(db: Database, event: ChangeLogEntry): { applied: boolean } {
	const rowData = JSON.parse(event.row_data);
	const hasModifiedAt = rowData.modified_at !== null && rowData.modified_at !== undefined;

	const columns = Object.keys(rowData);
	const placeholders = columns.map(() => "?").join(", ");
	const values = columns.map((k) => rowData[k]);

	if (hasModifiedAt) {
		// Hybrid reducer for redaction: check if row exists and update if modified_at is newer
		const existing = db.query(`SELECT * FROM ${event.table_name} WHERE id = ?`).get(rowData.id) as
			| Record<string, unknown>
			| undefined;

		if (!existing) {
			// If row doesn't exist, we can't apply a redaction (missing required fields)
			return { applied: false };
		}

		const existingModifiedAt = existing.modified_at;

		// Only update if incoming is newer
		if (existingModifiedAt && rowData.modified_at <= existingModifiedAt) {
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
	const rowData = JSON.parse(event.row_data);
	const schemaColumns = getTableColumns(db, event.table_name);

	// Check if row already exists
	const existing = db.query(`SELECT * FROM ${event.table_name} WHERE id = ?`).get(rowData.id) as
		| Record<string, unknown>
		| undefined;

	// If row doesn't exist, do a simple insert with all provided columns
	if (!existing) {
		const columnsToInsert = Object.keys(rowData).filter((col) => schemaColumns.includes(col));
		const valuesToInsert = columnsToInsert.map((col) => rowData[col]);
		db.run(
			`INSERT INTO ${event.table_name} (${columnsToInsert.join(", ")})
			VALUES (${columnsToInsert.map(() => "?").join(", ")})`,
			valuesToInsert,
		);
		const changes = db.query("SELECT changes() as count").get() as Record<string, number>;
		return { applied: changes.count > 0 };
	}

	// Row exists - apply LWW: only update if incoming modified_at > existing modified_at
	if (rowData.modified_at !== undefined && rowData.modified_at !== null) {
		const existingModifiedAt = existing.modified_at;

		// Only proceed if incoming is newer
		if (existingModifiedAt && rowData.modified_at <= existingModifiedAt) {
			return { applied: false };
		}
	}

	// Update only columns that are in both the event and the schema (except id)
	const columnsToUpdate = Object.keys(rowData).filter(
		(col) => schemaColumns.includes(col) && col !== "id",
	);

	if (columnsToUpdate.length === 0) {
		return { applied: false };
	}

	const updateSetClauses = columnsToUpdate.map((col) => `${col} = ?`);
	const valuesToUpdate = columnsToUpdate.map((col) => rowData[col]);
	valuesToUpdate.push(rowData.id);

	db.run(
		`UPDATE ${event.table_name} SET ${updateSetClauses.join(", ")} WHERE id = ?`,
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

export function replayEvents(
	db: Database,
	events: ChangeLogEntry[],
): { applied: number; skipped: number } {
	let applied = 0;
	let skipped = 0;

	for (const event of events) {
		const result = applyEvent(db, event);

		if (result.applied) {
			applied++;
			// Create a change_log entry preserving the original site_id
			createChangeLogEntry(
				db,
				event.table_name,
				event.row_id,
				event.site_id,
				JSON.parse(event.row_data),
			);
		} else {
			skipped++;
		}
	}

	return { applied, skipped };
}
