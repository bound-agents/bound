import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HLC_ZERO, TypedEventEmitter } from "@bound/shared";
import { getConfirmedSyncWatermark, getPeerCursor } from "../peer-cursor.js";
import type { ChangelogPushPayload } from "../ws-frames.js";
import { WsMessageType, decodeFrame } from "../ws-frames.js";
import { WsTransport } from "../ws-transport.js";

/**
 * #305: a refused (backpressured) changelog push must never be skipped by a
 * later accepted push. The cumulative cursors (`last_sent`, `last_confirmed`)
 * may only cover a contiguous delivered prefix, and backpressure recovery must
 * re-drain the refused range in HLC order.
 */
describe("changelog backpressure ordering (#305)", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let transport: WsTransport;
	const key = new Uint8Array(32).fill(7);
	const PEER = "peer-1";

	/** Accepted CHANGELOG_PUSH entries, in wire order. */
	let delivered: string[];
	let accept: boolean | ((frameIndex: number) => boolean);
	let frameIndex: number;

	function sendFrame(frame: Uint8Array): boolean {
		const index = frameIndex++;
		const ok = typeof accept === "function" ? accept(index) : accept;
		if (!ok) return false;
		const decoded = decodeFrame(frame, key);
		if (decoded.ok && decoded.value.type === WsMessageType.CHANGELOG_PUSH) {
			const payload = decoded.value.payload as ChangelogPushPayload;
			for (const entry of payload.entries) delivered.push(entry.hlc);
		}
		return true;
	}

	function hlc(n: number): string {
		return `2026-11-25T10:00:00.000Z_${String(n).padStart(4, "0")}_hub`;
	}

	function persist(n: number, rowData = "{}"): string {
		const h = hlc(n);
		db.run(
			`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
			VALUES (?, 'semantic_memory', ?, 'hub', ?, ?)`,
			[h, `mem-${n}`, new Date().toISOString(), rowData],
		);
		return h;
	}

	async function writeLive(...ns: number[]): Promise<string[]> {
		const hlcs = ns.map((n) => persist(n));
		for (const h of hlcs) {
			eventBus.emit("changelog:written", { hlc: h, tableName: "semantic_memory", siteId: "hub" });
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		return hlcs;
	}

	beforeEach(() => {
		db = new Database(":memory:");
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
				last_received TEXT NOT NULL DEFAULT '${HLC_ZERO}',
				last_sent TEXT NOT NULL DEFAULT '${HLC_ZERO}',
				last_confirmed TEXT NOT NULL DEFAULT '${HLC_ZERO}',
				sync_errors INTEGER DEFAULT 0,
				last_sync_at TEXT
			)
		`);
		eventBus = new TypedEventEmitter();
		transport = new WsTransport({ db, siteId: "hub", eventBus });
		transport.start();
		delivered = [];
		accept = true;
		frameIndex = 0;
		transport.addPeer(PEER, sendFrame, key);
	});

	afterEach(() => {
		transport.stop();
		db.close();
	});

	it("refuse A, accept B, ACK B: cursors never cover A and recovery delivers A before B", async () => {
		accept = false;
		const [a] = await writeLive(1);
		accept = true;
		const [b] = await writeLive(2);

		// B must not reach the wire ahead of the refused A.
		expect(delivered).not.toContain(b);

		// Even an ACK for B (what the receiver sends for its highest HLC) must not
		// advance either cursor past the never-delivered A.
		transport.handleChangelogAck(PEER, { cursor: b });
		expect((getPeerCursor(db, PEER)?.last_sent ?? HLC_ZERO) < a).toBe(true);
		expect(getConfirmedSyncWatermark(db, PEER) < a).toBe(true);

		// Backpressure clears: the refused range re-drains in HLC order.
		transport.resumeChangelogDrain(PEER);
		expect(delivered).toEqual([a, b]);
		expect(getPeerCursor(db, PEER)?.last_sent).toBe(b);

		transport.handleChangelogAck(PEER, { cursor: b });
		expect(getConfirmedSyncWatermark(db, PEER)).toBe(b);

		// Once recovered, live pushes flow again.
		const [c] = await writeLive(3);
		expect(delivered).toEqual([a, b, c]);
	});

	it("a partially accepted multi-frame live batch re-sends the refused tail", async () => {
		// ~1.2 MB rows: four of them exceed the 4 MiB frame cap and split into
		// [e1,e2] + [e3,e4]. Accept the first frame, refuse the second.
		const big = JSON.stringify({ blob: "x".repeat(1_200_000) });
		const hlcs = [1, 2, 3, 4].map((n) => persist(n, big));
		accept = (i) => i === 0;
		for (const h of hlcs) {
			eventBus.emit("changelog:written", { hlc: h, tableName: "semantic_memory", siteId: "hub" });
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(delivered).toEqual([hlcs[0], hlcs[1]]);

		// The receiver acks the prefix it got; the watermark must stay below e3.
		transport.handleChangelogAck(PEER, { cursor: hlcs[1] });
		expect(getConfirmedSyncWatermark(db, PEER) < hlcs[2]).toBe(true);
		expect((getPeerCursor(db, PEER)?.last_sent ?? HLC_ZERO) < hlcs[2]).toBe(true);

		accept = true;
		delivered = [];
		transport.resumeChangelogDrain(PEER);
		// e3 and e4 arrive, in order (the acked prefix may be re-sent idempotently).
		expect(delivered.slice(-2)).toEqual([hlcs[2], hlcs[3]]);
		transport.handleChangelogAck(PEER, { cursor: hlcs[3] });
		expect(getConfirmedSyncWatermark(db, PEER)).toBe(hlcs[3]);
	});

	it("a backpressured reconnect drain holds later live writes until recovery re-drains", async () => {
		const drained = Array.from({ length: 150 }, (_, i) => persist(i + 1));
		accept = (i) => i === 0; // first 100-entry batch accepted, second refused
		transport.drainChangelog(PEER);
		expect(delivered).toEqual(drained.slice(0, 100));
		expect(getPeerCursor(db, PEER)?.last_sent).toBe(drained[99]);

		accept = true;
		const [late] = await writeLive(500);
		expect(delivered).not.toContain(late);
		transport.handleChangelogAck(PEER, { cursor: late });
		expect(getConfirmedSyncWatermark(db, PEER) <= drained[99]).toBe(true);

		transport.resumeChangelogDrain(PEER);
		expect(delivered).toEqual([...drained, late]);
	});

	it("resumeChangelogDrain is a no-op when nothing was refused", async () => {
		await writeLive(1);
		const before = [...delivered];
		const framesBefore = frameIndex;
		transport.resumeChangelogDrain(PEER);
		expect(delivered).toEqual(before);
		expect(frameIndex).toBe(framesBefore);
	});
});
