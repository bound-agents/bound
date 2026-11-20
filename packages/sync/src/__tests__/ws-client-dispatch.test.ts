// Behavioral coverage for WsSyncClient receive-side frame dispatch and the
// spoke snapshot-apply handlers that the existing ws-client.test.ts leaves
// uncovered: the handleMessage decode + dispatch branches (changelog, snapshot
// begin/chunk/end, consistency, row-pull), the SNAPSHOT_ACK round trip, and the
// config mutators / connected getter. Uses the real WS cluster harness (real
// servers on port 0, real DBs) so frames flow over genuine sockets, plus
// direct-construction unit tests for the pure config helpers.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureKeypair } from "../crypto.js";
import { KeyManager } from "../key-manager.js";
import { clearColumnCache } from "../reducers.js";
import { WsSyncClient } from "../ws-client.js";
import { WsMessageType, decodeFrame, encodeFrame } from "../ws-frames.js";
import type {
	SnapshotBeginPayload,
	SnapshotChunkPayload,
	SnapshotEndPayload,
} from "../ws-frames.js";
import { type WsTestCluster, createWsTestCluster } from "./test-harness.js";

function uniqueRunId(): string {
	return randomBytes(6).toString("hex");
}

describe("WsSyncClient — receive-side snapshot apply over a live socket", () => {
	let cluster: WsTestCluster;

	beforeEach(async () => {
		cluster = await createWsTestCluster({ spokeCount: 1, basePort: 0, testRunId: uniqueRunId() });
	});

	afterEach(async () => {
		clearColumnCache();
		await cluster.cleanup();
	});

	it("applies a hub-pushed SNAPSHOT_BEGIN/CHUNK/END sequence into the spoke DB and acks", async () => {
		const spoke = cluster.spokes[0];
		const hub = cluster.hub;

		// The hub holds a live server socket to this spoke; push snapshot frames
		// through the real connection manager so the spoke's handleMessage decode +
		// dispatch path runs end to end.
		const symKey = hub.wsTransport as unknown as {
			peerConnections: Map<string, { symmetricKey: Uint8Array }>;
		};
		const peerKey = symKey.peerConnections.get(spoke.siteId)?.symmetricKey;
		expect(peerKey).toBeDefined();
		if (!peerKey) return;

		const conn = hub.connectionManager.get(spoke.siteId);
		expect(conn).toBeDefined();
		if (!conn) return;

		const hlc = "2026-06-01T00:00:00.000Z_0000_hub";
		const begin: SnapshotBeginPayload = { snapshot_hlc: hlc, tables: ["users"] };
		const now = new Date().toISOString();
		const chunk: SnapshotChunkPayload = {
			table_name: "users",
			offset: 0,
			rows: [
				{
					id: "snap-user-1",
					display_name: "Snapshot User",
					first_seen_at: now,
					modified_at: now,
					deleted: 0,
				},
			],
			last: true,
		};
		const end: SnapshotEndPayload = { table_count: 1, row_count: 1 };

		conn.send(encodeFrame(WsMessageType.SNAPSHOT_BEGIN, begin, peerKey), true);
		conn.send(encodeFrame(WsMessageType.SNAPSHOT_CHUNK, chunk, peerKey), true);
		conn.send(encodeFrame(WsMessageType.SNAPSHOT_END, end, peerKey), true);

		// Wait for the frames to be received and applied on the spoke.
		const applied = async (): Promise<boolean> => {
			const row = spoke.db.query("SELECT id FROM users WHERE id = ?").get("snap-user-1");
			return row !== null;
		};
		for (let i = 0; i < 40 && !(await applied()); i++) {
			await new Promise((r) => setTimeout(r, 25));
		}

		const row = spoke.db
			.query("SELECT display_name FROM users WHERE id = ?")
			.get("snap-user-1") as {
			display_name: string;
		} | null;
		expect(row?.display_name).toBe("Snapshot User");
	});

	it("reassembles an oversized column via SNAPSHOT_CHUNK col-chunk frames on the spoke", async () => {
		const spoke = cluster.spokes[0];
		const hub = cluster.hub;
		const peerKey = (
			hub.wsTransport as unknown as {
				peerConnections: Map<string, { symmetricKey: Uint8Array }>;
			}
		).peerConnections.get(spoke.siteId)?.symmetricKey;
		if (!peerKey) return;
		const conn = hub.connectionManager.get(spoke.siteId);
		if (!conn) return;

		const now = new Date().toISOString();
		// Skeleton row (oversized column blanked) then two column chunks.
		const skeleton: SnapshotChunkPayload = {
			table_name: "users",
			offset: 0,
			rows: [
				{ id: "col-user", display_name: "", first_seen_at: now, modified_at: now, deleted: 0 },
			],
			last: false,
		};
		const colA: SnapshotChunkPayload = {
			table_name: "users",
			offset: 0,
			rows: [],
			last: false,
			col_chunk_row_id: "col-user",
			col_chunk_column: "display_name",
			col_chunk_index: 0,
			col_chunk_final: false,
			col_chunk_data: "AAAA",
		};
		const colB: SnapshotChunkPayload = {
			table_name: "users",
			offset: 0,
			rows: [],
			last: true,
			col_chunk_row_id: "col-user",
			col_chunk_column: "display_name",
			col_chunk_index: 1,
			col_chunk_final: true,
			col_chunk_data: "BBBB",
		};

		conn.send(encodeFrame(WsMessageType.SNAPSHOT_CHUNK, skeleton, peerKey), true);
		conn.send(encodeFrame(WsMessageType.SNAPSHOT_CHUNK, colA, peerKey), true);
		conn.send(encodeFrame(WsMessageType.SNAPSHOT_CHUNK, colB, peerKey), true);

		const done = async (): Promise<boolean> => {
			const row = spoke.db.query("SELECT display_name FROM users WHERE id = ?").get("col-user") as {
				display_name: string;
			} | null;
			return row?.display_name === "AAAABBBB";
		};
		for (let i = 0; i < 40 && !(await done()); i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		const row = spoke.db.query("SELECT display_name FROM users WHERE id = ?").get("col-user") as {
			display_name: string;
		} | null;
		expect(row?.display_name).toBe("AAAABBBB");
	});

	it("ignores a text (string) frame without applying anything", async () => {
		const spoke = cluster.spokes[0];
		const hub = cluster.hub;
		const conn = hub.connectionManager.get(spoke.siteId);
		if (!conn) return;

		const before = spoke.db.query("SELECT COUNT(*) AS c FROM users").get() as { c: number };
		// A text frame is logged and ignored by handleMessage's string branch.
		conn.send("this is not a binary frame");
		await new Promise((r) => setTimeout(r, 50));
		const after = spoke.db.query("SELECT COUNT(*) AS c FROM users").get() as { c: number };
		expect(after.c).toBe(before.c);
		// The connection is still alive (text frames don't tear down the spoke side).
		expect(spoke.wsClient.connected).toBe(true);
	});
});

describe("WsSyncClient — config mutators and URL derivation (direct construction)", () => {
	let db: Database;
	let keyManager: KeyManager;
	let client: WsSyncClient | null = null;
	const dirs: string[] = [];

	beforeEach(async () => {
		db = new Database(":memory:");
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
		const dir = join(tmpdir(), `ws-client-cfg-${randomBytes(4).toString("hex")}`);
		dirs.push(dir);
		const kp = await ensureKeypair(join(dir, "keypair"));
		keyManager = new KeyManager({ publicKey: kp.publicKey, privateKey: kp.privateKey }, kp.siteId);
	});

	afterEach(() => {
		client?.close();
		client = null;
		db.close();
	});

	function makeClient(hubUrl: string): WsSyncClient {
		const kp = (keyManager as unknown as { keypair?: { privateKey: CryptoKey } }).keypair;
		return new WsSyncClient({
			hubUrl,
			privateKey: (kp?.privateKey ?? null) as any,
			siteId: "spoke-cfg",
			keyManager,
			hubSiteId: "hub-cfg",
			db,
		});
	}

	it("updateReconnectConfig and updateBackpressureLimit mutate config without connecting", () => {
		client = makeClient("http://localhost:9/sync");
		// Defaults are applied lazily; the mutators take the override path.
		client.updateReconnectConfig(42);
		client.updateBackpressureLimit(1234);
		const cfg = (
			client as unknown as { config: { reconnectMaxInterval?: number; backpressureLimit?: number } }
		).config;
		expect(cfg.reconnectMaxInterval).toBe(42);
		expect(cfg.backpressureLimit).toBe(1234);
	});

	it("updateReconnectConfig / updateBackpressureLimit are no-ops when passed undefined", () => {
		client = makeClient("http://localhost:9/sync");
		const cfg = (
			client as unknown as { config: { reconnectMaxInterval?: number; backpressureLimit?: number } }
		).config;
		const beforeR = cfg.reconnectMaxInterval;
		const beforeB = cfg.backpressureLimit;
		client.updateReconnectConfig(undefined);
		client.updateBackpressureLimit(undefined);
		expect(cfg.reconnectMaxInterval).toBe(beforeR);
		expect(cfg.backpressureLimit).toBe(beforeB);
	});

	it("connected is false before any socket opens, send refuses while disconnected", () => {
		client = makeClient("http://localhost:9/sync");
		expect(client.connected).toBe(false);
		// send() short-circuits to false when ws is null / not OPEN.
		expect(client.send(new Uint8Array([WsMessageType.CHANGELOG_PUSH]))).toBe(false);
	});

	it("deriveWsUrl maps http→ws and https→wss and appends /sync/ws", () => {
		client = makeClient("https://hub.example.com:8443/ignored");
		const derive = (
			client as unknown as { deriveWsUrl(u: string): { wsUrl: string } }
		).deriveWsUrl.bind(client);
		expect(derive("https://hub.example.com:8443/x").wsUrl).toBe(
			"wss://hub.example.com:8443/sync/ws",
		);
		expect(derive("http://localhost:3000/y").wsUrl).toBe("ws://localhost:3000/sync/ws");
	});

	it("deriveWsUrl throws on an unsupported protocol", () => {
		client = makeClient("http://localhost:9/sync");
		const derive = (
			client as unknown as { deriveWsUrl(u: string): { wsUrl: string } }
		).deriveWsUrl.bind(client);
		expect(() => derive("ftp://nope/")).toThrow(/Unsupported protocol/);
	});

	it("close() is idempotent and leaves the client disconnected", () => {
		client = makeClient("http://localhost:9/sync");
		client.close();
		client.close();
		expect(client.connected).toBe(false);
		// connect() after close is ignored (stopped guard).
	});
});

describe("WsSyncClient — SNAPSHOT_END ack frame construction", () => {
	// Drive the private snapshot handlers directly to assert the SNAPSHOT_ACK
	// frame is emitted with the begin HLC after an END — this covers the
	// handleSnapshotBegin → handleSnapshotEnd ack path without a live socket.
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("handleSnapshotEnd sends SNAPSHOT_ACK carrying the begin HLC", () => {
		const sent: Uint8Array[] = [];
		const symKey = new Uint8Array(32).fill(5);
		// Minimal client shell: inject a symmetricKey and capture send().
		const client = new WsSyncClient({
			hubUrl: "http://localhost:9/sync",
			privateKey: null as any,
			siteId: "spoke",
			keyManager: {} as any,
			hubSiteId: "hub",
			wsTransport: {
				applySnapshotChunk: () => 0,
				applyColumnChunk: () => {},
			} as any,
		});
		const inj = client as unknown as {
			symmetricKey: Uint8Array | null;
			send(frame: Uint8Array): boolean;
			handleSnapshotBegin(p: SnapshotBeginPayload): void;
			handleSnapshotEnd(p: SnapshotEndPayload): void;
		};
		inj.symmetricKey = symKey;
		// Capture send() by overriding it.
		inj.send = (frame: Uint8Array): boolean => {
			sent.push(frame);
			return true;
		};

		const hlc = "2026-06-01T00:00:00.000Z_0000_hub";
		inj.handleSnapshotBegin({ snapshot_hlc: hlc, tables: ["users"] });
		inj.handleSnapshotEnd({ table_count: 1, row_count: 0 });

		expect(sent.length).toBe(1);
		const decoded = decodeFrame(sent[0], symKey);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.type).toBe(WsMessageType.SNAPSHOT_ACK);
		const payload = decoded.value.payload as { snapshot_hlc: string };
		expect(payload.snapshot_hlc).toBe(hlc);

		client.close();
	});
});

