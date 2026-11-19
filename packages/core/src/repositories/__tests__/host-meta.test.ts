import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createCoreTestDb } from "../../__tests__/test-database";
import { getHostMetaHostName, getHostMetaSiteId, getHostMetaValue } from "../host-meta";

/** host_meta is a local, unsynced key/value table. */
function setMeta(db: Database, key: string, value: string): void {
	db.run("INSERT OR REPLACE INTO host_meta (key, value) VALUES (?, ?)", [key, value]);
}

describe("host-meta repository", () => {
	let db: Database;

	beforeEach(() => {
		db = createCoreTestDb();
	});

	afterEach(() => {
		db.close();
	});

	describe("getHostMetaValue", () => {
		it("returns null for an absent key", () => {
			expect(getHostMetaValue(db, "missing")).toBeNull();
		});

		it("returns the stored value for a present key", () => {
			setMeta(db, "site_id", "site-abc");
			expect(getHostMetaValue(db, "site_id")).toBe("site-abc");
		});
	});

	describe("getHostMetaSiteId", () => {
		it("returns the stored site_id", () => {
			setMeta(db, "site_id", "site-xyz");
			expect(getHostMetaSiteId(db)).toBe("site-xyz");
		});

		it('falls back to "unknown" when site_id is unset', () => {
			expect(getHostMetaSiteId(db)).toBe("unknown");
		});
	});

	describe("getHostMetaHostName", () => {
		it("returns the stored host_name", () => {
			setMeta(db, "host_name", "laptop-1");
			expect(getHostMetaHostName(db)).toBe("laptop-1");
		});

		it("returns null (not a fallback string) when host_name is unset", () => {
			expect(getHostMetaHostName(db)).toBeNull();
		});
	});
});
