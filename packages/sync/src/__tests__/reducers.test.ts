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
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				site_id TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				row_data TEXT NOT NULL
			)
		`);
	});

	afterEach(() => {
		db.close();
	});

	describe("applyAppendOnlyReducer", () => {
		it("inserts new message", () => {
			const event: ChangeLogEntry = {
				seq: 1,
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
				seq: 1,
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
				seq: 2,
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
				seq: 1,
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
				seq: 2,
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
				seq: 1,
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
				seq: 2,
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
	});

	describe("applyEvent", () => {
		it("dispatches to append-only reducer for messages", () => {
			const event: ChangeLogEntry = {
				seq: 1,
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
				seq: 1,
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
					seq: 1,
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
					seq: 2,
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
				seq: 1,
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
				seq: 1,
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

	describe("malformed JSON handling", () => {
		it("does not crash on malformed row_data in replayEvents", () => {
			const badEvent = {
				seq: 1,
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
				seq: 1,
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
				seq: 1,
				table_name: "threads",
				row_id: "bad",
				site_id: "x",
				timestamp: new Date().toISOString(),
				row_data: "broken",
			});
			expect(result.applied).toBe(false);
		});
	});
});
