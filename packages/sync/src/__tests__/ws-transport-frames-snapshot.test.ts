// Behavioral coverage for the WsTransport frame-encoding and snapshot-send paths
// that the existing ws-transport.test.ts and snapshot-seeding-hub.test.ts leave
// uncovered: oversize changelog frame splitting (encodeChangelogFrames recursion),
// the oversized-row skeleton + column-chunk protocol (sendOversizedRow), snapshot
// sub-chunk advancement, reseed, spool transfer send/receive/ack, and the various
// no-op / guard branches on the private send helpers. Real DBs, real frame encode/
// decode, no in-process mocks — frames are captured through a sendFrame closure the
// same way the hub snapshot tests do.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HLC_ZERO, TypedEventEmitter } from "@bound/shared";
import { clearColumnCache } from "../reducers.js";
import { WsMessageType, decodeFrame } from "../ws-frames.js";
import type {
	SnapshotChunkPayload,
	SpoolTransferAckPayload,
	SpoolTransferPayload,
} from "../ws-frames.js";
import { WsTransport } from "../ws-transport.js";

// The snapshot chunk state machine has no public entrypoint now that connect is
// consistency-pull-first, so seeding snapshotStates directly through a typed cast
// is the sanctioned test seam (mirrors snapshot-seeding-hub.test.ts).
interface SnapshotStateInjector {
	snapshotStates: Map<
		string,
		{
			tableIndex: number;
			offset: number;
			lastRowid: number;
			snapshotHlc: string;
			draining: boolean;
			stmt: unknown;
			pendingRows?: Array<Record<string, unknown>>;
			pendingCursor?: number;
			pendingRowsRaw?: Array<Record<string, unknown>>;
			pendingIsLastBatch?: boolean;
		}
	>;
	sendSnapshotChunks(peerSiteId: string): void;
}

interface StubPeer {
	frames: Uint8Array[];
	pings: number;
	backpressured: boolean;
}

function registerStubPeer(
	transport: WsTransport,
	peerSiteId: string,
	symKey: Uint8Array,
): StubPeer {
	const stub: StubPeer = { frames: [], pings: 0, backpressured: false };
	transport.addPeer(
		peerSiteId,
		(frame: Uint8Array): boolean => {
			if (stub.backpressured) return false;
			stub.frames.push(frame);
			return true;
		},
		symKey,
		() => {
			stub.pings += 1;
		},
		peerSiteId,
	);
	return stub;
}

function startSeed(transport: WsTransport, peerSiteId: string, snapshotHlc: string): void {
	const inj = transport as unknown as SnapshotStateInjector;
	inj.snapshotStates.set(peerSiteId, {
		tableIndex: 0,
		offset: 0,
		lastRowid: 0,
		snapshotHlc,
		draining: false,
		stmt: null,
	});
}

function decodeChunks(stub: StubPeer, symKey: Uint8Array): SnapshotChunkPayload[] {
	const chunks: SnapshotChunkPayload[] = [];
	for (const frame of stub.frames) {
		const decoded = decodeFrame(frame, symKey);
		if (decoded.ok && decoded.value.type === WsMessageType.SNAPSHOT_CHUNK) {
			chunks.push(decoded.value.payload as SnapshotChunkPayload);
		}
	}
	return chunks;
}

