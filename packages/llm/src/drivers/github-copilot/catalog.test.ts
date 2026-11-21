import { describe, expect, it } from "bun:test";
import {
	CATALOG_TTL_MS,
	CopilotCatalog,
	computeCopilotCost,
	computeCopilotCostBreakdown,
	resolveRoute,
	routeFromEndpoints,
	routeFromModelName,
} from "./catalog";

describe("routeFromEndpoints", () => {
	it("prefers messages, then responses, then chat", () => {
		expect(routeFromEndpoints(["/v1/messages", "/chat/completions"])).toBe("messages");
		expect(routeFromEndpoints(["/responses", "/chat/completions"])).toBe("responses");
		expect(routeFromEndpoints(["/chat/completions"])).toBe("chat");
		// ws:/responses alone does not satisfy the HTTP responses route.
		expect(routeFromEndpoints(["ws:/responses"])).toBeNull();
	});

	it("returns null for absent/empty endpoints (legacy models fall through)", () => {
		expect(routeFromEndpoints(undefined)).toBeNull();
		expect(routeFromEndpoints([])).toBeNull();
	});
});

describe("routeFromModelName", () => {
	it("routes claude-* to messages", () => {
		expect(routeFromModelName("claude-sonnet-4.5")).toBe("messages");
		expect(routeFromModelName("claude-3.7-sonnet")).toBe("messages");
	});

	it("routes gpt-N (N>=5), grok-*, mai-code-* to responses", () => {
		expect(routeFromModelName("gpt-5.6")).toBe("responses");
		expect(routeFromModelName("gpt-6")).toBe("responses");
		expect(routeFromModelName("gpt-6.2")).toBe("responses");
		expect(routeFromModelName("gpt-5.4-nano")).toBe("responses");
		expect(routeFromModelName("grok-4.7")).toBe("responses");
		expect(routeFromModelName("mai-code-2-flash")).toBe("responses");
	});

	it("keeps gpt-5-mini on chat", () => {
		expect(routeFromModelName("gpt-5-mini")).toBe("chat");
	});

	it("routes everything else (gpt-4.x, gemini, unknown) to chat", () => {
		expect(routeFromModelName("gpt-4.1")).toBe("chat");
		expect(routeFromModelName("gpt-4o")).toBe("chat");
		expect(routeFromModelName("gemini-3.8-flash")).toBe("chat");
		expect(routeFromModelName("some-unknown-model")).toBe("chat");
	});
});

describe("resolveRoute", () => {
	it("uses the catalog entry's endpoints when present", () => {
		expect(
			resolveRoute("gpt-5.6", { id: "gpt-5.6", supportedEndpoints: ["/chat/completions"] }),
		).toBe("chat");
	});

	it("falls back to the name heuristic when the entry lacks endpoints", () => {
		expect(resolveRoute("gpt-5.6", { id: "gpt-5.6" })).toBe("responses");
		expect(resolveRoute("claude-sonnet-4.5", null)).toBe("messages");
	});
});

