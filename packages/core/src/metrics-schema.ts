import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ContextDebugInfo } from "@bound/shared";
import { insertRow, updateRow } from "./change-log.js";

/**
 * A single LLM turn, recorded once per inference attempt. Rows replicate
 * across hosts via the change_log (append-only / hybrid reducer) so
 * cost/usage queries and the web context-debug panel span the whole
 * cluster. All columns replicate, including `context_debug`,
 * `relay_target`, and `relay_latency_ms` — a thread can bounce between
 * hosts mid-run, so any host may be asked to render the full context
 * history for a thread.
 *
 * Related: bound_issue:turns-table:observability-gap (2026-04-26).
 */
export interface TurnRecord {
	thread_id?: string;
	task_id?: string;
	dag_root_id?: string;
	model_id: string;
	tokens_in: number;
	tokens_out: number;
	tokens_cache_write: number | null;
	tokens_cache_read: number | null;
	cost_usd?: number;
	created_at: string;
	/**
	 * Inference outcome. Default "ok". Set to "error" when the provider
	 * call failed before producing output, or "aborted" when the stream
	 * was cancelled mid-flight. Failed/aborted turns still get a row so
	 * cost/usage analysis sees them instead of silently dropping.
	 */
	status?: "ok" | "error" | "aborted";
}