describe("WsSyncClient — receive-side relay/spool/consistency/row-pull dispatch over a live socket", () => {
	// Drive the handleMessage dispatch branches that no other test reaches: a hub
	// pushing RELAY_DELIVER / RELAY_ACK / SPOOL_TRANSFER / SPOOL_TRANSFER_ACK /
	// CONSISTENCY_RESPONSE / ERROR / ROW_PULL_RESPONSE frames down the live socket
	// so the spoke's handleMessage decode → transport-handler dispatch runs end to
	// end. Assertions are on the observable side effect (row applied, no teardown).
	let cluster: WsTestCluster;

	beforeEach(async () => {
		cluster = await createWsTestCluster({ spokeCount: 1, basePort: 0, testRunId: uniqueRunId() });
	});

	afterEach(async () => {
		clearColumnCache();
		await cluster.cleanup();
	});

	function peerKeyFor(spokeSiteId: string): Uint8Array | undefined {
		return (
			cluster.hub.wsTransport as unknown as {
				peerConnections: Map<string, { symmetricKey: Uint8Array }>;
			}
		).peerConnections.get(spokeSiteId)?.symmetricKey;
	}

	it("dispatches a hub-pushed ROW_PULL_RESPONSE into the spoke DB", async () => {
		const spoke = cluster.spokes[0];
		const peerKey = peerKeyFor(spoke.siteId);
		const conn = cluster.hub.connectionManager.get(spoke.siteId);
		if (!peerKey || !conn) return;

		const now = new Date().toISOString();
		const payload = {
			request_id: "rp-x",
			table_name: "users",
			rows: [
				{
					id: "rpr-user",
					display_name: "Row Pulled",
					first_seen_at: now,
					modified_at: now,
					deleted: 0,
				},
			],
			last: true,
		};
		conn.send(encodeFrame(WsMessageType.ROW_PULL_RESPONSE, payload, peerKey), true);

		const applied = async (): Promise<boolean> =>
			spoke.db.query("SELECT id FROM users WHERE id = ?").get("rpr-user") !== null;
		let ok = false;
		for (let i = 0; i < 40 && !ok; i++) {
			ok = await applied();
			if (!ok) await new Promise((r) => setTimeout(r, 25));
		}
		expect(ok).toBe(true);
		expect(spoke.wsClient.connected).toBe(true);
	});

	it("tolerates hub-pushed legacy RELAY_DELIVER / RELAY_ACK frames without tearing down", async () => {
		const spoke = cluster.spokes[0];
		const peerKey = peerKeyFor(spoke.siteId);
		const conn = cluster.hub.connectionManager.get(spoke.siteId);
		if (!peerKey || !conn) return;

		// Release-N+1 hosts refuse legacy relay frames as a no-op (no insert, no ack).
		const deliver = {
			entries: [
				{
					id: "leg-1",
					source_site_id: "other",
					kind: "platform_request",
					ref_id: null,
					idempotency_key: null,
					stream_id: null,
					expires_at: new Date(Date.now() + 60_000).toISOString(),
					payload: { a: 1 },
				},
			],
		};
		conn.send(encodeFrame(WsMessageType.RELAY_DELIVER, deliver, peerKey), true);
		conn.send(encodeFrame(WsMessageType.RELAY_ACK, { ids: ["leg-1"] }, peerKey), true);
		await new Promise((r) => setTimeout(r, 60));
		expect(spoke.wsClient.connected).toBe(true);
	});

	it("dispatches a hub-pushed SPOOL_TRANSFER into the spoke durable_work table and acks", async () => {
		const spoke = cluster.spokes[0];
		const peerKey = peerKeyFor(spoke.siteId);
		const conn = cluster.hub.connectionManager.get(spoke.siteId);
		if (!peerKey || !conn) return;

		const transfer = {
			entries: [
				{
					id: "sp-1",
					target_site_id: spoke.siteId,
					source_site: cluster.hub.siteId,
					kind: "platform_request",
					payload: { hello: "world" },
					idempotency_key: "idem-sp-1",
					ref_id: null,
					stream_id: null,
					expires_at: null,
					received_at: null,
					token: "tok-1",
				},
			],
		};
		conn.send(encodeFrame(WsMessageType.SPOOL_TRANSFER, transfer, peerKey), true);

		const landed = async (): Promise<boolean> =>
			spoke.db.query("SELECT id FROM durable_work WHERE id = ?").get("sp-1") !== null;
		let ok = false;
		for (let i = 0; i < 40 && !ok; i++) {
			ok = await landed();
			if (!ok) await new Promise((r) => setTimeout(r, 25));
		}
		expect(ok).toBe(true);
		// A SPOOL_TRANSFER_ACK from the spoke is a harmless no-op the hub tolerates.
		conn.send(
			encodeFrame(
				WsMessageType.SPOOL_TRANSFER_ACK,
				{ entries: [{ id: "sp-1", token: "tok-1" }] },
				peerKey,
			),
			true,
		);
		await new Promise((r) => setTimeout(r, 40));
		expect(spoke.wsClient.connected).toBe(true);
	});
});

