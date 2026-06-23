import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MemoryEdge } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../index";
import {
	countIncomingSummarizesEdges,
	findActiveEdgeIdById,
	findCollidingActiveEdge,
	findEdgeDeletedStateById,
	listActiveEdgeIdsBySourceAndTarget,
	listActiveEdgeIdsReferencingKey,
	listActiveEdgeSummaries,
	listEdgesWithNonCanonicalRelation,
	listSummarizesChildKeysBySource,
	listSummarizesParentsByChildKeys,
} from "../memory-edges";

const SITE_ID = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

/** Seed a memory_edges row through the trusted outbox write path. */
function seedEdge(db: Database, overrides: Partial<MemoryEdge> = {}): string {
	const id = overrides.id ?? `edge-${Math.random().toString(36).slice(2)}`;
	const row: MemoryEdge = {
		id,
		source_key: "src",
		target_key: "tgt",
		relation: "related_to",
		weight: 1.0,
		created_at: TS,
		modified_at: TS,
		context: null,
		deleted: 0,
		...overrides,
	};
	insertRow(db, "memory_edges", row, SITE_ID);
	return id;
}

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
});

afterEach(() => {
	db.close();
});

describe("findEdgeDeletedStateById (deleted-omission variant)", () => {
	it("returns the row for an active edge", () => {
		seedEdge(db, { id: "e1" });
		expect(findEdgeDeletedStateById(db, "e1")).toEqual({ id: "e1", deleted: 0 });
	});

	it("RETURNS a soft-deleted tombstone (no deleted=0 filter)", () => {
		seedEdge(db, { id: "e-dead" });
		softDelete(db, "memory_edges", "e-dead", SITE_ID);
		expect(findEdgeDeletedStateById(db, "e-dead")).toEqual({ id: "e-dead", deleted: 1 });
	});

	it("returns null on a miss", () => {
		expect(findEdgeDeletedStateById(db, "absent")).toBeNull();
	});
});

describe("findActiveEdgeIdById (deleted=0 sibling)", () => {
	it("returns the id for an active edge", () => {
		seedEdge(db, { id: "e2" });
		expect(findActiveEdgeIdById(db, "e2")).toEqual({ id: "e2" });
	});

	it("does NOT return a soft-deleted edge (contrast with the omission variant)", () => {
		seedEdge(db, { id: "e-dead" });
		softDelete(db, "memory_edges", "e-dead", SITE_ID);
		expect(findActiveEdgeIdById(db, "e-dead")).toBeNull();
		// The omission sibling still sees the tombstone.
		expect(findEdgeDeletedStateById(db, "e-dead")).toEqual({ id: "e-dead", deleted: 1 });
	});

	it("returns null on a miss", () => {
		expect(findActiveEdgeIdById(db, "absent")).toBeNull();
	});
});

describe("listActiveEdgeIdsBySourceAndTarget", () => {
	it("returns only active edges for the exact directed pair", () => {
		seedEdge(db, { id: "ab1", source_key: "a", target_key: "b", relation: "related_to" });
		seedEdge(db, { id: "ab2", source_key: "a", target_key: "b", relation: "informs" });
		// Wrong direction, wrong target, and a soft-deleted match must be excluded.
		seedEdge(db, { id: "ba", source_key: "b", target_key: "a" });
		seedEdge(db, { id: "ac", source_key: "a", target_key: "c" });
		seedEdge(db, { id: "ab-dead", source_key: "a", target_key: "b", relation: "supports" });
		softDelete(db, "memory_edges", "ab-dead", SITE_ID);

		const ids = listActiveEdgeIdsBySourceAndTarget(db, "a", "b")
			.map((r) => r.id)
			.sort();
		expect(ids).toEqual(["ab1", "ab2"]);
	});

	it("returns [] when no pair matches", () => {
		seedEdge(db, { id: "x", source_key: "a", target_key: "b" });
		expect(listActiveEdgeIdsBySourceAndTarget(db, "no", "match")).toEqual([]);
	});
});

describe("listActiveEdgeIdsReferencingKey", () => {
	it("matches the key as either source OR target, active only", () => {
		seedEdge(db, { id: "asrc", source_key: "k", target_key: "other", relation: "related_to" });
		seedEdge(db, { id: "atgt", source_key: "other", target_key: "k", relation: "informs" });
		seedEdge(db, { id: "none", source_key: "x", target_key: "y" });
		seedEdge(db, { id: "dead", source_key: "k", target_key: "z", relation: "supports" });
		softDelete(db, "memory_edges", "dead", SITE_ID);

		const ids = listActiveEdgeIdsReferencingKey(db, "k")
			.map((r) => r.id)
			.sort();
		expect(ids).toEqual(["asrc", "atgt"]);
	});

	it("returns [] for an unreferenced key", () => {
		seedEdge(db, { id: "x", source_key: "a", target_key: "b" });
		expect(listActiveEdgeIdsReferencingKey(db, "ghost")).toEqual([]);
	});
});

