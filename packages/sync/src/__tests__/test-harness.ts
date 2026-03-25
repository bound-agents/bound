import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import type { Logger } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import type { KeyringConfig } from "@bound/shared";
import { Hono } from "hono";
import { ensureKeypair } from "../crypto.js";
import { createSyncRoutes } from "../routes.js";
import { SyncClient } from "../sync-loop.js";
import type { RelayExecutor } from "../relay-executor.js";

export interface TestInstance {
	db: Database;
	siteId: string;
	port: number;
	server: ReturnType<typeof Bun.serve>;
	syncClient: SyncClient | null;
	cleanup: () => Promise<void>;
}

const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

const createMockEventBus = (): TypedEventEmitter => {
	return new TypedEventEmitter();
};

// Schema for all synced tables
const FULL_SCHEMA = `
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		display_name TEXT NOT NULL,
		discord_id TEXT,
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
		host_origin TEXT NOT NULL
	);

	CREATE TABLE semantic_memory (
		id TEXT PRIMARY KEY,
		key TEXT NOT NULL,
		value TEXT NOT NULL,
		source TEXT NOT NULL,
		created_at TEXT NOT NULL,
		modified_at TEXT NOT NULL,
		last_accessed_at TEXT NOT NULL,
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
		modified_at TEXT NOT NULL
	);

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

	CREATE TABLE change_log (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL,
		site_id TEXT NOT NULL,
		timestamp TEXT NOT NULL,
		row_data TEXT NOT NULL
	);

	CREATE TABLE sync_state (
		peer_site_id TEXT PRIMARY KEY,
		last_received INTEGER NOT NULL DEFAULT 0,
		last_sent INTEGER NOT NULL DEFAULT 0,
		last_sync_at TEXT,
		sync_errors INTEGER NOT NULL DEFAULT 0
	);
`;

export async function createTestInstance(config: {
	name: string;
	port: number;
	dbPath: string;
	role: "hub" | "spoke";
	hubPort?: number;
	keyring: KeyringConfig;
	keypairPath?: string;
	relayExecutor?: RelayExecutor;
}): Promise<TestInstance> {
	const { name, port, dbPath, role, hubPort, keyring, keypairPath, relayExecutor } = config;

	// Ensure directory exists
	const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
	if (dir && !existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}

	// Generate or load keypair for this instance
	const effectiveKeypairPath = keypairPath ?? `${dir}/host-${name}`;
	const keypair = await ensureKeypair(effectiveKeypairPath);
	const siteId = keypair.siteId;

	// Create SQLite database with full schema
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");

	// Execute all schema statements
	const statements = FULL_SCHEMA.split(";").filter((s) => s.trim());
	for (const stmt of statements) {
		if (stmt.trim()) {
			db.run(stmt);
		}
	}

	// Create Hono app with sync routes
	const honoApp = new Hono();
	const syncRoutes = createSyncRoutes(
		db,
		siteId,
		keyring,
		createMockEventBus(),
		createMockLogger(),
		relayExecutor,
	);

	// Mount sync routes
	honoApp.route("/", syncRoutes);

	// Start Bun.serve
	const server = Bun.serve({
		port,
		fetch: honoApp.fetch,
	});

	// Create SyncClient for this instance
	let syncClient: SyncClient | null = null;
	if (role === "spoke" && hubPort) {
		const hubUrl = `http://localhost:${hubPort}`;
		syncClient = new SyncClient(
			db,
			siteId,
			keypair.privateKey,
			hubUrl,
			createMockLogger(),
			createMockEventBus(),
			keyring,
		);
	}

	return {
		db,
		siteId,
		port,
		server,
		syncClient,
		cleanup: async () => {
			server.stop();
			db.close();
			// Give the port time to be released
			await new Promise((resolve) => setTimeout(resolve, 100));
			if (dir && existsSync(dir)) {
				await rm(dir, { recursive: true, force: true });
			}
		},
	};
}
