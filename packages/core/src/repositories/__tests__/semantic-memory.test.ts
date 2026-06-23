import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SemanticMemory } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../index";
import {
	countActiveMemory,
	countMemoryByKeyPrefix,
	countPinnedMemoryExcludingKeys,
	findMemoryById,
	findMemoryByKey,
	findMemoryIdByKey,
	findMemoryIdByKeyIncludingDeleted,
	findMemoryIdTierByKey,
	findMemoryStateByKeyIncludingDeleted,
	findMemoryValueByKey,
	listDetailMemoryAccessOrder,
	listMemoryDeltaKeysSince,
	listMemoryIdKeyByKeyPrefix,
	listMemoryIdKeyBySource,
	listMemorySamplesByTierSince,
	listMemoryValues,
} from "../semantic-memory";

const SITE_ID = "site-test";
const T0 = "2026-01-01T00:00:00.000Z";

function makeMemory(
	overrides: Partial<SemanticMemory> & Pick<SemanticMemory, "id" | "key" | "value">,
): SemanticMemory {
	return {
		source: null,
		created_at: T0,
		modified_at: T0,
		last_accessed_at: null,
		tier: "default",
		deleted: 0,
		...overrides,
	};
}

describe("semantic-memory repository finders", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("findMemoryById (by-id, no deleted filter)", () => {
		it("returns the full row for an existing id (happy path)", () => {
			insertRow(
				db,
				"semantic_memory",
				makeMemory({
					id: "m1",
					key: "alpha",
					value: "v-alpha",
					source: "thread-1",
					tier: "summary",
					last_accessed_at: "2026-02-02T00:00:00.000Z",
				}),
				SITE_ID,
			);

			const row = findMemoryById(db, "m1");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("m1");
			expect(row?.key).toBe("alpha");
			expect(row?.value).toBe("v-alpha");
			expect(row?.source).toBe("thread-1");
			expect(row?.tier).toBe("summary");
			expect(row?.last_accessed_at).toBe("2026-02-02T00:00:00.000Z");
			expect(row?.deleted).toBe(0);
		});

		it("returns null for an absent id (miss path)", () => {
			expect(findMemoryById(db, "nope")).toBeNull();
		});

		it("still returns a soft-deleted row (no deleted filter)", () => {
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m-dead", key: "k-dead", value: "x" }),
				SITE_ID,
			);
			softDelete(db, "semantic_memory", "m-dead", SITE_ID);

			const row = findMemoryById(db, "m-dead");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("m-dead");
			expect(row?.deleted).toBe(1);
		});
	});

	describe("findMemoryByKey (by-key, deleted=0 filter)", () => {
		it("returns the live row for a key (happy path)", () => {
			insertRow(db, "semantic_memory", makeMemory({ id: "m1", key: "alpha", value: "v" }), SITE_ID);
			const row = findMemoryByKey(db, "alpha");
			expect(row?.id).toBe("m1");
			expect(row?.value).toBe("v");
		});

		it("returns null for an absent key (miss path)", () => {
			expect(findMemoryByKey(db, "ghost")).toBeNull();
		});

		it("returns null for a soft-deleted key (deleted=0 filter active)", () => {
			insertRow(db, "semantic_memory", makeMemory({ id: "m-d", key: "gone", value: "v" }), SITE_ID);
			softDelete(db, "semantic_memory", "m-d", SITE_ID);
			expect(findMemoryByKey(db, "gone")).toBeNull();
		});
	});

	describe("findMemoryValueByKey (value projection, deleted=0)", () => {
		it("returns the value for a live key", () => {
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m1", key: "k", value: "the-value" }),
				SITE_ID,
			);
			expect(findMemoryValueByKey(db, "k")).toEqual({ value: "the-value" });
		});

		it("returns null for a soft-deleted key", () => {
			insertRow(db, "semantic_memory", makeMemory({ id: "m1", key: "k", value: "v" }), SITE_ID);
			softDelete(db, "semantic_memory", "m1", SITE_ID);
			expect(findMemoryValueByKey(db, "k")).toBeNull();
		});

		it("returns null for an absent key", () => {
			expect(findMemoryValueByKey(db, "nope")).toBeNull();
		});
	});

	describe("findMemoryIdByKey (id projection, deleted=0)", () => {
		it("returns the id for a live key", () => {
			insertRow(db, "semantic_memory", makeMemory({ id: "m1", key: "k", value: "v" }), SITE_ID);
			expect(findMemoryIdByKey(db, "k")).toEqual({ id: "m1" });
		});

		it("returns null for a soft-deleted key", () => {
			insertRow(db, "semantic_memory", makeMemory({ id: "m1", key: "k", value: "v" }), SITE_ID);
			softDelete(db, "semantic_memory", "m1", SITE_ID);
			expect(findMemoryIdByKey(db, "k")).toBeNull();
		});

		it("returns null for an absent key", () => {
			expect(findMemoryIdByKey(db, "nope")).toBeNull();
		});
	});

	describe("findMemoryIdTierByKey (id+tier projection, deleted=0)", () => {
		it("returns id and tier for a live key", () => {
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m1", key: "k", value: "v", tier: "pinned" }),
				SITE_ID,
			);
			expect(findMemoryIdTierByKey(db, "k")).toEqual({ id: "m1", tier: "pinned" });
		});

		it("returns null for a soft-deleted key", () => {
			insertRow(db, "semantic_memory", makeMemory({ id: "m1", key: "k", value: "v" }), SITE_ID);
			softDelete(db, "semantic_memory", "m1", SITE_ID);
			expect(findMemoryIdTierByKey(db, "k")).toBeNull();
		});

		it("returns null for an absent key", () => {
			expect(findMemoryIdTierByKey(db, "nope")).toBeNull();
		});
	});

	describe("findMemoryIdByKeyIncludingDeleted (deleted-filter OMISSION variant)", () => {
		it("returns the id for a live key", () => {
			insertRow(db, "semantic_memory", makeMemory({ id: "m1", key: "live", value: "v" }), SITE_ID);
			expect(findMemoryIdByKeyIncludingDeleted(db, "live")).toEqual({ id: "m1" });
		});

		it("returns null for an absent key", () => {
			expect(findMemoryIdByKeyIncludingDeleted(db, "nope")).toBeNull();
		});

		it("RETURNS a tombstoned row, unlike its deleted=0 sibling findMemoryIdByKey", () => {
			// A live row (distinct key) and a soft-deleted row.
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m-live", key: "live", value: "v" }),
				SITE_ID,
			);
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m-tomb", key: "tomb", value: "v" }),
				SITE_ID,
			);
			softDelete(db, "semantic_memory", "m-tomb", SITE_ID);

			// The omission finder sees the tombstone...
			expect(findMemoryIdByKeyIncludingDeleted(db, "tomb")).toEqual({ id: "m-tomb" });
			// ...but the deleted=0 sibling does NOT.
			expect(findMemoryIdByKey(db, "tomb")).toBeNull();

			// Both agree on the live row.
			expect(findMemoryIdByKeyIncludingDeleted(db, "live")).toEqual({ id: "m-live" });
			expect(findMemoryIdByKey(db, "live")).toEqual({ id: "m-live" });
		});
	});

	describe("findMemoryStateByKeyIncludingDeleted (deleted-filter OMISSION variant)", () => {
		it("returns id/deleted/tier for a live key", () => {
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m1", key: "k", value: "v", tier: "summary" }),
				SITE_ID,
			);
			expect(findMemoryStateByKeyIncludingDeleted(db, "k")).toEqual({
				id: "m1",
				deleted: 0,
				tier: "summary",
			});
		});

		it("returns null for an absent key", () => {
			expect(findMemoryStateByKeyIncludingDeleted(db, "nope")).toBeNull();
		});

		it("RETURNS a tombstoned row with deleted=1, unlike its deleted=0 sibling findMemoryIdTierByKey", () => {
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m-tomb", key: "tomb", value: "v", tier: "detail" }),
				SITE_ID,
			);
			softDelete(db, "semantic_memory", "m-tomb", SITE_ID);

			expect(findMemoryStateByKeyIncludingDeleted(db, "tomb")).toEqual({
				id: "m-tomb",
				deleted: 1,
				tier: "detail",
			});
			// The deleted=0 sibling does NOT see it.
			expect(findMemoryIdTierByKey(db, "tomb")).toBeNull();
		});
	});

	describe("listMemoryIdKeyBySource (deleted=0)", () => {
		it("returns only live (id,key) pairs matching the source", () => {
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m1", key: "a", value: "v", source: "src-1" }),
				SITE_ID,
			);
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m2", key: "b", value: "v", source: "src-1" }),
				SITE_ID,
			);
			// Different source — must be excluded.
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m3", key: "c", value: "v", source: "src-2" }),
				SITE_ID,
			);
			// Matching source but soft-deleted — must be excluded.
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m4", key: "d", value: "v", source: "src-1" }),
				SITE_ID,
			);
			softDelete(db, "semantic_memory", "m4", SITE_ID);

			const rows = listMemoryIdKeyBySource(db, "src-1");
			expect(rows).toEqual([
				{ id: "m1", key: "a" },
				{ id: "m2", key: "b" },
			]);
		});

		it("returns an empty array when no source matches", () => {
			expect(listMemoryIdKeyBySource(db, "nope")).toEqual([]);
		});
	});

	describe("listMemoryValues (deleted=0)", () => {
		it("returns the values of all live entries and omits tombstones", () => {
			insertRow(db, "semantic_memory", makeMemory({ id: "m1", key: "a", value: "one" }), SITE_ID);
			insertRow(db, "semantic_memory", makeMemory({ id: "m2", key: "b", value: "two" }), SITE_ID);
			insertRow(db, "semantic_memory", makeMemory({ id: "m3", key: "c", value: "dead" }), SITE_ID);
			softDelete(db, "semantic_memory", "m3", SITE_ID);

			const values = listMemoryValues(db)
				.map((r) => r.value)
				.sort();
			expect(values).toEqual(["one", "two"]);
		});

		it("returns an empty array on an empty table", () => {
			expect(listMemoryValues(db)).toEqual([]);
		});
	});

	describe("listMemoryIdKeyByKeyPrefix (LIKE pattern, deleted=0)", () => {
		it("returns only live (id,key) pairs matching the LIKE pattern", () => {
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m1", key: "pre.one", value: "v" }),
				SITE_ID,
			);
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m2", key: "pre.two", value: "v" }),
				SITE_ID,
			);
			insertRow(db, "semantic_memory", makeMemory({ id: "m3", key: "other", value: "v" }), SITE_ID);
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m4", key: "pre.dead", value: "v" }),
				SITE_ID,
			);
			softDelete(db, "semantic_memory", "m4", SITE_ID);

			const rows = listMemoryIdKeyByKeyPrefix(db, "pre.%");
			expect(rows).toEqual([
				{ id: "m1", key: "pre.one" },
				{ id: "m2", key: "pre.two" },
			]);
		});

		it("returns an empty array when no key matches", () => {
			expect(listMemoryIdKeyByKeyPrefix(db, "zzz%")).toEqual([]);
		});
	});

	describe("countMemoryByKeyPrefix (COUNT aggregate, LIKE, deleted=0)", () => {
		it("counts only live entries matching the pattern", () => {
			insertRow(db, "semantic_memory", makeMemory({ id: "m1", key: "p.a", value: "v" }), SITE_ID);
			insertRow(db, "semantic_memory", makeMemory({ id: "m2", key: "p.b", value: "v" }), SITE_ID);
			insertRow(db, "semantic_memory", makeMemory({ id: "m3", key: "q.c", value: "v" }), SITE_ID);
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m4", key: "p.dead", value: "v" }),
				SITE_ID,
			);
			softDelete(db, "semantic_memory", "m4", SITE_ID);

			expect(countMemoryByKeyPrefix(db, "p.%")).toBe(2);
		});

		it("returns 0 when nothing matches (zero-row aggregate)", () => {
			expect(countMemoryByKeyPrefix(db, "nothing%")).toBe(0);
		});
	});

	describe("countActiveMemory (COUNT aggregate, deleted=0)", () => {
		it("counts only live entries", () => {
			insertRow(db, "semantic_memory", makeMemory({ id: "m1", key: "a", value: "v" }), SITE_ID);
			insertRow(db, "semantic_memory", makeMemory({ id: "m2", key: "b", value: "v" }), SITE_ID);
			insertRow(db, "semantic_memory", makeMemory({ id: "m3", key: "c", value: "v" }), SITE_ID);
			softDelete(db, "semantic_memory", "m3", SITE_ID);

			expect(countActiveMemory(db)).toBe(2);
		});

		it("returns 0 on an empty table (zero-row aggregate)", () => {
			expect(countActiveMemory(db)).toBe(0);
		});
	});

	describe("countPinnedMemoryExcludingKeys (dynamic NOT IN, COUNT aggregate)", () => {
		beforeEach(() => {
			// 3 live pinned, 1 deleted pinned, 1 non-pinned.
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "p1", key: "pin.a", value: "v", tier: "pinned" }),
				SITE_ID,
			);
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "p2", key: "pin.b", value: "v", tier: "pinned" }),
				SITE_ID,
			);
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "p3", key: "pin.c", value: "v", tier: "pinned" }),
				SITE_ID,
			);
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "p4", key: "pin.dead", value: "v", tier: "pinned" }),
				SITE_ID,
			);
			softDelete(db, "semantic_memory", "p4", SITE_ID);
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "n1", key: "plain", value: "v", tier: "default" }),
				SITE_ID,
			);
		});

		it("empty exclude list counts all live pinned entries (NOT match-all, NOT throw)", () => {
			expect(countPinnedMemoryExcludingKeys(db, [])).toBe(3);
		});

		it("single excluded key drops exactly that one from the count", () => {
			expect(countPinnedMemoryExcludingKeys(db, ["pin.a"])).toBe(2);
		});

		it("multiple excluded keys drop each matching live pinned entry", () => {
			expect(countPinnedMemoryExcludingKeys(db, ["pin.a", "pin.b"])).toBe(1);
		});

		it("excluding a non-existent/non-pinned key changes nothing", () => {
			expect(countPinnedMemoryExcludingKeys(db, ["plain", "ghost"])).toBe(3);
		});

		it("returns 0 when there are no pinned entries (zero-row aggregate)", () => {
			const fresh = new Database(":memory:");
			applySchema(fresh);
			applyMetricsSchema(fresh);
			expect(countPinnedMemoryExcludingKeys(fresh, [])).toBe(0);
			expect(countPinnedMemoryExcludingKeys(fresh, ["x"])).toBe(0);
			fresh.close();
		});
	});

	describe("listMemoryDeltaKeysSince (DISTINCT keys, modified_at > baseline, deleted=0, internal-excluded)", () => {
		it("returns keys strictly newer than the baseline, excluding _internal.% and tombstones", () => {
			// Older than baseline — excluded.
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m1", key: "old", value: "v", modified_at: "2026-01-01T00:00:00.000Z" }),
				SITE_ID,
			);
			// Equal to baseline — excluded (strict >).
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m2", key: "eq", value: "v", modified_at: "2026-03-01T00:00:00.000Z" }),
				SITE_ID,
			);
			// Newer — included.
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m3", key: "new-a", value: "v", modified_at: "2026-04-01T00:00:00.000Z" }),
				SITE_ID,
			);
			// Newer but internal — excluded.
			insertRow(
				db,
				"semantic_memory",
				makeMemory({
					id: "m4",
					key: "_internal.x",
					value: "v",
					modified_at: "2026-04-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			// Newer but soft-deleted — excluded.
			insertRow(
				db,
				"semantic_memory",
				makeMemory({
					id: "m5",
					key: "new-dead",
					value: "v",
					modified_at: "2026-04-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			softDelete(db, "semantic_memory", "m5", SITE_ID);

			const keys = listMemoryDeltaKeysSince(db, "2026-03-01T00:00:00.000Z").map((r) => r.key);
			expect(keys).toEqual(["new-a"]);
		});

		it("returns an empty array when nothing is newer than the baseline", () => {
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "m1", key: "k", value: "v", modified_at: "2026-01-01T00:00:00.000Z" }),
				SITE_ID,
			);
			expect(listMemoryDeltaKeysSince(db, "2026-12-31T00:00:00.000Z")).toEqual([]);
		});
	});

	describe("listMemorySamplesByTierSince (tier IN summary/detail, modified_at >= cutoff, RANDOM, LIMIT)", () => {
		it("only samples live summary/detail entries at or after the cutoff", () => {
			// Eligible: summary & detail, modified_at >= cutoff, live.
			insertRow(
				db,
				"semantic_memory",
				makeMemory({
					id: "s1",
					key: "sum",
					value: "v-sum",
					tier: "summary",
					modified_at: "2026-03-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			insertRow(
				db,
				"semantic_memory",
				makeMemory({
					id: "d1",
					key: "det",
					value: "v-det",
					tier: "detail",
					modified_at: "2026-04-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			// Ineligible tier.
			insertRow(
				db,
				"semantic_memory",
				makeMemory({
					id: "p1",
					key: "pin",
					value: "v",
					tier: "pinned",
					modified_at: "2026-04-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			insertRow(
				db,
				"semantic_memory",
				makeMemory({
					id: "df1",
					key: "def",
					value: "v",
					tier: "default",
					modified_at: "2026-04-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			// Eligible tier but too old.
			insertRow(
				db,
				"semantic_memory",
				makeMemory({
					id: "old1",
					key: "old",
					value: "v",
					tier: "summary",
					modified_at: "2026-01-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			// Eligible tier+date but soft-deleted.
			insertRow(
				db,
				"semantic_memory",
				makeMemory({
					id: "dead1",
					key: "dead",
					value: "v",
					tier: "detail",
					modified_at: "2026-04-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			softDelete(db, "semantic_memory", "dead1", SITE_ID);

			const rows = listMemorySamplesByTierSince(db, "2026-03-01T00:00:00.000Z", 100);
			const keys = rows.map((r) => r.key).sort();
			expect(keys).toEqual(["det", "sum"]);
			// Verify projected shape on one known row.
			const sum = rows.find((r) => r.key === "sum");
			expect(sum).toEqual({ key: "sum", value: "v-sum", tier: "summary" });
		});

		it("honors LIMIT — never returns more than the cap", () => {
			for (let i = 0; i < 5; i++) {
				insertRow(
					db,
					"semantic_memory",
					makeMemory({
						id: `s${i}`,
						key: `sum-${i}`,
						value: "v",
						tier: "summary",
						modified_at: "2026-03-01T00:00:00.000Z",
					}),
					SITE_ID,
				);
			}
			expect(listMemorySamplesByTierSince(db, "2026-01-01T00:00:00.000Z", 2)).toHaveLength(2);
		});

		it("returns an empty array when nothing qualifies", () => {
			expect(listMemorySamplesByTierSince(db, "2026-01-01T00:00:00.000Z", 10)).toEqual([]);
		});
	});

	describe("listDetailMemoryAccessOrder (tier=detail, deleted=0, ORDER BY last_accessed_at DESC)", () => {
		it("orders detail entries by last_accessed_at DESC and omits non-detail/tombstones", () => {
			insertRow(
				db,
				"semantic_memory",
				makeMemory({
					id: "d-old",
					key: "old",
					value: "v",
					tier: "detail",
					last_accessed_at: "2026-01-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			insertRow(
				db,
				"semantic_memory",
				makeMemory({
					id: "d-new",
					key: "new",
					value: "v",
					tier: "detail",
					last_accessed_at: "2026-05-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			insertRow(
				db,
				"semantic_memory",
				makeMemory({
					id: "d-mid",
					key: "mid",
					value: "v",
					tier: "detail",
					last_accessed_at: "2026-03-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			// Non-detail tier — excluded.
			insertRow(
				db,
				"semantic_memory",
				makeMemory({
					id: "sum",
					key: "sum",
					value: "v",
					tier: "summary",
					last_accessed_at: "2026-06-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			// Detail but tombstoned — excluded.
			insertRow(
				db,
				"semantic_memory",
				makeMemory({
					id: "dead",
					key: "dead",
					value: "v",
					tier: "detail",
					last_accessed_at: "2026-07-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			softDelete(db, "semantic_memory", "dead", SITE_ID);

			const rows = listDetailMemoryAccessOrder(db);
			expect(rows.map((r) => r.id)).toEqual(["d-new", "d-mid", "d-old"]);
			expect(rows.map((r) => r.last_accessed_at)).toEqual([
				"2026-05-01T00:00:00.000Z",
				"2026-03-01T00:00:00.000Z",
				"2026-01-01T00:00:00.000Z",
			]);
		});

		it("returns an empty array when there are no live detail entries", () => {
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id: "s", key: "s", value: "v", tier: "summary" }),
				SITE_ID,
			);
			expect(listDetailMemoryAccessOrder(db)).toEqual([]);
		});
	});
});
