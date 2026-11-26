import type { Database } from "bun:sqlite";

/**
 * Latest OK turn for a thread, projecting the columns thread-sticky routing
 * needs (2026-11-21-model-routing.md §5.3). "OK" follows the turns status
 * convention where legacy `NULL` means ok (`status IS NULL OR status = 'ok'`),
 * so a failed/aborted turn never pins a thread to a dead route. Returns null
 * when the thread has no prior ok turn (first turn, or every prior turn errored).
 */
export function findLatestOkTurnRouteByThread(
	db: Database,
	threadId: string,
): {
	model_id: string;
	route_id: string | null;
	substituted_from: string | null;
	created_at: string;
} | null {
	return db
		.query(
			`SELECT model_id, route_id, substituted_from, created_at
			 FROM turns
			 WHERE thread_id = ?
			   AND deleted = 0
			   AND (status IS NULL OR status = 'ok')
			 ORDER BY created_at DESC, rowid DESC
			 LIMIT 1`,
		)
		.get(threadId) as {
		model_id: string;
		route_id: string | null;
		substituted_from: string | null;
		created_at: string;
	} | null;
}

/** A turn row projected to the columns the per-turn provenance footer needs. */
export interface TurnProvenanceRow {
	id: string;
	created_at: string;
	model_id: string;
	route_id: string | null;
	substituted_from: string | null;
	status: string | null;
	cost_usd: number | null;
	/** JSON `TurnCostBreakdownWithAttempts`; the `attempts` array drives the expanded footer. */
	cost_breakdown: string | null;
}

/**
 * Every non-deleted turn for a thread, oldest-first, projecting the provenance
 * columns the web UI's per-turn footer reads (2026-11-21-model-routing.md §9.1).
 * The `cost_breakdown` JSON carries an optional per-attempt `attempts` array
 * (§7.4) that the expanded footer renders; a single-attempt turn omits it.
 */
export function listTurnsByThread(db: Database, threadId: string): TurnProvenanceRow[] {
	return db
		.query(
			`SELECT id, created_at, model_id, route_id, substituted_from, status, cost_usd, cost_breakdown
			 FROM turns
			 WHERE thread_id = ?
			   AND deleted = 0
			 ORDER BY created_at ASC, rowid ASC`,
		)
		.all(threadId) as TurnProvenanceRow[];
}

/**
 * Latest turn for a thread, projecting only the cache-state columns needed by
 * the cache predictor.
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
 * Measure a route's effective prompt-cache window from history
 * (2026-11-21-model-catalog.md R-MC16, consumed by thread stickiness §5.3).
 *
 * The window is the LONGEST gap between two consecutive turns on the same
 * `route_id` WITHIN one thread where the later turn reported `tokens_cache_read
 * > 0` — i.e. the longest inter-turn delay after which the route's prompt cache
 * was observed still warm. A cache prefix is thread-scoped, so gaps are measured
 * per `(route_id, thread_id)`, never across threads. Returns the gap in
 * milliseconds, or `null` when the route has no two-consecutive-turns-with-a-
 * following-read history (the caller then falls back to the last requested
 * lifetime).
 *
 * Lookback bound: only turns created within the last 24h (`nowIso - 24h`) are
 * considered. 24h is not an invented constant — it is the longest cache
 * retention Bound ever requests (`promptCacheRetention: "24h"`, bedrock-mantle.ts).
 * A warm gap older than that cannot describe a currently-live cache window, so
 * bounding the scan there keeps the query cheap without discarding any
 * measurement that could still matter.
 */
export function computeEffectiveCacheWindowMs(
	db: Database,
	routeId: string,
	opts: { nowIso: string },
): number | null {
	const LOOKBACK_MS = 24 * 60 * 60 * 1000;
	const sinceIso = new Date(new Date(opts.nowIso).getTime() - LOOKBACK_MS).toISOString();
	const rows = db
		.query(
			`SELECT thread_id, created_at, tokens_cache_read
			 FROM turns
			 WHERE route_id = ?
			   AND deleted = 0
			   AND created_at >= ?
			 ORDER BY thread_id ASC, created_at ASC, rowid ASC`,
		)
		.all(routeId, sinceIso) as Array<{
		thread_id: string | null;
		created_at: string;
		tokens_cache_read: number | null;
	}>;

	let longest: number | null = null;
	for (let i = 1; i < rows.length; i++) {
		const prev = rows[i - 1];
		const cur = rows[i];
		// Consecutive within the same thread only — a cache prefix never spans
		// threads, so a read on a different thread says nothing about this gap.
		if (cur.thread_id !== prev.thread_id) continue;
		// The later turn must have actually read from cache for the gap to count as
		// a confirmed-warm window.
		if ((cur.tokens_cache_read ?? 0) <= 0) continue;
		const gap = new Date(cur.created_at).getTime() - new Date(prev.created_at).getTime();
		if (gap >= 0 && (longest === null || gap > longest)) longest = gap;
	}
	return longest;
}

/**
 * Per-thread context-debug history (token + cache columns) for turns that
 * recorded a `context_debug` payload, oldest first.
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

/** Timestamp of the latest turn for a thread+task pair. */
export function findMaxTurnCreatedAtByThreadAndTask(
	db: Database,
	threadId: string,
	taskId: string,
): { last_turn_at: string | null } | null {
	return db
		.query("SELECT MAX(created_at) as last_turn_at FROM turns WHERE thread_id = ? AND task_id = ?")
		.get(threadId, taskId) as { last_turn_at: string | null } | null;
}
