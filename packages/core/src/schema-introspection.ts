import type { Database } from "bun:sqlite";
import type { SyncedTableName } from "@bound/shared";
import { validateColumnName } from "./change-log";

export interface ColumnInfo {
	name: string;
	type: string;
	notnull: boolean;
	pk: boolean;
}

export interface TableSchemaInfo {
	table: SyncedTableName;
	columns: ColumnInfo[];
}

interface PragmaTableInfoRow {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

const SYNCED_TABLE_NAMES: readonly SyncedTableName[] = [
	"users",
	"threads",
	"messages",
	"semantic_memory",
	"tasks",
	"files",
	"hosts",
	"overlay_index",
	"cluster_config",
	"advisories",
	"skills",
	"memory_edges",
	"turns",
];

/**
 * Returns column metadata for every synced table, ordered by declaration order
 * within each table. Reads via `PRAGMA table_info` so the result always
 * reflects the live schema (including idempotent ALTER TABLE additions in
 * metrics-schema.ts). Callers typically use this to render schema hints into
 * the agent's system prompt.
 *
 * Table names come from the compile-time `SyncedTableName` union and are
 * additionally filtered through `validateColumnName` as a defensive check
 * against future refactors that might introduce dynamic names.
 */
export function getSyncedTableSchemas(db: Database): TableSchemaInfo[] {
	const out: TableSchemaInfo[] = [];
	for (const table of SYNCED_TABLE_NAMES) {
		// Defense-in-depth: validate the identifier even though it comes from
		// a closed union, so a future refactor can't silently introduce an
		// unsafe name.
		validateColumnName(table);
		const rows = db.query(`PRAGMA table_info(${table})`).all() as PragmaTableInfoRow[];
		const columns: ColumnInfo[] = rows
			.sort((a, b) => a.cid - b.cid)
			.map((r) => ({
				name: r.name,
				type: r.type,
				notnull: r.notnull !== 0,
				pk: r.pk !== 0,
			}));
		out.push({ table, columns });
	}
	return out;
}
