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
});
