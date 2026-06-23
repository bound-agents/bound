import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MemoryEdge, SemanticMemory } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../../index";
import {
	listIncomingNeighbors,
	listOutgoingNeighbors,
	traverseMemoryGraph,
} from "../memory-graph-neighbors";

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

// memory_edges carries a nullable `context` column (added via ALTER TABLE);
// seed it explicitly to drive the via_context / context projections.
function seedEdge(
	overrides: Partial<MemoryEdge> & Pick<MemoryEdge, "id" | "source_key" | "target_key">,
): void {
	const row: MemoryEdge = {
		id: overrides.id,
		source_key: overrides.source_key,
		target_key: overrides.target_key,
		relation: overrides.relation ?? "related_to",
		weight: overrides.weight ?? 1.0,
		context: overrides.context ?? null,
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

describe("traverseMemoryGraph", () => {
	it("returns [] from a start key with no outgoing edges", () => {
		seedMemory({ id: "m-a", key: "a" });
		expect(traverseMemoryGraph(db, "a", 3, null)).toEqual([]);
	});

	it("returns [] when the start key does not exist at all", () => {
		expect(traverseMemoryGraph(db, "nope", 3, null)).toEqual([]);
	});

	it("walks one hop and projects exactly the GraphTraversalRow columns", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({
			id: "m-b",
			key: "b",
			value: "b-value",
			tier: "summary",
			source: "src-b",
			modified_at: "2026-02-02T00:00:00.000Z",
		});
		seedEdge({
			id: "e-ab",
			source_key: "a",
			target_key: "b",
			relation: "informs",
			weight: 0.75,
			context: "because reasons",
		});

		const rows = traverseMemoryGraph(db, "a", 3, null);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			key: "b",
			depth: 1,
			via_relation: "informs",
			via_weight: 0.75,
			via_context: "because reasons",
			value: "b-value",
			modified_at: "2026-02-02T00:00:00.000Z",
			source: "src-b",
			tier: "summary",
		});
	});

	it("excludes the seed row itself (WHERE r.depth > 0)", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b" });
		seedEdge({ id: "e-ab", source_key: "a", target_key: "b" });

		const keys = traverseMemoryGraph(db, "a", 3, null).map((r) => r.key);
		expect(keys).toEqual(["b"]);
	});

	it("respects the depth bound: depth=1 stops after one hop", () => {
		// a -> b -> c
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b" });
		seedMemory({ id: "m-c", key: "c" });
		seedEdge({ id: "e-ab", source_key: "a", target_key: "b" });
		seedEdge({ id: "e-bc", source_key: "b", target_key: "c" });

		const depth1 = traverseMemoryGraph(db, "a", 1, null);
		expect(depth1.map((r) => r.key)).toEqual(["b"]);

		const depth2 = traverseMemoryGraph(db, "a", 2, null);
		// Ordered by depth ASC; b (depth 1) before c (depth 2).
		expect(depth2.map((r) => ({ key: r.key, depth: r.depth }))).toEqual([
			{ key: "b", depth: 1 },
			{ key: "c", depth: 2 },
		]);
	});

	it("terminates on a cycle and visits each reachable node once", () => {
		// a -> b -> c -> a (cycle). Path-string cycle prevention must stop the walk.
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b" });
		seedMemory({ id: "m-c", key: "c" });
		seedEdge({ id: "e-ab", source_key: "a", target_key: "b" });
		seedEdge({ id: "e-bc", source_key: "b", target_key: "c" });
		seedEdge({ id: "e-ca", source_key: "c", target_key: "a" });

		// Generous depth so only cycle prevention (not the depth bound) can stop it.
		const rows = traverseMemoryGraph(db, "a", 50, null);
		const keys = rows.map((r) => r.key);
		// From a: b (depth1), c (depth2). The edge c->a is suppressed because
		// 'a' is already on the path; a is also excluded by WHERE r.depth > 0.
		expect(keys).toEqual(["b", "c"]);
		expect(rows.map((r) => r.depth)).toEqual([1, 2]);
	});

	it("terminates on a self-loop", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedEdge({ id: "e-aa", source_key: "a", target_key: "a" });

		// a -> a: the seed path is '/a/', so target 'a' is already present and
		// the edge is suppressed. Nothing reachable beyond depth 0.
		expect(traverseMemoryGraph(db, "a", 50, null)).toEqual([]);
	});

	it("filters by relation when relationParam is provided", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b" });
		seedMemory({ id: "m-c", key: "c" });
		seedEdge({ id: "e-ab", source_key: "a", target_key: "b", relation: "informs" });
		seedEdge({ id: "e-ac", source_key: "a", target_key: "c", relation: "cites" });

		const onlyInforms = traverseMemoryGraph(db, "a", 3, "informs");
		expect(onlyInforms.map((r) => r.key)).toEqual(["b"]);
		expect(onlyInforms[0].via_relation).toBe("informs");

		// null follows all relations.
		const all = traverseMemoryGraph(db, "a", 3, null);
		expect(all.map((r) => r.key).sort()).toEqual(["b", "c"]);
	});

	it("excludes edges whose target memory row is soft-deleted", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b" });
		seedEdge({ id: "e-ab", source_key: "a", target_key: "b" });
		softDelete(db, "semantic_memory", "m-b", SITE_ID);

		// The edge still exists, but the JOIN to live semantic_memory drops it.
		expect(traverseMemoryGraph(db, "a", 3, null)).toEqual([]);
	});

	it("excludes soft-deleted edges from traversal", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b" });
		seedEdge({ id: "e-ab", source_key: "a", target_key: "b" });
		softDelete(db, "memory_edges", "e-ab", SITE_ID);

		expect(traverseMemoryGraph(db, "a", 3, null)).toEqual([]);
	});

	it("orders within a depth by modified_at DESC", () => {
		// a -> b and a -> c, both at depth 1; c is newer than b.
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b", modified_at: "2026-01-02T00:00:00.000Z" });
		seedMemory({ id: "m-c", key: "c", modified_at: "2026-03-03T00:00:00.000Z" });
		seedEdge({ id: "e-ab", source_key: "a", target_key: "b" });
		seedEdge({ id: "e-ac", source_key: "a", target_key: "c" });

		const keys = traverseMemoryGraph(db, "a", 3, null).map((r) => r.key);
		// Same depth (1); newer modified_at (c) first.
		expect(keys).toEqual(["c", "b"]);
	});

	it("reaches a diamond's deeper node at its shortest depth", () => {
		// a -> b -> d and a -> c -> d. d is reachable at depth 2 via two paths;
		// both paths are independent (no shared path prefix collision), so d may
		// appear via whichever path; depth must be 2 either way.
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b" });
		seedMemory({ id: "m-c", key: "c" });
		seedMemory({ id: "m-d", key: "d" });
		seedEdge({ id: "e-ab", source_key: "a", target_key: "b" });
		seedEdge({ id: "e-ac", source_key: "a", target_key: "c" });
		seedEdge({ id: "e-bd", source_key: "b", target_key: "d" });
		seedEdge({ id: "e-cd", source_key: "c", target_key: "d" });

		const rows = traverseMemoryGraph(db, "a", 3, null);
		const dRows = rows.filter((r) => r.key === "d");
		// Both distinct paths reach d, so the recursive CTE yields d twice (no
		// global visited-set, only per-path cycle prevention). Both at depth 2.
		expect(dRows.length).toBe(2);
		expect(dRows.every((r) => r.depth === 2)).toBe(true);
	});
});

