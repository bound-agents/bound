import type { Database } from "bun:sqlite";

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
}

export function applyMetricsSchema(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS turns (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
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

	// Add relay columns to turns (idempotent — no-op if already exists)
	try {
		db.run("ALTER TABLE turns ADD COLUMN relay_target TEXT");
	} catch {
		// Column already exists
	}
	try {
		db.run("ALTER TABLE turns ADD COLUMN relay_latency_ms INTEGER");
	} catch {
		// Column already exists
	}

	// Add cache token columns to turns (idempotent — no-op if already exists)
	try {
		db.run("ALTER TABLE turns ADD COLUMN tokens_cache_write INTEGER");
	} catch {
		// Column already exists
	}
	try {
		db.run("ALTER TABLE turns ADD COLUMN tokens_cache_read INTEGER");
	} catch {
		// Column already exists
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
}

export function recordTurn(db: Database, turn: TurnRecord): number {
	const result = db
		.prepare(
			`INSERT INTO turns (thread_id, task_id, dag_root_id, model_id, tokens_in, tokens_out, tokens_cache_write, tokens_cache_read, cost_usd, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			turn.thread_id || null,
			turn.task_id || null,
			turn.dag_root_id || null,
			turn.model_id,
			turn.tokens_in,
			turn.tokens_out,
			turn.tokens_cache_write ?? null,
			turn.tokens_cache_read ?? null,
			turn.cost_usd || 0,
			turn.created_at,
		);

	// Update daily_summary
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
		).run(turn.tokens_in, turn.tokens_out, turn.cost_usd || 0, date);
	} else {
		db.prepare(
			`INSERT INTO daily_summary (date, total_tokens_in, total_tokens_out, total_cost_usd, turn_count)
			 VALUES (?, ?, ?, ?, 1)`,
		).run(date, turn.tokens_in, turn.tokens_out, turn.cost_usd || 0);
	}

	return Number(result.lastInsertRowid);
}

export function getDailySpend(db: Database, date: string): number {
	const result = db.prepare("SELECT total_cost_usd FROM daily_summary WHERE date = ?").get(date) as
		| { total_cost_usd: number }
		| undefined;

	return result?.total_cost_usd || 0;
}
