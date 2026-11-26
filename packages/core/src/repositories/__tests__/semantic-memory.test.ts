import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SemanticMemory } from "@bound/shared";
import { createCoreTestDb } from "../../__tests__/test-database";
import { insertRow, softDelete } from "../../index";
import {
	countActiveMemory,
	countMemoryByKeyPrefix,
	findMemoryIdByKeyIncludingDeleted,
	findMemoryValueByKey,
	listDetailMemoryAccessOrder,
	listMemoryDeltaKeysSince,
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
		db = createCoreTestDb({ metrics: true });
	});

	afterEach(() => {
		db.close();
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

	describe("findMemoryIdByKeyIncludingDeleted (deleted-filter OMISSION variant)", () => {
		it("returns the id for a live key", () => {
			insertRow(db, "semantic_memory", makeMemory({ id: "m1", key: "live", value: "v" }), SITE_ID);
			expect(findMemoryIdByKeyIncludingDeleted(db, "live")).toEqual({ id: "m1" });
		});

		it("returns null for an absent key", () => {
			expect(findMemoryIdByKeyIncludingDeleted(db, "nope")).toBeNull();
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