describe("listOutgoingNeighbors", () => {
	it("returns [] when the key has no outgoing edges", () => {
		seedMemory({ id: "m-a", key: "a" });
		expect(listOutgoingNeighbors(db, "a")).toEqual([]);
	});

	it("returns [] for an absent key", () => {
		expect(listOutgoingNeighbors(db, "ghost")).toEqual([]);
	});

	it("projects exactly the GraphNeighborRow columns for the target side", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b", value: "b-value" });
		seedEdge({
			id: "e-ab",
			source_key: "a",
			target_key: "b",
			relation: "supports",
			weight: 0.9,
			context: "ctx-ab",
		});

		const rows = listOutgoingNeighbors(db, "a");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			key: "b",
			relation: "supports",
			weight: 0.9,
			context: "ctx-ab",
			value: "b-value",
		});
		expect(Object.keys(rows[0]).sort()).toEqual(
			["key", "relation", "weight", "context", "value"].sort(),
		);
	});

	it("surfaces a null context column", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b" });
		seedEdge({ id: "e-ab", source_key: "a", target_key: "b", context: null });

		const [row] = listOutgoingNeighbors(db, "a");
		expect(row.context).toBeNull();
	});

	it("drops an edge whose target memory row is soft-deleted", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b" });
		seedMemory({ id: "m-c", key: "c" });
		seedEdge({ id: "e-ab", source_key: "a", target_key: "b" });
		seedEdge({ id: "e-ac", source_key: "a", target_key: "c" });
		softDelete(db, "semantic_memory", "m-b", SITE_ID);

		const keys = listOutgoingNeighbors(db, "a").map((r) => r.key);
		expect(keys).toEqual(["c"]);
	});

	it("drops a soft-deleted edge", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b" });
		seedEdge({ id: "e-ab", source_key: "a", target_key: "b" });
		softDelete(db, "memory_edges", "e-ab", SITE_ID);

		expect(listOutgoingNeighbors(db, "a")).toEqual([]);
	});

	it("orders by weight DESC then modified_at DESC", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-hi", key: "hi" });
		seedMemory({ id: "m-lo", key: "lo" });
		// equal-weight pair to exercise the modified_at tiebreaker.
		seedMemory({ id: "m-old", key: "old", modified_at: "2026-01-02T00:00:00.000Z" });
		seedMemory({ id: "m-new", key: "new", modified_at: "2026-03-03T00:00:00.000Z" });

		seedEdge({ id: "e-hi", source_key: "a", target_key: "hi", weight: 0.9 });
		seedEdge({ id: "e-lo", source_key: "a", target_key: "lo", weight: 0.1 });
		seedEdge({ id: "e-old", source_key: "a", target_key: "old", weight: 0.5 });
		seedEdge({ id: "e-new", source_key: "a", target_key: "new", weight: 0.5 });

		const keys = listOutgoingNeighbors(db, "a").map((r) => r.key);
		// weight: hi(0.9) > {new,old}(0.5) > lo(0.1); within 0.5, newer first.
		expect(keys).toEqual(["hi", "new", "old", "lo"]);
	});

	it("does not return incoming edges", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b" });
		// b -> a (incoming to a); should be invisible to the outgoing query.
		seedEdge({ id: "e-ba", source_key: "b", target_key: "a" });

		expect(listOutgoingNeighbors(db, "a")).toEqual([]);
	});
});

