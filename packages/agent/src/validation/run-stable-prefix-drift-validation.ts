/**
 * Stable-prefix drift validator.
 *
 * Scans recent cold rebuilds (the only path that recomputes the
 * stable prefix) and surfaces leaks where two consecutive rebuilds
 * on the same thread within the cache TTL window produced different
 * `stableSubsectionHash` values.
 *
 * The compared output is the stable volatile subsection, not the whole
 * system prompt: `stablePrefixInputFingerprint` covers exactly the
 * inputs that subsection depends on, and both values describe the same
 * rendered snapshot (a cache hit records the fingerprint captured with
 * the cached bytes). Only rows whose `stablePrefixDriftVersion` equals
 * `STABLE_PREFIX_DRIFT_VERSION` are compared, so records from another
 * renderer/fingerprint generation never pair.
 *
 * The validator distinguishes two flavors of drift based on the
 * fingerprint:
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
 *     no `change_log` row covering `semantic_memory | skills | hosts`
 *     or a sibling thread's `threads.summary` change between the two
 *     fingerprints' collect instants (`stablePrefixRenderedAt`; a cache
 *     hit's fingerprint was collected at its original render, not at the
 *     turn), and the local `change_log` provably retains that whole
 *     window. Either the input collector is reading something
 *     that doesn't go through the outbox (a documented narrow
 *     exception, e.g., `last_accessed_at` bumps) and that something
 *     leaked into the fingerprint, OR the collector is reading
 *     undeclared signals.
 *
 * Pairs that cannot be classified are reported as `unknown`, not as
 * leaks (#304): turns from different producer hosts (`host_origin`),
 * and uncovered fingerprint shifts where pruning may have removed the
 * covering `change_log` row. Missing history is not evidence that no
 * declared input changed.
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
import { STABLE_PREFIX_DRIFT_VERSION } from "../stable-prefix";
import { isValidationDue, recordValidationRun } from "./validation-entries";

const DRIFT_LAST_RUN_KEY = "_validation:stable-prefix-drift-last-run";

/**
 * Cadence gate. One heartbeat cycle (1h) aligns with the cache TTL —
 * any drift within a single TTL window gets at least one detection
 * pass. Drift across TTL boundaries is uninteresting (the cache
 * naturally rebuilds; no way to attribute the change).
 */
const VALIDATION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Cache TTL window for pairing turns, fixed at the longest (1h) cache
 * lifetime. Shorter-TTL threads scanned with the same window produce fewer
 * pairs but no false positives (5m pairs are a strict subset of 1h pairs).
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

/**
 * A drifted pair the detector cannot attribute (#304). Not a leak: the
 * evidence needed to classify it is unavailable.
 *
 *   - `cross-host`: the two turns were produced by different hosts, whose
 *     host-local inputs (the `local` model flags, access-time hints,
 *     replica lag) legitimately differ.
 *   - `incomplete-history`: the local `change_log` no longer retains rows
 *     back to the earlier turn (sync pruning removes peer-confirmed
 *     entries), so the absence of a covering row proves nothing.
 */
export interface StablePrefixDriftUnknown {
	reason: "cross-host" | "incomplete-history";
	thread_id: string;
	prev_turn_id: string;
	curr_turn_id: string;
	prev_host: string | null;
	curr_host: string | null;
}

export interface StablePrefixDriftReport {
	pairsExamined: number;
	composeDriftCount: number;
	collectDriftCount: number;
	/** Drifted pairs that could not be classified; see {@link StablePrefixDriftUnknown}. */
	unknownCount: number;
	unknown: StablePrefixDriftUnknown[];
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
	drift_version: number | null;
	/** Instant the stable bytes and fingerprint were collected (cache hits: original render). */
	rendered_at: string | null;
	host_origin: string | null;
}

/**
 * Scan recent cold turns and surface drift findings.
 */