export function applyMetricsSchema(db: Database): void {
	// Migrate legacy schema: older bound versions used INTEGER PRIMARY KEY
	// AUTOINCREMENT for turns.id. Autoincrement ids collide across hosts
	// and cannot be safely replicated. Detect and rebuild the table with a
	// TEXT id, preserving data. This must run BEFORE the CREATE IF NOT
	// EXISTS below so we don't skip the migration on an already-present
	// legacy table.
	const existing = db
		.query("SELECT name FROM sqlite_master WHERE type='table' AND name='turns'")
		.get() as { name: string } | null;
	if (existing) {
		const cols = db.query("PRAGMA table_info(turns)").all() as Array<{
			name: string;
			type: string;
			pk: number;
		}>;
		const idCol = cols.find((c) => c.name === "id");
		if (idCol && idCol.type.toUpperCase() === "INTEGER") {
			migrateTurnsIntToText(db, cols);
		}
	}

	db.run(`
		CREATE TABLE IF NOT EXISTS turns (
			id TEXT PRIMARY KEY,
			thread_id TEXT,
			task_id TEXT,
			dag_root_id TEXT,
			model_id TEXT NOT NULL,
			tokens_in INTEGER NOT NULL,
			tokens_out INTEGER NOT NULL,
			cost_usd REAL,
			created_at TEXT NOT NULL
		) STRICT
	`);

	// Idempotent ALTERs for columns added over time. Each try/catch is a
	// no-op if the column already exists (SQLite has no ADD COLUMN IF NOT
	// EXISTS). Order-independent.
	for (const [colName, decl] of [
		["relay_target", "TEXT"],
		["relay_latency_ms", "INTEGER"],
		["tokens_cache_write", "INTEGER"],
		["tokens_cache_read", "INTEGER"],
		["context_debug", "TEXT"],
		// Turn outcome: "ok" | "error" | "aborted". Default "ok" at INSERT
		// time (recordTurn normalizes). We don't add a DEFAULT clause here
		// because SQLite ALTER TABLE ... ADD COLUMN ... DEFAULT behaves
		// oddly with STRICT tables and we want existing legacy rows to
		// stay NULL (interpreted as "ok" downstream).
		["status", "TEXT"],
		// Recording host. Lets cross-host queries attribute each row to
		// who ran the inference.
		["host_origin", "TEXT"],
		// Append-only hybrid reducer honors modified_at when present. We
		// bump it in updateRow() when recordContextDebug / recordTurnRelayMetrics
		// run, so post-insert column writes replicate correctly.
		["modified_at", "TEXT"],
	] as const) {
		try {
			db.run(`ALTER TABLE turns ADD COLUMN ${colName} ${decl}`);
		} catch {
			// Column already exists — fine.
		}
	}

	db.run(`
		CREATE TABLE IF NOT EXISTS daily_summary (
			date TEXT PRIMARY KEY,
			total_tokens_in INTEGER DEFAULT 0,
			total_tokens_out INTEGER DEFAULT 0,
			total_cost_usd REAL DEFAULT 0,
			turn_count INTEGER DEFAULT 0
		) STRICT
	`);

	// Performance index for turns by thread (context debug lookups, thread status)
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_turns_thread
		ON turns(thread_id, created_at DESC)
	`);
}

function migrateTurnsIntToText(
	db: Database,
	cols: Array<{ name: string; type: string; pk: number }>,
): void {
	// Build the new table with TEXT id, preserving all other column types
	// and declarations. Copy rows with id CAST to TEXT (stable per-host;
	// integers are already unique within a host so a string copy is
	// collision-free locally). Then drop/rename.
	//
	// We do this in a transaction so a crash mid-migration rolls back to
	// the legacy shape, leaving a retry on the next startup viable.
	const colDecls = cols.map((c) => {
		if (c.name === "id") return "id TEXT PRIMARY KEY";
		// Preserve NOT NULL constraint on model_id, tokens_in, tokens_out,
		// created_at — these pre-existed in the legacy schema. Safest path
		// is to rebuild from PRAGMA (which doesn't surface NOT NULL), so
		// instead we re-declare the known-required columns explicitly and
		// let the rest be nullable.
		if (c.name === "model_id") return "model_id TEXT NOT NULL";
		if (c.name === "tokens_in") return "tokens_in INTEGER NOT NULL";
		if (c.name === "tokens_out") return "tokens_out INTEGER NOT NULL";
		if (c.name === "created_at") return "created_at TEXT NOT NULL";
		return `${c.name} ${c.type}`;
	});

	const colNames = cols.map((c) => c.name);
	const colList = colNames.join(", ");
	const selectList = colNames.map((n) => (n === "id" ? "CAST(id AS TEXT)" : n)).join(", ");

	db.exec("BEGIN");
	try {
		db.run(`CREATE TABLE turns_new (${colDecls.join(", ")}) STRICT`);
		db.run(`INSERT INTO turns_new (${colList}) SELECT ${selectList} FROM turns`);
		db.run("DROP TABLE turns");
		db.run("ALTER TABLE turns_new RENAME TO turns");
		db.exec("COMMIT");
	} catch (err) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// rollback best-effort
		}
		throw err;
	}
}

/**
 * Insert a turn row. If `siteId` is provided, the row replicates via the
 * standard outbox (`insertRow`) so cost/usage and context-debug data are
 * visible from every host. Without `siteId` the row stays local — tests
 * and utility scripts use this path.
 */
export function recordTurn(db: Database, turn: TurnRecord, siteId?: string): string {
	const id = randomUUID();
	const status = turn.status ?? "ok";

	const row: import("@bound/shared").Turn = {
		id,
		thread_id: turn.thread_id ?? null,
		task_id: turn.task_id ?? null,
		dag_root_id: turn.dag_root_id ?? null,
		model_id: turn.model_id,
		tokens_in: turn.tokens_in,
		tokens_out: turn.tokens_out,
		tokens_cache_write: turn.tokens_cache_write ?? null,
		tokens_cache_read: turn.tokens_cache_read ?? null,
		cost_usd: turn.cost_usd ?? 0,
		created_at: turn.created_at,
		modified_at: turn.created_at,
		status,
		host_origin: siteId ?? null,
		relay_target: null,
		relay_latency_ms: null,
		context_debug: null,
	};

	if (siteId) {
		insertRow(db, "turns", row, siteId);
	} else {
		const rowData = row as unknown as Record<string, unknown>;
		const colsInOrder = Object.keys(rowData);
		const placeholders = colsInOrder.map(() => "?").join(", ");
		const values = colsInOrder.map((k) => rowData[k]) as Array<string | number | null>;
		db.prepare(`INSERT INTO turns (${colsInOrder.join(", ")}) VALUES (${placeholders})`).run(
			...values,
		);
	}

	// Update daily_summary for the calendar date of this turn. daily_summary
	// is a local rollup — not synced — so this runs outside the outbox path.
	const date = turn.created_at.split("T")[0];
	const existing = db.prepare("SELECT 1 FROM daily_summary WHERE date = ?").get(date);
	if (existing) {
		db.prepare(
			`UPDATE daily_summary
			 SET total_tokens_in = total_tokens_in + ?,
			     total_tokens_out = total_tokens_out + ?,
			     total_cost_usd = total_cost_usd + ?,
			     turn_count = turn_count + 1
			 WHERE date = ?`,
		).run(turn.tokens_in, turn.tokens_out, turn.cost_usd ?? 0, date);
	} else {
		db.prepare(
			`INSERT INTO daily_summary (date, total_tokens_in, total_tokens_out, total_cost_usd, turn_count)
			 VALUES (?, ?, ?, ?, 1)`,
		).run(date, turn.tokens_in, turn.tokens_out, turn.cost_usd ?? 0);
	}

	return id;
}

/**
 * Record context debug metadata for a turn. When `siteId` is provided the
 * update replicates via the outbox so the context-debug panel shows the
 * full turn history on any host, even when a thread bounced between hosts
 * mid-run. Without `siteId` the update stays local (tests / utilities).
 */
export function recordContextDebug(
	db: Database,
	turnId: string,
	debug: ContextDebugInfo,
	siteId?: string,
): void {
	const serialized = JSON.stringify(debug);
	if (siteId) {
		updateRow(db, "turns", turnId, { context_debug: serialized }, siteId);
	} else {
		db.run("UPDATE turns SET context_debug = ? WHERE id = ?", [serialized, turnId]);
	}
}

export function getDailySpend(db: Database, date: string): number {
	const result = db
		.prepare("SELECT total_cost_usd FROM daily_summary WHERE date = ?")
		.get(date) as { total_cost_usd: number } | null;

	return result?.total_cost_usd || 0;
}