function createMinimalSchema(db: Database): void {
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
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
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			display_name TEXT NOT NULL,
			platform_ids TEXT,
			first_seen_at TEXT NOT NULL,
			modified_at TEXT NOT NULL,
			deleted INTEGER NOT NULL DEFAULT 0
		) STRICT
	`);
	db.run(`
		CREATE TABLE durable_work (
			id TEXT PRIMARY KEY, target_site_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			claim_state TEXT NOT NULL DEFAULT 'pending' CHECK (claim_state IN ('pending', 'processing', 'transferring', 'consumed', 'dead_letter')),
			claim_token TEXT, claimed_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
			created_at TEXT NOT NULL, expires_at TEXT, dead_lettered_at TEXT, consumed_at TEXT,
			ref_id TEXT, source_site TEXT, received_at TEXT, stream_id TEXT, trace_context TEXT, reclassify_count INTEGER NOT NULL DEFAULT 0
		) STRICT
	`);
	db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_work_kind_key ON durable_work(kind, idempotency_key)",
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_durable_work_claimable ON durable_work(target_site_id, claim_state, created_at) WHERE claim_state = 'pending'`,
	);
	db.run(`
		CREATE TABLE hosts (
			site_id TEXT PRIMARY KEY,
			host_name TEXT NOT NULL,
			version TEXT NOT NULL,
			sync_url TEXT,
			mcp_servers TEXT,
			mcp_tools TEXT,
			models TEXT,
			online_at TEXT NOT NULL,
			modified_at TEXT NOT NULL,
			platforms TEXT,
			work_spool_capable INTEGER NOT NULL DEFAULT 0,
			deleted INTEGER NOT NULL DEFAULT 0
		)
	`);
}

const SYM_KEY = new Uint8Array(32).fill(7);

describe("WsTransport — oversize changelog frame splitting", () => {
	let db: Database;
	let transport: WsTransport;

	beforeEach(() => {
		db = new Database(":memory:");
		createMinimalSchema(db);
		transport = new WsTransport({ db, siteId: "hub", eventBus: new TypedEventEmitter() });
		transport.start();
	});

	afterEach(() => {
		transport.stop();
		db.close();
	});

	it("splits an oversize changelog batch into multiple CHANGELOG_PUSH frames, each decodable", async () => {
		const stub = registerStubPeer(transport, "peer-1", SYM_KEY);

		// Each entry carries a ~1.5 MiB row_data blob. Six entries batched into one
		// flush is ~9 MiB, well over the 4 MiB frame budget, so encodeChangelogFrames
		// must recurse and split. The coalescer batches all events written in the same
		// tick into a single flushChangelogEntries call — the live push path that feeds
		// encodeChangelogFrames.
		const blob = "x".repeat(1_500_000);
		const now = new Date().toISOString();
		const hlcs: string[] = [];
		const eventBus = (transport as unknown as { config: { eventBus: TypedEventEmitter } }).config
			.eventBus;
		for (let i = 0; i < 6; i++) {
			const hlc = `2026-03-22T10:00:0${i}.000Z_000${i}_remote`;
			hlcs.push(hlc);
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[hlc, "users", `u${i}`, "remote", now, JSON.stringify({ id: `u${i}`, blob })],
			);
			eventBus.emit("changelog:written", { hlc, tableName: "users", siteId: "remote" });
		}

		// Let the microtask coalescer flush the whole batch once.
		await new Promise((r) => setTimeout(r, 20));

		const pushFrames = stub.frames.filter((f) => {
			const d = decodeFrame(f, SYM_KEY);
			return d.ok && d.value.type === WsMessageType.CHANGELOG_PUSH;
		});
		expect(pushFrames.length).toBeGreaterThan(1);

		// Every split frame decodes and the union of their entries covers all 6 rows.
		const seen = new Set<string>();
		for (const f of pushFrames) {
			const d = decodeFrame(f, SYM_KEY);
			expect(d.ok).toBe(true);
			if (!d.ok) continue;
			const payload = d.value.payload as { entries: Array<{ hlc: string }> };
			for (const e of payload.entries) seen.add(e.hlc);
		}
		for (const hlc of hlcs) expect(seen.has(hlc)).toBe(true);
	});

	it("keeps a single oversize entry in one frame rather than splitting below one row", () => {
		const stub = registerStubPeer(transport, "peer-1", SYM_KEY);
		const blob = "y".repeat(5_000_000); // one entry already exceeds 4 MiB
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				"2026-03-22T11:00:00.000Z_0001_remote",
				"users",
				"big",
				"remote",
				now,
				JSON.stringify({ id: "big", blob }),
			],
		);

		transport.drainChangelog("peer-1");

		const pushFrames = stub.frames.filter((f) => {
			const d = decodeFrame(f, SYM_KEY);
			return d.ok && d.value.type === WsMessageType.CHANGELOG_PUSH;
		});
		// A lone entry cannot be split further — exactly one frame, even oversize.
		expect(pushFrames.length).toBe(1);
	});
});