export function runStablePrefixDriftValidation(
	db: Database,
	siteId: string,
	nowMs: number,
): StablePrefixDriftReport {
	// Record the run BEFORE scanning so an empty window still records a pass.
	recordValidationRun(db, siteId, DRIFT_LAST_RUN_KEY, "validation:stable-prefix-drift", nowMs);

	const cutoff = new Date(nowMs - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
	const rows = db
		.prepare(
			`SELECT
				thread_id,
				id,
				created_at,
				json_extract(context_debug, '$.stableSubsectionHash') AS hash,
				json_extract(context_debug, '$.stablePrefixInputFingerprint') AS input_fp,
				json_extract(context_debug, '$.stablePrefixDriftVersion') AS drift_version,
				json_extract(context_debug, '$.stablePrefixRenderedAt') AS rendered_at,
				host_origin
			FROM turns
			WHERE created_at >= ?
				AND deleted = 0
				AND json_extract(context_debug, '$.cachePath') = 'cold'
				AND json_extract(context_debug, '$.stableSubsectionHash') IS NOT NULL
			ORDER BY thread_id ASC, created_at ASC`,
		)
		.all(cutoff) as ColdTurnRow[];

	let pairsExamined = 0;
	let composeDriftCount = 0;
	let collectDriftCount = 0;
	const leaks: StablePrefixDriftLeak[] = [];
	const unknown: StablePrefixDriftUnknown[] = [];
	const markUnknown = (
		reason: StablePrefixDriftUnknown["reason"],
		curr: ColdTurnRow,
		prev: ColdTurnRow,
	): void => {
		unknown.push({
			reason,
			thread_id: curr.thread_id,
			prev_turn_id: prev.id,
			curr_turn_id: curr.id,
			prev_host: prev.host_origin,
			curr_host: curr.host_origin,
		});
	};

	for (let i = 1; i < rows.length; i++) {
		const prev = rows[i - 1];
		const curr = rows[i];
		// Only pair within the same thread.
		if (prev.thread_id !== curr.thread_id) continue;
		// Only compare records of the current renderer/fingerprint generation.
		// Rows from another generation (including pre-#303 rows, which hashed
		// the whole system prompt) measure a different scope, so any
		// difference between them says nothing about a leak. The turn still
		// acts as a pairing boundary: it is a cold rebuild between the two.
		if (
			prev.drift_version !== STABLE_PREFIX_DRIFT_VERSION ||
			curr.drift_version !== STABLE_PREFIX_DRIFT_VERSION
		) {
			continue;
		}

		// Pair must fall within the cache TTL window. Across-TTL
		// drift is expected (fresh cache write) and uninteresting.
		const prevMs = Date.parse(prev.created_at);
		const currMs = Date.parse(curr.created_at);
		if (!Number.isFinite(prevMs) || !Number.isFinite(currMs)) continue;
		if (currMs - prevMs > PAIR_WINDOW_MS) continue;

		pairsExamined++;

		if (curr.hash === prev.hash) continue; // No drift.

		// Different producers render from different host-local inputs and
		// different replicas; neither flavor can be attributed (#304).
		if (prev.host_origin !== curr.host_origin) {
			markUnknown("cross-host", curr, prev);
			continue;
		}

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
			// The window spans the two fingerprints' collect instants, not the
			// turns' times: a stable-subsection cache hit records the fingerprint
			// taken when its bytes were rendered, up to one cache TTL before the
			// turn, so a write between that render and the turn already moved
			// the fingerprint the turn reports (#303).
			const fromIso = renderedAt(prev);
			const toIso = renderedAt(curr);
			const coverage = changeLogTouchedStableSources(db, curr.thread_id, fromIso, toIso);
			if (coverage === "covered") continue;
			// An uncovered shift is only evidence of a collector leak when the
			// local change_log provably still holds every row in the window, and
			// every sibling `threads` write in it can be compared against that
			// sibling's previous logged row.
			if (coverage === "unprovable" || !changeLogRetainedSince(db, fromIso)) {
				markUnknown("incomplete-history", curr, prev);
				continue;
			}
			collectDriftCount++;
			leaks.push(buildLeak("collect", curr, prev));
		}
	}

	return {
		pairsExamined,
		composeDriftCount,
		collectDriftCount,
		unknownCount: unknown.length,
		unknown,
		leaks,
	};
}

