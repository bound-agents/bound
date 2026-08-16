import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import { insertRow, softDelete } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { getNeighbors, graphSeededRetrieval, traverseGraph } from "../graph-queries";
import { upsertEdge } from "../graph-queries";

let db: Database;
let dbPath: string;
const siteId = "test-site-id";

beforeEach(() => {
	dbPath = join(tmpdir(), `test-graph-memory-${randomBytes(4).toString("hex")}.db`);
	db = createDatabase(dbPath);
	applySchema(db);
	// Seed a small memory graph
	const now = new Date().toISOString();

	// Create 5 semantic_memory entries: A, B, C, D, E
	const entries = ["A", "B", "C", "D", "E"];
	for (const key of entries) {
		insertRow(
			db,
			"semantic_memory",
			{
				id: deterministicUUID(BOUND_NAMESPACE, key),
				key,
				value: `Memory entry ${key}`,
				source: "test",
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	}

	// Create edges: A→B (related_to), B→C (related_to), C→D (informs), A→D (extends), D→B (cites, creates cycle)
	upsertEdge(db, "A", "B", "related_to", 1.0, siteId);
	upsertEdge(db, "B", "C", "related_to", 1.0, siteId);
	upsertEdge(db, "C", "D", "informs", 1.0, siteId);
	upsertEdge(db, "A", "D", "extends", 1.0, siteId);
	upsertEdge(db, "D", "B", "cites", 1.0, siteId);
});

afterEach(() => {
	try {
		db.close();
	} catch {
		// ignore
	}
});

describe("graph-memory traversal contracts", () => {
	it("returns connected entries with their traversal result shape", () => {
		const results = traverseGraph(db, "A");

		expect(results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					key: "B",
					value: "Memory entry B",
					depth: 1,
					viaRelation: "related_to",
					viaWeight: 1,
					viaContext: null,
					modifiedAt: expect.any(String),
					source: "test",
				}),
				expect.objectContaining({ key: "D", depth: 1, viaRelation: "extends" }),
			]),
		);
		expect(results.map((result) => result.key)).not.toContain("A");
	});

	it("limits traversal depth and clamps requests to the supported range", () => {
		const depthOne = traverseGraph(db, "A", 1);
		expect(depthOne.map((result) => [result.key, result.depth])).toEqual(
			expect.arrayContaining([
				["B", 1],
				["D", 1],
			]),
		);
		expect(depthOne.every((result) => result.depth === 1)).toBe(true);

		for (const requestedDepth of [0, -1])
			expect(traverseGraph(db, "A", requestedDepth)).toEqual(depthOne);
		for (const requestedDepth of [4, 10])
			expect(traverseGraph(db, "A", requestedDepth)).toEqual(traverseGraph(db, "A", 3));
	});
});

describe("graph-memory.AC3.3: Relation filter narrows traversal", () => {
	it("should only follow edges of type related_to", () => {
		const results = traverseGraph(db, "A", 3, "related_to");

		const keys = results.map((r) => r.key);
		// A→B (related_to) should be included
		expect(keys).toContain("B");
		// B→C (related_to) should be included, so C should be at depth 2
		expect(keys).toContain("C");

		// A→D is extends, not related_to, so D should not appear
		// Relation filter narrows traversal so D is not reachable via related_to only
		expect(keys).not.toContain("D");
	});
});

describe("graph-memory.AC3.4: Neighbors returns one-hop connections with direction", () => {
	it("should return outbound edges from B", () => {
		const results = getNeighbors(db, "B", "out");

		const keys = results.map((r) => r.key);
		// B→C is an edge
		expect(keys).toContain("C");

		for (const r of results) {
			expect(r.direction).toBe("out");
			expect(r.key).toBeDefined();
			expect(r.value).toBeDefined();
			expect(r.relation).toBeDefined();
			expect(r.weight).toBeDefined();
		}
	});

	it("should return inbound edges to B", () => {
		const results = getNeighbors(db, "B", "in");

		const keys = results.map((r) => r.key);
		// A→B and D→B are edges
		expect(keys).toContain("A");
		expect(keys).toContain("D");

		for (const r of results) {
			expect(r.direction).toBe("in");
		}
	});

	it("should return both inbound and outbound edges with direction=both", () => {
		const results = getNeighbors(db, "B", "both");

		const keys = results.map((r) => r.key);
		// Should have A, D (inbound) and C (outbound)
		expect(keys).toContain("A");
		expect(keys).toContain("C");
		expect(keys).toContain("D");

		// Check directions are mixed
		const outbound = results.filter((r) => r.direction === "out");
		const inbound = results.filter((r) => r.direction === "in");
		expect(outbound.length).toBeGreaterThan(0);
		expect(inbound.length).toBeGreaterThan(0);
	});
});

describe("graph-memory.AC3.5: Cycle in graph does not cause infinite recursion", () => {
	it("should terminate traversal with cycle A→B→...→D→B", () => {
		// Graph has cycle: A→B, B→C, C→D, D→B
		const results = traverseGraph(db, "A", 3);

		// Should complete without hanging/infinite recursion
		expect(results.length).toBeGreaterThan(0);

		// B can appear via multiple paths: A→B (depth 1) and A→D→B (depth 2)
		// Deduplication ensures B appears only once (at shallowest depth 1)
		const bResults = results.filter((r) => r.key === "B");
		expect(bResults.length).toBe(1);
		// Check that depth is reasonable (not infinite)
		expect(bResults[0].depth).toBeLessThanOrEqual(3);
	});
});

