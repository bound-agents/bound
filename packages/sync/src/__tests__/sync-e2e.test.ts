import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, insertRow, softDelete, updateRow } from "@bound/core";
import type { KeyringConfig, Logger } from "@bound/shared";
import { HLC_ZERO, TypedEventEmitter } from "@bound/shared";
import { Hono } from "hono";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import { clearColumnCache } from "../reducers.js";
import { createSyncRoutes } from "../routes.js";
import { signRequest } from "../signing.js";
import { SyncClient } from "../sync-loop.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

interface Host {
	db: Database;
	siteId: string;
	privateKey: CryptoKey;
	server: ReturnType<typeof Bun.serve>;
	port: number;
	eventBus: TypedEventEmitter;
}

/** Temporary directories to clean up after all tests */
const tempDirs: string[] = [];

/** Bun.serve instances to stop after all tests */
const servers: ReturnType<typeof Bun.serve>[] = [];

/**
 * Create a fully-wired host with real Ed25519 identity, real DB schema,
 * and a live Hono server listening on a random port.
 */
async function createHost(
	_name: string,
	keyring: KeyringConfig,
	keypairDir: string,
): Promise<Host> {
	const db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	applySchema(db);
	clearColumnCache();

	const keypair = await ensureKeypair(keypairDir);
	const siteId = keypair.siteId;

	const eventBus = new TypedEventEmitter();
	const logger = createMockLogger();

	const honoApp = new Hono();
	const syncRoutes = createSyncRoutes(db, siteId, keyring, eventBus, logger);
	honoApp.route("/", syncRoutes);

	const server = Bun.serve({ port: 0, fetch: honoApp.fetch });
	servers.push(server);

	return {
		db,
		siteId,
		privateKey: keypair.privateKey,
		server,
		port: server.port,
		eventBus,
	};
}

/** Build a SyncClient that speaks from `from` to `to`. */
function makeSyncClient(from: Host, to: Host, keyring: KeyringConfig): SyncClient {
	return new SyncClient(
		from.db,
		from.siteId,
		from.privateKey,
		`http://localhost:${to.port}`,
		createMockLogger(),
		from.eventBus,
		keyring,
	);
}

/**
 * Create a unique temp directory for keypairs and register it for cleanup.
 */
function tempKeypairDir(label: string): string {
	const dir = join(tmpdir(), `bound-e2e-${label}-${randomBytes(4).toString("hex")}`);
	tempDirs.push(dir);
	return dir;
}

/**
 * Write a row directly to a table with a manual change_log entry.
 * Required for tables whose PK is NOT `id` (hosts, cluster_config).
 */
async function insertRawRow(
	db: Database,
	tableName: string,
	rowData: Record<string, unknown>,
	pkColumn: string,
	siteId: string,
): Promise<void> {
	const columns = Object.keys(rowData);
	const placeholders = columns.map(() => "?").join(", ");
	const values = columns.map((c) => rowData[c] ?? null);

	const { generateHlc } = await import("@bound/shared");
	const rowId = String(rowData[pkColumn]);
	const now = new Date().toISOString();

	// Get the last HLC from the change_log to generate the next one
	const lastHlcRow = db.query("SELECT hlc FROM change_log ORDER BY hlc DESC LIMIT 1").get() as {
		hlc: string;
	} | null;
	const hlc = generateHlc(now, lastHlcRow?.hlc ?? null, siteId);

	const txFn = db.transaction(() => {
		db.run(
			`INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders})`,
			values as (string | number | null)[],
		);
		db.run(
			"INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?, ?)",
			[hlc, tableName, rowId, siteId, now, JSON.stringify(rowData)],
		);
	});
	txFn();
}

// ---------------------------------------------------------------------------
// Scaffolding shared across all tests in this file
// ---------------------------------------------------------------------------

let hostA: Host;
let hostB: Host;
let hostC: Host;
let keyring: KeyringConfig;
let clientAtoB: SyncClient;
let clientBtoA: SyncClient;

