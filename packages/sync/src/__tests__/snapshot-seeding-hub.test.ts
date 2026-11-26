// Hub-side snapshot seeding tests: drive the chunk-sending state machine,
// reseed/ack handlers, and clearSyncedTables directly against a WsTransport
// with a stubbed peer connection. These cover the seeding paths that the
// full-cluster harness only exercises end-to-end (and under-reports because
// the snapshot path is now consistency-pull-first on connect).

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { CONSISTENCY_TABLES } from "@bound/core";
import { HLC_ZERO, TypedEventEmitter } from "@bound/shared";

import { clearColumnCache } from "../reducers.js";
import { WsMessageType, decodeFrame } from "../ws-frames.js";
import type { SnapshotAckPayload, SnapshotChunkPayload } from "../ws-frames.js";
import { WsTransport } from "../ws-transport.js";

// Minimal schema with the first few SNAPSHOT_TABLE_ORDER tables plus the
// sync_state / change_log bookkeeping the seeding code reads.
function createSeedSchema(db: Database): void {
	db.run("PRAGMA journal_mode = WAL");
	db.exec(`
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			display_name TEXT NOT NULL,
			platform_ids TEXT,
			first_seen_at TEXT NOT NULL,
			modified_at TEXT NOT NULL,
			deleted INTEGER NOT NULL DEFAULT 0
		) STRICT;
		CREATE TABLE threads (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			interface TEXT NOT NULL DEFAULT 'web',
			host_origin TEXT NOT NULL DEFAULT '',
			color INTEGER NOT NULL DEFAULT 0,
			title TEXT,
			summary TEXT,
			summary_through TEXT,
			summary_model_id TEXT,
			extracted_through TEXT,
			created_at TEXT NOT NULL,
			last_message_at TEXT NOT NULL,
			modified_at TEXT NOT NULL DEFAULT '',
			deleted INTEGER NOT NULL DEFAULT 0
		) STRICT;
		CREATE TABLE change_log (
			hlc TEXT PRIMARY KEY,
			table_name TEXT NOT NULL,
			row_id TEXT NOT NULL,
			site_id TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			row_data TEXT NOT NULL
		);
		CREATE TABLE sync_state (
			peer_site_id TEXT PRIMARY KEY,
			last_received TEXT NOT NULL DEFAULT '${HLC_ZERO}',
			last_sent TEXT NOT NULL DEFAULT '${HLC_ZERO}',
			last_confirmed TEXT NOT NULL DEFAULT '${HLC_ZERO}',
			sync_errors INTEGER NOT NULL DEFAULT 0,
			last_sync_at TEXT
		);
	`);
}

function insertUser(db: Database, id: string, name: string): void {
	db.run(
		`INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted)
		 VALUES (?, ?, NULL, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', 0)`,
		[id, name],
	);
}

// A stubbed peer: records every frame handed to its sendFrame closure, and can
// be flipped to simulate WebSocket backpressure (send returns false).
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
		(frame) => {
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

// Snapshot state shape matching the transport's private SnapshotState. Seeding
// it directly through a typed cast is the test seam for the chunk state machine
// (nothing public creates a state now that connect is consistency-pull-first).
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
		}
	>;
	sendSnapshotChunks(peerSiteId: string): void;
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

