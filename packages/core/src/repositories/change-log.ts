import type { Database } from "bun:sqlite";
import { getAll, getOne, queryBuilder } from "../query-builder";

/** Single-table reads for the local, unsynced `change_log` table. */
export function getChangeLogHorizon(db: Database): string | null {
	const row = getOne(
		db,
		queryBuilder
			.selectFrom("change_log")
			.select((eb) => eb.fn.min<string | null>("timestamp").as("horizon")),
	);
	return row?.horizon ?? null;
}

export function countChangeLogEntries(db: Database): number {
	const row = getOne(
		db,
		queryBuilder.selectFrom("change_log").select((eb) => eb.fn.countAll<number>().as("count")),
	);
	return row?.count ?? 0;
}

export function getChangeLogHlcAtOffset(db: Database, offset: number): string | null {
	const row = getOne(
		db,
		queryBuilder
			.selectFrom("change_log")
			.select("hlc")
			.orderBy("hlc", "desc")
			.limit(1)
			.offset(offset),
	);
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
	return getAll(
		db,
		queryBuilder
			.selectFrom("change_log")
			.select(["table_name", "row_id"])
			.distinct()
			.where("timestamp", ">", timestamp)
			.orderBy("table_name")
			.orderBy("row_id"),
	);
}

export function findLatestChangeLogRowAtOrBefore(
	db: Database,
	tableName: string,
	rowId: string,
	timestamp: string,
): ChangeLogRestoreRow | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("change_log")
			.select(["table_name", "row_id", "timestamp", "row_data"])
			.where("table_name", "=", tableName)
			.where("row_id", "=", rowId)
			.where("timestamp", "<=", timestamp)
			.orderBy("hlc", "desc")
			.limit(1),
	);
}

/** The caller picks the row type `T`, so the builder's inferred row is widened to it. */
export function findChangeLogEntryByHlc<T>(db: Database, hlc: string): T | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("change_log")
			.select(["hlc", "table_name", "row_id", "site_id", "timestamp", "row_data"])
			.where("hlc", "=", hlc),
	) as T | null;
}
