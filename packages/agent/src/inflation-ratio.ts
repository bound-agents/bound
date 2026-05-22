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
 * the caller falls back to its base TRUNCATION_TARGET_RATIO assumption.
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
 * Resolves the truncation ratio for assembleContext, factoring in the
 * thread's measured tiktoken-vs-actual inflation.
 *
 * `effective = baseRatio / max(1.0, measuredInflation)`
 *
 * The clamp at 1.0 prevents us from raising the ratio above its base when
 * tiktoken overestimates (inflation < 1.0); loosening would let the next
 * turn that swings back over the line blow the configured forcing budget.
 *
 * Returns `baseRatio` unchanged when computeInflationRatio has insufficient
 * data. New threads keep the original behavior until they have enough turns
 * for the EMA to be meaningful.
 */
export function resolveAdaptiveTruncationRatio(
	db: Database,
	threadId: string,
	baseRatio: number,
): number {
	const inflation = computeInflationRatio(db, threadId);
	if (inflation === null) return baseRatio;
	return baseRatio / Math.max(1.0, inflation);
}
