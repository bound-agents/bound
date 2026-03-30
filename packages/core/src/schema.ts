import type { Database } from "bun:sqlite";

export function applySchema(db: Database): void {
	// 1. users
	db.run(`
		CREATE TABLE IF NOT EXISTS users (
			id            TEXT PRIMARY KEY,
			display_name  TEXT NOT NULL,
			platform_ids  TEXT,
			first_seen_at TEXT NOT NULL,
			modified_at   TEXT NOT NULL,
			deleted       INTEGER DEFAULT 0
		) STRICT
	`);

	// 2. threads
	db.run(`
		CREATE TABLE IF NOT EXISTS threads (
			id               TEXT PRIMARY KEY,
			user_id          TEXT NOT NULL,
			interface        TEXT NOT NULL,
			host_origin      TEXT NOT NULL,
			color            INTEGER DEFAULT 0,
			title            TEXT,
			summary          TEXT,
			summary_through  TEXT,
			summary_model_id TEXT,
			extracted_through TEXT,
			created_at       TEXT NOT NULL,
			last_message_at  TEXT NOT NULL,
			modified_at      TEXT NOT NULL,
			deleted          INTEGER DEFAULT 0
		) STRICT
	`);

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(user_id, last_message_at)
		WHERE deleted = 0
	`);

	// 3. messages
	db.run(`
		CREATE TABLE IF NOT EXISTS messages (
			id          TEXT PRIMARY KEY,
			thread_id   TEXT NOT NULL,
			role        TEXT NOT NULL,
			content     TEXT NOT NULL,
			model_id    TEXT,
			tool_name   TEXT,
			created_at  TEXT NOT NULL,
			modified_at TEXT,
			host_origin TEXT NOT NULL,
			deleted     INTEGER DEFAULT 0
		) STRICT
	`);

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at)
	`);

	// 4. semantic_memory
	db.run(`
		CREATE TABLE IF NOT EXISTS semantic_memory (
			id              TEXT PRIMARY KEY,
			key             TEXT NOT NULL,
			value           TEXT NOT NULL,
			source          TEXT,
			created_at      TEXT NOT NULL,
			modified_at     TEXT NOT NULL,
			last_accessed_at TEXT,
			deleted         INTEGER DEFAULT 0
		) STRICT
	`);

	db.run(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_key ON semantic_memory(key)
		WHERE deleted = 0
	`);

	// 5. tasks
	db.run(`
		CREATE TABLE IF NOT EXISTS tasks (
			id              TEXT PRIMARY KEY,
			type            TEXT NOT NULL,
			status          TEXT NOT NULL,
			trigger_spec    TEXT NOT NULL,
			payload         TEXT,
			created_at      TEXT NOT NULL,
			created_by      TEXT,
			thread_id       TEXT,
			claimed_by      TEXT,
			claimed_at      TEXT,
			lease_id        TEXT,
			next_run_at     TEXT,
			last_run_at     TEXT,
			run_count       INTEGER DEFAULT 0,
			max_runs        INTEGER,
			requires        TEXT,
			model_hint      TEXT,
			no_history      INTEGER DEFAULT 0,
			inject_mode     TEXT DEFAULT 'results',
			depends_on      TEXT,
			require_success INTEGER DEFAULT 0,
			alert_threshold INTEGER DEFAULT 1,
			consecutive_failures INTEGER DEFAULT 0,
			event_depth     INTEGER DEFAULT 0,
			no_quiescence   INTEGER DEFAULT 0,
			heartbeat_at    TEXT,
			result          TEXT,
			error           TEXT,
			modified_at     TEXT NOT NULL,
			deleted         INTEGER DEFAULT 0
		) STRICT
	`);

	// 6. files
	db.run(`
		CREATE TABLE IF NOT EXISTS files (
			id          TEXT PRIMARY KEY,
			path        TEXT NOT NULL,
			content     TEXT,
			is_binary   INTEGER DEFAULT 0,
			size_bytes  INTEGER NOT NULL,
			created_at  TEXT NOT NULL,
			modified_at TEXT NOT NULL,
			deleted     INTEGER DEFAULT 0,
			created_by  TEXT,
			host_origin TEXT
		) STRICT
	`);

	db.run(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_files_path ON files(path)
		WHERE deleted = 0
	`);

	// 7. hosts
	db.run(`
		CREATE TABLE IF NOT EXISTS hosts (
			site_id      TEXT PRIMARY KEY,
			host_name    TEXT NOT NULL,
			version      TEXT,
			sync_url     TEXT,
			mcp_servers  TEXT,
			mcp_tools    TEXT,
			models       TEXT,
			overlay_root TEXT,
			online_at    TEXT,
			modified_at  TEXT NOT NULL,
			platforms    TEXT,
			deleted      INTEGER DEFAULT 0
		) STRICT
	`);

	// 8. overlay_index
	db.run(`
		CREATE TABLE IF NOT EXISTS overlay_index (
			id           TEXT PRIMARY KEY,
			site_id      TEXT NOT NULL,
			path         TEXT NOT NULL,
			size_bytes   INTEGER NOT NULL,
			content_hash TEXT,
			indexed_at   TEXT NOT NULL,
			deleted      INTEGER DEFAULT 0
		) STRICT
	`);

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_overlay_site_path ON overlay_index(site_id, path)
		WHERE deleted = 0
	`);

	// 9. cluster_config
	db.run(`
		CREATE TABLE IF NOT EXISTS cluster_config (
			key         TEXT PRIMARY KEY,
			value       TEXT NOT NULL,
			modified_at TEXT NOT NULL
		) STRICT
	`);

	// 10. advisories
	db.run(`
		CREATE TABLE IF NOT EXISTS advisories (
			id          TEXT PRIMARY KEY,
			type        TEXT NOT NULL,
			status      TEXT NOT NULL,
			title       TEXT NOT NULL,
			detail      TEXT NOT NULL,
			action      TEXT,
			impact      TEXT,
			evidence    TEXT,
			proposed_at TEXT NOT NULL,
			defer_until TEXT,
			resolved_at TEXT,
			created_by  TEXT,
			modified_at TEXT NOT NULL,
			deleted     INTEGER DEFAULT 0
		) STRICT
	`);

	// 11. skills
	db.run(`
		CREATE TABLE IF NOT EXISTS skills (
			id                TEXT PRIMARY KEY,
			name              TEXT NOT NULL,
			description       TEXT NOT NULL,
			status            TEXT NOT NULL,
			skill_root        TEXT NOT NULL,
			content_hash      TEXT,
			allowed_tools     TEXT,
			compatibility     TEXT,
			metadata_json     TEXT,
			activated_at      TEXT,
			created_by_thread TEXT,
			activation_count  INTEGER DEFAULT 0,
			last_activated_at TEXT,
			retired_by        TEXT,
			retired_reason    TEXT,
			modified_at       TEXT NOT NULL,
			deleted           INTEGER DEFAULT 0
		) STRICT
	`);

	db.run(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name ON skills(name)
			WHERE deleted = 0
	`);

	// 12. change_log (non-replicated, local-only)
	db.run(`
		CREATE TABLE IF NOT EXISTS change_log (
			seq        INTEGER PRIMARY KEY AUTOINCREMENT,
			table_name TEXT NOT NULL,
			row_id     TEXT NOT NULL,
			site_id    TEXT NOT NULL,
			timestamp  TEXT NOT NULL,
			row_data   TEXT NOT NULL
		) STRICT
	`);

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_changelog_seq ON change_log(seq)
	`);

	// 13. sync_state (non-replicated, local-only)
	db.run(`
		CREATE TABLE IF NOT EXISTS sync_state (
			peer_site_id TEXT PRIMARY KEY,
			last_received INTEGER NOT NULL,
			last_sent     INTEGER NOT NULL,
			last_sync_at  TEXT,
			sync_errors   INTEGER DEFAULT 0
		) STRICT
	`);

	// 14. host_meta (non-replicated, local-only)
	db.run(`
		CREATE TABLE IF NOT EXISTS host_meta (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		) STRICT
	`);

	// 15. relay_outbox (non-replicated, local-only)
	db.run(`
		CREATE TABLE IF NOT EXISTS relay_outbox (
			id              TEXT PRIMARY KEY,
			source_site_id  TEXT,
			target_site_id  TEXT NOT NULL,
			kind            TEXT NOT NULL,
			ref_id          TEXT,
			idempotency_key TEXT,
			payload         TEXT NOT NULL,
			created_at      TEXT NOT NULL,
			expires_at      TEXT NOT NULL,
			delivered       INTEGER DEFAULT 0
		) STRICT
	`);

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_relay_outbox_target
		ON relay_outbox(target_site_id, delivered)
		WHERE delivered = 0
	`);

	// 16. relay_inbox (non-replicated, local-only)
	db.run(`
		CREATE TABLE IF NOT EXISTS relay_inbox (
			id              TEXT PRIMARY KEY,
			source_site_id  TEXT NOT NULL,
			kind            TEXT NOT NULL,
			ref_id          TEXT,
			idempotency_key TEXT,
			payload         TEXT NOT NULL,
			expires_at      TEXT NOT NULL,
			received_at     TEXT NOT NULL,
			processed       INTEGER DEFAULT 0
		) STRICT
	`);

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_relay_inbox_unprocessed
		ON relay_inbox(processed)
		WHERE processed = 0
	`);

	// 17. relay_cycles (non-replicated, local-only)
	db.run(`
		CREATE TABLE IF NOT EXISTS relay_cycles (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			direction TEXT NOT NULL,
			peer_site_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			delivery_method TEXT NOT NULL,
			latency_ms INTEGER,
			expired INTEGER NOT NULL DEFAULT 0,
			success INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		) STRICT
	`);

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_relay_cycles_created
		ON relay_cycles(created_at)
	`);

	// stream_id column migrations (idempotent — ignore if column already exists)
	try {
		db.run("ALTER TABLE relay_outbox ADD COLUMN stream_id TEXT");
	} catch {
		/* already exists */
	}
	try {
		db.run("ALTER TABLE relay_inbox  ADD COLUMN stream_id TEXT");
	} catch {
		/* already exists */
	}
	try {
		db.run("ALTER TABLE relay_cycles ADD COLUMN stream_id TEXT");
	} catch {
		/* already exists */
	}

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_relay_outbox_stream
		ON relay_outbox(stream_id)
		WHERE stream_id IS NOT NULL
	`);

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_relay_inbox_stream
		ON relay_inbox(stream_id, processed)
		WHERE stream_id IS NOT NULL AND processed = 0
	`);

	// ── Platform connector migrations (Phase 1) ──────────────────────────────

	// Add platform_ids column to users (replaces discord_id)
	try {
		db.run("ALTER TABLE users ADD COLUMN platform_ids TEXT");
	} catch {
		/* already exists */
	}

	// Migrate existing discord_id values → platform_ids JSON {"discord":"<id>"}
	// Safe to re-run: WHERE clause skips rows already migrated
	// Uses PRAGMA table_info to check if discord_id column still exists before migrating
	try {
		db.run(
			`UPDATE users
			 SET    platform_ids = json_object('discord', discord_id)
			 WHERE  discord_id IS NOT NULL
			   AND  platform_ids IS NULL`,
		);
	} catch {
		/* discord_id column doesn't exist (fresh install or already migrated) */
	}

	// Drop the discord index BEFORE dropping the column
	// (SQLite rejects DROP COLUMN on indexed columns)
	db.run("DROP INDEX IF EXISTS idx_users_discord");

	// Drop the discord_id column
	// (Requires SQLite 3.35.0+; Bun bundles 3.51.0)
	try {
		db.run("ALTER TABLE users DROP COLUMN discord_id");
	} catch {
		/* already dropped, or column does not exist on fresh install */
	}

	// Add platforms column to hosts
	try {
		db.run("ALTER TABLE hosts ADD COLUMN platforms TEXT");
	} catch {
		/* already exists */
	}

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_memory_modified ON semantic_memory(modified_at DESC)
	`);

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_tasks_last_run ON tasks(last_run_at DESC)
		WHERE deleted = 0 AND last_run_at IS NOT NULL
	`);
}
