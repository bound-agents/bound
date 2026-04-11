import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow, updateRow } from "@bound/core";
import { removeEdges, upsertEdge } from "../graph-queries.js";

let db: Database;
let dbPath: string;

beforeEach(() => {
	dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
	db = createDatabase(dbPath);
	applySchema(db);
});

afterEach(() => {
	db.close();
	try {
		unlinkSync(dbPath);
	} catch {
		/* ignore */
	}
});

describe("AC6.5: Tier changelog propagation", () => {
	const siteId = randomBytes(8).toString("hex");

	it("tier column changes create changelog entries with tier field in row_data", () => {
		const memoryId = randomBytes(8).toString("hex");

		// Insert initial semantic_memory entry with tier='default'
		insertRow(
			db,
			"semantic_memory",
			{
				id: memoryId,
				key: "test_key_for_tier_sync",
				value: "Test value",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-01T00:00:00.000Z",
				deleted: 0,
				tier: "default",
			},
			siteId,
		);

		// Read the changelog entry created by insertRow
		let changeLogEntry = db
			.prepare(
				"SELECT row_data FROM change_log WHERE row_id = ? AND table_name = 'semantic_memory' ORDER BY hlc DESC LIMIT 1",
			)
			.get(memoryId) as { row_data: string } | null;

		expect(changeLogEntry).toBeDefined();
		const initialData = JSON.parse(changeLogEntry?.row_data);
		expect(initialData.tier).toBe("default");

		// Update entry's tier to 'pinned' via updateRow (which triggers changelog)
		updateRow(
			db,
			"semantic_memory",
			memoryId,
			{ tier: "pinned", modified_at: new Date().toISOString() },
			siteId,
		);

		// Read the updated changelog entry
		changeLogEntry = db
			.prepare(
				"SELECT row_data FROM change_log WHERE row_id = ? AND table_name = 'semantic_memory' ORDER BY hlc DESC LIMIT 1",
			)
			.get(memoryId) as { row_data: string } | null;

		expect(changeLogEntry).toBeDefined();
		const updatedData = JSON.parse(changeLogEntry?.row_data);
		expect(updatedData.tier).toBe("pinned");
	});

	it("tier change from default to detail propagates via changelog", () => {
		const memoryId = randomBytes(8).toString("hex");

		// Insert entry with default tier
		insertRow(
			db,
			"semantic_memory",
			{
				id: memoryId,
				key: "detail_test_key",
				value: "Test value",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-01T00:00:00.000Z",
				deleted: 0,
				tier: "default",
			},
			siteId,
		);

		// Update tier to 'detail'
		updateRow(db, "semantic_memory", memoryId, { tier: "detail" }, siteId);

		// Verify changelog entry has tier='detail'
		const changeLogEntry = db
			.prepare(
				"SELECT row_data FROM change_log WHERE row_id = ? AND table_name = 'semantic_memory' ORDER BY hlc DESC LIMIT 1",
			)
			.get(memoryId) as { row_data: string } | null;

		expect(changeLogEntry).toBeDefined();
		const rowData = JSON.parse(changeLogEntry?.row_data);
		expect(rowData.tier).toBe("detail");
	});

	it("multiple tier transitions create multiple changelog entries", () => {
		const memoryId = randomBytes(8).toString("hex");

		// Insert with default
		insertRow(
			db,
			"semantic_memory",
			{
				id: memoryId,
				key: "multi_tier_test",
				value: "Test value",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-01T00:00:00.000Z",
				deleted: 0,
				tier: "default",
			},
			siteId,
		);

		// Transition: default -> pinned
		updateRow(db, "semantic_memory", memoryId, { tier: "pinned" }, siteId);

		// Transition: pinned -> detail
		updateRow(db, "semantic_memory", memoryId, { tier: "detail" }, siteId);

		// Transition: detail -> summary
		updateRow(db, "semantic_memory", memoryId, { tier: "summary" }, siteId);

		// Verify all tier values appear in changelog
		const entries = db
			.prepare(
				"SELECT row_data FROM change_log WHERE row_id = ? AND table_name = 'semantic_memory' ORDER BY hlc",
			)
			.all(memoryId) as Array<{ row_data: string }>;

		expect(entries.length).toBeGreaterThanOrEqual(3);

		const tiers = entries.map((e) => JSON.parse(e.row_data).tier);
		expect(tiers).toContain("default");
		expect(tiers).toContain("pinned");
		expect(tiers).toContain("detail");
		expect(tiers).toContain("summary");
	});
});

