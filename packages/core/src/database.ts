import { Database } from "bun:sqlite";

export function createDatabase(path: string): Database {
	const db = new Database(path);
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	db.run("PRAGMA busy_timeout = 5000");
	return db;
}

export function getSiteId(db: Database): string {
	const row = db.query("SELECT value FROM host_meta WHERE key = 'site_id'").get() as {
		value: string;
	} | null;
	return row?.value ?? "unknown";
}
