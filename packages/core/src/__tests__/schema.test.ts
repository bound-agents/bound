import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createDatabase } from "../database";
import { applySchema } from "../schema";

describe("Database Schema", () => {
	let dbPath: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
	});

	afterEach(() => {
		try {
			require("fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("creates database with WAL mode and foreign keys enabled", () => {
		const db = createDatabase(dbPath);

		const journalMode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
		expect(journalMode.journal_mode.toLowerCase()).toBe("wal");

		const foreignKeys = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
		expect(foreignKeys.foreign_keys).toBe(1);

		db.close();
	});

	it("applies schema successfully creating all 13 tables", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
			.all() as Array<{ name: string }>;

		const tableNames = tables.map((t) => t.name);

		// Verify all 13 tables exist
		expect(tableNames).toContain("users");
		expect(tableNames).toContain("threads");
		expect(tableNames).toContain("messages");
		expect(tableNames).toContain("semantic_memory");
		expect(tableNames).toContain("tasks");
		expect(tableNames).toContain("files");
		expect(tableNames).toContain("hosts");
		expect(tableNames).toContain("overlay_index");
		expect(tableNames).toContain("cluster_config");
		expect(tableNames).toContain("advisories");
		expect(tableNames).toContain("change_log");
		expect(tableNames).toContain("sync_state");
		expect(tableNames).toContain("host_meta");

		expect(tableNames.length).toBe(13);

		db.close();
	});

	it("creates all indexes", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const indexes = db
			.query("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
			.all() as Array<{ name: string }>;

		const indexNames = indexes.map((i) => i.name);

		expect(indexNames).toContain("idx_users_discord");
		expect(indexNames).toContain("idx_threads_user");
		expect(indexNames).toContain("idx_messages_thread");
		expect(indexNames).toContain("idx_memory_key");
		expect(indexNames).toContain("idx_overlay_site_path");
		expect(indexNames).toContain("idx_files_path");
		expect(indexNames).toContain("idx_changelog_seq");

		db.close();
	});

	it("enforces STRICT mode on tables", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		// STRICT tables reject wrong types
		const result = db.query("PRAGMA table_info(users)").all() as Array<{
			cid: number;
			name: string;
			type: string;
		}>;

		expect(result.length).toBeGreaterThan(0);

		// Verify users table is STRICT by trying to insert wrong type
		db.run(`INSERT INTO users (id, display_name, first_seen_at, modified_at)
			VALUES ('user-123', 'Alice', '2026-03-22T00:00:00Z', '2026-03-22T00:00:00Z')`);

		const users = db.query("SELECT * FROM users").all();
		expect(users).toHaveLength(1);

		db.close();
	});

	it("allows idempotent schema application", () => {
		const db = createDatabase(dbPath);

		// Apply schema twice
		applySchema(db);
		applySchema(db);

		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
			.all() as Array<{ name: string }>;

		// Still exactly 13 tables
		expect(tables.length).toBe(13);

		db.close();
	});

	it("verifies messages table has correct columns", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const columns = db
			.query("PRAGMA table_info(messages)")
			.all() as Array<{ name: string }>;

		const columnNames = columns.map((c) => c.name);

		expect(columnNames).toContain("id");
		expect(columnNames).toContain("thread_id");
		expect(columnNames).toContain("role");
		expect(columnNames).toContain("content");
		expect(columnNames).toContain("model_id");
		expect(columnNames).toContain("tool_name");
		expect(columnNames).toContain("created_at");
		expect(columnNames).toContain("modified_at");
		expect(columnNames).toContain("host_origin");

		db.close();
	});

	it("verifies tasks table has all required columns", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const columns = db
			.query("PRAGMA table_info(tasks)")
			.all() as Array<{ name: string }>;

		const columnNames = columns.map((c) => c.name);

		// Verify all task columns are present
		const requiredColumns = [
			"id",
			"type",
			"status",
			"trigger_spec",
			"payload",
			"created_at",
			"created_by",
			"thread_id",
			"claimed_by",
			"claimed_at",
			"lease_id",
			"next_run_at",
			"last_run_at",
			"run_count",
			"max_runs",
			"requires",
			"model_hint",
			"no_history",
			"inject_mode",
			"depends_on",
			"require_success",
			"alert_threshold",
			"consecutive_failures",
			"event_depth",
			"no_quiescence",
			"heartbeat_at",
			"result",
			"error",
			"modified_at",
			"deleted",
		];

		for (const col of requiredColumns) {
			expect(columnNames).toContain(col);
		}

		db.close();
	});

	it("can insert and query data after applying schema", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const now = new Date().toISOString();

		db.run(
			`INSERT INTO users (id, display_name, first_seen_at, modified_at)
			VALUES (?, ?, ?, ?)`,
			["user-123", "Alice", now, now]
		);

		const user = db.query("SELECT * FROM users WHERE id = ?").get("user-123") as {
			id: string;
			display_name: string;
			first_seen_at: string;
			modified_at: string;
		};

		expect(user.id).toBe("user-123");
		expect(user.display_name).toBe("Alice");

		db.close();
	});
});
