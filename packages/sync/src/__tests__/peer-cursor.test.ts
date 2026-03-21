import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getMinConfirmedSeq,
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
				last_received INTEGER NOT NULL DEFAULT 0,
				last_sent INTEGER NOT NULL DEFAULT 0,
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
				["peer-a", 10, 5, 0],
			);

			const cursor = getPeerCursor(db, "peer-a");

			expect(cursor).not.toBeNull();
			if (cursor) {
				expect(cursor.last_received).toBe(10);
				expect(cursor.last_sent).toBe(5);
				expect(cursor.sync_errors).toBe(0);
			}
		});
	});

	describe("updatePeerCursor", () => {
		it("creates new entry if peer not exists", () => {
			updatePeerCursor(db, "new-peer", { last_received: 5, last_sent: 3 });

			const cursor = getPeerCursor(db, "new-peer");

			expect(cursor).not.toBeNull();
			if (cursor) {
				expect(cursor.last_received).toBe(5);
				expect(cursor.last_sent).toBe(3);
				expect(cursor.last_sync_at).not.toBeNull();
			}
		});

		it("updates existing entry", () => {
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_received, last_sent)
				VALUES (?, ?, ?)`,
				["peer-b", 5, 3],
			);

			updatePeerCursor(db, "peer-b", { last_received: 10, last_sent: 8 });

			const cursor = getPeerCursor(db, "peer-b");

			expect(cursor).not.toBeNull();
			if (cursor) {
				expect(cursor.last_received).toBe(10);
				expect(cursor.last_sent).toBe(8);
			}
		});

		it("sets last_sync_at to current timestamp", () => {
			const before = new Date().toISOString();
			updatePeerCursor(db, "peer-c", { last_received: 1 });
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

	describe("getMinConfirmedSeq", () => {
		it("returns 0 when no peers", () => {
			const minSeq = getMinConfirmedSeq(db);
			expect(minSeq).toBe(0);
		});

		it("returns minimum last_received across all peers", () => {
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_received)
				VALUES (?, ?)`,
				["peer-1", 10],
			);
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_received)
				VALUES (?, ?)`,
				["peer-2", 5],
			);
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_received)
				VALUES (?, ?)`,
				["peer-3", 15],
			);

			const minSeq = getMinConfirmedSeq(db);
			expect(minSeq).toBe(5);
		});

		it("returns minimum even with default 0 values", () => {
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_received)
				VALUES (?, ?)`,
				["peer-4", 0],
			);
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_received)
				VALUES (?, ?)`,
				["peer-5", 10],
			);

			const minSeq = getMinConfirmedSeq(db);
			expect(minSeq).toBe(0);
		});
	});
});
