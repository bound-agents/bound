import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MemoryEdge, SemanticMemory } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete, updateRow } from "../../../index";
import {
	listSummarizesChildrenKeyValue,
	listSummaryChildrenForStaleness,
} from "../memory-summary-children";

const SITE_ID = "test-site";
const TS = "2026-01-01T00:00:00.000Z";

let db: Database;

function seedMemory(overrides: Partial<SemanticMemory> & Pick<SemanticMemory, "id" | "key">): void {
	const row: SemanticMemory = {
		id: overrides.id,
		key: overrides.key,
		value: overrides.value ?? "v",
		source: overrides.source ?? null,
		created_at: overrides.created_at ?? TS,
		modified_at: overrides.modified_at ?? TS,
		last_accessed_at: overrides.last_accessed_at ?? null,
		tier: overrides.tier ?? "default",
		deleted: overrides.deleted ?? 0,
	};
	insertRow(db, "semantic_memory", row, SITE_ID);
}

function seedEdge(
	overrides: Partial<MemoryEdge> & Pick<MemoryEdge, "id" | "source_key" | "target_key">,
): void {
	const row: MemoryEdge = {
		id: overrides.id,
		source_key: overrides.source_key,
		target_key: overrides.target_key,
		// `summarizes` is one of CANONICAL_RELATIONS — the BEFORE INSERT trigger
		// on memory_edges rejects anything outside that set.
		relation: overrides.relation ?? "summarizes",
		weight: overrides.weight ?? 1.0,
		created_at: overrides.created_at ?? TS,
		modified_at: overrides.modified_at ?? TS,
		deleted: overrides.deleted ?? 0,
	};
	insertRow(db, "memory_edges", row, SITE_ID);
}

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
});

afterEach(() => {
	db.close();
});

