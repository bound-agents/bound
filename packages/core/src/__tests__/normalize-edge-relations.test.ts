import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateRow } from "../change-log";
import { applySchema, createDatabase } from "../index";
import { normalizeEdgeRelations } from "../normalize-edge-relations";

interface TestDb {
	db: ReturnType<typeof createDatabase>;
	dbPath: string;
}

let testDb: TestDb;
const TEST_SITE_ID = "test-site-001";

beforeEach(async () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "normalize-edges-"));
	const dbPath = join(tmpDir, "test.db");
	const db = createDatabase(dbPath);

	testDb = { db, dbPath };

	// Apply full schema
	applySchema(testDb.db);
});

afterEach(async () => {
	testDb.db.close();
});

// Helper to insert test data with non-canonical relations (bypass triggers temporarily)
function insertNonCanonicalEdge(
	id: string,
	source_key: string,
	target_key: string,
	relation: string,
	weight: number,
	context: string | null,
) {
	// Drop triggers temporarily
	testDb.db.exec(`
		DROP TRIGGER IF EXISTS memory_edges_canonical_relation_insert;
		DROP TRIGGER IF EXISTS memory_edges_canonical_relation_update;
	`);

	// Insert the data
	testDb.db
		.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, context, created_at, modified_at, deleted)
		 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)`,
		)
		.run(id, source_key, target_key, relation, weight, context);

	// Recreate the triggers by running the relevant part of applySchema
	const canonicalList = [
		"related_to",
		"informs",
		"supports",
		"extends",
		"complements",
		"contrasts-with",
		"competes-with",
		"cites",
		"summarizes",
		"synthesizes",
	]
		.map((r) => `'${r}'`)
		.join(", ");

	testDb.db.run(`
		CREATE TRIGGER IF NOT EXISTS memory_edges_canonical_relation_insert
		BEFORE INSERT ON memory_edges
		FOR EACH ROW WHEN NEW.relation NOT IN (${canonicalList})
		BEGIN SELECT RAISE(ABORT, 'Invalid relation. Must be one of: related_to, informs, supports, extends, complements, contrasts-with, competes-with, cites, summarizes, synthesizes. Use context column for bespoke phrasing.'); END;
	`);

	testDb.db.run(`
		CREATE TRIGGER IF NOT EXISTS memory_edges_canonical_relation_update
		BEFORE UPDATE OF relation ON memory_edges
		FOR EACH ROW WHEN NEW.relation NOT IN (${canonicalList})
		BEGIN SELECT RAISE(ABORT, 'Invalid relation. Must be one of: related_to, informs, supports, extends, complements, contrasts-with, competes-with, cites, summarizes, synthesizes. Use context column for bespoke phrasing.'); END;
	`);
}

describe("normalizeEdgeRelations", () => {
	describe("spelling variant mapping (AC2.2)", () => {
		it("maps related_to variants to canonical relation", async () => {
			insertNonCanonicalEdge("edge1", "mem1", "mem2", "related-to", 1.0, null);
			insertNonCanonicalEdge("edge2", "mem3", "mem4", "relates_to", 1.0, null);
			insertNonCanonicalEdge("edge3", "mem5", "mem6", "relates", 1.0, null);

			// Run normalization
			const summary = normalizeEdgeRelations(testDb.db, TEST_SITE_ID);

			// Verify counts
			expect(summary.variants_mapped).toBe(3);
			expect(summary.moved_to_context).toBe(0);
			expect(summary.collisions_merged).toBe(0);
			expect(summary.total_scanned).toBe(3);

			// Verify each row now has canonical relation
			const edge1 = testDb.db
				.prepare("SELECT relation, context FROM memory_edges WHERE id = ?")
				.get("edge1") as {
				relation: string;
				context: string | null;
			};
			expect(edge1.relation).toBe("related_to");
			expect(edge1.context).toBeNull();

			const edge2 = testDb.db
				.prepare("SELECT relation, context FROM memory_edges WHERE id = ?")
				.get("edge2") as {
				relation: string;
				context: string | null;
			};
			expect(edge2.relation).toBe("related_to");
			expect(edge2.context).toBeNull();

			const edge3 = testDb.db
				.prepare("SELECT relation, context FROM memory_edges WHERE id = ?")
				.get("edge3") as {
				relation: string;
				context: string | null;
			};
			expect(edge3.relation).toBe("related_to");
			expect(edge3.context).toBeNull();
		});

		it("maps other canonical variants (informs, supports, etc.)", async () => {
			insertNonCanonicalEdge("edge1", "mem1", "mem2", "informed-by", 1.0, null);
			insertNonCanonicalEdge("edge2", "mem3", "mem4", "supported-by", 1.0, null);
			insertNonCanonicalEdge("edge3", "mem5", "mem6", "summarize", 1.0, null);

			const summary = normalizeEdgeRelations(testDb.db, TEST_SITE_ID);

			expect(summary.variants_mapped).toBe(3);
			expect(summary.total_scanned).toBe(3);

			const edge1 = testDb.db
				.prepare("SELECT relation FROM memory_edges WHERE id = ?")
				.get("edge1") as {
				relation: string;
			};
			expect(edge1.relation).toBe("informs");

			const edge2 = testDb.db
				.prepare("SELECT relation FROM memory_edges WHERE id = ?")
				.get("edge2") as {
				relation: string;
			};
			expect(edge2.relation).toBe("supports");

			const edge3 = testDb.db
				.prepare("SELECT relation FROM memory_edges WHERE id = ?")
				.get("edge3") as {
				relation: string;
			};
			expect(edge3.relation).toBe("summarizes");
		});
	});

	describe("bespoke relation handling (AC2.3)", () => {
		it("rewrites bespoke relations to related_to and preserves original in context", async () => {
			insertNonCanonicalEdge("edge1", "mem1", "mem2", "durable-execution-pattern", 1.0, null);
			insertNonCanonicalEdge("edge2", "mem3", "mem4", "Both CRDT implementations", 1.0, null);

			const summary = normalizeEdgeRelations(testDb.db, TEST_SITE_ID);

			expect(summary.moved_to_context).toBe(2);
			expect(summary.variants_mapped).toBe(0);

			const edge1 = testDb.db
				.prepare("SELECT relation, context FROM memory_edges WHERE id = ?")
				.get("edge1") as {
				relation: string;
				context: string;
			};
			expect(edge1.relation).toBe("related_to");
			expect(edge1.context).toBe("durable-execution-pattern");

			const edge2 = testDb.db
				.prepare("SELECT relation, context FROM memory_edges WHERE id = ?")
				.get("edge2") as {
				relation: string;
				context: string;
			};
			expect(edge2.relation).toBe("related_to");
			expect(edge2.context).toBe("Both CRDT implementations");
		});

		it("joins new context with existing context", async () => {
			insertNonCanonicalEdge("edge1", "mem1", "mem2", "custom-relation", 1.0, "existing note");

			normalizeEdgeRelations(testDb.db, TEST_SITE_ID);

			const edge1 = testDb.db
				.prepare("SELECT relation, context FROM memory_edges WHERE id = ?")
				.get("edge1") as {
				relation: string;
				context: string;
			};
			expect(edge1.relation).toBe("related_to");
			expect(edge1.context).toBe("custom-relation | existing note");
		});
	});

	describe("changelog integration (AC2.4)", () => {
		it("emits changelog entries for each normalized row", async () => {
			insertNonCanonicalEdge("edge1", "mem1", "mem2", "related-to", 1.0, null);
			insertNonCanonicalEdge("edge2", "mem3", "mem4", "bespoke-rel", 1.0, null);

			normalizeEdgeRelations(testDb.db, TEST_SITE_ID);

			const changelogEntries = testDb.db
				.prepare("SELECT * FROM change_log WHERE table_name = 'memory_edges'")
				.all() as Array<{
				hlc: string;
				table_name: string;
				row_id: string;
				op: string;
				site_id: string;
				row_data: string;
			}>;

			expect(changelogEntries.length).toBe(2);

			// Verify both have the test site_id
			for (const entry of changelogEntries) {
				expect(entry.site_id).toBe(TEST_SITE_ID);

				const rowData = JSON.parse(entry.row_data);
				// Verify the row_data reflects canonical relations
				if (entry.row_id === "edge1") {
					expect(rowData.relation).toBe("related_to");
				} else if (entry.row_id === "edge2") {
					expect(rowData.relation).toBe("related_to");
					expect(rowData.context).toBe("bespoke-rel");
				}
			}
		});
	});

	describe("summary counts (AC2.5)", () => {
		it("returns correct counts for mixed normalization", async () => {
			// Already canonical — should NOT be in the select query
			testDb.db
				.prepare(
					`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, context, created_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)`,
				)
				.run("edge1", "mem1", "mem2", "related_to", 1.0, null);

			testDb.db
				.prepare(
					`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, context, created_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)`,
				)
				.run("edge2", "mem3", "mem4", "informs", 1.0, null);

			// Variant
			insertNonCanonicalEdge("edge3", "mem5", "mem6", "relates_to", 1.0, null);

			// Bespoke
			insertNonCanonicalEdge("edge4", "mem7", "mem8", "custom-rel", 1.0, null);

			const summary = normalizeEdgeRelations(testDb.db, TEST_SITE_ID);

			// Only non-canonical rows are scanned
			expect(summary.total_scanned).toBe(2); // edge3 (variant) and edge4 (bespoke)
			expect(summary.variants_mapped).toBe(1); // edge3
			expect(summary.moved_to_context).toBe(1); // edge4
			expect(summary.collisions_merged).toBe(0);
		});

		it("returns all zeros on empty or fully canonical DB", async () => {
			testDb.db
				.prepare(
					`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, context, created_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)`,
				)
				.run("edge1", "mem1", "mem2", "related_to", 1.0, null);

			testDb.db
				.prepare(
					`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, context, created_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)`,
				)
				.run("edge2", "mem3", "mem4", "informs", 1.0, null);

			const summary = normalizeEdgeRelations(testDb.db, TEST_SITE_ID);

			expect(summary.total_scanned).toBe(0);
			expect(summary.variants_mapped).toBe(0);
			expect(summary.moved_to_context).toBe(0);
			expect(summary.collisions_merged).toBe(0);
		});
	});

	describe("idempotency (AC2.7)", () => {
		it("second run returns all zeros and creates no new changelog entries", async () => {
			insertNonCanonicalEdge("edge1", "mem1", "mem2", "related-to", 1.0, null); // Variant
			insertNonCanonicalEdge("edge2", "mem3", "mem4", "bespoke-rel", 1.0, null); // Bespoke

			// First run
			const summary1 = normalizeEdgeRelations(testDb.db, TEST_SITE_ID);
			expect(summary1.total_scanned).toBe(2); // Both edge1 (variant) and edge2 (bespoke) are non-canonical

			const changelogAfterFirstRun = testDb.db
				.prepare("SELECT COUNT(*) as cnt FROM change_log WHERE table_name = 'memory_edges'")
				.get() as { cnt: number };
			const firstRunCount = changelogAfterFirstRun.cnt;

			// Second run
			const summary2 = normalizeEdgeRelations(testDb.db, TEST_SITE_ID);

			// All should be zero now
			expect(summary2.total_scanned).toBe(0);
			expect(summary2.variants_mapped).toBe(0);
			expect(summary2.moved_to_context).toBe(0);
			expect(summary2.collisions_merged).toBe(0);

			// No new changelog entries
			const changelogAfterSecondRun = testDb.db
				.prepare("SELECT COUNT(*) as cnt FROM change_log WHERE table_name = 'memory_edges'")
				.get() as { cnt: number };
			expect(changelogAfterSecondRun.cnt).toBe(firstRunCount);
		});
	});

	describe("trigger interaction", () => {
		it("updateRow can change non-canonical relation to canonical via active trigger", async () => {
			// Insert row with non-canonical relation (trigger temporarily disabled)
			insertNonCanonicalEdge("edge1", "mem1", "mem2", "custom-rel", 1.0, null);

			// Verify the row exists with non-canonical relation
			const beforeUpdate = testDb.db
				.prepare("SELECT relation FROM memory_edges WHERE id = ?")
				.get("edge1") as { relation: string };
			expect(beforeUpdate.relation).toBe("custom-rel");

			// Now use updateRow to change it to canonical — should succeed
			updateRow(testDb.db, "memory_edges", "edge1", { relation: "related_to" }, TEST_SITE_ID);

			// Verify it changed
			const afterUpdate = testDb.db
				.prepare("SELECT relation FROM memory_edges WHERE id = ?")
				.get("edge1") as { relation: string };
			expect(afterUpdate.relation).toBe("related_to");

			// Verify changelog was created
			const changelogEntries = testDb.db
				.prepare("SELECT COUNT(*) as cnt FROM change_log WHERE table_name = 'memory_edges'")
				.get() as { cnt: number };
			expect(changelogEntries.cnt).toBe(1);
		});
	});

	describe("collision-merge (AC2.6)", () => {
		it("merges variant collision with canonical row", async () => {
			// Row A: canonical relation (survives)
			testDb.db
				.prepare(
					`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, context, created_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)`,
				)
				.run("rowA", "mem1", "mem2", "related_to", 0.5, "existing note");

			// Row B: spelling variant that normalizes to same relation (should be deleted)
			insertNonCanonicalEdge("rowB", "mem1", "mem2", "related-to", 0.8, null);

			const summary = normalizeEdgeRelations(testDb.db, TEST_SITE_ID);

			// Should have one collision merge
			expect(summary.collisions_merged).toBe(1);
			expect(summary.variants_mapped).toBe(0);

			// Row A should survive with updated weight and context
			const survivor = testDb.db
				.prepare("SELECT id, weight, context, deleted FROM memory_edges WHERE id = ?")
				.get("rowA") as {
				id: string;
				weight: number;
				context: string;
				deleted: number;
			};
			expect(survivor.deleted).toBe(0);
			expect(survivor.weight).toBe(0.8); // max(0.5, 0.8)
			expect(survivor.context).toBe("existing note"); // No new context since variant doesn't preserve

			// Row B should be soft-deleted
			const loser = testDb.db
				.prepare("SELECT id, deleted FROM memory_edges WHERE id = ?")
				.get("rowB") as { id: string; deleted: number };
			expect(loser.deleted).toBe(1);

			// Both should have changelog entries (update for survivor + soft-delete for loser)
			const changelogEntries = testDb.db
				.prepare("SELECT COUNT(*) as cnt FROM change_log WHERE table_name = 'memory_edges'")
				.get() as { cnt: number };
			expect(changelogEntries.cnt).toBe(2); // One update (rowA) + one soft-delete (rowB)
		});

		it("merges bespoke collision with canonical row", async () => {
			// Row C: canonical relation (survives)
			testDb.db
				.prepare(
					`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, context, created_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)`,
				)
				.run("rowC", "mem1", "mem2", "related_to", 1.0, null);

			// Row D: bespoke relation that normalizes to related_to (should be deleted)
			insertNonCanonicalEdge("rowD", "mem1", "mem2", "durable-execution-pattern", 2.0, "important");

			const summary = normalizeEdgeRelations(testDb.db, TEST_SITE_ID);

			// Should have one collision merge
			expect(summary.collisions_merged).toBe(1);
			expect(summary.moved_to_context).toBe(0);

			// Row C should survive with merged context
			const survivor = testDb.db
				.prepare("SELECT id, weight, context, deleted FROM memory_edges WHERE id = ?")
				.get("rowC") as {
				id: string;
				weight: number;
				context: string;
				deleted: number;
			};
			expect(survivor.deleted).toBe(0);
			expect(survivor.weight).toBe(2.0); // max(1.0, 2.0)
			expect(survivor.context).toBe("durable-execution-pattern | important"); // Merged context

			// Row D should be soft-deleted
			const loser = testDb.db
				.prepare("SELECT id, deleted FROM memory_edges WHERE id = ?")
				.get("rowD") as { id: string; deleted: number };
			expect(loser.deleted).toBe(1);
		});

		it("deduplicates context parts when merging", async () => {
			// Row E: has existing context "note"
			testDb.db
				.prepare(
					`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, context, created_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)`,
				)
				.run("rowE", "mem1", "mem2", "related_to", 1.0, "note");

			// Row F: bespoke with same context "note" (should not duplicate)
			insertNonCanonicalEdge("rowF", "mem1", "mem2", "custom-rel", 1.5, "note");

			normalizeEdgeRelations(testDb.db, TEST_SITE_ID);

			const survivor = testDb.db
				.prepare("SELECT context FROM memory_edges WHERE id = ?")
				.get("rowE") as { context: string };

			// Should only have "note" once, not "note | custom-rel | note"
			expect(survivor.context).toBe("note | custom-rel"); // Deduplicated
		});
	});
});
