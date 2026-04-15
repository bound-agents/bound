import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { ensureKeypair } from "../crypto.js";

export interface TestInstance {
	db: Database;
	siteId: string;
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
		created_at  TEXT NOT NULL,
		modified_at TEXT NOT NULL,
		deleted     INTEGER DEFAULT 0
	);

	CREATE UNIQUE INDEX idx_edges_triple
		ON memory_edges(source_key, target_key, relation) WHERE deleted = 0;
	CREATE INDEX idx_edges_source ON memory_edges(source_key) WHERE deleted = 0;
	CREATE INDEX idx_edges_target ON memory_edges(target_key) WHERE deleted = 0;

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
	const statements = FULL_SCHEMA.split(";").filter((s) => s.trim());
	for (const stmt of statements) {
		if (stmt.trim()) {
			db.run(stmt);
		}
	}

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
