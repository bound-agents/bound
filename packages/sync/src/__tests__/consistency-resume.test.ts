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

	db.run(`
		CREATE TABLE hosts (
			site_id TEXT PRIMARY KEY,
			host_name TEXT NOT NULL,
			modified_at TEXT NOT NULL,
			deleted INTEGER DEFAULT 0
		)
	`);

	db.run(`
		CREATE TABLE cluster_config (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			modified_at TEXT NOT NULL,
			deleted INTEGER DEFAULT 0
		)
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

function insertMessageRole(db: Database, id: string, role: string): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin)
		 VALUES (?, 'thread-1', ?, 'c', ?, ?, 'hub')`,
		[id, role, now, now],
	);
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

	it("advertiser excludes role='system' messages from pks and count (invariant #19; non-converging backfill regression)", () => {
		// The advertiser (hub) previously enumerated ALL message rows, while the
		// comparing side (spoke) filtered role='system'. The unsyncable rows then
		// looked perpetually remoteOnly, so every backfill cycle re-pulled the
		// same rows without converging — a hot full-table scan every ~10 min.
		insertMessageRole(hubDb, "m-user", "user");
		insertMessageRole(hubDb, "m-assistant", "assistant");
		insertMessageRole(hubDb, "m-system", "system");

		let response: Record<string, unknown> | null = null;
		hub.addPeer(
			"spoke",
			(frame) => {
				const decoded = decodeFrame(frame, key);
				if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_RESPONSE) {
					const p = decoded.value.payload as Record<string, unknown>;
					if (p.table === "messages") response = p;
				}
				return true;
			},
			key,
		);

		hub.handleConsistencyRequest("spoke", {
			tables: ["messages"],
			request_id: "test-req",
		});

		expect(response).not.toBeNull();
		const advertisedPks = response?.pks as string[];
		const advertisedEntries = response?.entries as Array<{ pk: string }>;
		// role='system' must NOT be advertised — only the two syncable rows.
		expect(advertisedPks.sort()).toEqual(["m-assistant", "m-user"]);
		expect(advertisedEntries.map((e) => e.pk).sort()).toEqual(["m-assistant", "m-user"]);
		// count must match the filtered set so pagination stays consistent.
		expect(response?.count).toBe(2);
	});

	it("uses a PK cursor after the first page while preserving offset resume ordering", async () => {
		const pageSizeTarget = WsTransport as unknown as { CONSISTENCY_PAGE_SIZE: number };
		const originalPageSize = pageSizeTarget.CONSISTENCY_PAGE_SIZE;
		pageSizeTarget.CONSISTENCY_PAGE_SIZE = 2;
		for (const id of ["d", "b", "e", "a", "c"]) insertMemory(hubDb, id, `key-${id}`);

		const queries: string[] = [];
		const originalQuery = hubDb.query.bind(hubDb);
		(hubDb as unknown as { query: (sql: string) => ReturnType<Database["query"]> }).query = (
			sql,
		) => {
			queries.push(sql);
			return originalQuery(sql);
		};
		const pages: Array<{ pks: string[]; next_offset?: number }> = [];
		try {
			hub.addPeer(
				"spoke",
				(frame) => {
					const decoded = decodeFrame(frame, key);
					if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_RESPONSE) {
						const payload = decoded.value.payload as { pks: string[]; next_offset?: number };
						pages.push(payload);
					}
					return true;
				},
				key,
			);
			hub.handleConsistencyRequest("spoke", { tables: ["semantic_memory"] });
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(pages.flatMap((page) => page.pks)).toEqual([
				"a",
				"b",
				"c",
				"d",
				"e",
				"mem-1",
				"mem-2",
			]);
			expect(queries.filter((sql) => sql.includes("SELECT id, modified_at"))).not.toContainEqual(
				expect.stringContaining("OFFSET"),
			);
			expect(queries.filter((sql) => sql.includes("SELECT COUNT(*) AS c"))).toHaveLength(1);

			pages.length = 0;
			queries.length = 0;
			hub.handleConsistencyRequest("spoke", {
				tables: ["semantic_memory"],
				resume_offset: 2,
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(pages.flatMap((page) => page.pks)).toEqual(["c", "d", "e", "mem-1", "mem-2"]);
			expect(queries.filter((sql) => sql.includes("SELECT id, modified_at"))).toContainEqual(
				expect.stringContaining("OFFSET"),
			);
		} finally {
			pageSizeTarget.CONSISTENCY_PAGE_SIZE = originalPageSize;
		}
	});

	it("composes filtered and non-id keyset pages without loss or duplication", async () => {
		const target = WsTransport as unknown as { CONSISTENCY_PAGE_SIZE: number };
		const original = target.CONSISTENCY_PAGE_SIZE;
		target.CONSISTENCY_PAGE_SIZE = 2;
		const now = new Date().toISOString();
		for (const [id, role] of [
			["m4", "user"],
			["m1", "assistant"],
			["m3", "system"],
			["m2", "user"],
			["m5", "assistant"],
			["m6", "system"],
			["m7", "user"],
		] as const)
			insertMessageRole(hubDb, id, role);
		for (const siteId of ["c", "a", "b", "d", "e"])
			hubDb.run("INSERT INTO hosts (site_id, host_name, modified_at) VALUES (?, ?, ?)", [
				siteId,
				siteId,
				now,
			]);
		for (const configKey of ["zeta", "alpha", "delta", "beta", "gamma"])
			hubDb.run("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)", [
				configKey,
				configKey,
				now,
			]);
		const pages = new Map<string, string[]>();
		try {
			hub.addPeer(
				"spoke",
				(frame) => {
					const d = decodeFrame(frame, key);
					if (d.ok && d.value.type === WsMessageType.CONSISTENCY_RESPONSE) {
						const x = d.value.payload as { table: string; pks: string[] };
						pages.set(x.table, [...(pages.get(x.table) ?? []), ...x.pks]);
					}
					return true;
				},
				key,
			);
			hub.handleConsistencyRequest("spoke", { tables: ["messages", "hosts", "cluster_config"] });
			await new Promise((r) => setTimeout(r, 40));
			expect(pages.get("messages")).toEqual(["m1", "m2", "m4", "m5", "m7"]);
			expect(pages.get("hosts")).toEqual(["a", "b", "c", "d", "e"]);
			expect(pages.get("cluster_config")).toEqual(["alpha", "beta", "delta", "gamma", "zeta"]);
		} finally {
			target.CONSISTENCY_PAGE_SIZE = original;
		}
	});

	it("keeps per-peer cursors isolated through backpressure drain-resume", async () => {
		const target = WsTransport as unknown as { CONSISTENCY_PAGE_SIZE: number };
		const original = target.CONSISTENCY_PAGE_SIZE;
		target.CONSISTENCY_PAGE_SIZE = 2;
		for (const id of ["a", "b", "c", "d", "e", "f", "g"]) insertMemory(hubDb, id, id);
		const one: string[] = [];
		const two: string[] = [];
		const queries: string[] = [];
		const originalQuery = hubDb.query.bind(hubDb);
		(hubDb as unknown as { query: (sql: string) => ReturnType<Database["query"]> }).query = (
			sql,
		) => {
			queries.push(sql);
			return originalQuery(sql);
		};
		let sends = 0;
		let blocked = true;
		try {
			hub.addPeer(
				"one",
				(f) => {
					sends++;
					if (blocked && sends === 2) return false;
					const d = decodeFrame(f, key);
					if (d.ok && d.value.type === WsMessageType.CONSISTENCY_RESPONSE)
						one.push(...(d.value.payload as { pks: string[] }).pks);
					return true;
				},
				key,
			);
			hub.addPeer(
				"two",
				(f) => {
					const d = decodeFrame(f, key);
					if (d.ok && d.value.type === WsMessageType.CONSISTENCY_RESPONSE)
						two.push(...(d.value.payload as { pks: string[] }).pks);
					return true;
				},
				key,
			);
			hub.handleConsistencyRequest("one", { tables: ["semantic_memory"], request_id: "one" });
			hub.handleConsistencyRequest("two", { tables: ["semantic_memory"], request_id: "two" });
			await new Promise((r) => setTimeout(r, 15));
			blocked = false;
			hub.continueConsistencyStream("one");
			await new Promise((r) => setTimeout(r, 40));
			const expected = ["a", "b", "c", "d", "e", "f", "g", "mem-1", "mem-2"];
			expect(one).toEqual(expected);
			expect(two).toEqual(expected);
			// Each request owns its count cache, and peer one's cache survives its drain resume.
			expect(queries.filter((sql) => sql.includes("SELECT COUNT(*) AS c"))).toHaveLength(2);
		} finally {
			target.CONSISTENCY_PAGE_SIZE = original;
		}
	});

	it("uses one OFFSET seek on resume and keyset pages thereafter", async () => {
		const target = WsTransport as unknown as { CONSISTENCY_PAGE_SIZE: number };
		const original = target.CONSISTENCY_PAGE_SIZE;
		target.CONSISTENCY_PAGE_SIZE = 2;
		for (const id of ["a", "b", "c", "d", "e", "f", "g"]) insertMemory(hubDb, id, id);
		const queries: string[] = [];
		const originalQuery = hubDb.query.bind(hubDb);
		(hubDb as unknown as { query: (sql: string) => ReturnType<Database["query"]> }).query = (
			sql,
		) => {
			queries.push(sql);
			return originalQuery(sql);
		};
		try {
			hub.addPeer("spoke", () => true, key);
			hub.handleConsistencyRequest("spoke", { tables: ["semantic_memory"], resume_offset: 2 });
			await new Promise((r) => setTimeout(r, 40));
			const pageQueries = queries.filter((sql) => sql.includes("SELECT id, modified_at"));
			expect(pageQueries.filter((sql) => sql.includes("OFFSET"))).toHaveLength(1);
			expect(
				pageQueries.filter((sql) => !sql.includes("OFFSET")).every((sql) => sql.includes("id > ?")),
			).toBe(true);
			expect(queries.filter((sql) => sql.includes("SELECT COUNT(*) AS c"))).toHaveLength(1);
		} finally {
			target.CONSISTENCY_PAGE_SIZE = original;
		}
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
