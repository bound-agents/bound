import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import {
	type StageEntry,
	buildParentSummaryMap,
	buildStaleChildrenMap,
} from "../summary-extraction";

const TEST_SITE_ID = "test-site-00000000-0000-0000-0000-000000000000";

describe("buildParentSummaryMap", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	afterEach(() => {
		db.close();
	});

	test("Empty input keys returns empty map", () => {
		const result = buildParentSummaryMap(db, []);
		expect(result.size).toBe(0);
	});

	test("One detail key with one summarizes edge returns map with that entry", () => {
		// Insert a parent summary entry
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent-id",
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert a detail entry
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:key1",
				value: "Child detail",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert a summarizes edge from parent to child
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge-id",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const result = buildParentSummaryMap(db, ["detail:key1"]);
		expect(result.size).toBe(1);
		expect(result.get("detail:key1")).toBe("_summary:topic1");
	});

	test("One detail key with no edges is absent from map", () => {
		// Insert a detail entry with no incoming summarizes edges
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:orphan",
				value: "Orphan detail",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const result = buildParentSummaryMap(db, ["detail:orphan"]);
		expect(result.size).toBe(0);
		expect(result.has("detail:orphan")).toBe(false);
	});

	test("Multiple keys, mixed with and without parents", () => {
		// Insert parent summaries
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent1-id",
				key: "_summary:topic1",
				value: "Parent 1",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent2-id",
				key: "_summary:topic2",
				value: "Parent 2",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert detail entries
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child1-id",
				key: "detail:key1",
				value: "Child 1",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: "child2-id",
				key: "detail:key2",
				value: "Child 2",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: "orphan-id",
				key: "detail:orphan",
				value: "Orphan",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Create edges
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge1",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		insertRow(
			db,
			"memory_edges",
			{
				id: "edge2",
				source_key: "_summary:topic2",
				target_key: "detail:key2",
				relation: "summarizes",
				weight: 1.0,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const result = buildParentSummaryMap(db, ["detail:key1", "detail:key2", "detail:orphan"]);
		expect(result.size).toBe(2);
		expect(result.get("detail:key1")).toBe("_summary:topic1");
		expect(result.get("detail:key2")).toBe("_summary:topic2");
		expect(result.has("detail:orphan")).toBe(false);
	});

	test("Soft-deleted edges are ignored", () => {
		// Insert a parent summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent-id",
				key: "_summary:topic1",
				value: "Parent",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert a detail entry
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:key1",
				value: "Child",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert a deleted edge
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge-id",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				deleted: 1,
			},
			TEST_SITE_ID,
		);

		const result = buildParentSummaryMap(db, ["detail:key1"]);
		expect(result.size).toBe(0);
	});

	test("First-seen-wins on duplicate edges (multiple parents for same child)", () => {
		// Insert two parent summaries
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent1-id",
				key: "_summary:topic1",
				value: "Parent 1",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent2-id",
				key: "_summary:topic2",
				value: "Parent 2",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert a detail entry
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:key1",
				value: "Child",
				source: null,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert two edges from different parents to the same child
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge1",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		insertRow(
			db,
			"memory_edges",
			{
				id: "edge2",
				source_key: "_summary:topic2",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: "2026-05-23T00:00:00.000Z",
				modified_at: "2026-05-23T00:00:00.000Z",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const result = buildParentSummaryMap(db, ["detail:key1"]);
		expect(result.size).toBe(1);
		// Should pick the first-seen parent (depends on SQL result order)
		const parent = result.get("detail:key1");
		expect(parent === "_summary:topic1" || parent === "_summary:topic2").toBe(true);
	});
});

