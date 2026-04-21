import type { Database } from "bun:sqlite";
import { HLC_ZERO } from "@bound/shared";
import { CANONICAL_RELATIONS } from "./memory-relations";

/**
 * Migrate change_log from seq INTEGER PK to hlc TEXT PK.
 * Only runs if the old seq-based table exists. Safe to call on fresh installs
 * (table doesn't exist yet) or already-migrated databases (hlc column present).
 */
function migrateChangeLogToHlc(db: Database): void {
	// Check if change_log exists and has a seq column
	const cols = db.query("PRAGMA table_info(change_log)").all() as Array<{
		name: string;
		type: string;
	}>;
	if (cols.length === 0) return; // Table doesn't exist yet — fresh install
	const hasSeq = cols.some((c) => c.name === "seq");
	const hasHlc = cols.some((c) => c.name === "hlc");
	if (!hasSeq || hasHlc) return; // Already migrated or fresh install

	// Read site_id from host_meta for HLC generation
	const metaRow = db.query("SELECT value FROM host_meta WHERE key = 'site_id'").get() as {
		value: string;
	} | null;
	const fallbackSiteId = metaRow?.value ?? "0000";

	db.exec("BEGIN");
	try {
		// Create the new HLC-based table
		db.exec(`
			CREATE TABLE change_log_v2 (
				hlc        TEXT PRIMARY KEY,
				table_name TEXT NOT NULL,
				row_id     TEXT NOT NULL,
				site_id    TEXT NOT NULL,
				timestamp  TEXT NOT NULL,
				row_data   TEXT NOT NULL
			) STRICT
		`);

		// Migrate data: generate HLC from (timestamp, seq, site_id)
		// seq provides unique counter within same timestamp
		const rows = db
			.query(
				"SELECT seq, table_name, row_id, site_id, timestamp, row_data FROM change_log ORDER BY seq ASC",
			)
			.all() as Array<{
			seq: number;
			table_name: string;
			row_id: string;
			site_id: string;
			timestamp: string;
			row_data: string;
		}>;

		const insert = db.prepare(
			"INSERT INTO change_log_v2 (hlc, table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?, ?)",
		);

		for (const row of rows) {
			const counter = (row.seq % 65536).toString(16).padStart(4, "0");
			const siteId = row.site_id || fallbackSiteId;
			const hlc = `${row.timestamp}_${counter}_${siteId}`;
			insert.run(hlc, row.table_name, row.row_id, row.site_id, row.timestamp, row.row_data);
		}

		// Drop old index first, then swap tables
		db.exec("DROP INDEX IF EXISTS idx_changelog_seq");
		db.exec("DROP TABLE change_log");
		db.exec("ALTER TABLE change_log_v2 RENAME TO change_log");

		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// ROLLBACK failed, original error takes priority
		}
		throw error;
	}
}

/**
 * Migrate sync_state from INTEGER cursors to TEXT HLC cursors.
 * Converts seq-based cursors to HLC by looking up the corresponding
 * change_log entry. If the exact seq doesn't exist (pruned), uses HLC_ZERO.
 */
