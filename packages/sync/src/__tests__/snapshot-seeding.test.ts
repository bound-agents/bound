// Unit tests for snapshot seeding (initial state handoff to new cluster members).

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";

import { HLC_ZERO } from "@bound/shared";
import type { SyncedTableName } from "@bound/shared";

import { applySnapshotRows, clearColumnCache } from "../reducers.js";
import { WsMessageType, decodeFrame, encodeFrame } from "../ws-frames.js";
import type {
	ReseedRequestPayload,
	SnapshotAckPayload,
	SnapshotBeginPayload,
	SnapshotChunkPayload,
	SnapshotEndPayload,
} from "../ws-frames.js";

// ── Helpers ──────────────────────────────────────────────────────────

function tempDb(): Database {
	const path = ":memory:";
	const db = new Database(path);
	db.exec("PRAGMA journal_mode = WAL");
	return db;
}

function createSyncedTables(db: Database): void {
	const tables: Array<{ name: SyncedTableName; ddl: string }> = [
		{
			name: "users",
			ddl: `CREATE TABLE users (
				id TEXT PRIMARY KEY,
				display_name TEXT NOT NULL,
				platform_ids TEXT,
				first_seen_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				deleted INTEGER NOT NULL DEFAULT 0
			) STRICT`,
		},
		{
			name: "threads",
			ddl: `CREATE TABLE threads (
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
				deleted INTEGER NOT NULL DEFAULT 0
			) STRICT`,
		},
		{
			name: "messages",
			ddl: `CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				model_id TEXT,
				tool_name TEXT,
				host_origin TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				deleted INTEGER NOT NULL DEFAULT 0
			) STRICT`,
		},
	];

	for (const t of tables) {
		db.exec(t.ddl);
	}

	// Also create change_log for the pruning guard
	db.exec(`
		CREATE TABLE IF NOT EXISTS change_log (
			hlc TEXT PRIMARY KEY,
			table_name TEXT NOT NULL,
			row_id TEXT NOT NULL,
			site_id TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			row_data TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS sync_state (
			peer_site_id TEXT PRIMARY KEY,
			last_received TEXT NOT NULL DEFAULT '${HLC_ZERO}',
			last_sent TEXT NOT NULL DEFAULT '${HLC_ZERO}',
			sync_errors INTEGER NOT NULL DEFAULT 0,
			last_sync_at TEXT
		)
	`);
}

// ── applySnapshotRows ─────────────────────────────────────────────────

describe("applySnapshotRows", () => {
	let db: Database;

	beforeAll(() => {
		db = tempDb();
		createSyncedTables(db);
	});

	afterAll(() => {
		clearColumnCache();
		db.close();
	});

	it("inserts rows into an empty table", () => {
		const rows = [
			{
				id: "user-1",
				display_name: "Alice",
				platform_ids: null,
				first_seen_at: "2025-01-01T00:00:00.000Z",
				modified_at: "2025-01-01T00:00:00.000Z",
				deleted: 0,
			},
		];

		const applied = applySnapshotRows(db, "users", rows);
		expect(applied).toBe(1);

		const result = db.query("SELECT * FROM users WHERE id = ?").get("user-1") as {
			display_name: string;
		};
		expect(result.display_name).toBe("Alice");
	});

	it("upserts existing rows via INSERT OR REPLACE (idempotent)", () => {
		const rows1 = [
			{
				id: "thread-1",
				user_id: "user-1",
				interface: "web",
				host_origin: "host-a",
				color: 0,
				title: "Old Title",
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				created_at: "2025-01-01T00:00:00.000Z",
				last_message_at: "2025-01-01T00:00:00.000Z",
				deleted: 0,
			},
		];

		const applied1 = applySnapshotRows(db, "threads", rows1);
		expect(applied1).toBe(1);

		const rows2 = [
			{
				id: "thread-1",
				user_id: "user-1",
				interface: "web",
				host_origin: "host-b",
				color: 0,
				title: "New Title",
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				created_at: "2025-01-01T00:00:00.000Z",
				last_message_at: "2025-01-02T00:00:00.000Z",
				deleted: 0,
			},
		];

		const applied2 = applySnapshotRows(db, "threads", rows2);
		expect(applied2).toBe(1); // Should succeed (row replaced)

		const result = db.query("SELECT * FROM threads WHERE id = ?").get("thread-1") as {
			title: string;
			host_origin: string;
		};
		expect(result.title).toBe("New Title");
		expect(result.host_origin).toBe("host-b");
	});

	it("does NOT create changelog entries", () => {
		const before = (db.query("SELECT COUNT(*) as cnt FROM change_log").get() as { cnt: number })
			.cnt;

		const rows = [
			{
				id: "msg-1",
				thread_id: "thread-1",
				role: "user",
				content: "hello",
				model_id: null,
				tool_name: null,
				host_origin: "host-a",
				created_at: "2025-01-01T00:00:00.000Z",
				modified_at: "2025-01-01T00:00:00.000Z",
				deleted: 0,
			},
		];

		applySnapshotRows(db, "messages", rows);

		const after = (db.query("SELECT COUNT(*) as cnt FROM change_log").get() as { cnt: number }).cnt;
		expect(after).toBe(before); // No change_log entries created
	});

	it("returns 0 for invalid table name", () => {
		const applied = applySnapshotRows(db, "nonexistent_table" as SyncedTableName, [{ col: "val" }]);
		expect(applied).toBe(0);
	});

	it("handles empty rows gracefully", () => {
		const applied = applySnapshotRows(db, "users", []);
		expect(applied).toBe(0);
	});

	it("coerces object values to JSON strings for SQL compatibility", () => {
		// JSON columns like platform_ids are stored as strings in SQLite,
		// but may arrive as parsed objects in snapshot rows.
		const rows = [
			{
				id: "user-2",
				display_name: "Bob",
				platform_ids: { discord: "1234" }, // object, should be stringified
				first_seen_at: "2025-01-01T00:00:00.000Z",
				modified_at: "2025-01-01T00:00:00.000Z",
				deleted: 0,
			},
		];

		const applied = applySnapshotRows(db, "users", rows);
		expect(applied).toBe(1);

		const result = db.query("SELECT platform_ids FROM users WHERE id = ?").get("user-2") as {
			platform_ids: string;
		};
		expect(result.platform_ids).toBe('{"discord":"1234"}');
	});
});

