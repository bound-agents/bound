import { openBoundDB } from "../lib/db";

import { resolve } from "node:path";
import { getSiteId } from "@bound/core";
const APPEND_ONLY_TABLES = new Set(["messages"]);
export interface RestoreArgs {
	before: string;
	preview?: boolean;
	tables?: string[];
	configDir?: string;
}
interface ChangeLogRow {
	table_name: string;
	row_id: string;
	timestamp: string;
	row_data: string;
}
interface AffectedRow {
	table_name: string;
	row_id: string;
}
export async function runRestore(args: RestoreArgs): Promise<void> {
	const configDir = args.configDir || "data";
	const dbPath = resolve(configDir, "bound.db");
	console.log(`Point-in-time recovery before: ${args.before}`);
	if (args.preview) {
		console.log("PREVIEW MODE - No changes will be made\n");
	}
	try {
		const db = openBoundDB(args.configDir);
		const safeTimestamp = new Date(args.before);
		if (Number.isNaN(safeTimestamp.getTime())) {
			console.error("Invalid timestamp format. Use ISO 8601 (e.g., 2024-01-01T12:00:00Z)");
			process.exit(1);
		}
		const safeIso = safeTimestamp.toISOString();
		console.log(`Restoring to state before: ${safeIso}\n`);
		// Step 1: Find all unique (table_name, row_id) pairs that have ANY
		// change_log entry AFTER the safe timestamp.
		const affectedRows = db
			.query(
				`SELECT DISTINCT table_name, row_id
				FROM change_log
				WHERE timestamp > ?
				ORDER BY table_name, row_id`,
			)
			.all(safeIso) as AffectedRow[];
		// Filter by --tables if provided, and skip append-only tables
		const tableFilter = args.tables && args.tables.length > 0 ? new Set(args.tables) : null;
		const candidates = affectedRows.filter((r) => {
			if (APPEND_ONLY_TABLES.has(r.table_name)) {
				return false;
			}
			if (tableFilter && !tableFilter.has(r.table_name)) {
				return false;
			}
			return true;
		});
		if (candidates.length === 0) {
			console.log("No restorable rows affected after the given timestamp.");
			db.close();
			return;
		}
		console.log(`Found ${candidates.length} affected row(s) across tables.\n`);
		// Read the site_id from host_meta for change_log entries
		const siteId = getSiteId(db);
		if (siteId === "unknown") {
			console.log("Warning: unable to read site_id, using fallback.");
		}
		let restoredCount = 0;
		let tombstonedCount = 0;
		const processRows = () => {
			for (const { table_name, row_id } of candidates) {
				// Step 2a: Find the latest change_log entry at or before the safe timestamp
				const priorEntry = db
					.query(
						`SELECT table_name, row_id, timestamp, row_data
						FROM change_log
						WHERE table_name = ? AND row_id = ? AND timestamp <= ?
						ORDER BY seq DESC
						LIMIT 1`,
					)
					.get(table_name, row_id, safeIso) as ChangeLogRow | null;
				if (priorEntry) {
					// Row existed before safe timestamp — restore to that state
					const rowData = JSON.parse(priorEntry.row_data) as Record<string, unknown>;
					if (args.preview) {
						console.log(`  RESTORE ${table_name}.${row_id} -> snapshot at ${priorEntry.timestamp}`);
					} else {
						const columns = Object.keys(rowData);
						const placeholders = columns.map(() => "?").join(", ");
						const updateClause = columns
							.filter((c) => c !== "id")
							.map((c) => `${c} = excluded.${c}`)
							.join(", ");
						const values = columns.map((c) => {
							const v = rowData[c];
							return v === null || v === undefined ? null : v;
						});
						db.query(
							`INSERT INTO ${table_name} (${columns.join(", ")})
							VALUES (${placeholders})
							ON CONFLICT(id) DO UPDATE SET ${updateClause}`,
						).run(...(values as Array<string | number | null>));
						// Write change_log entry for outbox compliance
						const now = new Date().toISOString();
						db.query(
							`INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
							VALUES (?, ?, ?, ?, ?)`,
						).run(table_name, row_id, siteId, now, JSON.stringify(rowData));
					}
					restoredCount++;
				} else {
					// Row was created after the safe timestamp — tombstone it
					if (args.preview) {
						console.log(`  TOMBSTONE ${table_name}.${row_id} (created after safe timestamp)`);
					} else {
						const now = new Date().toISOString();
						db.query(`UPDATE ${table_name} SET deleted = 1, modified_at = ? WHERE id = ?`).run(
							now,
							row_id,
						);
						// Fetch updated row for change_log snapshot
						const deletedRow = db
							.query(`SELECT * FROM ${table_name} WHERE id = ?`)
							.get(row_id) as Record<string, unknown> | null;
						if (deletedRow) {
							db.query(
								`INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
								VALUES (?, ?, ?, ?, ?)`,
							).run(table_name, row_id, siteId, now, JSON.stringify(deletedRow));
						}
					}
					tombstonedCount++;
				}
			}
		};
		if (args.preview) {
			processRows();
			console.log(
				`\nPreview summary: ${restoredCount} would restore, ${tombstonedCount} would tombstone.`,
			);
			console.log("Run without --preview to execute.");
		} else {
			db.exec("BEGIN IMMEDIATE");
			try {
				processRows();
				db.exec("COMMIT");
			} catch (txError) {
				db.exec("ROLLBACK");
				throw txError;
			}
			console.log(`Restore completed: ${restoredCount} restored, ${tombstonedCount} tombstoned.`);
		}
		db.close();
	} catch (error) {
		console.error("Restore failed:", error);
		process.exit(1);
	}
}
