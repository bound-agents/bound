import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChangeLogEntry } from "@bound/shared";
import { applyAppendOnlyReducer, applyEvent, applyLWWReducer, replayEvents } from "../reducers.js";

describe("reducers", () => {
	let db: Database;
	let testDbPath: string;

	beforeEach(() => {
		testDbPath = ":memory:";

		db = new Database(testDbPath);
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA foreign_keys = ON");

		// Create schema
		db.run(`
			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				model_id TEXT,
				tool_name TEXT,
				created_at TEXT NOT NULL,
				modified_at TEXT,
				host_origin TEXT NOT NULL
			)
		`);

		db.run(`
			CREATE TABLE semantic_memory (
				id TEXT PRIMARY KEY,
				key TEXT NOT NULL,
				value TEXT NOT NULL,
				source TEXT NOT NULL,
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				last_accessed_at TEXT NOT NULL,
				deleted INTEGER NOT NULL DEFAULT 0
			)
		`);

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
			CREATE TABLE memory_edges (
				id          TEXT PRIMARY KEY,
				source_key  TEXT NOT NULL,
				target_key  TEXT NOT NULL,
				relation    TEXT NOT NULL,
				weight      REAL DEFAULT 1.0,
				created_at  TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				deleted     INTEGER DEFAULT 0
			)
		`);

		db.run(`
			CREATE TABLE hosts (
				site_id      TEXT PRIMARY KEY,
				host_name    TEXT NOT NULL,
				version      TEXT,
				sync_url     TEXT,
				online_at    TEXT,
				modified_at  TEXT NOT NULL,
				deleted      INTEGER DEFAULT 0
			)
		`);
	});

	afterEach(() => {
		db.close();
	});

	describe("applyAppendOnlyReducer", () => {
		it("inserts new message", () => {
			const event: ChangeLogEntry = {
				hlc: "2026-03-22T10:00:00.000Z_0001_test",
				table_name: "messages",
				row_id: "msg-1",
				site_id: "site-a",
				timestamp: "2026-03-22T10:00:00Z",
				row_data: JSON.stringify({
					id: "msg-1",
					thread_id: "thread-1",
					role: "user",
					content: "hello",
					created_at: "2026-03-22T10:00:00Z",
					host_origin: "laptop",
				}),
			};

			const result = applyAppendOnlyReducer(db, event);

			expect(result.applied).toBe(true);
			const row = db.query("SELECT * FROM messages WHERE id = ?").get("msg-1") as
				| Record<string, unknown>
				| undefined;
			expect(row).toBeDefined();
			expect(row?.content).toBe("hello");
		});

		it("skips duplicate message (ON CONFLICT DO NOTHING)", () => {
			const event: ChangeLogEntry = {
				hlc: "2026-03-22T10:00:00.000Z_0001_test",
				table_name: "messages",
				row_id: "msg-1",
				site_id: "site-a",
				timestamp: "2026-03-22T10:00:00Z",
				row_data: JSON.stringify({
					id: "msg-1",
					thread_id: "thread-1",
					role: "user",
					content: "hello",
					created_at: "2026-03-22T10:00:00Z",
					host_origin: "laptop",
				}),
			};

			applyAppendOnlyReducer(db, event);
			const result = applyAppendOnlyReducer(db, event);

			expect(result.applied).toBe(false);
			const rows = db.query("SELECT COUNT(*) as count FROM messages").get() as Record<
				string,
				number
			>;
			expect(rows.count).toBe(1);
		});

		it("applies redaction event (hybrid reducer with modified_at)", () => {
			// Insert original message
			db.run(
				`INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
				["msg-1", "thread-1", "user", "sensitive content", "2026-03-22T10:00:00Z", null, "laptop"],
			);

			// Redaction event (same id, modified_at is later)
			const redactionEvent: ChangeLogEntry = {
				hlc: "2026-03-22T10:01:00.000Z_0002_test",
				table_name: "messages",
				row_id: "msg-1",
				site_id: "site-a",
				timestamp: "2026-03-22T10:01:00Z",
				row_data: JSON.stringify({
					id: "msg-1",
					content: "[redacted]",
					modified_at: "2026-03-22T10:01:00Z",
				}),
			};

			const result = applyAppendOnlyReducer(db, redactionEvent);

			expect(result.applied).toBe(true);
			const row = db.query("SELECT * FROM messages WHERE id = ?").get("msg-1") as Record<
				string,
				unknown
			>;
			expect(row.content).toBe("[redacted]");
			expect(row.modified_at).toBe("2026-03-22T10:01:00Z");
		});
	});

	describe("applyLWWReducer", () => {
		it("inserts new row", () => {
			const event: ChangeLogEntry = {
				hlc: "2026-03-22T10:00:00.000Z_0001_sitea",
				table_name: "semantic_memory",
				row_id: "mem-1",
				site_id: "site-a",
				timestamp: "2026-03-22T10:00:00Z",
				row_data: JSON.stringify({
					id: "mem-1",
					key: "test_key",
					value: "value-a",
					source: "training",
					created_at: "2026-03-22T10:00:00Z",
					modified_at: "2026-03-22T10:00:00Z",
					last_accessed_at: "2026-03-22T10:00:00Z",
				}),
			};

			const result = applyLWWReducer(db, event);

			expect(result.applied).toBe(true);
			const row = db.query("SELECT * FROM semantic_memory WHERE id = ?").get("mem-1") as
				| Record<string, unknown>
				| undefined;
			expect(row).toBeDefined();
			expect(row?.value).toBe("value-a");
		});

		it("applies LWW: later timestamp wins", () => {
			// Insert initial row with earlier timestamp
			db.run(
				`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					"mem-1",
					"test_key",
					"value-a",
					"training",
					"2026-03-22T10:00:00Z",
					"2026-03-22T10:00:00Z",
					"2026-03-22T10:00:00Z",
				],
			);

			// Incoming event with later timestamp
			const event: ChangeLogEntry = {
				hlc: "2026-03-22T10:01:00.000Z_0002_test",
				table_name: "semantic_memory",
				row_id: "mem-1",
				site_id: "site-b",
				timestamp: "2026-03-22T10:05:00Z",
				row_data: JSON.stringify({
					id: "mem-1",
					key: "test_key",
					value: "value-b",
					modified_at: "2026-03-22T10:05:00Z",
				}),
			};

			const result = applyLWWReducer(db, event);

			expect(result.applied).toBe(true);
			const row = db.query("SELECT * FROM semantic_memory WHERE id = ?").get("mem-1") as Record<
				string,
				unknown
			>;
			expect(row.value).toBe("value-b");
		});

		it("ignores extra columns not in schema", () => {
			const event: ChangeLogEntry = {
				hlc: "2026-03-22T10:00:00.000Z_0001_sitea",
				table_name: "semantic_memory",
				row_id: "mem-1",
				site_id: "site-a",
				timestamp: "2026-03-22T10:00:00Z",
				row_data: JSON.stringify({
					id: "mem-1",
					key: "test_key",
					value: "test_value",
					source: "training",
					created_at: "2026-03-22T10:00:00Z",
					modified_at: "2026-03-22T10:00:00Z",
					last_accessed_at: "2026-03-22T10:00:00Z",
					extra_column: "should be ignored",
				}),
			};

			const result = applyLWWReducer(db, event);

			expect(result.applied).toBe(true);
			const row = db.query("SELECT * FROM semantic_memory WHERE id = ?").get("mem-1") as Record<
				string,
				unknown
			>;
			expect(row.value).toBe("test_value");
			// Verify extra_column was not added
			expect(Object.hasOwn(row, "extra_column")).toBe(false);
		});

		it("preserves local columns not in incoming event", () => {
			db.run(
				`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					"mem-1",
					"test_key",
					"original_value",
					"original_source",
					"2026-03-22T10:00:00Z",
					"2026-03-22T10:00:00Z",
					"2026-03-22T10:01:00Z",
				],
			);

			// Incoming event updates only value, not source
			const event: ChangeLogEntry = {
				hlc: "2026-03-22T10:01:00.000Z_0002_test",
				table_name: "semantic_memory",
				row_id: "mem-1",
				site_id: "site-b",
				timestamp: "2026-03-22T10:05:00Z",
				row_data: JSON.stringify({
					id: "mem-1",
					value: "new_value",
					modified_at: "2026-03-22T10:05:00Z",
				}),
			};

			const result = applyLWWReducer(db, event);

			expect(result.applied).toBe(true);
			const row = db.query("SELECT * FROM semantic_memory WHERE id = ?").get("mem-1") as Record<
				string,
				unknown
			>;
			expect(row.value).toBe("new_value");
			expect(row.source).toBe("original_source");
		});

		it("inserts new memory_edges row via LWW reducer", () => {
			const event: ChangeLogEntry = {
				hlc: "2026-03-22T10:00:00.000Z_0001_test",
				table_name: "memory_edges",
				row_id: "edge-1",
				site_id: "site-a",
				timestamp: "2026-03-22T10:00:00Z",
				row_data: JSON.stringify({
					id: "edge-1",
					source_key: "memory_a",
					target_key: "memory_b",
					relation: "depends_on",
					weight: 1.0,
					created_at: "2026-03-22T10:00:00Z",
					modified_at: "2026-03-22T10:00:00Z",
				}),
			};

			const result = applyLWWReducer(db, event);

			expect(result.applied).toBe(true);
			const row = db.query("SELECT * FROM memory_edges WHERE id = ?").get("edge-1") as Record<
				string,
				unknown
			>;
			expect(row).toBeDefined();
			expect(row?.source_key).toBe("memory_a");
			expect(row?.target_key).toBe("memory_b");
			expect(row?.relation).toBe("depends_on");
			expect(row?.weight).toBe(1.0);
		});

		it("applies LWW to memory_edges: later timestamp wins", () => {
			// Insert initial edge with earlier timestamp
			db.run(
				`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					"edge-1",
					"memory_a",
					"memory_b",
					"depends_on",
					1.0,
					"2026-03-22T10:00:00Z",
					"2026-03-22T10:00:00Z",
				],
			);

			// Incoming event with later timestamp and different weight
			const event: ChangeLogEntry = {
				hlc: "2026-03-22T10:01:00.000Z_0002_test",
				table_name: "memory_edges",
				row_id: "edge-1",
				site_id: "site-b",
				timestamp: "2026-03-22T10:05:00Z",
				row_data: JSON.stringify({
					id: "edge-1",
					weight: 0.5,
					modified_at: "2026-03-22T10:05:00Z",
				}),
			};

			const result = applyLWWReducer(db, event);

			expect(result.applied).toBe(true);
			const row = db.query("SELECT * FROM memory_edges WHERE id = ?").get("edge-1") as Record<
				string,
				unknown
			>;
			expect(row.weight).toBe(0.5);
		});

		it("ignores earlier timestamp on memory_edges (LWW)", () => {
			// Insert edge with later timestamp
			db.run(
				`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					"edge-1",
					"memory_a",
					"memory_b",
					"depends_on",
					0.8,
					"2026-03-22T10:10:00Z",
					"2026-03-22T10:10:00Z",
				],
			);

			// Incoming event with earlier timestamp (should be ignored)
			const event: ChangeLogEntry = {
				hlc: "2026-03-22T10:01:00.000Z_0002_test",
				table_name: "memory_edges",
				row_id: "edge-1",
				site_id: "site-b",
				timestamp: "2026-03-22T10:00:00Z",
				row_data: JSON.stringify({
					id: "edge-1",
					weight: 0.3,
					modified_at: "2026-03-22T10:00:00Z",
				}),
			};

			const result = applyLWWReducer(db, event);

			expect(result.applied).toBe(false);
			const row = db.query("SELECT * FROM memory_edges WHERE id = ?").get("edge-1") as Record<
				string,
				unknown
			>;
			expect(row.weight).toBe(0.8);
		});
	});

	describe("applyEvent", () => {
		it("dispatches to append-only reducer for messages", () => {
			const event: ChangeLogEntry = {
				hlc: "2026-03-22T10:00:00.000Z_0001_test",
				table_name: "messages",
				row_id: "msg-1",
				site_id: "site-a",
				timestamp: "2026-03-22T10:00:00Z",
				row_data: JSON.stringify({
					id: "msg-1",
					thread_id: "thread-1",
					role: "user",
					content: "hello",
					created_at: "2026-03-22T10:00:00Z",
					host_origin: "laptop",
				}),
			};

			const result = applyEvent(db, event);

			expect(result.applied).toBe(true);
			const row = db.query("SELECT * FROM messages WHERE id = ?").get("msg-1");
			expect(row).toBeDefined();
		});

		it("dispatches to LWW reducer for semantic_memory", () => {
			const event: ChangeLogEntry = {
				hlc: "2026-03-22T10:00:00.000Z_0001_sitea",
				table_name: "semantic_memory",
				row_id: "mem-1",
				site_id: "site-a",
				timestamp: "2026-03-22T10:00:00Z",
				row_data: JSON.stringify({
					id: "mem-1",
					key: "test",
					value: "val",
					source: "training",
					created_at: "2026-03-22T10:00:00Z",
					modified_at: "2026-03-22T10:00:00Z",
					last_accessed_at: "2026-03-22T10:00:00Z",
				}),
			};

			const result = applyEvent(db, event);

			expect(result.applied).toBe(true);
		});
	});

	describe("replayEvents", () => {
		it("replays multiple events and tracks counts", () => {
			const events: ChangeLogEntry[] = [
				{
					hlc: "2026-03-22T10:00:00.000Z_0001_test",
					table_name: "semantic_memory",
					row_id: "mem-1",
					site_id: "site-a",
					timestamp: "2026-03-22T10:00:00Z",
					row_data: JSON.stringify({
						id: "mem-1",
						key: "key1",
						value: "val1",
						source: "training",
						created_at: "2026-03-22T10:00:00Z",
						modified_at: "2026-03-22T10:00:00Z",
						last_accessed_at: "2026-03-22T10:00:00Z",
					}),
				},
				{
					hlc: "2026-03-22T10:01:00.000Z_0002_test",
					table_name: "semantic_memory",
					row_id: "mem-2",
					site_id: "site-a",
					timestamp: "2026-03-22T10:01:00Z",
					row_data: JSON.stringify({
						id: "mem-2",
						key: "key2",
						value: "val2",
						source: "training",
						created_at: "2026-03-22T10:01:00Z",
						modified_at: "2026-03-22T10:01:00Z",
						last_accessed_at: "2026-03-22T10:01:00Z",
					}),
				},
			];

			const result = replayEvents(db, events);

			expect(result.applied).toBe(2);
			expect(result.skipped).toBe(0);
		});

		it("tracks skipped duplicates", () => {
			const event: ChangeLogEntry = {
				hlc: "2026-03-22T10:00:00.000Z_0001_test",
				table_name: "messages",
				row_id: "msg-1",
				site_id: "site-a",
				timestamp: "2026-03-22T10:00:00Z",
				row_data: JSON.stringify({
					id: "msg-1",
					thread_id: "thread-1",
					role: "user",
					content: "hello",
					created_at: "2026-03-22T10:00:00Z",
					host_origin: "laptop",
				}),
			};

			const result = replayEvents(db, [event, event]);

			expect(result.applied).toBe(1);
			expect(result.skipped).toBe(1);
		});

		it("preserves original site_id in change_log", () => {
			const event: ChangeLogEntry = {
				hlc: "2026-03-22T10:00:00.000Z_0001_test",
				table_name: "semantic_memory",
				row_id: "mem-1",
				site_id: "remote-site",
				timestamp: "2026-03-22T10:00:00Z",
				row_data: JSON.stringify({
					id: "mem-1",
					key: "test",
					value: "val",
					source: "training",
					created_at: "2026-03-22T10:00:00Z",
					modified_at: "2026-03-22T10:00:00Z",
					last_accessed_at: "2026-03-22T10:00:00Z",
				}),
			};

			replayEvents(db, [event]);

			const logEntry = db.query("SELECT * FROM change_log WHERE row_id = ?").get("mem-1") as Record<
				string,
				unknown
			>;
			expect(logEntry.site_id).toBe("remote-site");
		});
	});

	describe("onApplied callback", () => {
		it("fires once per applied event with row info", () => {
			const events: ChangeLogEntry[] = [
				{
					hlc: "2026-03-22T10:00:00.000Z_0001_test",
					table_name: "semantic_memory",
					row_id: "mem-onapplied-1",
					site_id: "remote-site",
					timestamp: "2026-03-22T10:00:00Z",
					row_data: JSON.stringify({
						id: "mem-onapplied-1",
						key: "k1",
						value: "v1",
						source: "training",
						created_at: "2026-03-22T10:00:00Z",
						modified_at: "2026-03-22T10:00:00Z",
						last_accessed_at: "2026-03-22T10:00:00Z",
					}),
				},
				{
					hlc: "2026-03-22T10:01:00.000Z_0001_test",
					table_name: "semantic_memory",
					row_id: "mem-onapplied-2",
					site_id: "remote-site",
					timestamp: "2026-03-22T10:01:00Z",
					row_data: JSON.stringify({
						id: "mem-onapplied-2",
						key: "k2",
						value: "v2",
						source: "training",
						created_at: "2026-03-22T10:01:00Z",
						modified_at: "2026-03-22T10:01:00Z",
						last_accessed_at: "2026-03-22T10:01:00Z",
					}),
				},
			];

			const calls: Array<{ table_name: string; row_id: string; site_id: string }> = [];
			const result = replayEvents(db, events, {
				onApplied: (info) => {
					calls.push({
						table_name: info.table_name,
						row_id: info.row_id,
						site_id: info.site_id,
					});
				},
			});

			expect(result.applied).toBe(2);
			expect(calls.length).toBe(2);
			expect(calls[0]).toEqual({
				table_name: "semantic_memory",
				row_id: "mem-onapplied-1",
				site_id: "remote-site",
			});
			expect(calls[1]).toEqual({
				table_name: "semantic_memory",
				row_id: "mem-onapplied-2",
				site_id: "remote-site",
			});
		});

		it("does not fire for skipped events (malformed JSON)", () => {
			const badEvent: ChangeLogEntry = {
				hlc: "2026-03-22T10:00:00.000Z_0001_test",
				table_name: "semantic_memory",
				row_id: "bad-onapplied",
				site_id: "remote-site",
				timestamp: "2026-03-22T10:00:00Z",
				row_data: "{INVALID!!!",
			};

			let calls = 0;
			const result = replayEvents(db, [badEvent], {
				onApplied: () => {
					calls++;
				},
			});

			expect(result.applied).toBe(0);
			expect(result.skipped).toBe(1);
			expect(calls).toBe(0);
		});

		it("listener errors do not poison the batch or other listeners", () => {
			const event: ChangeLogEntry = {
				hlc: "2026-03-22T10:02:00.000Z_0001_test",
				table_name: "semantic_memory",
				row_id: "mem-onapplied-poison",
				site_id: "remote-site",
				timestamp: "2026-03-22T10:02:00Z",
				row_data: JSON.stringify({
					id: "mem-onapplied-poison",
					key: "k3",
					value: "v3",
					source: "training",
					created_at: "2026-03-22T10:02:00Z",
					modified_at: "2026-03-22T10:02:00Z",
					last_accessed_at: "2026-03-22T10:02:00Z",
				}),
			};

			// Listener throws — result should still report applied:1, and the
			// row should still be committed to the DB.
			const result = replayEvents(db, [event], {
				onApplied: () => {
					throw new Error("listener exploded");
				},
			});

			expect(result.applied).toBe(1);
			const row = db
				.prepare("SELECT id FROM semantic_memory WHERE id = ?")
				.get("mem-onapplied-poison") as { id: string } | undefined;
			expect(row?.id).toBe("mem-onapplied-poison");
		});
	});

	describe("malformed JSON handling", () => {
		it("does not crash on malformed row_data in replayEvents", () => {
			const badEvent = {
				hlc: "2026-03-22T10:00:00.000Z_0001_test",
				table_name: "semantic_memory",
				row_id: "bad-1",
				site_id: "remote-site",
				timestamp: new Date().toISOString(),
				row_data: "{INVALID JSON!!!",
			};
			// Should not throw — malformed events are skipped
			const result = replayEvents(db, [badEvent]);
			expect(result.applied).toBe(0);
			expect(result.skipped).toBe(1);
		});

		it("returns applied:false for malformed JSON in applyAppendOnlyReducer", () => {
			const result = applyAppendOnlyReducer(db, {
				hlc: "2026-03-22T10:00:00.000Z_0001_test",
				table_name: "messages",
				row_id: "bad",
				site_id: "x",
				timestamp: new Date().toISOString(),
				row_data: "NOT JSON",
			});
			expect(result.applied).toBe(false);
		});

		it("returns applied:false for malformed JSON in applyLWWReducer", () => {
			const result = applyLWWReducer(db, {
				hlc: "2026-03-22T10:00:00.000Z_0001_test",
				table_name: "threads",
				row_id: "bad",
				site_id: "x",
				timestamp: new Date().toISOString(),
				row_data: "broken",
			});
			expect(result.applied).toBe(false);
		});
	});

	describe("malformed row_data edge cases", () => {
		const baseEvent: Omit<ChangeLogEntry, "row_data"> = {
			hlc: "2026-03-22T10:00:00.000Z_0001_test",
			table_name: "semantic_memory",
			row_id: "mem-1",
			site_id: "site-a",
			timestamp: "2026-03-22T10:00:00Z",
		};

		it("LWW skips null row_data", () => {
			const result = applyLWWReducer(db, { ...baseEvent, row_data: "null" });
			expect(result.applied).toBe(false);
		});

		it("LWW skips array row_data", () => {
			const result = applyLWWReducer(db, { ...baseEvent, row_data: "[1,2,3]" });
			expect(result.applied).toBe(false);
		});

		it("LWW skips string row_data", () => {
			const result = applyLWWReducer(db, { ...baseEvent, row_data: '"hello"' });
			expect(result.applied).toBe(false);
		});

		it("LWW skips number row_data", () => {
			const result = applyLWWReducer(db, { ...baseEvent, row_data: "42" });
			expect(result.applied).toBe(false);
		});

		it("LWW skips boolean row_data", () => {
			const result = applyLWWReducer(db, { ...baseEvent, row_data: "false" });
			expect(result.applied).toBe(false);
		});

		it("append-only skips null row_data", () => {
			const result = applyAppendOnlyReducer(db, {
				...baseEvent,
				table_name: "messages",
				row_data: "null",
			});
			expect(result.applied).toBe(false);
		});

		it("append-only skips array row_data", () => {
			const result = applyAppendOnlyReducer(db, {
				...baseEvent,
				table_name: "messages",
				row_data: "[1]",
			});
			expect(result.applied).toBe(false);
		});
	});

	describe("partial row_data for NOT NULL columns", () => {
		it("LWW INSERT skips partial hosts row missing host_name", () => {
			// Simulates the platform heartbeat bug: only site_id + modified_at
			const result = applyLWWReducer(db, {
				hlc: "2026-03-22T10:00:00.000Z_0001_test",
				table_name: "hosts",
				row_id: "site-abc",
				site_id: "site-a",
				timestamp: "2026-03-22T10:00:00Z",
				row_data: JSON.stringify({
					site_id: "site-abc",
					modified_at: "2026-03-22T10:00:00Z",
				}),
			});
			expect(result.applied).toBe(false);

			// Verify no row was inserted
			const row = db.query("SELECT * FROM hosts WHERE site_id = ?").get("site-abc");
			expect(row).toBeNull();
		});

		it("LWW INSERT succeeds then partial UPDATE succeeds (only updates provided columns)", () => {
			// First: full INSERT
			applyLWWReducer(db, {
				hlc: "2026-03-22T10:00:00.000Z_0001_test",
				table_name: "hosts",
				row_id: "site-abc",
				site_id: "site-a",
				timestamp: "2026-03-22T10:00:00Z",
				row_data: JSON.stringify({
					site_id: "site-abc",
					host_name: "my-host",
					modified_at: "2026-03-22T10:00:00Z",
					deleted: 0,
				}),
			});

			// Then: partial UPDATE (heartbeat-style, only modified_at)
			const result = applyLWWReducer(db, {
				hlc: "2026-03-22T10:01:00.000Z_0001_test",
				table_name: "hosts",
				row_id: "site-abc",
				site_id: "site-a",
				timestamp: "2026-03-22T10:01:00Z",
				row_data: JSON.stringify({
					site_id: "site-abc",
					modified_at: "2026-03-22T10:01:00Z",
				}),
			});
			expect(result.applied).toBe(true);

			// Verify host_name preserved
			const row = db.query("SELECT * FROM hosts WHERE site_id = ?").get("site-abc") as Record<
				string,
				unknown
			>;
			expect(row.host_name).toBe("my-host");
			expect(row.modified_at).toBe("2026-03-22T10:01:00Z");
		});

		it("LWW empty object row_data skips gracefully", () => {
			const result = applyLWWReducer(db, {
				hlc: "2026-03-22T10:00:00.000Z_0001_test",
				table_name: "hosts",
				row_id: "site-abc",
				site_id: "site-a",
				timestamp: "2026-03-22T10:00:00Z",
				row_data: "{}",
			});
			expect(result.applied).toBe(false);
		});
	});

	describe("replayEvents mixed batch scenarios", () => {
		it("continues past failed events and applies good ones", () => {
			const events: ChangeLogEntry[] = [
				// Event 1: partial hosts INSERT — will fail NOT NULL constraint
				{
					hlc: "2026-03-22T10:00:00.000Z_0001_test",
					table_name: "hosts",
					row_id: "site-abc",
					site_id: "site-a",
					timestamp: "2026-03-22T10:00:00Z",
					row_data: JSON.stringify({ site_id: "site-abc", modified_at: "2026-03-22T10:00:00Z" }),
				},
				// Event 2: null row_data — will be skipped
				{
					hlc: "2026-03-22T10:00:01.000Z_0001_test",
					table_name: "semantic_memory",
					row_id: "mem-1",
					site_id: "site-a",
					timestamp: "2026-03-22T10:00:01Z",
					row_data: "null",
				},
				// Event 3: malformed JSON — will be skipped
				{
					hlc: "2026-03-22T10:00:02.000Z_0001_test",
					table_name: "semantic_memory",
					row_id: "mem-2",
					site_id: "site-a",
					timestamp: "2026-03-22T10:00:02Z",
					row_data: "broken{json",
				},
				// Event 4: valid full hosts INSERT — should succeed
				{
					hlc: "2026-03-22T10:00:03.000Z_0001_test",
					table_name: "hosts",
					row_id: "site-abc",
					site_id: "site-a",
					timestamp: "2026-03-22T10:00:03Z",
					row_data: JSON.stringify({
						site_id: "site-abc",
						host_name: "my-host",
						modified_at: "2026-03-22T10:00:03Z",
						deleted: 0,
					}),
				},
				// Event 5: valid memory — should succeed
				{
					hlc: "2026-03-22T10:00:04.000Z_0001_test",
					table_name: "semantic_memory",
					row_id: "mem-3",
					site_id: "site-a",
					timestamp: "2026-03-22T10:00:04Z",
					row_data: JSON.stringify({
						id: "mem-3",
						key: "test",
						value: "data",
						source: "agent",
						created_at: "2026-03-22T10:00:04Z",
						modified_at: "2026-03-22T10:00:04Z",
						last_accessed_at: "2026-03-22T10:00:04Z",
						deleted: 0,
					}),
				},
			];

			const result = replayEvents(db, events);
			expect(result.applied).toBe(2); // events 4 and 5
			expect(result.skipped).toBe(3); // events 1, 2, 3

			// Verify the good events landed
			const host = db.query("SELECT * FROM hosts WHERE site_id = ?").get("site-abc");
			expect(host).not.toBeNull();
			const mem = db.query("SELECT * FROM semantic_memory WHERE id = ?").get("mem-3");
			expect(mem).not.toBeNull();
		});

		it("all events fail gracefully without crashing", () => {
			const events: ChangeLogEntry[] = [
				{
					hlc: "2026-03-22T10:00:00.000Z_0001_test",
					table_name: "hosts",
					row_id: "x",
					site_id: "site-a",
					timestamp: "2026-03-22T10:00:00Z",
					row_data: "null",
				},
				{
					hlc: "2026-03-22T10:00:01.000Z_0001_test",
					table_name: "hosts",
					row_id: "y",
					site_id: "site-a",
					timestamp: "2026-03-22T10:00:01Z",
					row_data: "broken",
				},
			];

			const result = replayEvents(db, events);
			expect(result.applied).toBe(0);
			expect(result.skipped).toBe(2);
		});
	});

	// Note: invariant-#19 regression tests live in reducers-invariant-19.test.ts
	// (standalone file with a minimal schema for fast focused verification).
});
