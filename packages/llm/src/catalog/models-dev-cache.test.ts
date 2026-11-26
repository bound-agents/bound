/**
 * `models.dev` fallback-registry cache (slice 6, R-MC5/R-MC6,
 * 2026-11-21-model-catalog.md §5). Pure snapshot indexing + a cache manager with
 * disk persistence, conditional ETag refresh, offline resilience, and a disable
 * flag. The registry is a GAP-FILLING metadata fallback only; it never grants
 * availability (that is provider discovery's job).
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ModelsDevCache,
	indexModelsDevSnapshot,
	lookupModelsDev,
	lookupModelsDevScoped,
} from "./models-dev-cache";

function tmpCachePath(): { dir: string; path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "models-dev-"));
	return {
		dir,
		path: join(dir, "models-dev.json"),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** A minimal but shape-accurate slice of the models.dev api.json payload. */
const SAMPLE_PAYLOAD = {
	anthropic: {
		models: {
			"claude-opus-4": {
				limit: { context: 200000, output: 32000 },
				cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
				modalities: { input: ["text", "image"] },
				reasoning: true,
			},
			malformed: null,
		},
	},
	openai: {
		models: {
			"gpt-6": {
				limit: { context: 400000 },
				cost: { input: 2 },
			},
		},
	},
};

function jsonResponse(body: unknown, init?: { status?: number; etag?: string }): Response {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (init?.etag) headers.etag = init.etag;
	return new Response(init?.status === 304 ? "" : JSON.stringify(body), {
		status: init?.status ?? 200,
		headers,
	});
}