describe("listSummaryChildrenForStaleness", () => {
	it("returns [] for an empty summaryKeys array without touching the DB", () => {
		// Seed nothing relevant; assert the empty-IN-list short-circuit.
		expect(listSummaryChildrenForStaleness(db, [])).toEqual([]);
	});

	it("returns [] when the parent key has no outgoing summarizes edges", () => {
		seedMemory({ id: "m-parent", key: "parent-1", tier: "summary" });
		expect(listSummaryChildrenForStaleness(db, ["parent-1"])).toEqual([]);
	});

	it("projects the exact column shape destructured by buildStaleChildrenMap", () => {
		seedMemory({ id: "m-parent", key: "parent-1", tier: "summary" });
		seedMemory({
			id: "m-child",
			key: "child-1",
			value: "child body",
			tier: "detail",
			modified_at: "2026-03-03T00:00:00.000Z",
		});
		seedEdge({ id: "e-1", source_key: "parent-1", target_key: "child-1" });

		const rows = listSummaryChildrenForStaleness(db, ["parent-1"]);
		expect(rows).toEqual([
			{
				parent: "parent-1",
				child_key: "child-1",
				child_value: "child body",
				child_modified_at: "2026-03-03T00:00:00.000Z",
				tier: "detail",
			},
		]);
	});

	it("excludes children whose semantic_memory row is soft-deleted (JOIN m.deleted = 0)", () => {
		seedMemory({ id: "m-parent", key: "parent-1", tier: "summary" });
		seedMemory({ id: "m-live", key: "child-live", value: "live", tier: "detail" });
		seedMemory({ id: "m-dead", key: "child-dead", value: "dead", tier: "detail" });
		seedEdge({ id: "e-live", source_key: "parent-1", target_key: "child-live" });
		seedEdge({ id: "e-dead", source_key: "parent-1", target_key: "child-dead" });

		// Tombstone the child memory row — the edge stays live, but the JOIN must drop it.
		softDelete(db, "semantic_memory", "m-dead", SITE_ID);

		const rows = listSummaryChildrenForStaleness(db, ["parent-1"]);
		expect(rows.map((r) => r.child_key)).toEqual(["child-live"]);
	});

	it("excludes children reached only via a soft-deleted edge (e.deleted = 0)", () => {
		seedMemory({ id: "m-parent", key: "parent-1", tier: "summary" });
		seedMemory({ id: "m-child", key: "child-1", value: "body", tier: "detail" });
		seedEdge({ id: "e-1", source_key: "parent-1", target_key: "child-1" });

		// The child row stays live, but its only edge is tombstoned.
		softDelete(db, "memory_edges", "e-1", SITE_ID);

		expect(listSummaryChildrenForStaleness(db, ["parent-1"])).toEqual([]);
	});

	it("excludes edges whose relation is not 'summarizes'", () => {
		seedMemory({ id: "m-parent", key: "parent-1", tier: "summary" });
		seedMemory({ id: "m-sum", key: "child-sum", value: "summarized", tier: "detail" });
		seedMemory({ id: "m-rel", key: "child-rel", value: "related", tier: "detail" });
		seedEdge({ id: "e-sum", source_key: "parent-1", target_key: "child-sum" });
		// A non-summarizes (but still canonical) edge from the same parent must be ignored.
		seedEdge({
			id: "e-rel",
			source_key: "parent-1",
			target_key: "child-rel",
			relation: "related_to",
		});

		const rows = listSummaryChildrenForStaleness(db, ["parent-1"]);
		expect(rows.map((r) => r.child_key)).toEqual(["child-sum"]);
	});

	it("resolves children across multiple parent keys in a single call", () => {
		seedMemory({ id: "m-pa", key: "parent-a", tier: "summary" });
		seedMemory({ id: "m-pb", key: "parent-b", tier: "summary" });
		seedMemory({ id: "m-ca", key: "child-a", value: "va", tier: "detail" });
		seedMemory({ id: "m-cb", key: "child-b", value: "vb", tier: "detail" });
		// parent-c is NOT in the query set — its child must be absent.
		seedMemory({ id: "m-pc", key: "parent-c", tier: "summary" });
		seedMemory({ id: "m-cc", key: "child-c", value: "vc", tier: "detail" });
		seedEdge({ id: "e-a", source_key: "parent-a", target_key: "child-a" });
		seedEdge({ id: "e-b", source_key: "parent-b", target_key: "child-b" });
		seedEdge({ id: "e-c", source_key: "parent-c", target_key: "child-c" });

		const rows = listSummaryChildrenForStaleness(db, ["parent-a", "parent-b"]);
		const byParent = rows.map((r) => ({ parent: r.parent, child_key: r.child_key }));
		// Order between the two parents is not guaranteed by the query — compare as a set.
		expect(byParent).toHaveLength(2);
		expect(byParent).toContainEqual({ parent: "parent-a", child_key: "child-a" });
		expect(byParent).toContainEqual({ parent: "parent-b", child_key: "child-b" });
	});

	it("returns ALL children regardless of staleness (caller computes the comparison)", () => {
		seedMemory({
			id: "m-parent",
			key: "parent-1",
			tier: "summary",
			modified_at: "2026-02-02T00:00:00.000Z",
		});
		// One child OLDER than the parent (fresh), one NEWER (stale). Both must come back.
		seedMemory({
			id: "m-fresh",
			key: "child-fresh",
			value: "fresh",
			tier: "detail",
			modified_at: "2026-01-01T00:00:00.000Z",
		});
		seedMemory({
			id: "m-stale",
			key: "child-stale",
			value: "stale",
			tier: "detail",
			modified_at: "2026-03-03T00:00:00.000Z",
		});
		seedEdge({ id: "e-fresh", source_key: "parent-1", target_key: "child-fresh" });
		seedEdge({ id: "e-stale", source_key: "parent-1", target_key: "child-stale" });

		const rows = listSummaryChildrenForStaleness(db, ["parent-1"]);
		expect(rows.map((r) => r.child_key).sort()).toEqual(["child-fresh", "child-stale"]);
	});
});

