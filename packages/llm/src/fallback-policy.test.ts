import { describe, expect, it } from "bun:test";
import { type DriverFallbackSupport, resolveFallbackChain } from "./fallback-policy";

/**
 * Tests for the refusal-fallback policy resolver (slice 5, R-RT17 / R-MC11,
 * 2026-11-21-model-routing.md §7.3 step 1, 2026-11-21-model-catalog.md §7.1).
 *
 * The resolver is a pure function over (policy, driver support, provider/cluster
 * candidate lists, capability filter). It decides, for a substitutable refusal,
 * what the ordered fallback chain is — it does NOT execute anything.
 */

const ANTHROPIC: DriverFallbackSupport = {
	server_side_auto: true,
	publishes_allowed_targets: true,
	supports_fallback_credit: true,
};
const BEDROCK: DriverFallbackSupport = {
	server_side_auto: false,
	publishes_allowed_targets: false,
	supports_fallback_credit: true,
};
const OPENAI_COMPAT: DriverFallbackSupport = {
	server_side_auto: false,
	publishes_allowed_targets: false,
	supports_fallback_credit: false,
};

describe("resolveFallbackChain", () => {
	it("mode 'never' surfaces the refusal: no targets, server-side off", () => {
		const r = resolveFallbackChain({
			policy: { mode: "never" },
			driver: ANTHROPIC,
			refusedModel: "opus",
			allowedFallbackModels: ["sonnet"],
			defaultFallbackModels: ["haiku"],
			meetsRequirements: () => true,
		});
		expect(r.serverSideAuto).toBe(false);
		expect(r.targets).toEqual([]);
	});

	it("mode 'custom' walks the operator list in order, excluding the refused model", () => {
		const r = resolveFallbackChain({
			policy: { mode: "custom", models: ["opus", "sonnet", "haiku"] },
			driver: BEDROCK,
			refusedModel: "opus",
			allowedFallbackModels: [],
			defaultFallbackModels: ["should-be-ignored"],
			meetsRequirements: () => true,
		});
		expect(r.serverSideAuto).toBe(false);
		expect(r.targets).toEqual(["sonnet", "haiku"]);
	});

	it("mode 'custom' drops models that fail the turn's capability requirements", () => {
		const r = resolveFallbackChain({
			policy: { mode: "custom", models: ["sonnet", "vision-less", "haiku"] },
			driver: BEDROCK,
			refusedModel: "opus",
			allowedFallbackModels: [],
			defaultFallbackModels: [],
			meetsRequirements: (m) => m !== "vision-less",
		});
		expect(r.targets).toEqual(["sonnet", "haiku"]);
	});

	it("mode 'auto' on a server_side_auto driver delegates server-side, no walked targets", () => {
		const r = resolveFallbackChain({
			policy: { mode: "auto" },
			driver: ANTHROPIC,
			refusedModel: "opus",
			allowedFallbackModels: ["sonnet"],
			defaultFallbackModels: ["haiku"],
			meetsRequirements: () => true,
		});
		expect(r.serverSideAuto).toBe(true);
		expect(r.targets).toEqual([]);
	});

	it("mode 'auto' on a non-server_side driver that publishes targets walks allowed then default", () => {
		// A driver with server_side_auto:false but publishes_allowed_targets:true
		// exercises the allowed-then-default walk (the real Bedrock table has
		// publishes_allowed_targets:false, covered separately below).
		const PUBLISHES: DriverFallbackSupport = {
			server_side_auto: false,
			publishes_allowed_targets: true,
			supports_fallback_credit: false,
		};
		const r = resolveFallbackChain({
			policy: { mode: "auto" },
			driver: PUBLISHES,
			refusedModel: "opus",
			allowedFallbackModels: ["sonnet"],
			defaultFallbackModels: ["haiku", "fast"],
			meetsRequirements: () => true,
		});
		expect(r.serverSideAuto).toBe(false);
		expect(r.targets).toEqual(["sonnet", "haiku", "fast"]);
	});

	it("mode 'auto' on Bedrock (publishes_allowed_targets:false) walks default only", () => {
		const r = resolveFallbackChain({
			policy: { mode: "auto" },
			driver: BEDROCK,
			refusedModel: "opus",
			allowedFallbackModels: ["should-be-ignored"],
			defaultFallbackModels: ["haiku", "fast"],
			meetsRequirements: () => true,
		});
		expect(r.serverSideAuto).toBe(false);
		expect(r.targets).toEqual(["haiku", "fast"]);
	});

	it("mode 'auto' ignores allowed targets when the driver does not publish them", () => {
		const r = resolveFallbackChain({
			policy: { mode: "auto" },
			// supports credit but publishes_allowed_targets false, like Bedrock
			driver: BEDROCK,
			refusedModel: "opus",
			// A caller that erroneously passed allowed targets must be ignored
			// because the driver cannot publish them.
			allowedFallbackModels: ["leaked-allowed"],
			defaultFallbackModels: ["haiku"],
			meetsRequirements: () => true,
			ignoreAllowedWhenUnpublished: true,
		});
		expect(r.targets).toEqual(["haiku"]);
	});

	it("auto chain de-duplicates and drops the refused model and capability failures", () => {
		const r = resolveFallbackChain({
			policy: { mode: "auto" },
			driver: OPENAI_COMPAT,
			refusedModel: "opus",
			allowedFallbackModels: [],
			defaultFallbackModels: ["sonnet", "opus", "sonnet", "blind", "haiku"],
			meetsRequirements: (m) => m !== "blind",
		});
		expect(r.serverSideAuto).toBe(false);
		expect(r.targets).toEqual(["sonnet", "haiku"]);
	});

	it("absent fallback_policy row is treated as auto by the caller (resolver takes {mode:'auto'})", () => {
		// Documented contract: callers map a missing model_routing_rules row to
		// { mode: "auto" } before calling. Verify auto behaves as the default.
		const r = resolveFallbackChain({
			policy: { mode: "auto" },
			driver: OPENAI_COMPAT,
			refusedModel: "opus",
			allowedFallbackModels: [],
			defaultFallbackModels: ["haiku"],
			meetsRequirements: () => true,
		});
		expect(r.targets).toEqual(["haiku"]);
	});
});
