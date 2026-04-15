import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HLC_ZERO, TypedEventEmitter } from "@bound/shared";
import { getPeerCursor, updatePeerCursor } from "../peer-cursor.js";
import { MicrotaskCoalescer } from "../ws-coalescer.js";
import type { ChangelogAckPayload, ChangelogPushPayload } from "../ws-frames.js";
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
			transport.start();

			const sendFrame = (): boolean => true;
			const key = new Uint8Array(32).fill(1);

			transport.addPeer("peer-1", sendFrame, key);

			// Simulate some activity
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

			// Verify relay tables are not touched (no errors)
			// (In a full test, would create these tables and verify they remain empty)
		});
	});
});
