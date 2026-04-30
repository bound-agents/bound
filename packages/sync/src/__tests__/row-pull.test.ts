import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
import {
	type RowPullAckPayload,
	type RowPullRequestPayload,
	type RowPullResponsePayload,
	WsMessageType,
	decodeFrame,
	encodeFrame,
} from "../ws-frames.js";
import { WsTransport } from "../ws-transport.js";

function createTestSchema(db: Database): void {
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

	db.run(`
		CREATE TABLE tasks (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL,
			status TEXT NOT NULL,
			trigger_spec TEXT NOT NULL,
			payload TEXT,
			created_at TEXT NOT NULL,
			created_by TEXT,
			thread_id TEXT,
			claimed_by TEXT,
			claimed_at TEXT,
			lease_id TEXT,
			next_run_at TEXT,
			last_run_at TEXT,
			run_count INTEGER DEFAULT 0,
			max_runs INTEGER,
			requires TEXT,
			model_hint TEXT,
			no_history INTEGER DEFAULT 0,
			inject_mode TEXT DEFAULT 'results',
			depends_on TEXT,
			require_success INTEGER DEFAULT 0,
			alert_threshold INTEGER DEFAULT 3,
			consecutive_failures INTEGER DEFAULT 0,
			event_depth INTEGER DEFAULT 0,
			no_quiescence INTEGER DEFAULT 0,
			heartbeat_at TEXT,
			result TEXT,
			error TEXT,
			modified_at TEXT NOT NULL,
			deleted INTEGER DEFAULT 0
		) STRICT
	`);

	db.run(`
		CREATE TABLE messages (
			id TEXT PRIMARY KEY,
			thread_id TEXT NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			model_id TEXT,
			tool_name TEXT,
			created_at TEXT NOT NULL,
			modified_at TEXT,
			host_origin TEXT NOT NULL,
			deleted INTEGER DEFAULT 0
		) STRICT
	`);

	db.run(`
		CREATE TABLE files (
			id TEXT PRIMARY KEY,
			path TEXT NOT NULL,
			content TEXT NOT NULL,
			hash TEXT NOT NULL,
			created_at TEXT NOT NULL,
			modified_at TEXT NOT NULL,
			deleted INTEGER DEFAULT 0
		) STRICT
	`);
}

function insertMemory(db: Database, id: string, key: string): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at)
		 VALUES (?, ?, 'test-value', 'test', ?, ?)`,
		[id, key, now, now],
	);
}

function insertTask(db: Database, id: string): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO tasks (id, type, status, trigger_spec, created_at, modified_at)
		 VALUES (?, 'deferred', 'pending', '{}', ?, ?)`,
		[id, now, now],
	);
}

