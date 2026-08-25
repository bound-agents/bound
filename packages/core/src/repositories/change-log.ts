import type { Database } from "bun:sqlite";

/** Single-table reads for the local, unsynced `change_log` table. */
export function getChangeLogHorizon(db: Database): string | null {
	const row = db.query("SELECT MIN(timestamp) AS horizon FROM change_log").get() as {
		horizon: string | null;
	} | null;
	return row?.horizon ?? null;
}

export function countChangeLogEntries(db: Database): number {
	const row = db.query("SELECT COUNT(*) AS count FROM change_log").get() as {
		count: number;
	} | null;
	return row?.count ?? 0;
}

export function getChangeLogHlcAtOffset(db: Database, offset: number): string | null {
	const row = db
		.query("SELECT hlc FROM change_log ORDER BY hlc DESC LIMIT 1 OFFSET ?")
		.get(offset) as { hlc: string } | null;
	return row?.hlc ?? null;
}

export interface ChangeLogRestoreRow {
	table_name: string;
	row_id: string;
	timestamp: string;
	row_data: string | null;
}

export function listChangeLogRowsAffectedAfter(
	db: Database,
	timestamp: string,
): Array<Pick<ChangeLogRestoreRow, "table_name" | "row_id">> {
	return db
		.query(
			`SELECT DISTINCT table_name, row_id
		 FROM change_log
		 WHERE timestamp > ?
		 ORDER BY table_name, row_id`,
		)
		.all(timestamp) as Array<Pick<ChangeLogRestoreRow, "table_name" | "row_id">>;
}

export function findLatestChangeLogRowAtOrBefore(
	db: Database,
	tableName: string,
	rowId: string,
	timestamp: string,
): ChangeLogRestoreRow | null {
	return db
		.query(
			`SELECT table_name, row_id, timestamp, row_data
		 FROM change_log
		 WHERE table_name = ? AND row_id = ? AND timestamp <= ?
		 ORDER BY hlc DESC
		 LIMIT 1`,
		)
		.get(tableName, rowId, timestamp) as ChangeLogRestoreRow | null;
}

export function findChangeLogEntryByHlc<T>(db: Database, hlc: string): T | null {
	return db
		.query(
			`SELECT hlc, table_name, row_id, site_id, timestamp, row_data
		 FROM change_log WHERE hlc = ?`,
		)
		.get(hlc) as T | null;
}
