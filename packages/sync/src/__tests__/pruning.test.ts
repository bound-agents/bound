import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HLC_ZERO } from "@bound/shared";
import { determinePruningMode, pruneChangeLog } from "../pruning.js";

describe("pruning", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");

		db.run(`
			CREATE TABLE change_log (
				hlc TEXT PRIMARY KEY,
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
				last_received TEXT NOT NULL DEFAULT '${HLC_ZERO}',
				last_sent TEXT NOT NULL DEFAULT '${HLC_ZERO}',
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
				"2026-04-01T00:00:00.000Z_0005_testsite",
			);

			const mode = determinePruningMode(db);
			expect(mode).toBe("multi-host");
		});
	});

	describe("pruneChangeLog", () => {
		it("retains all events in single-host mode for future sync enablement", () => {
			// Insert test events
			for (let i = 1; i <= 10; i++) {
				const counter = i.toString(16).padStart(4, "0");
				const hlc = `2026-03-22T10:00:00.000Z_${counter}_site-a`;
				db.query(
					"INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?, ?)",
				).run(hlc, "semantic_memory", `row-${i}`, "site-a", "2026-03-22T10:00:00Z", "{}");
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
				const counter = i.toString(16).padStart(4, "0");
				const hlc = `2026-03-22T10:00:00.000Z_${counter}_site-a`;
				db.query(
					"INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?, ?)",
				).run(hlc, "semantic_memory", `row-${i}`, "site-a", "2026-03-22T10:00:00Z", "{}");
			}

			// Set up peer cursors showing confirmation through HLC 5
			db.query("INSERT INTO sync_state (peer_site_id, last_received) VALUES (?, ?)").run(
				"peer-1",
				"2026-03-22T10:00:00.000Z_0005_site-a",
			);
			db.query("INSERT INTO sync_state (peer_site_id, last_received) VALUES (?, ?)").run(
				"peer-2",
				"2026-03-22T10:00:00.000Z_000a_site-a",
			);

			// Min confirmed HLC is 0005 (minimum of 0005 and 000a)
			const result = pruneChangeLog(db, "multi-host");

			// Should delete events 1-5
			expect(result.deleted).toBe(5);

			// Verify events 1-5 are deleted and 6-10 remain
			const remaining = db.query("SELECT COUNT(*) as count FROM change_log").get() as {
				count: number;
			};
			expect(remaining.count).toBe(5);

			const remainingHlcs = db.query("SELECT hlc FROM change_log ORDER BY hlc").all() as Array<{
				hlc: string;
			}>;
			expect(remainingHlcs.map((r) => r.hlc)).toEqual([
				"2026-03-22T10:00:00.000Z_0006_site-a",
				"2026-03-22T10:00:00.000Z_0007_site-a",
				"2026-03-22T10:00:00.000Z_0008_site-a",
				"2026-03-22T10:00:00.000Z_0009_site-a",
				"2026-03-22T10:00:00.000Z_000a_site-a",
			]);
		});

		it("returns 0 deleted when no events to prune in multi-host", () => {
			// Set up peer cursors at HLC_ZERO
			db.query("INSERT INTO sync_state (peer_site_id, last_received) VALUES (?, ?)").run(
				"peer-1",
				HLC_ZERO,
			);

			const result = pruneChangeLog(db, "multi-host");
			expect(result.deleted).toBe(0);
		});

		it("preserves new events after pruning", () => {
			// Insert initial events
			for (let i = 1; i <= 5; i++) {
				const counter = i.toString(16).padStart(4, "0");
				const hlc = `2026-03-22T10:00:00.000Z_${counter}_site-a`;
				db.query(
					"INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?, ?)",
				).run(hlc, "semantic_memory", `row-${i}`, "site-a", "2026-03-22T10:00:00Z", "{}");
			}

			// Set up peer confirming through HLC 3
			db.query("INSERT INTO sync_state (peer_site_id, last_received) VALUES (?, ?)").run(
				"peer-1",
				"2026-03-22T10:00:00.000Z_0003_site-a",
			);

			pruneChangeLog(db, "multi-host");

			// Add new events after pruning
			for (let i = 6; i <= 8; i++) {
				const counter = i.toString(16).padStart(4, "0");
				const hlc = `2026-03-22T11:00:00.000Z_${counter}_site-a`;
				db.query(
					"INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?, ?)",
				).run(hlc, "semantic_memory", `row-${i}`, "site-a", "2026-03-22T11:00:00Z", "{}");
			}

			// Verify we have the expected events
			const hlcs = db.query("SELECT hlc FROM change_log ORDER BY hlc").all() as Array<{
				hlc: string;
			}>;
			expect(hlcs.length).toBeGreaterThanOrEqual(5);

			// Events 4, 5 should remain from original set, plus new events 6, 7, 8
			const allHlcs = hlcs.map((h) => h.hlc);
			expect(allHlcs).toContain("2026-03-22T10:00:00.000Z_0004_site-a");
			expect(allHlcs).toContain("2026-03-22T10:00:00.000Z_0005_site-a");
			expect(allHlcs).toContain("2026-03-22T11:00:00.000Z_0006_site-a");
			expect(allHlcs).toContain("2026-03-22T11:00:00.000Z_0007_site-a");
			expect(allHlcs).toContain("2026-03-22T11:00:00.000Z_0008_site-a");
		});
	});
});
