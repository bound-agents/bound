import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { User } from "@bound/shared";
import { createCoreTestDb } from "../../__tests__/test-database";
import { insertRow, softDelete, updateRow } from "../../index";
import { findUserDisplayNameById, findUserIdById } from "../users";

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
		db = createCoreTestDb({ metrics: true });
	});

	afterEach(() => {
		db.close();
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