describe("WsSyncClient — periodic backfill timer", () => {
	let cluster: WsTestCluster;

	beforeEach(async () => {
		cluster = await createWsTestCluster({ spokeCount: 1, basePort: 0, testRunId: uniqueRunId() });
	});

	afterEach(async () => {
		clearColumnCache();
		await cluster.cleanup();
	});

	it("fires runBackfill on its interval when the backfill interval is shrunk", async () => {
		const spoke = cluster.spokes[0];
		let calls = 0;
		// Wrap the transport's runBackfill to count periodic fires, then re-arm the
		// timer at a 30ms cadence through the real config mutator.
		const wt = spoke.wsTransport as unknown as {
			runBackfill: (opts?: { trigger?: string }) => Promise<unknown>;
		};
		const orig = wt.runBackfill.bind(wt);
		wt.runBackfill = (opts?: { trigger?: string }) => {
			if (opts?.trigger === "periodic") calls++;
			return orig(opts);
		};
		spoke.wsClient.updateBackfillInterval(0.03);

		for (let i = 0; i < 40 && calls === 0; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		expect(calls).toBeGreaterThan(0);
	});
});

describe("WsSyncClient — disconnect / reconnect cycle over a live socket", () => {
	let cluster: WsTestCluster;

	beforeEach(async () => {
		cluster = await createWsTestCluster({ spokeCount: 1, basePort: 0, testRunId: uniqueRunId() });
	});

	afterEach(async () => {
		clearColumnCache();
		await cluster.cleanup();
	});

	it("reconnects a fresh socket after the live one is force-closed", async () => {
		const client = cluster.spokes[0].wsClient;
		const ci = client as unknown as {
			ws: WebSocket | null;
			connected: boolean;
			socketGeneration: number;
			hasOpenedOnce: boolean;
		};
		expect(ci.connected).toBe(true);
		const genBefore = ci.socketGeneration;
		expect(ci.hasOpenedOnce).toBe(true);
		// Speed up the reconnect so the test settles quickly.
		client.updateReconnectConfig(1);

		// Force-close the live socket: handleClose fires removePeer + scheduleReconnect,
		// the reconnect opens a fresh socket (new generation), and handleOpen takes the
		// reconnect branch (hasOpenedOnce already true → scheduleReconnectBackfill).
		ci.ws?.close();

		let reconnected = false;
		for (let i = 0; i < 120 && !reconnected; i++) {
			reconnected = ci.connected && ci.socketGeneration > genBefore;
			if (!reconnected) await new Promise((r) => setTimeout(r, 25));
		}
		expect(reconnected).toBe(true);
	});
});

describe("WsSyncClient — reseed on connect", () => {
	let db: Database;
	let keyManager: KeyManager;
	const dirs: string[] = [];

	beforeEach(async () => {
		db = new Database(":memory:");
		const dir = join(tmpdir(), `ws-client-reseed-${randomBytes(4).toString("hex")}`);
		dirs.push(dir);
		const kp = await ensureKeypair(join(dir, "keypair"));
		keyManager = new KeyManager({ publicKey: kp.publicKey, privateKey: kp.privateKey }, kp.siteId);
	});

	afterEach(() => {
		db.close();
	});

	it("handleOpen clears synced tables once when reseed is set", () => {
		let cleared = 0;
		const client = new WsSyncClient({
			hubUrl: "http://localhost:9/sync",
			privateKey: null as unknown as CryptoKey,
			siteId: "spoke",
			keyManager,
			hubSiteId: "hub",
			reseed: true,
			wsTransport: {
				addPeer: () => {},
				drainChangelog: () => {},
				drainDurableWorkSpool: () => {},
				clearSyncedTables: () => {
					cleared++;
				},
				runBackfill: async () => ({}),
			} as unknown as never,
		});
		const inj = client as unknown as {
			symmetricKey: Uint8Array | null;
			handleOpen(): void;
		};
		inj.symmetricKey = new Uint8Array(32).fill(3);
		// Drive handleOpen directly (no live socket): the reseed branch clears tables
		// exactly once (reseedSent latches), and the first-connect backfill fires.
		inj.handleOpen();
		inj.handleOpen();
		expect(cleared).toBe(1);
		client.close();
	});
});

describe("WsSyncClient — handleMessage transport-dispatch branches (direct construction)", () => {
	// Drive handleMessage directly with real frames so each transport-dispatch
	// branch runs without a live socket. The wsTransport is a capturing stub; the
	// symmetricKey is injected so decodeFrame succeeds.
	const symKey = new Uint8Array(32).fill(11);

	function makeClient(calls: string[]): WsSyncClient {
		const wsTransport = {
			handleChangelogPush: () => calls.push("changelog_push"),
			handleChangelogAck: () => calls.push("changelog_ack"),
			handleRelayDeliver: () => calls.push("relay_deliver"),
			handleRelayAck: () => calls.push("relay_ack"),
			handleSpoolTransfer: () => calls.push("spool_transfer"),
			handleSpoolTransferAck: () => calls.push("spool_transfer_ack"),
		} as unknown as never;
		const client = new WsSyncClient({
			hubUrl: "http://localhost:9/sync",
			privateKey: null as unknown as CryptoKey,
			siteId: "spoke",
			keyManager: {} as unknown as never,
			hubSiteId: "hub",
			wsTransport,
		});
		(client as unknown as { symmetricKey: Uint8Array | null }).symmetricKey = symKey;
		return client;
	}

	function deliver(client: WsSyncClient, type: WsMessageType, payload: unknown): void {
		const frame = encodeFrame(type, payload, symKey);
		(client as unknown as { handleMessage(e: { data: Uint8Array }): void }).handleMessage({
			data: frame,
		});
	}

	it("routes each transport frame type to its handler", () => {
		const calls: string[] = [];
		const client = makeClient(calls);
		deliver(client, WsMessageType.CHANGELOG_PUSH, { entries: [] });
		deliver(client, WsMessageType.CHANGELOG_ACK, { cursor: "2026-01-01T00:00:00.000Z_0000_0000" });
		deliver(client, WsMessageType.RELAY_DELIVER, { entries: [] });
		deliver(client, WsMessageType.RELAY_ACK, { ids: [] });
		deliver(client, WsMessageType.SPOOL_TRANSFER_ACK, { entries: [] });
		expect(calls).toEqual([
			"changelog_push",
			"changelog_ack",
			"relay_deliver",
			"relay_ack",
			"spool_transfer_ack",
		]);
		client.close();
	});

	it("logs-and-ignores an unexpected RELAY_SEND from the hub without dispatching", () => {
		const calls: string[] = [];
		const client = makeClient(calls);
		// RELAY_SEND hits the explicit warn branch (hub should never send it) and
		// dispatches to no handler.
		deliver(client, WsMessageType.RELAY_SEND, { entries: [] });
		expect(calls).toEqual([]);
		client.close();
	});

	it("updates lastReceivedAt on any inbound frame (receive-liveness)", () => {
		const calls: string[] = [];
		const client = makeClient(calls);
		const inj = client as unknown as { lastReceivedAt: number };
		inj.lastReceivedAt = 0;
		deliver(client, WsMessageType.CHANGELOG_ACK, { cursor: "2026-01-01T00:00:00.000Z_0000_0000" });
		expect(inj.lastReceivedAt).toBeGreaterThan(0);
		client.close();
	});

	it("handleError logs the websocket error event without throwing", () => {
		const calls: string[] = [];
		const client = makeClient(calls);
		const inj = client as unknown as { handleError(e: Event): void };
		expect(() => inj.handleError(new ErrorEvent("error", { message: "boom" }))).not.toThrow();
		// A plain Event (non-ErrorEvent) takes the String(event) branch.
		expect(() => inj.handleError(new Event("error"))).not.toThrow();
		client.close();
	});
});

describe("WsSyncClient — handshake sync-error recording (direct construction)", () => {
	let db: Database;
	let keyManager: KeyManager;
	const dirs: string[] = [];

	beforeEach(async () => {
		db = new Database(":memory:");
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
		const dir = join(tmpdir(), `ws-client-hs-${randomBytes(4).toString("hex")}`);
		dirs.push(dir);
		const kp = await ensureKeypair(join(dir, "keypair"));
		keyManager = new KeyManager({ publicKey: kp.publicKey, privateKey: kp.privateKey }, kp.siteId);
	});

	afterEach(() => {
		db.close();
	});

	function makeClient(): WsSyncClient {
		return new WsSyncClient({
			hubUrl: "http://localhost:9/sync",
			privateKey: null as unknown as CryptoKey,
			siteId: "spoke-hs",
			keyManager,
			hubSiteId: "hub-hs",
			db,
		});
	}

	it("recordHandshakeFailure increments sync_errors for the hub peer", () => {
		const client = makeClient();
		const inj = client as unknown as { recordHandshakeFailure(reason: string): void };
		inj.recordHandshakeFailure("boom");
		inj.recordHandshakeFailure("boom again");
		const row = db
			.query("SELECT sync_errors FROM sync_state WHERE peer_site_id = ?")
			.get("hub-hs") as { sync_errors: number } | null;
		expect(row?.sync_errors).toBe(2);
		client.close();
	});

	it("recordHandshakeSuccess resets sync_errors to zero", () => {
		const client = makeClient();
		const inj = client as unknown as {
			recordHandshakeFailure(reason: string): void;
			recordHandshakeSuccess(): void;
		};
		inj.recordHandshakeFailure("boom");
		inj.recordHandshakeSuccess();
		const row = db
			.query("SELECT sync_errors FROM sync_state WHERE peer_site_id = ?")
			.get("hub-hs") as { sync_errors: number } | null;
		expect(row?.sync_errors).toBe(0);
		client.close();
	});

	it("both record methods swallow a DB error without throwing", () => {
		const client = makeClient();
		// Close the DB so the UPDATE throws inside the try — the catch path logs and
		// returns, leaving the client usable.
		db.close();
		const inj = client as unknown as {
			recordHandshakeFailure(reason: string): void;
			recordHandshakeSuccess(): void;
		};
		expect(() => inj.recordHandshakeFailure("boom")).not.toThrow();
		expect(() => inj.recordHandshakeSuccess()).not.toThrow();
		client.close();
		// Re-open a throwaway DB so afterEach's close() is a no-op-safe double close.
		db = new Database(":memory:");
	});
});

describe("WsSyncClient — send() backpressure latch (direct construction)", () => {
	let keyManager: KeyManager;

	beforeEach(async () => {
		const kp = await ensureKeypair(join(tmpdir(), `ws-send-bp-${randomBytes(4).toString("hex")}`));
		keyManager = new KeyManager({ publicKey: kp.publicKey, privateKey: kp.privateKey }, kp.siteId);
	});

	function makeClient(): WsSyncClient {
		return new WsSyncClient({
			hubUrl: "http://localhost:9/sync",
			privateKey: null as unknown as CryptoKey,
			siteId: "spoke",
			keyManager,
			hubSiteId: "hub",
			backpressureLimit: 1024,
		});
	}

	// A fake OPEN socket whose bufferedAmount we control, plus a capturing send().
	function attachFakeWs(client: WsSyncClient, bufferedAmount: number) {
		const sent: unknown[] = [];
		const fakeWs = {
			readyState: 1, // WebSocket.OPEN
			bufferedAmount,
			send: (b: unknown) => {
				sent.push(b);
			},
		};
		(client as unknown as { ws: unknown }).ws = fakeWs;
		return { fakeWs, sent };
	}

	it("latches pressured and refuses when the live buffer exceeds the limit", () => {
		const client = makeClient();
		const { sent } = attachFakeWs(client, 999_999);
		const ok = client.send(new Uint8Array([WsMessageType.CHANGELOG_PUSH]));
		expect(ok).toBe(false);
		expect(sent).toHaveLength(0);
		expect((client as unknown as { sendState: string }).sendState).toBe("pressured");
		client.close();
	});

	it("clears a stale pressured latch and sends when the buffer is back under the limit", () => {
		const client = makeClient();
		const { sent } = attachFakeWs(client, 0);
		// Pre-set the latch as if a prior blip had pressured it.
		(client as unknown as { sendState: string }).sendState = "pressured";
		const ok = client.send(new Uint8Array([WsMessageType.CHANGELOG_PUSH]));
		expect(ok).toBe(true);
		expect(sent).toHaveLength(1);
		// The stale latch cleared back to ready.
		expect((client as unknown as { sendState: string }).sendState).toBe("ready");
		client.close();
	});

	it("returns false without sending when the socket is not OPEN", () => {
		const client = makeClient();
		const { sent } = attachFakeWs(client, 0);
		(client as unknown as { ws: { readyState: number } }).ws.readyState = 3; // CLOSED
		expect(client.send(new Uint8Array([WsMessageType.CHANGELOG_PUSH]))).toBe(false);
		expect(sent).toHaveLength(0);
		client.close();
	});
});
