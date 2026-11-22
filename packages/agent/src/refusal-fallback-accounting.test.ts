import { describe, expect, it } from "bun:test";
import {
	type AttemptRecord,
	buildTurnCostBreakdownWithAttempts,
	summarizeServedAttempt,
} from "./refusal-fallback-accounting";

/**
 * Tests for per-attempt provenance + cost accounting (slice 5, R-RT21,
 * 2026-11-21-model-routing.md §7.4). A single turn can execute multiple
 * attempts (a refused primary plus a credited fallback). Each attempt is
 * recorded separately; tokens from different models are NEVER summed into one
 * model's totals.
 */

const refusedPrimary: AttemptRecord = {
	model_id: "opus",
	route_id: "siteA:anthropic:opus",
	outcome: "refusal",
	refusal_category: "cyber",
	credit_redeemed: false,
	tokens: { input: 100, output: 0, cache_read: 0, cache_write: 50 },
	cost_usd: 0.01,
};

const fallbackServed: AttemptRecord = {
	model_id: "sonnet",
	route_id: "siteA:anthropic:sonnet",
	outcome: "ok",
	refusal_category: null,
	credit_redeemed: true,
	tokens: { input: 120, output: 40, cache_read: 0, cache_write: 60 },
	cost_usd: 0.02,
};

describe("buildTurnCostBreakdownWithAttempts", () => {
	it("records every attempt separately (refused + fallback = two entries)", () => {
		const breakdown = buildTurnCostBreakdownWithAttempts({
			served: { input: 0.012, output: 0.004, cacheRead: 0, cacheWrite: 0.006 },
			attempts: [refusedPrimary, fallbackServed],
		});
		expect(breakdown.attempts).toHaveLength(2);
		expect(breakdown.attempts?.[0]?.outcome).toBe("refusal");
		expect(breakdown.attempts?.[1]?.outcome).toBe("ok");
	});

	it("keeps the served-model four-component totals at the top level (metrics route reads these)", () => {
		const breakdown = buildTurnCostBreakdownWithAttempts({
			served: { input: 0.012, output: 0.004, cacheRead: 0, cacheWrite: 0.006 },
			attempts: [refusedPrimary, fallbackServed],
		});
		// The top-level split is the SERVED model's cost only — it never sums the
		// refused attempt's tokens or the fallback's into one model's record.
		expect(breakdown.input).toBe(0.012);
		expect(breakdown.output).toBe(0.004);
		expect(breakdown.cacheWrite).toBe(0.006);
	});

	it("never sums tokens across different models", () => {
		const breakdown = buildTurnCostBreakdownWithAttempts({
			served: { input: 0.012, output: 0.004, cacheRead: 0, cacheWrite: 0.006 },
			attempts: [refusedPrimary, fallbackServed],
		});
		// Each attempt's token record stays distinct and model-scoped.
		const byModel = new Map(breakdown.attempts?.map((a) => [a.model_id, a.tokens]));
		expect(byModel.get("opus")?.input).toBe(100);
		expect(byModel.get("sonnet")?.input).toBe(120);
		// No combined "opus" record absorbing sonnet's 120 input.
		expect(byModel.get("opus")?.input).not.toBe(220);
	});

	it("omits the attempts array entirely for a single clean attempt (back-compat)", () => {
		const breakdown = buildTurnCostBreakdownWithAttempts({
			served: { input: 0.012, output: 0.004, cacheRead: 0, cacheWrite: 0.006 },
			attempts: [fallbackServed],
		});
		// One attempt and it's the served one → no attempts array; the row looks
		// exactly like a pre-slice-5 turn so the metrics aggregation is unchanged.
		expect(breakdown.attempts).toBeUndefined();
	});

	it("preserves a null served breakdown but still records attempts when there was a refusal", () => {
		const breakdown = buildTurnCostBreakdownWithAttempts({
			served: null,
			attempts: [refusedPrimary, fallbackServed],
		});
		// No served split (e.g. plain-number price callback) but two attempts still
		// recorded for provenance.
		expect(breakdown.input).toBe(0);
		expect(breakdown.attempts).toHaveLength(2);
	});
});

describe("summarizeServedAttempt", () => {
	it("marks the ok attempt as served and carries its route", () => {
		const s = summarizeServedAttempt([refusedPrimary, fallbackServed]);
		expect(s?.model_id).toBe("sonnet");
		expect(s?.route_id).toBe("siteA:anthropic:sonnet");
	});

	it("returns null when no attempt succeeded", () => {
		const s = summarizeServedAttempt([refusedPrimary]);
		expect(s).toBeNull();
	});
});
