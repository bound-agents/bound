import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setChangelogEventBus, setRelayOutboxEventBus } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import { KeyManager } from "../key-manager.js";
import { WsSyncClient } from "../ws-client.js";
import { WsConnectionManager, createWsHandlers } from "../ws-server.js";
import { WsTransport } from "../ws-transport.js";

export interface TestInstance {
	db: Database;
	siteId: string;
	cleanup: () => Promise<void>;
}

// Schema for all synced tables
const FULL_SCHEMA = `
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		display_name TEXT NOT NULL,
		platform_ids TEXT,
		first_seen_at TEXT NOT NULL,
		modified_at TEXT NOT NULL,
		deleted INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE threads (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		interface TEXT NOT NULL,
		host_origin TEXT NOT NULL,
		color INTEGER NOT NULL,
		title TEXT NOT NULL,
		summary TEXT,
		summary_through TEXT,
		summary_model_id TEXT,
		extracted_through TEXT,
		created_at TEXT NOT NULL,
		modified_at TEXT NOT NULL,
		last_message_at TEXT NOT NULL,
		deleted INTEGER NOT NULL DEFAULT 0
	);

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
		deleted INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE semantic_memory (
		id TEXT PRIMARY KEY,
		key TEXT NOT NULL,
		value TEXT NOT NULL,
		source TEXT NOT NULL,
		created_at TEXT NOT NULL,
		modified_at TEXT NOT NULL,
		last_accessed_at TEXT NOT NULL,
		tier TEXT DEFAULT 'default',
		deleted INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE tasks (
		id TEXT PRIMARY KEY,
		type TEXT NOT NULL,
		status TEXT NOT NULL,
		trigger_spec TEXT,
		payload TEXT,
		thread_id TEXT,
		claimed_by TEXT,
		claimed_at TEXT,
		lease_id TEXT,
		next_run_at TEXT,
		last_run_at TEXT,
		run_count INTEGER NOT NULL DEFAULT 0,
		max_runs INTEGER,
		requires TEXT,
		model_hint TEXT,
		no_history INTEGER NOT NULL DEFAULT 0,
		inject_mode TEXT NOT NULL,
		depends_on TEXT,
		require_success INTEGER NOT NULL DEFAULT 0,
		alert_threshold INTEGER NOT NULL DEFAULT 0,
		consecutive_failures INTEGER NOT NULL DEFAULT 0,
		event_depth INTEGER NOT NULL DEFAULT 0,
		no_quiescence INTEGER NOT NULL DEFAULT 0,
		heartbeat_at TEXT,
		result TEXT,
		error TEXT,
		created_at TEXT NOT NULL,
		created_by TEXT NOT NULL,
		modified_at TEXT NOT NULL,
		deleted INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE files (
		id TEXT PRIMARY KEY,
		path TEXT NOT NULL,
		content TEXT NOT NULL,
		is_binary INTEGER NOT NULL DEFAULT 0,
		size_bytes INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		modified_at TEXT NOT NULL,
		deleted INTEGER NOT NULL DEFAULT 0,
		created_by TEXT NOT NULL,
		host_origin TEXT NOT NULL
	);

	CREATE TABLE hosts (
		site_id TEXT PRIMARY KEY,
		host_name TEXT NOT NULL,
		version TEXT NOT NULL,
		sync_url TEXT,
		mcp_servers TEXT,
		mcp_tools TEXT,
		models TEXT,
		overlay_root TEXT,
		online_at TEXT NOT NULL,
		modified_at TEXT NOT NULL,
		platforms TEXT,
		deleted INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE skills (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		description TEXT NOT NULL,
		status TEXT NOT NULL,
		skill_root TEXT NOT NULL,
		content_hash TEXT,
		allowed_tools TEXT,
		compatibility TEXT,
		metadata_json TEXT,
		activated_at TEXT,
		created_by_thread TEXT,
		activation_count INTEGER DEFAULT 0,
		last_activated_at TEXT,
		retired_by TEXT,
		retired_reason TEXT,
		modified_at TEXT NOT NULL,
		deleted INTEGER DEFAULT 0
	);

	CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name ON skills(name) WHERE deleted = 0;

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
	);

	CREATE UNIQUE INDEX idx_edges_triple
		ON memory_edges(source_key, target_key, relation) WHERE deleted = 0;
	CREATE INDEX idx_edges_source ON memory_edges(source_key) WHERE deleted = 0;
	CREATE INDEX idx_edges_target ON memory_edges(target_key) WHERE deleted = 0;

	CREATE TRIGGER IF NOT EXISTS memory_edges_canonical_relation_insert
	BEFORE INSERT ON memory_edges
	FOR EACH ROW WHEN NEW.relation NOT IN ('related_to','informs','supports','extends','complements','contrasts-with','competes-with','cites','summarizes','synthesizes')
	BEGIN SELECT RAISE(ABORT, 'Invalid relation. Must be one of: related_to, informs, supports, extends, complements, contrasts-with, competes-with, cites, summarizes, synthesizes. Use context column for bespoke phrasing.'); END;

	CREATE TRIGGER IF NOT EXISTS memory_edges_canonical_relation_update
	BEFORE UPDATE OF relation ON memory_edges
	FOR EACH ROW WHEN NEW.relation NOT IN ('related_to','informs','supports','extends','complements','contrasts-with','competes-with','cites','summarizes','synthesizes')
	BEGIN SELECT RAISE(ABORT, 'Invalid relation. Must be one of: related_to, informs, supports, extends, complements, contrasts-with, competes-with, cites, summarizes, synthesizes. Use context column for bespoke phrasing.'); END;

	CREATE TABLE overlay_index (
		id TEXT PRIMARY KEY,
		site_id TEXT NOT NULL,
		path TEXT NOT NULL,
		size_bytes INTEGER NOT NULL,
		content_hash TEXT NOT NULL,
		indexed_at TEXT NOT NULL,
		deleted INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE cluster_config (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		modified_at TEXT NOT NULL
	);

	CREATE TABLE host_meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);

	CREATE TABLE advisories (
		id TEXT PRIMARY KEY,
		type TEXT NOT NULL,
		status TEXT NOT NULL,
		title TEXT NOT NULL,
		detail TEXT NOT NULL,
		action TEXT NOT NULL,
		impact TEXT NOT NULL,
		evidence TEXT NOT NULL,
		proposed_at TEXT NOT NULL,
		defer_until TEXT,
		resolved_at TEXT,
		created_by TEXT NOT NULL,
		modified_at TEXT NOT NULL
	);

	CREATE TABLE turns (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		thread_id TEXT,
		task_id TEXT,
		dag_root_id TEXT,
		model_id TEXT NOT NULL,
		tokens_in INTEGER NOT NULL,
		tokens_out INTEGER NOT NULL,
		tokens_cache_write INTEGER,
		tokens_cache_read INTEGER,
		cost_usd REAL,
		relay_target TEXT,
		relay_latency_ms INTEGER,
		context_debug TEXT,
		created_at TEXT NOT NULL
	) STRICT;

	CREATE TABLE daily_summary (
		date TEXT PRIMARY KEY,
		total_tokens_in INTEGER DEFAULT 0,
		total_tokens_out INTEGER DEFAULT 0,
		total_cost_usd REAL DEFAULT 0,
		turn_count INTEGER DEFAULT 0
	) STRICT;

	CREATE INDEX IF NOT EXISTS idx_turns_thread
	ON turns(thread_id, created_at DESC);

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
		last_received TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000',
		last_sent TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000',
		last_sync_at TEXT,
		sync_errors INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE relay_outbox (
		id TEXT PRIMARY KEY,
		source_site_id TEXT,
		target_site_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		ref_id TEXT,
		idempotency_key TEXT,
		stream_id TEXT,
		payload TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		delivered INTEGER DEFAULT 0
	);

	CREATE TABLE relay_inbox (
		id TEXT PRIMARY KEY,
		source_site_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		ref_id TEXT,
		idempotency_key TEXT,
		stream_id TEXT,
		payload TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		received_at TEXT NOT NULL,
		processed INTEGER DEFAULT 0
	);

	CREATE TABLE relay_cycles (
		id TEXT PRIMARY KEY,
		requester_site_id TEXT NOT NULL,
		target_site_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		stream_id TEXT,
		created_at TEXT NOT NULL,
		latency_ms INTEGER NOT NULL,
		success INTEGER NOT NULL
	);

	CREATE TABLE dispatch_queue (
		message_id TEXT PRIMARY KEY,
		thread_id TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending',
		claimed_by TEXT,
		event_type TEXT NOT NULL DEFAULT 'user_message',
		event_payload TEXT,
		created_at TEXT NOT NULL,
		modified_at TEXT NOT NULL
	) STRICT;
`;

