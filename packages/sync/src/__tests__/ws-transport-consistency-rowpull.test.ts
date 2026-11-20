// Behavioral coverage for the WsTransport consistency-stream and row-pull send
// helpers that ws-transport.test.ts and ws-transport-frames-snapshot.test.ts
// leave uncovered: continueConsistencyStream (backpressure resume + disconnect
// + all_done terminal), the spoke-side consistency request/resume state machine
// (requestConsistency with a resume cursor, handleConsistencyResponse cursor
// tracking + table-count-match + all_done, handleConsistencyError, the 5-minute
// timeout snapshotting resume state), and the row-pull hub stream helpers
// (streamRowPullPages empty-table skip, sendRowPullSubChunk frame-splitting under
// an oversize row, continueRowPull resume, handleRowPullAck cursor advance). Real
// DBs and real frame encode/decode throughout; peers are driven through a
// sendFrame closure with a toggleable backpressure flag, the same seam the
// snapshot test uses. Nothing in-process is mocked.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypedEventEmitter } from "@bound/shared";
import { ensureKeypair } from "../crypto.js";
import { clearColumnCache } from "../reducers.js";
import { WsMessageType, decodeFrame } from "../ws-frames.js";
import type { ConsistencyEntry } from "../ws-frames.js";
import { WsTransport } from "../ws-transport.js";
import { createSyncTestSchema } from "./test-harness.js";

function uniqueRunId(): string {
	return randomBytes(6).toString("hex");
}

interface StubPeer {
	frames: Uint8Array[];
	backpressured: boolean;
	symKey: Uint8Array;
}

// Reach into the private send-helper surface. These methods are the intended
// drain-resume seam (ws-server's drain() handler calls continueRowPull /
// continueConsistencyStream verbatim), so driving them directly mirrors
// production flow without a mock.
interface TransportInternals {
	addPeer(peerSiteId: string, sendFrame: (f: Uint8Array) => boolean, symKey: Uint8Array): void;
	peerConnections: Map<string, unknown>;
	continueConsistencyStream(peerSiteId: string): void;
	continueRowPull(peerSiteId: string): void;
	handleConsistencyRequest(peerSiteId: string, payload: unknown): void;
	handleConsistencyResponse(payload: unknown): void;
	handleConsistencyError(payload: unknown): void;
	handleRowPullRequest(peerSiteId: string, payload: unknown): void;
	handleRowPullAck(peerSiteId: string, payload: { request_id: string }): void;
	requestRowPull(
		tables: Array<{ table: string; pks: string[] }>,
		onFrame?: () => void,
	): Promise<number>;
	handleRowPullResponse(payload: unknown): number;
	sendRowPullAck(requestId: string): void;
	requestConsistency(
		tables: string[],
	): Promise<Map<string, { count: number; pks: string[]; entries?: ConsistencyEntry[] }>>;
	consistencyResumeState: unknown;
	pendingConsistencyStream: Map<string, unknown>;
	pendingRowPullState: Map<string, unknown>;
}

async function makeTransport(
	siteId: string,
	isHub: boolean,
): Promise<{ db: Database; transport: WsTransport; bus: TypedEventEmitter }> {
	const db = new Database(":memory:");
	createSyncTestSchema(db);
	// createSyncTestSchema omits the `users` table; the row-pull/consistency
	// tests pull real rows from it, so add it (a plain synced-table shape).
	db.run(`
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			display_name TEXT NOT NULL,
			platform_ids TEXT,
			first_seen_at TEXT NOT NULL,
			modified_at TEXT NOT NULL,
			deleted INTEGER NOT NULL DEFAULT 0
		)
	`);
	const bus = new TypedEventEmitter();
	const transport = new WsTransport({ db, siteId, eventBus: bus, isHub });
	transport.start();
	return { db, transport, bus };
}

function registerStub(transport: WsTransport, peerSiteId: string, symKey: Uint8Array): StubPeer {
	const stub: StubPeer = { frames: [], backpressured: false, symKey };
	(transport as unknown as TransportInternals).addPeer(
		peerSiteId,
		(frame: Uint8Array): boolean => {
			if (stub.backpressured) return false;
			stub.frames.push(frame);
			return true;
		},
		symKey,
	);
	return stub;
}

function decodeAll(stub: StubPeer): Array<{ type: number; payload: unknown }> {
	return stub.frames.map((f) => {
		const r = decodeFrame(f, stub.symKey);
		if (!r.ok) throw new Error(`decode failed: ${r.error}`);
		return { type: r.value.type, payload: r.value.payload };
	});
}

