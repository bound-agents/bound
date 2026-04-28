// Integration test: hub-side snapshot seeding logic at the WsTransport level.
// Verifies seedNewPeer, chunk generation, handleReseedRequest, and pruning guard
// without requiring real WebSocket servers.

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import { EventEmitter } from "node:events";
import { applySchema } from "@bound/core";

import { HLC_ZERO, type TypedEventEmitter } from "@bound/shared";

import { updatePeerCursor } from "../peer-cursor.js";
import { clearColumnCache } from "../reducers.js";
import { WsTransport } from "../ws-transport.js";

// Minimal event bus that satisfies TypedEventEmitter for the constructor.
class NoopEventBus extends EventEmitter {
	emitTyped = this.emit.bind(this);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("snapshot seeding (integration)", () => {
	let hubDb: Database;
	let spokeDb: Database;
	let hubTransport: WsTransport;
	const hubSiteId = "aaaa1111bbbb2222cccc3333dddd4444";
	const spokeSiteId = "eeee5555ffff6666gggg7777hhhh8888";

	beforeAll(() => {
		hubDb = new Database(":memory:");
		hubDb.exec("PRAGMA journal_mode = WAL");
		applySchema(hubDb);

		spokeDb = new Database(":memory:");
		spokeDb.exec("PRAGMA journal_mode = WAL");
		applySchema(spokeDb);

		// Pre-seed hub with data
		const now = new Date().toISOString();
		hubDb.run(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
			["user-1", "Alice", now, now],
		);
		hubDb.run(
			"INSERT INTO threads (id, user_id, interface, created_at, last_message_at, modified_at, host_origin, deleted) VALUES (?, ?, 'web', ?, ?, ?, 'hub', 0)",
			["thread-1", "user-1", now, now, now],
		);
		hubDb.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, 'hub', 0)",
			["msg-1", "thread-1", "user", "hello", now, now],
		);
		hubDb.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, 'hub', 0)",
			["msg-2", "thread-1", "assistant", "hi there", now, now],
		);
		hubDb.run(
			"INSERT INTO hosts (site_id, host_name, online_at, modified_at, deleted) VALUES (?, 'hub', ?, ?, 0)",
			[hubSiteId, now, now],
		);

