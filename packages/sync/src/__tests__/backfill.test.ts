import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
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

function insertMessage(db: Database, id: string, threadId: string): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin)
		 VALUES (?, ?, 'user', 'test content', ?, ?, 'test-host')`,
		[id, threadId, now, now],
	);
}

describe("WsTransport.runBackfill", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let transport: WsTransport;

	beforeEach(() => {
		db = new Database(":memory:");
		createTestSchema(db);
		eventBus = new TypedEventEmitter();
		transport = new WsTransport({
			db,
			siteId: "spoke-1",
			eventBus,
			isHub: false,
		});
	});

	afterEach(() => {
		transport.stop();
		db.close();
	});

	function mockHubPks(remoteTables: Map<string, { count: number; pks: string[] }>): void {
		const key = new Uint8Array(32).fill(1);
		transport.addPeer("hub", () => true, key);

		transport.requestConsistency = async () => remoteTables;
	}

	it("returns empty result when no local-only rows exist", async () => {
		insertMemory(db, "mem-1", "shared-key");
		insertMemory(db, "mem-2", "another-key");

		const remoteTables = new Map<string, { count: number; pks: string[] }>();
		remoteTables.set("semantic_memory", { count: 2, pks: ["mem-1", "mem-2"] });
		mockHubPks(remoteTables);

		const result = await transport.runBackfill();
		expect(result.backfilled).toBe(0);
		expect(result.tables).toBe(0);
	});

	it("generates changelog entries for local-only rows", async () => {
		insertMemory(db, "mem-1", "shared-key");
		insertMemory(db, "mem-2", "local-only-1");
		insertMemory(db, "mem-3", "local-only-2");
		insertMemory(db, "mem-4", "local-only-3");

		const remoteTables = new Map<string, { count: number; pks: string[] }>();
		remoteTables.set("semantic_memory", { count: 1, pks: ["mem-1"] });
		mockHubPks(remoteTables);

		const result = await transport.runBackfill();
		expect(result.backfilled).toBe(3);
		expect(result.tables).toBe(1);

		const entries = db
			.query("SELECT table_name, row_id FROM change_log ORDER BY row_id")
			.all() as Array<{ table_name: string; row_id: string }>;
		expect(entries.length).toBe(3);
		expect(entries.map((e) => e.row_id)).toEqual(["mem-2", "mem-3", "mem-4"]);
		expect(entries.every((e) => e.table_name === "semantic_memory")).toBe(true);
	});

	it("handles multiple tables", async () => {
		insertMemory(db, "mem-1", "shared");
		insertMemory(db, "mem-2", "local-only");
		insertTask(db, "task-1");
		insertTask(db, "task-2");

		const remoteTables = new Map<string, { count: number; pks: string[] }>();
		remoteTables.set("semantic_memory", { count: 1, pks: ["mem-1"] });
		remoteTables.set("tasks", { count: 0, pks: [] });
		mockHubPks(remoteTables);

		const result = await transport.runBackfill();
		expect(result.backfilled).toBe(3);
		expect(result.tables).toBe(2);

		const memEntries = db
			.query("SELECT row_id FROM change_log WHERE table_name = 'semantic_memory'")
			.all() as Array<{ row_id: string }>;
		expect(memEntries.length).toBe(1);

		const taskEntries = db
			.query("SELECT row_id FROM change_log WHERE table_name = 'tasks'")
			.all() as Array<{ row_id: string }>;
		expect(taskEntries.length).toBe(2);
	});

	it("batches transactions for large row counts", async () => {
		for (let i = 0; i < 2500; i++) {
			insertMessage(db, `msg-${String(i).padStart(5, "0")}`, "thread-1");
		}

		const remoteTables = new Map<string, { count: number; pks: string[] }>();
		remoteTables.set("messages", { count: 0, pks: [] });
		mockHubPks(remoteTables);

		const result = await transport.runBackfill();
		expect(result.backfilled).toBe(2500);

		const entryCount = db
			.query("SELECT COUNT(*) AS c FROM change_log WHERE table_name = 'messages'")
			.get() as { c: number };
		expect(entryCount.c).toBe(2500);
	});

	it("emits changelog:written events after each batch", async () => {
		insertMemory(db, "mem-1", "local-only-1");
		insertMemory(db, "mem-2", "local-only-2");

		const remoteTables = new Map<string, { count: number; pks: string[] }>();
		remoteTables.set("semantic_memory", { count: 0, pks: [] });
		mockHubPks(remoteTables);

		const emitted: Array<{ hlc: string; tableName: string }> = [];
		eventBus.on("changelog:written", (evt: { hlc: string; tableName: string }) => {
			emitted.push({ hlc: evt.hlc, tableName: evt.tableName });
		});

		await transport.runBackfill();

		expect(emitted.length).toBe(2);
		expect(emitted.every((e) => e.tableName === "semantic_memory")).toBe(true);
		for (const e of emitted) {
			const entry = db.query("SELECT * FROM change_log WHERE hlc = ?").get(e.hlc);
			expect(entry).not.toBeNull();
		}
	});

	it("rejects when consistency check is already in progress", async () => {
		const key = new Uint8Array(32).fill(1);
		transport.addPeer("hub", () => true, key);

		let resolveFirst: ((v: Map<string, { count: number; pks: string[] }>) => void) | null = null;
		transport.requestConsistency = () =>
			new Promise((resolve) => {
				resolveFirst = resolve;
			});

		const first = transport.runBackfill();
		const second = transport.runBackfill();

		await expect(second).rejects.toThrow("already in progress");

		resolveFirst?.(new Map());
		await first;
	});

	it("handles append-only tables (messages)", async () => {
		insertMessage(db, "msg-1", "thread-1");
		insertMessage(db, "msg-2", "thread-1");

		const remoteTables = new Map<string, { count: number; pks: string[] }>();
		remoteTables.set("messages", { count: 0, pks: [] });
		mockHubPks(remoteTables);

		const result = await transport.runBackfill();
		expect(result.backfilled).toBe(2);

		const entries = db
			.query("SELECT row_data FROM change_log WHERE table_name = 'messages' ORDER BY row_id")
			.all() as Array<{ row_data: string }>;
		expect(entries.length).toBe(2);

		const parsed = JSON.parse(entries[0].row_data);
		expect(parsed.id).toBe("msg-1");
		expect(parsed.thread_id).toBe("thread-1");
		expect(parsed.role).toBe("user");
		expect(parsed.content).toBe("test content");
	});

	it("skips tables not in remote response", async () => {
		insertMemory(db, "mem-1", "only-local");
		insertTask(db, "task-1");

		const remoteTables = new Map<string, { count: number; pks: string[] }>();
		remoteTables.set("semantic_memory", { count: 0, pks: [] });
		mockHubPks(remoteTables);

		const result = await transport.runBackfill();
		expect(result.backfilled).toBe(1);
		expect(result.tables).toBe(1);

		const taskEntries = db
			.query("SELECT COUNT(*) AS c FROM change_log WHERE table_name = 'tasks'")
			.get() as { c: number };
		expect(taskEntries.c).toBe(0);
	});
});