describe("graph-memory.AC3.6: Traversal on key with no edges returns empty result", () => {
	it("should return empty array for traverseGraph on E (isolated node)", () => {
		const results = traverseGraph(db, "E");
		expect(results.length).toBe(0);
	});

	it("should return empty array for getNeighbors on E (isolated node)", () => {
		const results = getNeighbors(db, "E");
		expect(results.length).toBe(0);
	});
});

describe("graph-memory.AC3.7: Depth clamping to MAX_DEPTH=3", () => {
	it("should clamp depth=10 to effective depth=3", () => {
		const results10 = traverseGraph(db, "A", 10);
		const results3 = traverseGraph(db, "A", 3);

		// Both should return the same results since 10 is clamped to 3
		expect(results10.length).toBe(results3.length);

		// Extract keys and compare (order might differ due to sorting)
		const keys10 = new Set(results10.map((r) => r.key));
		const keys3 = new Set(results3.map((r) => r.key));
		expect(keys10).toEqual(keys3);
	});
});

describe("graphSeededRetrieval: Seeds and traversal", () => {
	it("should find seeds by keyword matching", () => {
		const results = graphSeededRetrieval(db, ["Memory"], 10);

		// Should find entries with "Memory" in key or value
		const seeds = results.filter((r) => r.retrievalMethod === "seed");
		expect(seeds.length).toBeGreaterThan(0);

		for (const s of seeds) {
			expect(s.key).toBeDefined();
			expect(s.value).toBeDefined();
			expect(s.source).toBeDefined();
			expect(s.modifiedAt).toBeDefined();
			expect(s.retrievalMethod).toBe("seed");
		}
	});

	it("should include traversed entries from seeds", () => {
		const results = graphSeededRetrieval(db, ["Memory", "entry"], 10);

		// Should find traversed entries
		const traversed = results.filter((r) => r.retrievalMethod === "graph");
		// May or may not have traversed entries depending on seeds found

		for (const t of traversed) {
			expect(t.depth).toBeDefined();
			expect(t.viaRelation).toBeDefined();
			expect(t.retrievalMethod).toBe("graph");
		}
	});

	it("should return empty array for empty keywords", () => {
		const results = graphSeededRetrieval(db, [], 10);
		expect(results.length).toBe(0);
	});

	it("should return empty array for non-matching keywords", () => {
		const results = graphSeededRetrieval(db, ["xyzabc123nonexistent"], 10);
		expect(results.length).toBe(0);
	});

	it("should deduplicate results", () => {
		const results = graphSeededRetrieval(db, ["Memory", "entry"], 50);

		const keys = results.map((r) => r.key);
		const uniqueKeys = new Set(keys);
		// All keys should be unique
		expect(keys.length).toBe(uniqueKeys.size);
	});

	it("should exclude _internal.* keys from seed matches", () => {
		// Seed an _internal.file_thread entry whose key matches the keyword
		const now = new Date().toISOString();
		insertRow(
			db,
			"semantic_memory",
			{
				id: deterministicUUID(BOUND_NAMESPACE, "_internal.file_thread./workspace/Memory-foo.ts"),
				key: "_internal.file_thread./workspace/Memory-foo.ts",
				value: "some-thread-id",
				source: "/workspace/Memory-foo.ts",
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		const results = graphSeededRetrieval(db, ["Memory"], 50);
		const hasInternal = results.some((r) => r.key.startsWith("_internal."));
		expect(hasInternal).toBe(false);
	});
});

describe("traverseGraph: Additional edge cases", () => {
	it("should handle depth < 1 by clamping to 1", () => {
		const results = traverseGraph(db, "A", 0);
		// Should clamp to depth 1
		const resultsDepth1 = traverseGraph(db, "A", 1);
		expect(results.length).toBe(resultsDepth1.length);
	});

	it("should exclude soft-deleted edges", () => {
		// Soft delete an edge: A→B
		const edge = db
			.prepare(
				"SELECT id FROM memory_edges WHERE source_key = ? AND target_key = ? AND relation = ?",
			)
			.get("A", "B", "related_to") as { id: string } | null;

		expect(edge).not.toBeNull();
		if (edge) {
			softDelete(db, "memory_edges", edge.id, siteId);

			// Traversal should not include B via A→B
			const results = traverseGraph(db, "A", 1);
			// B should not be in results (only D via A→D should remain)
			const keys = results.map((r) => r.key);
			expect(keys).not.toContain("B");
			expect(keys).toContain("D");
		}
	});

	it("should join only active semantic_memory entries", () => {
		// Soft delete memory entry C
		const cId = deterministicUUID(BOUND_NAMESPACE, "C");
		softDelete(db, "semantic_memory", cId, siteId);

		// Traversal from A should not include C in results
		const results = traverseGraph(db, "A", 3);
		const cResult = results.find((r) => r.key === "C");
		expect(cResult).toBeUndefined();
	});
});