describe("WsTransport — snapshot oversized-row skeleton + column-chunk protocol", () => {
	let db: Database;
	let transport: WsTransport;
	const peer = "spoke-ovr";

	beforeEach(() => {
		db = new Database(":memory:");
		createMinimalSchema(db);
		transport = new WsTransport({
			db,
			siteId: "hub",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});
	});

	afterEach(() => {
		clearColumnCache();
		transport.stop();
		db.close();
	});

	it("sends a skeleton row then binary-searched column chunks that reassemble to the original value", async () => {
		// A single user whose display_name is a >1 MiB TEXT column: larger than
		// MAX_SNAPSHOT_FRAME_BYTES/4, so sendOversizedRow fires, emits a skeleton
		// (oversized column blanked) and then column chunks carrying the real value.
		const bigName = "N".repeat(6_000_000);
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, 0)`,
			["ovr-1", bigName, now, now],
		);

		const stub = registerStubPeer(transport, peer, SYM_KEY);
		startSeed(transport, peer, "2026-06-01T00:00:00.000Z_0000_aaaa");
		(transport as unknown as SnapshotStateInjector).sendSnapshotChunks(peer);

		// Walk the full SNAPSHOT_TABLE_ORDER and settle (yields 100ms per sub-chunk).
		const sawEnd = (): boolean =>
			stub.frames.some((f) => {
				const d = decodeFrame(f, SYM_KEY);
				return d.ok && d.value.type === WsMessageType.SNAPSHOT_END;
			});
		for (let i = 0; i < 80 && !sawEnd(); i++) {
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(sawEnd()).toBe(true);

		const chunks = decodeChunks(stub, SYM_KEY);
		const userChunks = chunks.filter((c) => c.table_name === "users");

		// Skeleton frame: a row whose display_name was blanked out.
		const skeleton = userChunks.find((c) => c.rows.length > 0 && c.rows[0].id === "ovr-1");
		expect(skeleton).toBeDefined();
		expect(skeleton?.rows[0].display_name).toBe("");

		// Column chunks for display_name reassemble to the full original value.
		const colChunks = userChunks
			.filter((c) => c.col_chunk_row_id === "ovr-1" && c.col_chunk_column === "display_name")
			.sort((a, b) => (a.col_chunk_index ?? 0) - (b.col_chunk_index ?? 0));
		expect(colChunks.length).toBeGreaterThan(1);
		const reassembled = colChunks.map((c) => c.col_chunk_data ?? "").join("");
		expect(reassembled).toBe(bigName);
		// The last column chunk marks final.
		expect(colChunks[colChunks.length - 1].col_chunk_final).toBe(true);
	});

	it("applySnapshotChunk and applyColumnChunk round-trip an oversized value into the spoke DB", () => {
		// Spoke-side application of the protocol the hub emits above: a blanked
		// skeleton row then column chunks rebuild the full value in place.
		const applied = transport.applySnapshotChunk("users", [
			{
				id: "rt-1",
				display_name: "",
				first_seen_at: "2026-06-01T00:00:00.000Z",
				modified_at: "2026-06-01T00:00:00.000Z",
				deleted: 0,
			},
		]);
		expect(applied).toBe(1);

		transport.applyColumnChunk("users", "rt-1", "display_name", 0, "hello ");
		transport.applyColumnChunk("users", "rt-1", "display_name", 1, "world");

		const row = db.query("SELECT display_name FROM users WHERE id = ?").get("rt-1") as {
			display_name: string;
		} | null;
		expect(row?.display_name).toBe("hello world");
	});

	it("returns false (pauses) when the oversized-row skeleton frame is backpressured", () => {
		// An oversized row whose very first frame (the skeleton) cannot send: the
		// peer backpressures immediately, so sendOversizedRow returns false at the
		// skeleton send without emitting any column chunks.
		const bigName = "N".repeat(6_000_000);
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
			["ovr-bp", bigName, now, now],
		);

		const stub = registerStubPeer(transport, peer, SYM_KEY);
		stub.backpressured = true; // every sendFrame returns false
		startSeed(transport, peer, "2026-06-01T00:00:00.000Z_0000_bbbb");
		(transport as unknown as SnapshotStateInjector).sendSnapshotChunks(peer);

		// Nothing got through, and the seed state is parked (draining) rather than
		// advancing past the oversized row.
		expect(stub.frames.length).toBe(0);
		const state = (transport as unknown as SnapshotStateInjector).snapshotStates.get(peer);
		expect(state?.draining).toBe(true);
	});

	it("pauses mid-oversized-row when a column chunk is backpressured after the skeleton", async () => {
		// Skeleton + first column chunk send, then the peer backpressures: the
		// column-chunk send-loop returns false mid-row (the 1798/1806 return paths).
		const bigName = "N".repeat(6_000_000);
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
			["ovr-mid", bigName, now, now],
		);

		// Backpressure after the first N frames so the skeleton (frame 0) and the
		// first column chunk (frame 1) land, then a later column chunk is refused.
		let allowed = 2;
		const frames: Uint8Array[] = [];
		transport.addPeer(
			peer,
			(frame: Uint8Array): boolean => {
				if (allowed <= 0) return false;
				allowed--;
				frames.push(frame);
				return true;
			},
			SYM_KEY,
			() => {},
			peer,
		);
		startSeed(transport, peer, "2026-06-01T00:00:00.000Z_0000_cccc");
		(transport as unknown as SnapshotStateInjector).sendSnapshotChunks(peer);
		// Let any scheduled sub-chunk timers settle.
		await new Promise((r) => setTimeout(r, 30));

		// The skeleton + one column chunk went out, then the loop paused on backpressure.
		expect(frames.length).toBe(2);
		const decoded = frames.map((f) => decodeFrame(f, SYM_KEY));
		expect(decoded.every((d) => d.ok)).toBe(true);
		const state = (transport as unknown as SnapshotStateInjector).snapshotStates.get(peer);
		expect(state?.draining).toBe(true);
	});
});

describe("WsTransport — reseed and snapshot teardown", () => {
	let db: Database;
	let hub: WsTransport;
	const peer = "spoke-re";

	beforeEach(() => {
		db = new Database(":memory:");
		createMinimalSchema(db);
		hub = new WsTransport({ db, siteId: "hub", eventBus: new TypedEventEmitter(), isHub: true });
	});

	afterEach(() => {
		hub.stop();
		db.close();
	});

	it("handleReseedRequest on the hub resets the peer cursor to HLC_ZERO", () => {
		registerStubPeer(hub, peer, SYM_KEY);
		db.run("INSERT INTO sync_state (peer_site_id, last_received, last_sent) VALUES (?, ?, ?)", [
			peer,
			"2026-01-01T00:00:00.000Z_0001_hub",
			"2026-01-01T00:00:00.000Z_0001_hub",
		]);

		hub.handleReseedRequest(peer, {});

		const row = db
			.query("SELECT last_received, last_sent FROM sync_state WHERE peer_site_id = ?")
			.get(peer) as { last_received: string; last_sent: string } | null;
		expect(row?.last_received).toBe(HLC_ZERO);
		expect(row?.last_sent).toBe(HLC_ZERO);
	});

	it("handleReseedRequest is a no-op on a spoke (isHub false)", () => {
		const spokeDb = new Database(":memory:");
		createMinimalSchema(spokeDb);
		const spoke = new WsTransport({
			db: spokeDb,
			siteId: "spoke",
			eventBus: new TypedEventEmitter(),
			isHub: false,
		});
		registerStubPeer(spoke, peer, SYM_KEY);
		spokeDb.run("INSERT INTO sync_state (peer_site_id, last_received) VALUES (?, ?)", [
			peer,
			"2026-01-01T00:00:00.000Z_0001_hub",
		]);

		spoke.handleReseedRequest(peer, {});

		const row = spokeDb
			.query("SELECT last_received FROM sync_state WHERE peer_site_id = ?")
			.get(peer) as { last_received: string } | null;
		// Unchanged — spokes never seed.
		expect(row?.last_received).toBe("2026-01-01T00:00:00.000Z_0001_hub");
		spoke.stop();
		spokeDb.close();
	});

	it("removePeer mid-seed clears the stalled HLC_ZERO cursor so pruning can resume", () => {
		registerStubPeer(hub, peer, SYM_KEY);
		db.run("INSERT INTO sync_state (peer_site_id, last_received) VALUES (?, ?)", [peer, HLC_ZERO]);
		startSeed(hub, peer, "2026-06-01T00:00:00.000Z_0000_aaaa");

		hub.removePeer(peer);

		const row = db.query("SELECT 1 FROM sync_state WHERE peer_site_id = ?").get(peer);
		expect(row).toBeNull();
		expect((hub as unknown as SnapshotStateInjector).snapshotStates.has(peer)).toBe(false);
	});
});

describe("WsTransport — spool transfer send / receive / ack", () => {
	let db: Database;
	let transport: WsTransport;
	const peer = "peer-spool";

	beforeEach(() => {
		db = new Database(":memory:");
		createMinimalSchema(db);
		// Advertise the peer as spool-capable so the next-hop gate passes.
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, version, online_at, modified_at, work_spool_capable, deleted)
			 VALUES (?, ?, '1.0', ?, ?, 1, 0)`,
			[peer, "node-peer", now, now],
		);
		transport = new WsTransport({ db, siteId: "hub", eventBus: new TypedEventEmitter() });
	});

	afterEach(() => {
		transport.stop();
		db.close();
	});

	it("handleSpoolTransfer inserts durable_work rows and sends an ack echoing the sender's tokens", () => {
		const stub = registerStubPeer(transport, peer, SYM_KEY);
		const payload: SpoolTransferPayload = {
			entries: [
				{
					id: "dw-1",
					target_site_id: "hub",
					source_site: peer,
					kind: "platform_request",
					payload: { hello: "world" },
					idempotency_key: "idem-1",
					ref_id: "ref-1",
					stream_id: null,
					expires_at: null,
					received_at: null,
					token: "tok-aaa",
				},
			],
		};

		transport.handleSpoolTransfer(peer, payload, true);

		// Row is durable locally.
		const row = db
			.query("SELECT id, kind, target_site_id FROM durable_work WHERE id = ?")
			.get("dw-1") as { id: string; kind: string; target_site_id: string } | null;
		expect(row?.id).toBe("dw-1");
		expect(row?.kind).toBe("platform_request");

		// An ack frame was sent back, echoing the id + token verbatim.
		const ackFrame = stub.frames.find((f) => {
			const d = decodeFrame(f, SYM_KEY);
			return d.ok && d.value.type === WsMessageType.SPOOL_TRANSFER_ACK;
		});
		expect(ackFrame).toBeDefined();
		if (ackFrame) {
			const d = decodeFrame(ackFrame, SYM_KEY);
			expect(d.ok).toBe(true);
			if (d.ok) {
				const ack = d.value.payload as SpoolTransferAckPayload;
				expect(ack.entries).toEqual([{ id: "dw-1", token: "tok-aaa" }]);
			}
		}
	});

	it("handleSpoolTransfer dedupes a redelivered row under the (kind, idempotency_key) fence and still acks", () => {
		const stub = registerStubPeer(transport, peer, SYM_KEY);
		const entry = {
			id: "dw-dup",
			target_site_id: "hub",
			source_site: peer,
			kind: "platform_request",
			payload: { n: 1 },
			idempotency_key: "idem-dup",
			ref_id: null,
			stream_id: null,
			expires_at: null,
			received_at: null,
			token: "tok-dup",
		};

		transport.handleSpoolTransfer(peer, { entries: [entry] }, true);
		stub.frames.length = 0;
		// Redeliver the identical batch — INSERT OR IGNORE dedupes but still acks.
		transport.handleSpoolTransfer(peer, { entries: [entry] }, true);

		const count = db
			.query("SELECT COUNT(*) AS c FROM durable_work WHERE kind = ? AND idempotency_key = ?")
			.get("platform_request", "idem-dup") as { c: number };
		expect(count.c).toBe(1);

		const ackFrame = stub.frames.find((f) => {
			const d = decodeFrame(f, SYM_KEY);
			return d.ok && d.value.type === WsMessageType.SPOOL_TRANSFER_ACK;
		});
		expect(ackFrame).toBeDefined();
	});

	it("handleSpoolTransfer on an empty batch sends no ack and inserts nothing", () => {
		const stub = registerStubPeer(transport, peer, SYM_KEY);
		transport.handleSpoolTransfer(peer, { entries: [] }, true);
		expect(stub.frames.length).toBe(0);
		const count = db.query("SELECT COUNT(*) AS c FROM durable_work").get() as { c: number };
		expect(count.c).toBe(0);
	});

	it("sendDurableWorkToPeer does not transfer when the next-hop peer does not advertise work_spool_capable", () => {
		// A second connected peer that is NOT spool-capable. On a spoke the next hop is
		// the first non-self connection; the capability gate (findHostWorkSpoolCapabilityById)
		// then refuses to transfer across it.
		const inj = transport as unknown as {
			peerConnections: Map<string, unknown>;
		};
		// Clear the spool-capable peer registered by beforeEach so the only connection
		// is the incapable one the next-hop resolver will pick.
		inj.peerConnections.clear();
		const stub = registerStubPeer(transport, "incapable-peer", SYM_KEY);
		// No work_spool_capable hosts row for incapable-peer.

		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, created_at)
			 VALUES (?, ?, 'platform_request', '{}', 'idem-x', 'pending', ?)`,
			["dw-x", "some-target", now],
		);

		transport.start();
		(transport as unknown as { config: { eventBus: TypedEventEmitter } }).config.eventBus.emit(
			"durable_work:written",
			{ id: "dw-x", target_site_id: "some-target" },
		);

		const spoolFrames = stub.frames.filter((f) => {
			const d = decodeFrame(f, SYM_KEY);
			return d.ok && d.value.type === WsMessageType.SPOOL_TRANSFER;
		});
		expect(spoolFrames.length).toBe(0);
		const row = db.query("SELECT claim_state FROM durable_work WHERE id = ?").get("dw-x") as {
			claim_state: string;
		} | null;
		expect(row?.claim_state).toBe("pending");
	});

	it("sendDurableWorkToPeer transfers a pending peer-targeted row across a spool-capable next hop", () => {
		const stub = registerStubPeer(transport, peer, SYM_KEY);
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, created_at)
			 VALUES (?, ?, 'platform_request', '{}', 'idem-ok', 'pending', ?)`,
			["dw-ok", peer, now],
		);

		transport.start();
		(transport as unknown as { config: { eventBus: TypedEventEmitter } }).config.eventBus.emit(
			"durable_work:written",
			{ id: "dw-ok", target_site_id: peer },
		);

		const spoolFrames = stub.frames.filter((f) => {
			const d = decodeFrame(f, SYM_KEY);
			return d.ok && d.value.type === WsMessageType.SPOOL_TRANSFER;
		});
		expect(spoolFrames.length).toBe(1);
		// The row flipped to transferring (sent successfully, token retained).
		const row = db.query("SELECT claim_state FROM durable_work WHERE id = ?").get("dw-ok") as {
			claim_state: string;
		} | null;
		expect(row?.claim_state).toBe("transferring");
	});
});

