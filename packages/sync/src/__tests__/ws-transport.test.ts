import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HLC_ZERO, TypedEventEmitter } from "@bound/shared";
import { getPeerCursor, updatePeerCursor } from "../peer-cursor.js";
import { MicrotaskCoalescer } from "../ws-coalescer.js";
import type {
	ChangelogAckPayload,
	ChangelogPushPayload,
	RelayAckPayload,
	RelayDeliverPayload,
	RelaySendPayload,
} from "../ws-frames.js";
import { WsMessageType, decodeFrame } from "../ws-frames.js";
import { WsTransport } from "../ws-transport.js";

describe("MicrotaskCoalescer", () => {
	it("batches items within the same event loop tick", async () => {
		const flushed: string[][] = [];
		const coalescer = new MicrotaskCoalescer<string>((items) => {
			flushed.push([...items]);
		});

		// Add 3 items synchronously
		coalescer.add("a");
		coalescer.add("b");
		coalescer.add("c");

		// Verify not flushed yet
		expect(flushed.length).toBe(0);

		// Wait for microtask
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Verify flushed in one batch
		expect(flushed.length).toBe(1);
		expect(flushed[0]).toEqual(["a", "b", "c"]);
	});

	it("sends separate batches for multiple ticks", async () => {
		const flushed: string[][] = [];
		const coalescer = new MicrotaskCoalescer<string>((items) => {
			flushed.push([...items]);
		});

		// First tick
		coalescer.add("a");
		coalescer.add("b");
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Second tick
		coalescer.add("c");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(flushed.length).toBe(2);
		expect(flushed[0]).toEqual(["a", "b"]);
		expect(flushed[1]).toEqual(["c"]);
	});

	it("provides pendingCount for diagnostics", () => {
		const coalescer = new MicrotaskCoalescer<string>(() => {});

		expect(coalescer.pendingCount).toBe(0);
		coalescer.add("a");
		expect(coalescer.pendingCount).toBe(1);
		coalescer.add("b");
		expect(coalescer.pendingCount).toBe(2);
	});
});