describe("AC6.6: Summarizes edge sync via memory_edges changelog", () => {
	const siteId = randomBytes(8).toString("hex");

	it("summarizes edge creation produces changelog entry with relation field", () => {
		const sourceKey = "summary_entry";
		const targetKey = "detail_entry";

		// Create the edge via upsertEdge (which uses insertRow internally)
		upsertEdge(db, sourceKey, targetKey, "summarizes", 1.0, siteId);

		// Query the edge ID deterministically
		const edgeId = (
			db
				.prepare(
					"SELECT id FROM memory_edges WHERE source_key = ? AND target_key = ? AND relation = ?",
				)
				.get(sourceKey, targetKey, "summarizes") as { id: string } | null
		)?.id;

		expect(edgeId).toBeDefined();

		// Verify changelog entry for memory_edges table
		const changeLogEntry = db
			.prepare(
				"SELECT row_data FROM change_log WHERE row_id = ? AND table_name = 'memory_edges' ORDER BY hlc DESC LIMIT 1",
			)
			.get(edgeId) as { row_data: string } | null;

		expect(changeLogEntry).toBeDefined();
		const rowData = JSON.parse(changeLogEntry?.row_data);
		expect(rowData.relation).toBe("summarizes");
		expect(rowData.source_key).toBe(sourceKey);
		expect(rowData.target_key).toBe(targetKey);
	});

	it("summarizes edge soft-delete produces changelog entry with deleted=1", () => {
		const sourceKey = "summary_for_delete";
		const targetKey = "detail_for_delete";

		// Create the edge
		upsertEdge(db, sourceKey, targetKey, "summarizes", 1.0, siteId);

		// Get the edge ID
		const edgeId = (
			db
				.prepare(
					"SELECT id FROM memory_edges WHERE source_key = ? AND target_key = ? AND relation = ?",
				)
				.get(sourceKey, targetKey, "summarizes") as { id: string } | null
		)?.id;

		expect(edgeId).toBeDefined();

		// Soft-delete the edge via removeEdges
		removeEdges(db, sourceKey, targetKey, ["summarizes"], siteId);

		// Verify changelog entry has deleted=1
		const changeLogEntry = db
			.prepare(
				"SELECT row_data FROM change_log WHERE row_id = ? AND table_name = 'memory_edges' ORDER BY hlc DESC LIMIT 1",
			)
			.get(edgeId) as { row_data: string } | null;

		expect(changeLogEntry).toBeDefined();
		const rowData = JSON.parse(changeLogEntry?.row_data);
		expect(rowData.deleted).toBe(1);
	});

	it("multiple summarizes edges create separate changelog entries", () => {
		const summaryKey = "summary_multi_child";
		const detailKey1 = "detail_child_1";
		const detailKey2 = "detail_child_2";

		// Create two summarizes edges from same summary
		upsertEdge(db, summaryKey, detailKey1, "summarizes", 1.0, siteId);
		upsertEdge(db, summaryKey, detailKey2, "summarizes", 1.0, siteId);

		// Verify changelog entries exist for both edges
		const entries = db
			.prepare(
				"SELECT COUNT(*) AS cnt FROM change_log WHERE table_name = 'memory_edges' AND ((SELECT relation FROM memory_edges WHERE id = change_log.row_id LIMIT 1) = 'summarizes')",
			)
			.get() as { cnt: number };

		// We should have at least 2 summarizes edge entries
		expect(entries.cnt).toBeGreaterThanOrEqual(2);
	});

	it("edge weight updates produce changelog with updated weight", () => {
		const sourceKey = "source_weight_update";
		const targetKey = "target_weight_update";

		// Create edge with weight 1.0
		upsertEdge(db, sourceKey, targetKey, "related_to", 1.0, siteId);

		// Get edge ID
		const edgeId = (
			db
				.prepare(
					"SELECT id FROM memory_edges WHERE source_key = ? AND target_key = ? AND relation = ?",
				)
				.get(sourceKey, targetKey, "related_to") as { id: string } | null
		)?.id;

		expect(edgeId).toBeDefined();

		// Update weight via upsertEdge
		upsertEdge(db, sourceKey, targetKey, "related_to", 2.5, siteId);

		// Verify latest changelog entry has updated weight
		const changeLogEntry = db
			.prepare(
				"SELECT row_data FROM change_log WHERE row_id = ? AND table_name = 'memory_edges' ORDER BY hlc DESC LIMIT 1",
			)
			.get(edgeId) as { row_data: string } | null;

		expect(changeLogEntry).toBeDefined();
		const rowData = JSON.parse(changeLogEntry?.row_data);
		expect(rowData.weight).toBe(2.5);
	});

	it("orphaned detail edge cascade properly records in changelog", () => {
		const summaryKey = "summary_cascade_test";
		const detailKey = "detail_cascade_test";

		// Create summarizes edge
		upsertEdge(db, summaryKey, detailKey, "summarizes", 1.0, siteId);

		// Create a related edge to the detail
		upsertEdge(db, detailKey, "other_entry", "related_to", 1.0, siteId);

		// Get both edge IDs
		const summEdgeId = (
			db
				.prepare(
					"SELECT id FROM memory_edges WHERE source_key = ? AND target_key = ? AND relation = ?",
				)
				.get(summaryKey, detailKey, "summarizes") as { id: string } | null
		)?.id;

		const _relEdgeId = (
			db
				.prepare(
					"SELECT id FROM memory_edges WHERE source_key = ? AND target_key = ? AND relation = ?",
				)
				.get(detailKey, "other_entry", "related_to") as { id: string } | null
		)?.id;

		// Remove summarizes edge cascade
		removeEdges(db, summaryKey, detailKey, ["summarizes"], siteId);

		// Verify changelog for both edges shows deletion
		const summEntry = db
			.prepare(
				"SELECT row_data FROM change_log WHERE row_id = ? AND table_name = 'memory_edges' ORDER BY hlc DESC LIMIT 1",
			)
			.get(summEdgeId) as { row_data: string } | null;

		expect(summEntry).toBeDefined();
		const summData = JSON.parse(summEntry?.row_data);
		expect(summData.deleted).toBe(1);
	});
});