/**
 * Create a test database instance with the full schema.
 * Used by WS transport tests for setting up test instances.
 */
export async function createTestInstance(config: {
	dbPath: string;
	keypairPath?: string;
}): Promise<TestInstance> {
	const { dbPath, keypairPath } = config;

	// Ensure directory exists
	const dir = dirname(dbPath);
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}

	// Generate or load keypair for this instance
	const effectiveKeypairPath = keypairPath ?? `${dir}/host-keypair`;
	const keypair = await ensureKeypair(effectiveKeypairPath);
	const siteId = keypair.siteId;

	// Create SQLite database with full schema
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");

	// Execute all schema statements
	db.exec(FULL_SCHEMA);

	return {
		db,
		siteId,
		cleanup: async () => {
			db.close();
			if (dir && existsSync(dir)) {
				await cleanupTmpDir(dir);
			}
		},
	};
}

export interface WsTestCluster {
	hub: TestInstance & {
		server: ReturnType<typeof Bun.serve>;
		wsTransport: WsTransport;
		connectionManager: WsConnectionManager;
		eventBus: TypedEventEmitter;
	};
	spokes: Array<
		TestInstance & {
			wsTransport: WsTransport;
			wsClient: WsSyncClient;
			eventBus: TypedEventEmitter;
		}
	>;
	cleanup: () => Promise<void>;
}

