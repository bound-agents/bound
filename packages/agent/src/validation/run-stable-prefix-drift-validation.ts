/**
 * Stable-prefix drift validator.
 *
 * Scans recent cold rebuilds (the only path that recomputes the
 * stable prefix) and surfaces leaks where two consecutive rebuilds
 * on the same thread within the cache TTL window produced different
 * `stablePrefixHash` values.
 *
 * The validator distinguishes two flavors of drift based on the
 * `stablePrefixInputFingerprint` field also recorded on
 * `context_debug`:
 *
 *   - **Compose drift** (`compose:`): same input fingerprint,
 *     different output hash. By elimination, the renderer must be
 *     reading some undeclared signal — e.g., wall-clock,
 *     `process.env`, locale settings. This is the leak class that
 *     produced the original 11.93% cache hit rate on thread
 *     `2d055bbe-...` (relative-time strings ticking with wall-clock
 *     between renders).
 *
 *   - **Collect drift** (`collect:`): different input fingerprint,
 *     no `change_log` row covering `semantic_memory | skills |
 *     files | advisories | overlay_index` between the two cold
 *     rebuilds. Either the input collector is reading something
 *     that doesn't go through the outbox (a documented narrow
 *     exception, e.g., `last_accessed_at` bumps) and that something
 *     leaked into the fingerprint, OR the collector is reading
 *     undeclared signals.
 *
 * Drift findings are returned in the report's `leaks` array; the
 * caller (`heartbeat-context.ts`) emits one structured `logger.warn`
 * per leak. Findings are NOT persisted to `semantic_memory` — they
 * are rare bug-signals you query from logs when they fire, not
 * telemetry to trend, so a log line is the right home and the memory
 * namespace stays bounded. Only the
 * `_validation:stable-prefix-drift-last-run` cadence marker is
 * persisted (a single overwriting key).
 *
 * Pattern lifted from `run-r-vc9-validation.ts`. Cadence: hourly,
 * one heartbeat cycle, aligned with the `1h` cache TTL so any
 * within-TTL leak gets at least one detection pass.
 */