describe("listSummarizesChildKeysBySource", () => {
	it("returns target keys of active 'summarizes' edges from the source", () => {
		seedEdge(db, { id: "s1", source_key: "parent", target_key: "child1", relation: "summarizes" });
		seedEdge(db, { id: "s2", source_key: "parent", target_key: "child2", relation: "summarizes" });
		// Non-summarizes relation, different source, and a tombstone are excluded.
		seedEdge(db, { id: "r1", source_key: "parent", target_key: "childX", relation: "informs" });
		seedEdge(db, {
			id: "s3",
			source_key: "other",
			target_key: "child3",
			relation: "summarizes",
		});
		seedEdge(db, {
			id: "s-dead",
			source_key: "parent",
			target_key: "childDead",
			relation: "summarizes",
		});
		softDelete(db, "memory_edges", "s-dead", SITE_ID);

		const keys = listSummarizesChildKeysBySource(db, "parent")
			.map((r) => r.target_key)
			.sort();
		expect(keys).toEqual(["child1", "child2"]);
	});

	it("returns [] when the source has no summarizes edges", () => {
		seedEdge(db, { id: "x", source_key: "parent", target_key: "c", relation: "informs" });
		expect(listSummarizesChildKeysBySource(db, "parent")).toEqual([]);
	});
});

describe("countIncomingSummarizesEdges (aggregate)", () => {
	it("counts only active incoming 'summarizes' edges for the target", () => {
		seedEdge(db, { id: "i1", source_key: "p1", target_key: "t", relation: "summarizes" });
		seedEdge(db, { id: "i2", source_key: "p2", target_key: "t", relation: "summarizes" });
		// Wrong relation, wrong target, and a tombstone do not count.
		seedEdge(db, { id: "i3", source_key: "p3", target_key: "t", relation: "informs" });
		seedEdge(db, { id: "i4", source_key: "p4", target_key: "other", relation: "summarizes" });
		seedEdge(db, { id: "i-dead", source_key: "p5", target_key: "t", relation: "summarizes" });
		softDelete(db, "memory_edges", "i-dead", SITE_ID);

		expect(countIncomingSummarizesEdges(db, "t")).toBe(2);
	});

	it("returns 0 (not null) for a target with no incoming summarizes edges", () => {
		expect(countIncomingSummarizesEdges(db, "ghost")).toBe(0);
	});
});

describe("listEdgesWithNonCanonicalRelation (dynamic NOT IN)", () => {
	// The canonical-relation trigger forbids inserting non-canonical relations, so
	// we exercise the dynamic NOT IN by supplying a PARTIAL canonical list: any
	// canonical relation absent from the supplied list is "non-canonical" to this
	// query. Includes soft-deleted rows (no deleted=0 filter).
	function seedMix(): void {
		seedEdge(db, {
			id: "keep1",
			source_key: "a",
			target_key: "b",
			relation: "informs",
			weight: 2.0,
			context: "ctx",
		});
		seedEdge(db, { id: "keep2", source_key: "c", target_key: "d", relation: "supports" });
		seedEdge(db, { id: "drop", source_key: "e", target_key: "f", relation: "related_to" });
		seedEdge(db, { id: "drop-dead", source_key: "g", target_key: "h", relation: "informs" });
		softDelete(db, "memory_edges", "drop-dead", SITE_ID);
	}

	it("empty list returns ALL rows (NOT IN () excludes nothing) without throwing", () => {
		seedMix();
		const ids = listEdgesWithNonCanonicalRelation(db, [])
			.map((r) => r.id)
			.sort();
		expect(ids).toEqual(["drop", "drop-dead", "keep1", "keep2"]);
	});

	it("single-element list excludes that relation, keeps the rest including tombstones", () => {
		seedMix();
		const ids = listEdgesWithNonCanonicalRelation(db, ["related_to"])
			.map((r) => r.id)
			.sort();
		// related_to ("drop") excluded; informs (keep1, drop-dead tombstone) + supports (keep2) remain.
		expect(ids).toEqual(["drop-dead", "keep1", "keep2"]);
	});

	it("multi-element list excludes all listed relations and projects the full column subset", () => {
		seedMix();
		const rows = listEdgesWithNonCanonicalRelation(db, ["related_to", "supports"]);
		expect(rows.map((r) => r.id).sort()).toEqual(["drop-dead", "keep1"]);
		const keep1 = rows.find((r) => r.id === "keep1");
		expect(keep1).toEqual({
			id: "keep1",
			source_key: "a",
			target_key: "b",
			relation: "informs",
			weight: 2.0,
			context: "ctx",
			deleted: 0,
		});
		// context defaults to null when not supplied at insert time.
		const deadRow = rows.find((r) => r.id === "drop-dead");
		expect(deadRow?.context).toBeNull();
		expect(deadRow?.deleted).toBe(1);
	});
});