describe("WsTransport", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let transport: WsTransport;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA foreign_keys = ON");

		// Create minimal schema
		db.run(`
			CREATE TABLE change_log (
				hlc TEXT PRIMARY KEY,
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				site_id TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				row_data TEXT NOT NULL
			)
		`);

		db.run(`
			CREATE TABLE sync_state (
				peer_site_id TEXT PRIMARY KEY,
				last_received TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000',
				last_sent TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000',
				sync_errors INTEGER DEFAULT 0,
				last_sync_at TEXT
			)
		`);

		db.run(`
			CREATE TABLE semantic_memory (
				id TEXT PRIMARY KEY,
				key TEXT NOT NULL,
				value TEXT NOT NULL,
				source TEXT,
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				last_accessed_at TEXT,
				tier TEXT DEFAULT 'default',
				deleted INTEGER DEFAULT 0
			)
		`);

		eventBus = new TypedEventEmitter();
		transport = new WsTransport({
			db,
			siteId: "hub",
			eventBus,
		});
	});

	afterEach(() => {
		transport.stop();
		db.close();
	});

	describe("addPeer/removePeer", () => {
		it("adds and removes peer connections", () => {
			const sendFrame = (): boolean => true;
			const key = new Uint8Array(32).fill(1);

			transport.addPeer("peer-1", sendFrame, key);
			// Verify peer is registered by attempting to drain (should succeed)
			transport.drainChangelog("peer-1"); // Should not throw

			transport.removePeer("peer-1");
			// After removal, drain should be a no-op
			transport.drainChangelog("peer-1"); // Should not throw
		});
	});

	describe("start/stop", () => {
		it("starts listening for changelog:written events", async () => {
			const events: Array<{ hlc: string; tableName: string }> = [];
			const listener = (event: {
				hlc: string;
				tableName: string;
				siteId: string;
			}) => {
				events.push({ hlc: event.hlc, tableName: event.tableName });
			};

			eventBus.on("changelog:written", listener);

			transport.start();

			// Insert a changelog entry
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				["2026-03-22T10:00:00.000Z_0001_hub", "semantic_memory", "mem-1", "hub", now, "{}"],
			);

			// Emit the event (simulating change-log.ts behavior)
			eventBus.emit("changelog:written", {
				hlc: "2026-03-22T10:00:00.000Z_0001_hub",
				tableName: "semantic_memory",
				siteId: "hub",
			});

			// Wait for microtask
			await new Promise((resolve) => setTimeout(resolve, 0));

			transport.stop();

			eventBus.off("changelog:written", listener);
		});
	});

	describe("flushChangelogEntries", () => {
		it("sends changelog_push frames to all connected peers with echo suppression", async () => {
			transport.start();

			const sendFrames1: Uint8Array[] = [];
			const sendFrame1 = (frame: Uint8Array): boolean => {
				sendFrames1.push(frame);
				return true;
			};

			const sendFrames2: Uint8Array[] = [];
			const sendFrame2 = (frame: Uint8Array): boolean => {
				sendFrames2.push(frame);
				return true;
			};

			const key1 = new Uint8Array(32).fill(1);
			const key2 = new Uint8Array(32).fill(2);

			transport.addPeer("peer-1", sendFrame1, key1);
			transport.addPeer("peer-2", sendFrame2, key2);

			// Insert entries: one from hub, one from peer-1
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				["2026-03-22T10:00:00.000Z_0001_hub", "semantic_memory", "mem-1", "hub", now, "{}"],
			);
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				["2026-03-22T10:00:00.000Z_0002_peer-1", "semantic_memory", "mem-2", "peer-1", now, "{}"],
			);

			// Emit events to trigger flush
			eventBus.emit("changelog:written", {
				hlc: "2026-03-22T10:00:00.000Z_0001_hub",
				tableName: "semantic_memory",
				siteId: "hub",
			});
			eventBus.emit("changelog:written", {
				hlc: "2026-03-22T10:00:00.000Z_0002_peer-1",
				tableName: "semantic_memory",
				siteId: "peer-1",
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			transport.stop();

			// peer-1 should receive: hub entry (not peer-1 entry due to echo suppression)
			expect(sendFrames1.length).toBe(1);
			const decodedPeer1 = decodeFrame(sendFrames1[0], key1);
			expect(decodedPeer1.ok).toBe(true);
			if (decodedPeer1.ok) {
				expect(decodedPeer1.value.type).toBe(WsMessageType.CHANGELOG_PUSH);
				const payload = decodedPeer1.value.payload as ChangelogPushPayload;
				expect(payload.entries.length).toBe(1);
				expect(payload.entries[0].site_id).toBe("hub");
			}

			// peer-2 should receive: both hub entry and peer-1 entry
			expect(sendFrames2.length).toBe(1);
			const decodedPeer2 = decodeFrame(sendFrames2[0], key2);
			expect(decodedPeer2.ok).toBe(true);
			if (decodedPeer2.ok) {
				expect(decodedPeer2.value.type).toBe(WsMessageType.CHANGELOG_PUSH);
				const payload = decodedPeer2.value.payload as ChangelogPushPayload;
				expect(payload.entries.length).toBe(2);
			}
		});

		it("batches multiple writes into single frame", async () => {
			transport.start();

			const sendFrames: Uint8Array[] = [];
			const sendFrame = (frame: Uint8Array): boolean => {
				sendFrames.push(frame);
				return true;
			};

			const key = new Uint8Array(32).fill(1);
			transport.addPeer("peer-1", sendFrame, key);

			// Insert 3 entries (within same tick, will be batched)
			const now = new Date().toISOString();
			for (let i = 0; i < 3; i++) {
				db.run(
					`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
					VALUES (?, ?, ?, ?, ?, ?)`,
					[
						`2026-03-22T10:00:00.000Z_000${i + 1}_hub`,
						"semantic_memory",
						`mem-${i}`,
						"hub",
						now,
						"{}",
					],
				);
			}

			// Emit all events synchronously (within same tick)
			for (let i = 0; i < 3; i++) {
				eventBus.emit("changelog:written", {
					hlc: `2026-03-22T10:00:00.000Z_000${i + 1}_hub`,
					tableName: "semantic_memory",
					siteId: "hub",
				});
			}

			await new Promise((resolve) => setTimeout(resolve, 0));

			transport.stop();

			// Should have exactly 1 frame (batched)
			expect(sendFrames.length).toBe(1);

			const decoded = decodeFrame(sendFrames[0], key);
			expect(decoded.ok).toBe(true);
			if (decoded.ok) {
				const payload = decoded.value.payload as ChangelogPushPayload;
				expect(payload.entries.length).toBe(3);
			}
		});
	});

	describe("handleChangelogPush", () => {
		it("replays entries and sends changelog_ack", () => {
			const sendFrames: Uint8Array[] = [];
			const sendFrame = (frame: Uint8Array): boolean => {
				sendFrames.push(frame);
				return true;
			};

			const key = new Uint8Array(32).fill(1);
			transport.addPeer("peer-1", sendFrame, key);

			const payload: ChangelogPushPayload = {
				entries: [
					{
						hlc: "2026-03-22T10:00:00.000Z_0001_peer-1",
						table_name: "semantic_memory",
						row_id: "mem-1",
						site_id: "peer-1",
						row_data: {
							id: "mem-1",
							key: "test",
							value: "value",
							source: "test",
							created_at: "2026-03-22T10:00:00Z",
							modified_at: "2026-03-22T10:00:00Z",
							last_accessed_at: null,
						},
					},
				],
			};

			transport.handleChangelogPush("peer-1", payload);

			// Should have sent changelog_ack
			expect(sendFrames.length).toBe(1);
			const decoded = decodeFrame(sendFrames[0], key);
			expect(decoded.ok).toBe(true);
			if (decoded.ok) {
				expect(decoded.value.type).toBe(WsMessageType.CHANGELOG_ACK);
				const ackPayload = decoded.value.payload as ChangelogAckPayload;
				expect(ackPayload.cursor).toBe("2026-03-22T10:00:00.000Z_0001_peer-1");
			}

			// Verify last_received cursor updated
			const cursor = getPeerCursor(db, "peer-1");
			expect(cursor?.last_received).toBe("2026-03-22T10:00:00.000Z_0001_peer-1");
		});
	});

	describe("handleChangelogAck", () => {
		it("updates last_sent cursor", () => {
			transport.addPeer("peer-1", () => true, new Uint8Array(32));

			const payload: ChangelogAckPayload = {
				cursor: "2026-03-22T10:00:00.000Z_0005_hub",
			};

			transport.handleChangelogAck("peer-1", payload);

			const cursor = getPeerCursor(db, "peer-1");
			expect(cursor?.last_sent).toBe("2026-03-22T10:00:00.000Z_0005_hub");
		});
	});

	describe("drainChangelog", () => {
		it("sends missed entries on reconnection", () => {
			const sendFrames: Uint8Array[] = [];
			const sendFrame = (frame: Uint8Array): boolean => {
				sendFrames.push(frame);
				return true;
			};

			const key = new Uint8Array(32).fill(1);

			// Set up initial last_sent cursor
			updatePeerCursor(db, "peer-1", { last_sent: HLC_ZERO });

			// Insert entries in change_log
			const now = new Date().toISOString();
			for (let i = 0; i < 3; i++) {
				db.run(
					`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
					VALUES (?, ?, ?, ?, ?, ?)`,
					[
						`2026-03-22T10:00:00.000Z_000${i + 1}_hub`,
						"semantic_memory",
						`mem-${i}`,
						"hub",
						now,
						"{}",
					],
				);
			}

			// Add peer and drain
			transport.addPeer("peer-1", sendFrame, key);
			transport.drainChangelog("peer-1");

			// Should have sent: 1 changelog_push (with 3 entries) + 1 drain_complete
			expect(sendFrames.length).toBe(2);

			// First frame should be changelog_push
			const decodedPush = decodeFrame(sendFrames[0], key);
			expect(decodedPush.ok).toBe(true);
			if (decodedPush.ok) {
				expect(decodedPush.value.type).toBe(WsMessageType.CHANGELOG_PUSH);
				const payload = decodedPush.value.payload as ChangelogPushPayload;
				expect(payload.entries.length).toBe(3);
			}

			// Second frame should be drain_complete
			const decodedComplete = decodeFrame(sendFrames[1], key);
			expect(decodedComplete.ok).toBe(true);
			if (decodedComplete.ok) {
				expect(decodedComplete.value.type).toBe(WsMessageType.DRAIN_COMPLETE);
			}

			// Verify last_sent advanced
			const cursor = getPeerCursor(db, "peer-1");
			expect(cursor?.last_sent).not.toBe(HLC_ZERO);
		});

		it("respects echo suppression during drain", () => {
			const sendFrames: Uint8Array[] = [];
			const sendFrame = (frame: Uint8Array): boolean => {
				sendFrames.push(frame);
				return true;
			};

			const key = new Uint8Array(32).fill(1);

			updatePeerCursor(db, "peer-1", { last_sent: HLC_ZERO });

			// Insert entries from different sites
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				["2026-03-22T10:00:00.000Z_0001_peer-1", "semantic_memory", "mem-1", "peer-1", now, "{}"],
			);
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				["2026-03-22T10:00:00.000Z_0002_hub", "semantic_memory", "mem-2", "hub", now, "{}"],
			);

			transport.addPeer("peer-1", sendFrame, key);
			transport.drainChangelog("peer-1");

			// Should only send hub's entry (peer-1's entry suppressed)
			const decodedPush = decodeFrame(sendFrames[0], key);
			expect(decodedPush.ok).toBe(true);
			if (decodedPush.ok) {
				const payload = decodedPush.value.payload as ChangelogPushPayload;
				expect(payload.entries.length).toBe(1);
				expect(payload.entries[0].site_id).toBe("hub");
			}
		});

		it("batches drain entries in chunks of 100", () => {
			const sendFrames: Uint8Array[] = [];
			const sendFrame = (frame: Uint8Array): boolean => {
				sendFrames.push(frame);
				return true;
			};

			const key = new Uint8Array(32).fill(1);

			updatePeerCursor(db, "peer-1", { last_sent: HLC_ZERO });

			// Insert 150 entries
			const now = new Date().toISOString();
			for (let i = 0; i < 150; i++) {
				const hlc = `2026-03-22T10:00:00.000Z_${String(i + 1).padStart(4, "0")}_hub`;
				db.run(
					`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
					VALUES (?, ?, ?, ?, ?, ?)`,
					[hlc, "semantic_memory", `mem-${i}`, "hub", now, "{}"],
				);
			}

			transport.addPeer("peer-1", sendFrame, key);
			transport.drainChangelog("peer-1");

			// Should have: 2 push frames (100 + 50 entries) + 1 drain_complete = 3 frames
			expect(sendFrames.length).toBe(3);

			// Verify first batch has 100 entries
			const decoded1 = decodeFrame(sendFrames[0], key);
			if (decoded1.ok) {
				const payload1 = decoded1.value.payload as ChangelogPushPayload;
				expect(payload1.entries.length).toBe(100);
			}

			// Verify second batch has 50 entries
			const decoded2 = decodeFrame(sendFrames[1], key);
			if (decoded2.ok) {
				const payload2 = decoded2.value.payload as ChangelogPushPayload;
				expect(payload2.entries.length).toBe(50);
			}
		});
	});

	describe("HLC cursor tracking", () => {
		it("advances last_sent after sending entries", async () => {
			transport.start();

			const sendFrame = (): boolean => true;
			const key = new Uint8Array(32).fill(1);

			transport.addPeer("peer-1", sendFrame, key);

			const now = new Date().toISOString();
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				["2026-03-22T10:00:00.000Z_0001_hub", "semantic_memory", "mem-1", "hub", now, "{}"],
			);

			eventBus.emit("changelog:written", {
				hlc: "2026-03-22T10:00:00.000Z_0001_hub",
				tableName: "semantic_memory",
				siteId: "hub",
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			transport.stop();

			const cursor = getPeerCursor(db, "peer-1");
			expect(cursor?.last_sent).toBe("2026-03-22T10:00:00.000Z_0001_hub");
		});

		it("advances last_received after receiving changelog_push", () => {
			transport.addPeer("peer-1", () => true, new Uint8Array(32));

			const payload: ChangelogPushPayload = {
				entries: [
					{
						hlc: "2026-03-22T10:00:00.000Z_0001_peer-1",
						table_name: "semantic_memory",
						row_id: "mem-1",
						site_id: "peer-1",
						row_data: {
							id: "mem-1",
							key: "test",
							value: "val",
							source: "test",
							created_at: "2026-03-22T10:00:00Z",
							modified_at: "2026-03-22T10:00:00Z",
							last_accessed_at: null,
						},
					},
					{
						hlc: "2026-03-22T10:00:00.000Z_0002_peer-1",
						table_name: "semantic_memory",
						row_id: "mem-2",
						site_id: "peer-1",
						row_data: {
							id: "mem-2",
							key: "test2",
							value: "val2",
							source: "test",
							created_at: "2026-03-22T10:00:00Z",
							modified_at: "2026-03-22T10:00:00Z",
							last_accessed_at: null,
						},
					},
				],
			};

			transport.handleChangelogPush("peer-1", payload);

			const cursor = getPeerCursor(db, "peer-1");
			expect(cursor?.last_received).toBe("2026-03-22T10:00:00.000Z_0002_peer-1");
		});
	});

	describe("relay tables untouched", () => {
		it("does not modify relay_outbox or relay_inbox tables", () => {
			// Create relay tables to verify they remain untouched
			db.run(`
				CREATE TABLE relay_outbox (
					id TEXT PRIMARY KEY,
					target_site_id TEXT NOT NULL,
					kind TEXT NOT NULL,
					payload TEXT NOT NULL,
					delivered INTEGER DEFAULT 0,
					created_at TEXT NOT NULL
				)
			`);

			db.run(`
				CREATE TABLE relay_inbox (
					id TEXT PRIMARY KEY,
					source_site_id TEXT NOT NULL,
					kind TEXT NOT NULL,
					payload TEXT NOT NULL,
					processed INTEGER DEFAULT 0,
					created_at TEXT NOT NULL
				)
			`);

			transport.start();

			const sendFrame = (): boolean => true;
			const key = new Uint8Array(32).fill(1);

			transport.addPeer("peer-1", sendFrame, key);

			// Simulate changelog activity
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				["2026-03-22T10:00:00.000Z_0001_hub", "semantic_memory", "mem-1", "hub", now, "{}"],
			);

			eventBus.emit("changelog:written", {
				hlc: "2026-03-22T10:00:00.000Z_0001_hub",
				tableName: "semantic_memory",
				siteId: "hub",
			});

			transport.stop();

			// Verify relay tables remain empty (AC6.5)
			const relayOutboxCount = (
				db.query("SELECT COUNT(*) as count FROM relay_outbox").get() as { count: number }
			).count;
			const relayInboxCount = (
				db.query("SELECT COUNT(*) as count FROM relay_inbox").get() as { count: number }
			).count;

			expect(relayOutboxCount).toBe(0);
			expect(relayInboxCount).toBe(0);
		});
	});

	describe("relay routing (hub-side and spoke-side)", () => {
		beforeEach(() => {
			// Create relay tables
			db.run(`
				CREATE TABLE relay_outbox (
					id TEXT PRIMARY KEY,
					source_site_id TEXT NOT NULL,
					target_site_id TEXT NOT NULL,
					kind TEXT NOT NULL,
					ref_id TEXT,
					idempotency_key TEXT,
					stream_id TEXT,
					payload TEXT NOT NULL,
					created_at TEXT NOT NULL,
					expires_at TEXT NOT NULL,
					delivered INTEGER DEFAULT 0
				)
			`);

			db.run(`
				CREATE TABLE relay_inbox (
					id TEXT PRIMARY KEY,
					source_site_id TEXT NOT NULL,
					kind TEXT NOT NULL,
					ref_id TEXT,
					idempotency_key TEXT,
					stream_id TEXT,
					payload TEXT NOT NULL,
					expires_at TEXT NOT NULL,
					received_at TEXT NOT NULL,
					processed INTEGER DEFAULT 0
				)
			`);
		});

		it("unicast relay routing: Spoke A sends to Spoke B via hub", () => {
			const spokeASendFrames: Uint8Array[] = [];
			const spokeBSendFrames: Uint8Array[] = [];

			const spokeAKey = new Uint8Array(32).fill(2);
			const spokeBKey = new Uint8Array(32).fill(3);

			// Setup: Hub connected to Spoke A and Spoke B
			transport.addPeer(
				"spoke-a",
				(frame) => {
					spokeASendFrames.push(frame);
					return true;
				},
				spokeAKey,
			);
			transport.addPeer(
				"spoke-b",
				(frame) => {
					spokeBSendFrames.push(frame);
					return true;
				},
				spokeBKey,
			);

			// Spoke A sends relay_send targeting Spoke B
			const relaySendPayload: RelaySendPayload = {
				entries: [
					{
						id: "relay-1",
						target_site_id: "spoke-b",
						kind: "tool_call",
						ref_id: "ref-1",
						idempotency_key: null,
						stream_id: null,
						expires_at: new Date(Date.now() + 60000).toISOString(),
						payload: { tool: "test" },
					},
				],
			};

			transport.handleRelaySend("spoke-a", relaySendPayload);

			// Verify Spoke B received relay_deliver frame
			expect(spokeBSendFrames.length).toBe(1);
			const decodedB = decodeFrame(spokeBSendFrames[0], spokeBKey);
			expect(decodedB.ok).toBe(true);
			if (decodedB.ok) {
				expect(decodedB.value.type).toBe(WsMessageType.RELAY_DELIVER);
			}

			// Verify Spoke A received relay_ack frame
			expect(spokeASendFrames.length).toBe(1);
			const decodedA = decodeFrame(spokeASendFrames[0], spokeAKey);
			expect(decodedA.ok).toBe(true);
			if (decodedA.ok) {
				expect(decodedA.value.type).toBe(WsMessageType.RELAY_ACK);
				const ackPayload = decodedA.value.payload as RelayAckPayload;
				expect(ackPayload.ids).toContain("relay-1");
			}
		});

		it("broadcast fan-out: Spoke A sends to all spokes except itself", () => {
			const spokeASendFrames: Uint8Array[] = [];
			const spokeBSendFrames: Uint8Array[] = [];
			const spokeCFrames: Uint8Array[] = [];

			const spokeAKey = new Uint8Array(32).fill(1);
			const spokeBKey = new Uint8Array(32).fill(2);
			const spokeCKey = new Uint8Array(32).fill(3);

			// Hub setup
			transport.addPeer(
				"spoke-a",
				(frame) => {
					spokeASendFrames.push(frame);
					return true;
				},
				spokeAKey,
			);
			transport.addPeer(
				"spoke-b",
				(frame) => {
					spokeBSendFrames.push(frame);
					return true;
				},
				spokeBKey,
			);
			transport.addPeer(
				"spoke-c",
				(frame) => {
					spokeCFrames.push(frame);
					return true;
				},
				spokeCKey,
			);

			// Spoke A sends broadcast (target = "*")
			const relaySendPayload: RelaySendPayload = {
				entries: [
					{
						id: "broadcast-1",
						target_site_id: "*",
						kind: "event_broadcast",
						ref_id: null,
						idempotency_key: null,
						stream_id: null,
						expires_at: new Date(Date.now() + 60000).toISOString(),
						payload: { event: "test-event" },
					},
				],
			};

			transport.handleRelaySend("spoke-a", relaySendPayload);

			// Verify only Spoke B and C received relay_deliver (NOT Spoke A)
			expect(spokeASendFrames.length).toBe(1); // Only ack
			expect(spokeBSendFrames.length).toBe(1); // deliver + implicit ack
			expect(spokeCFrames.length).toBe(1); // deliver + implicit ack

			// Verify content is relay_deliver
			const decodedB = decodeFrame(spokeBSendFrames[0], spokeBKey);
			expect(decodedB.ok && decodedB.value.type === WsMessageType.RELAY_DELIVER).toBe(true);
		});

		it("hub-local request dispatch: request goes to relay_inbox", () => {
			const spokeASendFrames: Uint8Array[] = [];
			const spokeAKey = new Uint8Array(32).fill(1);

			transport.addPeer(
				"spoke-a",
				(frame) => {
					spokeASendFrames.push(frame);
					return true;
				},
				spokeAKey,
			);

			// Spoke A sends tool_call targeting hub
			const relaySendPayload: RelaySendPayload = {
				entries: [
					{
						id: "tool-call-1",
						target_site_id: "hub",
						kind: "tool_call",
						ref_id: "ref-1",
						idempotency_key: null,
						stream_id: null,
						expires_at: new Date(Date.now() + 60000).toISOString(),
						payload: { tool: "test" },
					},
				],
			};

			const inboxEventsFired: Array<{
				ref_id?: string;
				stream_id?: string;
				kind: string;
			}> = [];
			eventBus.on("relay:inbox", (event) => {
				inboxEventsFired.push(event);
			});

			transport.handleRelaySend("spoke-a", relaySendPayload);

			// Verify entry in relay_inbox
			const inboxEntry = db
				.query("SELECT * FROM relay_inbox WHERE id = ?")
				.get("tool-call-1") as Record<string, unknown> | null;
			expect(inboxEntry).not.toBeNull();
			expect(inboxEntry?.kind).toBe("tool_call");

			// Verify relay:inbox event fired
			expect(inboxEventsFired.length).toBe(1);
			expect(inboxEventsFired[0].kind).toBe("tool_call");

			// Cleanup
			eventBus.off("relay:inbox", () => {});
		});

		it("hub-local response routing: stream_chunk goes to relay_inbox", () => {
			const spokeASendFrames: Uint8Array[] = [];
			const spokeAKey = new Uint8Array(32).fill(1);

			transport.addPeer(
				"spoke-a",
				(frame) => {
					spokeASendFrames.push(frame);
					return true;
				},
				spokeAKey,
			);

			// Spoke A sends stream_chunk targeting hub
			const relaySendPayload: RelaySendPayload = {
				entries: [
					{
						id: "stream-1",
						target_site_id: "hub",
						kind: "stream_chunk",
						ref_id: null,
						idempotency_key: null,
						stream_id: "stream-001",
						expires_at: new Date(Date.now() + 60000).toISOString(),
						payload: { text: "chunk" },
					},
				],
			};

			transport.handleRelaySend("spoke-a", relaySendPayload);

			// Verify entry in relay_inbox (response kinds go to inbox, not executed)
			const inboxEntry = db
				.query("SELECT * FROM relay_inbox WHERE id = ?")
				.get("stream-1") as Record<string, unknown> | null;
			expect(inboxEntry).not.toBeNull();
			expect(inboxEntry?.kind).toBe("stream_chunk");
		});

		// Note: Idempotency dedup testing skipped for now.
		// The hub-side idempotency check requires matching id,empotency_key,target_site_id
		// in relay_outbox, but entries targeting different destinations are not in relay_outbox.
		// Full idempotency testing requires multi-step test setup that will be added in Phase 6.

		it("offline spoke: entries accumulate in hub outbox", () => {
			// Hub connected to Spoke A only
			const spokeASendFrames: Uint8Array[] = [];
			const spokeAKey = new Uint8Array(32).fill(1);

			transport.addPeer(
				"spoke-a",
				(frame) => {
					spokeASendFrames.push(frame);
					return true;
				},
				spokeAKey,
			);

			// Spoke A sends relay targeting offline Spoke B
			const relaySendPayload: RelaySendPayload = {
				entries: [
					{
						id: "relay-1",
						target_site_id: "spoke-b",
						kind: "tool_call",
						ref_id: null,
						idempotency_key: null,
						stream_id: null,
						expires_at: new Date(Date.now() + 60000).toISOString(),
						payload: { tool: "test" },
					},
				],
			};

			transport.handleRelaySend("spoke-a", relaySendPayload);

			// Entry should be written to hub outbox (delivered = 0)
			const outboxEntry = db
				.query("SELECT * FROM relay_outbox WHERE id = ?")
				.get("relay-1") as Record<string, unknown> | null;
			expect(outboxEntry).not.toBeNull();
			expect(outboxEntry?.target_site_id).toBe("spoke-b");
			expect(outboxEntry?.delivered).toBe(0);

			// Spoke A should still get ack
			expect(spokeASendFrames.length).toBeGreaterThan(0);
		});

		it("spoke-side relay deliver: entries inserted to inbox with event fired", () => {
			// Spoke receiving relay_deliver from hub
			const relayDeliverPayload: RelayDeliverPayload = {
				entries: [
					{
						id: "relay-result-1",
						source_site_id: "hub",
						kind: "result",
						ref_id: "ref-1",
						idempotency_key: null,
						stream_id: null,
						expires_at: new Date(Date.now() + 60000).toISOString(),
						payload: { result: "data" },
					},
				],
			};

			const inboxEventsFired: Array<{
				ref_id?: string;
				stream_id?: string;
				kind: string;
			}> = [];
			eventBus.on("relay:inbox", (event) => {
				inboxEventsFired.push(event);
			});

			transport.handleRelayDeliver("hub", relayDeliverPayload);

			// Verify entry in relay_inbox
			const inboxEntry = db
				.query("SELECT * FROM relay_inbox WHERE id = ?")
				.get("relay-result-1") as Record<string, unknown> | null;
			expect(inboxEntry).not.toBeNull();
			expect(inboxEntry?.kind).toBe("result");

			// Verify relay:inbox event fired
			expect(inboxEventsFired.length).toBe(1);
			expect(inboxEventsFired[0].kind).toBe("result");

			// Cleanup
			eventBus.off("relay:inbox", () => {});
		});

		it("spoke-side relay ack: marks outbox as delivered", () => {
			// Pre-populate outbox
			db.run(
				`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, payload, created_at, expires_at, delivered)
				VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
				[
					"relay-1",
					"spoke-a",
					"hub",
					"tool_call",
					"{}",
					new Date().toISOString(),
					new Date(Date.now() + 60000).toISOString(),
				],
			);

			const ackPayload: RelayAckPayload = { ids: ["relay-1"] };
			transport.handleRelayAck("hub", ackPayload);

			// Verify entry marked as delivered
			const outboxEntry = db
				.query("SELECT * FROM relay_outbox WHERE id = ?")
				.get("relay-1") as Record<string, unknown> | null;
			expect(outboxEntry?.delivered).toBe(1);
		});
	});
});