/**
 * Create a multi-node WS test cluster with a hub and N spokes.
 *
 * All nodes share a single TypedEventEmitter so that relay:outbox-written
 * events emitted by the module-level writeOutbox() reach every WsTransport.
 * Each WsTransport queries its own DB on drain, so non-owning transports
 * find no entries and are effectively no-ops.
 *
 * NOTE: Because setChangelogEventBus and setRelayOutboxEventBus are
 * module-level singletons, this function overwrites them. Tests using this
 * cluster must not rely on separate per-instance event buses for changelog
 * or relay outbox writes.
 */
export async function createWsTestCluster(config: {
	spokeCount: number;
	basePort: number;
	testRunId: string;
}): Promise<WsTestCluster> {
	const { spokeCount, basePort, testRunId } = config;
	const totalNodes = 1 + spokeCount; // hub + spokes

	// One shared event bus for all nodes (see NOTE above)
	const sharedBus = new TypedEventEmitter();

	// Wire module-level event buses so writeOutbox() / insertRow() push to sharedBus
	setChangelogEventBus(sharedBus);
	setRelayOutboxEventBus(sharedBus);

	// Generate keypairs for all nodes: index 0 = hub, 1..N = spokes
	const keypairs = await Promise.all(
		Array.from({ length: totalNodes }, (_, i) =>
			ensureKeypair(join("/tmp", `bound-ws-cluster-${testRunId}-${i}`)),
		),
	);

	// Build shared keyring
	const keyring = {
		hosts: Object.fromEntries(
			await Promise.all(
				keypairs.map(async (kp, i) => [
					kp.siteId,
					{
						public_key: await exportPublicKey(kp.publicKey),
						url: `http://localhost:${basePort + i}`,
					},
				]),
			),
		),
	};

	// Helper: create a DB with full schema at a given path
	const createDb = async (dbPath: string): Promise<Database> => {
		const dir = dirname(dbPath);
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true });
		}
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA foreign_keys = ON");
		db.exec(FULL_SCHEMA);
		return db;
	};

	// ── Hub ──────────────────────────────────────────────────────────────────

	const hubKeypair = keypairs[0];
	const hubSiteId = hubKeypair.siteId;
	const hubPort = basePort;

	const hubDb = await createDb(join("/tmp", `bound-ws-cluster-${testRunId}-hub.db`));

	const hubKeyManager = new KeyManager(
		{ publicKey: hubKeypair.publicKey, privateKey: hubKeypair.privateKey },
		hubSiteId,
	);
	await hubKeyManager.init(keyring);

	const hubTransport = new WsTransport({
		db: hubDb,
		siteId: hubSiteId,
		eventBus: sharedBus,
		isHub: true,
	});
	hubTransport.start();

	const connectionManager = new WsConnectionManager();

	const wsHandlers = createWsHandlers({
		connectionManager,
		keyring,
		keyManager: hubKeyManager,
		wsTransport: hubTransport,
	});

	const hubServer = Bun.serve({
		port: hubPort,
		fetch: async (req, server) => {
			const url = new URL(req.url);
			if (url.pathname === "/sync/ws") {
				return (await wsHandlers.handleUpgrade(req, server)) ?? new Response("upgraded");
			}
			return new Response("not found", { status: 404 });
		},
		websocket: wsHandlers.websocket,
	});

	// ── Spokes ───────────────────────────────────────────────────────────────

	const spokeNodes: WsTestCluster["spokes"] = [];

	for (let i = 0; i < spokeCount; i++) {
		const spokeKeypair = keypairs[1 + i];
		const spokeSiteId = spokeKeypair.siteId;
		const spokeDb = await createDb(join("/tmp", `bound-ws-cluster-${testRunId}-spoke-${i}.db`));

		const spokeKeyManager = new KeyManager(
			{ publicKey: spokeKeypair.publicKey, privateKey: spokeKeypair.privateKey },
			spokeSiteId,
		);
		await spokeKeyManager.init(keyring);

		const spokeTransport = new WsTransport({
			db: spokeDb,
			siteId: spokeSiteId,
			eventBus: sharedBus,
			isHub: false,
		});
		spokeTransport.start();

		const wsClient = new WsSyncClient({
			hubUrl: `http://localhost:${hubPort}`,
			privateKey: spokeKeypair.privateKey,
			siteId: spokeSiteId,
			keyManager: spokeKeyManager,
			hubSiteId,
			wsTransport: spokeTransport,
		});

		await wsClient.connect();

		spokeNodes.push({
			db: spokeDb,
			siteId: spokeSiteId,
			wsTransport: spokeTransport,
			wsClient,
			eventBus: sharedBus,
			cleanup: async () => {
				spokeDb.close();
			},
		});
	}

	// Wait briefly for all spoke WebSocket connections to open
	await new Promise((r) => setTimeout(r, 100));

	// ── Cleanup ───────────────────────────────────────────────────────────────

	const cleanup = async (): Promise<void> => {
		// Stop spoke clients first
		for (const spoke of spokeNodes) {
			spoke.wsClient.close();
		}

		// Allow connections to close
		await new Promise((r) => setTimeout(r, 50));

		// Stop transports
		for (const spoke of spokeNodes) {
			spoke.wsTransport.stop();
			spoke.db.close();
		}

		hubTransport.stop();
		hubServer.stop(true);
		hubDb.close();

		// Reset module-level buses so they don't bleed into other tests
		setChangelogEventBus(null);

		// Clean up keypair files
		for (let i = 0; i < totalNodes; i++) {
			const dir = join("/tmp", `bound-ws-cluster-${testRunId}-${i}`);
			if (existsSync(dir)) {
				await cleanupTmpDir(dir);
			}
		}

		// Clean up DB files
		const hubDbPath = join("/tmp", `bound-ws-cluster-${testRunId}-hub.db`);
		if (existsSync(hubDbPath)) {
			await cleanupTmpDir(hubDbPath).catch(() => {});
		}
		for (let i = 0; i < spokeCount; i++) {
			const spokeDbPath = join("/tmp", `bound-ws-cluster-${testRunId}-spoke-${i}.db`);
			if (existsSync(spokeDbPath)) {
				await cleanupTmpDir(spokeDbPath).catch(() => {});
			}
		}
	};

	return {
		hub: {
			db: hubDb,
			siteId: hubSiteId,
			server: hubServer,
			wsTransport: hubTransport,
			connectionManager,
			eventBus: sharedBus,
			cleanup: async () => {
				hubTransport.stop();
				hubServer.stop(true);
				hubDb.close();
			},
		},
		spokes: spokeNodes,
		cleanup,
	};
}
