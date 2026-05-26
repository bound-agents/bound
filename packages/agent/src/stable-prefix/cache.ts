/**
 * Per-thread memoization cache for the rendered stable volatile subsection.
 *
 * Background. R-VC25 mandates that the stable-prefix subsection of the
 * volatile context be byte-stable across cold rebuilds within the cache TTL
 * window. The renderer (`composeStableVolatileSubsection`) is provably pure;
 * the collector (`collectStableVolatileInputs`) reads fresh DB state every
 * call, and that state CAN mutate within a TTL window through paths the
 * change-log doesn't track.
 *
 * The documented exception. `semantic_memory.last_accessed_at` is bumped by
 * `bumpRenderedDetailEntries` and other relevance-hint paths via direct SQL
 * — explicitly NOT routed through the change-log outbox per CONTRIBUTING.md
 * narrow exception #1. The Discoverable Archive renderer sorts detail entries
 * by `last_accessed_at DESC`, so any bump shifts the on-wire byte
 * representation of the stable subsection. The R-VC25 drift detector
 * classifies this as a `flavor:collect` violation.
 *
 * Live evidence (thread `a0efd4a2-…` 2026-05-25 18:01:39 → 18:01:59,
 * 20-second window):
 *
 *   - system block sha256 prefix mutated `eb0117b763bb` → `b55dff2241a9`
 *   - system text length identical (279,865 chars) — same length, different
 *     bytes, in-place reordering of the Discoverable Archive `Uncategorized`
 *     cluster
 *   - `tokens_cache_read` collapsed from 247,071 → 5,450 (every cumulative
 *     cache entry orphaned in a single turn)
 *   - `tokens_cache_write` ballooned to 248,278 to re-prime the new prefix
 *
 * Cache contract. The full invariant set lives in
 * `__tests__/cache.test.ts`; the load-bearing one is K1:
 *
 *   K1 Within-window byte stability — for a given thread within the TTL
 *      window, repeated calls return byte-identical output even if the
 *      underlying DB state mutated between calls.
 *
 * The cache is per-process / per-host. It does NOT need cross-host sync
 * because `last_accessed_at` is a per-host hint by design. Cache TTL aligns
 * with the Bedrock prompt cache TTL (1h) so cache window flips coincide
 * with the upstream cache also expiring — single coordinated refresh.
 */

import type { Database } from "bun:sqlite";
import { collectStableVolatileInputs } from "./collect";
import { composeStableVolatileSubsection } from "./compose";

/** TTL window matching the Bedrock 1h prompt cache TTL. */
export const STABLE_SUBSECTION_TTL_MS = 60 * 60 * 1000;

interface CachedEntry {
	lines: string[];
	createdAtMs: number;
}

export interface GetStableSubsectionParams {
	db: Database;
	threadId: string;
	budgetPressure: boolean;
	/** TTL override for tests. Defaults to STABLE_SUBSECTION_TTL_MS. */
	ttlMs?: number;
	/** Wall-clock override for tests. Defaults to Date.now(). */
	nowMs?: number;
}

/**
 * Per-thread memoization cache for the stable volatile subsection.
 *
 * The cache is intentionally an instance class (not a module-level
 * singleton) so tests can construct fresh instances and the agent loop
 * can reset it on cache-relevant invalidation events (summary regen,
 * skill activation/retirement, persona change).
 */
export class StableSubsectionCache {
	private readonly entries = new Map<string, CachedEntry>();

	/**
	 * Get the rendered stable volatile subsection for `threadId`.
	 *
	 * On cache hit (entry exists AND is within TTL), returns the cached
	 * lines without touching the DB.
	 *
	 * On cache miss (no entry OR entry expired), collects fresh inputs,
	 * renders, stores in cache, and returns.
	 */
	get(params: GetStableSubsectionParams): string[] {
		const ttlMs = params.ttlMs ?? STABLE_SUBSECTION_TTL_MS;
		const nowMs = params.nowMs ?? Date.now();

		// Scavenge expired entries — keeps memory bounded across long-lived
		// processes with many threads. Cheap O(N) over current entries; runs
		// on every `get` so we never accumulate stale entries in lieu of
		// background sweeping.
		this.scavenge(ttlMs, nowMs);

		const cached = this.entries.get(params.threadId);
		if (cached && nowMs - cached.createdAtMs < ttlMs) {
			return cached.lines;
		}

		const inputs = collectStableVolatileInputs(params.db, params.budgetPressure);
		const lines = composeStableVolatileSubsection(inputs);
		this.entries.set(params.threadId, { lines, createdAtMs: nowMs });
		return lines;
	}

	/**
	 * Force-invalidate the cache entry for `threadId`. The next `get`
	 * call will re-collect and re-render. Used by cache-relevant
	 * invalidation events (summary regen, persona change, etc).
	 */
	invalidate(threadId: string): void {
		this.entries.delete(threadId);
	}

	/**
	 * Drop every entry whose age exceeds `ttlMs`. Called automatically
	 * on `get` to keep memory bounded; exposed for tests + diagnostic
	 * tooling.
	 */
	scavenge(ttlMs: number, nowMs: number): number {
		let evicted = 0;
		for (const [key, entry] of this.entries) {
			if (nowMs - entry.createdAtMs >= ttlMs) {
				this.entries.delete(key);
				evicted++;
			}
		}
		return evicted;
	}

	/** Current number of cached entries. Diagnostic / test seam. */
	size(): number {
		return this.entries.size;
	}

	/** Drop all cached entries. Diagnostic / test seam. */
	clear(): void {
		this.entries.clear();
	}
}

/**
 * Process-wide singleton cache used by the agent loop. One instance is
 * shared across all threads on a host so per-thread cache entries can
 * be looked up by threadId. Tests construct their own instances via
 * `new StableSubsectionCache()` to keep state isolated.
 */
export const sharedStableSubsectionCache = new StableSubsectionCache();
