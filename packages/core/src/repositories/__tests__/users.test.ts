import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { User } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete, updateRow } from "../../index";
import { findUserById, findUserDisplayNameById, findUserIdById, listUsers } from "../users";

const SITE_ID = "site-test";

function makeUser(overrides: Partial<User> & Pick<User, "id" | "display_name">): User {
	return {
		platform_ids: null,
		first_seen_at: "2026-01-01T00:00:00.000Z",
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		...overrides,
	};
}

describe("users repository finders", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("findUserById", () => {
		it("returns the full row for an existing id (happy path)", () => {
			insertRow(
				db,
				"users",
				makeUser({
					id: "u1",
					display_name: "Alice",
					platform_ids: '{"discord":"123"}',
					first_seen_at: "2026-01-01T00:00:00.000Z",
				}),
				SITE_ID,
			);

			const row = findUserById(db, "u1");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("u1");
			expect(row?.display_name).toBe("Alice");
			expect(row?.platform_ids).toBe('{"discord":"123"}');
			expect(row?.first_seen_at).toBe("2026-01-01T00:00:00.000Z");
			expect(row?.deleted).toBe(0);
		});

		it("returns null for an absent id (miss path)", () => {
			expect(findUserById(db, "does-not-exist")).toBeNull();
		});

		it("still returns a soft-deleted row (no deleted filter)", () => {
			insertRow(db, "users", makeUser({ id: "u-dead", display_name: "Ghost" }), SITE_ID);
			softDelete(db, "users", "u-dead", SITE_ID);

			const row = findUserById(db, "u-dead");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("u-dead");
			expect(row?.deleted).toBe(1);
		});
	});

	describe("listUsers", () => {
		it("returns only live rows ordered by display_name ASC", () => {
			// Insert in non-alphabetical order to prove the ORDER BY.
			insertRow(db, "users", makeUser({ id: "u-c", display_name: "Charlie" }), SITE_ID);
			insertRow(db, "users", makeUser({ id: "u-a", display_name: "Alice" }), SITE_ID);
			insertRow(db, "users", makeUser({ id: "u-b", display_name: "Bob" }), SITE_ID);
			// A soft-deleted user that must be omitted.
			insertRow(db, "users", makeUser({ id: "u-x", display_name: "AAA-Deleted" }), SITE_ID);
			softDelete(db, "users", "u-x", SITE_ID);

			const rows = listUsers(db);
			expect(rows.map((r) => r.id)).toEqual(["u-a", "u-b", "u-c"]);
			expect(rows.map((r) => r.display_name)).toEqual(["Alice", "Bob", "Charlie"]);
		});

		it("returns an empty array when there are no live users", () => {
			insertRow(db, "users", makeUser({ id: "u-only", display_name: "Solo" }), SITE_ID);
			softDelete(db, "users", "u-only", SITE_ID);

			expect(listUsers(db)).toEqual([]);
		});

		it("returns an empty array on an empty table", () => {
			expect(listUsers(db)).toEqual([]);
		});
	});

	describe("findUserIdById (deleted-filter OMISSION variant)", () => {
		it("returns the id projection for a live row", () => {
			insertRow(db, "users", makeUser({ id: "u-live", display_name: "Live" }), SITE_ID);
			expect(findUserIdById(db, "u-live")).toEqual({ id: "u-live" });
		});

		it("returns null for an absent id", () => {
			expect(findUserIdById(db, "nope")).toBeNull();
		});

		it("RETURNS a soft-deleted row, unlike its deleted=0 sibling", () => {
			// Seed one live and one tombstoned row.
			insertRow(db, "users", makeUser({ id: "u-live", display_name: "Live" }), SITE_ID);
			insertRow(db, "users", makeUser({ id: "u-tomb", display_name: "Tomb" }), SITE_ID);
			softDelete(db, "users", "u-tomb", SITE_ID);

			// The omission finder sees the tombstone...
			expect(findUserIdById(db, "u-tomb")).toEqual({ id: "u-tomb" });
			// ...but the deleted=0 sibling does NOT.
			expect(findUserDisplayNameById(db, "u-tomb")).toBeNull();

			// And both agree on the live row.
			expect(findUserIdById(db, "u-live")).toEqual({ id: "u-live" });
			expect(findUserDisplayNameById(db, "u-live")).toEqual({ display_name: "Live" });
		});
	});

	describe("findUserDisplayNameById (deleted=0 filter)", () => {
		it("returns the display_name projection for a live row", () => {
			insertRow(db, "users", makeUser({ id: "u1", display_name: "Alice" }), SITE_ID);
			expect(findUserDisplayNameById(db, "u1")).toEqual({ display_name: "Alice" });
		});

		it("reflects an updated display_name", () => {
			insertRow(db, "users", makeUser({ id: "u1", display_name: "Alice" }), SITE_ID);
			updateRow(db, "users", "u1", { display_name: "Alice Renamed" }, SITE_ID);
			expect(findUserDisplayNameById(db, "u1")).toEqual({ display_name: "Alice Renamed" });
		});

		it("returns null for an absent id", () => {
			expect(findUserDisplayNameById(db, "nope")).toBeNull();
		});

		it("returns null for a soft-deleted row (deleted=0 filter active)", () => {
			insertRow(db, "users", makeUser({ id: "u-dead", display_name: "Ghost" }), SITE_ID);
			softDelete(db, "users", "u-dead", SITE_ID);
			expect(findUserDisplayNameById(db, "u-dead")).toBeNull();
		});
	});
});