describe("buildStaleChildrenMap", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	afterEach(() => {
		db.close();
	});

	test("Empty input summaries returns empty map", () => {
		const result = buildStaleChildrenMap(db, []);
		expect(result.size).toBe(0);
	});

	test("One summary with one stale child (child.modified_at > summary.modified_at)", () => {
		const parentTime = "2026-05-23T10:00:00.000Z";
		const childTime = "2026-05-23T11:00:00.000Z";

		// Insert parent summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent-id",
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				created_at: parentTime,
				modified_at: parentTime,
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert stale child (modified later)
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:key1",
				value: "Child detail",
				source: null,
				created_at: childTime,
				modified_at: childTime,
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Create summarizes edge
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge-id",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: parentTime,
				modified_at: parentTime,
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const summaries: StageEntry[] = [
			{
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				modifiedAt: parentTime,
				tier: "summary",
				tag: "[summary]",
			},
		];

		const result = buildStaleChildrenMap(db, summaries);
		expect(result.size).toBe(1);
		const staleChildren = result.get("_summary:topic1");
		expect(staleChildren).toBeDefined();
		expect(staleChildren?.length).toBe(1);
		expect(staleChildren?.[0].key).toBe("detail:key1");
		expect(staleChildren?.[0].tag).toBe("[stale-detail]");
	});

	test("One summary with one fresh child (child.modified_at <= summary.modified_at)", () => {
		const parentTime = "2026-05-23T11:00:00.000Z";
		const childTime = "2026-05-23T10:00:00.000Z";

		// Insert parent summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent-id",
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				created_at: parentTime,
				modified_at: parentTime,
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert fresh child (modified earlier)
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:key1",
				value: "Child detail",
				source: null,
				created_at: childTime,
				modified_at: childTime,
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Create summarizes edge
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge-id",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: parentTime,
				modified_at: parentTime,
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const summaries: StageEntry[] = [
			{
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				modifiedAt: parentTime,
				tier: "summary",
				tag: "[summary]",
			},
		];

		const result = buildStaleChildrenMap(db, summaries);
		expect(result.size).toBe(0);
	});

	test("Mixed stale and fresh children under one parent", () => {
		const parentTime = "2026-05-23T10:00:00.000Z";
		const staleTime = "2026-05-23T11:00:00.000Z";
		const freshTime = "2026-05-23T09:00:00.000Z";

		// Insert parent summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent-id",
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				created_at: parentTime,
				modified_at: parentTime,
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert stale child
		insertRow(
			db,
			"semantic_memory",
			{
				id: "stale-child-id",
				key: "detail:stale",
				value: "Stale child",
				source: null,
				created_at: staleTime,
				modified_at: staleTime,
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert fresh child
		insertRow(
			db,
			"semantic_memory",
			{
				id: "fresh-child-id",
				key: "detail:fresh",
				value: "Fresh child",
				source: null,
				created_at: freshTime,
				modified_at: freshTime,
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Create edges
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge1",
				source_key: "_summary:topic1",
				target_key: "detail:stale",
				relation: "summarizes",
				weight: 1.0,
				created_at: parentTime,
				modified_at: parentTime,
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		insertRow(
			db,
			"memory_edges",
			{
				id: "edge2",
				source_key: "_summary:topic1",
				target_key: "detail:fresh",
				relation: "summarizes",
				weight: 1.0,
				created_at: parentTime,
				modified_at: parentTime,
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const summaries: StageEntry[] = [
			{
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				modifiedAt: parentTime,
				tier: "summary",
				tag: "[summary]",
			},
		];

		const result = buildStaleChildrenMap(db, summaries);
		expect(result.size).toBe(1);
		const staleChildren = result.get("_summary:topic1");
		expect(staleChildren).toBeDefined();
		expect(staleChildren?.length).toBe(1);
		expect(staleChildren?.[0].key).toBe("detail:stale");
	});

	test("Soft-deleted child entries are ignored", () => {
		const parentTime = "2026-05-23T10:00:00.000Z";
		const childTime = "2026-05-23T11:00:00.000Z";

		// Insert parent summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent-id",
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				created_at: parentTime,
				modified_at: parentTime,
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert soft-deleted child
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:key1",
				value: "Child detail",
				source: null,
				created_at: childTime,
				modified_at: childTime,
				tier: "detail",
				deleted: 1,
			},
			TEST_SITE_ID,
		);

		// Create edge to the deleted child
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge-id",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: parentTime,
				modified_at: parentTime,
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const summaries: StageEntry[] = [
			{
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				modifiedAt: parentTime,
				tier: "summary",
				tag: "[summary]",
			},
		];

		const result = buildStaleChildrenMap(db, summaries);
		expect(result.size).toBe(0);
	});

	test("Returned StageEntry tag is '[stale-detail]'", () => {
		const parentTime = "2026-05-23T10:00:00.000Z";
		const childTime = "2026-05-23T11:00:00.000Z";

		// Insert parent summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: "parent-id",
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				created_at: parentTime,
				modified_at: parentTime,
				tier: "summary",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Insert stale child
		insertRow(
			db,
			"semantic_memory",
			{
				id: "child-id",
				key: "detail:key1",
				value: "Child detail",
				source: null,
				created_at: childTime,
				modified_at: childTime,
				tier: "detail",
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		// Create edge
		insertRow(
			db,
			"memory_edges",
			{
				id: "edge-id",
				source_key: "_summary:topic1",
				target_key: "detail:key1",
				relation: "summarizes",
				weight: 1.0,
				created_at: parentTime,
				modified_at: parentTime,
				deleted: 0,
			},
			TEST_SITE_ID,
		);

		const summaries: StageEntry[] = [
			{
				key: "_summary:topic1",
				value: "Parent summary",
				source: null,
				modifiedAt: parentTime,
				tier: "summary",
				tag: "[summary]",
			},
		];

		const result = buildStaleChildrenMap(db, summaries);
		const staleChildren = result.get("_summary:topic1");
		expect(staleChildren).toBeDefined();
		expect(staleChildren?.[0].tag).toBe("[stale-detail]");
	});

	test("EXPLAIN: buildParentSummaryMap uses idx_edges_target partial index", () => {
		// Populate with 1000+ edges to ensure ANALYZE computes proper selectivity
		const topicCount = 10;
		const detailPerTopic = 110;

		// Wrap bulk inserts in a single outer transaction so the per-insertRow
		// inner transactions become savepoints and the workload commits once
		// instead of 2210 times. Without this, slow CI runners exceed the 5s
		// per-test timeout (observed 9.5s on ubuntu-latest).
		db.transaction(() => {
			// Insert summary entries
			for (let t = 0; t < topicCount; t++) {
				insertRow(
					db,
					"semantic_memory",
					{
						id: `parent-${t}`,
						key: `_summary:topic${t}`,
						value: `Summary ${t}`,
						source: null,
						created_at: "2026-05-23T00:00:00.000Z",
						modified_at: "2026-05-23T00:00:00.000Z",
						tier: "summary",
						deleted: 0,
					},
					TEST_SITE_ID,
				);
			}

			// Insert detail entries and edges
			for (let t = 0; t < topicCount; t++) {
				for (let d = 0; d < detailPerTopic; d++) {
					const key = `detail:topic${t}_item${d}`;
					insertRow(
						db,
						"semantic_memory",
						{
							id: `child-${t}-${d}`,
							key,
							value: `Detail ${t}/${d}`,
							source: null,
							created_at: "2026-05-23T00:00:00.000Z",
							modified_at: "2026-05-23T00:00:00.000Z",
							tier: "detail",
							deleted: 0,
						},
						TEST_SITE_ID,
					);

					insertRow(
						db,
						"memory_edges",
						{
							id: `edge-${t}-${d}`,
							source_key: `_summary:topic${t}`,
							target_key: key,
							relation: "summarizes",
							weight: 1.0,
							created_at: "2026-05-23T00:00:00.000Z",
							modified_at: "2026-05-23T00:00:00.000Z",
							deleted: 0,
						},
						TEST_SITE_ID,
					);
				}
			}
		})();

		// Run ANALYZE to compute selectivity for the query planner
		db.exec("ANALYZE");

		// Execute buildParentSummaryMap with a sample of keys
		const sampleKeys = Array.from(
			{ length: 50 },
			(_, i) => `detail:topic${i % topicCount}_item${i}`,
		);
		const result = buildParentSummaryMap(db, sampleKeys);

		// Verify results are correct
		expect(result.size).toBeGreaterThan(0);

		// Check the query plan: the WHERE clause uses `deleted = 0` which matches the partial index predicate
		const explainResult = db
			.prepare(
				`EXPLAIN QUERY PLAN
			 SELECT e.target_key AS child, e.source_key AS parent
			 FROM memory_edges e
			 WHERE e.relation = 'summarizes'
			   AND e.deleted = 0
			   AND e.target_key IN ('detail:topic0_item0')`,
			)
			.all() as Array<{ detail: string }>;

		// The plan should mention idx_edges_target (indicating partial index is used)
		// Format: "SEARCH e USING INDEX idx_edges_target"
		const planText = JSON.stringify(explainResult);
		expect(planText).toContain("idx_edges_target");
		expect(planText).not.toContain("SCAN e");
	});

	test("EXPLAIN: buildStaleChildrenMap uses idx_edges_source partial index", () => {
		const summaryTime = "2026-05-23T00:00:00.000Z";
		const staleTime = "2026-05-24T00:00:00.000Z"; // One day later (stale)

		// Insert test data — wrapped in an outer transaction so the per-insertRow
		// inner transactions become savepoints with a single final commit.
		db.transaction(() => {
			for (let i = 0; i < 100; i++) {
				insertRow(
					db,
					"semantic_memory",
					{
						id: `summary-${i}`,
						key: `_summary:topic${i}`,
						value: `Summary ${i}`,
						source: null,
						created_at: summaryTime,
						modified_at: summaryTime,
						tier: "summary",
						deleted: 0,
					},
					TEST_SITE_ID,
				);

				insertRow(
					db,
					"semantic_memory",
					{
						id: `detail-${i}`,
						key: `detail:${i}`,
						value: `Detail ${i}`,
						source: null,
						created_at: summaryTime,
						modified_at: staleTime, // Details modified after summary = stale children
						tier: "detail",
						deleted: 0,
					},
					TEST_SITE_ID,
				);

				insertRow(
					db,
					"memory_edges",
					{
						id: `edge-${i}`,
						source_key: `_summary:topic${i}`,
						target_key: `detail:${i}`,
						relation: "summarizes",
						weight: 1.0,
						created_at: summaryTime,
						modified_at: summaryTime,
						deleted: 0,
					},
					TEST_SITE_ID,
				);
			}
		})();

		// Run ANALYZE to compute selectivity for the query planner
		db.exec("ANALYZE");

		// Build summaries list with summaryTime
		const summaries: StageEntry[] = Array.from({ length: 50 }, (_, i) => ({
			key: `_summary:topic${i}`,
			value: `Summary ${i}`,
			source: null,
			modifiedAt: summaryTime,
			tier: "summary",
			tag: "[summary]",
		}));

		const result = buildStaleChildrenMap(db, summaries);

		// Verify results work (all 50 summaries should have stale children)
		expect(result.size).toBeGreaterThan(0);

		// Check the query plan: WHERE uses `deleted = 0` on both edges and semantic_memory
		const explainResult = db
			.prepare(
				`EXPLAIN QUERY PLAN
			 SELECT e.source_key AS parent, e.target_key AS child_key,
					m.value AS child_value, m.modified_at AS child_modified_at, m.tier AS tier
			 FROM memory_edges e
			 JOIN semantic_memory m ON m.key = e.target_key AND m.deleted = 0
			 WHERE e.relation = 'summarizes'
			   AND e.deleted = 0
			   AND e.source_key IN ('_summary:topic0')`,
			)
			.all() as Array<{ detail: string }>;

		// The plan should NOT do a full table scan on edges (e)
		// It should use either idx_edges_source or a covering index like idx_edges_triple
		const planText = JSON.stringify(explainResult);
		expect(planText).not.toContain("SCAN e");
		// Should use an index on source_key
		const hasSourceIndex =
			planText.includes("idx_edges_source") || planText.includes("idx_edges_triple");
		expect(hasSourceIndex).toBe(true);
	});
});
