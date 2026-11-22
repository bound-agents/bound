import { describe, expect, it } from "bun:test";
import { type CreditRedemptionContext, planCreditRedemption } from "./fallback-credit";
import type { DriverFallbackSupport } from "./fallback-policy";
import type { ModelDeclinedOutcome } from "./model-declined";

/**
 * Tests for the fallback-credit redemption planner (slice 5, R-RT18,
 * 2026-11-21-model-routing.md §7.3 step 2, catalog §7.1). This is the PURE
 * decision layer: given a classified refusal carrying a credit token, the
 * active driver's capability descriptor, the next fallback target, and where
 * that target is served, it decides whether the credited inline retry is
 * eligible and, if so, the ordered step-down attempt plan. It does not perform
 * HTTP.
 */

const BEDROCK: DriverFallbackSupport = {
	server_side_auto: false,
	publishes_allowed_targets: false,
	supports_fallback_credit: true,
};
const ANTHROPIC: DriverFallbackSupport = {
	server_side_auto: true,
	publishes_allowed_targets: true,
	supports_fallback_credit: true,
};
const COPILOT: DriverFallbackSupport = {
	server_side_auto: false,
	publishes_allowed_targets: false,
	supports_fallback_credit: false,
};

function refusal(overrides: Partial<ModelDeclinedOutcome> = {}): ModelDeclinedOutcome {
	return {
		kind: "model-declined",
		vendor: "anthropic",
		category: "cyber",
		raw_reason: "refusal",
		substitutable: true,
		credit: { token: "tok-123", endpoint: "ep-A", has_prefill_claim: true },
		...overrides,
	};
}

function ctx(overrides: Partial<CreditRedemptionContext> = {}): CreditRedemptionContext {
	return {
		driver: BEDROCK,
		outcome: refusal(),
		targetModel: "sonnet",
		targetEndpoint: "ep-A",
		executingEndpoint: "ep-A",
		serverToolsRan: false,
		...overrides,
	};
}

describe("planCreditRedemption — eligibility", () => {
	it("is ineligible when the driver does not support fallback credit", () => {
		const plan = planCreditRedemption(ctx({ driver: COPILOT }));
		expect(plan.eligible).toBe(false);
		expect(plan.reason).toBe("driver-unsupported");
	});

	it("is ineligible when no credit token is present", () => {
		const plan = planCreditRedemption(ctx({ outcome: refusal({ credit: undefined }) }));
		expect(plan.eligible).toBe(false);
		expect(plan.reason).toBe("no-token");
	});

	it("is ineligible (forfeits credit) when the target is not co-located on the same endpoint", () => {
		const plan = planCreditRedemption(ctx({ targetEndpoint: "ep-B", executingEndpoint: "ep-A" }));
		expect(plan.eligible).toBe(false);
		expect(plan.reason).toBe("not-co-located");
	});

	it("surfaces an error instead of retrying uncredited when server tools already ran", () => {
		const plan = planCreditRedemption(ctx({ serverToolsRan: true }));
		expect(plan.eligible).toBe(false);
		expect(plan.reason).toBe("server-tools-ran");
		expect(plan.surfaceError).toBe(true);
	});

	it("is eligible for a co-located target on a credit-supporting driver", () => {
		const plan = planCreditRedemption(ctx());
		expect(plan.eligible).toBe(true);
	});
});

describe("planCreditRedemption — step-down order (Bedrock, has_prefill_claim present/absent)", () => {
	it("prefill-claim TRUE: continuation body → unchanged+token → drop token", () => {
		const plan = planCreditRedemption(
			ctx({
				outcome: refusal({ credit: { token: "t", endpoint: "ep-A", has_prefill_claim: true } }),
			}),
		);
		expect(plan.eligible).toBe(true);
		expect(plan.steps.map((s) => s.kind)).toEqual([
			"continuation-body",
			"unchanged-plus-token",
			"drop-token",
		]);
		// Every credited step carries the token except the final forfeit.
		expect(plan.steps[0]?.includeToken).toBe(true);
		expect(plan.steps[1]?.includeToken).toBe(true);
		expect(plan.steps[2]?.includeToken).toBe(false);
	});

	it("prefill-claim ABSENT (Bedrock omitted): same step-down shape as TRUE", () => {
		const plan = planCreditRedemption(
			ctx({ outcome: refusal({ credit: { token: "t", endpoint: "ep-A" } }) }),
		);
		expect(plan.steps.map((s) => s.kind)).toEqual([
			"continuation-body",
			"unchanged-plus-token",
			"drop-token",
		]);
	});

	it("prefill-claim FALSE: skips the continuation body, starts at unchanged+token", () => {
		const plan = planCreditRedemption(
			ctx({
				outcome: refusal({ credit: { token: "t", endpoint: "ep-A", has_prefill_claim: false } }),
			}),
		);
		expect(plan.steps.map((s) => s.kind)).toEqual(["unchanged-plus-token", "drop-token"]);
	});

	it("when server tools ran, the drop-token forfeit step is NOT present", () => {
		const plan = planCreditRedemption(ctx({ serverToolsRan: true }));
		expect(plan.steps).toEqual([]);
	});
});

describe("planCreditRedemption — identical beta flags and unstripped thinking", () => {
	it("every credited step preserves the identical beta flags and keeps thinking blocks", () => {
		const plan = planCreditRedemption(ctx());
		for (const step of plan.steps) {
			if (step.includeToken) {
				expect(step.stripThinking).toBe(false);
				expect(step.preserveBetaFlags).toBe(true);
			}
		}
	});

	it("the server-side-auto Anthropic driver plans server-side fallback, not a Bedrock replay", () => {
		// Anthropic expresses fallback server-side; the planner marks the credited
		// path as server-side rather than the Bedrock replay step-down.
		const plan = planCreditRedemption(
			ctx({ driver: ANTHROPIC, outcome: refusal({ vendor: "anthropic" }) }),
		);
		expect(plan.eligible).toBe(true);
		expect(plan.serverSide).toBe(true);
		expect(plan.steps.map((s) => s.kind)).toEqual(["server-side-fallback"]);
	});
});

describe("isTransientRedemptionError", () => {
	it("classifies 'redemption temporarily unavailable' as transient (retry in window)", async () => {
		const { isTransientRedemptionError } = await import("./fallback-credit");
		expect(isTransientRedemptionError("redemption temporarily unavailable")).toBe(true);
		expect(isTransientRedemptionError("Redemption Temporarily Unavailable: try later")).toBe(true);
		expect(isTransientRedemptionError("invalid fallback_credit_token")).toBe(false);
	});
});
