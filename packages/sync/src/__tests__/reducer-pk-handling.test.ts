import { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach } from "bun:test";
import { applyLWWReducer, applyAppendOnlyReducer, clearColumnCache } from "../reducers";
import type { ChangeLogEntry } from "../changeset";

/**
 * TDD tests for reducer primary key handling.
 *
 * These tests verify that sync reducers correctly handle tables with
 * non-standard primary keys (not "id"). Found via E2E testing:
 * - hosts table uses site_id as PK
 * - cluster_config table uses key as PK
 * - messages (append-only) with modified_at must still INSERT new rows
 */

describe("Reducer primary key handling", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		clearColumnCache();

		// Create tables matching the real schema
		db.exec(`
			CREATE TABLE hosts (
				site_id TEXT PRIMARY KEY,
				host_name TEXT NOT NULL,
				online_at TEXT,
				modified_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			) STRICT;

			CREATE TABLE cluster_config (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				modified_at TEXT NOT NULL
			) STRICT;

			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				model_id TEXT,
				tool_name TEXT,
				created_at TEXT NOT NULL,
				modified_at TEXT,
				host_origin TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			) STRICT;

			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				interface TEXT NOT NULL,
				host_origin TEXT NOT NULL,
				color INTEGER DEFAULT 0,
				title TEXT,
				summary TEXT,
				created_at TEXT NOT NULL,
				last_message_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			) STRICT;
		`);
	});

	describe("LWW reducer with hosts table (site_id PK)", () => {
		it("inserts a new host row using site_id as PK", () => {
			const event: ChangeLogEntry = {
				seq: 1,
				table_name: "hosts",
				row_id: "abc123",
				site_id: "remote-site",
				timestamp: "2026-03-24T00:00:00Z",
				row_data: JSON.stringify({
					site_id: "abc123",
					host_name: "remote-host",
					online_at: "2026-03-24T00:00:00Z",
					modified_at: "2026-03-24T00:00:00Z",
					deleted: 0,
				}),
			};

			const result = applyLWWReducer(db, event);
			expect(result.applied).toBe(true);

			const row = db.query("SELECT * FROM hosts WHERE site_id = ?").get("abc123") as Record<string, unknown> | null;
			expect(row).not.toBeNull();
			expect(row!.host_name).toBe("remote-host");
		});

		it("updates an existing host row using LWW on modified_at", () => {
			// Insert initial
			db.run("INSERT INTO hosts (site_id, host_name, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
				["abc123", "old-name", "2026-03-24T00:00:00Z", "2026-03-24T00:00:00Z"]);

			const event: ChangeLogEntry = {
				seq: 2,
				table_name: "hosts",
				row_id: "abc123",
				site_id: "remote-site",
				timestamp: "2026-03-24T01:00:00Z",
				row_data: JSON.stringify({
					site_id: "abc123",
					host_name: "new-name",
					online_at: "2026-03-24T01:00:00Z",
					modified_at: "2026-03-24T01:00:00Z",
					deleted: 0,
				}),
			};

			const result = applyLWWReducer(db, event);
			expect(result.applied).toBe(true);

			const row = db.query("SELECT host_name FROM hosts WHERE site_id = ?").get("abc123") as Record<string, unknown> | null;
			expect(row!.host_name).toBe("new-name");
		});
	});

	describe("LWW reducer with cluster_config table (key PK)", () => {
		it("inserts a new cluster_config row using key as PK", () => {
			const event: ChangeLogEntry = {
				seq: 1,
				table_name: "cluster_config",
				row_id: "cluster_hub",
				site_id: "remote-site",
				timestamp: "2026-03-24T00:00:00Z",
				row_data: JSON.stringify({
					key: "cluster_hub",
					value: "hub.example.com",
					modified_at: "2026-03-24T00:00:00Z",
				}),
			};

			const result = applyLWWReducer(db, event);
			expect(result.applied).toBe(true);

			const row = db.query("SELECT * FROM cluster_config WHERE key = ?").get("cluster_hub") as Record<string, unknown> | null;
			expect(row).not.toBeNull();
			expect(row!.value).toBe("hub.example.com");
		});

		it("updates existing cluster_config using LWW on modified_at", () => {
			db.run("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)",
				["cluster_hub", "old-hub.com", "2026-03-24T00:00:00Z"]);

			const event: ChangeLogEntry = {
				seq: 2,
				table_name: "cluster_config",
				row_id: "cluster_hub",
				site_id: "remote-site",
				timestamp: "2026-03-24T01:00:00Z",
				row_data: JSON.stringify({
					key: "cluster_hub",
					value: "new-hub.com",
					modified_at: "2026-03-24T01:00:00Z",
				}),
			};

			const result = applyLWWReducer(db, event);
			expect(result.applied).toBe(true);

			const row = db.query("SELECT value FROM cluster_config WHERE key = ?").get("cluster_hub") as Record<string, unknown> | null;
			expect(row!.value).toBe("new-hub.com");
		});

		it("rejects stale cluster_config update (older modified_at)", () => {
			db.run("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)",
				["cluster_hub", "current-hub.com", "2026-03-24T02:00:00Z"]);

			const event: ChangeLogEntry = {
				seq: 3,
				table_name: "cluster_config",
				row_id: "cluster_hub",
				site_id: "remote-site",
				timestamp: "2026-03-24T01:00:00Z",
				row_data: JSON.stringify({
					key: "cluster_hub",
					value: "stale-hub.com",
					modified_at: "2026-03-24T01:00:00Z",
				}),
			};

			const result = applyLWWReducer(db, event);
			expect(result.applied).toBe(false);

			const row = db.query("SELECT value FROM cluster_config WHERE key = ?").get("cluster_hub") as Record<string, unknown> | null;
			expect(row!.value).toBe("current-hub.com");
		});
	});

	describe("Append-only reducer with modified_at (messages)", () => {
		it("inserts new messages even when modified_at is set", () => {
			const event: ChangeLogEntry = {
				seq: 1,
				table_name: "messages",
				row_id: "msg-001",
				site_id: "remote-site",
				timestamp: "2026-03-24T00:00:00Z",
				row_data: JSON.stringify({
					id: "msg-001",
					thread_id: "thread-001",
					role: "user",
					content: "Hello from remote host!",
					model_id: null,
					tool_name: null,
					created_at: "2026-03-24T00:00:00Z",
					modified_at: "2026-03-24T00:00:00Z",
					host_origin: "remote-host",
					deleted: 0,
				}),
			};

			const result = applyAppendOnlyReducer(db, event);
			expect(result.applied).toBe(true);

			const row = db.query("SELECT * FROM messages WHERE id = ?").get("msg-001") as Record<string, unknown> | null;
			expect(row).not.toBeNull();
			expect(row!.content).toBe("Hello from remote host!");
		});

		it("does not duplicate messages on re-sync (ON CONFLICT DO NOTHING)", () => {
			// Insert first (with modified_at, like insertRow does)
			db.run("INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
				["msg-001", "thread-001", "user", "Original", "2026-03-24T00:00:00Z", "2026-03-24T00:00:00Z", "host-a"]);

			const event: ChangeLogEntry = {
				seq: 2,
				table_name: "messages",
				row_id: "msg-001",
				site_id: "remote-site",
				timestamp: "2026-03-24T00:00:00Z",
				row_data: JSON.stringify({
					id: "msg-001",
					thread_id: "thread-001",
					role: "user",
					content: "Original",
					created_at: "2026-03-24T00:00:00Z",
					modified_at: "2026-03-24T00:00:00Z",
					host_origin: "host-a",
					deleted: 0,
				}),
			};

			const result = applyAppendOnlyReducer(db, event);
			// Should not duplicate — conflict resolution
			expect(result.applied).toBe(false);

			const count = db.query("SELECT COUNT(*) as c FROM messages WHERE id = ?").get("msg-001") as { c: number };
			expect(count.c).toBe(1);
		});
	});
});