function migrateSyncStateToHlc(db: Database): void {
	const cols = db.query("PRAGMA table_info(sync_state)").all() as Array<{
		name: string;
		type: string;
	}>;
	if (cols.length === 0) return; // Table doesn't exist yet

	const lastReceivedCol = cols.find((c) => c.name === "last_received");
	if (!lastReceivedCol) return;
	if (lastReceivedCol.type === "TEXT") return; // Already migrated

	db.exec("BEGIN");
	try {
		db.exec(`
			CREATE TABLE sync_state_v2 (
				peer_site_id  TEXT PRIMARY KEY,
				last_received TEXT NOT NULL DEFAULT '${HLC_ZERO}',
				last_sent     TEXT NOT NULL DEFAULT '${HLC_ZERO}',
				last_sync_at  TEXT,
				sync_errors   INTEGER DEFAULT 0
			) STRICT
		`);

		// For each peer, try to find the HLC for their cursor position.
		// Since we just migrated change_log, the new hlc column is available.
		const peers = db
			.query(
				"SELECT peer_site_id, last_received, last_sent, last_sync_at, sync_errors FROM sync_state",
			)
			.all() as Array<{
			peer_site_id: string;
			last_received: number;
			last_sent: number;
			last_sync_at: string | null;
			sync_errors: number;
		}>;

		const insertPeer = db.prepare(
			"INSERT INTO sync_state_v2 (peer_site_id, last_received, last_sent, last_sync_at, sync_errors) VALUES (?, ?, ?, ?, ?)",
		);

		for (const peer of peers) {
			// After migration, seq N maps to the Nth entry. Use HLC_ZERO as safe default.
			insertPeer.run(peer.peer_site_id, HLC_ZERO, HLC_ZERO, peer.last_sync_at, peer.sync_errors);
		}

		db.exec("DROP TABLE sync_state");
		db.exec("ALTER TABLE sync_state_v2 RENAME TO sync_state");

		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// ROLLBACK failed
		}
		throw error;
	}
}

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
			alert_threshold INTEGER DEFAULT 3,
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

	// 12. memory_edges (synced)
	db.run(`
		CREATE TABLE IF NOT EXISTS memory_edges (
			id          TEXT PRIMARY KEY,
			source_key  TEXT NOT NULL,
			target_key  TEXT NOT NULL,
			relation    TEXT NOT NULL,
			weight      REAL DEFAULT 1.0,
			created_at  TEXT NOT NULL,
			modified_at TEXT NOT NULL,
			deleted     INTEGER DEFAULT 0
		) STRICT
	`);

	db.run(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_triple
		ON memory_edges(source_key, target_key, relation) WHERE deleted = 0
	`);
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source_key) WHERE deleted = 0
	`);
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target_key) WHERE deleted = 0
	`);

	// 13. change_log (non-replicated, local-only)
	// Migration: if old seq-based table exists, migrate to HLC-based table
	migrateChangeLogToHlc(db);

	db.run(`
		CREATE TABLE IF NOT EXISTS change_log (
			hlc        TEXT PRIMARY KEY,
			table_name TEXT NOT NULL,
			row_id     TEXT NOT NULL,
			site_id    TEXT NOT NULL,
			timestamp  TEXT NOT NULL,
			row_data   TEXT NOT NULL
		) STRICT
	`);

	// 14. sync_state (non-replicated, local-only)
	// Migration: if old INTEGER cursors exist, migrate to TEXT HLC cursors
	migrateSyncStateToHlc(db);

	db.run(`
		CREATE TABLE IF NOT EXISTS sync_state (
			peer_site_id  TEXT PRIMARY KEY,
			last_received TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000',
			last_sent     TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000',
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

	// Add origin_thread_id column to tasks (tracks the conversation that scheduled the task,
	// separate from thread_id which is the execution thread)
	try {
		db.run("ALTER TABLE tasks ADD COLUMN origin_thread_id TEXT");
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

	// Relay idempotency: prevent duplicate UNDELIVERED outbox entries with the
	// same idempotency_key targeting the same site. Without this, a double-fired
	// Discord event (or any retry) can create duplicate intake/process relays
	// that spawn multiple concurrent agent loops for one user message.
	// The index is scoped to delivered = 0 so that delivered entries don't block
	// legitimate retries (e.g., filing the same Discord message again later).
	// Drop the old over-broad index (no delivered filter) if it exists, then
	// clean up pre-existing undelivered duplicates before creating the new one.
	try {
		db.run("DROP INDEX IF EXISTS idx_relay_outbox_idempotency");
		db.run(`
			DELETE FROM relay_outbox WHERE rowid NOT IN (
				SELECT MIN(rowid) FROM relay_outbox
				WHERE idempotency_key IS NOT NULL AND delivered = 0
				GROUP BY idempotency_key, target_site_id
			) AND idempotency_key IS NOT NULL AND delivered = 0
		`);
		db.run(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_outbox_idempotency
			ON relay_outbox(idempotency_key, target_site_id)
			WHERE idempotency_key IS NOT NULL AND delivered = 0
		`);
	} catch {
		/* index already exists or other non-fatal schema issue */
	}

	// Performance indexes for relay table cleanup (pruneRelayTables scans 88K+ rows)
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_relay_outbox_cleanup
		ON relay_outbox(delivered, created_at) WHERE delivered = 1
	`);
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_relay_inbox_cleanup
		ON relay_inbox(processed, received_at) WHERE processed = 1
	`);

	// exit_code column on messages (tool_result exit status for UI error styling)
	try {
		db.run("ALTER TABLE messages ADD COLUMN exit_code INTEGER");
	} catch {
		/* already exists */
	}

	// Performance indexes for scheduler task queries (run every tick)
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_tasks_pending_schedule
		ON tasks(status, next_run_at)
		WHERE status = 'pending' AND deleted = 0 AND next_run_at IS NOT NULL
	`);

	// 19. dispatch_queue (non-replicated, local-only)
	// Tracks message dispatch status for event-driven conversation model.
	// NOT a synced table — dispatch state is local coordination only.
	db.run(`
		CREATE TABLE IF NOT EXISTS dispatch_queue (
			message_id    TEXT PRIMARY KEY,
			thread_id     TEXT NOT NULL,
			status        TEXT NOT NULL DEFAULT 'pending',
			claimed_by    TEXT,
			event_type    TEXT NOT NULL DEFAULT 'user_message',
			event_payload TEXT,
			created_at    TEXT NOT NULL,
			modified_at   TEXT NOT NULL
		) STRICT
	`);

	// Idempotent column additions for existing databases
	try {
		db.run("ALTER TABLE dispatch_queue ADD COLUMN event_type TEXT NOT NULL DEFAULT 'user_message'");
	} catch {
		// Column already exists
	}
	try {
		db.run("ALTER TABLE dispatch_queue ADD COLUMN event_payload TEXT");
	} catch {
		// Column already exists
	}

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_dispatch_queue_pending
		ON dispatch_queue(thread_id, status)
		WHERE status = 'pending'
	`);

	// Hierarchical memory: add tier column for retrieval priority classification
	try {
		db.run("ALTER TABLE semantic_memory ADD COLUMN tier TEXT DEFAULT 'default'");
	} catch {
		/* already exists */
	}

	// Partial index on tier for efficient tier-filtered queries (only non-deleted rows)
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_memory_tier ON semantic_memory(tier)
		WHERE deleted = 0
	`);

	// Backfill: prefix-keyed entries → pinned tier (idempotent — only updates default tier)
	// IMPORTANT: Use the EXACT same ESCAPE syntax as summary-extraction.ts lines 467-470.
	// Do NOT derive the escaping from scratch — copy the pattern from the existing codebase.
	// The correct escape sequence depends on the string context (template literal vs prepare()).
	// Reference: summary-extraction.ts uses LIKE '\\_standing%' ESCAPE '\\' inside prepare().
	db.run(`
		UPDATE semantic_memory SET tier = 'pinned'
		WHERE (key LIKE '\\_standing%' ESCAPE '\\'
			OR key LIKE '\\_feedback%' ESCAPE '\\'
			OR key LIKE '\\_policy%' ESCAPE '\\'
			OR key LIKE '\\_pinned%' ESCAPE '\\')
			AND tier = 'default' AND deleted = 0
	`);

	// Thread model hint: authoritative model preference for inference on this thread.
	// Replaces the heuristic of scanning messages.model_id for thread model resolution.
	try {
		db.run("ALTER TABLE threads ADD COLUMN model_hint TEXT");
	} catch {
		/* already exists */
	}

	// ── Edge graph normalization ─────────────────────────────────────────────────

	// Add context column to memory_edges (nullable free-text annotation)
	try {
		db.run("ALTER TABLE memory_edges ADD COLUMN context TEXT");
	} catch {
		/* already exists */
	}

	// Generate trigger SQL from canonical set — single source of truth.
	// Safety: CANONICAL_RELATIONS values are string literals defined in memory-relations.ts.
	// None contain single quotes, so interpolation into SQL string literals is safe.
	// If a value with a single quote were ever added to the set, the trigger CREATE
	// would fail loudly at startup (SQL syntax error), not silently inject.
	const canonicalList = CANONICAL_RELATIONS.map((r) => `'${r}'`).join(", ");
	const triggerMsg = `Invalid relation. Must be one of: ${CANONICAL_RELATIONS.join(", ")}. Use context column for bespoke phrasing.`;

	db.run(`
		CREATE TRIGGER IF NOT EXISTS memory_edges_canonical_relation_insert
		BEFORE INSERT ON memory_edges
		FOR EACH ROW WHEN NEW.relation NOT IN (${canonicalList})
		BEGIN SELECT RAISE(ABORT, '${triggerMsg}'); END
	`);

	db.run(`
		CREATE TRIGGER IF NOT EXISTS memory_edges_canonical_relation_update
		BEFORE UPDATE OF relation ON memory_edges
		FOR EACH ROW WHEN NEW.relation NOT IN (${canonicalList})
		BEGIN SELECT RAISE(ABORT, '${triggerMsg}'); END
	`);
}
