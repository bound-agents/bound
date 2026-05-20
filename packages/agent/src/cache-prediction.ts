import type { Database } from "bun:sqlite";

export type CacheState = "warm" | "cold";

/**
 * Predicts whether the LLM prompt cache is warm or cold for a given thread.
 *
 * Uses the most recent turn's cache metrics and timestamp:
 * - "warm": last turn had cache activity (read or write > 0) AND is within TTL
 * - "cold": no recent turn, beyond TTL, or no cache activity
 *
 * @param ttlMs Cache TTL in milliseconds (e.g., 300_000 for 5m, 3_600_000 for 1h)
 */
export function predictCacheState(db: Database, threadId: string, ttlMs: number): CacheState {
	type TurnRow = {
		created_at: string;
		tokens_cache_read: number | null;
		tokens_cache_write: number | null;
	};

	let row: TurnRow | null = null;

	try {
		row = db
			.query(
				`SELECT created_at, tokens_cache_read, tokens_cache_write
				 FROM turns
				 WHERE thread_id = ?
				 ORDER BY created_at DESC
				 LIMIT 1`,
			)
			.get(threadId) as TurnRow | null;
	} catch {
		// turns table may not exist (e.g., test environments without metrics schema)
		return "cold";
	}

	if (!row) return "cold";

	const cacheRead = row.tokens_cache_read ?? 0;
	const cacheWrite = row.tokens_cache_write ?? 0;
	const hadCacheActivity = cacheRead > 0 || cacheWrite > 0;

	if (!hadCacheActivity) return "cold";

	const msSinceTurn = Date.now() - new Date(row.created_at).getTime();
	return msSinceTurn < ttlMs ? "warm" : "cold";
}

/** TTL durations in milliseconds, keyed by the API TTL string. */
export const CACHE_TTL_MS: Record<"5m" | "1h", number> = {
	"5m": 5 * 60_000,
	"1h": 60 * 60_000,
};

/**
 * Selects the cache TTL for warm/cold path prediction.
 *
 * All interfaces use 1h. The 5m TTL was previously used for web/MCP under the
 * assumption that messages arrive frequently, but agent tool-use turns routinely
 * take 30-130+ seconds — a 5m TTL between separate user messages forced
 * unnecessary cold reassembly and prefix reshuffling, guaranteeing provider-side
 * cache misses on subsequent turns.
 */
export function selectCacheTtl(_threadInterface: string): "5m" | "1h" {
	return "1h";
}
