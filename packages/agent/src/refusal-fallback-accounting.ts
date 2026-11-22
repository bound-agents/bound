/**
 * Per-attempt provenance and cost accounting for refusal-fallback turns
 * (slice 5, R-RT21, 2026-11-21-model-routing.md §7.4).
 *
 * A single turn can execute multiple attempts — a refused primary attempt plus
 * a credited fallback attempt, or a failed route trial plus a failover attempt.
 * Each attempt is recorded separately in `turns.cost_breakdown`. Tokens from
 * different models are NEVER summed into one model's totals: the top-level
 * four-component split stays the SERVED model's cost only (the metrics route
 * reads `json_extract(cost_breakdown, '$.input')` etc. off it), and the
 * per-attempt detail rides in an optional `attempts` array alongside it. A turn
 * with a single clean attempt carries no `attempts` array, so its row is
 * byte-identical to a pre-slice-5 turn and the metrics aggregation is unchanged.
 */

import type { TurnCostBreakdown } from "./agent-loop-utils";

/** Per-attempt token counts, model-scoped — never summed across models. */
export interface AttemptTokens {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
}

/** One recorded inference attempt within a turn (§7.4). */
export interface AttemptRecord {
	/** Logical model this attempt ran against. */
	model_id: string;
	/** RouteId that served (or would have served) the attempt, or null. */
	route_id: string | null;
	/** Terminal outcome of the attempt. */
	outcome: "ok" | "route-error" | "refusal";
	/** Provider refusal category when `outcome === "refusal"`, else null. */
	refusal_category: string | null;
	/** Whether an endpoint-bound fallback credit was redeemed on this attempt. */
	credit_redeemed: boolean;
	/** Model-scoped token counts for this attempt. */
	tokens: AttemptTokens;
	/** This attempt's USD cost. */
	cost_usd: number;
}

/**
 * The turn's `cost_breakdown`, extended with an optional per-attempt array
 * (R-RT21). The four top-level components remain the SERVED model's cost split
 * so the metrics route's `json_extract` paths are unchanged.
 */
export interface TurnCostBreakdownWithAttempts extends TurnCostBreakdown {
	/**
	 * Present only when a turn executed more than one attempt (refusal +
	 * fallback, or a route trial + failover). Absent for a single clean attempt.
	 */
	attempts?: AttemptRecord[];
}

export interface BuildTurnCostBreakdownArgs {
	/**
	 * The served model's four-component cost split, or null when no split is
	 * available (e.g. a plain-number `price(turn)` callback). Null collapses the
	 * top-level components to zero while still recording attempts.
	 */
	served: TurnCostBreakdown | null;
	/** Every attempt executed this turn, in execution order. */
	attempts: AttemptRecord[];
}

/**
 * Build the turn's `cost_breakdown`. The top-level components are the served
 * model's split (or zeros when unavailable). An `attempts` array is attached
 * only when the turn executed more than one attempt — a lone served attempt
 * produces a bare four-component breakdown indistinguishable from a
 * pre-slice-5 turn.
 */
export function buildTurnCostBreakdownWithAttempts(
	args: BuildTurnCostBreakdownArgs,
): TurnCostBreakdownWithAttempts {
	const served = args.served ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const breakdown: TurnCostBreakdownWithAttempts = {
		input: served.input,
		output: served.output,
		cacheRead: served.cacheRead,
		cacheWrite: served.cacheWrite,
	};
	// Only attach the per-attempt detail when there was genuinely more than one
	// attempt. A single attempt means no refusal/failover happened this turn.
	if (args.attempts.length > 1) {
		breakdown.attempts = args.attempts;
	}
	return breakdown;
}

/**
 * Pick the attempt that actually served the turn (the first `ok` outcome), or
 * null when every attempt refused or errored. Used to stamp the turn's
 * authoritative `model_id` / `route_id` after a substitution.
 */
export function summarizeServedAttempt(attempts: AttemptRecord[]): AttemptRecord | null {
	return attempts.find((a) => a.outcome === "ok") ?? null;
}
