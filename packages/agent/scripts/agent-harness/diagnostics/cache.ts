/**
 * Cache diagnostic — the v1 user of the agent-harness scaffold.
 *
 * Per turn, extracts:
 *   - cache path (cold/warm/unknown) from `context_debug.cachePath`
 *   - system + message cache-marker counts from raw wire bodies
 *   - cache_read / cache_write from already-normalized `usage`
 *   - first byte index where the latest wire body diverges from the prior
 *     cold turn's wire body — the killer field for tracking down which
 *     content shifted at a cache-thrash boundary
 *
 * Renders a per-turn table plus cumulative footer (hit rate, longest
 * stable-cache run, total cost).
 *
 * Provider-agnostic: the marker counts come from the
 * `scanWireBodyForCacheMarkers` scanner (single set of well-known JSON
 * key names handles every supported provider).
 */

import { firstByteDiff, scanWireBodyForCacheMarkers } from "../capture";
import type { Diagnostic, DiagnosticTurnData } from "./types";

interface CacheTurnRecord {
	turn: number;
	path: "cold" | "warm" | "unknown";
	sysCp: number;
	msgCp: number;
	msgCpOffsets: number[];
	cr: number | null;
	cw: number | null;
	costUsd: number;
	/** First byte index where this turn's first wire body diverges from
	 *  the previous turn's first wire body. -1 = byte-identical. null = no
	 *  prior turn or no body to compare. */
	wireDiffVsPrev: number | null;
	/** First wire body's length in bytes (used for diff context). */
	bodyLen: number;
}

/**
 * Build a fresh cache diagnostic. Wire-body diff state is scoped to the
 * returned object — calling this twice in the same process yields two
 * independent diagnostic instances, each tracking its own `priorBody`.
 * The exported `cacheDiagnostic` is a default singleton built at module
 * load.
 */
export function buildCacheDiagnostic(): Diagnostic {
	// Per-instance state: tracks the previous turn's first wire body so
	// `wireDiffVsPrev` can report the first byte where the wire changed.
	// Scoped to this closure so multiple harness invocations in one
	// process don't poison each other's state.
	let priorBody: string | null = null;
	return {
		name: "cache",
		description: "Per-turn cache markers + cr/cw + wire byte-diff vs prior turn",

		collect(data: DiagnosticTurnData): Record<string, unknown> {
			// First wire body of the turn — the agent-loop's first inference call.
			// (Inner-loop tool round-trips after the first call may differ in
			// shape; the first call carries the cache marker placement we care
			// about.)
			const firstBody = data.wireBodies[0]?.body ?? "";
			const inspect = firstBody ? scanWireBodyForCacheMarkers(firstBody) : null;
			let wireDiffVsPrev: number | null = null;
			if (firstBody) {
				wireDiffVsPrev = priorBody === null ? null : firstByteDiff(priorBody, firstBody);
				priorBody = firstBody;
			}
			const record: CacheTurnRecord = {
				turn: data.turn,
				path: data.cachePath,
				sysCp: inspect?.systemMarkers ?? 0,
				msgCp: inspect?.messageMarkers ?? 0,
				msgCpOffsets: inspect?.messageMarkerByteOffsets ?? [],
				cr: data.usage?.cache_read_tokens ?? null,
				cw: data.usage?.cache_write_tokens ?? null,
				costUsd: data.costUsd,
				wireDiffVsPrev,
				bodyLen: firstBody.length,
			};
			return record as unknown as Record<string, unknown>;
		},

		render(perTurnRecords: ReadonlyArray<Record<string, unknown>>): string {
			return renderCacheReport(perTurnRecords as unknown as ReadonlyArray<CacheTurnRecord>);
		},
	};
}

function renderCacheReport(recs: ReadonlyArray<CacheTurnRecord>): string {
	if (recs.length === 0) {
		return "(no turns completed)\n";
	}

	const lines: string[] = [];
	lines.push("  n  path  sys  msg  cr        cw        cost_usd  wire_diff_vs_prev");
	lines.push("  -- ----  ---  ---  --------  --------  --------  -----------------");
	for (const r of recs) {
		const diff =
			r.wireDiffVsPrev === null
				? "n/a"
				: r.wireDiffVsPrev === -1
					? "stable"
					: `@${r.wireDiffVsPrev} of ${r.bodyLen}`;
		lines.push(
			`  ${pad(String(r.turn), 2)} ${pad(r.path, 5)} ${pad(String(r.sysCp), 3)}  ${pad(String(r.msgCp), 3)}  ${pad(formatTokens(r.cr), 8)}  ${pad(formatTokens(r.cw), 8)}  ${pad(r.costUsd.toFixed(4), 8)}  ${diff}`,
		);
	}

	// Cumulative stats.
	const totalCr = recs.reduce((s, r) => s + (r.cr ?? 0), 0);
	const totalCw = recs.reduce((s, r) => s + (r.cw ?? 0), 0);
	const totalCost = recs.reduce((s, r) => s + r.costUsd, 0);
	const hitRate = totalCr + totalCw === 0 ? 0 : (100 * totalCr) / (totalCr + totalCw);
	const longestStable = longestRunOf(
		recs,
		(r) => r.wireDiffVsPrev === -1 || r.wireDiffVsPrev === null,
	);

	lines.push("");
	lines.push("  cumulative:");
	lines.push(`    total_cr:           ${totalCr.toLocaleString()}`);
	lines.push(`    total_cw:           ${totalCw.toLocaleString()}`);
	lines.push(`    cache_hit_rate:     ${hitRate.toFixed(2)}%`);
	lines.push(`    total_cost_usd:     ${totalCost.toFixed(4)}`);
	lines.push(`    longest_stable_run: ${longestStable} turns`);
	return lines.join("\n");
}

function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function formatTokens(n: number | null): string {
	if (n === null) return "-";
	return n.toLocaleString();
}

function longestRunOf<T>(arr: ReadonlyArray<T>, pred: (x: T) => boolean): number {
	let best = 0;
	let cur = 0;
	for (const x of arr) {
		if (pred(x)) {
			cur += 1;
			if (cur > best) best = cur;
		} else {
			cur = 0;
		}
	}
	return best;
}
