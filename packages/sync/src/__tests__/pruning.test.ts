import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertDurableWork } from "@bound/core";
import { HLC_ZERO } from "@bound/shared";
import {
	determinePruningMode,
	drainFreelistOnStartup,
	pruneChangeLog,
	runIncrementalVacuum,
	startPruningLoop,
} from "../pruning.js";

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
				last_confirmed TEXT NOT NULL DEFAULT '${HLC_ZERO}',
				last_sync_at TEXT,
				sync_errors INTEGER NOT NULL DEFAULT 0
			)
		`);

		db.exec(`
			CREATE TABLE durable_work (
				id TEXT PRIMARY KEY, target_site_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
				idempotency_key TEXT NOT NULL,
				claim_state TEXT NOT NULL DEFAULT 'pending' CHECK (claim_state IN ('pending', 'processing', 'transferring', 'consumed', 'dead_letter')),
				claim_token TEXT, claimed_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
				created_at TEXT NOT NULL, expires_at TEXT, dead_lettered_at TEXT, consumed_at TEXT,
				ref_id TEXT, source_site TEXT, received_at TEXT, stream_id TEXT, reclassify_count INTEGER NOT NULL DEFAULT 0
			) STRICT;

			CREATE TABLE relay_cycles (
				id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT NOT NULL, peer_site_id TEXT NOT NULL,
				kind TEXT NOT NULL, delivery_method TEXT NOT NULL, latency_ms INTEGER,
				expired INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
			) STRICT;

			CREATE TABLE dispatch_queue (
				message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
				claimed_by TEXT, event_type TEXT NOT NULL DEFAULT 'user_message', event_payload TEXT,
				created_at TEXT NOT NULL, modified_at TEXT NOT NULL
			) STRICT;
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

		it("incremental_vacuum reclaims freed pages after pruning", () => {
			// Insert enough data to create free pages when deleted
			for (let i = 1; i <= 1000; i++) {
				const counter = i.toString(16).padStart(4, "0");
				const hlc = `2026-03-22T10:00:00.000Z_${counter}_site-a`;
				const largeData = JSON.stringify({ payload: "x".repeat(500) });
				db.query(
					"INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?, ?)",
				).run(hlc, "semantic_memory", `row-${i}`, "site-a", "2026-03-22T10:00:00Z", largeData);
			}

			// Set up peer confirming all events
			db.query("INSERT INTO sync_state (peer_site_id, last_received) VALUES (?, ?)").run(
				"peer-1",
				"2026-03-22T10:00:00.000Z_ffff_site-a",
			);

			// Prune all entries
			const result = pruneChangeLog(db, "multi-host");
			expect(result.deleted).toBe(1000);

			// runIncrementalVacuum should run without error
			// (in-memory DBs don't have freelist pages, but verifies the call is valid)
			expect(() => {
				runIncrementalVacuum(db);
			}).not.toThrow();
		});
	});

	describe("runIncrementalVacuum", () => {
		it("executes without error on a database", () => {
			expect(() => {
				runIncrementalVacuum(db);
			}).not.toThrow();
		});

		it("accepts a custom page count", () => {
			expect(() => {
				runIncrementalVacuum(db, 16384);
			}).not.toThrow();
		});
	});

	describe("drainFreelistOnStartup", () => {
		it("does nothing when freelist is below threshold", () => {
			const logs: string[] = [];
			const logger = { info: (msg: string) => logs.push(msg) } as any;
			drainFreelistOnStartup(db, logger);
			expect(logs.length).toBe(0);
		});

		it("executes without error on a file-backed database", () => {
			// `/tmp` is not a real path on Windows except via Git Bash mapping;
			// use `tmpdir()` for portability.
			const tmpPath = join(tmpdir(), `drain-test-${randomUUID()}.db`);
			const fileDb = new Database(tmpPath);
			fileDb.run("PRAGMA journal_mode = WAL");
			fileDb.run("PRAGMA auto_vacuum = INCREMENTAL");
			fileDb.run("VACUUM");

			fileDb.run("CREATE TABLE test_data (id INTEGER PRIMARY KEY, payload TEXT)");
			// Batch the inserts in a single transaction: 5000 individual statements
			// is 5000 WAL fsyncs, which on a slow Windows CI filesystem blew past the
			// 30s timeout (observed 30909ms). One transaction is one fsync and keeps
			// the same ~5MB churn, so the freelist still exceeds the 1000-page drain
			// threshold and drainFreelistOnStartup's reclaim path is still exercised.
			const insertMany = fileDb.transaction(() => {
				for (let i = 0; i < 5000; i++) {
					fileDb.run("INSERT INTO test_data (payload) VALUES (?)", ["x".repeat(1000)]);
				}
			});
			insertMany();
			fileDb.run("DELETE FROM test_data");

			const logs: string[] = [];
			const logger = { info: (msg: string) => logs.push(msg) } as any;

			expect(() => {
				drainFreelistOnStartup(fileDb, logger);
			}).not.toThrow();

			fileDb.close();
			try {
				require("node:fs").unlinkSync(tmpPath);
				require("node:fs").unlinkSync(`${tmpPath}-wal`);
				require("node:fs").unlinkSync(`${tmpPath}-shm`);
			} catch {}
			// 5MB of data churn + VACUUM on Windows filesystems can exceed the
			// default 5s per-test timeout; allow up to 30s.
		}, 30000);
	});

	describe("startPruningLoop dead-letter retention sweep", () => {
		function seedDeadLetter(id: string, expiresAt: string): void {
			insertDurableWork(db, {
				id,
				target_site_id: "local",
				kind: "dispatch_message",
				payload: JSON.stringify({ id }),
				idempotency_key: `dl-${id}`,
				expires_at: expiresAt,
			});
			db.run(
				"UPDATE durable_work SET claim_state = 'dead_letter', dead_lettered_at = ? WHERE id = ?",
				[new Date().toISOString(), id],
			);
		}

		it("deletes dead-letter rows past their retention deadline and leaves live rows alone", async () => {
			const past = new Date(Date.now() - 60_000).toISOString();
			const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

			seedDeadLetter("dl-expired-1", past);
			seedDeadLetter("dl-expired-2", past);
			seedDeadLetter("dl-live", future);
			insertDurableWork(db, {
				id: "pending-null-ttl",
				target_site_id: "local",
				kind: "dispatch_message",
				payload: JSON.stringify({ id: "pending-null-ttl" }),
				idempotency_key: "pending-null-ttl",
				expires_at: null,
			});

			const handle = startPruningLoop(db, 20);
			try {
				await new Promise((resolve) => setTimeout(resolve, 80));
			} finally {
				handle.stop();
			}

			const survivors = (
				db.query("SELECT id FROM durable_work ORDER BY id").all() as Array<{ id: string }>
			).map((r) => r.id);
			expect(survivors).toEqual(["dl-live", "pending-null-ttl"]);
		});
	});
});
