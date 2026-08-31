import type { Database } from "bun:sqlite";
import { HLC_ZERO } from "@bound/shared";
import { SYNCED_TABLE_NAMES, getPkColumn, validateColumnName } from "./change-log.js";
import { CANONICAL_RELATIONS } from "./memory-relations";
import { hasDroppedLegacyRelayTables } from "./relay";

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
	if (cols.length === 0) return; // Table doesn't exist yet â fresh install
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

/**
 * Add a column to an existing table if it is absent.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing database, so a column
 * declared inline in the CREATE never materializes on an upgrade path. Any index
 * or trigger created later in `applySchema` that references such a column then
 * fails with "no such column" â on existing installs only, while fresh installs
 * stay green. #201 hit exactly that: `agent_id` was declared inline on
 * semantic_memory / memory_edges / threads and the composite unique indexes
 * referencing it are created immediately after the CREATE, ~500 lines before the
 * ALTER migration block near the end of this function.
 *
 * Detect via PRAGMA table_info rather than try/catch so a genuine failure still
 * throws instead of being swallowed as "already exists".
 */
function ensureColumn(db: Database, table: string, column: string, type = "TEXT"): void {
	const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	if (cols.length === 0) return; // table doesn't exist yet â CREATE will carry the column
	if (cols.some((c) => c.name === column)) return;
	db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * Rebuild the local durable spool when upgrading from the 4A shape. SQLite
 * cannot alter a CHECK constraint, so adding `consumed` needs a table swap.
 */
function migrateDurableWorkForConsumedState(db: Database): void {
	const columns = db.query("PRAGMA table_info(durable_work)").all() as Array<{ name: string }>;
	if (columns.length === 0 || columns.some((column) => column.name === "consumed_at")) return;

	db.exec("BEGIN");
	try {
		db.exec(`CREATE TABLE durable_work_new (
			id TEXT PRIMARY KEY,
			target_site_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			payload TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			claim_state TEXT NOT NULL DEFAULT 'pending' CHECK (claim_state IN ('pending', 'processing', 'transferring', 'consumed', 'dead_letter')),
			claim_token TEXT,
			claimed_at TEXT,
			attempt_count INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			created_at TEXT NOT NULL,
			expires_at TEXT,
			dead_lettered_at TEXT,
			consumed_at TEXT,
			ref_id TEXT,
			source_site TEXT,
			received_at TEXT,
			stream_id TEXT
		) STRICT`);
		db.exec(`INSERT INTO durable_work_new (
			id, target_site_id, kind, payload, idempotency_key, claim_state,
			claim_token, claimed_at, attempt_count, last_error, created_at, expires_at, dead_lettered_at
		) SELECT id, target_site_id, kind, payload, idempotency_key, claim_state,
			claim_token, claimed_at, attempt_count, last_error, created_at, expires_at, dead_lettered_at
			FROM durable_work`);
		db.exec("DROP TABLE durable_work");
		db.exec("ALTER TABLE durable_work_new RENAME TO durable_work");
		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}

export function installRowHashInvalidationTriggers(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS row_state_hashes (
			table_name TEXT NOT NULL, pk TEXT NOT NULL, state_hash TEXT NOT NULL, hashed_at TEXT NOT NULL,
			PRIMARY KEY (table_name, pk)
		) STRICT, WITHOUT ROWID
	`);
	for (const table of SYNCED_TABLE_NAMES) {
		const exists = db
			.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(table);
		if (!exists) continue;
		validateColumnName(table);
		const pk = getPkColumn(table);
		validateColumnName(pk);
		for (const [operation, reference] of [
			["insert", "NEW"],
			["update", "NEW"],
			["delete", "OLD"],
		] as const) {
			db.run(
				`CREATE TRIGGER IF NOT EXISTS rsh_inv_${table}_${operation} AFTER ${operation.toUpperCase()} ON ${table} BEGIN DELETE FROM row_state_hashes WHERE table_name = '${table}' AND pk = ${reference}.${pk}; END`,
			);
		}
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
			deleted          INTEGER DEFAULT 0,
			agent_id         TEXT, -- #201: NULL = main agent; non-null = aux identity
			parent_thread_id TEXT  -- #201: dispatching parent thread for aux conversations
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
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_messages_consistency
		ON messages(id, modified_at, role) WHERE role != 'system'
	`);

	// Context assembly and web history repeatedly fetch live thread messages in
	// chronological order. The general index above includes tombstones, so this
	// partial index keeps the hot live-only path compact and ordered.
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_messages_live_thread_created
		ON messages(thread_id, created_at)
		WHERE deleted = 0
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
			deleted         INTEGER DEFAULT 0,
			agent_id        TEXT -- #201: NULL = main agent; auxiliary-agent namespace partition
		) STRICT
	`);

	// #201: uniqueness moves from `key` alone to `(agent_id, key)` so two
	// namespaces can reuse the same key. Drop the old single-column index on
	// existing installations, then create the composite.
	//
	// ensureColumn FIRST: on an upgrade the CREATE above was a no-op, so the
	// inline agent_id never materialized and the composite index below would
	// fail with "no such column: agent_id".
	ensureColumn(db, "semantic_memory", "agent_id");
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_semantic_memory_consistency
		ON semantic_memory(id, modified_at)
	`);
	db.run("DROP INDEX IF EXISTS idx_memory_key");
	db.run(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_key
		ON semantic_memory(agent_id, key) WHERE deleted = 0
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
			commit_hash  TEXT,
			sync_url     TEXT,
			mcp_servers  TEXT,
			mcp_tools    TEXT,
			mcp_tool_annotations TEXT,
			mcp_capabilities TEXT,
			work_spool_capable INTEGER NOT NULL DEFAULT 0,
			models       TEXT,
			online_at    TEXT,
			modified_at  TEXT NOT NULL,
			platforms    TEXT,
			deleted      INTEGER DEFAULT 0
		) STRICT
	`);

	// 8. cluster_config

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
			thread_id   TEXT,
			resolved_by      TEXT,
			resolution_note  TEXT,
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
			skill_root        TEXT NOT NULL,
			content_hash      TEXT,
			allowed_tools     TEXT,
			compatibility     TEXT,
			metadata_json     TEXT,
			activated_at      TEXT,
			created_by_thread TEXT,
			activation_count  INTEGER DEFAULT 0,
			last_activated_at TEXT,
			modified_at       TEXT NOT NULL,
			deleted           INTEGER DEFAULT 0
		) STRICT
	`);

	db.run(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name ON skills(name)
			WHERE deleted = 0
	`);

	// 11b. agents (#201) â durable, persona-scoped auxiliary-agent identities.
	// Shaped like `skills` (synced LWW, cluster-wide): an identity defined on one
	// host is invocable from any thread on any host, and its memory namespace
	// travels with it. `retired_at` is domain state (hidden from list/invoke,
	// namespace still readable) and is deliberately distinct from `deleted`, which
	// stays a pure sync tombstone â conflating them would make retirement
	// indistinguishable from removal at the sync layer. `name` carries NO UNIQUE
	// index (unlike skills): synced tables can't enforce cluster-wide uniqueness,
	// so two hosts defining the same name offline must both converge, not break
	// sync; dispatch resolves name â non-retired/non-deleted with a deterministic
	// modified_at DESC tiebreak, and `list` surfaces duplicates for cleanup.
	db.run(`
		CREATE TABLE IF NOT EXISTS agents (
			id                TEXT PRIMARY KEY,
			name              TEXT NOT NULL,
			persona           TEXT NOT NULL,
			tools             TEXT,
			model_hint        TEXT,
			retired_at        TEXT,
			created_by_thread TEXT,
			created_at        TEXT NOT NULL,
			modified_at       TEXT NOT NULL,
			deleted           INTEGER DEFAULT 0
		) STRICT
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
			deleted     INTEGER DEFAULT 0,
			agent_id    TEXT, -- #201: NULL = main agent; edges never cross namespaces
			context     TEXT
		) STRICT
	`);

	// #201: uniqueness moves from (source, target, relation) to
	// (source, target, relation, agent_id) so two namespaces can have the
	// same edge triple. Drop the old index on existing installs.
	//
	// ensureColumn FIRST for the same reason as semantic_memory above: the
	// CREATE is a no-op on an upgrade, so the inline agent_id never lands and
	// the composite index below fails with "no such column: agent_id".
	ensureColumn(db, "memory_edges", "agent_id");
	db.run("DROP INDEX IF EXISTS idx_edges_triple");
	db.run(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_triple
		ON memory_edges(source_key, target_key, relation, agent_id) WHERE deleted = 0
	`);
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source_key) WHERE deleted = 0
	`);
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target_key) WHERE deleted = 0
	`);

	// 13. connector_handles (synced)
	db.run(`
		CREATE TABLE IF NOT EXISTS connector_handles (
			id            TEXT PRIMARY KEY,
			server_name   TEXT NOT NULL,
			event_name    TEXT NOT NULL,
			event_args    TEXT NOT NULL,
			delivery_mode TEXT NOT NULL,
			cursor        TEXT,
			task_id       TEXT,
			created_at    TEXT NOT NULL,
			deleted       INTEGER NOT NULL DEFAULT 0,
			modified_at   TEXT NOT NULL
		) STRICT
	`);

	// 14. webhooks (synced) â HMAC-authenticated HTTP endpoints that trigger agent tasks
	db.run(`
		CREATE TABLE IF NOT EXISTS webhooks (
			id               TEXT PRIMARY KEY,
			name             TEXT NOT NULL,
			secret           TEXT NOT NULL,
			signature_format TEXT NOT NULL DEFAULT 'github',
			description      TEXT,
			task_id          TEXT NOT NULL,
			thread_id        TEXT NOT NULL,
			created_at       TEXT NOT NULL,
			deleted          INTEGER NOT NULL DEFAULT 0,
			modified_at      TEXT NOT NULL
		) STRICT
	`);

	db.run(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_webhooks_name
		ON webhooks(name) WHERE deleted = 0
	`);

	// 14a. rss_feeds (synced) â polled RSS/Atom feeds that trigger agent tasks.
	// Mirrors the webhook three-row pattern (feed row + delivery thread + event
	// task with trigger_spec `rss:<name>`), but items are PULLED by the
	// leader-gated poller in @bound/platforms rather than pushed over HTTP.
	// `seen_guids` is the durable dedup cursor (JSON array, newest last, capped)
	// â relay_inbox idempotency keys are pruned with the inbox, so seen-state
	// must live on the synced row to survive leader failover.
	db.run(`
		CREATE TABLE IF NOT EXISTS rss_feeds (
			id                    TEXT PRIMARY KEY,
			name                  TEXT NOT NULL,
			url                   TEXT NOT NULL,
			description           TEXT,
			poll_interval_seconds INTEGER NOT NULL DEFAULT 900,
			seen_guids            TEXT,
			task_id               TEXT NOT NULL,
			thread_id             TEXT NOT NULL,
			created_at            TEXT NOT NULL,
			deleted               INTEGER NOT NULL DEFAULT 0,
			modified_at           TEXT NOT NULL
		) STRICT
	`);

	db.run(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_rss_feeds_name
		ON rss_feeds(name) WHERE deleted = 0
	`);

	// 14b. client_sessions (synced) â tracks which host holds the live WS
	// connection (boundless / external BoundClient) subscribed to a thread, so
	// notify/introspect wakeups can be routed to the host that can actually
	// supply the thread's client tools. See invariant #21 (client-session
	// affinity) and issue #91.
	db.run(`
		CREATE TABLE IF NOT EXISTS client_sessions (
			id            TEXT PRIMARY KEY,
			connection_id TEXT NOT NULL,
			thread_id     TEXT NOT NULL,
			site_id       TEXT NOT NULL,
			created_at    TEXT NOT NULL,
			deleted       INTEGER NOT NULL DEFAULT 0,
			modified_at   TEXT NOT NULL
		) STRICT
	`);

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_client_sessions_thread
		ON client_sessions(thread_id) WHERE deleted = 0
	`);

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_client_sessions_connection
		ON client_sessions(connection_id) WHERE deleted = 0
	`);

	// 15. change_log (non-replicated, local-only)
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

	// 16. sync_state (non-replicated, local-only)
	// Migration: if old INTEGER cursors exist, migrate to TEXT HLC cursors
	migrateSyncStateToHlc(db);

	db.run(`
		CREATE TABLE IF NOT EXISTS sync_state (
			peer_site_id   TEXT PRIMARY KEY,
			last_received  TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000',
			last_sent      TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000',
			last_confirmed TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000',
			last_sync_at   TEXT,
			sync_errors    INTEGER DEFAULT 0
		) STRICT
	`);

	// last_confirmed column migration (idempotent â ignore if column already
	// exists). Distinct from last_sent (optimistic) and last_received (inbound):
	// last_confirmed is the peer-acknowledged watermark, advanced ONLY on
	// changelog_ack, and is the sole anchor authority for delegation range
	// segments (R-UD7/R-UD11). See docs/design/specs/2026-06-29-unified-delegation.md.
	try {
		db.run(
			"ALTER TABLE sync_state ADD COLUMN last_confirmed TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z_0000_0000'",
		);
	} catch {
		/* already exists */
	}

	// 17. host_meta (non-replicated, local-only)
	db.run(`
		CREATE TABLE IF NOT EXISTS host_meta (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		) STRICT
	`);

	// 17b. local_flags (non-replicated, local-only): per-host one-way lifecycle
	// markers that must NOT sync. A spoke that drops its legacy relay tables
	// (slice 4E gated drop) records the fact here so every legacy code path can
	// early-return instead of touching a table that no longer exists on THIS
	// host. Distinct from host_meta (reserved for site_id/HLC bootstrap identity)
	// so the flag namespace stays independent of bootstrap identity.
	db.run(`
		CREATE TABLE IF NOT EXISTS local_flags (
			key        TEXT PRIMARY KEY,
			value      TEXT NOT NULL,
			set_at     TEXT NOT NULL
		) STRICT
	`);

	// 18-19. relay_outbox / relay_inbox (non-replicated, local-only). Slice 4E:
	// once this host retires its legacy relay tables (one-way local_flags marker,
	// set inside dropLegacyRelayTables), a restart must NOT resurrect them — the
	// durable_work spool is the sole store post-drop. The marker is read from the
	// SAME db, and local_flags is created above (§17b) so the read sees the table.
	// relay_cycles (§20, retained telemetry) is created unconditionally below.
	const legacyRelayRetired = hasDroppedLegacyRelayTables(db);
	if (!legacyRelayRetired) {
		// 18. relay_outbox (non-replicated, local-only)
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

		// 19. relay_inbox (non-replicated, local-only)
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

		// Event-task wakeups drain inbox entries by (ref_id, kind) in receive
		// order. This avoids scanning every unprocessed relay row as backlog grows.
		db.run(`
		CREATE INDEX IF NOT EXISTS idx_relay_inbox_ref_unprocessed_received
		ON relay_inbox(ref_id, kind, received_at)
		WHERE processed = 0
	`);

		db.run(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_inbox_idempotency
		ON relay_inbox(idempotency_key)
		WHERE idempotency_key IS NOT NULL
	`);
	}

	migrateDurableWorkForConsumedState(db);

	// durable_work (non-replicated, local-only): the additive per-host spool.
	// It intentionally has no change-log integration; see R-DW19.
	db.run(`
		CREATE TABLE IF NOT EXISTS durable_work (
			id TEXT PRIMARY KEY,
			target_site_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			payload TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			claim_state TEXT NOT NULL DEFAULT 'pending' CHECK (claim_state IN ('pending', 'processing', 'transferring', 'consumed', 'dead_letter')),
			claim_token TEXT,
			claimed_at TEXT,
			attempt_count INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			created_at TEXT NOT NULL,
			expires_at TEXT,
			dead_lettered_at TEXT,
			consumed_at TEXT,
			ref_id TEXT,
			source_site TEXT,
			received_at TEXT,
			stream_id TEXT
		) STRICT
	`);
	ensureColumn(db, "durable_work", "ref_id");
	ensureColumn(db, "durable_work", "source_site");
	ensureColumn(db, "durable_work", "received_at");
	ensureColumn(db, "durable_work", "stream_id");

	db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_work_kind_key
		ON durable_work(kind, idempotency_key)`);
	db.run(`CREATE INDEX IF NOT EXISTS idx_durable_work_claimable
		ON durable_work(target_site_id, claim_state, created_at)
		WHERE claim_state = 'pending'`);
	db.run(`CREATE INDEX IF NOT EXISTS idx_durable_work_expiry
		ON durable_work(expires_at) WHERE expires_at IS NOT NULL`);

	// 20. relay_cycles (non-replicated, local-only)
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

	// stream_id column migrations (idempotent — ignore if column already exists).
	// Slice 4E: skip the relay_outbox/relay_inbox ALTERs + stream indexes on a
	// retired host (the tables are gone); relay_cycles is retained and always runs.
	if (!legacyRelayRetired) {
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
	}
	try {
		db.run("ALTER TABLE relay_cycles ADD COLUMN stream_id TEXT");
	} catch {
		/* already exists */
	}

	if (!legacyRelayRetired) {
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
	}

	// trace_context column migrations for OpenTelemetry trace propagation (idempotent).
	// Slice 4E: skip on a retired host (the tables are gone).
	if (!legacyRelayRetired) {
		try {
			db.run("ALTER TABLE relay_outbox ADD COLUMN trace_context TEXT");
		} catch {
			/* already exists */
		}
		try {
			db.run("ALTER TABLE relay_inbox ADD COLUMN trace_context TEXT");
		} catch {
			/* already exists */
		}
	}

	// ââ Platform connector migrations (Phase 1) ââââââââââââââââââââââââââââââ

	// #93: link an advisory to the thread it originated from so the web UI can
	// navigate operators straight to the source conversation. Idempotent â older
	// databases gain the column on next startup; existing rows default to NULL.
	try {
		db.run("ALTER TABLE advisories ADD COLUMN thread_id TEXT");
	} catch {
		/* already exists */
	}

	// #192: record advisory outcome provenance. `resolved_by` stamps the actor
	// that changed state ("agent" for the advisory tool, an operator user id for
	// the web path); `resolution_note` carries the required rationale/outcome for
	// the transition. Idempotent â older rows default to NULL.
	try {
		db.run("ALTER TABLE advisories ADD COLUMN resolved_by TEXT");
	} catch {
		/* already exists */
	}
	try {
		db.run("ALTER TABLE advisories ADD COLUMN resolution_note TEXT");
	} catch {
		/* already exists */
	}

	// #201: auxiliary-agent columns. All nullable â NULL means the main agent, so
	// every existing row keeps main-agent semantics and no behavior changes until
	// the aux tool starts writing them. Idempotent ALTERs (older DBs gain them on
	// next startup); STRICT tables accept nullable ADD COLUMN cleanly. No FK
	// clauses (invariant #20 â referential integrity by convention on synced
	// tables). Behavioral code identifies aux threads by `agent_id IS NOT NULL`,
	// never by `threads.interface`.
	//   - threads.agent_id / parent_thread_id: an aux conversation is a child
	//     thread carrying its identity and its dispatching parent.
	//   - semantic_memory.agent_id: the hard memory-namespace partition.
	//   - memory_edges.agent_id: load-bearing, not decorative. Edges reference
	//     source_key/target_key (key strings, not row ids), and namespacing
	//     semantic_memory moves key uniqueness from `key` to `(agent_id, key)`;
	//     without a namespace column on the edge, two aux' same-named keys are
	//     indistinguishable at the edge layer. One column IS the
	//     never-cross-namespaces rule, enforced by shape.
	for (const [table, col] of [
		["threads", "agent_id"],
		["threads", "parent_thread_id"],
		["semantic_memory", "agent_id"],
		["memory_edges", "agent_id"],
	] as const) {
		try {
			db.run(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
		} catch {
			/* already exists */
		}
	}

	// Add platform_ids column to users (replaces discord_id)
	try {
		db.run("ALTER TABLE users ADD COLUMN platform_ids TEXT");
	} catch {
		/* already exists */
	}
	// Migrate existing discord_id values â platform_ids JSON {"discord":"<id>"}
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

	// R-DW14: synced binary capability, not local spool state. Existing hosts
	// gain the conservative false value until their next startup registration.
	ensureColumn(db, "hosts", "work_spool_capable", "INTEGER NOT NULL DEFAULT 0");

	// Add platforms column to hosts
	try {
		db.run("ALTER TABLE hosts ADD COLUMN platforms TEXT");
	} catch {
		/* already exists */
	}

	// Add mcp_tool_annotations column to hosts (per-server, per-tool MCP-spec
	// annotations captured from listTools() â used by the agent retry policy
	// to look up target idempotency for relay-routed tool calls).
	// Shape: {[serverName]: {[toolName]: {idempotentHint?, readOnlyHint?}}}
	try {
		db.run("ALTER TABLE hosts ADD COLUMN mcp_tool_annotations TEXT");
	} catch {
		/* already exists */
	}

	// Full per-server MCP capability inventory (serverInfo from the initialize
	// handshake, tools with descriptions, prompts, resources) â the complete
	// surface a server exposes to agents. Rendered by the web UI's
	// Connections â MCP view.
	// Shape: {[serverName]: {serverInfo?, tools?, prompts?, resources?}}
	try {
		db.run("ALTER TABLE hosts ADD COLUMN mcp_capabilities TEXT");
	} catch {
		/* already exists */
	}

	// #120: record each node's build commit hash so `hostinfo` can surface it,
	// letting agents reason about inconsistent cluster behavior across nodes
	// running different builds. Idempotent â older databases gain the column on
	// next startup; existing rows default to NULL until the host re-registers.
	try {
		db.run("ALTER TABLE hosts ADD COLUMN commit_hash TEXT");
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

	// system_prompt_addition column on tasks â persistent prompt injection for
	// event tasks (webhooks, scheduled), replacing ephemeral WS-only mechanism.
	// Read by scheduler and relay processor when building AgentLoopConfig.
	try {
		db.run("ALTER TABLE tasks ADD COLUMN system_prompt_addition TEXT");
	} catch {
		/* already exists */
	}

	// deleted column on cluster_config â brings it under the soft-delete invariant
	// (invariant #2). Existing rows default to live (0). Writers soft-delete via
	// the standard UPDATE-deleted=1 path; live reads filter deleted = 0.
	try {
		db.run("ALTER TABLE cluster_config ADD COLUMN deleted INTEGER DEFAULT 0");
	} catch {
		/* already exists */
	}
	// Drop skills.status / retired_by / retired_reason (idempotent).
	// The `retire` operation and status filtering were removed; the only skill
	// states are live (deleted = 0) and tombstoned (deleted = 1), so these
	// three columns carry no information. On existing DBs they are dropped here;
	// fresh installs never create them (see the CREATE TABLE above). DDL only â
	// not a synced row write, so raw db.run is correct (cf. the discord_id drop).
	// None are indexed (the unique index is on `name`), so DROP COLUMN succeeds.
	// (Requires SQLite 3.35.0+; Bun bundles 3.51.0.)
	for (const col of ["status", "retired_by", "retired_reason"]) {
		try {
			db.run(`ALTER TABLE skills DROP COLUMN ${col}`);
		} catch {
			/* already dropped, or column does not exist on fresh install */
		}
	}

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_memory_modified ON semantic_memory(modified_at DESC)
	`);

	// #201: namespace-scoped lookups â dispatch resolves (agent_id, key), and
	// aux context injection filters by agent_id on every memory read.
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_memory_agent_key
		ON semantic_memory(agent_id, key) WHERE deleted = 0
	`);
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_edges_agent ON memory_edges(agent_id) WHERE deleted = 0
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
	// Slice 4E: skip on a retired host — the tables are gone.
	if (!legacyRelayRetired) {
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
	}

	// exit_code column on messages (tool_result exit status for UI error styling)
	try {
		db.run("ALTER TABLE messages ADD COLUMN exit_code INTEGER");
	} catch {
		/* already exists */
	}

	// metadata column on messages â opaque JSON property bag scoped to
	// platform connectors (e.g. Discord delivery-retry tombstones). Most of
	// the application treats this field as "does not exist." Platform-specific
	// code reads/writes it via readMessageMetadata / writeMessageMetadata.
	// Convention: platform writers prefix keys with their platform name
	// (discord_*, slack_*) to avoid collisions.
	try {
		db.run("ALTER TABLE messages ADD COLUMN metadata TEXT");
	} catch {
		/* already exists */
	}

	// Performance indexes for scheduler task queries (run every tick)
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_tasks_pending_schedule
		ON tasks(status, next_run_at)
		WHERE status = 'pending' AND deleted = 0 AND next_run_at IS NOT NULL
	`);

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_tasks_claimed_at
		ON tasks(claimed_at)
		WHERE deleted = 0 AND claimed_by IS NOT NULL
	`);

	db.run(`
		CREATE INDEX IF NOT EXISTS idx_tasks_running_heartbeat
		ON tasks(heartbeat_at)
		WHERE status = 'running' AND deleted = 0
	`);

	// 21. dispatch_queue (non-replicated, local-only)
	// Tracks message dispatch status for event-driven conversation model.
	// NOT a synced table â dispatch state is local coordination only.
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

	// Partial index for R-VC4 detail-tier retrieval (unbounded SELECT ordered by recency)
	// COVERING index: includes `key` column so planner can satisfy SELECT without table lookup
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_memory_detail_recency
			ON semantic_memory(last_accessed_at DESC, key)
			WHERE tier = 'detail' AND deleted = 0
	`);

	// Thread model hint: authoritative model preference for inference on this thread.
	// Replaces the heuristic of scanning messages.model_id for thread model resolution.
	try {
		db.run("ALTER TABLE threads ADD COLUMN model_hint TEXT");
	} catch {
		/* already exists */
	}

	// ââ Edge graph normalization âââââââââââââââââââââââââââââââââââââââââââââââââ

	// Add context column to memory_edges (nullable free-text annotation)
	try {
		db.run("ALTER TABLE memory_edges ADD COLUMN context TEXT");
	} catch {
		/* already exists */
	}

	// Generate trigger SQL from canonical set â single source of truth.
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

	// ââ FTS5 full-text search index for semantic_memory âââââââââââââââââââââââââ
	// Local-only index (NOT synced). Each node rebuilds from semantic_memory data.
	// Uses porter stemmer for morphological matching and unicode61 for non-ASCII.
	//
	// #201: agent_id is an UNINDEXED column used for namespace-scoped searches.
	// The triggers scope DELETE by (key, agent_id) so two namespaces using the
	// same key don't clobber each other's FTS5 entries.

	// #201: FTS5 virtual tables do NOT support ALTER TABLE ADD COLUMN.
	// The previous migration tried ALTER inside try/catch, which silently
	// failed on existing databases â leaving the FTS table without agent_id
	// while triggers referenced it, causing runtime errors on aux memory writes.
	// Fix: detect the missing column and DROP+CREATE (safe â FTS is local-only,
	// rebuilt from the base semantic_memory table).
	const ftsColumns = db.query("PRAGMA table_info(semantic_memory_fts)").all() as Array<{
		name: string;
	}>;
	const ftsHasAgentId = ftsColumns.some((c) => c.name === "agent_id");
	if (!ftsHasAgentId) {
		db.run("DROP TABLE IF EXISTS semantic_memory_fts");
	}
	db.run(`
		CREATE VIRTUAL TABLE IF NOT EXISTS semantic_memory_fts
		USING fts5(key, value, agent_id UNINDEXED, tokenize='porter unicode61')
	`);

	// Triggers to keep FTS5 in sync with semantic_memory writes.
	// All writes go through insertRow/updateRow/softDelete, which hit the base
	// table â triggers fire automatically, including on sync replay.
	// #201: DROP+CREATE (not IF NOT EXISTS) so trigger definitions pick up
	// the agent_id scoping on existing installations.
	db.run("DROP TRIGGER IF EXISTS memory_fts_insert");
	db.run("DROP TRIGGER IF EXISTS memory_fts_update");
	db.run("DROP TRIGGER IF EXISTS memory_fts_delete");

	db.run(`
		CREATE TRIGGER memory_fts_insert
		AFTER INSERT ON semantic_memory
		WHEN NEW.deleted = 0 AND NEW.key NOT LIKE '_internal.%'
		BEGIN
			INSERT INTO semantic_memory_fts(key, value, agent_id) VALUES (NEW.key, NEW.value, NEW.agent_id);
		END
	`);

	db.run(`
		CREATE TRIGGER memory_fts_update
		AFTER UPDATE ON semantic_memory
		BEGIN
			DELETE FROM semantic_memory_fts WHERE key = OLD.key AND agent_id IS OLD.agent_id;
			INSERT INTO semantic_memory_fts(key, value, agent_id)
				SELECT NEW.key, NEW.value, NEW.agent_id
				WHERE NEW.deleted = 0 AND NEW.key NOT LIKE '_internal.%';
		END
	`);

	db.run(`
		CREATE TRIGGER memory_fts_delete
		AFTER UPDATE OF deleted ON semantic_memory
		WHEN NEW.deleted = 1
		BEGIN
			DELETE FROM semantic_memory_fts WHERE key = OLD.key AND agent_id IS OLD.agent_id;
		END
	`);

	// Backfill FTS5 from existing semantic_memory data, but only if FTS is empty.
	//
	// The memory_fts_insert/update/delete triggers above are the source of truth
	// during steady-state, so a routine restart never needs to rebuild. The
	// rebuild only matters on the upgrade path (FTS table existed but was empty
	// before triggers were added) and on fresh installs (no-op anyway).
	//
	// Previously this ran unconditionally as DELETE+INSERT every boot, which
	// re-tokenized every memory through the porter stemmer on every daemon
	// start. Measured ~330ms warm against ~1k memories; longer on cold disk.
	//
	// Edge case: if the exclusion list (`key NOT LIKE '_internal.%'`) ever
	// changes, FTS rows for newly-excluded keys will linger until an explicit
	// rebuild. That should be handled as a deliberate migration step, not
	// implicitly on every boot.
	const ftsCount = (
		db.query("SELECT COUNT(*) AS n FROM semantic_memory_fts").get() as { n: number }
	).n;
	if (ftsCount === 0) {
		db.run(`
			INSERT INTO semantic_memory_fts(key, value, agent_id)
			SELECT key, value, agent_id FROM semantic_memory
			WHERE deleted = 0 AND key NOT LIKE '_internal.%'
		`);
	}

	installRowHashInvalidationTriggers(db);
}