/** A fetch stub returning a canned `{api}/models` response. */
function modelsFetch(
	data: unknown[],
	opts: { status?: number; onCall?: () => void } = {},
): typeof fetch {
	return (async () => {
		opts.onCall?.();
		return new Response(JSON.stringify({ data }), {
			status: opts.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

describe("CopilotCatalog", () => {
	const apiEndpoint = "https://api.individual.githubcopilot.com";

	it("fetches, parses, and routes from supported_endpoints and billing", async () => {
		const catalog = new CopilotCatalog({
			apiEndpoint,
			fetch: modelsFetch([
				{
					id: "claude-sonnet-4.5",
					supported_endpoints: ["/v1/messages", "/chat/completions"],
					capabilities: {
						limits: { max_output_tokens: 8192, max_context_window_tokens: 200000 },
						supports: { tool_calls: true, vision: true },
					},
					billing: { token_prices: { input: 3, output: 15, batch_size: 0 } },
				},
				{
					id: "gpt-4.1",
					supported_endpoints: ["/chat/completions"],
					billing: { token_prices: { input: 0, output: 0, batch_size: 0 } },
				},
			]),
		});
		const claude = await catalog.getEntry("claude-sonnet-4.5");
		expect(claude?.supportedEndpoints).toEqual(["/v1/messages", "/chat/completions"]);
		expect(claude?.zeroPriced).toBe(false);
		expect(resolveRoute("claude-sonnet-4.5", claude)).toBe("messages");

		const gpt41 = await catalog.getEntry("gpt-4.1");
		expect(gpt41?.zeroPriced).toBe(true);
	});

	it("caches within the TTL and refetches after it expires", async () => {
		let calls = 0;
		let clock = 0;
		const catalog = new CopilotCatalog({
			apiEndpoint,
			now: () => clock,
			fetch: modelsFetch([{ id: "gpt-5.6", supported_endpoints: ["/responses"] }], {
				onCall: () => {
					calls++;
				},
			}),
		});
		await catalog.load();
		await catalog.load();
		expect(calls).toBe(1); // second load served from cache
		clock += CATALOG_TTL_MS + 1;
		await catalog.load();
		expect(calls).toBe(2); // TTL expired → refetch
	});

	it("degrades to an empty catalog (name heuristic) on a fetch error without throwing", async () => {
		const catalog = new CopilotCatalog({
			apiEndpoint,
			fetch: (async () => {
				throw new Error("network down");
			}) as typeof fetch,
		});
		const entry = await catalog.getEntry("claude-sonnet-4.5");
		expect(entry).toBeNull();
		// Routing still works via the name heuristic.
		expect(resolveRoute("claude-sonnet-4.5", entry)).toBe("messages");
	});

	it("degrades to an empty catalog on a non-OK response", async () => {
		const catalog = new CopilotCatalog({
			apiEndpoint,
			fetch: modelsFetch([], { status: 500 }),
		});
		expect(await catalog.getEntry("gpt-5.6")).toBeNull();
	});

	it("single-flights concurrent loads into one fetch", async () => {
		let calls = 0;
		const catalog = new CopilotCatalog({
			apiEndpoint,
			fetch: (async () => {
				calls++;
				await new Promise((r) => setTimeout(r, 10));
				return new Response(JSON.stringify({ data: [{ id: "gpt-5.6" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as typeof fetch,
		});
		await Promise.all([catalog.load(), catalog.load()]);
		expect(calls).toBe(1);
	});

	const fixedNow = Date.UTC(2026, 10, 21, 0, 0, 0);

	describe("CopilotCatalog pricing parse", () => {
		const apiEndpoint = "https://api.individual.githubcopilot.com";

		it("parses default + long_context rows, auto_discount and promo off billing", async () => {
			const catalog = new CopilotCatalog({
				apiEndpoint,
				fetch: modelsFetch([
					{
						id: "claude-haiku-5.5",
						supported_endpoints: ["/v1/messages"],
						billing: {
							token_prices: {
								batch_size: 1_000_000,
								default: {
									input_price: 10,
									output_price: 50,
									cache_read_price: 1,
									cache_write_price: 12.5,
									cache_write_1h_price: 20,
									max_prompt_tokens: 200_000,
								},
								long_context: {
									input_price: 20,
									output_price: 100,
									cache_read_price: 2,
									cache_write_price: 25,
								},
							},
							auto_discount: 0.1,
							promo: { discount_percent: 50, ends_at: "2026-12-01T00:00:00Z" },
						},
					},
				]),
			});
			const entry = await catalog.getEntry("claude-haiku-5.5");
			expect(entry?.pricing).toBeDefined();
			const p = entry?.pricing;
			expect(p?.batchSize).toBe(1_000_000);
			expect(p?.default.inputPrice).toBe(10);
			expect(p?.default.outputPrice).toBe(50);
			expect(p?.default.cacheReadPrice).toBe(1);
			expect(p?.default.cacheWritePrice).toBe(12.5);
			expect(p?.default.cacheWrite1hPrice).toBe(20);
			expect(p?.default.maxPromptTokens).toBe(200_000);
			expect(p?.longContext?.inputPrice).toBe(20);
			expect(p?.autoDiscount).toBe(0.1);
			expect(p?.promo?.discountPercent).toBe(50);
			expect(p?.promo?.endsAt).toBe("2026-12-01T00:00:00Z");
			// zeroPriced is driven by the structured prices, not the legacy flat map.
			expect(entry?.zeroPriced).toBe(false);
		});

		it("leaves pricing undefined when billing has no token_prices", async () => {
			const catalog = new CopilotCatalog({
				apiEndpoint,
				fetch: modelsFetch([{ id: "legacy", supported_endpoints: ["/chat/completions"] }]),
			});
			const entry = await catalog.getEntry("legacy");
			expect(entry?.pricing).toBeUndefined();
		});

		it("marks an all-zero structured catalog entry as zeroPriced", async () => {
			const catalog = new CopilotCatalog({
				apiEndpoint,
				fetch: modelsFetch([
					{
						id: "free-model",
						supported_endpoints: ["/chat/completions"],
						billing: {
							token_prices: {
								batch_size: 1_000_000,
								default: {
									input_price: 0,
									output_price: 0,
									cache_read_price: 0,
									cache_write_price: 0,
								},
							},
						},
					},
				]),
			});
			const entry = await catalog.getEntry("free-model");
			expect(entry?.zeroPriced).toBe(true);
		});
	});

	describe("computeCopilotCost", () => {
		// claude-haiku-5.5 live prices: 10/50/1/12.5/20 per the /M units
		// (USD = tokens * price / batch_size / 100).
		const haiku = {
			batchSize: 1_000_000,
			default: {
				inputPrice: 10,
				outputPrice: 50,
				cacheReadPrice: 1,
				cacheWritePrice: 12.5,
				cacheWrite1hPrice: 20,
				maxPromptTokens: 200_000,
			},
			longContext: {
				inputPrice: 20,
				outputPrice: 100,
				cacheReadPrice: 2,
				cacheWritePrice: 25,
			},
		};

		it("prices a plain turn off the default row (USD = tokens * price / batch / 100)", () => {
			// 1M input at input_price 10 → 10/100 = $0.10.
			const cost = computeCopilotCost({
				pricing: { batchSize: 1_000_000, default: haiku.default },
				usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
				nowMs: fixedNow,
			});
			expect(cost).toBeCloseTo(0.1, 10);
		});

		it("sums input+output+cache_read+cache_write at the default rates", () => {
			const cost = computeCopilotCost({
				pricing: { batchSize: 1_000_000, default: haiku.default },
				usage: {
					inputTokens: 1_000_000,
					outputTokens: 1_000_000,
					cacheReadTokens: 1_000_000,
					cacheWriteTokens: 1_000_000,
				},
				nowMs: fixedNow,
			});
			// (10 + 50 + 1 + 12.5) / 100 = 0.735
			expect(cost).toBeCloseTo(0.735, 10);
		});

		it("switches to long_context when input+cache_read+cache_write exceeds default.max_prompt_tokens", () => {
			const cost = computeCopilotCost({
				pricing: { batchSize: 1_000_000, default: haiku.default, longContext: haiku.longContext },
				usage: {
					inputTokens: 300_000,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
				nowMs: fixedNow,
			});
			// 300k > 200k max_prompt_tokens → long_context input 20: 300000*20/1e6/100
			expect(cost).toBeCloseTo((300_000 * 20) / 1_000_000 / 100, 12);
		});

		it("stays on default when the prompt fits even if long_context exists", () => {
			const cost = computeCopilotCost({
				pricing: { batchSize: 1_000_000, default: haiku.default, longContext: haiku.longContext },
				usage: {
					inputTokens: 100_000,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
				nowMs: fixedNow,
			});
			expect(cost).toBeCloseTo((100_000 * 10) / 1_000_000 / 100, 12);
		});

		it("prices the 1h cache-write subset at cache_write_1h_price and the rest at cache_write_price", () => {
			const cost = computeCopilotCost({
				pricing: { batchSize: 1_000_000, default: haiku.default },
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 1_000_000,
					cacheWrite1hTokens: 400_000,
				},
				nowMs: fixedNow,
			});
			// 600k at 12.5 + 400k at 20, over 1e6 / 100
			const expected = (600_000 * 12.5 + 400_000 * 20) / 1_000_000 / 100;
			expect(cost).toBeCloseTo(expected, 12);
		});

		it("falls back to cache_write_price for the 1h subset when cache_write_1h_price is absent", () => {
			const cost = computeCopilotCost({
				pricing: {
					batchSize: 1_000_000,
					default: { ...haiku.default, cacheWrite1hPrice: undefined },
				},
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 1_000_000,
					cacheWrite1hTokens: 400_000,
				},
				nowMs: fixedNow,
			});
			expect(cost).toBeCloseTo((1_000_000 * 12.5) / 1_000_000 / 100, 12);
		});

		it("applies auto_discount only when the turn routed through model: auto", () => {
			const base = {
				pricing: { batchSize: 1_000_000, default: haiku.default, autoDiscount: 0.1 },
				usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
				nowMs: fixedNow,
			};
			const viaAuto = computeCopilotCost({ ...base, routedThroughAuto: true });
			const direct = computeCopilotCost({ ...base, routedThroughAuto: false });
			// $0.10 base; auto path shaves 10%.
			expect(viaAuto).toBeCloseTo(0.1 * 0.9, 10);
			expect(direct).toBeCloseTo(0.1, 10);
		});

		it("applies promo.discount_percent only while now < promo.ends_at", () => {
			const base = {
				pricing: {
					batchSize: 1_000_000,
					default: haiku.default,
					promo: { discountPercent: 50, endsAt: "2026-12-01T00:00:00Z" },
				},
				usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			};
			const active = computeCopilotCost({ ...base, nowMs: Date.UTC(2026, 10, 1) });
			const expired = computeCopilotCost({ ...base, nowMs: Date.UTC(2026, 11, 2) });
			expect(active).toBeCloseTo(0.1 * 0.5, 10);
			expect(expired).toBeCloseTo(0.1, 10);
		});

		it("stacks auto_discount and an active promo multiplicatively", () => {
			const cost = computeCopilotCost({
				pricing: {
					batchSize: 1_000_000,
					default: haiku.default,
					autoDiscount: 0.1,
					promo: { discountPercent: 50, endsAt: "2026-12-01T00:00:00Z" },
				},
				usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
				nowMs: Date.UTC(2026, 10, 1),
				routedThroughAuto: true,
			});
			// 0.10 * 0.9 * 0.5
			expect(cost).toBeCloseTo(0.1 * 0.9 * 0.5, 10);
		});
	});

	describe("computeCopilotCostBreakdown", () => {
		const row = {
			inputPrice: 10,
			outputPrice: 50,
			cacheReadPrice: 1,
			cacheWritePrice: 12.5,
			cacheWrite1hPrice: 20,
			maxPromptTokens: 200_000,
		};
		const usage = {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 1_000_000,
			cacheWrite1hTokens: 400_000,
		};

		it("prices each component at its own rate, folding 1h and 5m writes into cacheWrite", () => {
			const parts = computeCopilotCostBreakdown({
				pricing: { batchSize: 1_000_000, default: row },
				usage,
				nowMs: fixedNow,
			});
			expect(parts.input).toBeCloseTo(0.1, 12);
			expect(parts.output).toBeCloseTo(0.5, 12);
			expect(parts.cacheRead).toBeCloseTo(0.01, 12);
			// 600k at 12.5 + 400k at 20 = 75 + 80 = 155 per-M units / 100.
			expect(parts.cacheWrite).toBeCloseTo((600_000 * 12.5 + 400_000 * 20) / 1e6 / 100, 12);
		});

		it("scales every component by the stacked discounts so the parts sum to the total", () => {
			const input = {
				pricing: {
					batchSize: 1_000_000,
					default: row,
					longContext: { inputPrice: 20, outputPrice: 100, cacheReadPrice: 2, cacheWritePrice: 25 },
					autoDiscount: 0.1,
					promo: { discountPercent: 50, endsAt: "2026-12-01T00:00:00Z" },
				},
				usage,
				nowMs: Date.UTC(2026, 10, 1),
				routedThroughAuto: true,
			};
			const parts = computeCopilotCostBreakdown(input);
			const total = computeCopilotCost(input);
			expect(parts.input + parts.output + parts.cacheRead + parts.cacheWrite).toBeCloseTo(
				total,
				14,
			);
			// 4M prompt tokens > 200k, so the long_context row applies: input 20 → $0.20 × 0.45.
			expect(parts.input).toBeCloseTo(0.2 * 0.9 * 0.5, 12);
			expect(parts.output).toBeCloseTo(1.0 * 0.9 * 0.5, 12);
		});
	});
});
