import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HLC_ZERO, TypedEventEmitter } from "@bound/shared";
import { getConfirmedSyncWatermark, getPeerCursor, updatePeerCursor } from "../peer-cursor.js";
import { setSyncTelemetry } from "../telemetry.js";
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
				last_confirmed TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000',
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
		setSyncTelemetry();
		transport.stop();
		db.close();
	});

	describe("addPeer/removePeer", () => {
		it("records an attempted drain skipped before a peer exists", () => {
			const drains: Array<{ value: number; attributes?: Record<string, string | number> }> = [];
			setSyncTelemetry({
				handshakes: { add() {} },
				drains: { add: (value, attributes) => drains.push({ value, attributes }) },
				drainedEntries: { add() {} },
				drainDuration: { record() {} },
				startSpan: () => ({ addEvent() {}, recordException() {}, setStatus() {}, end() {} }),
			});

			transport.drainChangelog("missing-peer");

			expect(drains).toEqual([{ value: 1, attributes: { kind: "changelog", outcome: "skipped" } }]);
		});

		it("tracks active peer connections without double-counting replacements", () => {
			const active: Array<{ value: number; attributes?: Record<string, string | number> }> = [];
			setSyncTelemetry({
				handshakes: { add() {} },
				drains: { add() {} },
				drainedEntries: { add() {} },
				drainDuration: { record() {} },
				activeConnections: { add: (value, attributes) => active.push({ value, attributes }) },
				startSpan: () => ({ addEvent() {}, recordException() {}, setStatus() {}, end() {} }),
			});
			const sendFrame = (): boolean => true;
			const key = new Uint8Array(32).fill(1);

			transport.addPeer("peer-1", sendFrame, key);
			transport.addPeer("peer-1", sendFrame, key);
			transport.removePeer("peer-1");
			transport.removePeer("peer-1");

			expect(active).toEqual([
				{ value: 1, attributes: { role: "server" } },
				{ value: -1, attributes: { role: "server" } },
			]);
		});
	});

	describe("flushChangelogEntries", () => {
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

		// AC.5 (R-UD7): last_confirmed is the peer-acknowledged watermark and the
		// sole anchor authority for delegation range segments. It must advance ONLY
		// on changelog_ack — never on the optimistic send-side write (the flush in
		// flushChangelogEntries). This test drives a flush, asserts the watermark is
		// still HLC_ZERO, then drives an ack and asserts it advances.
		it("advances last_confirmed ONLY on ack, never on the optimistic send", async () => {
			transport.start();

			const key = new Uint8Array(32).fill(1);
			transport.addPeer("peer-1", () => true, key);

			// Insert a hub-originated changelog entry and emit the write event so
			// flushChangelogEntries runs (the optimistic send-side path).
			const now = new Date().toISOString();
			const hlc = "2026-03-22T10:00:00.000Z_0007_hub";
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				[hlc, "semantic_memory", "mem-7", "hub", now, "{}"],
			);
			eventBus.emit("changelog:written", {
				hlc,
				tableName: "semantic_memory",
				siteId: "hub",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			// Optimistic send advanced last_sent...
			expect(getPeerCursor(db, "peer-1")?.last_sent).toBe(hlc);
			// ...but NOT the confirmed watermark.
			expect(getConfirmedSyncWatermark(db, "peer-1")).toBe(HLC_ZERO);

			// The peer now acks. ONLY now does last_confirmed advance.
			transport.handleChangelogAck("peer-1", { cursor: hlc });
			expect(getConfirmedSyncWatermark(db, "peer-1")).toBe(hlc);

			transport.stop();
		});
	});

	describe("drainChangelog", () => {
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

	describe("legacy relay frames (release N+1 warn-and-drop)", () => {
		// After the N+1 demolition there is no relay_outbox/relay_inbox to route
		// into. A legacy RELAY_SEND/RELAY_DELIVER can only arrive from a peer with a
		// stale capability snapshot; the transport refuses the PAYLOAD but keeps the
		// SOCKET (the frame decode stays, so no 1011 close flaps the stale peer).
		it("handleRelaySend warns and drops without inserting or acking", () => {
			const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
			const warnDb = new Database(":memory:");
			const warnTransport = new WsTransport({
				db: warnDb,
				siteId: "hub",
				eventBus: new TypedEventEmitter(),
				logger: {
					info() {},
					error() {},
					debug() {},
					warn(msg: string, meta?: Record<string, unknown>) {
						warnings.push({ msg, meta });
					},
				},
			});
			const sent: Uint8Array[] = [];
			warnTransport.addPeer(
				"spoke-a",
				(frame) => {
					sent.push(frame);
					return true;
				},
				new Uint8Array(32).fill(2),
			);
			try {
				const payload: RelaySendPayload = {
					entries: [
						{
							id: "legacy-1",
							target_site_id: "hub",
							kind: "tool_call",
							ref_id: null,
							idempotency_key: "k1",
							stream_id: null,
							expires_at: new Date(Date.now() + 60_000).toISOString(),
							payload: { tool: "noop" },
							trace_context: null,
						},
					],
				};
				warnTransport.handleRelaySend("spoke-a", payload);
				// (a) warns, (b) no relay_inbox insert (table does not exist — a write
				// would have thrown), (c) no ack frame sent back.
				expect(warnings.some((w) => /RELAY_SEND/.test(w.msg))).toBe(true);
				expect(sent.length).toBe(0);
			} finally {
				warnTransport.stop();
				warnDb.close();
			}
		});

		it("handleRelayDeliver warns and drops on a spoke without inserting or acking", () => {
			const warnings: string[] = [];
			const warnDb = new Database(":memory:");
			const warnTransport = new WsTransport({
				db: warnDb,
				siteId: "spoke",
				eventBus: new TypedEventEmitter(),
				logger: {
					info() {},
					error() {},
					debug() {},
					warn(msg: string) {
						warnings.push(msg);
					},
				},
			});
			const sent: Uint8Array[] = [];
			warnTransport.addPeer(
				"hub",
				(frame) => {
					sent.push(frame);
					return true;
				},
				new Uint8Array(32).fill(1),
			);
			try {
				const payload: RelayDeliverPayload = {
					entries: [
						{
							id: "legacy-2",
							source_site_id: "hub",
							kind: "result",
							ref_id: "req-1",
							idempotency_key: null,
							stream_id: null,
							expires_at: new Date(Date.now() + 60_000).toISOString(),
							payload: { ok: true },
							trace_context: null,
						},
					],
				};
				warnTransport.handleRelayDeliver("hub", payload);
				expect(warnings.some((m) => /RELAY_DELIVER/.test(m))).toBe(true);
				expect(sent.length).toBe(0);
			} finally {
				warnTransport.stop();
				warnDb.close();
			}
		});

		it("handleRelayAck is a harmless no-op", () => {
			const ackDb = new Database(":memory:");
			const ackTransport = new WsTransport({
				db: ackDb,
				siteId: "hub",
				eventBus: new TypedEventEmitter(),
			});
			try {
				const payload: RelayAckPayload = { ids: ["whatever"] };
				expect(() => ackTransport.handleRelayAck("spoke-a", payload)).not.toThrow();
			} finally {
				ackTransport.stop();
				ackDb.close();
			}
		});
	});
});