afterAll(async () => {
	for (const s of servers) {
		s.stop(true);
	}
	for (const d of tempDirs) {
		await rm(d, { recursive: true, force: true }).catch(() => {});
	}
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("sync E2E", () => {
	beforeEach(async () => {
		clearColumnCache();

		const dirA = tempKeypairDir("a");
		const dirB = tempKeypairDir("b");
		const dirC = tempKeypairDir("c");

		// Pre-generate keypairs so we can build the keyring before creating hosts
		const kpA = await ensureKeypair(dirA);
		const kpB = await ensureKeypair(dirB);
		const kpC = await ensureKeypair(dirC);

		const pubA = await exportPublicKey(kpA.publicKey);
		const pubB = await exportPublicKey(kpB.publicKey);
		const pubC = await exportPublicKey(kpC.publicKey);

		// We don't know ports yet, so we'll patch keyring after hosts start.
		// Create a preliminary keyring with placeholder URLs.
		keyring = {
			hosts: {
				[kpA.siteId]: { public_key: pubA, url: "http://localhost:0" },
				[kpB.siteId]: { public_key: pubB, url: "http://localhost:0" },
				[kpC.siteId]: { public_key: pubC, url: "http://localhost:0" },
			},
		};

		hostA = await createHost("a", keyring, dirA);
		hostB = await createHost("b", keyring, dirB);
		hostC = await createHost("c", keyring, dirC);

		// Patch keyring with real ports
		const hosts = keyring.hosts as Record<string, { public_key: string; url: string }>;
		hosts[hostA.siteId].url = `http://localhost:${hostA.port}`;
		hosts[hostB.siteId].url = `http://localhost:${hostB.port}`;
		hosts[hostC.siteId].url = `http://localhost:${hostC.port}`;

		clientAtoB = makeSyncClient(hostA, hostB, keyring);
		clientBtoA = makeSyncClient(hostB, hostA, keyring);
	});

	// -----------------------------------------------------------------------
	// 1. Basic bidirectional sync — A creates data, syncs to B
	// -----------------------------------------------------------------------

	it("1. A creates thread + message, sync to B", async () => {
		const now = new Date().toISOString();
		const threadId = randomUUID();
		const msgId = randomUUID();

		insertRow(
			hostA.db,
			"threads",
			{
				id: threadId,
				user_id: "user-1",
				interface: "web",
				host_origin: hostA.siteId,
				color: 0,
				title: "Hello thread",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		insertRow(
			hostA.db,
			"messages",
			{
				id: msgId,
				thread_id: threadId,
				role: "user",
				content: "First message",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: hostA.siteId,
				deleted: 0,
			},
			hostA.siteId,
		);

		// B syncs from A (B pushes then pulls)
		const result = await clientBtoA.syncCycle();
		expect(result.ok).toBe(true);

		const thread = hostB.db.query("SELECT * FROM threads WHERE id = ?").get(threadId) as Record<
			string,
			unknown
		> | null;
		expect(thread).not.toBeNull();
		expect(thread?.title).toBe("Hello thread");

		const msg = hostB.db.query("SELECT * FROM messages WHERE id = ?").get(msgId) as Record<
			string,
			unknown
		> | null;
		expect(msg).not.toBeNull();
		expect(msg?.content).toBe("First message");
	});

	// -----------------------------------------------------------------------
	// 2. B creates thread + message, syncs to A
	// -----------------------------------------------------------------------

	it("2. B creates thread + message, sync to A", async () => {
		const now = new Date().toISOString();
		const threadId = randomUUID();
		const msgId = randomUUID();

		insertRow(
			hostB.db,
			"threads",
			{
				id: threadId,
				user_id: "user-2",
				interface: "discord",
				host_origin: hostB.siteId,
				color: 1,
				title: "From B",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			hostB.siteId,
		);

		insertRow(
			hostB.db,
			"messages",
			{
				id: msgId,
				thread_id: threadId,
				role: "assistant",
				content: "Response from B",
				model_id: "claude-3-opus",
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: hostB.siteId,
				deleted: 0,
			},
			hostB.siteId,
		);

		// A pushes to B (nothing to push), then pulls from B
		const result = await clientAtoB.syncCycle();
		expect(result.ok).toBe(true);

		const thread = hostA.db.query("SELECT * FROM threads WHERE id = ?").get(threadId) as Record<
			string,
			unknown
		> | null;
		expect(thread).not.toBeNull();
		expect(thread?.title).toBe("From B");

		const msg = hostA.db.query("SELECT * FROM messages WHERE id = ?").get(msgId) as Record<
			string,
			unknown
		> | null;
		expect(msg).not.toBeNull();
		expect(msg?.content).toBe("Response from B");
	});

	// -----------------------------------------------------------------------
	// 3. Both create different threads, sync both ways, both have everything
	// -----------------------------------------------------------------------

	it("3. bidirectional: both create threads, sync both ways", async () => {
		const now = new Date().toISOString();
		const threadA = randomUUID();
		const threadB = randomUUID();

		insertRow(
			hostA.db,
			"threads",
			{
				id: threadA,
				user_id: "u1",
				interface: "web",
				host_origin: hostA.siteId,
				color: 0,
				title: "Thread from A",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		insertRow(
			hostB.db,
			"threads",
			{
				id: threadB,
				user_id: "u2",
				interface: "web",
				host_origin: hostB.siteId,
				color: 1,
				title: "Thread from B",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			hostB.siteId,
		);

		// B pushes to A, pulls from A
		const r1 = await clientBtoA.syncCycle();
		expect(r1.ok).toBe(true);

		// A pushes to B, pulls from B
		const r2 = await clientAtoB.syncCycle();
		expect(r2.ok).toBe(true);

		// Both hosts should now have both threads
		expect(hostA.db.query("SELECT * FROM threads WHERE id = ?").get(threadB)).not.toBeNull();
		expect(hostB.db.query("SELECT * FROM threads WHERE id = ?").get(threadA)).not.toBeNull();
	});

	// -----------------------------------------------------------------------
	// 4. Users table (LWW): create on A, sync to B, update on B, sync back
	// -----------------------------------------------------------------------

	it("4. users LWW: create on A, sync to B, update on B, sync back", async () => {
		const now = new Date().toISOString();
		const userId = randomUUID();

		insertRow(
			hostA.db,
			"users",
			{
				id: userId,
				display_name: "Alice",
				platform_ids: null,
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		// B pulls from A
		const r1 = await clientBtoA.syncCycle();
		expect(r1.ok).toBe(true);

		const userOnB = hostB.db.query("SELECT * FROM users WHERE id = ?").get(userId) as Record<
			string,
			unknown
		> | null;
		expect(userOnB).not.toBeNull();
		expect(userOnB?.display_name).toBe("Alice");

		// B updates the user
		updateRow(hostB.db, "users", userId, { display_name: "Alice B." }, hostB.siteId);

		// A pulls from B
		const r2 = await clientAtoB.syncCycle();
		expect(r2.ok).toBe(true);

		const userOnA = hostA.db.query("SELECT * FROM users WHERE id = ?").get(userId) as Record<
			string,
			unknown
		> | null;
		expect(userOnA).not.toBeNull();
		expect(userOnA?.display_name).toBe("Alice B.");
	});

	// -----------------------------------------------------------------------
	// 5. Hosts table (LWW, site_id PK)
	// -----------------------------------------------------------------------

	it("5. hosts table: registration syncs via site_id PK", async () => {
		const now = new Date().toISOString();

		await insertRawRow(
			hostA.db,
			"hosts",
			{
				site_id: "remote-laptop-001",
				host_name: "my-laptop",
				version: "0.1.0",
				sync_url: null,
				mcp_servers: null,
				mcp_tools: null,
				models: null,
				overlay_root: null,
				online_at: now,
				modified_at: now,
				deleted: 0,
			},
			"site_id",
			hostA.siteId,
		);

		const r = await clientBtoA.syncCycle();
		expect(r.ok).toBe(true);

		const hostOnB = hostB.db
			.query("SELECT * FROM hosts WHERE site_id = ?")
			.get("remote-laptop-001") as Record<string, unknown> | null;
		expect(hostOnB).not.toBeNull();
		expect(hostOnB?.host_name).toBe("my-laptop");
	});

	// -----------------------------------------------------------------------
	// 6. Cluster_config table (LWW, key PK) — emergency_stop replicates
	// -----------------------------------------------------------------------

	it("6. cluster_config: emergency_stop replicates from A to B", async () => {
		const now = new Date().toISOString();

		await insertRawRow(
			hostA.db,
			"cluster_config",
			{
				key: "emergency_stop",
				value: "true",
				modified_at: now,
			},
			"key",
			hostA.siteId,
		);

		const r = await clientBtoA.syncCycle();
		expect(r.ok).toBe(true);

		const cfgOnB = hostB.db
			.query("SELECT * FROM cluster_config WHERE key = ?")
			.get("emergency_stop") as Record<string, unknown> | null;
		expect(cfgOnB).not.toBeNull();
		expect(cfgOnB?.value).toBe("true");
	});

	// -----------------------------------------------------------------------
	// 7. Messages (append-only): merge from both hosts without duplication
	// -----------------------------------------------------------------------

	it("7. messages append-only: merge from both hosts", async () => {
		const now = new Date().toISOString();
		const threadId = randomUUID();
		const msgA = randomUUID();
		const msgB = randomUUID();

		// Create threads on both so messages have valid parents
		for (const host of [hostA, hostB]) {
			insertRow(
				host.db,
				"threads",
				{
					id: threadId,
					user_id: "u1",
					interface: "web",
					host_origin: host.siteId,
					color: 0,
					title: "Shared thread",
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				host.siteId,
			);
		}

		insertRow(
			hostA.db,
			"messages",
			{
				id: msgA,
				thread_id: threadId,
				role: "user",
				content: "From A",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: hostA.siteId,
				deleted: 0,
			},
			hostA.siteId,
		);

		insertRow(
			hostB.db,
			"messages",
			{
				id: msgB,
				thread_id: threadId,
				role: "user",
				content: "From B",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: hostB.siteId,
				deleted: 0,
			},
			hostB.siteId,
		);

		// B syncs with A
		await clientBtoA.syncCycle();
		// A syncs with B
		await clientAtoB.syncCycle();

		const countA = (
			hostA.db.query("SELECT COUNT(*) as c FROM messages WHERE thread_id = ?").get(threadId) as {
				c: number;
			}
		).c;
		const countB = (
			hostB.db.query("SELECT COUNT(*) as c FROM messages WHERE thread_id = ?").get(threadId) as {
				c: number;
			}
		).c;

		expect(countA).toBe(2);
		expect(countB).toBe(2);
	});

	// -----------------------------------------------------------------------
	// 8. Semantic_memory (LWW): newer timestamp wins
	// -----------------------------------------------------------------------

	it("8. semantic_memory LWW: update on B with newer ts wins over A", async () => {
		const time1 = "2026-03-24T10:00:00.000Z";
		const memId = randomUUID();

		insertRow(
			hostA.db,
			"semantic_memory",
			{
				id: memId,
				key: "project-goal",
				value: "Build a sync system",
				source: "user",
				created_at: time1,
				modified_at: time1,
				last_accessed_at: time1,
				deleted: 0,
			},
			hostA.siteId,
		);

		// B pulls from A
		await clientBtoA.syncCycle();

		// B updates with newer timestamp
		updateRow(
			hostB.db,
			"semantic_memory",
			memId,
			{ value: "Build a ROBUST sync system", key: "project-goal" },
			hostB.siteId,
		);

		// A pulls from B
		await clientAtoB.syncCycle();

		const memOnA = hostA.db
			.query("SELECT * FROM semantic_memory WHERE id = ?")
			.get(memId) as Record<string, unknown> | null;
		expect(memOnA).not.toBeNull();
		expect(memOnA?.value).toBe("Build a ROBUST sync system");
	});

	// -----------------------------------------------------------------------
	// 9. Tasks (LWW): schedule on A, sync to B
	// -----------------------------------------------------------------------

	it("9. tasks: schedule on A, sync to B", async () => {
		const now = new Date().toISOString();
		const taskId = randomUUID();

		insertRow(
			hostA.db,
			"tasks",
			{
				id: taskId,
				type: "cron",
				status: "pending",
				trigger_spec: "0 * * * *",
				payload: JSON.stringify({ command: "backup" }),
				created_at: now,
				created_by: "system",
				thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: now,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: "results",
				depends_on: null,
				require_success: 0,
				alert_threshold: 1,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				modified_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		await clientBtoA.syncCycle();

		const taskOnB = hostB.db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<
			string,
			unknown
		> | null;
		expect(taskOnB).not.toBeNull();
		expect(taskOnB?.type).toBe("cron");
		expect(taskOnB?.trigger_spec).toBe("0 * * * *");
	});

	// -----------------------------------------------------------------------
	// 10. Files (LWW): write on A, sync to B
	// -----------------------------------------------------------------------

	it("10. files: write on A, sync to B", async () => {
		const now = new Date().toISOString();
		const fileId = randomUUID();

		insertRow(
			hostA.db,
			"files",
			{
				id: fileId,
				path: "/docs/README.md",
				content: "# Hello World",
				is_binary: 0,
				size_bytes: 13,
				created_at: now,
				modified_at: now,
				deleted: 0,
				created_by: "user-1",
				host_origin: hostA.siteId,
			},
			hostA.siteId,
		);

		await clientBtoA.syncCycle();

		const fileOnB = hostB.db.query("SELECT * FROM files WHERE id = ?").get(fileId) as Record<
			string,
			unknown
		> | null;
		expect(fileOnB).not.toBeNull();
		expect(fileOnB?.path).toBe("/docs/README.md");
		expect(fileOnB?.content).toBe("# Hello World");
	});

	// -----------------------------------------------------------------------
	// 11. Advisories (LWW): create on A, approve on B, sync back
	// -----------------------------------------------------------------------

	it("11. advisories: create on A, approve on B, sync back", async () => {
		const now = new Date().toISOString();
		const advId = randomUUID();

		insertRow(
			hostA.db,
			"advisories",
			{
				id: advId,
				type: "cost",
				status: "proposed",
				title: "Cost is high",
				detail: "Daily spend exceeds $50",
				action: "Reduce model usage",
				impact: "high",
				evidence: JSON.stringify({ daily_cost: 52.0 }),
				proposed_at: now,
				defer_until: null,
				resolved_at: null,
				created_by: "system",
				modified_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		// B pulls advisory
		await clientBtoA.syncCycle();

		const advOnB = hostB.db.query("SELECT * FROM advisories WHERE id = ?").get(advId) as Record<
			string,
			unknown
		> | null;
		expect(advOnB).not.toBeNull();
		expect(advOnB?.status).toBe("proposed");

		// B approves it
		updateRow(
			hostB.db,
			"advisories",
			advId,
			{ status: "approved", resolved_at: new Date().toISOString() },
			hostB.siteId,
		);

		// A pulls from B
		await clientAtoB.syncCycle();

		const advBackOnA = hostA.db.query("SELECT * FROM advisories WHERE id = ?").get(advId) as Record<
			string,
			unknown
		> | null;
		expect(advBackOnA).not.toBeNull();
		expect(advBackOnA?.status).toBe("approved");
	});

	// -----------------------------------------------------------------------
	// 12. Overlay_index (LWW): index on A, sync to B
	// -----------------------------------------------------------------------

	it("12. overlay_index: index files on A, sync to B", async () => {
		const now = new Date().toISOString();
		const ovId = randomUUID();

		insertRow(
			hostA.db,
			"overlay_index",
			{
				id: ovId,
				site_id: hostA.siteId,
				path: "/data/overlay/file.txt",
				size_bytes: 256,
				content_hash: "abcdef1234567890",
				indexed_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		await clientBtoA.syncCycle();

		const ovOnB = hostB.db.query("SELECT * FROM overlay_index WHERE id = ?").get(ovId) as Record<
			string,
			unknown
		> | null;
		expect(ovOnB).not.toBeNull();
		expect(ovOnB?.path).toBe("/data/overlay/file.txt");
		expect(ovOnB?.size_bytes).toBe(256);
	});

	// -----------------------------------------------------------------------
	// 13. LWW conflict: both hosts update same row — newer modified_at wins
	// -----------------------------------------------------------------------

	it("13. LWW conflict: newer modified_at wins", async () => {
		const timeOld = "2026-03-24T10:00:00.000Z";
		const timeNew = "2026-03-24T10:00:01.000Z";
		const memId = randomUUID();

		// Insert the same row on BOTH hosts. A has the older timestamp, B has
		// the newer one.
		insertRow(
			hostA.db,
			"semantic_memory",
			{
				id: memId,
				key: "conflict-key",
				value: "A's value (old)",
				source: "user",
				created_at: timeOld,
				modified_at: timeOld,
				last_accessed_at: timeOld,
				deleted: 0,
			},
			hostA.siteId,
		);

		insertRow(
			hostB.db,
			"semantic_memory",
			{
				id: memId,
				key: "conflict-key",
				value: "B's value (new)",
				source: "user",
				created_at: timeOld,
				modified_at: timeNew,
				last_accessed_at: timeNew,
				deleted: 0,
			},
			hostB.siteId,
		);

		// B pushes its data (including its newer row) to A
		await clientBtoA.syncCycle();

		// A should now have B's value because timeNew > timeOld
		const memOnA = hostA.db
			.query("SELECT * FROM semantic_memory WHERE id = ?")
			.get(memId) as Record<string, unknown> | null;
		expect(memOnA).not.toBeNull();
		expect(memOnA?.value).toBe("B's value (new)");
	});

	// -----------------------------------------------------------------------
	// 14. Append-only dedup: same message ID — no duplication
	// -----------------------------------------------------------------------

	it("14. append-only dedup: same message ID from two sources", async () => {
		const now = new Date().toISOString();
		const threadId = randomUUID();
		const sharedMsgId = randomUUID();

		// Create thread on both
		for (const host of [hostA, hostB]) {
			insertRow(
				host.db,
				"threads",
				{
					id: threadId,
					user_id: "u1",
					interface: "web",
					host_origin: host.siteId,
					color: 0,
					title: "Dedup test",
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				host.siteId,
			);
		}

		// Same message ID on both hosts (arrived via two paths)
		insertRow(
			hostA.db,
			"messages",
			{
				id: sharedMsgId,
				thread_id: threadId,
				role: "user",
				content: "Hello",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: "laptop",
				deleted: 0,
			},
			hostA.siteId,
		);

		insertRow(
			hostB.db,
			"messages",
			{
				id: sharedMsgId,
				thread_id: threadId,
				role: "user",
				content: "Hello",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: "cloud",
				deleted: 0,
			},
			hostB.siteId,
		);

		// Sync both ways
		await clientBtoA.syncCycle();
		await clientAtoB.syncCycle();

		// Each host must have exactly 1 copy
		const countA = (
			hostA.db.query("SELECT COUNT(*) as c FROM messages WHERE id = ?").get(sharedMsgId) as {
				c: number;
			}
		).c;
		const countB = (
			hostB.db.query("SELECT COUNT(*) as c FROM messages WHERE id = ?").get(sharedMsgId) as {
				c: number;
			}
		).c;

		expect(countA).toBe(1);
		expect(countB).toBe(1);
	});

	// -----------------------------------------------------------------------
	// 15. Soft delete: delete on A syncs as deleted=1 to B
	// -----------------------------------------------------------------------

	it("15. soft delete syncs as deleted=1", async () => {
		const now = new Date().toISOString();
		const memId = randomUUID();

		insertRow(
			hostA.db,
			"semantic_memory",
			{
				id: memId,
				key: "to-delete",
				value: "temporary",
				source: "user",
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		// Sync to B first
		await clientBtoA.syncCycle();
		expect(hostB.db.query("SELECT * FROM semantic_memory WHERE id = ?").get(memId)).not.toBeNull();

		// Soft-delete on A
		softDelete(hostA.db, "semantic_memory", memId, hostA.siteId);

		// Sync again
		await clientBtoA.syncCycle();

		const memOnB = hostB.db
			.query("SELECT * FROM semantic_memory WHERE id = ?")
			.get(memId) as Record<string, unknown> | null;
		expect(memOnB).not.toBeNull();
		expect(memOnB?.deleted).toBe(1);
	});

	// -----------------------------------------------------------------------
	// 16. Empty sync: no changes -> push/pull both return 0
	// -----------------------------------------------------------------------

	it("16. empty sync: no changes yields 0 pushed and 0 pulled", async () => {
		const result = await clientBtoA.syncCycle();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.pushed).toBe(0);
			expect(result.value.pulled).toBe(0);
		}
	});

	// -----------------------------------------------------------------------
	// 17. Large batch: 100+ changes in one sync cycle
	// -----------------------------------------------------------------------

	it("17. large batch: 100+ changes in one sync cycle", async () => {
		const now = new Date().toISOString();

		for (let i = 0; i < 120; i++) {
			insertRow(
				hostA.db,
				"semantic_memory",
				{
					id: randomUUID(),
					key: `batch-key-${i}`,
					value: `value-${i}`,
					source: "bulk-import",
					created_at: now,
					modified_at: now,
					last_accessed_at: now,
					deleted: 0,
				},
				hostA.siteId,
			);
		}

		const result = await clientBtoA.syncCycle();
		expect(result.ok).toBe(true);

		const countB = (
			hostB.db
				.query("SELECT COUNT(*) as c FROM semantic_memory WHERE source = 'bulk-import'")
				.get() as { c: number }
		).c;
		expect(countB).toBe(120);
	});

	// -----------------------------------------------------------------------
	// 18. Idempotent re-sync: running sync twice with no new changes is a no-op
	// -----------------------------------------------------------------------

	it("18. idempotent re-sync: second cycle with no new data is a no-op", async () => {
		const now = new Date().toISOString();

		insertRow(
			hostA.db,
			"semantic_memory",
			{
				id: randomUUID(),
				key: "idem-key",
				value: "idem-value",
				source: "test",
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		// First sync
		const r1 = await clientBtoA.syncCycle();
		expect(r1.ok).toBe(true);

		// Second sync with no new changes
		const r2 = await clientBtoA.syncCycle();
		expect(r2.ok).toBe(true);
		if (r2.ok) {
			expect(r2.value.pulled).toBe(0);
		}

		// Ensure only one row with that key
		const count = (
			hostB.db.query("SELECT COUNT(*) as c FROM semantic_memory WHERE key = 'idem-key'").get() as {
				c: number;
			}
		).c;
		expect(count).toBe(1);
	});

	// -----------------------------------------------------------------------
	// 19. One-way: only A has changes, B pulls them
	// -----------------------------------------------------------------------

	it("19. one-way: only A has changes, B pulls via syncCycle", async () => {
		const now = new Date().toISOString();
		const memId = randomUUID();

		insertRow(
			hostA.db,
			"semantic_memory",
			{
				id: memId,
				key: "one-way",
				value: "only-on-a",
				source: "test",
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		const result = await clientBtoA.syncCycle();
		expect(result.ok).toBe(true);
		if (result.ok) {
			// B had nothing to push
			expect(result.value.pushed).toBe(0);
			// B pulled data from A
			expect(result.value.pulled).toBeGreaterThan(0);
		}

		expect(hostB.db.query("SELECT * FROM semantic_memory WHERE id = ?").get(memId)).not.toBeNull();
	});

	// -----------------------------------------------------------------------
	// 20. Stale data rejection: B has newer data, A's older update is rejected
	// -----------------------------------------------------------------------

	it("20. stale data rejection: older modified_at loses to existing newer row", async () => {
		const timeNew = "2026-03-24T12:00:00.000Z";
		const timeOld = "2026-03-24T10:00:00.000Z";
		const memId = randomUUID();

		// B already has the row with a NEWER timestamp
		insertRow(
			hostB.db,
			"semantic_memory",
			{
				id: memId,
				key: "stale-test",
				value: "B's newer value",
				source: "user",
				created_at: timeOld,
				modified_at: timeNew,
				last_accessed_at: timeNew,
				deleted: 0,
			},
			hostB.siteId,
		);

		// A has the row with an OLDER timestamp
		insertRow(
			hostA.db,
			"semantic_memory",
			{
				id: memId,
				key: "stale-test",
				value: "A's older value",
				source: "user",
				created_at: timeOld,
				modified_at: timeOld,
				last_accessed_at: timeOld,
				deleted: 0,
			},
			hostA.siteId,
		);

		// B syncs with A. A's data (older) flows into B but should be rejected.
		await clientBtoA.syncCycle();

		const memOnB = hostB.db
			.query("SELECT * FROM semantic_memory WHERE id = ?")
			.get(memId) as Record<string, unknown> | null;
		expect(memOnB).not.toBeNull();
		expect(memOnB?.value).toBe("B's newer value"); // Unchanged
	});

	// -----------------------------------------------------------------------
	// 21. Signed requests pass verification
	// -----------------------------------------------------------------------

	it("21. signed requests pass verification (sync succeeds)", async () => {
		const now = new Date().toISOString();
		insertRow(
			hostA.db,
			"semantic_memory",
			{
				id: randomUUID(),
				key: "sign-test",
				value: "signed-value",
				source: "test",
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		// If signing were broken, syncCycle would fail
		const result = await clientBtoA.syncCycle();
		expect(result.ok).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 22. Unknown site_id is rejected (403)
	// -----------------------------------------------------------------------

	it("22. unknown site_id is rejected with 403", async () => {
		// Create a keypair that is NOT in the keyring
		const unknownDir = tempKeypairDir("unknown");
		const unknownKp = await ensureKeypair(unknownDir);

		const body = JSON.stringify({ since_hlc: "" });
		const headers = await signRequest(
			unknownKp.privateKey,
			unknownKp.siteId,
			"POST",
			"/sync/pull",
			body,
		);

		const response = await fetch(`http://localhost:${hostA.port}/sync/pull`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...headers,
			},
			body,
		});

		expect(response.status).toBe(403);
	});

	// -----------------------------------------------------------------------
	// 23. Invalid signature is rejected (401)
	// -----------------------------------------------------------------------

	it("23. invalid signature is rejected with 401", async () => {
		const body = JSON.stringify({ since_hlc: "" });

		// Use a valid site_id from the keyring but sign with a DIFFERENT key
		const rogueDir = tempKeypairDir("rogue");
		const rogueKp = await ensureKeypair(rogueDir);

		// Sign with rogue's private key but claim to be hostA
		const headers = await signRequest(
			rogueKp.privateKey,
			hostA.siteId, // claim to be A
			"POST",
			"/sync/pull",
			body,
		);

		const response = await fetch(`http://localhost:${hostB.port}/sync/pull`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...headers,
			},
			body,
		});

		expect(response.status).toBe(401);
	});

	// -----------------------------------------------------------------------
	// 24. Three-host topology: A -> B -> C fan-out
	// -----------------------------------------------------------------------

	it("24. three-host fan-out: A creates, B relays to C", async () => {
		const now = new Date().toISOString();
		const memId = randomUUID();

		insertRow(
			hostA.db,
			"semantic_memory",
			{
				id: memId,
				key: "three-host",
				value: "originated-on-a",
				source: "test",
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		// B syncs from A
		await clientBtoA.syncCycle();

		// C syncs from B
		const clientCtoB = makeSyncClient(hostC, hostB, keyring);
		await clientCtoB.syncCycle();

		const memOnC = hostC.db
			.query("SELECT * FROM semantic_memory WHERE id = ?")
			.get(memId) as Record<string, unknown> | null;
		expect(memOnC).not.toBeNull();
		expect(memOnC?.value).toBe("originated-on-a");
	});

	// -----------------------------------------------------------------------
	// 25. Sync state cursor tracks correctly across multiple cycles
	// -----------------------------------------------------------------------

	it("25. sync_state cursor advances correctly over multiple cycles", async () => {
		const now = new Date().toISOString();

		// Cycle 1: one row
		insertRow(
			hostA.db,
			"semantic_memory",
			{
				id: randomUUID(),
				key: "cursor-1",
				value: "v1",
				source: "test",
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		await clientBtoA.syncCycle();

		const state1 = hostB.db
			.query("SELECT * FROM sync_state WHERE peer_site_id = ?")
			.get(hostA.siteId) as Record<string, unknown> | null;
		expect(state1).not.toBeNull();
		const lastReceived1 = state1?.last_received as string;
		expect(lastReceived1).not.toBe(HLC_ZERO);
		expect(lastReceived1).toBeTruthy();

		// Cycle 2: another row
		insertRow(
			hostA.db,
			"semantic_memory",
			{
				id: randomUUID(),
				key: "cursor-2",
				value: "v2",
				source: "test",
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		await clientBtoA.syncCycle();

		const state2 = hostB.db
			.query("SELECT * FROM sync_state WHERE peer_site_id = ?")
			.get(hostA.siteId) as Record<string, unknown> | null;
		const lastReceived2 = state2?.last_received as string;
		expect(lastReceived2).toBeTruthy();
		// HLC strings compare lexicographically - later HLC > earlier HLC
		expect(lastReceived2 > lastReceived1).toBe(true);

		// Both rows should exist on B
		expect(
			(hostB.db.query("SELECT COUNT(*) as c FROM semantic_memory").get() as { c: number }).c,
		).toBeGreaterThanOrEqual(2);
	});

	// -----------------------------------------------------------------------
	// 26. Event bus fires sync:completed with correct stats
	// -----------------------------------------------------------------------

	it("26. event bus emits sync:completed with pushed/pulled counts", async () => {
		const now = new Date().toISOString();

		insertRow(
			hostA.db,
			"semantic_memory",
			{
				id: randomUUID(),
				key: "event-bus-test",
				value: "v1",
				source: "test",
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		let emittedEvent: { pushed: number; pulled: number } | null = null;
		hostB.eventBus.on("sync:completed", (e) => {
			emittedEvent = e as { pushed: number; pulled: number };
		});

		await clientBtoA.syncCycle();

		expect(emittedEvent).not.toBeNull();
		expect(emittedEvent?.pulled).toBeGreaterThan(0);
	});

	// -----------------------------------------------------------------------
	// 27. Mixed table types in a single sync cycle
	// -----------------------------------------------------------------------

	it("27. mixed table types in a single sync cycle", async () => {
		const now = new Date().toISOString();
		const threadId = randomUUID();
		const msgId = randomUUID();
		const memId = randomUUID();
		const userId = randomUUID();

		insertRow(
			hostA.db,
			"users",
			{
				id: userId,
				display_name: "Mixed User",
				platform_ids: null,
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		insertRow(
			hostA.db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: hostA.siteId,
				color: 2,
				title: "Mixed thread",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		insertRow(
			hostA.db,
			"messages",
			{
				id: msgId,
				thread_id: threadId,
				role: "user",
				content: "Mixed message",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: hostA.siteId,
				deleted: 0,
			},
			hostA.siteId,
		);

		insertRow(
			hostA.db,
			"semantic_memory",
			{
				id: memId,
				key: "mixed-mem",
				value: "mixed-val",
				source: "test",
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
			},
			hostA.siteId,
		);

		await insertRawRow(
			hostA.db,
			"cluster_config",
			{ key: "mixed-cfg", value: "cfg-val", modified_at: now },
			"key",
			hostA.siteId,
		);

		await clientBtoA.syncCycle();

		expect(hostB.db.query("SELECT * FROM users WHERE id = ?").get(userId)).not.toBeNull();
		expect(hostB.db.query("SELECT * FROM threads WHERE id = ?").get(threadId)).not.toBeNull();
		expect(hostB.db.query("SELECT * FROM messages WHERE id = ?").get(msgId)).not.toBeNull();
		expect(hostB.db.query("SELECT * FROM semantic_memory WHERE id = ?").get(memId)).not.toBeNull();
		expect(
			hostB.db.query("SELECT * FROM cluster_config WHERE key = ?").get("mixed-cfg"),
		).not.toBeNull();
	});
});
