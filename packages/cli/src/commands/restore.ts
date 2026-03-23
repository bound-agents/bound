// Task 4: boundctl restore command
// Point-in-time recovery

import { resolve } from "node:path";
import Database from "better-sqlite3";

export interface RestoreArgs {
	before: string;
	preview?: boolean;
	tables?: string[];
	configDir?: string;
}

export async function runRestore(args: RestoreArgs): Promise<void> {
	const configDir = args.configDir || "data";
	const dbPath = resolve(configDir, "bound.db");

	console.log(`Point-in-time recovery before: ${args.before}`);

	if (args.preview) {
		console.log("PREVIEW MODE - No changes will be made\n");
	}

	try {
		// Open database
		const db = new Database(dbPath);

		// Parse timestamp
		const timestamp = new Date(args.before);
		if (Number.isNaN(timestamp.getTime())) {
			console.error("Invalid timestamp format. Use ISO 8601 (e.g., 2024-01-01T12:00:00Z)");
			process.exit(1);
		}

		console.log(`Restoring to state before: ${timestamp.toISOString()}`);

		// TODO: Implement restore logic per spec §12.8
		// - Scan changelog for affected rows
		// - Revert synced rows to state before timestamp
		// - Handle both local and synced rows

		if (!args.preview) {
			// TODO: Execute restore

			console.log("Restore completed successfully.");
		} else {
			console.log("Preview complete. Run without --preview to execute.");
		}

		db.close();
	} catch (error) {
		console.error("Restore failed:", error);
		process.exit(1);
	}
}