describe("findCollidingActiveEdge", () => {
	it("finds an active edge on the (source,target,relation) triple excluding the given id", () => {
		seedEdge(db, {
			id: "existing",
			source_key: "a",
			target_key: "b",
			relation: "informs",
			weight: 3.0,
			context: "note",
		});
		const hit = findCollidingActiveEdge(db, "a", "b", "informs", "self");
		expect(hit).toEqual({ id: "existing", weight: 3.0, context: "note" });
	});

	it("excludes the edge matching excludeId", () => {
		seedEdge(db, { id: "self", source_key: "a", target_key: "b", relation: "informs" });
		expect(findCollidingActiveEdge(db, "a", "b", "informs", "self")).toBeNull();
	});

	it("ignores a soft-deleted collision", () => {
		seedEdge(db, { id: "dead", source_key: "a", target_key: "b", relation: "informs" });
		softDelete(db, "memory_edges", "dead", SITE_ID);
		expect(findCollidingActiveEdge(db, "a", "b", "informs", "other")).toBeNull();
	});

	it("returns null when no triple matches", () => {
		seedEdge(db, { id: "x", source_key: "a", target_key: "b", relation: "informs" });
		expect(findCollidingActiveEdge(db, "a", "b", "supports", "other")).toBeNull();
	});
});

describe("listActiveEdgeSummaries", () => {
	it("returns the (source,target,relation,modified_at) subset for active edges only", () => {
		seedEdge(db, {
			id: "live",
			source_key: "a",
			target_key: "b",
			relation: "informs",
			modified_at: "2026-02-02T00:00:00.000Z",
		});
		seedEdge(db, { id: "dead", source_key: "c", target_key: "d", relation: "supports" });
		softDelete(db, "memory_edges", "dead", SITE_ID);

		const rows = listActiveEdgeSummaries(db);
		expect(rows).toEqual([
			{
				source_key: "a",
				target_key: "b",
				relation: "informs",
				modified_at: "2026-02-02T00:00:00.000Z",
			},
		]);
	});

	it("returns [] when there are no active edges", () => {
		expect(listActiveEdgeSummaries(db)).toEqual([]);
	});
});

describe("listSummarizesParentsByChildKeys (dynamic IN)", () => {
	function seedTree(): void {
		seedEdge(db, { id: "p1", source_key: "parentA", target_key: "child1", relation: "summarizes" });
		seedEdge(db, { id: "p2", source_key: "parentB", target_key: "child2", relation: "summarizes" });
		// Non-summarizes relation into child3 and a tombstone into child1 are excluded.
		seedEdge(db, { id: "p3", source_key: "parentC", target_key: "child3", relation: "informs" });
		seedEdge(db, {
			id: "p-dead",
			source_key: "parentD",
			target_key: "child1",
			relation: "summarizes",
		});
		softDelete(db, "memory_edges", "p-dead", SITE_ID);
	}

	it("empty list returns [] (IN () matches nothing) without throwing", () => {
		seedTree();
		expect(listSummarizesParentsByChildKeys(db, [])).toEqual([]);
	});

	it("single key returns its child->parent mapping", () => {
		seedTree();
		expect(listSummarizesParentsByChildKeys(db, ["child1"])).toEqual([
			{ child: "child1", parent: "parentA" },
		]);
	});

	it("multiple keys return all matching mappings, excluding non-summarizes and tombstones", () => {
		seedTree();
		const rows = listSummarizesParentsByChildKeys(db, ["child1", "child2", "child3"]).sort((a, b) =>
			a.child.localeCompare(b.child),
		);
		expect(rows).toEqual([
			{ child: "child1", parent: "parentA" },
			{ child: "child2", parent: "parentB" },
		]);
	});
});