describe("listSummarizesChildrenKeyValue", () => {
	it("returns [] when the parent key is absent", () => {
		expect(listSummarizesChildrenKeyValue(db, "no-such-parent")).toEqual([]);
	});

	it("returns [] when the parent exists but has no summarizes edges", () => {
		seedMemory({ id: "m-parent", key: "parent-1", tier: "summary" });
		expect(listSummarizesChildrenKeyValue(db, "parent-1")).toEqual([]);
	});

	it("projects exactly { key, value } for each live summarizes child", () => {
		seedMemory({ id: "m-parent", key: "parent-1", tier: "summary" });
		seedMemory({ id: "m-c1", key: "child-1", value: "value one", tier: "detail" });
		seedMemory({ id: "m-c2", key: "child-2", value: "value two", tier: "detail" });
		seedEdge({ id: "e-1", source_key: "parent-1", target_key: "child-1" });
		seedEdge({ id: "e-2", source_key: "parent-1", target_key: "child-2" });

		const rows = listSummarizesChildrenKeyValue(db, "parent-1");
		expect(rows).toHaveLength(2);
		expect(rows).toContainEqual({ key: "child-1", value: "value one" });
		expect(rows).toContainEqual({ key: "child-2", value: "value two" });
		// Projection must carry ONLY key + value, nothing else.
		for (const r of rows) {
			expect(Object.keys(r).sort()).toEqual(["key", "value"]);
		}
	});

	it("excludes a child whose semantic_memory row is soft-deleted (JOIN m.deleted = 0)", () => {
		seedMemory({ id: "m-parent", key: "parent-1", tier: "summary" });
		seedMemory({ id: "m-live", key: "child-live", value: "live", tier: "detail" });
		seedMemory({ id: "m-dead", key: "child-dead", value: "dead", tier: "detail" });
		seedEdge({ id: "e-live", source_key: "parent-1", target_key: "child-live" });
		seedEdge({ id: "e-dead", source_key: "parent-1", target_key: "child-dead" });

		softDelete(db, "semantic_memory", "m-dead", SITE_ID);

		const rows = listSummarizesChildrenKeyValue(db, "parent-1");
		expect(rows).toEqual([{ key: "child-live", value: "live" }]);
	});

	it("excludes a child reached only via a soft-deleted edge (e.deleted = 0)", () => {
		seedMemory({ id: "m-parent", key: "parent-1", tier: "summary" });
		seedMemory({ id: "m-child", key: "child-1", value: "body", tier: "detail" });
		seedEdge({ id: "e-1", source_key: "parent-1", target_key: "child-1" });

		softDelete(db, "memory_edges", "e-1", SITE_ID);

		expect(listSummarizesChildrenKeyValue(db, "parent-1")).toEqual([]);
	});

	it("excludes non-summarizes relations from the same parent", () => {
		seedMemory({ id: "m-parent", key: "parent-1", tier: "summary" });
		seedMemory({ id: "m-sum", key: "child-sum", value: "summarized", tier: "detail" });
		seedMemory({ id: "m-cite", key: "child-cite", value: "cited", tier: "detail" });
		seedEdge({ id: "e-sum", source_key: "parent-1", target_key: "child-sum" });
		seedEdge({
			id: "e-cite",
			source_key: "parent-1",
			target_key: "child-cite",
			relation: "cites",
		});

		expect(listSummarizesChildrenKeyValue(db, "parent-1")).toEqual([
			{ key: "child-sum", value: "summarized" },
		]);
	});

	it("reflects an updated child value (resolves against the live row, not the edge)", () => {
		seedMemory({ id: "m-parent", key: "parent-1", tier: "summary" });
		seedMemory({ id: "m-child", key: "child-1", value: "original", tier: "detail" });
		seedEdge({ id: "e-1", source_key: "parent-1", target_key: "child-1" });

		updateRow(db, "semantic_memory", "m-child", { value: "rewritten" }, SITE_ID);

		expect(listSummarizesChildrenKeyValue(db, "parent-1")).toEqual([
			{ key: "child-1", value: "rewritten" },
		]);
	});
});
