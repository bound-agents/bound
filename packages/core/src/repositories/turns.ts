import type { Database } from "bun:sqlite";
import { sql } from "kysely";
import { getAll, getOne, queryBuilder } from "../query-builder";

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
	return getOne(
		db,
		queryBuilder
			.selectFrom("turns")
			.select(["model_id", "route_id", "substituted_from", "created_at"])
			.where("thread_id", "=", threadId)
			.where("deleted", "=", 0)
			.where((eb) => eb.or([eb("status", "is", null), eb("status", "=", "ok")]))
			.orderBy("created_at", "desc")
			.orderBy(sql`rowid`, "desc")
			.limit(1),
	);
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
	return getAll(
		db,
		queryBuilder
			.selectFrom("turns")
			.select([
				"id",
				"created_at",
				"model_id",
				"route_id",
				"substituted_from",
				"status",
				"cost_usd",
				"cost_breakdown",
			])
			.where("thread_id", "=", threadId)
			.where("deleted", "=", 0)
			.orderBy("created_at", "asc")
			.orderBy(sql`rowid`, "asc"),
	);
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
	return getOne(
		db,
		queryBuilder
			.selectFrom("turns")
			.select(["created_at", "tokens_cache_read", "tokens_cache_write"])
			.where("thread_id", "=", threadId)
			.orderBy("created_at", "desc")
			.limit(1),
	);
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
	const rows = getAll(
		db,
		queryBuilder
			.selectFrom("turns")
			.select(["thread_id", "created_at", "tokens_cache_read"])
			.where("route_id", "=", routeId)
			.where("deleted", "=", 0)
			.where("created_at", ">=", sinceIso)
			.orderBy("thread_id", "asc")
			.orderBy("created_at", "asc")
			.orderBy(sql`rowid`, "asc"),
	);

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
	id: string;
	model_id: string;
	tokens_in: number;
	tokens_out: number;
	tokens_cache_read: number | null;
	tokens_cache_write: number | null;
	context_debug: string | null;
	created_at: string;
}> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("turns")
			.select([
				"id",
				"model_id",
				"tokens_in",
				"tokens_out",
				"tokens_cache_read",
				"tokens_cache_write",
				"context_debug",
				"created_at",
			])
			.where("thread_id", "=", threadId)
			.where("context_debug", "is not", null)
			.orderBy("created_at", "asc"),
	);
}

/** Timestamp of the latest turn for a thread+task pair. */
export function findMaxTurnCreatedAtByThreadAndTask(
	db: Database,
	threadId: string,
	taskId: string,
): { last_turn_at: string | null } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("turns")
			.select((eb) => eb.fn.max<string | null>("created_at").as("last_turn_at"))
			.where("thread_id", "=", threadId)
			.where("task_id", "=", taskId),
	);
}
