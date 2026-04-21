import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "../index.js";
import { CANONICAL_RELATIONS } from "../memory-relations.js";

describe("memory_edges schema and triggers", () => {
	let tempDir: string;
	let dbPath: string;
	let db: Database;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-test-"));
		dbPath = join(tempDir, "test.db");
	});

	afterEach(() => {
		if (db) {
			db.close();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	describe("edge-graph-normalization.AC1.1: Fresh DB has context column and triggers", () => {
		it("fresh DB from createDatabase + applySchema has context column", () => {
			db = createDatabase(dbPath);
			applySchema(db);

			// Check PRAGMA table_info for context column
			const cols = db.query("PRAGMA table_info(memory_edges)").all() as Array<{
				cid: number;
				name: string;
				type: string;
				notnull: number;
				dflt_value: string | null;
				pk: number;
			}>;

			const contextCol = cols.find((c) => c.name === "context");
			expect(contextCol).toBeDefined();
			expect(contextCol?.type).toBe("TEXT");
			expect(contextCol?.notnull).toBe(0); // Nullable
		});

		it("fresh DB has both canonical-relation triggers", () => {
			db = createDatabase(dbPath);
			applySchema(db);

			const triggers = db
				.query(
					"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_edges' ORDER BY name",
				)
				.all() as Array<{ name: string }>;

			const triggerNames = triggers.map((t) => t.name);
			expect(triggerNames).toContain("memory_edges_canonical_relation_insert");
			expect(triggerNames).toContain("memory_edges_canonical_relation_update");
			expect(triggerNames.length).toBe(2);
		});
	});

	describe("edge-graph-normalization.AC1.2: Existing DB gains context column via ALTER TABLE", () => {
		it("ALTER TABLE adds context column to existing DB without losing data", () => {
			// Create old schema (without context column)
			db = new Database(dbPath);
			db.run("PRAGMA journal_mode = WAL");
			db.run("PRAGMA auto_vacuum = INCREMENTAL");

			// Create memory_edges table without context column
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
				) STRICT
			`);

			// Insert test data
			const testId = "test-edge-1";
			const testSourceKey = "key1";
			const testTargetKey = "key2";
			const testRelation = "related_to";
			const now = new Date().toISOString();

			db.run(
				`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
				[testId, testSourceKey, testTargetKey, testRelation, now, now],
			);

			db.close();

			// Now run applySchema — should add context column via ALTER TABLE
			db = createDatabase(dbPath);
			applySchema(db);

			// Verify context column exists
			const cols = db.query("PRAGMA table_info(memory_edges)").all() as Array<{
				name: string;
				type: string;
			}>;
			const contextCol = cols.find((c) => c.name === "context");
			expect(contextCol).toBeDefined();

			// Verify test data survived
			const row = db.query("SELECT * FROM memory_edges WHERE id = ?").get(testId) as {
				id: string;
				source_key: string;
				target_key: string;
				relation: string;
				context: string | null;
			} | null;

			expect(row).toBeDefined();
			expect(row?.id).toBe(testId);
			expect(row?.source_key).toBe(testSourceKey);
			expect(row?.target_key).toBe(testTargetKey);
			expect(row?.relation).toBe(testRelation);
			expect(row?.context).toBeNull(); // New column should be NULL for existing rows
		});
	});

	describe("edge-graph-normalization.AC1.3: Triggers are created idempotently", () => {
		it("both triggers exist after applySchema", () => {
			db = createDatabase(dbPath);
			applySchema(db);

			const triggers = db
				.query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_edges'")
				.all() as Array<{ name: string }>;

			expect(triggers.length).toBe(2);

			const names = new Set(triggers.map((t) => t.name));
			expect(names.has("memory_edges_canonical_relation_insert")).toBe(true);
			expect(names.has("memory_edges_canonical_relation_update")).toBe(true);
		});

		it("trigger SQL contains the canonical list", () => {
			db = createDatabase(dbPath);
			applySchema(db);

			const insertTrigger = db
				.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?")
				.get("memory_edges_canonical_relation_insert") as { sql: string } | null;

			expect(insertTrigger).toBeDefined();
			const triggerSql = insertTrigger?.sql ?? "";

			// Verify all canonical relations are in the NOT IN clause
			for (const relation of CANONICAL_RELATIONS) {
				expect(triggerSql).toContain(`'${relation}'`);
			}
		});
	});

	describe("edge-graph-normalization.AC1.4: applySchema is idempotent", () => {
		it("calling applySchema twice does not error and preserves data", () => {
			db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			db.run(
				`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
				["edge-1", "key-a", "key-b", "related_to", now, now],
			);

			// Count triggers before second applySchema
			const triggersBefore = db
				.query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_edges'")
				.all() as Array<{ name: string }>;
			const countBefore = triggersBefore.length;

			// Call applySchema again — should be idempotent
			expect(() => applySchema(db)).not.toThrow();

			// Verify trigger count unchanged
			const triggersAfter = db
				.query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_edges'")
				.all() as Array<{ name: string }>;
			const countAfter = triggersAfter.length;
			expect(countAfter).toBe(countBefore);

			// Verify data unchanged
			const row = db.query("SELECT * FROM memory_edges WHERE id = ?").get("edge-1") as {
				id: string;
				source_key: string;
			} | null;
			expect(row?.id).toBe("edge-1");
		});

		it("trigger count is exactly 2 after multiple applySchema calls", () => {
			db = createDatabase(dbPath);
			applySchema(db);
			applySchema(db);
			applySchema(db);

			const triggers = db
				.query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_edges'")
				.all() as Array<{ name: string }>;

			expect(triggers.length).toBe(2);
		});
	});

	describe("edge-graph-normalization.AC3.2: INSERT with non-canonical relation fails", () => {
		it("direct INSERT with non-canonical relation raises trigger error", () => {
			db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();

			expect(() => {
				db.run(
					`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at)
					VALUES (?, ?, ?, ?, ?, ?)`,
					["edge-1", "key-a", "key-b", "bespoke-thing", now, now],
				);
			}).toThrow();
		});

		it("trigger error message contains valid relation list", () => {
			db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();

			let thrownError: unknown;
			try {
				db.run(
					`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at)
					VALUES (?, ?, ?, ?, ?, ?)`,
					["edge-1", "key-a", "key-b", "invalid_relation", now, now],
				);
			} catch (e) {
				thrownError = e;
			}

			expect(thrownError).toBeDefined();
			const errorMsg = String(thrownError);
			expect(errorMsg).toContain("Invalid relation");
			expect(errorMsg).toContain("related_to");
			expect(errorMsg).toContain("informs");
		});
	});

	describe("edge-graph-normalization.AC3.3: UPDATE with non-canonical relation fails", () => {
		it("UPDATE SET relation to non-canonical value raises trigger error", () => {
			db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();

			// Insert with valid relation
			db.run(
				`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
				["edge-1", "key-a", "key-b", "related_to", now, now],
			);

			// Try to update to invalid relation
			expect(() => {
				db.run("UPDATE memory_edges SET relation = ? WHERE id = ?", ["bespoke-thing", "edge-1"]);
			}).toThrow();
		});

		it("UPDATE to another canonical relation succeeds", () => {
			db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();

			// Insert with one canonical relation
			db.run(
				`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
				["edge-1", "key-a", "key-b", "related_to", now, now],
			);

			// Update to another canonical relation — should succeed
			expect(() => {
				db.run("UPDATE memory_edges SET relation = ? WHERE id = ?", ["informs", "edge-1"]);
			}).not.toThrow();

			// Verify update took effect
			const row = db.query("SELECT relation FROM memory_edges WHERE id = ?").get("edge-1") as {
				relation: string;
			} | null;
			expect(row?.relation).toBe("informs");
		});
	});

	describe("Trigger-const sync check (nice-to-have)", () => {
		it("trigger SQL reflects CANONICAL_RELATIONS exactly", () => {
			db = createDatabase(dbPath);
			applySchema(db);

			const insertTrigger = db
				.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?")
				.get("memory_edges_canonical_relation_insert") as { sql: string } | null;

			expect(insertTrigger?.sql).toBeDefined();
			const triggerSql = insertTrigger?.sql ?? "";

			// Extract the NOT IN clause values
			const notInMatch = triggerSql.match(/NOT IN \(([^)]+)\)/);
			expect(notInMatch).toBeDefined();

			const notInClause = notInMatch?.[1] ?? "";
			// Split on comma and clean up quotes
			const triggeredRelations = notInClause
				.split(",")
				.map((s) => s.trim().replace(/^'|'$/g, ""))
				.filter((s) => s.length > 0);

			// Should match CANONICAL_RELATIONS
			const expectedRelations = [...CANONICAL_RELATIONS].sort();
			const actualRelations = triggeredRelations.sort();

			expect(actualRelations).toEqual(expectedRelations);
		});

		it("canonical relations in trigger match the exported CANONICAL_RELATIONS const", () => {
			db = createDatabase(dbPath);
			applySchema(db);

			// Verify each canonical relation can be inserted without error
			let insertCount = 0;
			for (const relation of CANONICAL_RELATIONS) {
				const now = new Date().toISOString();
				const edgeId = `edge-${insertCount}`;

				expect(() => {
					db.run(
						`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at)
						VALUES (?, ?, ?, ?, ?, ?)`,
						[edgeId, "key-a", "key-b", relation, now, now],
					);
				}).not.toThrow();

				insertCount++;
			}

			// Verify all were inserted
			const count = db.query("SELECT COUNT(*) as cnt FROM memory_edges").get() as { cnt: number };
			expect(count.cnt).toBe(CANONICAL_RELATIONS.length);
		});
	});
});
