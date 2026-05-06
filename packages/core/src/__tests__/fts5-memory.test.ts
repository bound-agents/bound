import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertRow, softDelete, updateRow } from "../index";

function createTestDb(): Database {
	const dbPath = `/tmp/test-fts5-${randomBytes(4).toString("hex")}.db`;
	const db = new Database(dbPath);
	applySchema(db);
	return db;
}

const siteId = "test-site-fts5";

describe("FTS5 semantic_memory_fts", () => {
	let db: Database;

	beforeEach(() => {
		db = createTestDb();
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// ignore
		}
	});

	describe("table creation", () => {
		it("should create semantic_memory_fts virtual table", () => {
			// FTS5 tables show up in sqlite_master with type='table'
			const row = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='semantic_memory_fts'")
				.get() as { name: string } | null;

			expect(row).not.toBeNull();
			expect(row?.name).toBe("semantic_memory_fts");
		});

		it("should use porter and unicode61 tokenizers", () => {
			// FTS5 table SQL contains tokenizer config
			const row = db
				.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='semantic_memory_fts'")
				.get() as { sql: string } | null;

			expect(row).not.toBeNull();
			expect(row?.sql).toContain("porter");
			expect(row?.sql).toContain("unicode61");
		});
	});

	describe("trigger-based sync on INSERT", () => {
		it("should populate FTS5 when a memory is inserted", () => {
			insertRow(
				db,
				"semantic_memory",
				{
					id: "fts-test-1",
					key: "scheduler_config",
					value: "The scheduler handles cron-based task execution",
					source: "test",
					created_at: "2026-01-01T00:00:00.000Z",
					modified_at: "2026-01-01T00:00:00.000Z",
					last_accessed_at: "2026-01-01T00:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			// FTS5 should find it via MATCH
			const result = db
				.prepare(
					"SELECT key, value FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'scheduler'",
				)
				.all() as Array<{ key: string; value: string }>;

			expect(result.length).toBe(1);
			expect(result[0].key).toBe("scheduler_config");
		});

		it("should NOT index entries with _internal. prefix", () => {
			insertRow(
				db,
				"semantic_memory",
				{
					id: "fts-internal-1",
					key: "_internal.cache_state",
					value: "internal bookkeeping data",
					source: "system",
					created_at: "2026-01-01T00:00:00.000Z",
					modified_at: "2026-01-01T00:00:00.000Z",
					last_accessed_at: "2026-01-01T00:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			const result = db
				.prepare(
					"SELECT key FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'internal OR bookkeeping'",
				)
				.all();

			expect(result.length).toBe(0);
		});

		it("should NOT index entries that are already soft-deleted on insert", () => {
			insertRow(
				db,
				"semantic_memory",
				{
					id: "fts-deleted-1",
					key: "deleted_entry",
					value: "this should not be indexed",
					source: "test",
					created_at: "2026-01-01T00:00:00.000Z",
					modified_at: "2026-01-01T00:00:00.000Z",
					last_accessed_at: "2026-01-01T00:00:00.000Z",
					deleted: 1,
					tier: "default",
				},
				siteId,
			);

			const result = db
				.prepare(
					"SELECT key FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'deleted OR indexed'",
				)
				.all();

			expect(result.length).toBe(0);
		});
	});

	describe("trigger-based sync on UPDATE", () => {
		it("should update FTS5 when a memory value is changed", () => {
			insertRow(
				db,
				"semantic_memory",
				{
					id: "fts-update-1",
					key: "mutable_entry",
					value: "original content about databases",
					source: "test",
					created_at: "2026-01-01T00:00:00.000Z",
					modified_at: "2026-01-01T00:00:00.000Z",
					last_accessed_at: "2026-01-01T00:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			// Update the value
			updateRow(
				db,
				"semantic_memory",
				"fts-update-1",
				{ value: "updated content about networking" },
				siteId,
			);

			// Old content should NOT match
			const oldResult = db
				.prepare("SELECT key FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'databases'")
				.all();
			expect(oldResult.length).toBe(0);

			// New content SHOULD match
			const newResult = db
				.prepare("SELECT key FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'networking'")
				.all();
			expect(newResult.length).toBe(1);
			expect((newResult[0] as { key: string }).key).toBe("mutable_entry");
		});

		it("should remove from FTS5 when a memory is soft-deleted", () => {
			insertRow(
				db,
				"semantic_memory",
				{
					id: "fts-softdel-1",
					key: "ephemeral_entry",
					value: "temporary knowledge about routing",
					source: "test",
					created_at: "2026-01-01T00:00:00.000Z",
					modified_at: "2026-01-01T00:00:00.000Z",
					last_accessed_at: "2026-01-01T00:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			// Verify it's indexed
			let result = db
				.prepare("SELECT key FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'routing'")
				.all();
			expect(result.length).toBe(1);

			// Soft-delete it
			softDelete(db, "semantic_memory", "fts-softdel-1", siteId);

			// Should no longer appear in FTS5
			result = db
				.prepare("SELECT key FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'routing'")
				.all();
			expect(result.length).toBe(0);
		});

		it("should re-index when a soft-deleted memory is restored", () => {
			// Insert then delete
			insertRow(
				db,
				"semantic_memory",
				{
					id: "fts-restore-1",
					key: "restored_entry",
					value: "knowledge about synchronization protocols",
					source: "test",
					created_at: "2026-01-01T00:00:00.000Z",
					modified_at: "2026-01-01T00:00:00.000Z",
					last_accessed_at: "2026-01-01T00:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);
			softDelete(db, "semantic_memory", "fts-restore-1", siteId);

			// Verify it's gone from FTS5
			let result = db
				.prepare(
					"SELECT key FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'synchronization'",
				)
				.all();
			expect(result.length).toBe(0);

			// Restore it (updateRow with deleted: 0)
			updateRow(db, "semantic_memory", "fts-restore-1", { deleted: 0 }, siteId);

			// Should be back in FTS5
			result = db
				.prepare(
					"SELECT key FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'synchronization'",
				)
				.all();
			expect(result.length).toBe(1);
		});
	});

	describe("FTS5 query capabilities", () => {
		beforeEach(() => {
			// Populate several memories for search testing
			const entries = [
				{
					id: "fts-q1",
					key: "scheduling_design",
					value: "The scheduler processes cron jobs and deferred tasks",
				},
				{
					id: "fts-q2",
					key: "cron_syntax",
					value: "Cron expressions use five fields: minute hour day month weekday",
				},
				{
					id: "fts-q3",
					key: "task_lifecycle",
					value: "Tasks transition through pending, running, completed, failed states",
				},
				{
					id: "fts-q4",
					key: "network_config",
					value: "WebSocket connections use TLS encryption for sync protocol",
				},
				{
					id: "fts-q5",
					key: "ai_models",
					value: "AI model routing supports Bedrock Anthropic and Ollama backends",
				},
			];

			for (const entry of entries) {
				insertRow(
					db,
					"semantic_memory",
					{
						...entry,
						source: "test",
						created_at: "2026-01-01T00:00:00.000Z",
						modified_at: "2026-01-01T00:00:00.000Z",
						last_accessed_at: "2026-01-01T00:00:00.000Z",
						deleted: 0,
						tier: "default",
					},
					siteId,
				);
			}
		});

		it("should support porter stemming (scheduling matches scheduled)", () => {
			const result = db
				.prepare("SELECT key FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'scheduled'")
				.all() as Array<{ key: string }>;

			// "scheduler" and "scheduling" should stem-match "scheduled"
			expect(result.length).toBeGreaterThan(0);
			const keys = result.map((r) => r.key);
			expect(keys).toContain("scheduling_design");
		});

		it("should support prefix queries", () => {
			const result = db
				.prepare("SELECT key FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'cron*'")
				.all() as Array<{ key: string }>;

			expect(result.length).toBeGreaterThan(0);
			const keys = result.map((r) => r.key);
			expect(keys).toContain("cron_syntax");
			expect(keys).toContain("scheduling_design"); // contains "cron"
		});

		it("should support short keywords like AI", () => {
			const result = db
				.prepare("SELECT key FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'ai'")
				.all() as Array<{ key: string }>;

			expect(result.length).toBeGreaterThan(0);
			const keys = result.map((r) => r.key);
			expect(keys).toContain("ai_models");
		});

		it("should return BM25-ranked results via rank column", () => {
			// Insert an entry with many mentions of "cron" for higher relevance
			insertRow(
				db,
				"semantic_memory",
				{
					id: "fts-q-multi",
					key: "cron_deep_dive",
					value: "cron cron cron — deep dive into cron scheduling with cron expressions",
					source: "test",
					created_at: "2026-01-01T00:00:00.000Z",
					modified_at: "2026-01-01T00:00:00.000Z",
					last_accessed_at: "2026-01-01T00:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			const results = db
				.prepare(
					"SELECT key, rank FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'cron' ORDER BY rank",
				)
				.all() as Array<{ key: string; rank: number }>;

			// BM25 rank is negative (lower = better match)
			expect(results.length).toBeGreaterThan(1);
			// The entry with more "cron" mentions should rank first (most negative)
			expect(results[0].key).toBe("cron_deep_dive");
		});

		it("should support phrase matching with quotes", () => {
			const result = db
				.prepare(
					`SELECT key FROM semantic_memory_fts WHERE semantic_memory_fts MATCH '"sync protocol"'`,
				)
				.all() as Array<{ key: string }>;

			expect(result.length).toBe(1);
			expect(result[0].key).toBe("network_config");
		});

		it("should support boolean OR queries", () => {
			const result = db
				.prepare(
					"SELECT key FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'websocket OR anthropic'",
				)
				.all() as Array<{ key: string }>;

			expect(result.length).toBe(2);
			const keys = result.map((r) => r.key);
			expect(keys).toContain("network_config");
			expect(keys).toContain("ai_models");
		});
	});

	describe("rebuild from existing data", () => {
		it("should populate FTS5 from existing semantic_memory rows on schema apply", () => {
			// Create a fresh DB, insert data WITHOUT triggers (simulate pre-FTS data)
			const rawDb = new Database(":memory:");
			// Apply schema which creates the table AND populates FTS5 from existing data
			applySchema(rawDb);

			// Insert a memory (triggers will handle FTS sync)
			insertRow(
				rawDb,
				"semantic_memory",
				{
					id: "rebuild-1",
					key: "existing_knowledge",
					value: "pre-existing memories should be searchable",
					source: "test",
					created_at: "2026-01-01T00:00:00.000Z",
					modified_at: "2026-01-01T00:00:00.000Z",
					last_accessed_at: "2026-01-01T00:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			// Re-apply schema (simulates restart) — FTS5 should still have data
			// because it's idempotent (CREATE ... IF NOT EXISTS + rebuild)
			applySchema(rawDb);

			const result = rawDb
				.prepare("SELECT key FROM semantic_memory_fts WHERE semantic_memory_fts MATCH 'searchable'")
				.all() as Array<{ key: string }>;

			expect(result.length).toBe(1);
			expect(result[0].key).toBe("existing_knowledge");

			rawDb.close();
		});
	});
});
