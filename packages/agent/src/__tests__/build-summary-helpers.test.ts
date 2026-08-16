import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import fc from "fast-check";
import {
	type StageEntry,
	buildParentSummaryMap,
	buildStaleChildrenMap,
} from "../summary-extraction";

const TEST_SITE_ID = "test-site-00000000-0000-0000-0000-000000000000";
const SUMMARY_TIME = "2026-05-23T10:00:00.000Z";

interface ParentEdgeScenario {
	requested: string[];
	edges: Array<{ parent: string; child: string; deleted: boolean }>;
}

interface StaleChildScenario {
	summaries: Array<{ key: string; modifiedAt: string }>;
	children: Array<{
		parent: string;
		key: string;
		modifiedAt: string;
		childDeleted: boolean;
		edgeDeleted: boolean;
	}>;
}

function insertMemory(
	db: Database,
	{
		id,
		key,
		modifiedAt,
		deleted = 0,
		tier = "detail",
	}: {
		id: string;
		key: string;
		modifiedAt: string;
		deleted?: 0 | 1;
		tier?: "summary" | "detail";
	},
): void {
	insertRow(
		db,
		"semantic_memory",
		{
			id,
			key,
			value: key,
			source: null,
			created_at: modifiedAt,
			modified_at: modifiedAt,
			tier,
			deleted,
		},
		TEST_SITE_ID,
	);
}

function insertSummarizesEdge(
	db: Database,
	{
		id,
		parent,
		child,
		deleted = 0,
	}: {
		id: string;
		parent: string;
		child: string;
		deleted?: boolean;
	},
): void {
	insertRow(
		db,
		"memory_edges",
		{
			id,
			source_key: parent,
			target_key: child,
			relation: "summarizes",
			weight: 1,
			created_at: SUMMARY_TIME,
			modified_at: SUMMARY_TIME,
			deleted: deleted ? 1 : 0,
		},
		TEST_SITE_ID,
	);
}

const parentEdgeScenario = fc.record({
	requested: fc
		.uniqueArray(fc.integer({ min: 0, max: 5 }), { maxLength: 6 })
		.map((ids) => ids.map((id) => `detail:${id}`)),
	edges: fc.array(
		fc.record({
			parent: fc.integer({ min: 0, max: 5 }).map((id) => `_summary:${id}`),
			child: fc.integer({ min: 0, max: 5 }).map((id) => `detail:${id}`),
			deleted: fc.boolean(),
		}),
		{ maxLength: 16 },
	),
}) satisfies fc.Arbitrary<ParentEdgeScenario>;

const staleChildScenario = fc
	.uniqueArray(
		fc.record({
			key: fc.integer({ min: 0, max: 4 }).map((id) => `_summary:${id}`),
			modifiedAt: fc.integer({ min: 1, max: 5 }).map((hour) => `2026-05-23T0${hour}:00:00.000Z`),
		}),
		{ selector: (summary) => summary.key, minLength: 1, maxLength: 5 },
	)
	.chain((summaries) =>
		fc.record({
			summaries: fc.constant(summaries),
			children: fc.array(
				fc.record({
					parent: fc.constantFrom(...summaries.map((summary) => summary.key)),
					key: fc.integer({ min: 0, max: 8 }).map((id) => `detail:${id}`),
					modifiedAt: fc
						.integer({ min: 1, max: 5 })
						.map((hour) => `2026-05-23T0${hour}:00:00.000Z`),
					childDeleted: fc.boolean(),
					edgeDeleted: fc.boolean(),
				}),
				{ maxLength: 16 },
			),
		}),
	)
	.map(({ summaries, children }) => ({
		summaries,
		children: children.map((child, index) => ({
			...child,
			key: `${child.key}:${index}`,
			modifiedAt: child.modifiedAt,
		})),
	})) satisfies fc.Arbitrary<StaleChildScenario>;

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
		expect(buildParentSummaryMap(db, [])).toEqual(new Map());
	});

	test("maps exactly requested children with live summarizes edges", () => {
		fc.assert(
			fc.property(parentEdgeScenario, ({ requested, edges }) => {
				const propertyDb = new Database(":memory:");
				applySchema(propertyDb);
				try {
					for (const [index, edge] of edges.entries()) {
						insertSummarizesEdge(propertyDb, { id: `edge-${index}`, ...edge });
					}

					const expected = new Map<string, string>();
					for (const edge of edges) {
						if (!edge.deleted && requested.includes(edge.child) && !expected.has(edge.child)) {
							expected.set(edge.child, edge.parent);
						}
					}

					expect(buildParentSummaryMap(propertyDb, requested)).toEqual(expected);
				} finally {
					propertyDb.close();
				}
			}),
			{ numRuns: 100 },
		);
	});

	test("First-seen-wins on duplicate edges (multiple parents for same child)", () => {
		insertSummarizesEdge(db, { id: "first", parent: "_summary:first", child: "detail:shared" });
		insertSummarizesEdge(db, { id: "second", parent: "_summary:second", child: "detail:shared" });

		expect(buildParentSummaryMap(db, ["detail:shared"])).toEqual(
			new Map([["detail:shared", "_summary:first"]]),
		);
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
			expect(buildStaleChildrenMap(db, [])).toEqual(new Map());
		});

		test("returns exactly live children newer than their requested parent with stale-detail tags", () => {
			fc.assert(
				fc.property(staleChildScenario, ({ summaries, children }) => {
					const propertyDb = new Database(":memory:");
					applySchema(propertyDb);
					try {
						for (const [index, child] of children.entries()) {
							insertMemory(propertyDb, {
								id: `child-${index}`,
								key: child.key,
								modifiedAt: child.modifiedAt,
								deleted: child.childDeleted ? 1 : 0,
							});
							insertSummarizesEdge(propertyDb, {
								id: `edge-${index}`,
								parent: child.parent,
								child: child.key,
								deleted: child.edgeDeleted,
							});
						}

						const stageEntries: StageEntry[] = summaries.map((summary) => ({
							key: summary.key,
							value: summary.key,
							source: null,
							modifiedAt: summary.modifiedAt,
							tier: "summary",
							tag: "[summary]",
						}));
						const summaryByKey = new Map(summaries.map((summary) => [summary.key, summary]));
						const expected = new Map<string, Set<string>>();
						for (const child of children) {
							const parent = summaryByKey.get(child.parent);
							if (
								!parent ||
								child.childDeleted ||
								child.edgeDeleted ||
								child.modifiedAt <= parent.modifiedAt
							) {
								continue;
							}
							const bucket = expected.get(child.parent) ?? new Set<string>();
							bucket.add(`${child.key}|${child.modifiedAt}|[stale-detail]`);
							expected.set(child.parent, bucket);
						}

						const actual = buildStaleChildrenMap(propertyDb, stageEntries);
						const actualNormalized = new Map(
							Array.from(actual, ([parent, entries]) => [
								parent,
								new Set(entries.map(({ key, modifiedAt, tag }) => `${key}|${modifiedAt}|${tag}`)),
							]),
						);
						expect(actualNormalized).toEqual(expected);
					} finally {
						propertyDb.close();
					}
				}),
				{ numRuns: 100 },
			);
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
});