import type { Database } from "bun:sqlite";
import { insertRow, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";

/**
 * Cadence gate. One heartbeat cycle (1h) aligns with the cache TTL —
 * any drift within a single TTL window gets at least one detection
 * pass. Drift across TTL boundaries is uninteresting (the cache
 * naturally rebuilds; no way to attribute the change).
 */
const VALIDATION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Cache TTL window for pairing turns. Hardcoded to 1h here —
 * `selectCacheTtl` returns "1h" for boundless threads (the bulk of
 * cold-rebuild traffic). 5m TTL threads get scanned with the same
 * window which produces fewer pairs but no false positives (5m
 * pairs are a strict subset of 1h pairs).
 */
const PAIR_WINDOW_MS = 60 * 60 * 1000;

/** Lookback for the scan. */
const LOOKBACK_HOURS = 24;

export interface StablePrefixDriftLeak {
	flavor: "compose" | "collect";
	thread_id: string;
	prev_turn_id: string;
	curr_turn_id: string;
	prev_created_at: string;
	curr_created_at: string;
	prev_hash: string | null;
	curr_hash: string | null;
	prev_input_fp: string | null;
	curr_input_fp: string | null;
}

export interface StablePrefixDriftReport {
	pairsExamined: number;
	composeDriftCount: number;
	collectDriftCount: number;
	/**
	 * One record per detected leak, in scan order. The caller logs
	 * these; they are NOT persisted to `semantic_memory`.
	 */
	leaks: StablePrefixDriftLeak[];
}

interface ColdTurnRow {
	thread_id: string;
	id: string;
	created_at: string;
	hash: string | null;
	input_fp: string | null;
}

/**
 * Scan recent cold turns and surface drift findings.
 */
export function runStablePrefixDriftValidation(
	db: Database,
	siteId: string,
	nowMs: number,
): StablePrefixDriftReport {
	// Update the last-run marker BEFORE scanning so even an empty
	// scan window records a successful pass (mirrors r-vc9 pattern).
	updateLastRun(db, siteId, nowMs);

	const cutoff = new Date(nowMs - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
	const rows = db
		.prepare(
			`SELECT
				thread_id,
				id,
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
		.all(cutoff) as ColdTurnRow[];

	let pairsExamined = 0;
	let composeDriftCount = 0;
	let collectDriftCount = 0;
	const leaks: StablePrefixDriftLeak[] = [];

	for (let i = 1; i < rows.length; i++) {
		const prev = rows[i - 1];
		const curr = rows[i];
		// Only pair within the same thread.
		if (prev.thread_id !== curr.thread_id) continue;

		// Pair must fall within the cache TTL window. Across-TTL
		// drift is expected (fresh cache write) and uninteresting.
		const prevMs = Date.parse(prev.created_at);
		const currMs = Date.parse(curr.created_at);
		if (!Number.isFinite(prevMs) || !Number.isFinite(currMs)) continue;
		if (currMs - prevMs > PAIR_WINDOW_MS) continue;

		pairsExamined++;

		if (curr.hash === prev.hash) continue; // No drift.

		// Same input fingerprint, different output hash → compose leak.
		if (curr.input_fp !== null && prev.input_fp !== null && curr.input_fp === prev.input_fp) {
			composeDriftCount++;
			leaks.push(buildLeak("compose", curr, prev));
			continue;
		}

		// Different input fingerprint with no covering change_log row → collect leak.
		// We check `change_log` for any row touching the stable-side
		// data sources between the two turns. If no covering change
		// is found, the input fingerprint shifted without a
		// declared write — the collector is reading something it
		// shouldn't.
		if (curr.input_fp !== prev.input_fp) {
			const hasCoveringChange = changeLogTouchedStableSources(db, prev.created_at, curr.created_at);
			if (!hasCoveringChange) {
				collectDriftCount++;
				leaks.push(buildLeak("collect", curr, prev));
			}
		}
	}

	return {
		pairsExamined,
		composeDriftCount,
		collectDriftCount,
		leaks,
	};
}

/**
 * Returns true when the cadence gate has elapsed (or no last-run
 * marker exists).
 */
export function shouldRunStablePrefixDriftValidation(db: Database, nowMs: number): boolean {
	const row = db
		.prepare("SELECT value FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get("_validation:stable-prefix-drift-last-run") as { value: string } | null;

	if (!row) return true;

	try {
		const lastRunMs = new Date(row.value).getTime();
		return nowMs - lastRunMs >= VALIDATION_INTERVAL_MS;
	} catch (_e) {
		return true;
	}
}

function updateLastRun(db: Database, siteId: string, nowMs: number): void {
	const lastRunKey = "_validation:stable-prefix-drift-last-run";
	const lastRunId = deterministicUUID(BOUND_NAMESPACE, lastRunKey);
	const lastRunValue = new Date(nowMs).toISOString();
	try {
		updateRow(
			db,
			"semantic_memory",
			lastRunId,
			{ modified_at: lastRunValue, value: lastRunValue },
			siteId,
		);
	} catch (_e) {
		try {
			insertRow(
				db,
				"semantic_memory",
				{
					id: lastRunId,
					key: lastRunKey,
					value: lastRunValue,
					tier: "default",
					source: "validation:stable-prefix-drift",
					modified_at: lastRunValue,
					last_accessed_at: lastRunValue,
					created_at: lastRunValue,
					deleted: 0,
				},
				siteId,
			);
		} catch (insertErr) {
			console.warn("[stable-prefix-drift] last-run write failed:", insertErr);
		}
	}
}

/**
 * Tables whose change_log rows could legitimately shift the
 * stable-side input fingerprint between two cold rebuilds:
 *
 *   - `semantic_memory`: pinned + summary tier bodies (Working
 *     Knowledge stable channel) and detail tier title metadata
 *     (Discoverable Archive). Note: `last_accessed_at` bumps via
 *     `bumpRenderedDetailEntries` are a documented outbox-exempt
 *     narrow exception (per CONTRIBUTING.md #1) and intentionally
 *     do NOT generate change_log rows. They DO advance the input
 *     fingerprint (because `last_accessed_at` is part of
 *     `DetailEntryView`), so a lone bump can produce a "collect
 *     drift" finding. Whether to suppress those is a v2 question;
 *     for v1, surfacing them is informative.
 *
 *   - `skills`: skill index entries (the active set drives the
 *     rendered `<available_skills>` block).
 *
 *   - `advisories`, `files`, `overlay_index`: NOT consulted by the
 *     stable-side renderer. Listed here only so future additions
 *     to the stable-side input set don't silently fail to update
 *     this list — the JSDoc on `StableVolatileInputs` makes the
 *     boundary explicit.
 */
const STABLE_SIDE_TABLES = ["semantic_memory", "skills"] as const;

function changeLogTouchedStableSources(db: Database, fromIso: string, toIso: string): boolean {
	const placeholders = STABLE_SIDE_TABLES.map(() => "?").join(",");
	// `change_log.timestamp` is the wall-clock anchor (HLC encodes
	// causal order; timestamp is the literal ISO instant of the
	// write). We pair on timestamp because the upstream `created_at`
	// on `turns` is similarly wall-clock — apples-to-apples.
	const row = db
		.prepare(
			`SELECT 1 AS hit FROM change_log
			WHERE table_name IN (${placeholders})
				AND timestamp > ?
				AND timestamp <= ?
			LIMIT 1`,
		)
		.get(...STABLE_SIDE_TABLES, fromIso, toIso) as { hit: number } | null;
	return row !== null;
}

function buildLeak(
	flavor: "compose" | "collect",
	curr: ColdTurnRow,
	prev: ColdTurnRow,
): StablePrefixDriftLeak {
	return {
		flavor,
		thread_id: curr.thread_id,
		prev_turn_id: prev.id,
		curr_turn_id: curr.id,
		prev_created_at: prev.created_at,
		curr_created_at: curr.created_at,
		prev_hash: prev.hash,
		curr_hash: curr.hash,
		prev_input_fp: prev.input_fp,
		curr_input_fp: curr.input_fp,
	};
}