describe("indexModelsDevSnapshot / lookupModelsDev", () => {
	it("indexes context, output, pricing, and modalities under the canonical key", () => {
		const index = indexModelsDevSnapshot(SAMPLE_PAYLOAD);
		const layer = lookupModelsDev(index, "anthropic", "claude-opus-4");
		expect(layer?.capabilities?.max_context).toBe(200000);
		expect(layer?.max_output_tokens).toBe(32000);
		expect(layer?.pricing?.input_per_m).toBe(15);
		expect(layer?.pricing?.output_per_m).toBe(75);
		expect(layer?.pricing?.cache_read_per_m).toBe(1.5);
		expect(layer?.capabilities?.vision).toBe(true);
		expect(layer?.capabilities?.extended_thinking).toBe(true);
	});

	it("parses reasoning_options into structured reasoning metadata (effort + toggle)", () => {
		// Real models.dev shape: `reasoning: true` plus a `reasoning_options`
		// array that may carry a `toggle` entry and/or an `effort` entry with a
		// `values` list. Both are published facts, not a model-ID lookup.
		const index = indexModelsDevSnapshot({
			anthropic: {
				models: {
					"claude-reasoner": {
						limit: { context: 200000 },
						reasoning: true,
						reasoning_options: [
							{ type: "toggle" },
							{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
						],
					},
				},
			},
		});
		const layer = lookupModelsDev(index, "anthropic", "claude-reasoner");
		expect(layer?.capabilities?.reasoning).toEqual({
			supported: true,
			toggle: true,
			effort_values: ["low", "medium", "high", "xhigh", "max"],
		});
		// `extended_thinking` stays set for backward-compat consumers.
		expect(layer?.capabilities?.extended_thinking).toBe(true);
	});

	it("parses an effort-only reasoning_options (no toggle)", () => {
		const index = indexModelsDevSnapshot({
			openai: {
				models: {
					"gpt-reasoner": {
						limit: { context: 400000 },
						reasoning: true,
						reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high"] }],
					},
				},
			},
		});
		const layer = lookupModelsDev(index, "openai", "gpt-reasoner");
		expect(layer?.capabilities?.reasoning).toEqual({
			supported: true,
			effort_values: ["none", "low", "medium", "high"],
		});
	});

	it("records reasoning.supported=false when the registry says reasoning:false", () => {
		const index = indexModelsDevSnapshot({
			"amazon-bedrock": {
				models: {
					"amazon.nova-lite": { limit: { context: 300000 }, reasoning: false },
				},
			},
		});
		const layer = lookupModelsDev(index, "amazon-bedrock", "amazon.nova-lite");
		expect(layer?.capabilities?.reasoning).toEqual({ supported: false });
		expect(layer?.capabilities?.extended_thinking).toBe(false);
	});

	it("omits reasoning metadata entirely when the entry says nothing about it", () => {
		const index = indexModelsDevSnapshot(SAMPLE_PAYLOAD);
		const layer = lookupModelsDev(index, "openai", "gpt-6");
		expect(layer?.capabilities?.reasoning).toBeUndefined();
	});

	it("normalizes a region/vendor-prefixed query id to the same entry", () => {
		const index = indexModelsDevSnapshot(SAMPLE_PAYLOAD);
		// A Bedrock-style id resolves to the same canonical entry as the direct id.
		const layer = lookupModelsDev(index, "bedrock", "us.anthropic.claude-opus-4-v1:0");
		expect(layer?.capabilities?.max_context).toBe(200000);
	});

	it("skips a malformed model entry rather than throwing", () => {
		const index = indexModelsDevSnapshot(SAMPLE_PAYLOAD);
		// `malformed: null` under anthropic must not appear and must not have thrown.
		expect(lookupModelsDev(index, "anthropic", "malformed")).toBeUndefined();
		// The well-formed sibling still indexed.
		expect(lookupModelsDev(index, "anthropic", "claude-opus-4")).toBeDefined();
	});

	it("tolerates a wholly malformed payload (returns an empty index, no throw)", () => {
		expect(indexModelsDevSnapshot(null).size).toBe(0);
		expect(indexModelsDevSnapshot("nope").size).toBe(0);
		expect(indexModelsDevSnapshot({ anthropic: 42 }).size).toBe(0);
	});

	it("honours limit.input: max_context = min(context, input + output) (requirement 4)", () => {
		// github-copilot grok-4.7 real shape: {context: 500000, input: 372000, output: 128000}.
		// The real prompt budget is input, so max_context must land at input+output=500000
		// (<= context here) so the truncation target (max_context - max_output) == input.
		const index = indexModelsDevSnapshot({
			"github-copilot": {
				models: {
					"grok-4.7": { limit: { context: 500000, input: 372000, output: 128000 } },
				},
			},
		});
		const layer = lookupModelsDev(index, "github-copilot", "grok-4.7");
		expect(layer?.capabilities?.max_context).toBe(500000);
		expect(layer?.max_output_tokens).toBe(128000);
	});

	it("caps max_context at limit.context when input + output exceeds it (requirement 4)", () => {
		const index = indexModelsDevSnapshot({
			anthropic: {
				models: {
					"claude-x": { limit: { context: 200000, input: 190000, output: 64000 } },
				},
			},
		});
		const layer = lookupModelsDev(index, "anthropic", "claude-x");
		// input+output = 254000 > context 200000 → capped at 200000.
		expect(layer?.capabilities?.max_context).toBe(200000);
	});

	it("leaves max_context at limit.context when limit.input is absent (unchanged behavior)", () => {
		const index = indexModelsDevSnapshot(SAMPLE_PAYLOAD);
		const layer = lookupModelsDev(index, "anthropic", "claude-opus-4");
		expect(layer?.capabilities?.max_context).toBe(200000);
		expect(layer?.max_output_tokens).toBe(32000);
	});

	it("parses cost.tiers into context-tiered pricing (requirement 2)", () => {
		// Real amazon-bedrock shape: a base `cost` plus a `tiers` array, each tier
		// carrying its own four prices and `tier: {type: "context", size: N}`.
		const index = indexModelsDevSnapshot({
			"amazon-bedrock": {
				models: {
					"global.anthropic.claude-haiku-5-5": {
						limit: { context: 200000, output: 32000 },
						cost: {
							input: 0.1,
							output: 0.5,
							cache_read: 0.01,
							cache_write: 0.125,
							tiers: [
								{
									input: 0.5,
									output: 2.5,
									cache_read: 0.05,
									cache_write: 0.625,
									tier: { type: "context", size: 100000 },
								},
							],
						},
					},
				},
			},
		});
		const layer = lookupModelsDev(index, "amazon-bedrock", "global.anthropic.claude-haiku-5-5");
		// Base prices stay the top-level per-M fields.
		expect(layer?.pricing?.input_per_m).toBe(0.1);
		expect(layer?.pricing?.output_per_m).toBe(0.5);
		expect(layer?.pricing?.cache_read_per_m).toBe(0.01);
		expect(layer?.pricing?.cache_write_5m_per_m).toBe(0.125);
		// The context tier is parsed with its threshold and its own four prices.
		expect(layer?.pricing?.tiers).toEqual([
			{
				threshold: 100000,
				input_per_m: 0.5,
				output_per_m: 2.5,
				cache_read_per_m: 0.05,
				cache_write_5m_per_m: 0.625,
			},
		]);
	});

	it("ignores context_over_200k, which the data proves is a duplicate of the single context tier (requirement 2)", () => {
		// Across every amazon-bedrock entry in the snapshot that carries both, the
		// first `tiers` entry is byte-identical to `context_over_200k` (0 of 785
		// mismatches) and `context_over_200k` never appears without `tiers`. `tiers`
		// is the general, authoritative representation; `context_over_200k` is a
		// legacy duplicate of the single context tier and is dropped.
		const index = indexModelsDevSnapshot({
			"amazon-bedrock": {
				models: {
					"global.openai.gpt-6-luna": {
						limit: { context: 400000, output: 128000 },
						cost: {
							input: 0.1,
							output: 0.375,
							tiers: [
								{
									input: 0.2,
									output: 0.75,
									cache_read: 0.02,
									cache_write: 0.25,
									tier: { type: "context", size: 272000 },
								},
							],
							context_over_200k: { input: 0.2, output: 0.75, cache_read: 0.02, cache_write: 0.25 },
						},
					},
				},
			},
		});
		const layer = lookupModelsDev(index, "amazon-bedrock", "global.openai.gpt-6-luna");
		// Exactly one tier (from `tiers`), size 272000 — not a second tier from
		// context_over_200k.
		expect(layer?.pricing?.tiers).toHaveLength(1);
		expect(layer?.pricing?.tiers?.[0].threshold).toBe(272000);
	});

	it("sorts parsed context tiers ascending by threshold", () => {
		const index = indexModelsDevSnapshot({
			anthropic: {
				models: {
					"multi-tier": {
						limit: { context: 1000000 },
						cost: {
							input: 1,
							output: 2,
							tiers: [
								{ input: 4, output: 8, tier: { type: "context", size: 500000 } },
								{ input: 2, output: 4, tier: { type: "context", size: 200000 } },
							],
						},
					},
				},
			},
		});
		const layer = lookupModelsDev(index, "anthropic", "multi-tier");
		expect(layer?.pricing?.tiers?.map((t) => t.threshold)).toEqual([200000, 500000]);
	});
});

describe("lookupModelsDevScoped — provider-scoped lookup (requirement 3)", () => {
	// A canonical key that collides across providers: a non-copilot provider
	// writes grok-4.7 first (cross-provider index is first-writer-wins), so an
	// unscoped lookup for a github-copilot backend returns the WRONG provider's
	// limits. The provider-scoped lookup must return github-copilot's own entry.
	const COLLISION_PAYLOAD = {
		xai: {
			models: {
				"grok-4.7": { limit: { context: 500000, output: 500000 } },
			},
		},
		"github-copilot": {
			models: {
				"grok-4.7": { limit: { context: 500000, input: 372000, output: 128000 } },
			},
		},
	};

	it("prefers the backend's own provider namespace over a cross-provider collision", () => {
		const index = indexModelsDevSnapshot(COLLISION_PAYLOAD);
		// Cross-provider index resolved to xai (first writer): ctx 500000, out 500000.
		expect(lookupModelsDev(index, "github-copilot", "grok-4.7")?.max_output_tokens).toBe(500000);
		// Provider-scoped lookup returns github-copilot's own entry.
		const scoped = lookupModelsDevScoped(index, "github-copilot", "grok-4.7");
		expect(scoped?.capabilities?.max_context).toBe(500000);
		expect(scoped?.max_output_tokens).toBe(128000);
	});

	it("maps bedrock and bedrock-mantle to amazon-bedrock for scoped lookup", () => {
		const index = indexModelsDevSnapshot({
			"amazon-bedrock": {
				models: {
					"us.anthropic.claude-opus-4-v1:0": { limit: { context: 200000, output: 64000 } },
				},
			},
		});
		const a = lookupModelsDevScoped(index, "bedrock", "us.anthropic.claude-opus-4-v1:0");
		expect(a?.capabilities?.max_context).toBe(200000);
		const b = lookupModelsDevScoped(index, "bedrock-mantle", "us.anthropic.claude-opus-4-v1:0");
		expect(b?.capabilities?.max_context).toBe(200000);
	});

	it("falls back to the cross-provider canonical index when no namespace is mapped", () => {
		const index = indexModelsDevSnapshot(SAMPLE_PAYLOAD);
		// openai-compatible has no models.dev namespace mapping, so scoped falls
		// through to the canonical cross-provider entry.
		const layer = lookupModelsDevScoped(index, "openai-compatible", "claude-opus-4");
		expect(layer?.capabilities?.max_context).toBe(200000);
	});

	it("returns undefined when neither scoped nor canonical lookup matches", () => {
		const index = indexModelsDevSnapshot(SAMPLE_PAYLOAD);
		expect(lookupModelsDevScoped(index, "github-copilot", "nonexistent-model")).toBeUndefined();
	});
});

describe("lookupModelsDevScoped — exact (namespace, raw model id) resolution (requirement 1)", () => {
	// Bedrock prices CRIS inference profiles differently: a `global.` profile is
	// billed at list price, while an in-region (bare vendor-prefixed) profile is
	// billed list + 10%. normalizeModelKey strips the region prefix, so
	// `global.anthropic.claude-haiku-5-5` and `anthropic.claude-haiku-5-5`
	// collapse onto ONE canonical key and first-writer-wins would hand a backend
	// whichever price happened to index first. The exact index keyed by the raw
	// model id keeps each profile's own row so a backend prices the id it calls.
	const BEDROCK_CRIS_PAYLOAD = {
		"amazon-bedrock": {
			models: {
				// In-region (bare) profile, billed list + 10%. Indexed FIRST, so it wins
				// the canonical slot; a region-stripping lookup would resolve global to it.
				"anthropic.claude-haiku-5-5": {
					limit: { context: 200000, output: 32000 },
					cost: { input: 0.11, output: 0.55, cache_read: 0.011, cache_write: 0.1375 },
				},
				// Global profile, billed list price. Shares the canonical key with the
				// in-region row above; only the exact index distinguishes it.
				"global.anthropic.claude-haiku-5-5": {
					limit: { context: 200000, output: 32000 },
					cost: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
				},
				// A third vendor/family, with only a global and a us-region profile, to
				// prove exact resolution is not special-cased to one model id.
				"global.openai.fable-5-2": {
					limit: { context: 400000, output: 128000 },
					cost: { input: 1, output: 4 },
				},
				"us.openai.fable-5-2": {
					limit: { context: 400000, output: 128000 },
					cost: { input: 1.1, output: 4.4 },
				},
			},
		},
	};

	it("resolves global vs in-region haiku to their OWN price rows, not a collapsed one", () => {
		const index = indexModelsDevSnapshot(BEDROCK_CRIS_PAYLOAD);
		const global = lookupModelsDevScoped(index, "bedrock", "global.anthropic.claude-haiku-5-5");
		const inRegion = lookupModelsDevScoped(index, "bedrock", "anthropic.claude-haiku-5-5");
		// Global profile keeps list price; in-region keeps list + 10%.
		expect(global?.pricing?.input_per_m).toBe(0.1);
		expect(global?.pricing?.output_per_m).toBe(0.5);
		expect(inRegion?.pricing?.input_per_m).toBe(0.11);
		expect(inRegion?.pricing?.output_per_m).toBe(0.55);
	});

	it("resolves global vs us-region fable-5-2 to their own rows", () => {
		const index = indexModelsDevSnapshot(BEDROCK_CRIS_PAYLOAD);
		const global = lookupModelsDevScoped(index, "bedrock", "global.openai.fable-5-2");
		const us = lookupModelsDevScoped(index, "bedrock", "us.openai.fable-5-2");
		expect(global?.pricing?.input_per_m).toBe(1);
		expect(us?.pricing?.input_per_m).toBe(1.1);
	});

	it("falls back to the scoped canonical entry when the exact raw id has no row", () => {
		const index = indexModelsDevSnapshot(BEDROCK_CRIS_PAYLOAD);
		// `eu.` profile is absent from the payload, so no exact row exists; the
		// region-stripped canonical key still resolves (to the first-writer entry).
		const eu = lookupModelsDevScoped(index, "bedrock", "eu.anthropic.claude-haiku-5-5");
		expect(eu?.pricing?.input_per_m).toBe(0.11);
	});

	it("still resolves a cross-provider collision via the scoped canonical index when no exact row exists", () => {
		// github-copilot grok-4.7 (no region/vendor prefix): the exact raw-id index
		// has it, but this asserts the scoped-canonical fallback stays intact for a
		// backend whose id normalizes cleanly. Reuses the collision fixture shape.
		const index = indexModelsDevSnapshot({
			xai: { models: { "grok-4.7": { limit: { context: 500000, output: 500000 } } } },
			"github-copilot": {
				models: { "grok-4.7": { limit: { context: 500000, input: 372000, output: 128000 } } },
			},
		});
		const scoped = lookupModelsDevScoped(index, "github-copilot", "grok-4.7");
		expect(scoped?.max_output_tokens).toBe(128000);
	});
});

describe("ModelsDevCache — offline resilience (R-MC6)", () => {
	it("load() with no cache returns an empty index and never throws", async () => {
		const { path, cleanup } = tmpCachePath();
		try {
			const cache = new ModelsDevCache({ cachePath: path });
			await cache.load();
			expect(cache.getIndex().size).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("refresh() with a throwing fetch resolves (never rejects) and keeps the prior index", async () => {
		const { path, cleanup } = tmpCachePath();
		try {
			// Seed a cached snapshot on disk.
			writeFileSync(
				path,
				JSON.stringify({ etag: "v1", fetchedAtMs: 1000, payload: SAMPLE_PAYLOAD }),
			);
			const cache = new ModelsDevCache({
				cachePath: path,
				fetchImpl: () => {
					throw new Error("network down");
				},
			});
			await cache.load();
			expect(cache.getIndex().size).toBeGreaterThan(0);
			const status = await cache.refresh();
			expect(status).toBe("error");
			// Prior cached index survives the failed refresh.
			expect(lookupModelsDev(cache.getIndex(), "anthropic", "claude-opus-4")).toBeDefined();
		} finally {
			cleanup();
		}
	});

	it("starts empty and stays empty with no cache and a failing fetch (startup not blocked)", async () => {
		const { path, cleanup } = tmpCachePath();
		try {
			const cache = new ModelsDevCache({
				cachePath: path,
				fetchImpl: async () => jsonResponse({}, { status: 500 }),
			});
			await cache.load();
			const status = await cache.refresh();
			expect(status).toBe("error");
			expect(cache.getIndex().size).toBe(0);
		} finally {
			cleanup();
		}
	});
});

describe("ModelsDevCache — ETag conditional refresh (R-MC5)", () => {
	it("writes the ETag on a 200 and sends If-None-Match on the next refresh", async () => {
		const { path, cleanup } = tmpCachePath();
		try {
			const seenHeaders: Array<Record<string, string>> = [];
			let call = 0;
			const cache = new ModelsDevCache({
				cachePath: path,
				fetchImpl: async (_url, init) => {
					seenHeaders.push({ ...((init?.headers as Record<string, string>) ?? {}) });
					call += 1;
					if (call === 1) return jsonResponse(SAMPLE_PAYLOAD, { etag: '"abc"' });
					return jsonResponse({}, { status: 304 });
				},
			});
			await cache.load();
			const first = await cache.refresh();
			expect(first).toBe("updated");
			expect(existsSync(path)).toBe(true);
			expect(lookupModelsDev(cache.getIndex(), "anthropic", "claude-opus-4")).toBeDefined();

			const second = await cache.refresh();
			expect(second).toBe("not-modified");
			// Second request carried the stored ETag.
			expect(seenHeaders[1]?.["if-none-match"]).toBe('"abc"');
			// 304 kept the index intact.
			expect(lookupModelsDev(cache.getIndex(), "anthropic", "claude-opus-4")).toBeDefined();
		} finally {
			cleanup();
		}
	});
});

describe("ModelsDevCache — disable flag + refresh cadence", () => {
	it("refresh() is a no-op when disabled and never calls fetch", async () => {
		const { path, cleanup } = tmpCachePath();
		try {
			let called = false;
			const cache = new ModelsDevCache({
				cachePath: path,
				enabled: false,
				fetchImpl: async () => {
					called = true;
					return jsonResponse(SAMPLE_PAYLOAD);
				},
			});
			await cache.load();
			const status = await cache.refresh();
			expect(status).toBe("disabled");
			expect(called).toBe(false);
		} finally {
			cleanup();
		}
	});
});

describe("ModelsDevCache — in-memory only (cachePath null)", () => {
	it("refreshes into the index without touching disk", async () => {
		const cache = new ModelsDevCache({
			cachePath: null,
			fetchImpl: (async () =>
				new Response(JSON.stringify(SAMPLE_PAYLOAD), { status: 200 })) as unknown as typeof fetch,
		});
		await cache.load();
		expect(await cache.refresh(1)).toBe("updated");
		expect(cache.getIndex().size).toBeGreaterThan(0);
	});
});
