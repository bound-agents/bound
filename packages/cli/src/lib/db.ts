import { Database } from "bun:sqlite";
import { resolve } from "node:path";

export function openBoundDB(configDir?: string): Database {
	const dir = configDir || "data";
	const db = new Database(resolve(dir, "bound.db"));
	// Ensure host_meta exists — boundctl opens the DB without applySchema,
	// so this table may be missing if the main process hasn't run yet.
	db.exec(`
		CREATE TABLE IF NOT EXISTS host_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`);
	return db;
}
