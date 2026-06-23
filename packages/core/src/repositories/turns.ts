import type { Database } from "bun:sqlite";

/** Read repository for the `turns` table. See ./index.ts for conventions. */

/**
 * Latest turn for a thread, projecting only the cache-state columns needed by
 * the cache predictor. Used by cache-prediction.ts.
 */
export function findLatestTurnCacheStateByThread(
	db: Database,
	threadId: string,
): {
	created_at: string;
	tokens_cache_read: number | null;
	tokens_cache_write: number | null;
} | null {
	return db
		.query(
			`SELECT created_at, tokens_cache_read, tokens_cache_write
			 FROM turns
			 WHERE thread_id = ?
			 ORDER BY created_at DESC
			 LIMIT 1`,
		)
		.get(threadId) as {
		created_at: string;
		tokens_cache_read: number | null;
		tokens_cache_write: number | null;
	} | null;
}

/**
 * `created_at` of the most recent turn for a thread. Used by cache-warm-poke.ts
 * to decide whether a warm prefix is still extendable.
 */
export function findLatestTurnCreatedAtByThread(
	db: Database,
	threadId: string,
): { created_at: string } | null {
	return db
		.query("SELECT created_at FROM turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
		.get(threadId) as { created_at: string } | null;
}

/**
 * Status of the most recent turn for a thread at or after `since`. Used by the
 * introspect tool to detect an error on a target thread.
 */
export function findLatestTurnStatusByThreadSince(
	db: Database,
	threadId: string,
	since: string,
): { status: string | null } | null {
	return db
		.query(
			"SELECT status FROM turns WHERE thread_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
		)
		.get(threadId, since) as { status: string | null } | null;
}

/**
 * Inflation-ratio history: estimated vs. actual token counts pulled from
 * `context_debug` JSON for the most recent turns of a thread. Used by
 * inflation-ratio.ts.
 */
export function listTurnInflationRatiosByThread(
	db: Database,
	threadId: string,
	lookback: number,
): Array<{ estimated: number | null; actual: number | null }> {
	return db
		.query(
			`SELECT
				json_extract(context_debug, '$.totalEstimated') AS estimated,
				json_extract(context_debug, '$.actualTotalTokens') AS actual
			FROM turns
			WHERE thread_id = ?
				AND context_debug IS NOT NULL
			ORDER BY created_at DESC, rowid DESC
			LIMIT ?`,
		)
		.all(threadId, lookback) as Array<{ estimated: number | null; actual: number | null }>;
}

/**
 * Stable-prefix drift-validation feed: cold-path turns carrying a stable-prefix
 * hash + input fingerprint, ordered for per-thread sweep. Used by
 * run-stable-prefix-drift-validation.ts.
 */
export function listStablePrefixDriftTurnsSince(
	db: Database,
	since: string,
): Array<{
	thread_id: string | null;
	created_at: string;
	hash: string | null;
	input_fp: string | null;
}> {
	return db
		.query(
			`SELECT
				thread_id,
				created_at,
				json_extract(context_debug, '$.stablePrefixHash') AS hash,
				json_extract(context_debug, '$.stablePrefixInputFingerprint') AS input_fp
			FROM turns
			WHERE created_at >= ?
				AND deleted = 0
				AND json_extract(context_debug, '$.cachePath') = 'cold'
				AND json_extract(context_debug, '$.stablePrefixHash') IS NOT NULL
			ORDER BY thread_id ASC, created_at ASC`,
		)
		.all(since) as Array<{
		thread_id: string | null;
		created_at: string;
		hash: string | null;
		input_fp: string | null;
	}>;
}

/**
 * Per-thread context-debug history (token + cache columns) for turns that
 * recorded a `context_debug` payload, oldest first. Used by the threads route's
 * context-history endpoint.
 */
export function listContextDebugTurnsByThread(
	db: Database,
	threadId: string,
): Array<{
	id: number;
	model_id: string;
	tokens_in: number;
	tokens_out: number;
	tokens_cache_read: number | null;
	tokens_cache_write: number | null;
	context_debug: string | null;
	created_at: string;
}> {
	return db
		.query(
			`SELECT id, model_id, tokens_in, tokens_out, tokens_cache_read,
			        tokens_cache_write, context_debug, created_at
			 FROM turns
			 WHERE thread_id = ? AND context_debug IS NOT NULL
			 ORDER BY created_at ASC`,
		)
		.all(threadId) as Array<{
		id: number;
		model_id: string;
		tokens_in: number;
		tokens_out: number;
		tokens_cache_read: number | null;
		tokens_cache_write: number | null;
		context_debug: string | null;
		created_at: string;
	}>;
}

/**
 * Most recent turn's cost/token columns regardless of thread. Used by the agent
 * harness environment to report last-turn spend.
 */
export function findLatestTurnSpend(
	db: Database,
): { cost_usd: number | null; tokens_in: number; tokens_out: number } | null {
	return db
		.query(
			"SELECT cost_usd, tokens_in, tokens_out FROM turns ORDER BY created_at DESC, rowid DESC LIMIT 1",
		)
		.get() as { cost_usd: number | null; tokens_in: number; tokens_out: number } | null;
}

/**
 * Sum of `cost_usd` across all turns created on a given calendar day
 * (`date(created_at) = ?`). Used by the scheduler's daily-budget guard.
 */
export function sumTurnCostForDate(db: Database, date: string): { total: number | null } | null {
	return db
		.query("SELECT SUM(cost_usd) as total FROM turns WHERE date(created_at) = ?")
		.get(date) as { total: number | null } | null;
}

/**
 * Timestamp of the latest turn for a thread+task pair. Used by the tasks route
 * to compute last-run duration.
 */
export function findMaxTurnCreatedAtByThreadAndTask(
	db: Database,
	threadId: string,
	taskId: string,
): { last_turn_at: string | null } | null {
	return db
		.query("SELECT MAX(created_at) as last_turn_at FROM turns WHERE thread_id = ? AND task_id = ?")
		.get(threadId, taskId) as { last_turn_at: string | null } | null;
}

/**
 * Per-model usage rollup over a `created_at` window. Used by the metrics route's
 * by-model breakdown.
 */
export function listModelUsageInRange(
	db: Database,
	fromISO: string,
	toISO: string,
): Array<{
	model_id: string;
	tokens_in: number | null;
	tokens_out: number | null;
	cache_read: number | null;
	cache_write: number | null;
	cost_usd: number | null;
	turn_count: number;
}> {
	return db
		.query(
			`SELECT
					model_id,
					SUM(tokens_in) as tokens_in,
					SUM(tokens_out) as tokens_out,
					SUM(COALESCE(tokens_cache_read, 0)) as cache_read,
					SUM(COALESCE(tokens_cache_write, 0)) as cache_write,
					SUM(COALESCE(cost_usd, 0)) as cost_usd,
					COUNT(*) as turn_count
				FROM turns
				WHERE created_at BETWEEN ? AND ? AND deleted = 0
				GROUP BY model_id
				ORDER BY (tokens_in + tokens_out) DESC`,
		)
		.all(fromISO, toISO) as Array<{
		model_id: string;
		tokens_in: number | null;
		tokens_out: number | null;
		cache_read: number | null;
		cache_write: number | null;
		cost_usd: number | null;
		turn_count: number;
	}>;
}

/**
 * Aggregate usage totals (tokens, cache, cost, turn + error counts) over a
 * `created_at` window. Used by the metrics route's summary panel.
 */
export function aggregateUsageTotalsInRange(
	db: Database,
	fromISO: string,
	toISO: string,
): {
	tokens_in: number | null;
	tokens_out: number | null;
	cache_read: number | null;
	cache_write: number | null;
	cost_usd: number | null;
	turn_count: number | null;
	error_count: number | null;
} | null {
	return db
		.query(
			`SELECT
					SUM(tokens_in) as tokens_in,
					SUM(tokens_out) as tokens_out,
					SUM(COALESCE(tokens_cache_read, 0)) as cache_read,
					SUM(COALESCE(tokens_cache_write, 0)) as cache_write,
					SUM(COALESCE(cost_usd, 0)) as cost_usd,
					COUNT(*) as turn_count,
					SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count
				FROM turns
				WHERE created_at BETWEEN ? AND ? AND deleted = 0`,
		)
		.get(fromISO, toISO) as {
		tokens_in: number | null;
		tokens_out: number | null;
		cache_read: number | null;
		cache_write: number | null;
		cost_usd: number | null;
		turn_count: number | null;
		error_count: number | null;
	} | null;
}

/**
 * Context-debug health rollup (budget-pressure share + average truncated
 * messages) over a `created_at` window, restricted to turns carrying a
 * `context_debug` payload. Used by the metrics route.
 */
export function aggregateContextDebugHealthInRange(
	db: Database,
	fromISO: string,
	toISO: string,
): {
	total_turns_with_debug: number | null;
	budget_pressure_count: number | null;
	avg_truncated_messages: number | null;
} | null {
	return db
		.prepare(
			`SELECT
					COUNT(*) as total_turns_with_debug,
					SUM(CASE WHEN json_extract(context_debug, '$.budgetPressure') = 1 THEN 1 ELSE 0 END) as budget_pressure_count,
					AVG(COALESCE(CAST(json_extract(context_debug, '$.truncated') AS INTEGER), 0)) as avg_truncated_messages
				FROM turns
				WHERE created_at BETWEEN ? AND ? AND context_debug IS NOT NULL AND deleted = 0`,
		)
		.get(fromISO, toISO) as {
		total_turns_with_debug: number | null;
		budget_pressure_count: number | null;
		avg_truncated_messages: number | null;
	} | null;
}

/**
 * Most recent computable cache-hit-rate over a `created_at` window. Used by the
 * metrics route's last-cache-hit indicator.
 */
export function findLatestCacheHitRateInRange(
	db: Database,
	fromISO: string,
	toISO: string,
): { cache_hit_rate: number | null } | null {
	return db
		.prepare(
			`SELECT
					CAST(COALESCE(tokens_cache_read, 0) AS REAL) /
						(COALESCE(tokens_cache_read, 0) + tokens_in) as cache_hit_rate
				FROM turns
				WHERE created_at BETWEEN ? AND ?
					AND context_debug IS NOT NULL
					AND deleted = 0
					AND COALESCE(tokens_cache_read, 0) + tokens_in > 0
				ORDER BY created_at DESC
				LIMIT 1`,
		)
		.get(fromISO, toISO) as { cache_hit_rate: number | null } | null;
}
