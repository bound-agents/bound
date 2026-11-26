import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HLC_ZERO } from "@bound/shared";
import { createCoreTestDb } from "../../__tests__/test-database";
import {
	countSyncStatePeers,
	getMinSyncReceivedHlc,
	getPeerSiteId,
	listSyncState,
} from "../sync-state";

/** sync_state is a local, unsynced table — seed it with raw INSERTs. */
function seedPeer(
	db: Database,
	row: {
		peer_site_id: string;
		last_received?: string;
		last_sent?: string;
		last_confirmed?: string;
		last_sync_at?: string | null;
		sync_errors?: number;
	},
): void {
	db.run(
		`INSERT INTO sync_state (peer_site_id, last_received, last_sent, last_confirmed, last_sync_at, sync_errors)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			row.peer_site_id,
			row.last_received ?? HLC_ZERO,
			row.last_sent ?? HLC_ZERO,
			row.last_confirmed ?? HLC_ZERO,
			row.last_sync_at ?? null,
			row.sync_errors ?? 0,
		],
	);
}

describe("sync-state repository", () => {
	let db: Database;

	beforeEach(() => {
		db = createCoreTestDb();
	});

	afterEach(() => {
		db.close();
	});

	describe("getPeerSiteId", () => {
		it("returns undefined when there are no peers", () => {
			expect(getPeerSiteId(db)).toBeUndefined();
		});

		it("returns the first peer's site id", () => {
			seedPeer(db, { peer_site_id: "peer-first" });
			expect(getPeerSiteId(db)).toBe("peer-first");
		});

		it("returns undefined (not throw) when the table does not exist", () => {
			const empty = new (db.constructor as typeof Database)(":memory:");
			// No schema applied — the query should fail and be swallowed.
			expect(getPeerSiteId(empty)).toBeUndefined();
			empty.close();
		});
	});

	describe("listSyncState", () => {
		it("returns [] when empty", () => {
			expect(listSyncState(db)).toEqual([]);
		});

		it("returns every peer row", () => {
			seedPeer(db, { peer_site_id: "p1" });
			seedPeer(db, { peer_site_id: "p2" });
			const rows = listSyncState(db);
			expect(rows.map((r) => r.peer_site_id).sort()).toEqual(["p1", "p2"]);
		});
	});

	describe("countSyncStatePeers", () => {
		it("returns 0 when empty", () => {
			expect(countSyncStatePeers(db)).toBe(0);
		});

		it("counts live peer rows", () => {
			seedPeer(db, { peer_site_id: "p1" });
			seedPeer(db, { peer_site_id: "p2" });
			seedPeer(db, { peer_site_id: "p3" });
			expect(countSyncStatePeers(db)).toBe(3);
		});
	});

	describe("getMinSyncReceivedHlc", () => {
		it("returns HLC_ZERO when there are no peers (MIN over empty set is null)", () => {
			expect(getMinSyncReceivedHlc(db)).toBe(HLC_ZERO);
		});

		it("returns the lexicographically smallest last_received across peers", () => {
			seedPeer(db, { peer_site_id: "p1", last_received: "2026-03-03T00:00:00.000Z_0000_aaaa" });
			seedPeer(db, { peer_site_id: "p2", last_received: "2026-01-01T00:00:00.000Z_0000_aaaa" });
			seedPeer(db, { peer_site_id: "p3", last_received: "2026-02-02T00:00:00.000Z_0000_aaaa" });
			expect(getMinSyncReceivedHlc(db)).toBe("2026-01-01T00:00:00.000Z_0000_aaaa");
		});
	});
});
