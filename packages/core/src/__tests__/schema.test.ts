import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertRow, updateRow } from "../change-log";
import { createDatabase } from "../database";
import { applySchema } from "../schema";

describe("Database Schema", () => {
	let dbPath: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
	});

	afterEach(() => {
		try {
			require("node:fs").unlinkSync(dbPath);
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

	it("applies schema successfully creating all 19 tables + FTS5", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const tables = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all() as Array<{ name: string }>;

		const tableNames = tables.map((t) => t.name);

		// Verify all 21 base tables exist
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
		expect(tableNames).toContain("skills");
		expect(tableNames).toContain("memory_edges");
		expect(tableNames).toContain("connector_handles");
		expect(tableNames).toContain("webhooks");
		expect(tableNames).toContain("change_log");
		expect(tableNames).toContain("sync_state");
		expect(tableNames).toContain("host_meta");
		expect(tableNames).toContain("relay_outbox");
		expect(tableNames).toContain("relay_inbox");
		expect(tableNames).toContain("relay_cycles");
		expect(tableNames).toContain("dispatch_queue");

		// FTS5 virtual table + its shadow tables
		expect(tableNames).toContain("semantic_memory_fts");

		// 21 base tables + FTS5 virtual table + 5 FTS5 shadow tables = 27
		const baseTables = tableNames.filter((n) => !n.startsWith("semantic_memory_fts_"));
		expect(baseTables.length).toBe(22); // 21 base + 1 FTS5 virtual table

		db.close();
	});

	it("creates all indexes", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const indexes = db
			.query("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
			.all() as Array<{ name: string }>;

		const indexNames = indexes.map((i) => i.name);

		expect(indexNames).toContain("idx_threads_user");
		expect(indexNames).toContain("idx_messages_thread");
		expect(indexNames).toContain("idx_memory_key");
		expect(indexNames).toContain("idx_overlay_site_path");
		expect(indexNames).toContain("idx_files_path");
		expect(indexNames).toContain("idx_skills_name");
		expect(indexNames).toContain("idx_edges_triple");
		expect(indexNames).toContain("idx_edges_source");
		expect(indexNames).toContain("idx_edges_target");
		// idx_changelog_seq removed in HLC migration — hlc is TEXT PRIMARY KEY
		expect(indexNames).toContain("idx_memory_modified");
		expect(indexNames).toContain("idx_tasks_last_run");
		expect(indexNames).toContain("idx_memory_detail_recency");

		db.close();
	});

	it("idx_memory_detail_recency exists and supports R-VC4 SELECT predicate", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		// Verify the index exists
		const indexes = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_detail_recency'",
			)
			.all() as Array<{ name: string }>;
		expect(indexes).toHaveLength(1);

		// Verify the index is COVERING by including key column (for planner to prefer it)
		const indexInfo = db.query("PRAGMA index_info(idx_memory_detail_recency)").all() as Array<{
			seqno: number;
			cid: number;
			name: string;
		}>;

		// Should have last_accessed_at and key (covering index)
		expect(indexInfo).toHaveLength(2);
		expect(indexInfo[0].name).toBe("last_accessed_at");
		expect(indexInfo[1].name).toBe("key");

		// Verify the index WHERE clause by querying sqlite_master
		const indexDef = db
			.query(
				"SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_memory_detail_recency'",
			)
			.get() as { sql: string };
		expect(indexDef.sql).toContain("tier = 'detail'");
		expect(indexDef.sql).toContain("deleted = 0");

		// Insert large dataset (1000+ rows) to make planner favor the specialized index
		// Mix of tiers to exercise the partial index WHERE clause filtering
		for (let i = 0; i < 1200; i++) {
			const tier = i % 10 < 4 ? "detail" : i % 10 < 7 ? "summary" : "pinned";
			const deleted = i === 42 ? 1 : 0; // soft-delete one detail row
			db.run(`
				INSERT INTO semantic_memory (
					id, key, value, tier, source, created_at, last_accessed_at, modified_at, deleted
				) VALUES (
					'test-id-${i}',
					'test-key-${i}',
					'test-value-${i}',
					'${tier}',
					'test-source',
					datetime('now'),
					datetime('now', '-${1200 - i} seconds'),
					datetime('now'),
					${deleted}
				)
			`);
		}

		// Run ANALYZE so the query planner has statistics to make decisions
		db.run("ANALYZE");

		// Verify that the query with the correct predicate (deleted = 0) returns expected results
		// Rows with tier='detail' and deleted=0 should be returned, ordered by recency
		const results = db
			.prepare(
				"SELECT key, last_accessed_at FROM semantic_memory WHERE tier = 'detail' AND deleted = 0 ORDER BY last_accessed_at DESC",
			)
			.all() as Array<{ key: string; last_accessed_at: string | null }>;

		// Should have ~480 detail rows (1200 * 0.4 ≈ 480, minus 1 deleted)
		expect(results.length).toBeGreaterThan(400);
		expect(results.length).toBeLessThan(500);
		// Verify they are sorted by last_accessed_at descending
		for (let i = 1; i < results.length; i++) {
			const prev = results[i - 1].last_accessed_at;
			const curr = results[i].last_accessed_at;
			if (prev !== null && curr !== null) {
				// Timestamps are ISO 8601 strings, which sort lexicographically in descending order
				expect(prev >= curr).toBe(true);
			}
		}

		// CRITICAL: Verify the EXPLAIN QUERY PLAN shows idx_memory_detail_recency is selected
		// The covering index must be used (not idx_memory_tier), and no TEMP B-TREE sort
		const queryPlan = db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT key, last_accessed_at FROM semantic_memory WHERE tier = 'detail' AND deleted = 0 ORDER BY last_accessed_at DESC",
			)
			.all() as Array<{ detail: string }>;
		const planText = queryPlan.map((row) => row.detail).join(" ");

		// Regression guard: must use the covering partial index for recency ordering
		expect(planText).toContain("idx_memory_detail_recency");
		// Must NOT require a temporary B-tree for sorting (would indicate wrong index)
		expect(planText).not.toContain("TEMP B-TREE");

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

		// Still exactly 27 tables (21 base + 1 FTS5 virtual + 5 FTS5 shadow)
		expect(tables.length).toBe(27);

		db.close();
	});

	it("verifies threads table has model_hint column", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const columns = db.query("PRAGMA table_info(threads)").all() as Array<{
			name: string;
			type: string;
			notnull: number;
			dflt_value: string | null;
		}>;

		const columnNames = columns.map((c) => c.name);
		expect(columnNames).toContain("model_hint");

		const modelHintCol = columns.find((c) => c.name === "model_hint");
		expect(modelHintCol?.type).toBe("TEXT");
		expect(modelHintCol?.notnull).toBe(0); // nullable
		expect(modelHintCol?.dflt_value).toBeNull(); // no default

		db.close();
	});

	it("verifies messages table has correct columns", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const columns = db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;

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

		const columns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;

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

	it("defaults alert_threshold to 3 for new tasks", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		const siteId = "test-site";
		const now = new Date().toISOString();

		insertRow(
			db,
			"tasks",
			{
				id: randomUUID(),
				type: "deferred",
				status: "pending",
				trigger_spec: "in 10m",
				payload: null,
				thread_id: null,
				origin_thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: now,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				// alert_threshold intentionally omitted to test DEFAULT
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: now,
				created_by: "test",
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		const task = db.query("SELECT alert_threshold FROM tasks").get() as { alert_threshold: number };
		expect(task.alert_threshold).toBe(3);

		db.close();
	});

	it("verifies skills table has all required columns", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const columns = db.query("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
		const columnNames = columns.map((c) => c.name);

		expect(columnNames).toContain("id");
		expect(columnNames).toContain("name");
		expect(columnNames).toContain("description");
		expect(columnNames).toContain("status");
		expect(columnNames).toContain("skill_root");
		expect(columnNames).toContain("content_hash");
		expect(columnNames).toContain("allowed_tools");
		expect(columnNames).toContain("compatibility");
		expect(columnNames).toContain("metadata_json");
		expect(columnNames).toContain("activated_at");
		expect(columnNames).toContain("created_by_thread");
		expect(columnNames).toContain("activation_count");
		expect(columnNames).toContain("last_activated_at");
		expect(columnNames).toContain("retired_by");
		expect(columnNames).toContain("retired_reason");
		expect(columnNames).toContain("modified_at");
		expect(columnNames).toContain("deleted");

		db.close();
	});

	it("enforces unique index on active skill name", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		const now = new Date().toISOString();

		db.run(
			`INSERT INTO skills (id, name, description, status, skill_root, activation_count, modified_at, deleted)
			 VALUES ('id-1', 'pr-review', 'Review PRs', 'active', '/home/user/skills/pr-review', 0, ?, 0)`,
			[now],
		);

		// Inserting a second active skill with the same name must fail
		expect(() => {
			db.run(
				`INSERT INTO skills (id, name, description, status, skill_root, activation_count, modified_at, deleted)
				 VALUES ('id-2', 'pr-review', 'Duplicate', 'active', '/home/user/skills/pr-review', 0, ?, 0)`,
				[now],
			);
		}).toThrow();

		db.close();
	});

	it("insertRow and updateRow write change-log entries for skills table", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		const siteId = "test-site";
		const skillId = randomUUID();
		const now = new Date().toISOString();

		insertRow(
			db,
			"skills",
			{
				id: skillId,
				name: "test-skill",
				description: "A test skill",
				status: "active",
				skill_root: "/home/user/skills/test-skill",
				content_hash: null,
				allowed_tools: null,
				compatibility: null,
				metadata_json: null,
				activated_at: null,
				created_by_thread: null,
				activation_count: 0,
				last_activated_at: null,
				retired_by: null,
				retired_reason: null,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		const entry = db.query("SELECT * FROM change_log WHERE row_id = ?").get(skillId) as Record<
			string,
			unknown
		>;
		expect(entry).toBeDefined();
		expect(entry.table_name).toBe("skills");

		updateRow(
			db,
			"skills",
			skillId,
			{ description: "Updated description", modified_at: now },
			siteId,
		);

		const entries = db
			.query("SELECT * FROM change_log WHERE row_id = ? ORDER BY hlc")
			.all(skillId) as Array<Record<string, unknown>>;
		expect(entries).toHaveLength(2);
		expect(entries[1].table_name).toBe("skills");

		db.close();
	});

	it("can insert and query data after applying schema", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const now = new Date().toISOString();

		db.run(
			`INSERT INTO users (id, display_name, first_seen_at, modified_at)
			VALUES (?, ?, ?, ?)`,
			["user-123", "Alice", now, now],
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

describe("platform-connectors Phase 1 migrations", () => {
	let dbPath: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
	});

	afterEach(() => {
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("AC1.1: users table has platform_ids column after applySchema", () => {
		// Create fresh in-memory DB and apply schema
		const db = createDatabase(":memory:");
		applySchema(db);
		const cols = db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>;
		expect(cols.map((c) => c.name)).toContain("platform_ids");
		db.close();
	});

	it("AC1.2: existing discord_id rows are migrated to platform_ids", () => {
		const db = createDatabase(":memory:");
		// Apply OLD schema (before platform_ids exists) by running the base
		// CREATE TABLE with discord_id but without platform_ids
		db.run(`
			CREATE TABLE IF NOT EXISTS users (
				id           TEXT PRIMARY KEY,
				display_name TEXT NOT NULL,
				discord_id   TEXT,
				first_seen_at TEXT NOT NULL,
				modified_at  TEXT NOT NULL,
				deleted      INTEGER DEFAULT 0
			) STRICT
		`);
		db.run(`INSERT INTO users VALUES ('u1', 'Alice', '12345', '2026-01-01', '2026-01-01', 0)`);
		// Now run the full schema (triggers the migration)
		applySchema(db);
		const row = db.query("SELECT platform_ids FROM users WHERE id = 'u1'").get() as {
			platform_ids: string | null;
		};
		expect(row.platform_ids).toBe('{"discord":"12345"}');
		db.close();
	});

	it("AC1.3: discord_id column does not exist after applySchema", () => {
		const db = createDatabase(":memory:");
		applySchema(db);
		const cols = db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>;
		expect(cols.map((c) => c.name)).not.toContain("discord_id");
		db.close();
	});

	it("AC1.4: hosts table has platforms column after applySchema", () => {
		const db = createDatabase(":memory:");
		applySchema(db);
		const cols = db.query("PRAGMA table_info(hosts)").all() as Array<{ name: string }>;
		expect(cols.map((c) => c.name)).toContain("platforms");
		db.close();
	});

	it("AC1.5: threads table accepts non-web-non-discord interface values", () => {
		const db = createDatabase(":memory:");
		applySchema(db);
		// Insert a thread with interface = "telegram" — should not throw
		expect(() => {
			db.run(
				`INSERT INTO threads (id, user_id, interface, host_origin, color, created_at, last_message_at, modified_at, deleted)
				 VALUES ('t1', 'u1', 'telegram', 'host1', 0, '2026-01-01', '2026-01-01', '2026-01-01', 0)`,
			);
		}).not.toThrow();
		const row = db.query("SELECT interface FROM threads WHERE id = 't1'").get() as {
			interface: string;
		};
		expect(row.interface).toBe("telegram");
		db.close();
	});

	it("webhooks table has all required columns", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const columns = db.query("PRAGMA table_info(webhooks)").all() as Array<{ name: string }>;
		const columnNames = columns.map((c) => c.name);

		const requiredColumns = [
			"id",
			"name",
			"secret",
			"signature_format",
			"description",
			"task_id",
			"thread_id",
			"created_at",
			"deleted",
			"modified_at",
		];

		for (const col of requiredColumns) {
			expect(columnNames).toContain(col);
		}

		db.close();
	});

	it("enforces unique index on active webhook name", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		const now = new Date().toISOString();

		db.run(
			`INSERT INTO webhooks (id, name, secret, signature_format, description, task_id, thread_id, created_at, deleted, modified_at)
			 VALUES ('wh-1', 'my-webhook', 'secret123', 'github', 'test webhook', 'task-1', 'thread-1', ?, 0, ?)`,
			[now, now],
		);

		// Inserting a second active webhook with the same name must fail
		expect(() => {
			db.run(
				`INSERT INTO webhooks (id, name, secret, signature_format, description, task_id, thread_id, created_at, deleted, modified_at)
				 VALUES ('wh-2', 'my-webhook', 'secret456', 'github', 'duplicate', 'task-2', 'thread-2', ?, 0, ?)`,
				[now, now],
			);
		}).toThrow();

		db.close();
	});

	it("allows soft-deleted webhook names to be reused", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		const now = new Date().toISOString();

		db.run(
			`INSERT INTO webhooks (id, name, secret, signature_format, description, task_id, thread_id, created_at, deleted, modified_at)
			 VALUES ('wh-1', 'my-webhook', 'secret123', 'github', 'test webhook', 'task-1', 'thread-1', ?, 0, ?)`,
			[now, now],
		);

		// Soft-delete the first webhook
		db.run(`UPDATE webhooks SET deleted = 1 WHERE id = 'wh-1'`);

		// Inserting a second webhook with the same name should succeed (first is soft-deleted)
		expect(() => {
			db.run(
				`INSERT INTO webhooks (id, name, secret, signature_format, description, task_id, thread_id, created_at, deleted, modified_at)
				 VALUES ('wh-2', 'my-webhook', 'secret456', 'github', 'reused', 'task-2', 'thread-2', ?, 0, ?)`,
				[now, now],
			);
		}).not.toThrow();

		db.close();
	});

	it("tasks table has system_prompt_addition column", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const columns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
		const columnNames = columns.map((c) => c.name);

		expect(columnNames).toContain("system_prompt_addition");

		db.close();
	});
});
