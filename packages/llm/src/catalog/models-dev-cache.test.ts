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

	it("shouldRefresh honors the 24h interval against an injected clock", async () => {
		const { path, cleanup } = tmpCachePath();
		try {
			writeFileSync(path, JSON.stringify({ etag: "v1", fetchedAtMs: 0, payload: SAMPLE_PAYLOAD }));
			const day = 24 * 60 * 60 * 1000;
			const cache = new ModelsDevCache({ cachePath: path, refreshIntervalMs: day });
			await cache.load();
			expect(cache.shouldRefresh(day - 1)).toBe(false);
			expect(cache.shouldRefresh(day)).toBe(true);
			expect(cache.shouldRefresh(day + 1)).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("shouldRefresh is true when nothing has been fetched yet", async () => {
		const { path, cleanup } = tmpCachePath();
		try {
			const cache = new ModelsDevCache({ cachePath: path });
			await cache.load();
			expect(cache.shouldRefresh(0)).toBe(true);
		} finally {
			cleanup();
		}
	});
});