describe("WsTransport.handleChangelogPush — onApplied broadcast fan-out", () => {
	let db: Database;
	let transport: WsTransport;
	let bus: TypedEventEmitter;
	const peer = "peer-push";

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		db.run(
			"CREATE TABLE change_log (hlc TEXT PRIMARY KEY, table_name TEXT NOT NULL, row_id TEXT NOT NULL, site_id TEXT NOT NULL, timestamp TEXT NOT NULL, row_data TEXT NOT NULL)",
		);
		db.run(
			`CREATE TABLE sync_state (peer_site_id TEXT PRIMARY KEY, last_received TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000', last_sent TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000', last_confirmed TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000', sync_errors INTEGER DEFAULT 0, last_sync_at TEXT)`,
		);
		db.run(
			"CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, model_id TEXT, tool_name TEXT, exit_code INTEGER, metadata TEXT, created_at TEXT NOT NULL, modified_at TEXT, host_origin TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0) STRICT",
		);
		db.run(
			"CREATE TABLE connector_handles (id TEXT PRIMARY KEY, server_name TEXT NOT NULL, event_name TEXT NOT NULL, event_args TEXT NOT NULL, delivery_mode TEXT NOT NULL, cursor TEXT, task_id TEXT, created_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, modified_at TEXT NOT NULL) STRICT",
		);
		bus = new TypedEventEmitter();
		transport = new WsTransport({ db, siteId: "local-hub", eventBus: bus, isHub: true });
		registerStubPeer(transport, peer, SYM_KEY);
	});

	afterEach(() => {
		clearColumnCache();
		transport.stop();
		db.close();
	});

	it("emits message:broadcast when an applied messages row rehydrates from the DB", () => {
		const events: Array<{ thread_id: string }> = [];
		bus.on("message:broadcast", (e) => events.push(e as { thread_id: string }));

		const now = new Date().toISOString();
		transport.handleChangelogPush(peer, {
			entries: [
				{
					hlc: "2026-01-01T00:00:00.000Z_0001_0001",
					table_name: "messages",
					row_id: "m-1",
					site_id: peer,
					timestamp: now,
					row_data: {
						id: "m-1",
						thread_id: "t-1",
						role: "user",
						content: "hello from remote",
						created_at: now,
						host_origin: peer,
						deleted: 0,
					},
				},
			],
		});

		// The onApplied hook rehydrated the row and broadcast it with its thread id.
		expect(events).toHaveLength(1);
		expect(events[0].thread_id).toBe("t-1");
		// And the row actually landed in the local DB.
		const row = db.query("SELECT content FROM messages WHERE id = ?").get("m-1") as {
			content: string;
		} | null;
		expect(row?.content).toBe("hello from remote");
	});

	it("emits connector:handle_synced when a non-deleted connector_handles row applies", () => {
		const events: Array<{ handle_id: string; server_name: string }> = [];
		bus.on("connector:handle_synced", (e) =>
			events.push(e as { handle_id: string; server_name: string }),
		);

		const now = new Date().toISOString();
		transport.handleChangelogPush(peer, {
			entries: [
				{
					hlc: "2026-01-01T00:00:01.000Z_0001_0001",
					table_name: "connector_handles",
					row_id: "h-1",
					site_id: peer,
					timestamp: now,
					row_data: {
						id: "h-1",
						server_name: "discord",
						event_name: "message",
						event_args: "{}",
						delivery_mode: "push",
						created_at: now,
						modified_at: now,
						deleted: 0,
					},
				},
			],
		});

		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({ handle_id: "h-1", server_name: "discord" });
	});

	it("does NOT emit connector:handle_synced for a soft-deleted handle row", () => {
		const events: unknown[] = [];
		bus.on("connector:handle_synced", (e) => events.push(e));

		const now = new Date().toISOString();
		transport.handleChangelogPush(peer, {
			entries: [
				{
					hlc: "2026-01-01T00:00:02.000Z_0001_0001",
					table_name: "connector_handles",
					row_id: "h-2",
					site_id: peer,
					timestamp: now,
					row_data: {
						id: "h-2",
						server_name: "discord",
						event_name: "message",
						event_args: "{}",
						delivery_mode: "push",
						created_at: now,
						modified_at: now,
						deleted: 1,
					},
				},
			],
		});

		expect(events).toHaveLength(0);
	});

	it("returns early (no cursor write) on an empty entries batch", () => {
		transport.handleChangelogPush(peer, { entries: [] });
		const row = db
			.query("SELECT last_received FROM sync_state WHERE peer_site_id = ?")
			.get(peer) as {
			last_received: string;
		} | null;
		// No row created / no cursor advance from an empty push.
		expect(row).toBeNull();
	});
});