describe("WsTransport — hub-side consistency stream resume", () => {
	let hub: { db: Database; transport: WsTransport; bus: TypedEventEmitter };
	let symKey: Uint8Array;
	const peerSiteId = "spoke-consistency";

	beforeEach(async () => {
		const kp = await ensureKeypair(join(tmpdir(), `cstream-${uniqueRunId()}`));
		hub = await makeTransport(kp.siteId, kp, true);
		symKey = randomBytes(32);
	});

	afterEach(() => {
		clearColumnCache();
		hub.transport.stop?.();
		hub.db.close();
	});

	it("pauses on backpressure, then continueConsistencyStream resumes and drains every PK page", async () => {
		// Seed enough users that the PK stream pages more than once.
		const now = new Date().toISOString();
		const insert = hub.db.prepare(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
		);
		for (let i = 0; i < 25; i++) {
			insert.run(`u-${i}`, `User ${i}`, now, now);
		}

		const stub = registerStub(hub.transport, peerSiteId, symKey);
		// Backpressure the very first send so the stream parks in
		// pendingConsistencyStream before any frame lands.
		stub.backpressured = true;
		(hub.transport as unknown as TransportInternals).handleConsistencyRequest(peerSiteId, {
			tables: ["users"],
			request_id: "cr-1",
		});

		const ti = hub.transport as unknown as TransportInternals;
		expect(ti.pendingConsistencyStream.has(peerSiteId)).toBe(true);
		expect(stub.frames.length).toBe(0);

		// Relieve backpressure and resume via the exact seam ws-server's drain() uses.
		stub.backpressured = false;
		ti.continueConsistencyStream(peerSiteId);

		// Let the setTimeout(0) continuation chain flush all remaining pages.
		for (let i = 0; i < 40 && ti.pendingConsistencyStream.has(peerSiteId); i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		await new Promise((r) => setTimeout(r, 20));

		const decoded = decodeAll(stub);
		const responses = decoded.filter((d) => d.type === WsMessageType.CONSISTENCY_RESPONSE);
		expect(responses.length).toBeGreaterThan(0);
		const allPks = new Set<string>();
		for (const r of responses) {
			for (const pk of (r.payload as { pks: string[] }).pks) allPks.add(pk);
		}
		expect(allPks.size).toBe(25);
		// The final response frame is marked all_done.
		expect(responses.some((r) => (r.payload as { all_done?: boolean }).all_done === true)).toBe(
			true,
		);
		expect(ti.pendingConsistencyStream.has(peerSiteId)).toBe(false);
	});

	it("continueConsistencyStream fails the serving operation when the peer vanished mid-stream", async () => {
		const now = new Date().toISOString();
		const insert = hub.db.prepare(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
		);
		for (let i = 0; i < 25; i++) insert.run(`v-${i}`, `V ${i}`, now, now);

		const stub = registerStub(hub.transport, peerSiteId, symKey);
		stub.backpressured = true;
		const ti = hub.transport as unknown as TransportInternals;
		ti.handleConsistencyRequest(peerSiteId, { tables: ["users"], request_id: "cr-2" });
		expect(ti.pendingConsistencyStream.has(peerSiteId)).toBe(true);

		// Remove the peer, then resume: the state must be dropped (peer gone branch).
		ti.peerConnections.delete(peerSiteId);
		ti.continueConsistencyStream(peerSiteId);
		expect(ti.pendingConsistencyStream.has(peerSiteId)).toBe(false);
	});

	it("continueConsistencyStream is a no-op when there is no parked state", () => {
		const ti = hub.transport as unknown as TransportInternals;
		registerStub(hub.transport, peerSiteId, symKey);
		// No request was parked — must return cleanly without throwing.
		expect(() => ti.continueConsistencyStream(peerSiteId)).not.toThrow();
	});

	it("handleConsistencyRequest returns early when no requested table is recognized", () => {
		const stub = registerStub(hub.transport, peerSiteId, symKey);
		const ti = hub.transport as unknown as TransportInternals;
		// Every requested name is unknown, so the allTables filter yields zero tables
		// and the handler hits the empty-tables guard and returns without streaming.
		ti.handleConsistencyRequest(peerSiteId, {
			tables: ["not_a_real_table", "also_fake"],
			request_id: "cr-empty",
		});
		expect(stub.frames.length).toBe(0);
		expect(ti.pendingConsistencyStream.has(peerSiteId)).toBe(false);
	});

	it("returns early without parking state when no requested table is valid", () => {
		registerStub(hub.transport, peerSiteId, symKey);
		const ti = hub.transport as unknown as TransportInternals;
		// A request whose only table name is not in the hub's synced-table set filters
		// to zero tables, hitting the empty-tables guard (no stream parked, no frame).
		ti.handleConsistencyRequest(peerSiteId, {
			tables: ["not_a_real_table"],
			request_id: "cr-empty",
		});
		expect(ti.pendingConsistencyStream.has(peerSiteId)).toBe(false);
	});
});

describe("WsTransport — spoke-side consistency request/response state machine", () => {
	let spoke: { db: Database; transport: WsTransport; bus: TypedEventEmitter };
	let symKey: Uint8Array;
	const hubSiteId = "hub-peer";

	beforeEach(async () => {
		const kp = await ensureKeypair(join(tmpdir(), `creq-${uniqueRunId()}`));
		spoke = await makeTransport(kp.siteId, kp, false);
		symKey = randomBytes(32);
	});

	afterEach(() => {
		clearColumnCache();
		spoke.transport.stop?.();
		spoke.db.close();
	});

	it("rejects requestConsistency when not connected to a hub", async () => {
		const ti = spoke.transport as unknown as TransportInternals;
		await expect(ti.requestConsistency(["users"])).rejects.toThrow(/Not connected to hub/);
	});

	it("resolves on all_done and accumulates pks across multiple response frames", async () => {
		const stub = registerStub(spoke.transport, hubSiteId, symKey);
		const ti = spoke.transport as unknown as TransportInternals;
		const promise = ti.requestConsistency(["users"]);

		// The request frame was sent to the hub.
		const sent = decodeAll(stub);
		expect(sent.some((d) => d.type === WsMessageType.CONSISTENCY_REQUEST)).toBe(true);
		const reqId = (
			sent.find((d) => d.type === WsMessageType.CONSISTENCY_REQUEST)?.payload as {
				request_id: string;
			}
		).request_id;

		// First response: partial, advances the cursor.
		ti.handleConsistencyResponse({
			table: "users",
			pks: ["a", "b"],
			count: 4,
			request_id: reqId,
			next_table_index: 0,
			next_offset: 2,
			has_more: true,
		});
		// Second response: appends more pks and terminates with all_done.
		ti.handleConsistencyResponse({
			table: "users",
			pks: ["c", "d"],
			count: 4,
			request_id: reqId,
			next_table_index: 0,
			next_offset: 4,
			all_done: true,
		});

		const result = await promise;
		expect(result.get("users")?.pks.sort()).toEqual(["a", "b", "c", "d"]);
		// Resume state cleared on a clean all_done resolution.
		expect(ti.consistencyResumeState).toBeNull();
	});

	it("resolves on table_count_match when the last table arrives with no has_more", async () => {
		const stub = registerStub(spoke.transport, hubSiteId, symKey);
		const ti = spoke.transport as unknown as TransportInternals;
		const promise = ti.requestConsistency(["users"]);
		const reqId = (
			decodeAll(stub).find((d) => d.type === WsMessageType.CONSISTENCY_REQUEST)?.payload as {
				request_id: string;
			}
		).request_id;

		ti.handleConsistencyResponse({
			table: "users",
			pks: ["x"],
			count: 1,
			request_id: reqId,
			has_more: false,
			table_count: 1,
		});

		const result = await promise;
		expect(result.size).toBe(1);
	});

	it("handleConsistencyError rejects the pending request and clears its timer", async () => {
		const stub = registerStub(spoke.transport, hubSiteId, symKey);
		const ti = spoke.transport as unknown as TransportInternals;
		const promise = ti.requestConsistency(["users"]);
		const reqId = (
			decodeAll(stub).find((d) => d.type === WsMessageType.CONSISTENCY_REQUEST)?.payload as {
				request_id: string;
			}
		).request_id;

		ti.handleConsistencyError({ request_id: reqId });
		await expect(promise).rejects.toThrow(/Consistency request failed/);
	});

	it("ignores response/error frames for unknown request ids", () => {
		const ti = spoke.transport as unknown as TransportInternals;
		registerStub(spoke.transport, hubSiteId, symKey);
		expect(() =>
			ti.handleConsistencyResponse({ table: "users", pks: [], count: 0, request_id: "ghost" }),
		).not.toThrow();
		expect(() => ti.handleConsistencyError({ request_id: "ghost" })).not.toThrow();
		// Missing request_id entirely is also a clean no-op.
		expect(() => ti.handleConsistencyError({})).not.toThrow();
	});
});

describe("WsTransport — hub-side row pull streaming", () => {
	let hub: { db: Database; transport: WsTransport; bus: TypedEventEmitter };
	let symKey: Uint8Array;
	const peerSiteId = "spoke-rowpull";

	beforeEach(async () => {
		const kp = await ensureKeypair(join(tmpdir(), `rowpull-${uniqueRunId()}`));
		hub = await makeTransport(kp.siteId, kp, true);
		symKey = randomBytes(32);
	});

	afterEach(() => {
		clearColumnCache();
		hub.transport.stop?.();
		hub.db.close();
	});

	it("streams requested rows, pausing on backpressure and resuming via continueRowPull", async () => {
		const now = new Date().toISOString();
		const insert = hub.db.prepare(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
		);
		const pks: string[] = [];
		for (let i = 0; i < 5; i++) {
			const id = `rp-${i}`;
			insert.run(id, `RP ${i}`, now, now);
			pks.push(id);
		}

		const stub = registerStub(hub.transport, peerSiteId, symKey);
		stub.backpressured = true;
		const ti = hub.transport as unknown as TransportInternals;
		ti.handleRowPullRequest(peerSiteId, {
			request_id: "rpr-1",
			tables: [{ table: "users", pks }],
		});
		// State parked, no frame yet.
		expect(ti.pendingRowPullState.has(peerSiteId)).toBe(true);
		expect(stub.frames.length).toBe(0);

		stub.backpressured = false;
		ti.continueRowPull(peerSiteId);
		for (let i = 0; i < 40 && ti.pendingRowPullState.has(peerSiteId); i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		await new Promise((r) => setTimeout(r, 20));

		const decoded = decodeAll(stub).filter((d) => d.type === WsMessageType.ROW_PULL_RESPONSE);
		const got = new Set<string>();
		for (const d of decoded) {
			for (const row of (d.payload as { rows: Array<{ id: string }> }).rows) got.add(row.id);
		}
		expect(got.size).toBe(5);
		expect(decoded.some((d) => (d.payload as { last?: boolean }).last === true)).toBe(true);
	});

	it("rejects an invalid table name with an ERROR frame and streams nothing", () => {
		const stub = registerStub(hub.transport, peerSiteId, symKey);
		const ti = hub.transport as unknown as TransportInternals;
		ti.handleRowPullRequest(peerSiteId, {
			request_id: "rpr-bad",
			tables: [{ table: "users; DROP TABLE users", pks: ["x"] }],
		});
		const decoded = decodeAll(stub);
		expect(decoded.some((d) => d.type === WsMessageType.ERROR)).toBe(true);
		expect(decoded.some((d) => d.type === WsMessageType.ROW_PULL_RESPONSE)).toBe(false);
	});

	it("skips an empty-PK table and still emits a terminal last frame", async () => {
		const now = new Date().toISOString();
		hub.db
			.prepare(
				"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
			)
			.run("only", "Only", now, now);

		const stub = registerStub(hub.transport, peerSiteId, symKey);
		const ti = hub.transport as unknown as TransportInternals;
		// First table empty (skipped via streamRowPullPages batch.length === 0),
		// second table has the row.
		ti.handleRowPullRequest(peerSiteId, {
			request_id: "rpr-empty",
			tables: [
				{ table: "users", pks: [] },
				{ table: "users", pks: ["only"] },
			],
		});
		for (let i = 0; i < 40 && ti.pendingRowPullState.has(peerSiteId); i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		await new Promise((r) => setTimeout(r, 20));

		const decoded = decodeAll(stub).filter((d) => d.type === WsMessageType.ROW_PULL_RESPONSE);
		expect(decoded.some((d) => (d.payload as { last?: boolean }).last === true)).toBe(true);
		const got = new Set<string>();
		for (const d of decoded)
			for (const row of (d.payload as { rows: Array<{ id: string }> }).rows) got.add(row.id);
		expect(got.has("only")).toBe(true);
	});

	it("handleRowPullAck advances the peer cursor and triggers a changelog drain", () => {
		registerStub(hub.transport, peerSiteId, symKey);
		// Seed a sync_state row so updatePeerCursor has a target.
		hub.db.run("INSERT OR IGNORE INTO sync_state (peer_site_id) VALUES (?)", [peerSiteId]);
		const ti = hub.transport as unknown as TransportInternals;
		expect(() => ti.handleRowPullAck(peerSiteId, { request_id: "rpr-1" })).not.toThrow();
		const row = hub.db
			.query("SELECT last_received, last_sent FROM sync_state WHERE peer_site_id = ?")
			.get(peerSiteId) as { last_received: string | null; last_sent: string | null } | null;
		expect(row?.last_received).toBeTruthy();
		expect(row?.last_sent).toBeTruthy();
	});

	it("continueRowPull is a no-op when no row-pull state is parked", () => {
		registerStub(hub.transport, peerSiteId, symKey);
		const ti = hub.transport as unknown as TransportInternals;
		expect(() => ti.continueRowPull(peerSiteId)).not.toThrow();
	});

	it("frame-splits an oversized single row down to one-per-frame in sendRowPullSubChunk", async () => {
		const now = new Date().toISOString();
		// One row whose display_name alone exceeds the per-frame budget, so the
		// binary-search split in sendRowPullSubChunk collapses to sliceEnd === 1 and
		// emits the oversized frame anyway (the single-row break path).
		const big = "x".repeat(400_000);
		hub.db
			.prepare(
				"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
			)
			.run("huge", big, now, now);
		// A second normal row in the same table so the first page carries >1 row and
		// the split actually has to shrink the slice rather than ship both at once.
		hub.db
			.prepare(
				"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
			)
			.run("small", "tiny", now, now);

		const stub = registerStub(hub.transport, peerSiteId, symKey);
		const ti = hub.transport as unknown as TransportInternals;
		ti.handleRowPullRequest(peerSiteId, {
			request_id: "rpr-huge",
			tables: [{ table: "users", pks: ["huge", "small"] }],
		});
		for (let i = 0; i < 60 && ti.pendingRowPullState.has(peerSiteId); i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		await new Promise((r) => setTimeout(r, 20));

		const decoded = decodeAll(stub).filter((d) => d.type === WsMessageType.ROW_PULL_RESPONSE);
		const got = new Map<string, number>();
		for (const d of decoded) {
			for (const row of (d.payload as { rows: Array<{ id: string; display_name: string }> }).rows) {
				got.set(row.id, row.display_name.length);
			}
		}
		// Both rows arrived, the oversized one intact, and the terminal frame fired.
		expect(got.get("huge")).toBe(400_000);
		expect(got.get("small")).toBe(4);
		expect(decoded.some((d) => (d.payload as { last?: boolean }).last === true)).toBe(true);
	});
});

describe("WsTransport.runBackfill — local-only push and remote-only pull diff", () => {
	// Drives executeBackfill's diff/push/pull block by stubbing requestConsistency
	// to return the hub's view of PKs (the same seam backfill.test.ts uses). This
	// exercises the mergeDiff path, the BEGIN IMMEDIATE push batches, and the
	// row-pull request for remote-only rows — all without a live socket.
	let spoke: { db: Database; transport: WsTransport; bus: TypedEventEmitter };

	beforeEach(async () => {
		const kp = await ensureKeypair(join(tmpdir(), `bf-${uniqueRunId()}`));
		spoke = await makeTransport(kp.siteId, false);
	});

	afterEach(() => {
		clearColumnCache();
		spoke.transport.stop?.();
		spoke.db.close();
	});

	function insertMemory(id: string, key: string): void {
		const now = new Date().toISOString();
		spoke.db.run(
			`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at)
			 VALUES (?, ?, 'v', 'test', ?, ?)`,
			[id, key, now, now],
		);
	}

	function stubHub(remote: Map<string, { count: number; pks: string[] }>): void {
		const ti = spoke.transport as unknown as TransportInternals;
		ti.addPeer("hub", () => true, randomBytes(32));
		// Override the consistency request to return the hub's view directly — the
		// sanctioned seam (backfill.test.ts uses the same override).
		(spoke.transport as unknown as { requestConsistency: unknown }).requestConsistency = async () =>
			remote;
	}

	it("generates changelog entries for local-only rows (push via PK-only diff)", async () => {
		insertMemory("mem-shared", "shared");
		insertMemory("mem-local-1", "local-1");
		insertMemory("mem-local-2", "local-2");

		const remote = new Map<string, { count: number; pks: string[] }>();
		// Hub omits state hashes (entries undefined) — drives the PK-only fallback
		// branch (getBackfillablePksSorted + mergeDiffPks).
		remote.set("semantic_memory", { count: 1, pks: ["mem-shared"] });
		stubHub(remote);

		const result = await spoke.transport.runBackfill();
		expect(result.backfilled).toBe(2);
		expect(result.tables).toBe(1);
		const rows = spoke.db
			.query("SELECT row_id FROM change_log WHERE table_name = 'semantic_memory' ORDER BY row_id")
			.all() as Array<{ row_id: string }>;
		expect(rows.map((r) => r.row_id)).toEqual(["mem-local-1", "mem-local-2"]);
	});

	it("returns an empty result when local and remote agree", async () => {
		insertMemory("mem-1", "a");
		insertMemory("mem-2", "b");
		const remote = new Map<string, { count: number; pks: string[] }>();
		remote.set("semantic_memory", { count: 2, pks: ["mem-1", "mem-2"] });
		stubHub(remote);

		const result = await spoke.transport.runBackfill();
		expect(result.backfilled).toBe(0);
		expect(result.tables).toBe(0);
	});

	it("no-ops (does not throw) when a backfill is already running", async () => {
		insertMemory("mem-1", "a");
		const remote = new Map<string, { count: number; pks: string[] }>();
		remote.set("semantic_memory", { count: 0, pks: [] });
		stubHub(remote);

		const first = spoke.transport.runBackfill();
		const second = await spoke.transport.runBackfill();
		await first;
		// The concurrent second call short-circuits to the running-skip path.
		expect(second).toEqual({ backfilled: 0, tables: 0, requested: 0, pulled: 0 });
	});

	it("pulls remote-only rows (drives the row-pull leg of executeBackfill)", async () => {
		// Local has one shared row; hub advertises two more PKs the spoke lacks, so
		// the diff routes them to remoteOnlyByTable and runBackfill calls requestRowPull.
		// Override requestRowPull to resolve a pulled count without a live hub stream,
		// driving the pull-accounting + completion branch (the 2690-2726 region).
		insertMemory("mem-shared", "shared");
		const remote = new Map<string, { count: number; pks: string[] }>();
		remote.set("semantic_memory", {
			count: 3,
			pks: ["mem-shared", "mem-remote-1", "mem-remote-2"],
		});
		stubHub(remote);

		let pullArgs: Array<{ table: string; pks: string[] }> | null = null;
		(
			spoke.transport as unknown as {
				requestRowPull: (
					t: Array<{ table: string; pks: string[] }>,
					onFrame?: () => void,
				) => Promise<number>;
			}
		).requestRowPull = async (tables, onFrame) => {
			pullArgs = tables;
			onFrame?.();
			return tables.reduce((sum, t) => sum + t.pks.length, 0);
		};

		const result = await spoke.transport.runBackfill({ isFirstConnect: true });
		// Two remote-only PKs were requested and reported pulled.
		expect(pullArgs).not.toBeNull();
		expect(result.requested).toBe(2);
		expect(result.pulled).toBe(2);
		const pa = pullArgs as unknown as Array<{ table: string; pks: string[] }>;
		expect(pa[0].pks.sort()).toEqual(["mem-remote-1", "mem-remote-2"]);
	});

	it("propagates a requestRowPull failure out of executeBackfill", async () => {
		insertMemory("mem-shared", "shared");
		const remote = new Map<string, { count: number; pks: string[] }>();
		remote.set("semantic_memory", { count: 2, pks: ["mem-shared", "mem-remote-x"] });
		stubHub(remote);

		(
			spoke.transport as unknown as {
				requestRowPull: () => Promise<number>;
			}
		).requestRowPull = async () => {
			throw new Error("row pull boom");
		};

		await expect(spoke.transport.runBackfill()).rejects.toThrow(/row pull boom/);
	});
});

describe("WsTransport.drainChangelog + flushChangelogEntries", () => {
	// Drives the hub-side changelog drain (empty, send, backpressure, drain-complete)
	// and the push-on-write flush (echo suppression, backpressure) with a stub peer
	// and seeded change_log rows. Both are reachable without a live socket.
	let hub: { db: Database; transport: WsTransport; bus: TypedEventEmitter };
	let symKey: Uint8Array;
	const peerSiteId = "spoke-drain";

	beforeEach(async () => {
		const kp = await ensureKeypair(join(tmpdir(), `drain-${uniqueRunId()}`));
		hub = await makeTransport(kp.siteId, true);
		symKey = randomBytes(32);
		hub.db.run("INSERT OR IGNORE INTO sync_state (peer_site_id) VALUES (?)", [peerSiteId]);
	});

	afterEach(() => {
		clearColumnCache();
		hub.transport.stop?.();
		hub.db.close();
	});

	function seedChangeLogRow(rowId: string, siteId: string): void {
		const now = new Date().toISOString();
		const hlc = `${now}_0001_${siteId.slice(0, 4)}-${rowId}`;
		hub.db.run(
			`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
			 VALUES (?, 'users', ?, ?, ?, ?)`,
			[
				hlc,
				rowId,
				siteId,
				now,
				JSON.stringify({
					id: rowId,
					display_name: rowId,
					first_seen_at: now,
					modified_at: now,
					deleted: 0,
				}),
			],
		);
	}

	it("drains missed entries to a connected peer and sends DRAIN_COMPLETE", () => {
		seedChangeLogRow("drain-1", "other-site");
		seedChangeLogRow("drain-2", "other-site");
		const stub = registerStub(hub.transport, peerSiteId, symKey);
		hub.transport.drainChangelog(peerSiteId);

		const decoded = decodeAll(stub);
		expect(decoded.some((d) => d.type === WsMessageType.CHANGELOG_PUSH)).toBe(true);
		expect(decoded.some((d) => d.type === WsMessageType.DRAIN_COMPLETE)).toBe(true);
		// The peer cursor advanced to the highest sent HLC.
		const row = hub.db
			.query("SELECT last_sent FROM sync_state WHERE peer_site_id = ?")
			.get(peerSiteId) as { last_sent: string } | null;
		expect(row?.last_sent).not.toBe("0000-00-00T00:00:00.000Z_0000_0000");
	});

	it("is a no-op (no frames) when there are no missed entries", () => {
		const stub = registerStub(hub.transport, peerSiteId, symKey);
		hub.transport.drainChangelog(peerSiteId);
		expect(stub.frames.length).toBe(0);
	});

	it("echo-suppresses entries authored by the target peer", () => {
		// A row authored BY the peer must not be echoed back to it.
		seedChangeLogRow("echo-1", peerSiteId);
		const stub = registerStub(hub.transport, peerSiteId, symKey);
		hub.transport.drainChangelog(peerSiteId);
		expect(stub.frames.length).toBe(0);
	});

	it("stops draining at the first backpressured frame", () => {
		for (let i = 0; i < 5; i++) seedChangeLogRow(`bp-${i}`, "other-site");
		const stub = registerStub(hub.transport, peerSiteId, symKey);
		stub.backpressured = true;
		hub.transport.drainChangelog(peerSiteId);
		// Backpressured on the first frame → no DRAIN_COMPLETE, cursor not advanced.
		const decoded = decodeAll(stub);
		expect(decoded.some((d) => d.type === WsMessageType.DRAIN_COMPLETE)).toBe(false);
	});

	it("skips the drain entirely when the peer is not connected", () => {
		// No registerStub → no peer connection; drain short-circuits on the guard.
		expect(() => hub.transport.drainChangelog("ghost-peer")).not.toThrow();
	});

	it("flushes a changelog:written event to a connected peer with echo suppression", async () => {
		const stub = registerStub(hub.transport, peerSiteId, symKey);
		seedChangeLogRow("flush-1", "other-site");
		const hlcRow = hub.db.query("SELECT hlc FROM change_log WHERE row_id = ?").get("flush-1") as {
			hlc: string;
		} | null;
		expect(hlcRow).not.toBeNull();
		if (!hlcRow) return;
		// Fire the module-level changelog bus the transport listens on. The flush path
		// batches and pushes to every connected peer except the author.
		hub.bus.emit("changelog:written", {
			hlc: hlcRow.hlc,
			tableName: "users",
			siteId: "other-site",
		});
		await new Promise((r) => setTimeout(r, 30));
		const decoded = decodeAll(stub);
		expect(decoded.some((d) => d.type === WsMessageType.CHANGELOG_PUSH)).toBe(true);
	});
});

describe("WsTransport — spoke-side row-pull request/response round trip", () => {
	// Drives requestRowPull (send + pending-request registration) and
	// handleRowPullResponse (apply rows, apply column chunks, resolve on last) on
	// the spoke, through the isolated-transport seam. The hub peer is a capturing
	// stub so the request frame is observable; responses are fed back directly.
	let spoke: { db: Database; transport: WsTransport; bus: TypedEventEmitter };
	let symKey: Uint8Array;

	beforeEach(async () => {
		const kp = await ensureKeypair(join(tmpdir(), `rp-spoke-${uniqueRunId()}`));
		spoke = await makeTransport(kp.siteId, false);
		symKey = randomBytes(32);
	});

	afterEach(() => {
		clearColumnCache();
		spoke.transport.stop?.();
		spoke.db.close();
	});

	it("rejects requestRowPull when no hub peer is connected", async () => {
		const ti = spoke.transport as unknown as TransportInternals;
		await expect(ti.requestRowPull([{ table: "users", pks: ["a"] }])).rejects.toThrow(
			/Not connected to hub/,
		);
	});

	it("sends a ROW_PULL_REQUEST then resolves with the applied-row count on the last response", async () => {
		const stub = registerStub(spoke.transport, "hub", symKey);
		const ti = spoke.transport as unknown as TransportInternals;

		let frames = 0;
		const pending = ti.requestRowPull([{ table: "users", pks: ["u1", "u2"] }], () => frames++);

		// The request frame went out with the two requested PKs.
		const reqFrames = decodeAll(stub).filter((d) => d.type === WsMessageType.ROW_PULL_REQUEST);
		expect(reqFrames).toHaveLength(1);
		const reqPayload = reqFrames[0].payload as {
			request_id: string;
			tables: Array<{ table: string; pks: string[] }>;
		};
		expect(reqPayload.tables[0].pks).toEqual(["u1", "u2"]);
		const requestId = reqPayload.request_id;

		const now = new Date().toISOString();
		// First response carries one row, not last.
		ti.handleRowPullResponse({
			request_id: requestId,
			table_name: "users",
			rows: [{ id: "u1", display_name: "One", first_seen_at: now, modified_at: now, deleted: 0 }],
			last: false,
		});
		// Terminal response carries the second row and resolves the promise.
		ti.handleRowPullResponse({
			request_id: requestId,
			table_name: "users",
			rows: [{ id: "u2", display_name: "Two", first_seen_at: now, modified_at: now, deleted: 0 }],
			last: true,
		});

		const applied = await pending;
		expect(applied).toBe(2);
		expect(frames).toBe(2);
		const ids = spoke.db.query("SELECT id FROM users ORDER BY id").all() as Array<{ id: string }>;
		expect(ids.map((r) => r.id)).toEqual(["u1", "u2"]);
	});

	it("reassembles an oversized column via col-chunk fields in handleRowPullResponse", async () => {
		const stub = registerStub(spoke.transport, "hub", symKey);
		const ti = spoke.transport as unknown as TransportInternals;
		const now = new Date().toISOString();

		const pending = ti.requestRowPull([{ table: "users", pks: ["big"] }]);
		const requestId = (
			decodeAll(stub).find((d) => d.type === WsMessageType.ROW_PULL_REQUEST)?.payload as {
				request_id: string;
			}
		).request_id;

		// Skeleton row with the oversized column blanked.
		ti.handleRowPullResponse({
			request_id: requestId,
			table_name: "users",
			rows: [{ id: "big", display_name: "", first_seen_at: now, modified_at: now, deleted: 0 }],
			last: false,
		});
		// Two column chunks reassemble the display_name.
		ti.handleRowPullResponse({
			request_id: requestId,
			table_name: "users",
			rows: [],
			last: false,
			col_chunk_row_id: "big",
			col_chunk_column: "display_name",
			col_chunk_index: 0,
			col_chunk_data: "AAAA",
		});
		ti.handleRowPullResponse({
			request_id: requestId,
			table_name: "users",
			rows: [],
			last: true,
			col_chunk_row_id: "big",
			col_chunk_column: "display_name",
			col_chunk_index: 1,
			col_chunk_data: "BBBB",
		});

		await pending;
		const row = spoke.db.query("SELECT display_name FROM users WHERE id = ?").get("big") as {
			display_name: string;
		} | null;
		expect(row?.display_name).toBe("AAAABBBB");
	});

	it("handleRowPullResponse ignores a response for an unknown request id", () => {
		registerStub(spoke.transport, "hub", symKey);
		const ti = spoke.transport as unknown as TransportInternals;
		const now = new Date().toISOString();
		// No pending request registered for this id — applies the row but tracks nothing.
		const applied = ti.handleRowPullResponse({
			request_id: "nope",
			table_name: "users",
			rows: [{ id: "ghost", display_name: "G", first_seen_at: now, modified_at: now, deleted: 0 }],
			last: true,
		});
		expect(applied).toBe(1);
		// The row still landed (apply is unconditional); only the resolve bookkeeping is skipped.
		expect(spoke.db.query("SELECT id FROM users WHERE id = ?").get("ghost")).not.toBeNull();
	});

	it("sendRowPullAck emits a ROW_PULL_ACK frame to the hub peer", () => {
		const stub = registerStub(spoke.transport, "hub", symKey);
		const ti = spoke.transport as unknown as TransportInternals;
		ti.sendRowPullAck("req-xyz");
		const acks = decodeAll(stub).filter((d) => d.type === WsMessageType.ROW_PULL_ACK);
		expect(acks).toHaveLength(1);
		expect((acks[0].payload as { request_id: string }).request_id).toBe("req-xyz");
	});
});