describe("hub snapshot seeding — chunk sending", () => {
	let db: Database;
	let transport: WsTransport;
	const symKey = new Uint8Array(32).fill(7);
	const peer = "spoke-aaaa";

	beforeEach(() => {
		db = new Database(":memory:");
		createSeedSchema(db);
		transport = new WsTransport({
			db,
			siteId: "hub-site",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});
	});

	afterEach(() => {
		clearColumnCache();
		db.close();
	});

	it("sends a SNAPSHOT_CHUNK for each seeded row then a terminating SNAPSHOT_END", async () => {
		insertUser(db, "u1", "Alice");
		insertUser(db, "u2", "Bob");
		const stub = registerStubPeer(transport, peer, symKey);

		startSeed(transport, peer, "2025-06-01T00:00:00.000Z_0000_aaaa");
		(transport as unknown as SnapshotStateInjector).sendSnapshotChunks(peer);

		// Chunk sending yields to the event loop between sub-chunks (setTimeout
		// 100ms), so wait for the whole table walk + SNAPSHOT_END to settle.
		await new Promise((r) => setTimeout(r, 400));

		const chunks = decodeChunks(stub, symKey);
		const userChunks = chunks.filter((c) => c.table_name === "users" && c.rows.length > 0);
		const seededIds = userChunks.flatMap((c) => c.rows.map((row) => row.id));
		expect(seededIds).toContain("u1");
		expect(seededIds).toContain("u2");

		// A ping fires each cycle to reset the hub's WS idle timer.
		expect(stub.pings).toBeGreaterThan(0);

		// Last frame must be SNAPSHOT_END with a non-zero row count.
		const last = stub.frames[stub.frames.length - 1];
		const decoded = decodeFrame(last, symKey);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.type).toBe(WsMessageType.SNAPSHOT_END);
		const end = decoded.value.payload as { table_count: number; row_count: number };
		expect(end.row_count).toBe(2);
	});

	it("halts on backpressure and resumes from the same cursor via continueSnapshotSeed", async () => {
		for (let i = 0; i < 5; i++) insertUser(db, `u${i}`, `User ${i}`);
		const stub = registerStubPeer(transport, peer, symKey);
		stub.backpressured = true;

		startSeed(transport, peer, "2025-06-01T00:00:00.000Z_0000_aaaa");
		(transport as unknown as SnapshotStateInjector).sendSnapshotChunks(peer);
		await new Promise((r) => setTimeout(r, 50));

		// Backpressured: nothing sent, state still present and marked draining.
		expect(stub.frames.length).toBe(0);
		const inj = transport as unknown as SnapshotStateInjector;
		expect(inj.snapshotStates.has(peer)).toBe(true);
		expect(inj.snapshotStates.get(peer)?.draining).toBe(true);

		// Buffer drains → resume. All rows now flow and the seed walks to SNAPSHOT_END.
		stub.backpressured = false;
		transport.continueSnapshotSeed(peer);

		// The resumed seed walks every SNAPSHOT_TABLE_ORDER table, yielding to the
		// event loop (setTimeout 100ms) after each sub-chunk; poll until SNAPSHOT_END
		// is emitted rather than guessing a fixed window.
		const sawEnd = (): boolean =>
			stub.frames.some((f) => {
				const d = decodeFrame(f, symKey);
				return d.ok && d.value.type === WsMessageType.SNAPSHOT_END;
			});
		for (let i = 0; i < 60 && !sawEnd(); i++) {
			await new Promise((r) => setTimeout(r, 100));
		}

		const chunks = decodeChunks(stub, symKey);
		const seededIds = new Set(
			chunks.filter((c) => c.table_name === "users").flatMap((c) => c.rows.map((row) => row.id)),
		);
		expect(seededIds.size).toBe(5); // resumed from cursor, no rows lost or duplicated
		expect(sawEnd()).toBe(true);
		// The hub keeps the snapshot state until the spoke sends SNAPSHOT_ACK — it is
		// NOT cleared by SNAPSHOT_END. Confirm handleSnapshotAck is what tears it down.
		expect(inj.snapshotStates.has(peer)).toBe(true);
		transport.handleSnapshotAck(peer, { snapshot_hlc: "2025-06-01T00:00:00.000Z_0000_aaaa" });
		expect(inj.snapshotStates.has(peer)).toBe(false);
	});

	it("continueSnapshotSeed is a no-op when there is no draining state", () => {
		const stub = registerStubPeer(transport, peer, symKey);
		// No snapshot state registered at all.
		transport.continueSnapshotSeed(peer);
		expect(stub.frames.length).toBe(0);

		// State present but not draining → still a no-op.
		startSeed(transport, peer, "2025-06-01T00:00:00.000Z_0000_aaaa");
		transport.continueSnapshotSeed(peer);
		expect(stub.frames.length).toBe(0);
	});

	it("drops the snapshot state when the peer connection is gone", () => {
		startSeed(transport, peer, "2025-06-01T00:00:00.000Z_0000_aaaa");
		const inj = transport as unknown as SnapshotStateInjector;
		// No peer registered → sendSnapshotChunks must delete the orphaned state.
		inj.sendSnapshotChunks(peer);
		expect(inj.snapshotStates.has(peer)).toBe(false);
	});
});

