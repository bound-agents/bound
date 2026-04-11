import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HLC_ZERO } from "@bound/shared";
import {
	getMinConfirmedHlc,
	getPeerCursor,
	incrementSyncErrors,
	resetSyncErrors,
	updatePeerCursor,
} from "../peer-cursor.js";

describe("peer-cursor", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");

		db.run(`
			CREATE TABLE sync_state (
				peer_site_id TEXT PRIMARY KEY,
				last_received TEXT NOT NULL DEFAULT '${HLC_ZERO}',
				last_sent TEXT NOT NULL DEFAULT '${HLC_ZERO}',
				last_sync_at TEXT,
				sync_errors INTEGER NOT NULL DEFAULT 0
			)
		`);
	});

	afterEach(() => {
		db.close();
	});

	describe("getPeerCursor", () => {
		it("returns null when peer not found", () => {
			const cursor = getPeerCursor(db, "unknown-peer");
			expect(cursor).toBeNull();
		});

		it("returns cursor data when peer exists", () => {
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_received, last_sent, sync_errors)
				VALUES (?, ?, ?, ?)`,
				["peer-a", "2026-04-10T10:00:00.000Z_0000_0000", "2026-04-10T09:00:00.000Z_0000_0000", 0],
			);

			const cursor = getPeerCursor(db, "peer-a");

			expect(cursor).not.toBeNull();
			if (cursor) {
				expect(cursor.last_received).toBe("2026-04-10T10:00:00.000Z_0000_0000");
				expect(cursor.last_sent).toBe("2026-04-10T09:00:00.000Z_0000_0000");
				expect(cursor.sync_errors).toBe(0);
			}
		});
	});

	describe("updatePeerCursor", () => {
		it("creates new entry if peer not exists", () => {
			updatePeerCursor(db, "new-peer", {
				last_received: "2026-04-10T10:00:00.000Z_0000_0005",
				last_sent: "2026-04-10T10:00:00.000Z_0000_0003",
			});

			const cursor = getPeerCursor(db, "new-peer");

			expect(cursor).not.toBeNull();
			if (cursor) {
				expect(cursor.last_received).toBe("2026-04-10T10:00:00.000Z_0000_0005");
				expect(cursor.last_sent).toBe("2026-04-10T10:00:00.000Z_0000_0003");
				expect(cursor.last_sync_at).not.toBeNull();
			}
		});

		it("updates existing entry", () => {
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_received, last_sent)
				VALUES (?, ?, ?)`,
				["peer-b", "2026-04-10T09:00:00.000Z_0000_0005", "2026-04-10T09:00:00.000Z_0000_0003"],
			);

			updatePeerCursor(db, "peer-b", {
				last_received: "2026-04-10T10:00:00.000Z_0000_0010",
				last_sent: "2026-04-10T10:00:00.000Z_0000_0008",
			});

			const cursor = getPeerCursor(db, "peer-b");

			expect(cursor).not.toBeNull();
			if (cursor) {
				expect(cursor.last_received).toBe("2026-04-10T10:00:00.000Z_0000_0010");
				expect(cursor.last_sent).toBe("2026-04-10T10:00:00.000Z_0000_0008");
			}
		});

		it("sets last_sync_at to current timestamp", () => {
			const before = new Date().toISOString();
			updatePeerCursor(db, "peer-c", { last_received: "2026-04-10T10:00:00.000Z_0000_0001" });
			const after = new Date().toISOString();

			const cursor = getPeerCursor(db, "peer-c");

			expect(cursor).not.toBeNull();
			if (cursor?.last_sync_at) {
				const syncTime = new Date(cursor.last_sync_at).getTime();
				expect(syncTime).toBeGreaterThanOrEqual(new Date(before).getTime());
				expect(syncTime).toBeLessThanOrEqual(new Date(after).getTime());
			}
		});
	});

	describe("resetSyncErrors", () => {
		it("resets sync_errors to 0 for existing peer", () => {
			db.run(
				`INSERT INTO sync_state (peer_site_id, sync_errors)
				VALUES (?, ?)`,
				["peer-d", 3],
			);

			resetSyncErrors(db, "peer-d");

			const cursor = getPeerCursor(db, "peer-d");
			expect(cursor?.sync_errors).toBe(0);
		});
	});

	describe("incrementSyncErrors", () => {
		it("increments sync_errors for existing peer", () => {
			db.run(
				`INSERT INTO sync_state (peer_site_id, sync_errors)
				VALUES (?, ?)`,
				["peer-e", 2],
			);

			incrementSyncErrors(db, "peer-e");

			const cursor = getPeerCursor(db, "peer-e");
			expect(cursor?.sync_errors).toBe(3);
		});

		it("creates peer with sync_errors=1 if not exists", () => {
			incrementSyncErrors(db, "new-peer-errors");

			const cursor = getPeerCursor(db, "new-peer-errors");
			expect(cursor?.sync_errors).toBe(1);
		});
	});

	describe("getMinConfirmedHlc", () => {
		it("returns HLC_ZERO when no peers", () => {
			const minHlc = getMinConfirmedHlc(db);
			expect(minHlc).toBe(HLC_ZERO);
		});

		it("returns minimum last_received across all peers", () => {
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_received)
				VALUES (?, ?)`,
				["peer-1", "2026-04-10T10:00:00.000Z_0000_0010"],
			);
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_received)
				VALUES (?, ?)`,
				["peer-2", "2026-04-10T09:00:00.000Z_0000_0005"],
			);
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_received)
				VALUES (?, ?)`,
				["peer-3", "2026-04-10T11:00:00.000Z_0000_0015"],
			);

			const minHlc = getMinConfirmedHlc(db);
			expect(minHlc).toBe("2026-04-10T09:00:00.000Z_0000_0005");
		});

		it("returns minimum even with HLC_ZERO values", () => {
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_received)
				VALUES (?, ?)`,
				["peer-4", HLC_ZERO],
			);
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_received)
				VALUES (?, ?)`,
				["peer-5", "2026-04-10T10:00:00.000Z_0000_0010"],
			);

			const minHlc = getMinConfirmedHlc(db);
			expect(minHlc).toBe(HLC_ZERO);
		});
	});
});
