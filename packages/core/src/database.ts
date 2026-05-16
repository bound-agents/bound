import { Database } from "bun:sqlite";

export function createDatabase(path: string): Database {
	const db = new Database(path);
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	db.run("PRAGMA busy_timeout = 5000");

	// Performance tuning. Without these, sample-profiling on a live daemon
	// shows ~91% of awake main-thread time in sqlite3_step → readDbPage → pread,
	// because the default 2000-page (~8 MiB) cache thrashes against multi-table
	// hot scans (relay_inbox poll, scheduler tick, change_log replay).
	//
	// - synchronous=NORMAL: safe with WAL, drops fsync count meaningfully.
	// - cache_size=-65536: 64 MiB LRU page cache (negative value = KiB).
	// - mmap_size=256 MiB: hot pages served from a kernel-mapped region
	//   instead of pread() syscalls. Biggest single lever on real workloads.
	// - temp_store=MEMORY: keep transient btrees/sorts off disk.
	db.run("PRAGMA synchronous = NORMAL");
	db.run("PRAGMA cache_size = -65536");
	db.run("PRAGMA mmap_size = 268435456");
	db.run("PRAGMA temp_store = MEMORY");

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
