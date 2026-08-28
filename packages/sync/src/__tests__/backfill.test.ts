import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
import { trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { setSyncTelemetry } from "../telemetry.js";
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

	db.run(`
		CREATE TABLE messages (
			id TEXT PRIMARY KEY,
			thread_id TEXT NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			model_id TEXT,
			tool_name TEXT,
			exit_code INTEGER,
			metadata TEXT,
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
		setSyncTelemetry();
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

	it("no-ops (does not throw) when a backfill is already in progress", async () => {
		const key = new Uint8Array(32).fill(1);
		transport.addPeer("hub", () => true, key);

		let resolveFirst: ((v: Map<string, { count: number; pks: string[] }>) => void) | null = null;
		transport.requestConsistency = () =>
			new Promise((resolve) => {
				resolveFirst = resolve;
			});

		const first = transport.runBackfill();
		// A concurrent backfill is normal on slow/unstable connections (#160). The
		// reentrancy guard must early-return a zero result, mirroring the cooldown
		// path, rather than throwing — otherwise callers log warn-level noise for an
		// expected condition.
		const second = await transport.runBackfill();
		expect(second).toEqual({ backfilled: 0, tables: 0, requested: 0, pulled: 0 });

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

	it("creates bounded backfill children with real parent IDs for a successful remote pull", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		provider.register({ contextManager: new AsyncLocalStorageContextManager() });
		setSyncTelemetry({
			handshakes: { add() {} },
			drains: { add() {} },
			drainedEntries: { add() {} },
			drainDuration: { record() {} },
			activeConnections: { add() {} },
			startSpan: (name, attributes, parentContext) =>
				trace.getTracer("bound.sync").startSpan(name, { attributes }, parentContext),
		});
		try {
			mockHubPks(new Map([["semantic_memory", { count: 1, pks: ["remote-1"] }]]));
			transport.requestRowPull = async () => 1;
			await transport.runBackfill({ trigger: "initial" });
			const spans = exporter.getFinishedSpans();
			const backfill = spans.find((span) => span.name === "sync.backfill");
			const consistency = spans.find((span) => span.name === "sync.consistency");
			const rowPull = spans.find((span) => span.name === "sync.row-pull");
			expect(backfill).toBeDefined();
			expect(consistency?.parentSpanId).toBe(backfill?.spanContext().spanId);
			expect(rowPull?.parentSpanId).toBe(backfill?.spanContext().spanId);
			expect(consistency?.attributes ?? {}).toMatchObject({
				"consistency.completion_reason": "send_failed",
				"consistency.received_table_count": 1,
				"consistency.received_page_count": 0,
				"consistency.response_frame_count": 0,
			});
			expect(rowPull?.attributes ?? {}).toMatchObject({
				"row_pull.requested_count": 1,
				"row_pull.applied_count": 1,
			});
		} finally {
			provider.shutdown();
			trace.disable();
		}
	});

	it("closes the consistency child with error status when it times out", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		provider.register({ contextManager: new AsyncLocalStorageContextManager() });
		setSyncTelemetry({
			handshakes: { add() {} },
			drains: { add() {} },
			drainedEntries: { add() {} },
			drainDuration: { record() {} },
			activeConnections: { add() {} },
			startSpan: (name, attributes, parentContext) =>
				trace.getTracer("bound.sync").startSpan(name, { attributes }, parentContext),
		});
		try {
			transport.requestConsistency = async () => {
				throw new Error("Consistency check timed out (5m)");
			};
			await expect(transport.runBackfill()).rejects.toThrow("timed out");
			const consistency = exporter
				.getFinishedSpans()
				.find((span) => span.name === "sync.consistency");
			expect(consistency?.status.code).toBe(2);
			expect(consistency?.events.some((event) => event.name === "exception")).toBe(true);
		} finally {
			provider.shutdown();
			trace.disable();
		}
	});

	it("records request, response, gap, completion, and resume diagnostics on consistency", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		provider.register({ contextManager: new AsyncLocalStorageContextManager() });
		setSyncTelemetry({
			handshakes: { add() {} },
			drains: { add() {} },
			drainedEntries: { add() {} },
			drainDuration: { record() {} },
			activeConnections: { add() {} },
			startSpan: (name, attributes, parentContext) =>
				trace.getTracer("bound.sync").startSpan(name, { attributes }, parentContext),
		});
		try {
			transport.requestConsistency = async (_tables, observer) => {
				observer?.requestSent?.({ resumeUsed: true, resumeTableIndex: 2, resumeOffset: 5000 });
				observer?.response?.({
					tableIndex: 2,
					nextOffset: 6000,
					rowCount: 1000,
					observedAt: performance.now() + 1_001,
				});
				observer?.response?.({
					tableIndex: 2,
					nextOffset: 7000,
					rowCount: 500,
					observedAt: performance.now() + 2_002,
				});
				observer?.complete?.("all_done", performance.now() + 2_004);
				return new Map([["semantic_memory", { count: 1, pks: ["remote-1"] }]]);
			};
			transport.requestRowPull = async () => 0;
			await transport.runBackfill();
			const consistency = exporter
				.getFinishedSpans()
				.find((span) => span.name === "sync.consistency");
			expect(consistency?.attributes).toMatchObject({
				"consistency.completion_reason": "all_done",
				"consistency.received_table_count": 1,
				"consistency.received_page_count": 2,
				"consistency.response_frame_count": 2,
				"consistency.resume_used": true,
				"consistency.resume_table_index": 2,
				"consistency.resume_offset": 5000,
				"consistency.last_table_index": 2,
				"consistency.last_offset": 7000,
			});
			expect(consistency?.events.map((event) => event.name)).toEqual([
				"sync.consistency.request_sent",
				"sync.consistency.first_response",
				"sync.consistency.response_gap",
				"sync.consistency.complete",
			]);
		} finally {
			provider.shutdown();
			trace.disable();
		}
	});

	it("records timeout diagnostics from the production timeout timer and authoritative resume cursor", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		provider.register({ contextManager: new AsyncLocalStorageContextManager() });
		setSyncTelemetry({
			handshakes: { add() {} },
			drains: { add() {} },
			drainedEntries: { add() {} },
			drainDuration: { record() {} },
			activeConnections: { add() {} },
			startSpan: (name, attributes, parentContext) =>
				trace.getTracer("bound.sync").startSpan(name, { attributes }, parentContext),
		});
		const key = new Uint8Array(32).fill(1);
		let requestId: string | undefined;
		transport.addPeer(
			"hub",
			(frame) => {
				const decoded = decodeFrame(frame, key);
				if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_REQUEST) {
					requestId = (decoded.value.payload as { request_id: string }).request_id;
				}
				return true;
			},
			key,
		);
		const originalSetTimeout = globalThis.setTimeout;
		let consistencyTimeout: (() => void) | undefined;
		globalThis.setTimeout = ((callback, delay, ...args) => {
			if (delay === 300_000) {
				consistencyTimeout = () => {
					if (typeof callback === "function") callback(...args);
				};
				return 0 as unknown as Timer;
			}
			return originalSetTimeout(callback, delay, ...args);
		}) as typeof setTimeout;
		try {
			const backfill = transport.runBackfill();
			expect(requestId).toBeDefined();
			transport.handleConsistencyResponse({
				table: "semantic_memory",
				pks: ["remote-1"],
				count: 1,
				has_more: true,
				table_index: 3,
				table_count: 5,
				request_id: requestId,
				next_table_index: 4,
				next_offset: 0,
			});
			expect(consistencyTimeout).toBeDefined();
			consistencyTimeout?.();
			await expect(backfill).rejects.toThrow("timed out");
			const consistency = exporter
				.getFinishedSpans()
				.find((span) => span.name === "sync.consistency");
			expect(consistency?.attributes).toMatchObject({
				"consistency.completion_reason": "timeout",
				"consistency.last_table_index": 4,
				"consistency.last_offset": 0,
			});
			expect(consistency?.status.code).toBe(2);
			expect(consistency?.events.some((event) => event.name === "exception")).toBe(true);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			provider.shutdown();
			trace.disable();
		}
	});

	it("does not create a row-pull child when consistency finds no remote-only rows", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		provider.register({ contextManager: new AsyncLocalStorageContextManager() });
		setSyncTelemetry({
			handshakes: { add() {} },
			drains: { add() {} },
			drainedEntries: { add() {} },
			drainDuration: { record() {} },
			activeConnections: { add() {} },
			startSpan: (name, attributes, parentContext) =>
				trace.getTracer("bound.sync").startSpan(name, { attributes }, parentContext),
		});
		try {
			mockHubPks(new Map());
			await transport.runBackfill();
			expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
				"sync.consistency",
				"sync.backfill",
			]);
		} finally {
			provider.shutdown();
			trace.disable();
		}
	});

	it("emits outer and bounded child backfill spans for a successful remote pull", async () => {
		const spans: Array<{ attributes: Record<string, string | number | boolean>; ends: number }> =
			[];
		setSyncTelemetry({
			handshakes: { add() {} },
			drains: { add() {} },
			drainedEntries: { add() {} },
			drainDuration: { record() {} },
			activeConnections: { add() {} },
			startSpan: (_name, attributes) => {
				const span = { attributes, ends: 0 };
				spans.push(span);
				return {
					addEvent() {},
					recordException() {},
					setAttribute: (name, value) => {
						span.attributes[name] = value;
					},
					setStatus() {},
					end: () => {
						span.ends++;
					},
				};
			},
		});
		mockHubPks(new Map([["semantic_memory", { count: 1, pks: ["remote-1"] }]]));
		transport.requestRowPull = async () => 0;
		await transport.runBackfill({ trigger: "initial" });
		expect(spans).toHaveLength(3);
		expect(spans[0].attributes).toMatchObject({
			"backfill.trigger": "initial",
			"backfill.outcome": "completed",
			"backfill.remote_pull_requested_count": 1,
			"backfill.remote_pull_applied_count": 0,
		});
		expect(spans[0].ends).toBe(1);
	});

	it("records a failed backfill and does not open spans for cooldown skips", async () => {
		const spans: Array<{ exceptions: Error[]; ends: number }> = [];
		setSyncTelemetry({
			handshakes: { add() {} },
			drains: { add() {} },
			drainedEntries: { add() {} },
			drainDuration: { record() {} },
			activeConnections: { add() {} },
			startSpan: () => {
				const span = { exceptions: [] as Error[], ends: 0 };
				spans.push(span);
				return {
					addEvent() {},
					recordException: (error) => span.exceptions.push(error),
					setStatus() {},
					end: () => {
						span.ends++;
					},
				};
			},
		});
		transport.requestConsistency = async () => {
			throw new Error("consistency failed");
		};
		await expect(transport.runBackfill({ trigger: "reconnect" })).rejects.toThrow(
			"consistency failed",
		);
		expect(spans).toHaveLength(2);
		expect(spans[0].exceptions[0]?.message).toBe("consistency failed");
		transport.requestConsistency = async () => new Map();
		await transport.runBackfill({ trigger: "periodic" });
		await transport.runBackfill({ trigger: "periodic" });
		expect(spans).toHaveLength(4);
	});
});