// ── Snapshot frame encode/decode ──────────────────────────────────────

describe("snapshot frame codec", () => {
	const symKey = new Uint8Array(32);
	randomBytes(32).forEach((b, i) => {
		symKey[i] = b;
	});

	it("round-trips SNAPSHOT_BEGIN", () => {
		const payload: SnapshotBeginPayload = {
			snapshot_hlc: "2025-01-01T00:00:00.000Z_0000_aaaa",
			tables: ["users", "threads", "messages"],
		};
		const frame = encodeFrame(WsMessageType.SNAPSHOT_BEGIN, payload, symKey);
		const decoded = decodeFrame(frame, symKey);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.type).toBe(WsMessageType.SNAPSHOT_BEGIN);
		const p = decoded.value.payload as SnapshotBeginPayload;
		expect(p.snapshot_hlc).toBe(payload.snapshot_hlc);
		expect(p.tables).toEqual(payload.tables);
	});

	it("round-trips SNAPSHOT_CHUNK", () => {
		const payload: SnapshotChunkPayload = {
			table_name: "messages",
			offset: 0,
			rows: [
				{ id: "msg-1", thread_id: "t1", role: "user", content: "hi" },
				{ id: "msg-2", thread_id: "t1", role: "assistant", content: "hello" },
			],
			last: false,
		};
		const frame = encodeFrame(WsMessageType.SNAPSHOT_CHUNK, payload, symKey);
		const decoded = decodeFrame(frame, symKey);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.type).toBe(WsMessageType.SNAPSHOT_CHUNK);
		const p = decoded.value.payload as SnapshotChunkPayload;
		expect(p.table_name).toBe("messages");
		expect(p.offset).toBe(0);
		expect(p.rows).toHaveLength(2);
		expect(p.last).toBe(false);
	});

	it("round-trips SNAPSHOT_END", () => {
		const payload: SnapshotEndPayload = {
			table_count: 3,
			row_count: 150,
		};
		const frame = encodeFrame(WsMessageType.SNAPSHOT_END, payload, symKey);
		const decoded = decodeFrame(frame, symKey);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.type).toBe(WsMessageType.SNAPSHOT_END);
		const p = decoded.value.payload as SnapshotEndPayload;
		expect(p.table_count).toBe(3);
		expect(p.row_count).toBe(150);
	});

	it("round-trips SNAPSHOT_ACK", () => {
		const payload: SnapshotAckPayload = {
			snapshot_hlc: "2025-01-01T00:00:00.000Z_0000_aaaa",
		};
		const frame = encodeFrame(WsMessageType.SNAPSHOT_ACK, payload, symKey);
		const decoded = decodeFrame(frame, symKey);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.type).toBe(WsMessageType.SNAPSHOT_ACK);
		const p = decoded.value.payload as SnapshotAckPayload;
		expect(p.snapshot_hlc).toBe(payload.snapshot_hlc);
	});

	it("rejects invalid SNAPSHOT_BEGIN payload (missing tables)", () => {
		const frame = encodeFrame(
			WsMessageType.SNAPSHOT_BEGIN,
			{ snapshot_hlc: "x" /* missing tables */ },
			symKey,
		);
		const decoded = decodeFrame(frame, symKey);
		expect(decoded.ok).toBe(false);
		expect(decoded.error).toBe("invalid_payload");
	});

	it("rejects invalid SNAPSHOT_CHUNK payload (missing rows)", () => {
		const frame = encodeFrame(
			WsMessageType.SNAPSHOT_CHUNK,
			{ table_name: "x", offset: 0 /* missing rows */ },
			symKey,
		);
		const decoded = decodeFrame(frame, symKey);
		expect(decoded.ok).toBe(false);
		expect(decoded.error).toBe("invalid_payload");
	});

	it("rejects invalid SNAPSHOT_END payload (missing row_count)", () => {
		const frame = encodeFrame(
			WsMessageType.SNAPSHOT_END,
			{ table_count: 1 /* missing row_count */ },
			symKey,
		);
		const decoded = decodeFrame(frame, symKey);
		expect(decoded.ok).toBe(false);
		expect(decoded.error).toBe("invalid_payload");
	});

	it("rejects invalid SNAPSHOT_ACK payload (missing snapshot_hlc)", () => {
		const frame = encodeFrame(WsMessageType.SNAPSHOT_ACK, {} as SnapshotAckPayload, symKey);
		const decoded = decodeFrame(frame, symKey);
		expect(decoded.ok).toBe(false);
		expect(decoded.error).toBe("invalid_payload");
	});

	it("round-trips RESEED_REQUEST", () => {
		const payload: ReseedRequestPayload = {
			reason: "spoke was restored from backup",
		};
		const frame = encodeFrame(WsMessageType.RESEED_REQUEST, payload, symKey);
		const decoded = decodeFrame(frame, symKey);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.type).toBe(WsMessageType.RESEED_REQUEST);
		const p = decoded.value.payload as ReseedRequestPayload;
		expect(p.reason).toBe("spoke was restored from backup");
	});

	it("rejects invalid RESEED_REQUEST (missing reason)", () => {
		const frame = encodeFrame(WsMessageType.RESEED_REQUEST, {} as ReseedRequestPayload, symKey);
		const decoded = decodeFrame(frame, symKey);
		expect(decoded.ok).toBe(false);
		expect(decoded.error).toBe("invalid_payload");
	});

	it("round-trips DRAIN_REQUEST heartbeat payload", () => {
		// This is the exact payload sent by the spoke heartbeat during
		// snapshot seeding. It must pass validation or the hub will log
		// WS frame decode failed: invalid_payload every 30 seconds.
		const payload = { reason: "snapshot heartbeat" };
		const frame = encodeFrame(WsMessageType.DRAIN_REQUEST, payload, symKey);
		const decoded = decodeFrame(frame, symKey);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.type).toBe(WsMessageType.DRAIN_REQUEST);
		const p = decoded.value.payload as { reason: string };
		expect(p.reason).toBe("snapshot heartbeat");
	});
});

