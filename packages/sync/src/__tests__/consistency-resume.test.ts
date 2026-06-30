import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
import { WsMessageType, decodeFrame } from "../ws-frames.js";
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

/**
 * Tests for the resumable consistency exchange: when a WebSocket connection
 * drops mid-stream, the spoke saves its cursor so the next attempt resumes
 * from where it left off instead of restarting from table 0, offset 0.
 *
 * Without this, an unstable connection (194 drops/day observed on MSI) makes
 * the all-or-nothing exchange impossible to complete, permanently stranding
 * any rows that fell into the offline gap.
 */
describe("consistency exchange resume", () => {
	let hubDb: Database;
	let spokeDb: Database;
	let hub: WsTransport;
	let spoke: WsTransport;
	let eventBus: TypedEventEmitter;
	const key = new Uint8Array(32).fill(1);

	beforeEach(() => {
		hubDb = new Database(":memory:");
		createTestSchema(hubDb);
		insertMemory(hubDb, "mem-1", "key-1");
		insertMemory(hubDb, "mem-2", "key-2");
		insertTask(hubDb, "task-1");

		spokeDb = new Database(":memory:");
		createTestSchema(spokeDb);

		eventBus = new TypedEventEmitter();

		hub = new WsTransport({ db: hubDb, siteId: "hub", eventBus, isHub: true });
		spoke = new WsTransport({ db: spokeDb, siteId: "spoke", eventBus, isHub: false });
	});

	afterEach(() => {
		spoke.stop();
		hub.stop();
		spokeDb.close();
		hubDb.close();
	});

	it("first request has no resume cursor", () => {
		let capturedPayload: Record<string, unknown> | null = null;
		spoke.addPeer(
			"hub",
			(frame) => {
				const decoded = decodeFrame(frame, key);
				if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_REQUEST) {
					capturedPayload = decoded.value.payload as Record<string, unknown>;
				}
				return true;
			},
			key,
		);

		spoke.requestConsistency(["semantic_memory"]).catch(() => {});

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload?.resume_table_index).toBeUndefined();
		expect(capturedPayload?.resume_offset).toBeUndefined();
	});

	it("includes resume cursor after a partial exchange", () => {
		// Simulate state saved by a previous timeout after a partial exchange
		(spoke as unknown as { consistencyResumeState: unknown }).consistencyResumeState = {
			cursor: { tableIndex: 1, offset: 5000 },
			data: new Map(),
		};

		let capturedPayload: Record<string, unknown> | null = null;
		spoke.addPeer(
			"hub",
			(frame) => {
				const decoded = decodeFrame(frame, key);
				if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_REQUEST) {
					capturedPayload = decoded.value.payload as Record<string, unknown>;
				}
				return true;
			},
			key,
		);

		spoke.requestConsistency(["semantic_memory", "tasks"]).catch(() => {});

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload?.resume_table_index).toBe(1);
		expect(capturedPayload?.resume_offset).toBe(5000);
	});

	it("hub starts streaming from the resume position", () => {
		let firstResponse: Record<string, unknown> | null = null;
		hub.addPeer(
			"spoke",
			(frame) => {
				if (firstResponse) return true;
				const decoded = decodeFrame(frame, key);
				if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_RESPONSE) {
					firstResponse = decoded.value.payload as Record<string, unknown>;
				}
				return true;
			},
			key,
		);

		hub.handleConsistencyRequest("spoke", {
			tables: ["semantic_memory", "tasks"],
			request_id: "test-req",
			resume_table_index: 1,
			resume_offset: 0,
		});

		expect(firstResponse).not.toBeNull();
		// Should start at table index 1 (tasks), not 0 (semantic_memory)
		expect(firstResponse?.table_index).toBe(1);
		expect(firstResponse?.table).toBe("tasks");
	});

	it("tracks cursor through responses", () => {
		let capturedPayload: Record<string, unknown> | null = null;
		spoke.addPeer(
			"hub",
			(frame) => {
				const decoded = decodeFrame(frame, key);
				if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_REQUEST) {
					capturedPayload = decoded.value.payload as Record<string, unknown>;
				}
				return true;
			},
			key,
		);

		spoke.requestConsistency(["semantic_memory"]).catch(() => {});

		const reqId = capturedPayload?.request_id as string;

		// Feed a partial response with a next cursor
		spoke.handleConsistencyResponse({
			table: "semantic_memory",
			pks: ["mem-1"],
			entries: [{ pk: "mem-1", hash: "abc", modified_at: null }],
			count: 100,
			has_more: true,
			table_index: 0,
			table_count: 2,
			all_done: false,
			request_id: reqId,
			next_table_index: 0,
			next_offset: 5000,
		});

		const pending = (
			spoke as unknown as {
				pendingConsistencyRequests: Map<string, { cursor: { tableIndex: number; offset: number } }>;
			}
		).pendingConsistencyRequests.get(reqId);

		expect(pending).toBeDefined();
		expect(pending?.cursor.tableIndex).toBe(0);
		expect(pending?.cursor.offset).toBe(5000);
	});

	it("clears resume state on successful completion", async () => {
		let capturedPayload: Record<string, unknown> | null = null;
		spoke.addPeer(
			"hub",
			(frame) => {
				const decoded = decodeFrame(frame, key);
				if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_REQUEST) {
					capturedPayload = decoded.value.payload as Record<string, unknown>;
				}
				return true;
			},
			key,
		);

		// Pre-set resume state to verify it gets cleared on success
		(spoke as unknown as { consistencyResumeState: unknown }).consistencyResumeState = {
			cursor: { tableIndex: 1, offset: 5000 },
			data: new Map(),
		};

		const promise = spoke.requestConsistency(["semantic_memory"]);
		const reqId = capturedPayload?.request_id as string;

		// Feed an all_done response to complete the exchange
		spoke.handleConsistencyResponse({
			table: "semantic_memory",
			pks: ["mem-1", "mem-2"],
			entries: [
				{ pk: "mem-1", hash: "abc", modified_at: null },
				{ pk: "mem-2", hash: "def", modified_at: null },
			],
			count: 2,
			has_more: false,
			table_index: 0,
			table_count: 1,
			all_done: true,
			request_id: reqId,
		});

		await promise;

		expect(
			(spoke as unknown as { consistencyResumeState: unknown }).consistencyResumeState,
		).toBeNull();
	});
});
