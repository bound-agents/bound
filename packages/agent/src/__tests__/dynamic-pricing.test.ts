import { beforeEach, describe, expect, it } from "bun:test";
import { calculateDynamicPrice, compileDynamicPricing } from "../dynamic-pricing";

const input = {
	modelId: "m",
	inputTokens: 100,
	outputTokens: 10,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	pricesPerM: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

describe("dynamic pricing registry", () => {
	beforeEach(async () => {
		await compileDynamicPricing([]);
	});

	it("publishes validated functions for synchronous hot-path evaluation", async () => {
		await compileDynamicPricing([
			{ id: "m", priceFunction: "function price(t) { return t.inputTokens / 1000; }" },
		]);
		expect(calculateDynamicPrice("m", input)).toEqual({ value: 0.1, error: null });
	});

	it("rejects syntax errors before publication", async () => {
		await expect(
			compileDynamicPricing([{ id: "bad", priceFunction: "function price( {" }]),
		).rejects.toThrow();
		expect(calculateDynamicPrice("bad", { ...input, modelId: "bad" })).toBeNull();
	});

	it("keeps the previous registry when a replacement fails validation", async () => {
		await compileDynamicPricing([{ id: "m", priceFunction: "function price() { return 7; }" }]);
		await expect(
			compileDynamicPricing([{ id: "m", priceFunction: "function price() { return -1; }" }]),
		).rejects.toThrow(/finite non-negative/);
		expect(calculateDynamicPrice("m", input)).toEqual({ value: 7, error: null });
	});

	it("returns the branch-specific runtime failure for logging", async () => {
		await compileDynamicPricing([
			{
				id: "m",
				priceFunction:
					"function price(t) { if (t.inputTokens > 10) throw new Error('branch'); return 0; }",
			},
		]);
		expect(calculateDynamicPrice("m", input)).toEqual({
			value: null,
			error: "branch",
		});
	});

	it("interrupts runaway functions during startup validation", async () => {
		await expect(
			compileDynamicPricing([
				{ id: "spin", priceFunction: "function price() { while (true) {} }" },
			]),
		).rejects.toThrow();
	});
});