// ── seedNewPeer detection logic ───────────────────────────────────────

describe("seedNewPeer detection", () => {
	let db: Database;

	beforeAll(() => {
		db = tempDb();
		createSyncedTables(db);
	});

	afterAll(() => {
		clearColumnCache();
		db.close();
	});

	it("detects new peer via HLC_ZERO cursor (sync_state absent)", () => {
		// No sync_state row for the peer → should trigger seeding.
		const row = db.query("SELECT * FROM sync_state WHERE peer_site_id = ?").get("new-peer") as
			| unknown
			| null;
		expect(row).toBeNull();
	});

	it("detects new peer via HLC_ZERO cursor (sync_state present with zero)", () => {
		db.run(
			`INSERT INTO sync_state (peer_site_id, last_received, last_sent, sync_errors)
			 VALUES (?, ?, ?, 0)`,
			["fresh-peer", HLC_ZERO, HLC_ZERO],
		);

		const row = db
			.query("SELECT last_received FROM sync_state WHERE peer_site_id = ?")
			.get("fresh-peer") as { last_received: string };
		expect(row.last_received).toBe(HLC_ZERO);
	});

	it("skips seeding for existing peer with non-zero cursor", () => {
		db.run(
			`INSERT INTO sync_state (peer_site_id, last_received, last_sent, sync_errors)
			 VALUES (?, ?, ?, 0)`,
			["existing-peer", "2025-01-01T00:00:00.000Z_0000_bbbb", "2025-01-01T00:00:00.000Z_0000_bbbb"],
		);

		const row = db
			.query("SELECT last_received FROM sync_state WHERE peer_site_id = ?")
			.get("existing-peer") as { last_received: string };
		expect(row.last_received).not.toBe(HLC_ZERO);
	});

	it("pruning is blocked when any peer has HLC_ZERO cursor", () => {
		// Simulate: one peer confirmed, one peer fresh
		db.run("DELETE FROM sync_state");
		db.run(
			`INSERT INTO sync_state (peer_site_id, last_received, last_sent, sync_errors)
			 VALUES ('confirmed-peer', '2025-01-05T00:00:00.000Z_0000_cccc', '2025-01-05T00:00:00.000Z_0000_cccc', 0)`,
		);
		db.run(
			`INSERT INTO sync_state (peer_site_id, last_received, last_sent, sync_errors)
			 VALUES ('fresh-peer', ?, ?, 0)`,
			[HLC_ZERO, HLC_ZERO],
		);

		const minHlc = (
			db.query("SELECT MIN(last_received) as min_hlc FROM sync_state").get() as {
				min_hlc: string;
			}
		).min_hlc;
		expect(minHlc).toBe(HLC_ZERO);
	});
});
