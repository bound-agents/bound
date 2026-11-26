import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MemoryEdge } from "@bound/shared";
import { createCoreTestDb } from "../../__tests__/test-database";
import { insertRow, softDelete } from "../../index";
import {
	findActiveEdgeIdById,
	findEdgeDeletedStateById,
	listActiveEdgeIdsBySourceAndTarget,
	listActiveEdgeIdsReferencingKey,
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
	db = createCoreTestDb({ metrics: true });
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
