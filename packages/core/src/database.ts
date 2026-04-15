import { Database } from "bun:sqlite";

export function createDatabase(path: string): Database {
	const db = new Database(path);
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	db.run("PRAGMA busy_timeout = 5000");

	// Enable incremental auto-vacuum (one-time migration).
	// Changing auto_vacuum from NONE requires a full VACUUM to restructure
	// the file. Subsequent startups see auto_vacuum=2 and skip this.
	const autoVacuum = db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number } | null;
	if (!autoVacuum || autoVacuum.auto_vacuum === 0) {
		db.run("PRAGMA auto_vacuum = INCREMENTAL");
		db.run("VACUUM");
	}

	return db;
}

export function getSiteId(db: Database): string {
	const row = db.query("SELECT value FROM host_meta WHERE key = 'site_id'").get() as {
		value: string;
	} | null;
	return row?.value ?? "unknown";
}