describe("listIncomingNeighbors", () => {
	it("returns [] when the key has no incoming edges", () => {
		seedMemory({ id: "m-a", key: "a" });
		expect(listIncomingNeighbors(db, "a")).toEqual([]);
	});

	it("returns [] for an absent key", () => {
		expect(listIncomingNeighbors(db, "ghost")).toEqual([]);
	});

	it("projects the source side and resolves the source memory value", () => {
		seedMemory({ id: "m-a", key: "a", value: "a-value" });
		seedMemory({ id: "m-b", key: "b" });
		seedEdge({
			id: "e-ab",
			source_key: "a",
			target_key: "b",
			relation: "extends",
			weight: 0.42,
			context: "ctx-ab",
		});

		// Incoming neighbors of b: the edge a -> b, resolved against source 'a'.
		const rows = listIncomingNeighbors(db, "b");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			key: "a",
			relation: "extends",
			weight: 0.42,
			context: "ctx-ab",
			value: "a-value",
		});
	});

	it("drops an edge whose source memory row is soft-deleted", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b" });
		seedMemory({ id: "m-c", key: "c" });
		seedEdge({ id: "e-ac", source_key: "a", target_key: "c" });
		seedEdge({ id: "e-bc", source_key: "b", target_key: "c" });
		softDelete(db, "semantic_memory", "m-a", SITE_ID);

		const keys = listIncomingNeighbors(db, "c").map((r) => r.key);
		expect(keys).toEqual(["b"]);
	});

	it("drops a soft-deleted edge", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b" });
		seedEdge({ id: "e-ab", source_key: "a", target_key: "b" });
		softDelete(db, "memory_edges", "e-ab", SITE_ID);

		expect(listIncomingNeighbors(db, "b")).toEqual([]);
	});

	it("orders by weight DESC then modified_at DESC", () => {
		seedMemory({ id: "m-t", key: "t" });
		seedMemory({ id: "m-hi", key: "hi" });
		seedMemory({ id: "m-lo", key: "lo" });
		seedMemory({ id: "m-old", key: "old", modified_at: "2026-01-02T00:00:00.000Z" });
		seedMemory({ id: "m-new", key: "new", modified_at: "2026-03-03T00:00:00.000Z" });

		seedEdge({ id: "e-hi", source_key: "hi", target_key: "t", weight: 0.9 });
		seedEdge({ id: "e-lo", source_key: "lo", target_key: "t", weight: 0.1 });
		seedEdge({ id: "e-old", source_key: "old", target_key: "t", weight: 0.5 });
		seedEdge({ id: "e-new", source_key: "new", target_key: "t", weight: 0.5 });

		const keys = listIncomingNeighbors(db, "t").map((r) => r.key);
		expect(keys).toEqual(["hi", "new", "old", "lo"]);
	});

	it("does not return outgoing edges", () => {
		seedMemory({ id: "m-a", key: "a" });
		seedMemory({ id: "m-b", key: "b" });
		// a -> b is outgoing from a; querying incoming of a must skip it.
		seedEdge({ id: "e-ab", source_key: "a", target_key: "b" });

		expect(listIncomingNeighbors(db, "a")).toEqual([]);
	});
});