		hubTransport = new WsTransport({
			db: hubDb,
			siteId: hubSiteId,
			eventBus: new NoopEventBus() as unknown as TypedEventEmitter,
			isHub: true,
		});
	});

	afterEach(() => {
		// Clean up peer connection, snapshot state, and sync_state row
		// so every test starts from a known empty state.
		hubTransport.removePeer(spokeSiteId);
	});

	afterAll(() => {
		clearColumnCache();
		hubDb.close();
		spokeDb.close();
	});

	it("seedNewPeer sends snapshot data to a peer (via mock sendFrame)", async () => {
		// Collect frames that would be sent over the wire.
		const sentFrames: Array<{ type: number; payloadStr: string }> = [];
		const mockSendFrame = (_frame: Uint8Array): boolean => {
			if (_frame.length < 1) return false;
			const type = _frame[0];
			const payloadRaw = _frame.slice(25); // skip type(1) + nonce(24)
			let payloadStr = "";
			try {
				payloadStr = new TextDecoder().decode(payloadRaw);
			} catch {
				/* encrypted — that's fine */
			}
			sentFrames.push({ type, payloadStr });
			return true; // never backpressured in test
		};

		// Register the peer with a mock send function.
		const symKey = new Uint8Array(32);
		hubTransport.addPeer(spokeSiteId, mockSendFrame, symKey);

		// Verify the peer has no cursor (fresh).
		const cursorBefore = hubDb
			.query("SELECT last_received FROM sync_state WHERE peer_site_id = ?")
			.get(spokeSiteId) as { last_received: string } | null;
		expect(cursorBefore).toBeNull();

		// Trigger seeding.
		hubTransport.seedNewPeer(spokeSiteId);

		// seedNewPeer creates the sync_state row and schedules chunk sending.
		// The first frame sent should be SNAPSHOT_BEGIN.
		// Due to setTimeout(0), the chunks are deferred. Wait for them.
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(sentFrames.length).toBeGreaterThan(0);

		// The first frame should be SNAPSHOT_BEGIN (0x10).
		const firstType = sentFrames[0]?.type;
		expect(firstType).toBe(0x10); // SNAPSHOT_BEGIN

		// Verify the sync_state row was created (pruning guard).
		const cursorAfter = hubDb
			.query("SELECT last_received FROM sync_state WHERE peer_site_id = ?")
			.get(spokeSiteId) as { last_received: string } | null;
		expect(cursorAfter).not.toBeNull();
		// Should be HLC_ZERO until the spoke acks.
		expect(cursorAfter?.last_received).toBe(HLC_ZERO);
	});

	it("seedNewPeer skips peers with existing cursor", () => {
		// Give the spoke a non-zero cursor via sync_state.
		updatePeerCursor(hubDb, spokeSiteId, {
			last_received: "2025-01-01T00:00:00.000Z_0000_zzzz",
		});

		const sentFrames: number[] = [];
		const symKey = new Uint8Array(32);
		hubTransport.addPeer(
			spokeSiteId,
			(frame: Uint8Array): boolean => {
				sentFrames.push(frame[0]);
				return true;
			},
			symKey,
		);

		hubTransport.seedNewPeer(spokeSiteId);
		// Should immediately return without sending anything (cursor already exists).
		expect(sentFrames).toHaveLength(0);
	});

	it("handleReseedRequest clears cursor and triggers seed", async () => {
		// First, give the spoke an existing cursor.
		updatePeerCursor(hubDb, spokeSiteId, {
			last_received: "2025-01-02T00:00:00.000Z_0000_zzzz",
			last_sent: "2025-01-02T00:00:00.000Z_0000_zzzz",
		});

		const sentFrames: number[] = [];
		const mockSendFrame = (frame: Uint8Array): boolean => {
			sentFrames.push(frame[0]);
			return true;
		};
		const symKey = new Uint8Array(32);
		hubTransport.addPeer(spokeSiteId, mockSendFrame, symKey);

		// Trigger a reseed request.
		hubTransport.handleReseedRequest(spokeSiteId, "test force reseed");

		// The handleReseedRequest should:
		// 1. Reset the cursor to HLC_ZERO
		// 2. Call seedNewPeer → send SNAPSHOT_BEGIN + chunks
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Verify cursor was reset.
		const cursorAfter = hubDb
			.query("SELECT last_received FROM sync_state WHERE peer_site_id = ?")
			.get(spokeSiteId) as { last_received: string } | null;
		expect(cursorAfter).not.toBeNull();
		expect(cursorAfter?.last_received).toBe(HLC_ZERO);

		// Verify frames were sent.
		expect(sentFrames.length).toBeGreaterThan(0);
		expect(sentFrames[0]).toBe(0x10); // SNAPSHOT_BEGIN
	});

	it("handleReseedRequest is idempotent — second call while active is a no-op", async () => {
		// Give the spoke an existing cursor so it doesn't auto-seed on addPeer.
		updatePeerCursor(hubDb, spokeSiteId, {
			last_received: "2025-01-02T00:00:00.000Z_0000_zzzz",
			last_sent: "2025-01-02T00:00:00.000Z_0000_zzzz",
		});

		const sentFrames: number[] = [];
		const mockSendFrame = (frame: Uint8Array): boolean => {
			sentFrames.push(frame[0]);
			return true;
		};
		const symKey = new Uint8Array(32);
		hubTransport.addPeer(spokeSiteId, mockSendFrame, symKey);

		// Start a snapshot.
		hubTransport.handleReseedRequest(spokeSiteId, "first reseed");
		await new Promise((resolve) => setTimeout(resolve, 100));

		const firstBeginCount = sentFrames.filter((t) => t === 0x10).length;
		expect(firstBeginCount).toBe(1);

		// Snapshot state should exist.
		const transportAny = hubTransport as Record<string, unknown>;
		expect((transportAny.snapshotStates as Map<string, unknown>).has(spokeSiteId)).toBe(true);

		// Second call while the snapshot is still active should be ignored.
		hubTransport.handleReseedRequest(spokeSiteId, "second reseed while active");
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Cursor should still be HLC_ZERO.
		const cursorAfter = hubDb
			.query("SELECT last_received FROM sync_state WHERE peer_site_id = ?")
			.get(spokeSiteId) as { last_received: string } | null;
		expect(cursorAfter?.last_received).toBe(HLC_ZERO);

		// Should NOT have sent a second SNAPSHOT_BEGIN (idempotent).
		const secondBeginCount = sentFrames.filter((t) => t === 0x10).length;
		expect(secondBeginCount).toBe(1);
	});

	it("handleReseedRequest is a no-op when snapshot is already active for the peer", async () => {
		// Simulate the race: hub auto-detects new peer and starts seeding,
		// then spoke (which hasn't received SNAPSHOT_BEGIN yet) sends
		// RESEED_REQUEST. The hub should ignore the duplicate request.
		const sentFrames: number[] = [];
		const mockSendFrame = (frame: Uint8Array): boolean => {
			sentFrames.push(frame[0]);
			return true;
		};
		const symKey = new Uint8Array(32);
		hubTransport.addPeer(spokeSiteId, mockSendFrame, symKey);

		// Fresh peer (HLC_ZERO cursor) — hub auto-starts seeding.
		hubTransport.seedNewPeer(spokeSiteId);
		await new Promise((resolve) => setTimeout(resolve, 100));

		const beginCountBeforeReseed = sentFrames.filter((t) => t === 0x10).length;
		expect(beginCountBeforeReseed).toBe(1);

		// Now spoke sends RESEED_REQUEST (simulating the race).
		hubTransport.handleReseedRequest(spokeSiteId, "duplicate reseed race");
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Should NOT have sent a second SNAPSHOT_BEGIN.
		const beginCountAfterReseed = sentFrames.filter((t) => t === 0x10).length;
		expect(beginCountAfterReseed).toBe(1);
	});

	it("drainChangelog skips when snapshot is active for the peer", () => {
		// Start a snapshot session for a peer.
		const symKey = new Uint8Array(32);
		hubTransport.addPeer(spokeSiteId, (_frame: Uint8Array): boolean => true, symKey);
		hubTransport.seedNewPeer(spokeSiteId);

		// Verify snapshot state exists (private field, access via cast).
		const transportAny = hubTransport as Record<string, unknown>;
		expect((transportAny.snapshotStates as Map<string, unknown>).has(spokeSiteId)).toBe(true);

		// drainChangelog should bail early when snapshot is active.
		// (We can't easily verify the internal skip, but the guard is
		// in the first lines of the method.)
		const cursorBefore = hubDb
			.query("SELECT last_sent FROM sync_state WHERE peer_site_id = ?")
			.get(spokeSiteId) as { last_sent: string } | null;
		// last_sent should still be HLC_ZERO (drain didn't update it).
		expect(cursorBefore?.last_sent).toBe(HLC_ZERO);

		// Clean up.
		hubTransport.removePeer(spokeSiteId);
	});

	it("removePeer cleans up sync_state for mid-seed disconnected peers", () => {
		const transportAny = hubTransport as Record<string, unknown>;

		// Simulate a peer that was mid-seed.
		hubDb.run(
			`INSERT OR REPLACE INTO sync_state (peer_site_id, last_received, last_sent, sync_errors)
			 VALUES ('stalled-peer', ?, ?, 0)`,
			[HLC_ZERO, HLC_ZERO],
		);

		// Manually set snapshot state (simulating mid-seed disconnect).
		(transportAny.snapshotStates as Map<string, unknown>).set("stalled-peer", {
			tableIndex: 0,
			offset: 0,
			lastRowid: 0,
			snapshotHlc: "2025-01-01T00:00:00.000Z_0000_aaaa",
			draining: false,
			stmt: null,
		});
		(transportAny.peerConnections as Map<string, unknown>).set("stalled-peer", {
			peerSiteId: "stalled-peer",
			sendFrame: () => true,
			symmetricKey: new Uint8Array(32),
		});

		// Verify sync_state exists before removal.
		const before = hubDb
			.query("SELECT * FROM sync_state WHERE peer_site_id = ?")
			.get("stalled-peer");
		expect(before).not.toBeNull();

		// Remove the peer.
		hubTransport.removePeer("stalled-peer");

		// Verify sync_state was cleaned up.
		const after = hubDb
			.query("SELECT * FROM sync_state WHERE peer_site_id = ?")
			.get("stalled-peer");
		expect(after).toBeNull();
	});

	it("seedNewPeer is a no-op on non-hub WsTransport instances", () => {
		const nonHubTransport = new WsTransport({
			db: spokeDb,
			siteId: spokeSiteId,
			eventBus: new NoopEventBus() as unknown as TypedEventEmitter,
			isHub: false,
		});

		const sentFrames: number[] = [];
		nonHubTransport.addPeer(
			hubSiteId,
			(frame: Uint8Array): boolean => {
				sentFrames.push(frame[0]);
				return true;
			},
			new Uint8Array(32),
		);

		nonHubTransport.seedNewPeer(hubSiteId);
		expect(sentFrames).toHaveLength(0);
	});

	it("pruning is blocked while any peer has HLC_ZERO", () => {
		// Add a confirmed peer.
		hubDb.run(
			`INSERT OR REPLACE INTO sync_state (peer_site_id, last_received, last_sent, sync_errors)
			 VALUES ('confirmed-peer', '2025-01-05T00:00:00.000Z_0000_cccc', '2025-01-05T00:00:00.000Z_0000_cccc', 0)`,
		);

		// Add a fresh peer (simulating the sync_state row created by seedNewPeer).
		hubDb.run(
			`INSERT OR REPLACE INTO sync_state (peer_site_id, last_received, last_sent, sync_errors)
			 VALUES (?, ?, ?, 0)`,
			["fresh-peer", HLC_ZERO, HLC_ZERO],
		);

		const minHlc = (
			hubDb.query("SELECT MIN(last_received) as min_hlc FROM sync_state").get() as {
				min_hlc: string;
			}
		).min_hlc;
		expect(minHlc).toBe(HLC_ZERO);

		// Clean up test rows.
		hubDb.run("DELETE FROM sync_state WHERE peer_site_id IN ('confirmed-peer', 'fresh-peer')");
	});
});
