import { openBoundDB } from "../lib/db";

import { getSiteId } from "@bound/core";
// Task 4: boundctl stop/resume commands
// Emergency stop and resume operations
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
export interface StopResumeArgs {
	configDir?: string;
}
export async function runStop(args: StopResumeArgs): Promise<void> {
	const configDir = args.configDir || "data";
	const dbPath = resolve(configDir, "bound.db");
	console.log("Setting emergency stop flag...");
	try {
		// Open database
		const db = openBoundDB(args.configDir);
		// Get site_id from host_meta for change-log
		const siteId = getSiteId(db);
		if (siteId === "unknown") {
			console.error("Failed to read site_id from database. Database may not be initialized.");
			db.close();
			process.exit(1);
		}
		const now = new Date().toISOString();
		// Check if emergency_stop already exists
		const existing = db.query("SELECT key FROM cluster_config WHERE key = ?").get("emergency_stop");
		// cluster_config uses 'key' as primary key, not 'id'. Use manual transaction + change_log.
		const txFn = db.transaction(() => {
			if (existing) {
				db.query("UPDATE cluster_config SET value = ?, modified_at = ? WHERE key = ?").run(
					now,
					now,
					"emergency_stop",
				);
			} else {
				db.query("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)").run(
					"emergency_stop",
					now,
					now,
				);
			}
			// Write change_log entry (row_id is the key field for cluster_config)
			const rowData = { key: "emergency_stop", value: now, modified_at: now };
			db.query(
				`INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
				 VALUES (?, ?, ?, ?, ?)`,
			).run("cluster_config", "emergency_stop", siteId, now, JSON.stringify(rowData));
		});
		txFn();
		console.log("Emergency stop set. All hosts will halt autonomous operations on next sync.");
		db.close();
	} catch (error) {
		console.error("Failed to set emergency stop:", error);
		process.exit(1);
	}
}
export async function runResume(args: StopResumeArgs): Promise<void> {
	const configDir = args.configDir || "data";
	const dbPath = resolve(configDir, "bound.db");
	console.log("Clearing emergency stop flag...");
	try {
		const db = openBoundDB(args.configDir);
		const siteId = getSiteId(db);
		if (siteId === "unknown") {
			console.error("Failed to read site_id from database. Database may not be initialized.");
			db.close();
			process.exit(1);
		}
		const now = new Date().toISOString();
		// cluster_config doesn't have a deleted column, so we just delete the row directly
		// But we need to write a change_log entry to sync the deletion
		const rowData = { key: "emergency_stop", value: "", modified_at: now };
		// Use a transaction to delete + log
		const txFn = db.transaction(() => {
			db.query("DELETE FROM cluster_config WHERE key = ?").run("emergency_stop");
			// Write change_log entry with empty value to signal deletion
			db.query(
				`INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
				 VALUES (?, ?, ?, ?, ?)`,
			).run("cluster_config", "emergency_stop", siteId, now, JSON.stringify(rowData));
		});
		txFn();
		console.log("Emergency stop cleared. Normal operations resume.");
		db.close();
	} catch (error) {
		console.error("Failed to resume:", error);
		process.exit(1);
	}
}
