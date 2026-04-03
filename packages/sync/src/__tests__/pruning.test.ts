import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { determinePruningMode, pruneChangeLog } from "../pruning.js";

describe("pruning", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");

		db.run(`
			CREATE TABLE change_log (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				site_id TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				row_data TEXT NOT NULL
			)
		`);

		db.run(`
			CREATE TABLE sync_state (
				peer_site_id TEXT PRIMARY KEY,
				last_received INTEGER NOT NULL DEFAULT 0,
				last_sent INTEGER NOT NULL DEFAULT 0,
				last_sync_at TEXT,
				sync_errors INTEGER NOT NULL DEFAULT 0
			)
		`);
	});

	afterEach(() => {
		db.close();
	});

	describe("determinePruningMode", () => {
		it("returns single-host when sync_state is empty", () => {
			const mode = determinePruningMode(db);
			expect(mode).toBe("single-host");
		});

		it("returns multi-host when sync_state has entries", () => {
			db.query("INSERT INTO sync_state (peer_site_id, last_received) VALUES (?, ?)").run(
				"peer-1",
				5,
			);

			const mode = determinePruningMode(db);
			expect(mode).toBe("multi-host");
		});
	});

	describe("pruneChangeLog", () => {
		it("retains all events in single-host mode for future sync enablement", () => {
			// Insert test events
			for (let i = 1; i <= 10; i++) {
				db.query(
					"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
				).run("semantic_memory", `row-${i}`, "site-a", "2026-03-22T10:00:00Z", "{}");
			}

			const result = pruneChangeLog(db, "single-host");
			expect(result.deleted).toBe(0);

			// Verify all events are retained
			const count = db.query("SELECT COUNT(*) as count FROM change_log").get() as {
				count: number;
			};
			expect(count.count).toBe(10);
		});

		it("deletes confirmed events in multi-host mode", () => {
			// Insert test events
			for (let i = 1; i <= 10; i++) {
				db.query(
					"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
				).run("semantic_memory", `row-${i}`, "site-a", "2026-03-22T10:00:00Z", "{}");
			}

			// Set up peer cursors showing confirmation through seq 5
			db.query("INSERT INTO sync_state (peer_site_id, last_received) VALUES (?, ?)").run(
				"peer-1",
				5,
			);
			db.query("INSERT INTO sync_state (peer_site_id, last_received) VALUES (?, ?)").run(
				"peer-2",
				10,
			);

			// Min confirmed seq is 5 (minimum of 5 and 10)
			const result = pruneChangeLog(db, "multi-host");

			// Should delete events 1-5
			expect(result.deleted).toBe(5);

			// Verify events 1-5 are deleted and 6-10 remain
			const remaining = db.query("SELECT COUNT(*) as count FROM change_log").get() as {
				count: number;
			};
			expect(remaining.count).toBe(5);

			const remainingSeqs = db.query("SELECT seq FROM change_log ORDER BY seq").all() as Array<{
				seq: number;
			}>;
			expect(remainingSeqs.map((r) => r.seq)).toEqual([6, 7, 8, 9, 10]);
		});

		it("returns 0 deleted when no events to prune in multi-host", () => {
			// Set up peer cursors at seq 0
			db.query("INSERT INTO sync_state (peer_site_id, last_received) VALUES (?, ?)").run(
				"peer-1",
				0,
			);

			const result = pruneChangeLog(db, "multi-host");
			expect(result.deleted).toBe(0);
		});

		it("preserves new events after pruning", () => {
			// Insert initial events
			for (let i = 1; i <= 5; i++) {
				db.query(
					"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
				).run("semantic_memory", `row-${i}`, "site-a", "2026-03-22T10:00:00Z", "{}");
			}

			// Set up peer confirming through seq 3
			db.query("INSERT INTO sync_state (peer_site_id, last_received) VALUES (?, ?)").run(
				"peer-1",
				3,
			);

			pruneChangeLog(db, "multi-host");

			// Add new events after pruning
			for (let i = 6; i <= 8; i++) {
				db.query(
					"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
				).run("semantic_memory", `row-${i}`, "site-a", "2026-03-22T11:00:00Z", "{}");
			}

			// Verify new events have correct seq numbers (6, 7, 8 if AUTOINCREMENT continues)
			const seqs = db.query("SELECT seq FROM change_log ORDER BY seq").all() as Array<{
				seq: number;
			}>;
			expect(seqs.length).toBeGreaterThanOrEqual(5);

			// Events 4, 5 should remain from original set, plus new events 6, 7, 8
			expect(seqs[seqs.length - 1].seq).toBeGreaterThan(5);
		});
	});
});
