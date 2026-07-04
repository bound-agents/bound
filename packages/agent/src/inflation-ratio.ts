import type { Database } from "bun:sqlite";

/**
 * Default lookback window for inflation-ratio computation. Ten turns is
 * enough to smooth out per-turn variance (e.g. one outlier-heavy thinking
 * block) while still adapting quickly when a thread shifts content profile
 * (e.g. user pastes in a large file and inflation spikes for several turns).
 */
const DEFAULT_LOOKBACK = 10;

/**
 * Minimum number of valid samples required before we trust the ratio.
 * One or two turns is too noisy; below this threshold we return null and
 * the caller falls back to its unadjusted `computeBaseTruncationTarget` value.
 */
const DEFAULT_MIN_SAMPLES = 3;

/**
 * Computes the per-thread tiktoken inflation ratio: arithmetic mean of
 * (actualTotalTokens / totalEstimated) across the most recent `lookback`
 * turns where both numbers are present and totalEstimated > 0.
 *
 * Returns null when fewer than `minSamples` valid rows are available, so
 * callers can fall back to their default ratio without per-thread data.
 *
 * Read-only against the synced `turns` table; safe to call inside the agent
 * loop hot path. The query is bounded by `lookback` and indexed on
 * (thread_id, created_at DESC) by `idx_turns_thread`.
 */
export function computeInflationRatio(
	db: Database,
	threadId: string,
	lookback: number = DEFAULT_LOOKBACK,
	minSamples: number = DEFAULT_MIN_SAMPLES,
): number | null {
	type Row = {
		estimated: number | null;
		actual: number | null;
	};

	let rows: Row[];
	try {
		rows = db
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
			.all(threadId, lookback) as Row[];
	} catch {
		// turns table may not exist (e.g., test harnesses that skip
		// applyMetricsSchema). Mirrors the cache-prediction module's
		// behavior — bail to null so callers fall back to base ratio.
		return null;
	}

	const ratios: number[] = [];
	for (const row of rows) {
		const estimated = row.estimated ?? 0;
		const actual = row.actual ?? null;
		if (actual === null) continue;
		if (estimated <= 0) continue;
		ratios.push(actual / estimated);
	}

	if (ratios.length < minSamples) return null;

	const sum = ratios.reduce((acc, r) => acc + r, 0);
	return sum / ratios.length;
}

/**
 * Resolves the truncation target (in tokens) for assembleContext, factoring
 * in the thread's measured tiktoken-vs-actual inflation.
 *
 * `target = floor(baseTarget / max(1.0, measuredInflation))`
 *
 * `baseTarget` is the physical target before per-thread adjustment —
 * `contextWindow - maxOutputTokens` (see `computeBaseTruncationTarget` in
 * context-assembly.ts), NOT a ratio. Dividing it down by the inflation EMA
 * keeps the same intent the old ratio-based scheme had: tiktoken's
 * cl100k_base under-counts thinking-heavy threads by 1.5-2x, so the
 * estimator-visible budget must shrink by the same factor for the real
 * wire payload to still fit inside `baseTarget` real tokens.
 *
 * The clamp at 1.0 prevents us from raising the target above its base when
 * tiktoken overestimates (inflation < 1.0); loosening would let the next
 * turn that swings back over the line blow the configured budget.
 *
 * Returns `{ target: baseTarget, inflation: null }` when
 * `computeInflationRatio` has insufficient data. New threads keep the
 * unadjusted base target until they accumulate enough turns for the EMA to
 * be meaningful.
 */
export function resolveAdaptiveTruncationTarget(
	db: Database,
	threadId: string,
	baseTarget: number,
): { target: number; inflation: number | null } {
	const inflation = computeInflationRatio(db, threadId);
	if (inflation === null) return { target: baseTarget, inflation: null };
	return { target: Math.max(0, Math.floor(baseTarget / Math.max(1.0, inflation))), inflation };
}