describe("hub snapshot seeding — reseed and ack handlers", () => {
	let db: Database;
	let transport: WsTransport;
	const peer = "spoke-bbbb";

	beforeEach(() => {
		db = new Database(":memory:");
		createSeedSchema(db);
		transport = new WsTransport({
			db,
			siteId: "hub-site",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});
	});

	afterEach(() => {
		clearColumnCache();
		db.close();
	});

	it("handleReseedRequest resets the peer cursor to HLC_ZERO and tracks the peer", () => {
		// Pre-existing non-zero cursor.
		db.run(
			`INSERT INTO sync_state (peer_site_id, last_received, last_sent)
			 VALUES (?, '2025-01-01T00:00:00.000Z_0000_cccc', '2025-01-01T00:00:00.000Z_0000_cccc')`,
			[peer],
		);

		transport.handleReseedRequest(peer, { reason: "restored from backup" });

		const row = db
			.query("SELECT last_received, last_sent FROM sync_state WHERE peer_site_id = ?")
			.get(peer) as { last_received: string; last_sent: string };
		expect(row.last_received).toBe(HLC_ZERO);
		expect(row.last_sent).toBe(HLC_ZERO);
	});

	it("handleReseedRequest is ignored when a snapshot is already active for the peer", () => {
		startSeed(transport, peer, "2025-06-01T00:00:00.000Z_0000_aaaa");
		db.run(
			`INSERT INTO sync_state (peer_site_id, last_received, last_sent)
			 VALUES (?, '2025-01-01T00:00:00.000Z_0000_cccc', '2025-01-01T00:00:00.000Z_0000_cccc')`,
			[peer],
		);

		transport.handleReseedRequest(peer, { reason: "duplicate" });

		// Cursor untouched because the duplicate request short-circuits.
		const row = db
			.query("SELECT last_received FROM sync_state WHERE peer_site_id = ?")
			.get(peer) as { last_received: string };
		expect(row.last_received).toBe("2025-01-01T00:00:00.000Z_0000_cccc");
	});

	it("handleReseedRequest is a no-op on a spoke (non-hub)", () => {
		const spokeTransport = new WsTransport({
			db,
			siteId: "spoke-site",
			eventBus: new TypedEventEmitter(),
			isHub: false,
		});
		spokeTransport.handleReseedRequest(peer, { reason: "spoke ignores" });
		const row = db.query("SELECT * FROM sync_state WHERE peer_site_id = ?").get(peer);
		expect(row).toBeNull();
	});

	it("handleSnapshotAck advances all three cursor watermarks to the snapshot HLC", () => {
		const snapshotHlc = "2025-06-01T00:00:00.000Z_0000_dddd";
		startSeed(transport, peer, snapshotHlc);

		const ack: SnapshotAckPayload = { snapshot_hlc: snapshotHlc };
		transport.handleSnapshotAck(peer, ack);

		const row = db
			.query(
				"SELECT last_received, last_sent, last_confirmed FROM sync_state WHERE peer_site_id = ?",
			)
			.get(peer) as { last_received: string; last_sent: string; last_confirmed: string };
		expect(row.last_received).toBe(snapshotHlc);
		expect(row.last_sent).toBe(snapshotHlc);
		expect(row.last_confirmed).toBe(snapshotHlc);

		// Snapshot state cleared after ack.
		const inj = transport as unknown as SnapshotStateInjector;
		expect(inj.snapshotStates.has(peer)).toBe(false);
	});

	it("handleSnapshotAck without a tracked state does not create a cursor row", () => {
		transport.handleSnapshotAck(peer, { snapshot_hlc: "2025-06-01T00:00:00.000Z_0000_eeee" });
		// snapshotHlc came from the (absent) state, so no cursor advance happened.
		const row = db.query("SELECT * FROM sync_state WHERE peer_site_id = ?").get(peer);
		expect(row).toBeNull();
	});
});

describe("clearSyncedTables", () => {
	let db: Database;
	let transport: WsTransport;

	// A reseed wipes only the consistency tables; a missing one throws, so the
	// happy path needs them all present. model_aliases stands in for every
	// synced table outside that set, which must survive the clear.
	const SYNCED_TABLES = [...CONSISTENCY_TABLES];
	const NON_CONSISTENCY_TABLE = "model_aliases";

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		// Minimal single-column tables are enough — clearSyncedTables issues a bare
		// `DELETE FROM <table>` and reads nothing about the schema.
		for (const t of SYNCED_TABLES) {
			db.exec(`CREATE TABLE ${t} (id TEXT PRIMARY KEY)`);
		}
		db.exec(`CREATE TABLE ${NON_CONSISTENCY_TABLE} (id TEXT PRIMARY KEY)`);
		transport = new WsTransport({
			db,
			siteId: "spoke-site",
			eventBus: new TypedEventEmitter(),
			isHub: false,
		});
	});

	afterEach(() => {
		clearColumnCache();
		db.close();
	});

	it("deletes rows from every consistency table and leaves other synced tables alone", () => {
		for (const t of SYNCED_TABLES) {
			db.run(`INSERT INTO ${t} (id) VALUES ('row-1'), ('row-2')`);
		}
		db.run(`INSERT INTO ${NON_CONSISTENCY_TABLE} (id) VALUES ('alias-1')`);
		expect((db.query("SELECT COUNT(*) c FROM users").get() as { c: number }).c).toBe(2);
		expect((db.query("SELECT COUNT(*) c FROM skills").get() as { c: number }).c).toBe(2);

		transport.clearSyncedTables();

		for (const t of SYNCED_TABLES) {
			expect((db.query(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c).toBe(0);
		}
		expect(
			(db.query(`SELECT COUNT(*) c FROM ${NON_CONSISTENCY_TABLE}`).get() as { c: number }).c,
		).toBe(1);
	});

	it("throws and rolls back the whole clear when a synced table is missing", () => {
		// Drop one table mid-list so the DELETE on it throws after earlier ones
		// already deleted — the ROLLBACK must restore those rows (atomicity).
		db.run("INSERT INTO users (id) VALUES ('keep-me')");
		db.exec("DROP TABLE threads");

		expect(() => transport.clearSyncedTables()).toThrow();

		// users was deleted before the throw but ROLLBACK restored it.
		expect((db.query("SELECT COUNT(*) c FROM users").get() as { c: number }).c).toBe(1);
	});
});
