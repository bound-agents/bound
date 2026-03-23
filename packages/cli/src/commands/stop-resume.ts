// Task 4: boundctl stop/resume commands
// Emergency stop and resume operations

import { resolve } from "node:path";
import Database from "better-sqlite3";

export interface StopResumeArgs {
	configDir?: string;
}

export async function runStop(args: StopResumeArgs): Promise<void> {
	const configDir = args.configDir || "data";
	const dbPath = resolve(configDir, "bound.db");

	console.log("Setting emergency stop flag...");

	try {
		// Open database
		const db = new Database(dbPath);

		// Ensure cluster_config table exists
		db.exec(`
			CREATE TABLE IF NOT EXISTS cluster_config (
				key TEXT PRIMARY KEY,
				value TEXT
			)
		`);

		// Set emergency stop with timestamp
		const timestamp = new Date().toISOString();
		const stmt = db.prepare("INSERT OR REPLACE INTO cluster_config (key, value) VALUES (?, ?)");
		stmt.run("emergency_stop", timestamp);

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
		// Open database
		const db = new Database(dbPath);

		// Ensure cluster_config table exists
		db.exec(`
			CREATE TABLE IF NOT EXISTS cluster_config (
				key TEXT PRIMARY KEY,
				value TEXT
			)
		`);

		// Delete emergency stop
		const stmt = db.prepare("DELETE FROM cluster_config WHERE key = ?");
		stmt.run("emergency_stop");

		console.log("Emergency stop cleared. Normal operations resume.");
		db.close();
	} catch (error) {
		console.error("Failed to resume:", error);
		process.exit(1);
	}
}
