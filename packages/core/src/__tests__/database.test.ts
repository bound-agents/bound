import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../database.js";

describe("createDatabase", () => {
	let tempDir: string;

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("sets auto_vacuum to INCREMENTAL on new database", () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-test-"));
		const dbPath = join(tempDir, "test.db");
		const db = createDatabase(dbPath);
		const row = db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
		expect(row.auto_vacuum).toBe(2); // 2 = INCREMENTAL
		db.close();
	});

	it("does not re-VACUUM on subsequent opens", () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-test-"));
		const dbPath = join(tempDir, "test.db");

		// First open: migration runs
		const db1 = createDatabase(dbPath);
		const row1 = db1.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
		expect(row1.auto_vacuum).toBe(2);
		db1.close();

		// Second open: auto_vacuum already 2, no VACUUM needed
		const db2 = createDatabase(dbPath);
		const row2 = db2.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
		expect(row2.auto_vacuum).toBe(2);
		db2.close();
	});

	it("preserves WAL journal mode after VACUUM migration", () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-test-"));
		const dbPath = join(tempDir, "test.db");
		const db = createDatabase(dbPath);
		const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
		expect(row.journal_mode).toBe("wal");
		db.close();
	});

	it("applies performance-tuning PRAGMAs (cache_size, mmap_size, synchronous, temp_store)", () => {
		// Regression guard: these PRAGMAs are load-bearing for daemon CPU.
		// Profiling shows ~91% of awake main-thread time hits sqlite3 pread
		// without them. If a future refactor drops one, latency comes back.
		tempDir = mkdtempSync(join(tmpdir(), "bound-test-"));
		const dbPath = join(tempDir, "test.db");
		const db = createDatabase(dbPath);

		// synchronous: 1 = NORMAL
		const sync = db.query("PRAGMA synchronous").get() as { synchronous: number };
		expect(sync.synchronous).toBe(1);

		// cache_size: negative means KiB; we asked for 64 MiB
		const cache = db.query("PRAGMA cache_size").get() as { cache_size: number };
		expect(cache.cache_size).toBe(-65536);

		// mmap_size: 256 MiB. SQLite may report 0 if mmap unavailable on the
		// platform/build, but on Bun's bundled SQLite we expect the request
		// to be honored.
		const mmap = db.query("PRAGMA mmap_size").get() as { mmap_size: number };
		expect(mmap.mmap_size).toBe(268435456);

		// temp_store: 2 = MEMORY
		const temp = db.query("PRAGMA temp_store").get() as { temp_store: number };
		expect(temp.temp_store).toBe(2);

		db.close();
	});

	it("migrates existing database from auto_vacuum=NONE to INCREMENTAL", () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-test-"));
		const dbPath = join(tempDir, "test.db");

		// Create a database without auto_vacuum (simulating pre-migration state)
		const preDb = new Database(dbPath);
		preDb.run("PRAGMA journal_mode = WAL");
		preDb.run("CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT)");
		preDb.run("INSERT INTO test_data VALUES (1, 'hello')");
		const preRow = preDb.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
		expect(preRow.auto_vacuum).toBe(0); // Confirm it starts as NONE
		preDb.close();

		// Now open with createDatabase — should migrate
		const db = createDatabase(dbPath);
		const row = db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
		expect(row.auto_vacuum).toBe(2); // Migrated to INCREMENTAL

		// Data should survive the VACUUM
		const dataRow = db.query("SELECT value FROM test_data WHERE id = 1").get() as {
			value: string;
		} | null;
		expect(dataRow?.value).toBe("hello");
		db.close();
	});
});
