import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../database";
import { applySchema } from "../schema";

describe("Hierarchical Memory: tier column migration (AC6.1-AC6.4)", () => {
	let dbPath: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-tier-${randomBytes(4).toString("hex")}.db`);
	});

	afterEach(() => {
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("AC6.1: tier column exists after applySchema on fresh DB", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const columns = db.query("PRAGMA table_info(semantic_memory)").all() as Array<{ name: string }>;
		const columnNames = columns.map((c) => c.name);

		expect(columnNames).toContain("tier");
		db.close();
	});

	it("AC6.1: applySchema is idempotent — tier column add is safe on existing DB", () => {
		const db = createDatabase(dbPath);

		// Apply schema first time
		applySchema(db);
		let columns = db.query("PRAGMA table_info(semantic_memory)").all() as Array<{ name: string }>;
		expect(columns.map((c) => c.name)).toContain("tier");

		// Apply schema again — should not throw
		expect(() => {
			applySchema(db);
		}).not.toThrow();

		// tier column still exists
		columns = db.query("PRAGMA table_info(semantic_memory)").all() as Array<{ name: string }>;
		expect(columns.map((c) => c.name)).toContain("tier");

		db.close();
	});

	it("AC6.2: prefix-keyed entries are backfilled to pinned tier after migration", () => {
		const db = createDatabase(dbPath);

		// Create semantic_memory table WITHOUT tier column (pre-migration state)
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
			) STRICT
		`);

		const now = new Date().toISOString();
		const prefixKeys = [
			"_standing:user-context",
			"_feedback:model-perf",
			"_policy:rate-limit",
			"_pinned:instructions",
		];

		// Insert prefix-keyed entries
		for (const key of prefixKeys) {
			db.run(
				`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[randomUUID(), key, `value-${key}`, "test", now, now, now, 0],
			);
		}

		// Apply migration (adds tier column)
		applySchema(db);

		// Verify all prefix-keyed entries have tier = 'pinned'
		for (const key of prefixKeys) {
			const row = db.query("SELECT tier FROM semantic_memory WHERE key = ?").get(key) as {
				tier: string;
			};
			expect(row.tier).toBe("pinned");
		}

		db.close();
	});

	it("AC6.3: non-prefix entries remain default tier after migration", () => {
		const db = createDatabase(dbPath);

		// Create semantic_memory table WITHOUT tier column
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
			) STRICT
		`);

		const now = new Date().toISOString();
		const nonPrefixKeys = ["user-context", "model-perf", "rate-limit", "instructions"];

		// Insert non-prefix entries
		for (const key of nonPrefixKeys) {
			db.run(
				`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[randomUUID(), key, `value-${key}`, "test", now, now, now, 0],
			);
		}

		// Apply migration
		applySchema(db);

		// Verify all non-prefix entries have tier = 'default'
		for (const key of nonPrefixKeys) {
			const row = db.query("SELECT tier FROM semantic_memory WHERE key = ?").get(key) as {
				tier: string;
			};
			expect(row.tier).toBe("default");
		}

		db.close();
	});

	it("AC6.4: running migration twice produces same result (idempotent backfill)", () => {
		const db = createDatabase(dbPath);

		// Create pre-migration table
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
			) STRICT
		`);

		const now = new Date().toISOString();
		const prefixKeys = ["_standing:x", "_feedback:y"];
		const nonPrefixKeys = ["key-a", "key-b"];

		// Insert mixed entries
		for (const key of prefixKeys) {
			db.run(
				`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[randomUUID(), key, `value-${key}`, "test", now, now, now, 0],
			);
		}
		for (const key of nonPrefixKeys) {
			db.run(
				`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[randomUUID(), key, `value-${key}`, "test", now, now, now, 0],
			);
		}

		// Apply migration first time
		applySchema(db);

		// Capture state after first migration
		const afterFirstMigration = db
			.query("SELECT key, tier FROM semantic_memory ORDER BY key")
			.all() as Array<{ key: string; tier: string }>;

		// Apply migration second time (idempotent)
		applySchema(db);

		// Capture state after second migration
		const afterSecondMigration = db
			.query("SELECT key, tier FROM semantic_memory ORDER BY key")
			.all() as Array<{ key: string; tier: string }>;

		// States must be identical
		expect(afterFirstMigration).toEqual(afterSecondMigration);

		// Verify expectations
		expect(afterSecondMigration).toHaveLength(4);
		for (const row of afterSecondMigration) {
			if (row.key.startsWith("_")) {
				expect(row.tier).toBe("pinned");
			} else {
				expect(row.tier).toBe("default");
			}
		}

		db.close();
	});

	it("edge case: soft-deleted prefix entries should NOT be backfilled to pinned", () => {
		const db = createDatabase(dbPath);

		// Create pre-migration table
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
			) STRICT
		`);

		const now = new Date().toISOString();

		// Insert a soft-deleted prefix entry (deleted = 1)
		const deletedId = randomUUID();
		db.run(
			`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[deletedId, "_standing:old-context", "old-value", "test", now, now, now, 1],
		);

		// Insert a non-deleted prefix entry for comparison
		const activeId = randomUUID();
		db.run(
			`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[activeId, "_standing:new-context", "new-value", "test", now, now, now, 0],
		);

		// Apply migration
		applySchema(db);

		// Deleted entry should remain default (backfill WHERE includes deleted = 0)
		const deletedRow = db.query("SELECT tier FROM semantic_memory WHERE id = ?").get(deletedId) as {
			tier: string;
		};
		expect(deletedRow.tier).toBe("default");

		// Active entry should be backfilled to pinned
		const activeRow = db.query("SELECT tier FROM semantic_memory WHERE id = ?").get(activeId) as {
			tier: string;
		};
		expect(activeRow.tier).toBe("pinned");

		db.close();
	});

	it("edge case: entries already set to non-default tier should not be overwritten", () => {
		const db = createDatabase(dbPath);

		// Manually apply base schema and insert data with tier column already
		applySchema(db);

		const now = new Date().toISOString();
		const prefixId = randomUUID();

		// Manually set a prefix entry to 'summary' tier (pre-migration override)
		db.run(
			`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at, tier, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[prefixId, "_standing:context", "value", "test", now, now, now, "summary", 0],
		);

		// Apply migration again
		applySchema(db);

		// Tier should still be 'summary' (not overwritten to pinned, because backfill WHERE includes tier = 'default')
		const row = db.query("SELECT tier FROM semantic_memory WHERE id = ?").get(prefixId) as {
			tier: string;
		};
		expect(row.tier).toBe("summary");

		db.close();
	});

	it("creates idx_memory_tier index for tier-filtered queries", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const indexes = db
			.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_tier'")
			.all() as Array<{ name: string }>;

		expect(indexes).toHaveLength(1);
		expect(indexes[0].name).toBe("idx_memory_tier");

		db.close();
	});
});
