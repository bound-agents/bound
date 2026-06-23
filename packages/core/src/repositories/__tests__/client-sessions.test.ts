import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ClientSession } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../index";
import {
	findClientSessionIdById,
	findLiveClientSessionIdById,
	hasLiveClientSessionForThreadOnSite,
	listClientSessionIdsByConnectionId,
	listClientSessionIdsBySiteId,
	listClientSessionSiteIdsByThreadId,
} from "../client-sessions";

const SITE_A = "site-aaaaaaaa";
const SITE_B = "site-bbbbbbbb";
const TS = "2026-01-01T00:00:00.000Z";

let db: Database;

function seedSession(overrides: Partial<ClientSession> & { id: string }): ClientSession {
	const row: ClientSession = {
		id: overrides.id,
		connection_id: overrides.connection_id ?? "conn-default",
		thread_id: overrides.thread_id ?? "thread-default",
		site_id: overrides.site_id ?? SITE_A,
		created_at: overrides.created_at ?? TS,
		deleted: overrides.deleted ?? 0,
		modified_at: overrides.modified_at ?? TS,
	};
	insertRow(db, "client_sessions", row, row.site_id);
	return row;
}

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
});

afterEach(() => {
	db.close();
});

describe("listClientSessionIdsBySiteId", () => {
	it("returns only live ids for the given site", () => {
		seedSession({ id: "conn1::t1", site_id: SITE_A });
		seedSession({ id: "conn2::t2", site_id: SITE_A });
		seedSession({ id: "conn3::t3", site_id: SITE_B });

		const rows = listClientSessionIdsBySiteId(db, SITE_A);
		const ids = rows.map((r) => r.id).sort();
		expect(ids).toEqual(["conn1::t1", "conn2::t2"]);
	});

	it("omits soft-deleted rows (deleted = 0 filter)", () => {
		seedSession({ id: "live::t1", site_id: SITE_A });
		seedSession({ id: "dead::t2", site_id: SITE_A });
		softDelete(db, "client_sessions", "dead::t2", SITE_A);

		const ids = listClientSessionIdsBySiteId(db, SITE_A).map((r) => r.id);
		expect(ids).toEqual(["live::t1"]);
	});

	it("returns [] for a site with no sessions", () => {
		seedSession({ id: "conn1::t1", site_id: SITE_A });
		expect(listClientSessionIdsBySiteId(db, "site-unknown")).toEqual([]);
	});
});

describe("listClientSessionSiteIdsByThreadId", () => {
	it("returns the site_ids of every live session on a thread", () => {
		seedSession({ id: "connA::shared", thread_id: "shared", site_id: SITE_A });
		seedSession({ id: "connB::shared", thread_id: "shared", site_id: SITE_B });
		seedSession({ id: "connA::other", thread_id: "other", site_id: SITE_A });

		const siteIds = listClientSessionSiteIdsByThreadId(db, "shared")
			.map((r) => r.site_id)
			.sort();
		expect(siteIds).toEqual([SITE_A, SITE_B]);
	});

	it("omits soft-deleted rows (deleted = 0 filter)", () => {
		seedSession({ id: "connA::t", thread_id: "t", site_id: SITE_A });
		seedSession({ id: "connB::t", thread_id: "t", site_id: SITE_B });
		softDelete(db, "client_sessions", "connB::t", SITE_B);

		const siteIds = listClientSessionSiteIdsByThreadId(db, "t").map((r) => r.site_id);
		expect(siteIds).toEqual([SITE_A]);
	});

	it("returns [] for a thread with no sessions", () => {
		expect(listClientSessionSiteIdsByThreadId(db, "nope")).toEqual([]);
	});
});

describe("hasLiveClientSessionForThreadOnSite", () => {
	it("returns true when a live session matches thread + site", () => {
		seedSession({ id: "conn::t1", thread_id: "t1", site_id: SITE_A });
		expect(hasLiveClientSessionForThreadOnSite(db, "t1", SITE_A)).toBe(true);
	});

	it("returns false when no row matches", () => {
		seedSession({ id: "conn::t1", thread_id: "t1", site_id: SITE_A });
		// right thread, wrong site
		expect(hasLiveClientSessionForThreadOnSite(db, "t1", SITE_B)).toBe(false);
		// wrong thread, right site
		expect(hasLiveClientSessionForThreadOnSite(db, "t2", SITE_A)).toBe(false);
	});

	it("returns false once the matching row is soft-deleted (deleted = 0 filter)", () => {
		seedSession({ id: "conn::t1", thread_id: "t1", site_id: SITE_A });
		expect(hasLiveClientSessionForThreadOnSite(db, "t1", SITE_A)).toBe(true);
		softDelete(db, "client_sessions", "conn::t1", SITE_A);
		expect(hasLiveClientSessionForThreadOnSite(db, "t1", SITE_A)).toBe(false);
	});
});

describe("findClientSessionIdById (no deleted filter) vs findLiveClientSessionIdById", () => {
	it("happy path: both find a live row by id", () => {
		seedSession({ id: "conn::t1" });
		expect(findClientSessionIdById(db, "conn::t1")).toEqual({ id: "conn::t1" });
		expect(findLiveClientSessionIdById(db, "conn::t1")).toEqual({ id: "conn::t1" });
	});

	it("miss path: both return null for an absent id", () => {
		expect(findClientSessionIdById(db, "absent")).toBeNull();
		expect(findLiveClientSessionIdById(db, "absent")).toBeNull();
	});

	it("deleted-omission: the no-filter finder returns the tombstone, the live finder does not", () => {
		seedSession({ id: "dead::t1" });
		softDelete(db, "client_sessions", "dead::t1", SITE_A);

		// findClientSessionIdById omits the deleted=0 filter — sees the tombstone.
		expect(findClientSessionIdById(db, "dead::t1")).toEqual({ id: "dead::t1" });
		// findLiveClientSessionIdById has the deleted=0 filter — does not.
		expect(findLiveClientSessionIdById(db, "dead::t1")).toBeNull();
	});
});

describe("listClientSessionIdsByConnectionId", () => {
	it("returns only live ids for the given connection", () => {
		seedSession({ id: "connX::t1", connection_id: "connX" });
		seedSession({ id: "connX::t2", connection_id: "connX" });
		seedSession({ id: "connY::t3", connection_id: "connY" });

		const ids = listClientSessionIdsByConnectionId(db, "connX")
			.map((r) => r.id)
			.sort();
		expect(ids).toEqual(["connX::t1", "connX::t2"]);
	});

	it("omits soft-deleted rows (deleted = 0 filter)", () => {
		seedSession({ id: "connX::t1", connection_id: "connX" });
		seedSession({ id: "connX::t2", connection_id: "connX" });
		softDelete(db, "client_sessions", "connX::t2", SITE_A);

		const ids = listClientSessionIdsByConnectionId(db, "connX").map((r) => r.id);
		expect(ids).toEqual(["connX::t1"]);
	});

	it("returns [] for a connection with no sessions", () => {
		expect(listClientSessionIdsByConnectionId(db, "unknown")).toEqual([]);
	});
});
