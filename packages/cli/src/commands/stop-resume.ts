import { dirname, join, resolve } from "node:path";
import { createChangeLogEntry, getSiteId } from "@bound/core";
import { openBoundDB } from "../lib/db";
export interface StopResumeArgs {
	configDir?: string;
}

/**
 * Resolve the data directory from a config directory argument, matching the
 * layout produced by `bound init` (sibling `config/` and `data/` directories).
 */
function resolveDataDir(configDir: string | undefined): string {
	return join(dirname(resolve(configDir || "config")), "data");
}

export async function runStop(args: StopResumeArgs): Promise<void> {
	const dataDir = resolveDataDir(args.configDir);
	console.log("Setting emergency stop flag...");
	const db = openBoundDB(dataDir);
	try {
		// Get site_id from host_meta for change-log
		const siteId = getSiteId(db);
		if (siteId === "unknown") {
			throw new Error("Failed to read site_id from database. Database may not be initialized.");
		}
		const now = new Date().toISOString();
		// Check if emergency_stop already exists
		const existing = db.query("SELECT key FROM cluster_config WHERE key = ?").get("emergency_stop");
		// cluster_config uses 'key' as primary key, not 'id'. Use manual transaction + change_log.
		const txFn = db.transaction(() => {
			if (existing) {
				db.query(
					"UPDATE cluster_config SET value = ?, modified_at = ? WHERE key = ?", // outbox-exempt: createChangeLogEntry called below
				).run(now, now, "emergency_stop");
			} else {
				db.query(
					"INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)", // outbox-exempt: createChangeLogEntry called below
				).run("emergency_stop", now, now);
			}
			// Write change_log entry (row_id is the key field for cluster_config)
			const rowData = { key: "emergency_stop", value: now, modified_at: now };
			createChangeLogEntry(db, "cluster_config", "emergency_stop", siteId, rowData);
		});
		txFn();
		console.log("Emergency stop set. All hosts will halt autonomous operations on next sync.");
	} finally {
		db.close();
	}
}
export async function runResume(args: StopResumeArgs): Promise<void> {
	const dataDir = resolveDataDir(args.configDir);
	console.log("Clearing emergency stop flag...");
	const db = openBoundDB(dataDir);
	try {
		const siteId = getSiteId(db);
		if (siteId === "unknown") {
			throw new Error("Failed to read site_id from database. Database may not be initialized.");
		}
		const now = new Date().toISOString();
		// cluster_config doesn't have a deleted column, so we just delete the row directly
		// But we need to write a change_log entry to sync the deletion
		const rowData = { key: "emergency_stop", value: "", modified_at: now };
		// Use a transaction to delete + log
		const txFn = db.transaction(() => {
			db.query(
				"DELETE FROM cluster_config WHERE key = ?", // outbox-exempt: createChangeLogEntry called below
			).run("emergency_stop");
			// Write change_log entry with empty value to signal deletion
			createChangeLogEntry(db, "cluster_config", "emergency_stop", siteId, rowData);
		});
		txFn();
		console.log("Emergency stop cleared. Normal operations resume.");
	} finally {
		db.close();
	}
}