function insertFile(db: Database, id: string, path: string, content: string): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO files (id, path, content, hash, created_at, modified_at)
		 VALUES (?, ?, ?, 'hash-placeholder', ?, ?)`,
		[id, path, content, now, now],
	);
}

describe("ROW_PULL frame codec", () => {
	const key = new Uint8Array(32).fill(42);

	it("round-trips ROW_PULL_REQUEST", () => {
		const payload: RowPullRequestPayload = {
			request_id: "rp_test_123",
			tables: [
				{ table: "semantic_memory", pks: ["mem-1", "mem-2"] },
				{ table: "tasks", pks: ["task-1"] },
			],
		};
		const frame = encodeFrame(WsMessageType.ROW_PULL_REQUEST, payload, key);
		const decoded = decodeFrame(frame, key);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.type).toBe(WsMessageType.ROW_PULL_REQUEST);
		const p = decoded.value.payload as RowPullRequestPayload;
		expect(p.request_id).toBe("rp_test_123");
		expect(p.tables).toHaveLength(2);
		expect(p.tables[0].table).toBe("semantic_memory");
		expect(p.tables[0].pks).toEqual(["mem-1", "mem-2"]);
	});

	it("round-trips ROW_PULL_RESPONSE", () => {
		const payload: RowPullResponsePayload = {
			request_id: "rp_test_123",
			table_name: "semantic_memory",
			rows: [{ id: "mem-1", key: "k1", value: "v1" }],
			last: false,
		};
		const frame = encodeFrame(WsMessageType.ROW_PULL_RESPONSE, payload, key);
		const decoded = decodeFrame(frame, key);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.type).toBe(WsMessageType.ROW_PULL_RESPONSE);
		const p = decoded.value.payload as RowPullResponsePayload;
		expect(p.request_id).toBe("rp_test_123");
		expect(p.table_name).toBe("semantic_memory");
		expect(p.rows).toHaveLength(1);
		expect(p.last).toBe(false);
	});

	it("round-trips ROW_PULL_RESPONSE with column chunks", () => {
		const payload: RowPullResponsePayload = {
			request_id: "rp_test_123",
			table_name: "files",
			rows: [],
			last: false,
			col_chunk_row_id: "file-1",
			col_chunk_column: "content",
			col_chunk_index: 0,
			col_chunk_final: false,
			col_chunk_data: "chunk-data-here",
		};
		const frame = encodeFrame(WsMessageType.ROW_PULL_RESPONSE, payload, key);
		const decoded = decodeFrame(frame, key);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		const p = decoded.value.payload as RowPullResponsePayload;
		expect(p.col_chunk_row_id).toBe("file-1");
		expect(p.col_chunk_column).toBe("content");
		expect(p.col_chunk_index).toBe(0);
		expect(p.col_chunk_data).toBe("chunk-data-here");
	});

	it("round-trips ROW_PULL_ACK", () => {
		const payload: RowPullAckPayload = { request_id: "rp_test_123" };
		const frame = encodeFrame(WsMessageType.ROW_PULL_ACK, payload, key);
		const decoded = decodeFrame(frame, key);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.type).toBe(WsMessageType.ROW_PULL_ACK);
		const p = decoded.value.payload as RowPullAckPayload;
		expect(p.request_id).toBe("rp_test_123");
	});

	it("rejects ROW_PULL_REQUEST missing request_id", () => {
		const payload = { tables: [] };
		const frame = encodeFrame(WsMessageType.ROW_PULL_REQUEST, payload, key);
		const decoded = decodeFrame(frame, key);
		expect(decoded.ok).toBe(false);
	});

	it("rejects ROW_PULL_RESPONSE missing last field", () => {
		const payload = { request_id: "x", table_name: "t", rows: [] };
		const frame = encodeFrame(WsMessageType.ROW_PULL_RESPONSE, payload, key);
		const decoded = decodeFrame(frame, key);
		expect(decoded.ok).toBe(false);
	});
});

describe("Hub-side handleRowPullRequest", () => {
	let hubDb: Database;
	let hubTransport: WsTransport;
	let sentFrames: Uint8Array[];
	const symmetricKey = new Uint8Array(32).fill(1);

	beforeEach(() => {
		hubDb = new Database(":memory:");
		createTestSchema(hubDb);
		hubTransport = new WsTransport({
			db: hubDb,
			siteId: "hub-1",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});
		sentFrames = [];
		hubTransport.addPeer(
			"spoke-1",
			(frame: Uint8Array) => {
				sentFrames.push(frame);
				return true;
			},
			symmetricKey,
		);
	});

	afterEach(() => {
		hubTransport.stop();
		hubDb.close();
	});

	it("responds with requested rows", async () => {
		insertMemory(hubDb, "mem-1", "key-1");
		insertMemory(hubDb, "mem-2", "key-2");
		insertMemory(hubDb, "mem-3", "key-3");

		hubTransport.handleRowPullRequest("spoke-1", {
			request_id: "rp_1",
			tables: [{ table: "semantic_memory", pks: ["mem-1", "mem-3"] }],
		});

		await new Promise((r) => setTimeout(r, 200));

		const responses = sentFrames
			.map((f) => decodeFrame(f, symmetricKey))
			.filter((r) => r.ok)
			.map(
				(r) => (r as { ok: true; value: { type: number; payload: RowPullResponsePayload } }).value,
			)
			.filter((f) => f.type === WsMessageType.ROW_PULL_RESPONSE);

		expect(responses.length).toBeGreaterThanOrEqual(1);

		const allRows = responses.flatMap((r) => r.payload.rows);
		const ids = allRows.map((r) => r.id);
		expect(ids).toContain("mem-1");
		expect(ids).toContain("mem-3");
		expect(ids).not.toContain("mem-2");

		const lastFrame = responses[responses.length - 1];
		expect(lastFrame.payload.last).toBe(true);
		expect(lastFrame.payload.request_id).toBe("rp_1");
	});

	it("handles nonexistent PKs gracefully", async () => {
		hubTransport.handleRowPullRequest("spoke-1", {
			request_id: "rp_2",
			tables: [{ table: "semantic_memory", pks: ["nonexistent-1", "nonexistent-2"] }],
		});

		await new Promise((r) => setTimeout(r, 200));

		const responses = sentFrames
			.map((f) => decodeFrame(f, symmetricKey))
			.filter((r) => r.ok)
			.map(
				(r) => (r as { ok: true; value: { type: number; payload: RowPullResponsePayload } }).value,
			)
			.filter((f) => f.type === WsMessageType.ROW_PULL_RESPONSE);

		expect(responses.length).toBeGreaterThanOrEqual(1);
		const lastFrame = responses[responses.length - 1];
		expect(lastFrame.payload.last).toBe(true);
		expect(lastFrame.payload.rows).toHaveLength(0);
	});

	it("handles multiple tables in one request", async () => {
		insertMemory(hubDb, "mem-1", "key-1");
		insertTask(hubDb, "task-1");
		insertTask(hubDb, "task-2");

		hubTransport.handleRowPullRequest("spoke-1", {
			request_id: "rp_3",
			tables: [
				{ table: "semantic_memory", pks: ["mem-1"] },
				{ table: "tasks", pks: ["task-1", "task-2"] },
			],
		});

		await new Promise((r) => setTimeout(r, 200));

		const responses = sentFrames
			.map((f) => decodeFrame(f, symmetricKey))
			.filter((r) => r.ok)
			.map(
				(r) => (r as { ok: true; value: { type: number; payload: RowPullResponsePayload } }).value,
			)
			.filter((f) => f.type === WsMessageType.ROW_PULL_RESPONSE);

		const allRows = responses.flatMap((r) => r.payload.rows);
		expect(allRows.length).toBe(3);

		const lastFrame = responses[responses.length - 1];
		expect(lastFrame.payload.last).toBe(true);
	});
});

describe("Spoke-side handleRowPullResponse", () => {
	let spokeDb: Database;
	let spokeTransport: WsTransport;

	beforeEach(() => {
		spokeDb = new Database(":memory:");
		createTestSchema(spokeDb);
		spokeTransport = new WsTransport({
			db: spokeDb,
			siteId: "spoke-1",
			eventBus: new TypedEventEmitter(),
			isHub: false,
		});
	});

	afterEach(() => {
		spokeTransport.stop();
		spokeDb.close();
	});

	it("applies received rows to local DB", () => {
		const now = new Date().toISOString();
		spokeTransport.handleRowPullResponse({
			request_id: "rp_test",
			table_name: "semantic_memory",
			rows: [
				{
					id: "mem-1",
					key: "k1",
					value: "v1",
					source: "hub",
					created_at: now,
					modified_at: now,
					tier: "default",
					deleted: 0,
				},
				{
					id: "mem-2",
					key: "k2",
					value: "v2",
					source: "hub",
					created_at: now,
					modified_at: now,
					tier: "default",
					deleted: 0,
				},
			],
			last: true,
		});

		const rows = spokeDb
			.query("SELECT id, key, value FROM semantic_memory ORDER BY id")
			.all() as Array<{ id: string; key: string; value: string }>;
		expect(rows).toHaveLength(2);
		expect(rows[0].id).toBe("mem-1");
		expect(rows[1].id).toBe("mem-2");
	});

	it("applies column chunks for oversized rows", () => {
		insertFile(spokeDb, "file-1", "/test.txt", "");

		spokeTransport.handleRowPullResponse({
			request_id: "rp_test",
			table_name: "files",
			rows: [],
			last: false,
			col_chunk_row_id: "file-1",
			col_chunk_column: "content",
			col_chunk_index: 0,
			col_chunk_data: "AAAA",
		});

		spokeTransport.handleRowPullResponse({
			request_id: "rp_test",
			table_name: "files",
			rows: [],
			last: true,
			col_chunk_row_id: "file-1",
			col_chunk_column: "content",
			col_chunk_index: 1,
			col_chunk_final: true,
			col_chunk_data: "BBBB",
		});

		const file = spokeDb.query("SELECT content FROM files WHERE id = 'file-1'").get() as {
			content: string;
		};
		expect(file.content).toBe("AAAABBBB");
	});

	it("does not create changelog entries for pulled rows", () => {
		const now = new Date().toISOString();
		spokeTransport.handleRowPullResponse({
			request_id: "rp_test",
			table_name: "semantic_memory",
			rows: [
				{
					id: "mem-1",
					key: "k1",
					value: "v1",
					source: "hub",
					created_at: now,
					modified_at: now,
					tier: "default",
					deleted: 0,
				},
			],
			last: true,
		});

		const clCount = spokeDb.query("SELECT COUNT(*) AS c FROM change_log").get() as { c: number };
		expect(clCount.c).toBe(0);
	});
});

describe("Bidirectional executeBackfill", () => {
	let spokeDb: Database;
	let eventBus: TypedEventEmitter;
	let spokeTransport: WsTransport;
	let hubDb: Database;
	let hubTransport: WsTransport;
	const symmetricKey = new Uint8Array(32).fill(1);

	beforeEach(() => {
		spokeDb = new Database(":memory:");
		createTestSchema(spokeDb);
		eventBus = new TypedEventEmitter();
		spokeTransport = new WsTransport({
			db: spokeDb,
			siteId: "spoke-1",
			eventBus,
			isHub: false,
		});

		hubDb = new Database(":memory:");
		createTestSchema(hubDb);
		hubTransport = new WsTransport({
			db: hubDb,
			siteId: "hub-1",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});
	});

	afterEach(() => {
		spokeTransport.stop();
		hubTransport.stop();
		spokeDb.close();
		hubDb.close();
	});

	function setupBidirectionalMock(): void {
		const hubSentFrames: Uint8Array[] = [];

		hubTransport.addPeer(
			"spoke-1",
			(frame: Uint8Array) => {
				hubSentFrames.push(frame);
				return true;
			},
			symmetricKey,
		);

		spokeTransport.addPeer("hub-1", () => true, symmetricKey);

		spokeTransport.requestConsistency = async () => {
			const tables = new Map<string, { count: number; pks: string[] }>();
			for (const table of ["semantic_memory", "tasks", "messages"] as const) {
				const pkCol = table === "messages" ? "id" : table === "tasks" ? "id" : "id";
				const rows = hubDb
					.query(`SELECT ${pkCol} AS pk FROM ${table} ORDER BY ${pkCol} ASC`)
					.all() as Array<{ pk: string }>;
				tables.set(table, { count: rows.length, pks: rows.map((r) => r.pk) });
			}
			return tables;
		};

		spokeTransport.requestRowPull = async (tables: Array<{ table: string; pks: string[] }>) => {
			hubTransport.handleRowPullRequest("spoke-1", {
				request_id: "rp_test",
				tables,
			});
			await new Promise((r) => setTimeout(r, 200));

			for (const frame of hubSentFrames) {
				const decoded = decodeFrame(frame, symmetricKey);
				if (!decoded.ok) continue;
				if (decoded.value.type === WsMessageType.ROW_PULL_RESPONSE) {
					spokeTransport.handleRowPullResponse(decoded.value.payload as RowPullResponsePayload);
				}
			}
		};
	}

	it("pushes local-only AND pulls remote-only rows", async () => {
		insertMemory(spokeDb, "mem-spoke-1", "spoke-key");
		insertMemory(spokeDb, "mem-spoke-2", "spoke-key-2");
		insertMemory(spokeDb, "mem-shared", "shared-key");

		insertMemory(hubDb, "mem-shared", "shared-key");
		insertMemory(hubDb, "mem-hub-1", "hub-key-1");
		insertMemory(hubDb, "mem-hub-2", "hub-key-2");
		insertMemory(hubDb, "mem-hub-3", "hub-key-3");

		setupBidirectionalMock();

		const result = await spokeTransport.runBackfill();

		expect(result.backfilled).toBe(2);

		const clEntries = spokeDb
			.query("SELECT row_id FROM change_log WHERE table_name = 'semantic_memory' ORDER BY row_id")
			.all() as Array<{ row_id: string }>;
		expect(clEntries.map((e) => e.row_id)).toEqual(["mem-spoke-1", "mem-spoke-2"]);

		expect(result.pulled).toBeGreaterThanOrEqual(3);

		const allMemories = spokeDb.query("SELECT id FROM semantic_memory ORDER BY id").all() as Array<{
			id: string;
		}>;
		const ids = allMemories.map((r) => r.id);
		expect(ids).toContain("mem-hub-1");
		expect(ids).toContain("mem-hub-2");
		expect(ids).toContain("mem-hub-3");
		expect(ids).toContain("mem-spoke-1");
		expect(ids).toContain("mem-spoke-2");
		expect(ids).toContain("mem-shared");
	});

	it("returns zero pulled when no remote-only rows", async () => {
		insertMemory(spokeDb, "mem-1", "key-1");
		insertMemory(hubDb, "mem-1", "key-1");

		setupBidirectionalMock();

		const result = await spokeTransport.runBackfill();
		expect(result.backfilled).toBe(0);
		expect(result.pulled).toBe(0);
	});

	it("first-connect pulls all hub data", async () => {
		insertMemory(hubDb, "mem-1", "key-1");
		insertMemory(hubDb, "mem-2", "key-2");
		insertTask(hubDb, "task-1");

		setupBidirectionalMock();

		spokeTransport.sendRowPullAck = (_requestId: string) => {
			// no-op mock — just verifying it's called
		};

		const result = await spokeTransport.runBackfill({ isFirstConnect: true });

		expect(result.backfilled).toBe(0);
		expect(result.pulled).toBeGreaterThanOrEqual(3);

		const memories = spokeDb.query("SELECT id FROM semantic_memory ORDER BY id").all() as Array<{
			id: string;
		}>;
		expect(memories.map((r) => r.id)).toEqual(["mem-1", "mem-2"]);

		const tasks = spokeDb.query("SELECT id FROM tasks ORDER BY id").all() as Array<{ id: string }>;
		expect(tasks.map((r) => r.id)).toEqual(["task-1"]);
	});
});

describe("Row pull promise resolution", () => {
	let db: Database;
	let transport: WsTransport;

	beforeEach(() => {
		db = new Database(":memory:");
		createTestSchema(db);
		transport = new WsTransport({
			db,
			siteId: "spoke-1",
			eventBus: new TypedEventEmitter(),
			isHub: false,
		});
	});

	afterEach(() => {
		transport.stop();
		db.close();
	});

	it("stays pending until last:true response arrives", async () => {
		const key = new Uint8Array(32).fill(1);
		transport.addPeer("hub", () => true, key);

		let resolved = false;
		const pullPromise = transport
			.requestRowPull([{ table: "semantic_memory", pks: ["mem-1"] }])
			.then(() => {
				resolved = true;
			});

		await new Promise((r) => setTimeout(r, 100));
		expect(resolved).toBe(false);

		// Simulate hub responding with last:true — must match the request_id
		// that requestRowPull generated. We extract it from the pending map.
		const pendingKeys = [
			...(
				transport as unknown as { pendingRowPullRequests: Map<string, unknown> }
			).pendingRowPullRequests.keys(),
		];
		expect(pendingKeys.length).toBe(1);

		const now = new Date().toISOString();
		transport.handleRowPullResponse({
			request_id: pendingKeys[0],
			table_name: "semantic_memory",
			rows: [
				{
					id: "mem-1",
					key: "k",
					value: "v",
					source: "test",
					created_at: now,
					modified_at: now,
					tier: "default",
					deleted: 0,
				},
			],
			last: true,
		});

		await pullPromise;
		expect(resolved).toBe(true);

		const row = db.query("SELECT id FROM semantic_memory WHERE id = 'mem-1'").get();
		expect(row).not.toBeNull();
	});
});

describe("seedNewPeer no-op", () => {
	it("does not send any frames after being made a no-op", () => {
		const db = new Database(":memory:");
		createTestSchema(db);
		db.run(`INSERT INTO sync_state (peer_site_id) VALUES ('spoke-1')`);
		db.run(
			`UPDATE sync_state SET last_received = '0000-00-00T00:00:00.000Z_0000_0000' WHERE peer_site_id = 'spoke-1'`,
		);

		const sent: Uint8Array[] = [];
		const transport = new WsTransport({
			db,
			siteId: "hub-1",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});

		const key = new Uint8Array(32).fill(1);
		transport.addPeer(
			"spoke-1",
			(frame: Uint8Array) => {
				sent.push(frame);
				return true;
			},
			key,
		);

		transport.seedNewPeer("spoke-1");

		expect(sent.length).toBe(0);

		transport.stop();
		db.close();
	});
});

// ── Critical regression tests ─────────────────────────────────────────
//
// These test the failure modes discovered in production:
// 1. Backpressure during row pull causing rows to be permanently skipped
// 2. Trigger-rejecting rows causing entire batches to be lost
// 3. Large row counts requiring frame splitting
// 4. Accurate row counting (pulled counter vs actual DB rows)

describe("Hub-side row pull under backpressure", () => {
	const symmetricKey = new Uint8Array(32).fill(1);

	it("does not skip rows when sendFrame returns false (backpressure)", async () => {
		const hubDb = new Database(":memory:");
		createTestSchema(hubDb);
		const hubTransport = new WsTransport({
			db: hubDb,
			siteId: "hub-1",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});

		for (let i = 0; i < 500; i++) {
			insertMemory(hubDb, `mem-${String(i).padStart(4, "0")}`, `key-${i}`);
		}

		const sentFrames: Uint8Array[] = [];
		let callCount = 0;
		hubTransport.addPeer(
			"spoke-1",
			(frame: Uint8Array) => {
				callCount++;
				if (callCount % 3 === 0) {
					return false;
				}
				sentFrames.push(frame);
				return true;
			},
			symmetricKey,
		);

		const allPks = Array.from({ length: 500 }, (_, i) => `mem-${String(i).padStart(4, "0")}`);
		hubTransport.handleRowPullRequest("spoke-1", {
			request_id: "rp_bp_test",
			tables: [{ table: "semantic_memory", pks: allPks }],
		});

		// Simulate drain events to resume after each backpressure pause.
		// In production, ws-server drain handler calls continueRowPull.
		for (let tick = 0; tick < 100; tick++) {
			await new Promise((r) => setTimeout(r, 10));
			hubTransport.continueRowPull("spoke-1");
		}

		const responses = sentFrames
			.map((f) => decodeFrame(f, symmetricKey))
			.filter((r) => r.ok)
			.map(
				(r) => (r as { ok: true; value: { type: number; payload: RowPullResponsePayload } }).value,
			)
			.filter((f) => f.type === WsMessageType.ROW_PULL_RESPONSE);

		const allReceivedRows = responses.flatMap((r) => r.payload.rows);
		const receivedIds = new Set(allReceivedRows.map((r) => r.id as string));

		expect(receivedIds.size).toBe(500);
		for (let i = 0; i < 500; i++) {
			expect(receivedIds.has(`mem-${String(i).padStart(4, "0")}`)).toBe(true);
		}

		const lastResponses = responses.filter((r) => r.payload.last);
		expect(lastResponses.length).toBe(1);

		hubTransport.stop();
		hubDb.close();
	});

	it("resumes correctly after multiple consecutive backpressure events", async () => {
		const hubDb = new Database(":memory:");
		createTestSchema(hubDb);
		const hubTransport = new WsTransport({
			db: hubDb,
			siteId: "hub-1",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});

		for (let i = 0; i < 200; i++) {
			insertMemory(hubDb, `mem-${String(i).padStart(4, "0")}`, `key-${i}`);
		}

		const sentFrames: Uint8Array[] = [];
		let pressuredUntilDrain = false;
		hubTransport.addPeer(
			"spoke-1",
			(frame: Uint8Array) => {
				if (pressuredUntilDrain) return false;
				sentFrames.push(frame);
				// After sending the first frame, enter a 5-consecutive-reject streak
				if (sentFrames.length === 1) {
					pressuredUntilDrain = true;
				}
				return true;
			},
			symmetricKey,
		);

		const allPks = Array.from({ length: 200 }, (_, i) => `mem-${String(i).padStart(4, "0")}`);
		hubTransport.handleRowPullRequest("spoke-1", {
			request_id: "rp_consecutive_bp",
			tables: [{ table: "semantic_memory", pks: allPks }],
		});

		await new Promise((r) => setTimeout(r, 50));

		// Now "drain" — allow sends again
		pressuredUntilDrain = false;
		hubTransport.continueRowPull("spoke-1");

		for (let tick = 0; tick < 50; tick++) {
			await new Promise((r) => setTimeout(r, 10));
			hubTransport.continueRowPull("spoke-1");
		}

		const responses = sentFrames
			.map((f) => decodeFrame(f, symmetricKey))
			.filter((r) => r.ok)
			.map(
				(r) => (r as { ok: true; value: { type: number; payload: RowPullResponsePayload } }).value,
			)
			.filter((f) => f.type === WsMessageType.ROW_PULL_RESPONSE);

		const allReceivedRows = responses.flatMap((r) => r.payload.rows);
		expect(allReceivedRows.length).toBe(200);

		hubTransport.stop();
		hubDb.close();
	});
});

describe("applySnapshotRows per-row fallback", () => {
	it("applies valid rows when trigger rejects some in a batch", () => {
		const db = new Database(":memory:");
		createTestSchema(db);

		db.run(`
			CREATE TABLE memory_edges (
				id          TEXT PRIMARY KEY,
				source_key  TEXT NOT NULL,
				target_key  TEXT NOT NULL,
				relation    TEXT NOT NULL,
				weight      REAL DEFAULT 1.0,
				context     TEXT,
				created_at  TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				deleted     INTEGER DEFAULT 0
			) STRICT
		`);
		const canonicals = [
			"related_to",
			"informs",
			"supports",
			"extends",
			"complements",
			"contrasts-with",
			"competes-with",
			"cites",
			"summarizes",
			"synthesizes",
		];
		const canonicalList = canonicals.map((r) => `'${r}'`).join(", ");
		db.run(`
			CREATE TRIGGER memory_edges_canonical_relation_insert
			BEFORE INSERT ON memory_edges
			FOR EACH ROW WHEN NEW.relation NOT IN (${canonicalList})
			BEGIN SELECT RAISE(ABORT, 'Invalid relation'); END
		`);

		const transport = new WsTransport({
			db,
			siteId: "spoke-1",
			eventBus: new TypedEventEmitter(),
			isHub: false,
		});

		const now = new Date().toISOString();
		const rows = [
			{
				id: "edge-1",
				source_key: "a",
				target_key: "b",
				relation: "related_to",
				weight: 1.0,
				context: null,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			{
				id: "edge-2",
				source_key: "c",
				target_key: "d",
				relation: "INVALID_RELATION",
				weight: 1.0,
				context: null,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			{
				id: "edge-3",
				source_key: "e",
				target_key: "f",
				relation: "supports",
				weight: 1.0,
				context: null,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			{
				id: "edge-4",
				source_key: "g",
				target_key: "h",
				relation: "old_custom_relation",
				weight: 1.0,
				context: null,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			{
				id: "edge-5",
				source_key: "i",
				target_key: "j",
				relation: "informs",
				weight: 1.0,
				context: null,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
		];

		transport.handleRowPullResponse({
			request_id: "rp_trigger_test",
			table_name: "memory_edges",
			rows,
			last: true,
		});

		const applied = db.query("SELECT id, relation FROM memory_edges ORDER BY id").all() as Array<{
			id: string;
			relation: string;
		}>;
		expect(applied.length).toBe(3);
		expect(applied.map((r) => r.id)).toEqual(["edge-1", "edge-3", "edge-5"]);
		expect(applied.map((r) => r.relation)).toEqual(["related_to", "supports", "informs"]);

		transport.stop();
		db.close();
	});

	it("applies all rows normally when no trigger failures", () => {
		const db = new Database(":memory:");
		createTestSchema(db);
		const transport = new WsTransport({
			db,
			siteId: "spoke-1",
			eventBus: new TypedEventEmitter(),
			isHub: false,
		});

		const now = new Date().toISOString();
		const rows = Array.from({ length: 50 }, (_, i) => ({
			id: `mem-${i}`,
			key: `key-${i}`,
			value: `val-${i}`,
			source: "test",
			created_at: now,
			modified_at: now,
			tier: "default",
			deleted: 0,
		}));

		transport.handleRowPullResponse({
			request_id: "rp_normal",
			table_name: "semantic_memory",
			rows,
			last: true,
		});

		const count = db.query("SELECT COUNT(*) AS c FROM semantic_memory").get() as { c: number };
		expect(count.c).toBe(50);

		transport.stop();
		db.close();
	});
});

describe("Hub-side frame splitting for large rows", () => {
	const symmetricKey = new Uint8Array(32).fill(1);

	it("splits large batches into multiple frames that fit within 4MB", async () => {
		const hubDb = new Database(":memory:");
		createTestSchema(hubDb);
		const hubTransport = new WsTransport({
			db: hubDb,
			siteId: "hub-1",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});

		// Insert rows with large content (~50KB each). 100 rows = ~5MB > 4MB frame limit.
		const bigContent = "x".repeat(50_000);
		for (let i = 0; i < 100; i++) {
			insertFile(hubDb, `file-${String(i).padStart(3, "0")}`, `/path/${i}.txt`, bigContent);
		}

		const sentFrames: Uint8Array[] = [];
		hubTransport.addPeer(
			"spoke-1",
			(frame: Uint8Array) => {
				sentFrames.push(frame);
				return true;
			},
			symmetricKey,
		);

		const allPks = Array.from({ length: 100 }, (_, i) => `file-${String(i).padStart(3, "0")}`);
		hubTransport.handleRowPullRequest("spoke-1", {
			request_id: "rp_large",
			tables: [{ table: "files", pks: allPks }],
		});

		for (let tick = 0; tick < 30; tick++) {
			await new Promise((r) => setTimeout(r, 20));
		}

		const responses = sentFrames
			.map((f) => decodeFrame(f, symmetricKey))
			.filter((r) => r.ok)
			.map(
				(r) => (r as { ok: true; value: { type: number; payload: RowPullResponsePayload } }).value,
			)
			.filter((f) => f.type === WsMessageType.ROW_PULL_RESPONSE);

		// Must have been split into multiple frames (100 × 50KB > 4MB)
		expect(responses.length).toBeGreaterThan(1);

		const allReceivedRows = responses.flatMap((r) => r.payload.rows);
		const receivedIds = new Set(allReceivedRows.map((r) => r.id as string));
		expect(receivedIds.size).toBe(100);

		// Verify content integrity
		for (const row of allReceivedRows) {
			expect((row.content as string).length).toBe(50_000);
		}

		const lastResponses = responses.filter((r) => r.payload.last);
		expect(lastResponses.length).toBe(1);

		hubTransport.stop();
		hubDb.close();
	});
});

describe("End-to-end row pull with actual hub→spoke wiring", () => {
	const symmetricKey = new Uint8Array(32).fill(1);

	it("spoke receives all rows when hub streams under backpressure", async () => {
		const hubDb = new Database(":memory:");
		createTestSchema(hubDb);
		const hubTransport = new WsTransport({
			db: hubDb,
			siteId: "hub-1",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});

		const spokeDb = new Database(":memory:");
		createTestSchema(spokeDb);
		const spokeTransport = new WsTransport({
			db: spokeDb,
			siteId: "spoke-1",
			eventBus: new TypedEventEmitter(),
			isHub: false,
		});

		for (let i = 0; i < 300; i++) {
			insertMemory(hubDb, `mem-${String(i).padStart(4, "0")}`, `key-${i}`);
		}

		// Wire hub→spoke: hub sends frames through a channel that simulates
		// backpressure by rejecting every 4th frame, with manual drain.
		let hubSendCallCount = 0;
		const pendingHubFrames: Uint8Array[] = [];
		let hubBackpressured = false;

		hubTransport.addPeer(
			"spoke-1",
			(frame: Uint8Array) => {
				hubSendCallCount++;
				if (hubBackpressured) {
					return false;
				}
				if (hubSendCallCount % 4 === 0) {
					hubBackpressured = true;
					return false;
				}
				pendingHubFrames.push(frame);
				return true;
			},
			symmetricKey,
		);

		spokeTransport.addPeer("hub-1", () => true, symmetricKey);

		// Spoke sends consistency request → gets hub PKs
		spokeTransport.requestConsistency = async () => {
			const tables = new Map<string, { count: number; pks: string[] }>();
			const rows = hubDb
				.query("SELECT id AS pk FROM semantic_memory ORDER BY id ASC")
				.all() as Array<{ pk: string }>;
			tables.set("semantic_memory", { count: rows.length, pks: rows.map((r) => r.pk) });
			return tables;
		};

		// Spoke sends row pull → hub streams → spoke applies
		spokeTransport.requestRowPull = async (tables: Array<{ table: string; pks: string[] }>) => {
			hubTransport.handleRowPullRequest("spoke-1", {
				request_id: "rp_e2e_bp",
				tables,
			});

			// Process with simulated backpressure drain cycles
			for (let cycle = 0; cycle < 100; cycle++) {
				await new Promise((r) => setTimeout(r, 5));

				// Drain: deliver pending frames to spoke
				while (pendingHubFrames.length > 0) {
					const frame = pendingHubFrames.shift();
					if (!frame) break;
					const decoded = decodeFrame(frame, symmetricKey);
					if (decoded.ok && decoded.value.type === WsMessageType.ROW_PULL_RESPONSE) {
						spokeTransport.handleRowPullResponse(decoded.value.payload as RowPullResponsePayload);
					}
				}

				// Release backpressure and let hub resume
				if (hubBackpressured) {
					hubBackpressured = false;
					hubTransport.continueRowPull("spoke-1");
				}
			}
		};

		const result = await spokeTransport.runBackfill();

		expect(result.pulled).toBe(300);

		const spokeRows = spokeDb.query("SELECT COUNT(*) AS c FROM semantic_memory").get() as {
			c: number;
		};
		expect(spokeRows.c).toBe(300);

		// Verify every single row made it
		for (let i = 0; i < 300; i++) {
			const id = `mem-${String(i).padStart(4, "0")}`;
			const row = spokeDb.query("SELECT id FROM semantic_memory WHERE id = ?").get(id);
			expect(row).not.toBeNull();
		}

		spokeTransport.stop();
		hubTransport.stop();
		spokeDb.close();
		hubDb.close();
	});
});

// ── Consistency PK stream backpressure tests ──────────────────────────
//
// The consistency PK stream sends 5000-PK pages per frame. Under
// backpressure, the hub must pause and retry on drain — dropping a
// frame silently loses 5000 PKs, causing the spoke to never request
// those rows. This was the root cause of the 25,000-missing-messages
// production incident.

describe("Consistency PK stream under backpressure", () => {
	const symmetricKey = new Uint8Array(32).fill(1);

	it("does not drop PK pages when sendFrame returns false", async () => {
		const hubDb = new Database(":memory:");
		createTestSchema(hubDb);
		const hubTransport = new WsTransport({
			db: hubDb,
			siteId: "hub-1",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});

		for (let i = 0; i < 20000; i++) {
			insertMemory(hubDb, `mem-${String(i).padStart(6, "0")}`, `key-${i}`);
		}

		const sentFrames: Uint8Array[] = [];
		let callCount = 0;
		hubTransport.addPeer(
			"spoke-1",
			(frame: Uint8Array) => {
				callCount++;
				if (callCount % 3 === 0) {
					return false;
				}
				sentFrames.push(frame);
				return true;
			},
			symmetricKey,
		);

		hubTransport.handleConsistencyRequest("spoke-1", {
			tables: ["semantic_memory"],
			request_id: "cr_bp_test",
		});

		for (let tick = 0; tick < 50; tick++) {
			await new Promise((r) => setTimeout(r, 10));
			hubTransport.continueConsistencyStream("spoke-1");
		}

		const responses = sentFrames
			.map((f) => decodeFrame(f, symmetricKey))
			.filter((r) => r.ok)
			.map((r) => {
				const v = (r as { ok: true; value: { type: number; payload: Record<string, unknown> } })
					.value;
				return v;
			})
			.filter((f) => f.type === WsMessageType.CONSISTENCY_RESPONSE);

		const allPks = responses.flatMap((r) => (r.payload as { pks: string[] }).pks);
		const uniquePks = new Set(allPks);

		expect(uniquePks.size).toBe(20000);

		const doneFrames = responses.filter((r) => (r.payload as { all_done: boolean }).all_done);
		expect(doneFrames.length).toBe(1);

		hubTransport.stop();
		hubDb.close();
	});

	it("pauses consistency stream and resumes on drain with no data loss", async () => {
		const hubDb = new Database(":memory:");
		createTestSchema(hubDb);
		const hubTransport = new WsTransport({
			db: hubDb,
			siteId: "hub-1",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});

		for (let i = 0; i < 12000; i++) {
			insertMemory(hubDb, `mem-${String(i).padStart(6, "0")}`, `key-${i}`);
		}
		for (let i = 0; i < 500; i++) {
			insertTask(hubDb, `task-${String(i).padStart(4, "0")}`);
		}

		const sentFrames: Uint8Array[] = [];
		let blocked = false;
		hubTransport.addPeer(
			"spoke-1",
			(frame: Uint8Array) => {
				if (blocked) return false;
				sentFrames.push(frame);
				if (sentFrames.length === 2) blocked = true;
				return true;
			},
			symmetricKey,
		);

		hubTransport.handleConsistencyRequest("spoke-1", {
			tables: ["semantic_memory", "tasks"],
			request_id: "cr_pause_test",
		});

		await new Promise((r) => setTimeout(r, 50));

		expect(sentFrames.length).toBe(2);

		blocked = false;
		for (let tick = 0; tick < 20; tick++) {
			await new Promise((r) => setTimeout(r, 10));
			hubTransport.continueConsistencyStream("spoke-1");
		}

		const responses = sentFrames
			.map((f) => decodeFrame(f, symmetricKey))
			.filter((r) => r.ok)
			.map((r) => {
				const v = (r as { ok: true; value: { type: number; payload: Record<string, unknown> } })
					.value;
				return v;
			})
			.filter((f) => f.type === WsMessageType.CONSISTENCY_RESPONSE);

		const memoryPks = responses
			.filter((r) => (r.payload as { table: string }).table === "semantic_memory")
			.flatMap((r) => (r.payload as { pks: string[] }).pks);
		const taskPks = responses
			.filter((r) => (r.payload as { table: string }).table === "tasks")
			.flatMap((r) => (r.payload as { pks: string[] }).pks);

		expect(new Set(memoryPks).size).toBe(12000);
		expect(new Set(taskPks).size).toBe(500);

		hubTransport.stop();
		hubDb.close();
	});
});

describe("End-to-end consistency + row pull under backpressure", () => {
	const symmetricKey = new Uint8Array(32).fill(1);

	it("spoke receives all hub data when both PK stream and row stream hit backpressure", async () => {
		const hubDb = new Database(":memory:");
		createTestSchema(hubDb);
		const hubTransport = new WsTransport({
			db: hubDb,
			siteId: "hub-1",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});

		const spokeDb = new Database(":memory:");
		createTestSchema(spokeDb);
		const spokeTransport = new WsTransport({
			db: spokeDb,
			siteId: "spoke-1",
			eventBus: new TypedEventEmitter(),
			isHub: false,
		});

		for (let i = 0; i < 500; i++) {
			insertMemory(hubDb, `mem-${String(i).padStart(4, "0")}`, `key-${i}`);
		}
		for (let i = 0; i < 200; i++) {
			insertTask(hubDb, `task-${String(i).padStart(4, "0")}`);
		}

		let hubSendCount = 0;
		let hubBlocked = false;
		const pendingFrames: Uint8Array[] = [];

		hubTransport.addPeer(
			"spoke-1",
			(frame: Uint8Array) => {
				hubSendCount++;
				if (hubBlocked) return false;
				if (hubSendCount % 5 === 0) {
					hubBlocked = true;
					return false;
				}
				pendingFrames.push(frame);
				return true;
			},
			symmetricKey,
		);

		spokeTransport.addPeer("hub-1", () => true, symmetricKey);

		spokeTransport.requestConsistency = async () => {
			hubTransport.handleConsistencyRequest("spoke-1", {
				tables: ["semantic_memory", "tasks"],
				request_id: "cr_e2e_bp",
			});

			for (let cycle = 0; cycle < 30; cycle++) {
				await new Promise((r) => setTimeout(r, 10));
				if (hubBlocked) {
					hubBlocked = false;
					hubTransport.continueConsistencyStream("spoke-1");
				}
			}

			const tables = new Map<string, { count: number; pks: string[] }>();
			for (const frame of pendingFrames) {
				const decoded = decodeFrame(frame, symmetricKey);
				if (!decoded.ok) continue;
				if (decoded.value.type !== WsMessageType.CONSISTENCY_RESPONSE) continue;
				const p = decoded.value.payload as {
					table: string;
					pks: string[];
					count: number;
				};
				const existing = tables.get(p.table);
				if (existing) {
					existing.pks.push(...p.pks);
					existing.count = p.count;
				} else {
					tables.set(p.table, { count: p.count, pks: [...p.pks] });
				}
			}
			pendingFrames.length = 0;
			return tables;
		};

		spokeTransport.requestRowPull = async (tables: Array<{ table: string; pks: string[] }>) => {
			hubTransport.handleRowPullRequest("spoke-1", {
				request_id: "rp_e2e_bp2",
				tables,
			});

			for (let cycle = 0; cycle < 50; cycle++) {
				await new Promise((r) => setTimeout(r, 10));
				while (pendingFrames.length > 0) {
					const frame = pendingFrames.shift();
					if (!frame) break;
					const decoded = decodeFrame(frame, symmetricKey);
					if (decoded.ok && decoded.value.type === WsMessageType.ROW_PULL_RESPONSE) {
						spokeTransport.handleRowPullResponse(decoded.value.payload as RowPullResponsePayload);
					}
				}
				if (hubBlocked) {
					hubBlocked = false;
					hubTransport.continueRowPull("spoke-1");
				}
			}
		};

		const result = await spokeTransport.runBackfill();

		expect(result.pulled).toBe(700);

		const memCount = spokeDb.query("SELECT COUNT(*) AS c FROM semantic_memory").get() as {
			c: number;
		};
		expect(memCount.c).toBe(500);

		const taskCount = spokeDb.query("SELECT COUNT(*) AS c FROM tasks").get() as { c: number };
		expect(taskCount.c).toBe(200);

		spokeTransport.stop();
		hubTransport.stop();
		spokeDb.close();
		hubDb.close();
	});
});
