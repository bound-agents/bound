import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { OverlayIndexEntry } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow } from "../../index";
import {
	findOverlayContentHashByIdActive,
	findOverlayContentHashByPathActive,
	listOverlayIdPathBySiteActive,
} from "../overlay-index";

const SITE = "site-A";
const OTHER_SITE = "site-B";
const TS = "2026-01-01T00:00:00.000Z";

/**
 * Build a complete overlay_index row. Every column from the OverlayIndexEntry
 * type is populated so insertRow (STRICT table) never rejects.
 *
 * NOTE: the overlay_index table has NO `modified_at` column, so softDelete()
 * and updateRow() — which unconditionally write `modified_at = ?` — both throw
 * "no such column: modified_at" against this table. The only sanctioned way to
 * produce a tombstoned row through the outbox write path is insertRow with
 * deleted: 1, which is what `dead` rows below do.
 */
function row(overrides: Partial<OverlayIndexEntry> & { id: string }): OverlayIndexEntry {
	return {
		site_id: SITE,
		path: `/mnt/repo/${overrides.id}`,
		size_bytes: 100,
		content_hash: `hash-${overrides.id}`,
		indexed_at: TS,
		deleted: 0,
		...overrides,
	};
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

describe("findOverlayContentHashByPathActive", () => {
	it("returns the content_hash for a live row matching the path", () => {
		insertRow(
			db,
			"overlay_index",
			row({ id: "o1", path: "/mnt/repo/a.ts", content_hash: "abc123" }),
			SITE,
		);

		const result = findOverlayContentHashByPathActive(db, "/mnt/repo/a.ts");

		expect(result).toEqual({ content_hash: "abc123" });
	});

	it("returns null for an absent path", () => {
		insertRow(db, "overlay_index", row({ id: "o1", path: "/mnt/repo/a.ts" }), SITE);

		const result = findOverlayContentHashByPathActive(db, "/mnt/repo/nope.ts");

		expect(result).toBeNull();
	});

	it("preserves a null content_hash on a live row", () => {
		insertRow(
			db,
			"overlay_index",
			row({ id: "o1", path: "/mnt/repo/empty.ts", content_hash: null }),
			SITE,
		);

		const result = findOverlayContentHashByPathActive(db, "/mnt/repo/empty.ts");

		expect(result).toEqual({ content_hash: null });
	});

	it("omits a soft-deleted row at the same path (deleted = 0 filter)", () => {
		// Tombstone seeded directly via insertRow(deleted: 1): softDelete/updateRow
		// cannot run against overlay_index (no modified_at column).
		insertRow(
			db,
			"overlay_index",
			row({ id: "dead", path: "/mnt/repo/gone.ts", content_hash: "tomb", deleted: 1 }),
			SITE,
		);

		const result = findOverlayContentHashByPathActive(db, "/mnt/repo/gone.ts");

		expect(result).toBeNull();
	});

	it("returns the live sibling when a tombstone exists alongside it", () => {
		// Same path, one tombstoned and one live — the active finder picks the live one.
		insertRow(
			db,
			"overlay_index",
			row({ id: "dead", path: "/mnt/repo/x.ts", content_hash: "old", deleted: 1 }),
			SITE,
		);
		insertRow(
			db,
			"overlay_index",
			row({ id: "live", path: "/mnt/repo/x.ts", content_hash: "new", deleted: 0 }),
			SITE,
		);

		const result = findOverlayContentHashByPathActive(db, "/mnt/repo/x.ts");

		expect(result).toEqual({ content_hash: "new" });
	});
});

describe("findOverlayContentHashByIdActive", () => {
	it("returns the content_hash for a live row matching the id", () => {
		insertRow(db, "overlay_index", row({ id: "o1", content_hash: "byid" }), SITE);

		const result = findOverlayContentHashByIdActive(db, "o1");

		expect(result).toEqual({ content_hash: "byid" });
	});

	it("returns null for an absent id", () => {
		insertRow(db, "overlay_index", row({ id: "o1" }), SITE);

		const result = findOverlayContentHashByIdActive(db, "missing-id");

		expect(result).toBeNull();
	});

	it("omits a soft-deleted row by id (deleted = 0 filter)", () => {
		insertRow(db, "overlay_index", row({ id: "dead", content_hash: "tomb", deleted: 1 }), SITE);

		const result = findOverlayContentHashByIdActive(db, "dead");

		expect(result).toBeNull();
	});
});

describe("listOverlayIdPathBySiteActive", () => {
	it("returns id+path for every live row of the site, excluding tombstones and other sites", () => {
		// site-A: two live, one tombstoned. site-B: one live (must be excluded).
		insertRow(db, "overlay_index", row({ id: "a1", path: "/mnt/repo/a1.ts", deleted: 0 }), SITE);
		insertRow(db, "overlay_index", row({ id: "a2", path: "/mnt/repo/a2.ts", deleted: 0 }), SITE);
		insertRow(db, "overlay_index", row({ id: "a3", path: "/mnt/repo/a3.ts", deleted: 1 }), SITE);
		insertRow(
			db,
			"overlay_index",
			row({ id: "b1", site_id: OTHER_SITE, path: "/mnt/repo/b1.ts", deleted: 0 }),
			OTHER_SITE,
		);

		const result = listOverlayIdPathBySiteActive(db, SITE);

		// Hand-written oracle: only the two live site-A rows, id+path only.
		expect(result).toEqual([
			{ id: "a1", path: "/mnt/repo/a1.ts" },
			{ id: "a2", path: "/mnt/repo/a2.ts" },
		]);
	});

	it("returns an empty array for a site with no live rows", () => {
		insertRow(db, "overlay_index", row({ id: "a1", deleted: 1 }), SITE);

		const result = listOverlayIdPathBySiteActive(db, SITE);

		expect(result).toEqual([]);
	});

	it("returns an empty array for a site with no rows at all", () => {
		const result = listOverlayIdPathBySiteActive(db, "ghost-site");

		expect(result).toEqual([]);
	});
});
