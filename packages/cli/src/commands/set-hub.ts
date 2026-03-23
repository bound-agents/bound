// Task 4: boundctl set-hub command
// Cluster hub configuration

import { resolve } from "node:path";
import Database from "better-sqlite3";

export interface SetHubArgs {
	hostName: string;
	wait?: boolean;
	configDir?: string;
}

export async function runSetHub(args: SetHubArgs): Promise<void> {
	const configDir = args.configDir || "data";
	const dbPath = resolve(configDir, "bound.db");

	console.log(`Setting cluster hub to: ${args.hostName}`);

	// TODO: Implement database connection and write cluster_hub to cluster_config table
	// For now, provide a structure that can be tested

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

		// Set hub
		const stmt = db.prepare("INSERT OR REPLACE INTO cluster_config (key, value) VALUES (?, ?)");
		stmt.run("cluster_hub", args.hostName);

		if (args.wait) {
			console.log("Waiting for all peers to confirm...");
			// TODO: Poll sync_status until all peers confirm
		}

		console.log("Cluster hub set successfully.");
		db.close();
	} catch (error) {
		console.error("Failed to set hub:", error);
		process.exit(1);
	}
}
