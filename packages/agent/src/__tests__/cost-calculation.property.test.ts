/**
 * Property tests for `calculateTurnCost`.
 *
 * Cost calculation has been wrong multiple times historically: Bedrock
 * cache_read inflation (CONTRIBUTING.md "Critical invariants" cache
 * accounting), Anthropic input_tokens already-summed accounting,
 * MoonshotAI returning estimated tokens. Each silently miscounted by
 * 2-600x at various points.
 *
 * Properties:
 *
 *   C1 Linearity in input tokens — doubling `inputTokens` doubles
 *      the corresponding component of the cost. Same for output,
 *      cache_read, cache_write.
 *
 *   C2 Zero on unknown model — if the modelId isn't in the
 *      backends list, cost is exactly 0 (the historical "delegated
 *      from hub-only spoke" behavior).
 *
 *   C3 Zero on zero usage — empty usage on a known model produces
 *      cost 0.
 *
 *   C4 Hand-computed agreement — for any usage and pricing, the
 *      result equals `(input * priceIn + output * priceOut +
 *      cacheRead * priceCacheRead + cacheWrite * priceCacheWrite)
 *      / 1_000_000` within ε.
 *
 *   C5 Null cache fields treated as 0 — usage with `cacheReadTokens:
 *      null` produces the same cost as `cacheReadTokens: 0`.
 *
 *   C6 Missing prices treated as 0 — pricing config without a given
 *      `price_per_m_*` field contributes 0 to that component.
 *
 *   C7 Determinism — same inputs return same output.
 *
 *   C8 Non-negative for non-negative inputs — when all token counts
 *      and prices are non-negative, the returned cost is non-negative.
 */

import { describe, it } from "bun:test";
import fc from "fast-check";
import { calculateTurnCost } from "../agent-loop-utils";

const tokens = fc.integer({ min: 0, max: 1_000_000 });
const price = fc.double({ min: 0, max: 100, noNaN: true });

const usageArb = fc.record({
	inputTokens: tokens,
	outputTokens: tokens,
	cacheReadTokens: fc.option(tokens, { nil: null }),
	cacheWriteTokens: fc.option(tokens, { nil: null }),
});

const backendArb = fc.record({
	id: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-z0-9-]+$/.test(s)),
	price_per_m_input: price,
	price_per_m_output: price,
	price_per_m_cache_read: price,
	price_per_m_cache_write: price,
});

const ε = 1e-9;

function handComputed(
	usage: ReturnType<(typeof usageArb)["generate"]>["value"],
	cfg: ReturnType<(typeof backendArb)["generate"]>["value"],
): number {
	return (
		(usage.inputTokens * cfg.price_per_m_input +
			usage.outputTokens * cfg.price_per_m_output +
			(usage.cacheReadTokens ?? 0) * cfg.price_per_m_cache_read +
			(usage.cacheWriteTokens ?? 0) * cfg.price_per_m_cache_write) /
		1_000_000
	);
}

describe("calculateTurnCost — property tests", () => {
	it("C1: doubling inputTokens scales the input cost component linearly", () => {
		fc.assert(
			fc.property(usageArb, backendArb, (usage, cfg) => {
				const baseCost = calculateTurnCost(cfg.id, usage, [cfg]);
				const doubled = { ...usage, inputTokens: usage.inputTokens * 2 };
				const doubledCost = calculateTurnCost(cfg.id, doubled, [cfg]);
				const inputComponent = (usage.inputTokens * cfg.price_per_m_input) / 1_000_000;
				return Math.abs(doubledCost - (baseCost + inputComponent)) < ε;
			}),
			{ numRuns: 100 },
		);
	});

	it("C2: unknown model => cost is exactly 0", () => {
		fc.assert(
			fc.property(usageArb, backendArb, (usage, cfg) => {
				const cost = calculateTurnCost("nonexistent-model", usage, [cfg]);
				return cost === 0;
			}),
			{ numRuns: 50 },
		);
	});

	it("C3: zero usage on known model => cost 0", () => {
		fc.assert(
			fc.property(backendArb, (cfg) => {
				const cost = calculateTurnCost(
					cfg.id,
					{
						inputTokens: 0,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
					[cfg],
				);
				return cost === 0;
			}),
			{ numRuns: 50 },
		);
	});

	it("C4: hand-computed agreement within ε", () => {
		fc.assert(
			fc.property(usageArb, backendArb, (usage, cfg) => {
				const cost = calculateTurnCost(cfg.id, usage, [cfg]);
				const expected = handComputed(usage, cfg);
				return Math.abs(cost - expected) < ε;
			}),
			{ numRuns: 200 },
		);
	});

	it("C5: null cache fields treated as 0", () => {
		fc.assert(
			fc.property(usageArb, backendArb, (usage, cfg) => {
				const withNulls = { ...usage, cacheReadTokens: null, cacheWriteTokens: null };
				const withZeros = { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 };
				const a = calculateTurnCost(cfg.id, withNulls, [cfg]);
				const b = calculateTurnCost(cfg.id, withZeros, [cfg]);
				return Math.abs(a - b) < ε;
			}),
			{ numRuns: 100 },
		);
	});

	it("C6: missing prices treated as 0 (no NaN, no exception)", () => {
		fc.assert(
			fc.property(usageArb, fc.string({ minLength: 1, maxLength: 20 }), (usage, modelId) => {
				const cost = calculateTurnCost(modelId, usage, [{ id: modelId }]);
				return cost === 0 && Number.isFinite(cost);
			}),
			{ numRuns: 100 },
		);
	});

	it("C7: determinism", () => {
		fc.assert(
			fc.property(usageArb, backendArb, (usage, cfg) => {
				const a = calculateTurnCost(cfg.id, usage, [cfg]);
				const b = calculateTurnCost(cfg.id, usage, [cfg]);
				return a === b;
			}),
			{ numRuns: 100 },
		);
	});

	it("C8: non-negative for non-negative inputs", () => {
		fc.assert(
			fc.property(usageArb, backendArb, (usage, cfg) => {
				const cost = calculateTurnCost(cfg.id, usage, [cfg]);
				return cost >= 0;
			}),
			{ numRuns: 100 },
		);
	});

	it("C-regression: full-cache-read turn produces non-zero cost", () => {
		// Pre-fix: cost_usd only counted inputTokens against price_per_m_input,
		// missing cache_read entirely. A turn with 230k cache_read landed as
		// $0.00 instead of $0.115 — 615x underreporting.
		const cost = calculateTurnCost(
			"opus",
			{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 230_000, cacheWriteTokens: 0 },
			[
				{
					id: "opus",
					price_per_m_input: 5,
					price_per_m_output: 25,
					price_per_m_cache_read: 0.5,
					price_per_m_cache_write: 6.25,
				},
			],
		);
		const expected = (230_000 * 0.5) / 1_000_000;
		if (Math.abs(cost - expected) > ε) {
			throw new Error(`cache-read regression: ${cost} vs ${expected}`);
		}
	});
});