/** True when the cadence gate has elapsed or no last-run marker exists. */
export function shouldRunStablePrefixDriftValidation(db: Database, nowMs: number): boolean {
	return isValidationDue(db, DRIFT_LAST_RUN_KEY, nowMs, VALIDATION_INTERVAL_MS);
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
 *   - `hosts`: cluster model topology drives the `<stable-context>`
 *     models section (model→host mapping + the per-model `local`
 *     flag, from each host row's `models` JSON). Only the configured
 *     model set participates in the rendered bytes — NOT `online_at`
 *     liveness, which flaps on every heartbeat and is deliberately
 *     excluded from the projection (see `ClusterModelView`). A
 *     topology change (a host adding/dropping a model) advances the
 *     input fingerprint AND writes a `hosts` change_log row, so it is
 *     correctly classified as a collect-covered change rather than a
 *     compose leak. A bare `online_at` bump writes a `hosts` row too,
 *     but does not move the fingerprint, so it never triggers a
 *     finding.
 *
 *   - `threads`: cross-thread summaries (`threads.summary`) seed the
 *     stable channel and are folded into the input fingerprint, so a
 *     sibling thread's summary update is a covering write. Only that
 *     write covers: every loop turn bumps its own thread's
 *     `last_message_at`, and active siblings bump theirs, so treating
 *     any `threads` row as coverage would mask every collect leak. A
 *     `threads` row covers only when it belongs to another thread and
 *     its `summary` differs from that thread's previous logged row. A
 *     sibling row with no earlier logged row proves nothing either way
 *     (pruning may have dropped its predecessor), so it leaves the pair
 *     unclassifiable rather than covered.
 *
 *   - `advisories`, `files`: NOT consulted by the
 *     stable-side renderer. Listed here only so future additions
 *     to the stable-side input set don't silently fail to update
 *     this list — the JSDoc on `StableVolatileInputs` makes the
 *     boundary explicit.
 */
const STABLE_SIDE_TABLES = ["semantic_memory", "skills", "hosts"] as const;

/**
 * Coverage verdict for one drifted pair's window:
 *
 *   - `covered`: a declared input provably changed, so the shift is benign.
 *   - `unprovable`: no proven change, but a sibling `threads` write in the
 *     window has no earlier logged row to compare its summary against.
 *   - `uncovered`: nothing in the window could have moved the fingerprint.
 */
type StableSourceCoverage = "covered" | "unprovable" | "uncovered";

/**
 * Classifies the window `(fromIso, toIso]` against the change_log rows that
 * could legitimately move the stable-side input fingerprint of `threadId`: any
 * {@link STABLE_SIDE_TABLES} row, or a sibling thread's summary change. This
 * is the "did the stable prefix's own inputs actually change" check the drift
 * detector uses to rule out a benign, expected fingerprint shift.
 */
function changeLogTouchedStableSources(
	db: Database,
	threadId: string,
	fromIso: string,
	toIso: string,
): StableSourceCoverage {
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
	if (row !== null) return "covered";
	return siblingSummaryCoverage(db, threadId, fromIso, toIso);
}

/**
 * Classifies sibling `threads` writes inside `(fromIso, toIso]`. `row_data`
 * carries the full post-write row, so a summary change is a row whose summary
 * differs from the same thread's previous logged row (`covered`). A sibling
 * row with no earlier logged row cannot be compared: pruning removes an HLC
 * prefix, so its predecessor may be gone and an unchanged summary would look
 * new. Such a row makes the window `unprovable` unless another row proves a
 * change. Writes to `threadId` itself never count: its own `last_message_at`
 * advances on every turn, and its summary is not part of its own stable
 * prefix.
 */
function siblingSummaryCoverage(
	db: Database,
	threadId: string,
	fromIso: string,
	toIso: string,
): StableSourceCoverage {
	const row = db
		.prepare(
			`SELECT
				MAX(prev_hlc IS NOT NULL AND summary IS NOT prev_summary) AS changed,
				MAX(prev_hlc IS NULL) AS orphaned
			FROM (
				SELECT
					json_extract(c.row_data, '$.summary') AS summary,
					p.hlc AS prev_hlc,
					json_extract(p.row_data, '$.summary') AS prev_summary
				FROM change_log c
				LEFT JOIN change_log p ON p.hlc = (
					SELECT q.hlc FROM change_log q
					WHERE q.table_name = 'threads'
						AND q.row_id = c.row_id
						AND q.hlc < c.hlc
					ORDER BY q.hlc DESC
					LIMIT 1
				)
				WHERE c.table_name = 'threads'
					AND c.row_id != ?
					AND c.timestamp > ?
					AND c.timestamp <= ?
			)`,
		)
		.get(threadId, fromIso, toIso) as { changed: number | null; orphaned: number | null } | null;
	if (row?.changed === 1) return "covered";
	if (row?.orphaned === 1) return "unprovable";
	return "uncovered";
}

/**
 * True when the local `change_log` provably retains every row written after
 * `fromIso`. Pruning deletes a prefix (`hlc <= cutoff`), so a surviving row
 * stamped at or before `fromIso` shows nothing later was pruned. An empty log,
 * or one whose oldest row is newer than `fromIso`, may have lost rows inside
 * the window, and the caller must treat missing coverage as unknown (#304).
 */
function changeLogRetainedSince(db: Database, fromIso: string): boolean {
	const row = db
		.prepare("SELECT 1 AS hit FROM change_log WHERE timestamp <= ? LIMIT 1")
		.get(fromIso) as { hit: number } | null;
	return row !== null;
}

/**
 * Collect instant of a turn's recorded fingerprint. Current-generation rows
 * always carry `stablePrefixRenderedAt`; `created_at` is a defensive fallback
 * for a row missing it, equal to the render time on a fresh render.
 */
function renderedAt(row: ColdTurnRow): string {
	return row.rendered_at ?? row.created_at;
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
