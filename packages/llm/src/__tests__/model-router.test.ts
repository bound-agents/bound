import { describe, expect, it } from "bun:test";
import { ModelRouter, createModelRouter } from "../model-router";
import type {
	BackendCapabilities,
	BackendReadiness,
	LLMBackend,
	ModelBackendsConfig,
	ModelDescriptor,
	ModelRegistrar,
} from "../types";
import { LLMError } from "../types";

class MockBackend implements LLMBackend {
	constructor(public id: string) {}

	async *chat() {
		// Mock implementation
	}

	capabilities() {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			extended_thinking: false,
			max_context: 4096,
		};
	}
}

// Helper to create a router from backends map with no capability overrides
function createRouterFromBackends(
	backends: Map<string, LLMBackend>,
	defaultId: string,
): ModelRouter {
	const effectiveCaps = new Map<string, BackendCapabilities>();
	for (const [id, backend] of backends) {
		effectiveCaps.set(id, backend.capabilities());
	}
	return new ModelRouter(backends, defaultId, effectiveCaps);
}

/**
 * Caching-capable mock backend (advertises prompt_caching: true).
 * Used to test capability-based defaulting of getCacheTtl.
 */
class CachingMockBackend implements LLMBackend {
	constructor(public id: string) {}
	async *chat() {}
	capabilities() {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true, // ← THIS distinguishes it from MockBackend
			vision: false,
			extended_thinking: false,
			max_context: 200000,
		};
	}
}

import type { ResolvedBackend } from "../catalog/resolve-catalog";
import type { ModelMetadata } from "../catalog/resolve-metadata";

/** Build a minimal ResolvedBackend for applyResolvedCatalog tests. */
function resolvedBackend(opts: {
	maxContext?: number;
	maxOutputTokens?: number;
	maxOutputSource?: "config" | "provider" | "models_dev";
	ready?: boolean;
}): ResolvedBackend {
	const field_sources: ModelMetadata["field_sources"] = {};
	if (opts.maxContext !== undefined) field_sources.max_context = "models_dev";
	if (opts.maxOutputTokens !== undefined) {
		field_sources.max_output_tokens = opts.maxOutputSource ?? "models_dev";
	}
	const metadata: ModelMetadata = {
		provider_model_id: "m",
		logical_model: null,
		vendor: null,
		capabilities: opts.maxContext !== undefined ? { max_context: opts.maxContext } : {},
		...(opts.maxOutputTokens !== undefined && { max_output_tokens: opts.maxOutputTokens }),
		field_sources,
	};
	return {
		metadata,
		ready: opts.ready ?? opts.maxContext !== undefined,
		configGap: "",
		logicalModel: null,
		groupingSource: "none",
	};
}

describe("ModelRouter — applyResolvedCatalog (requirement 1 + 5)", () => {
	it("applies resolved max_context and max_output_tokens to a backend with none in config", () => {
		// A backend built from config WITHOUT context_window gets the sentinel 0
		// window; the catalog resolved both values from models.dev.
		const router = createModelRouter({
			backends: [
				{
					id: "grok",
					provider: "openai-compatible",
					apiKey: "k",
					model: "grok-4.7",
					baseUrl: "http://localhost",
					// no contextWindow, no maxOutputTokens
				},
			],
			default: "grok",
		});
		expect(router.getEffectiveCapabilities("grok")?.max_context).toBe(0);
		expect(router.getMaxOutputTokens("grok")).toBeUndefined();

		router.applyResolvedCatalog(
			new Map([["grok", resolvedBackend({ maxContext: 500000, maxOutputTokens: 128000 })]]),
		);

		expect(router.getEffectiveCapabilities("grok")?.max_context).toBe(500000);
		expect(router.getMaxOutputTokens("grok")).toBe(128000);
	});

	it("leaves a config-provided max_output_tokens untouched when catalog omits it", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "nova",
					provider: "bedrock",
					model: "nova-pro",
					region: "us-east-1",
					contextWindow: 300000,
					maxOutputTokens: 8192,
				},
			],
			default: "nova",
		});
		// Catalog resolves only max_context; config max_output_tokens stays.
		router.applyResolvedCatalog(new Map([["nova", resolvedBackend({ maxContext: 300000 })]]));
		expect(router.getEffectiveCapabilities("nova")?.max_context).toBe(300000);
		expect(router.getMaxOutputTokens("nova")).toBe(8192);
	});

	it("drops a non-config max_output_tokens that is >= max_context (output>=context sanity, req 5)", () => {
		// amazon-bedrock us.moonshotai.kimi-k3.1: context 1048576, output 1048576.
		// output == context would make computeBaseTruncationTarget 0; the
		// non-config value must be treated as unknown.
		const router = createModelRouter({
			backends: [{ id: "kimi", provider: "bedrock", model: "kimi", region: "us-east-1" }],
			default: "kimi",
		});
		router.applyResolvedCatalog(
			new Map([["kimi", resolvedBackend({ maxContext: 1048576, maxOutputTokens: 1048576 })]]),
		);
		expect(router.getEffectiveCapabilities("kimi")?.max_context).toBe(1048576);
		// Dropped → no max_output_tokens, so the loop sends the provider default and
		// the truncation target stays sane.
		expect(router.getMaxOutputTokens("kimi")).toBeUndefined();
	});

	it("respects a config max_output_tokens even when it is >= max_context (req 5)", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "kimi",
					provider: "bedrock",
					model: "kimi",
					region: "us-east-1",
					contextWindow: 1048576,
					maxOutputTokens: 1048576,
				},
			],
			default: "kimi",
		});
		// A config-sourced value is always honoured, even if it equals max_context.
		router.applyResolvedCatalog(
			new Map([
				[
					"kimi",
					resolvedBackend({
						maxContext: 1048576,
						maxOutputTokens: 1048576,
						maxOutputSource: "config",
					}),
				],
			]),
		);
		expect(router.getMaxOutputTokens("kimi")).toBe(1048576);
	});

	it("skips unready backends and backends absent from the router", () => {
		const router = createModelRouter({
			backends: [
				{ id: "a", provider: "bedrock", model: "a", region: "us-east-1", contextWindow: 200000 },
			],
			default: "a",
		});
		router.applyResolvedCatalog(
			new Map([
				// unready → skipped
				["a", resolvedBackend({ ready: false })],
				// unknown id → skipped, no throw
				["ghost", resolvedBackend({ maxContext: 999 })],
			]),
		);
		// 'a' keeps its config window; nothing from the unready entry applied.
		expect(router.getEffectiveCapabilities("a")?.max_context).toBe(200000);
	});
});

describe("ModelRouter — system prompt suffix", () => {
	it("returns the configured suffix only for its backend", () => {
		const configured = new MockBackend("configured");
		const plain = new MockBackend("plain");
		const backends = new Map<string, LLMBackend>([
			[configured.id, configured],
			[plain.id, plain],
		]);
		const router = new ModelRouter(
			backends,
			configured.id,
			undefined,
			new Map([
				[
					configured.id,
					{
						id: configured.id,
						provider: "bedrock",
						model: "configured",
						systemPromptSuffix: "Configured only.",
					},
				],
				[plain.id, { id: plain.id, provider: "bedrock", model: "plain" }],
			]),
		);
		expect(router.getSystemPromptSuffix(configured.id)).toBe("Configured only.");
		expect(router.getSystemPromptSuffix(plain.id)).toBeUndefined();
	});
});

describe("ModelRouter — getCacheTtl capability defaulting", () => {
	// Live regression: a thread ran with cr=0 across
	// most of its turns because Sonnet's `model_backends.json` config didn't
	// explicitly set `cacheTtl` (a config-landmine — every operator must
	// remember to set it for each caching-capable backend). `getCacheTtl`
	// returned undefined; bedrock-driver's gate disabled the system anchor
	// after the message-level marker also stopped firing; cumulative
	// caching collapsed.
	//
	// Contract: `getCacheTtl` falls back to a sensible default ("5m" — the
	// Bedrock baseline TTL supported by every caching model) when the
	// backend's effective capabilities advertise `prompt_caching: true`,
	// even if the config doesn't explicitly set `cacheTtl`. Operators can
	// still override to "1h" via config when they want extended TTL on
	// supported models.

	it("E1 (load-bearing): defaults to '5m' when caps say prompt_caching:true and config has no explicit cacheTtl", () => {
		const backend = new CachingMockBackend("sonnet-mock");
		const backends = new Map<string, LLMBackend>([[backend.id, backend]]);
		const effectiveCaps = new Map<string, BackendCapabilities>([
			[backend.id, backend.capabilities()],
		]);
		const router = new ModelRouter(backends, backend.id, effectiveCaps);
		expect(router.getCacheTtl(backend.id)).toBe("5m");
	});

	it("E2: returns undefined when caps say prompt_caching:false (no caching intended)", () => {
		const backend = new MockBackend("non-caching"); // prompt_caching: false
		const backends = new Map<string, LLMBackend>([[backend.id, backend]]);
		const router = createRouterFromBackends(backends, backend.id);
		expect(router.getCacheTtl(backend.id)).toBeUndefined();
	});

	it("keeps arbitrary configured cache TTLs available for internal scheduling", () => {
		const config: ModelBackendsConfig = {
			backends: [
				{
					id: "cached",
					provider: "bedrock",
					model: "anthropic.claude-sonnet",
					region: "us-east-1",
					cacheTtl: "30m",
				},
			],
			default: "cached",
		};
		const backend = new CachingMockBackend("cached");
		const router = new ModelRouter(
			new Map([[backend.id, backend]]),
			backend.id,
			new Map([[backend.id, backend.capabilities()]]),
			new Map([[backend.id, config.backends[0]]]),
		);
		expect(router.getCacheTtl("cached")).toBe("30m");
	});

	it("E3: explicit config cacheTtl='1h' overrides the capability default", () => {
		const config: ModelBackendsConfig = {
			backends: [
				{
					id: "opus-1h",
					provider: "bedrock",
					region: "us-west-2",
					model: "anthropic.claude-opus-4-7",
					contextWindow: 200000,
					cacheTtl: "1h",
				},
			],
			default: "opus-1h",
		};
		const router = createModelRouter(config);
		expect(router.getCacheTtl("opus-1h")).toBe("1h");
	});

	it("E4: returns undefined for an unknown backend ID", () => {
		const backend = new CachingMockBackend("known");
		const backends = new Map<string, LLMBackend>([[backend.id, backend]]);
		const effectiveCaps = new Map<string, BackendCapabilities>([
			[backend.id, backend.capabilities()],
		]);
		const router = new ModelRouter(backends, backend.id, effectiveCaps);
		expect(router.getCacheTtl("not-registered")).toBeUndefined();
	});
});

describe("ModelRouter", () => {
	it("should create a router with multiple backends", () => {
		const backend1 = new MockBackend("backend1");
		const backend2 = new MockBackend("backend2");
		const backends = new Map<string, LLMBackend>([
			["backend1", backend1],
			["backend2", backend2],
		]);

		const router = createRouterFromBackends(backends, "backend1");
		expect(router).toBeDefined();
	});

	it("should retrieve backend by ID", () => {
		const backend1 = new MockBackend("backend1");
		const backend2 = new MockBackend("backend2");
		const backends = new Map<string, LLMBackend>([
			["backend1", backend1],
			["backend2", backend2],
		]);

		const router = createRouterFromBackends(backends, "backend1");
		const retrieved = router.getBackend("backend2");
		expect(retrieved).toBe(backend2);
	});

	it("should use default backend when no ID specified", () => {
		const backend1 = new MockBackend("backend1");
		const backends = new Map<string, LLMBackend>([["backend1", backend1]]);

		const router = createRouterFromBackends(backends, "backend1");
		const retrieved = router.getBackend();
		expect(retrieved).toBe(backend1);
	});

	it("should return default backend", () => {
		const backend1 = new MockBackend("backend1");
		const backends = new Map<string, LLMBackend>([["backend1", backend1]]);

		const router = createRouterFromBackends(backends, "backend1");
		const retrieved = router.getDefault();
		expect(retrieved).toBe(backend1);
	});

	it("should throw error for unknown backend ID", () => {
		const backend1 = new MockBackend("backend1");
		const backends = new Map<string, LLMBackend>([["backend1", backend1]]);

		const router = createRouterFromBackends(backends, "backend1");
		expect(() => router.getBackend("unknown")).toThrow("Unknown backend ID");
	});

	it("should suggest available alternatives when backend unavailable", () => {
		const backend1 = new MockBackend("backend1");
		const backend2 = new MockBackend("backend2");
		const backends = new Map<string, LLMBackend>([
			["backend1", backend1],
			["backend2", backend2],
		]);

		const router = createRouterFromBackends(backends, "backend1");
		expect(() => router.getBackend("unknown")).toThrow("Available backends: backend1, backend2");
	});

	it("should list all backends with capabilities", () => {
		const backend1 = new MockBackend("backend1");
		const backend2 = new MockBackend("backend2");
		const backends = new Map<string, LLMBackend>([
			["backend1", backend1],
			["backend2", backend2],
		]);

		const router = createRouterFromBackends(backends, "backend1");
		const list = router.listBackends();

		expect(list).toHaveLength(2);
		expect(list.some((b) => b.id === "backend1")).toBe(true);
		expect(list.some((b) => b.id === "backend2")).toBe(true);
		expect(list[0].capabilities.streaming).toBe(true);
	});

	it("should create router from config with Ollama backend", () => {
		const config: ModelBackendsConfig = {
			backends: [
				{
					id: "ollama-local",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama2",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
				},
			],
			default: "ollama-local",
		};

		const router = createModelRouter(config);
		expect(router).toBeDefined();

		const backend = router.getBackend();
		expect(backend.capabilities().streaming).toBe(true);
		expect(backend.capabilities().tool_use).toBe(true);
	});

	it("should throw error if default backend not in config", () => {
		const config: ModelBackendsConfig = {
			backends: [
				{
					id: "ollama-local",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama2",
				},
			],
			default: "nonexistent",
		};

		expect(() => createModelRouter(config)).toThrow('Default backend "nonexistent" not found');
	});

	it("should throw error for unsupported provider", () => {
		const config: ModelBackendsConfig = {
			backends: [
				{
					id: "unsupported",
					provider: "unsupported-provider",
					model: "some-model",
				},
			],
			default: "unsupported",
		};

		expect(() => createModelRouter(config)).toThrow("Provider not supported");
	});

	it("reports max_context 0 (unresolved) for openai-compatible config with no context_window (R-MC4)", () => {
		const config: ModelBackendsConfig = {
			backends: [
				{
					id: "oai",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama2",
				},
			],
			default: "oai",
		};

		const router = createModelRouter(config);
		const backend = router.getBackend();
		const caps = backend.capabilities();
		// No hardcoded context-window guess (slice 6, R-MC4): a backend built from
		// static config WITHOUT context_window reports max_context 0 ("unresolved"),
		// which R-RT2 treats as ineligible and the catalog gate surfaces as a
		// config gap — rather than dispatching a turn on a guessed 8192 window.
		expect(caps.max_context).toBe(0);
	});

	it("should create router from config with OpenCode Go backend", () => {
		const config: ModelBackendsConfig = {
			backends: [
				{
					id: "opencode-go",
					provider: "opencode-go",
					apiKey: "test",
					model: "glm-5.1",
					baseUrl: "https://opencode.ai/zen/go/v1",
					contextWindow: 128000,
				},
			],
			default: "opencode-go",
		};

		const router = createModelRouter(config);
		const backend = router.getBackend();
		const caps = backend.capabilities();
		expect(caps.streaming).toBe(true);
		expect(caps.tool_use).toBe(true);
		expect(caps.max_context).toBe(128000);
	});

	it("should support case-insensitive provider names", () => {
		const config: ModelBackendsConfig = {
			backends: [
				{
					id: "ollama-local",
					provider: "OPENAI-COMPATIBLE",
					apiKey: "test",
					model: "llama2",
				},
			],
			default: "ollama-local",
		};

		const router = createModelRouter(config);
		expect(router).toBeDefined();
	});
});

describe("Phase 4: capability management", () => {
	// AC3.4 — no capabilities field falls back to driver baseline
	it("uses driver baseline when no capabilities override in config (AC3.4)", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "test",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
			],
			default: "test",
		});
		const caps = router.getEffectiveCapabilities("test");
		expect(caps).not.toBeNull();
		// openai-compatible baseline: prompt_caching: false, extended_thinking: false
		expect(caps?.prompt_caching).toBe(false);
		expect(caps?.extended_thinking).toBe(false);
		expect(caps?.tool_use).toBe(true);
	});

	// AC3.1 — capabilities override adds vision: true to an Ollama backend
	it("merges capabilities override with driver baseline (AC3.1)", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "test",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llava",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: true },
				},
			],
			default: "test",
		});
		const caps = router.getEffectiveCapabilities("test");
		expect(caps?.vision).toBe(true); // Override applied
		expect(caps?.tool_use).toBe(true); // Baseline retained (AC3.2)
	});

	// AC3.2 — unspecified fields retain provider default
	it("unspecified override fields retain provider defaults (AC3.2)", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "test",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: true }, // Only override vision
				},
			],
			default: "test",
		});
		const caps = router.getEffectiveCapabilities("test");
		// Non-overridden fields come from driver baseline
		expect(caps?.streaming).toBe(true);
		expect(caps?.system_prompt).toBe(true);
		expect(caps?.max_context).toBe(4096);
	});

	// AC3.3 — suppress vision on a vision-capable provider
	it("can suppress vision on a vision-capable provider (AC3.3)", () => {
		// Use Anthropic (which has vision: true by default in its capabilities())
		const router = createModelRouter({
			backends: [
				{
					id: "claude",
					provider: "bedrock",
					region: "us-east-1",
					model: "claude-3-opus",
					apiKey: "test-key",
					contextWindow: 200000,
					tier: 1,
					capabilities: { vision: false }, // Suppress vision
				},
			],
			default: "claude",
		});
		const caps = router.getEffectiveCapabilities("claude");
		expect(caps?.vision).toBe(false);
	});

	// AC5.1 — markRateLimited + isRateLimited round-trip
	it("markRateLimited + isRateLimited round-trip (AC5.1)", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "test",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
			],
			default: "test",
		});
		expect(router.isRateLimited("test")).toBe(false);
		router.markRateLimited("test", 60_000);
		expect(router.isRateLimited("test")).toBe(true);
	});

	it("isRateLimited expires exactly at the retry boundary", () => {
		let now = 1_000;
		const router = createModelRouter(
			{
				backends: [
					{
						id: "test",
						provider: "openai-compatible",
						apiKey: "test",
						model: "llama3",
						baseUrl: "http://localhost:11434",
						contextWindow: 4096,
						tier: 1,
					},
				],
				default: "test",
			},
			{ clock: () => now },
		);
		router.markRateLimited("test", 1_000);
		expect(router.isRateLimited("test")).toBe(true);
		now += 999;
		expect(router.isRateLimited("test")).toBe(true);
		now += 1;
		expect(router.isRateLimited("test")).toBe(false);
	});

	// AC5.4 — listEligible excludes rate-limited backends
	it("listEligible excludes rate-limited backends (AC5.4)", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "a",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
				{
					id: "b",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 2,
				},
			],
			default: "a",
		});
		router.markRateLimited("a", 60_000);
		const eligible = router.listEligible();
		expect(eligible.map((b) => b.id)).toEqual(["b"]);
	});

	// listEligible excludes backends missing required capability
	it("listEligible excludes backends lacking required capability", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "vision-backend",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llava",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: true },
				},
				{
					id: "no-vision",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: false },
				},
			],
			default: "no-vision",
		});
		const eligible = router.listEligible({ vision: true });
		expect(eligible.map((b) => b.id)).toEqual(["vision-backend"]);
	});

	// Text-only requests pass qualification unchanged (AC2.5 prerequisite)
	it("listEligible with no requirements returns all non-rate-limited backends", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "a",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
				{
					id: "b",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
			],
			default: "a",
		});
		const eligible = router.listEligible();
		expect(eligible).toHaveLength(2);
	});
});

describe("Phase 5: getEarliestCapableRecovery", () => {
	// AC2.4 — getEarliestCapableRecovery returns earliest expiry among rate-limited capable backends
	it("returns earliest expiry timestamp among rate-limited backends that support requirements", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "vision-backend-1",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llava",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: true },
				},
				{
					id: "vision-backend-2",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llava",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 2,
					capabilities: { vision: true },
				},
				{
					id: "no-vision",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: false },
				},
			],
			default: "no-vision",
		});

		// Mark both vision backends as rate-limited with different expiry times
		const now = Date.now();
		router.markRateLimited("vision-backend-1", 30_000); // Expires in 30s
		router.markRateLimited("vision-backend-2", 60_000); // Expires in 60s
		router.markRateLimited("no-vision", 10_000); // Expires in 10s (should be ignored)

		const earliest = router.getEarliestCapableRecovery({ vision: true });
		expect(earliest).toBeDefined();
		expect(earliest).toBeGreaterThan(now);
		// The earliest should be approximately 30s from now (vision-backend-1)
		if (earliest !== null) {
			expect(earliest).toBeLessThan(now + 31_000);
		}
	});

	// getEarliestCapableRecovery returns null when no rate-limited backend supports requirements
	it("returns null when no rate-limited backend supports the requirements", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "vision-backend",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llava",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: true },
				},
				{
					id: "no-vision",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: false },
				},
			],
			default: "no-vision",
		});

		// Only mark non-vision backend as rate-limited
		router.markRateLimited("no-vision", 10_000);

		// Query for vision requirement — should return null since vision backend is not rate-limited
		const earliest = router.getEarliestCapableRecovery({ vision: true });
		expect(earliest).toBeNull();
	});

	// getEarliestCapableRecovery returns null when no backends are rate-limited
	it("returns null when no backends are rate-limited", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "vision-backend",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llava",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: true },
				},
			],
			default: "vision-backend",
		});

		const earliest = router.getEarliestCapableRecovery({ vision: true });
		expect(earliest).toBeNull();
	});

	// getEarliestCapableRecovery with no requirements includes all rate-limited backends
	it("with no requirements, returns earliest expiry among all rate-limited backends", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "backend-a",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
				{
					id: "backend-b",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 2,
				},
			],
			default: "backend-a",
		});

		const now = Date.now();
		router.markRateLimited("backend-a", 100_000);
		router.markRateLimited("backend-b", 50_000);

		const earliest = router.getEarliestCapableRecovery();
		expect(earliest).toBeDefined();
		// Should be backend-b (50s < 100s)
		if (earliest !== null) {
			expect(earliest).toBeLessThan(now + 51_000);
		}
	});

	// getEarliestCapableRecovery checks all capability fields
	it("filters by all capability requirements", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "full-featured",
					provider: "bedrock",
					region: "us-east-1",
					model: "claude-3",
					apiKey: "test-key",
					contextWindow: 200000,
					tier: 1,
					capabilities: {
						vision: true,
						tool_use: true,
						system_prompt: true,
						prompt_caching: true,
					},
				},
				{
					id: "limited",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: false, tool_use: true },
				},
			],
			default: "limited",
		});

		const now = Date.now();
		router.markRateLimited("full-featured", 50_000);
		router.markRateLimited("limited", 100_000);

		// Query for vision requirement — only full-featured supports it
		const earliest = router.getEarliestCapableRecovery({ vision: true });
		expect(earliest).toBeDefined();
		if (earliest !== null) {
			expect(earliest).toBeLessThan(now + 51_000); // Should return full-featured expiry
		}
	});

	// getEarliestCapableRecovery returns null for unmet requirements
	it("returns null when no rate-limited backend has all required capabilities", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "partial-1",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llava",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: true, tool_use: false },
				},
				{
					id: "partial-2",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 2,
					capabilities: { vision: false, tool_use: true },
				},
			],
			default: "partial-1",
		});

		router.markRateLimited("partial-1", 50_000);
		router.markRateLimited("partial-2", 100_000);

		// Query for both vision AND tool_use — no backend has both
		const earliest = router.getEarliestCapableRecovery({
			vision: true,
			tool_use: true,
		});
		expect(earliest).toBeNull();
	});
});

describe("ModelRouter flat registry (R-RT1, slice 2)", () => {
	it("registers one backend per id as a flat route (no tier, no pooling)", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "cheap",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
				},
				{
					id: "expensive",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
				},
			],
			default: "cheap",
		});

		expect(
			router
				.listBackends()
				.map((b) => b.id)
				.sort(),
		).toEqual(["cheap", "expensive"]);
		// tier is gone from the router surface.
		expect((router as unknown as Record<string, unknown>).getBackendTier).toBeUndefined();
		expect((router as unknown as Record<string, unknown>).listEligibleByTier).toBeUndefined();
	});

	it("a later config entry with a duplicate id replaces the earlier one (last-wins)", () => {
		// PooledBackend is gone: two entries sharing an id no longer merge into a
		// pool. The flat registry keeps the last one so a reload-style duplicate
		// doesn't throw; the operator surface still lists one route per id.
		const router = createModelRouter({
			backends: [
				{
					id: "dup",
					provider: "openai-compatible",
					apiKey: "test",
					model: "first",
					baseUrl: "http://localhost:1",
					contextWindow: 4096,
				},
				{
					id: "dup",
					provider: "openai-compatible",
					apiKey: "test",
					model: "second",
					baseUrl: "http://localhost:2",
					contextWindow: 8192,
				},
			],
			default: "dup",
		});

		expect(router.listBackends().filter((b) => b.id === "dup")).toHaveLength(1);
		expect(router.getEffectiveCapabilities("dup")?.max_context).toBe(8192);
	});
});

describe("ModelRouter thinking config", () => {
	it("getThinkingConfig returns undefined when no thinking config on backend", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "test",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
				},
			],
			default: "test",
		});
		expect(router.getThinkingConfig("test")).toBeUndefined();
	});

	it("getThinkingConfig returns enabled config when thinking: true (boolean shorthand)", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "claude",
					provider: "bedrock",
					region: "us-east-1",
					model: "claude-sonnet-4-20250514",
					apiKey: "test-key",
					contextWindow: 200000,
					thinking: true,
				},
			],
			default: "claude",
		});
		const config = router.getThinkingConfig("claude");
		expect(config).toBeDefined();
		expect(config?.type).toBe("enabled");
		expect(config?.budget_tokens).toBe(10000);
	});

	it("getThinkingConfig returns config with custom budget when thinking: { budget_tokens: N }", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "claude",
					provider: "bedrock",
					region: "us-east-1",
					model: "claude-sonnet-4-20250514",
					apiKey: "test-key",
					contextWindow: 200000,
					thinking: { budget_tokens: 20000 },
				},
			],
			default: "claude",
		});
		const config = router.getThinkingConfig("claude");
		expect(config).toBeDefined();
		expect(config?.type).toBe("enabled");
		expect(config?.budget_tokens).toBe(20000);
	});

	it("getThinkingConfig returns null for unknown backend ID", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "test",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
				},
			],
			default: "test",
		});
		expect(router.getThinkingConfig("nonexistent")).toBeUndefined();
	});

	// Opus 4.7 requires `thinking: {type: "adaptive"}` — the old
	// `{type: "enabled", budget_tokens: N}` shape 400s on 4.7. The router must
	// preserve `adaptive` end-to-end instead of translating it to `enabled`,
	// and must also carry `display` (opt back into visible summarized thinking
	// on 4.7 — default is "omitted" / empty text).
	it("getThinkingConfig passes adaptive thinking through unchanged", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "opus",
					provider: "bedrock",
					region: "us-east-1",
					model: "claude-opus-4-7",
					apiKey: "test-key",
					contextWindow: 1_000_000,
					thinking: { type: "adaptive" },
				},
			],
			default: "opus",
		});
		const config = router.getThinkingConfig("opus");
		expect(config).toBeDefined();
		expect(config?.type).toBe("adaptive");
	});

	it("getThinkingConfig preserves display on adaptive thinking", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "opus",
					provider: "bedrock",
					region: "us-east-1",
					model: "claude-opus-4-7",
					apiKey: "test-key",
					contextWindow: 1_000_000,
					thinking: { type: "adaptive", display: "summarized" },
				},
			],
			default: "opus",
		});
		const config = router.getThinkingConfig("opus");
		expect(config?.type).toBe("adaptive");
		expect(config?.display).toBe("summarized");
	});

	it("maps thinking: { type: 'tool' } to an explicit provider disable and exposes the tool mode", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "tool-model",
					provider: "bedrock",
					region: "us-east-1",
					model: "anthropic.claude-opus-5",
					apiKey: "test-key",
					contextWindow: 200000,
					thinking: { type: "tool" },
				},
			],
			default: "tool-model",
		});

		expect(router.getThinkingConfig("tool-model")).toEqual({ type: "disabled" });
		expect(router.usesThinkingTool("tool-model")).toBe(true);
		expect(router.getEffort("tool-model")).toBeUndefined();
	});

	it("getEffort returns configured effort", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "opus",
					provider: "bedrock",
					region: "us-east-1",
					model: "claude-opus-4-7",
					apiKey: "test-key",
					contextWindow: 1_000_000,
					thinking: { type: "adaptive" },
					effort: "xhigh",
				},
			],
			default: "opus",
		});
		expect(router.getEffort("opus")).toBe("xhigh");
	});

	it("getEffort returns undefined when not configured", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "opus",
					provider: "bedrock",
					region: "us-east-1",
					model: "claude-opus-4-7",
					apiKey: "test-key",
					contextWindow: 1_000_000,
				},
			],
			default: "opus",
		});
		expect(router.getEffort("opus")).toBeUndefined();
	});
});

describe("ModelRouter.reload — in-place config swap", () => {
	const initialConfig: ModelBackendsConfig = {
		backends: [
			{
				id: "old-backend",
				provider: "openai-compatible",
				apiKey: "test",
				model: "llama3",
				baseUrl: "http://localhost:11434",
				contextWindow: 4096,
				tier: 3,
			},
		],
		default: "old-backend",
	};

	it("replaces backends and default when called with a new config", () => {
		const router = createModelRouter(initialConfig);
		expect(router.getDefaultId()).toBe("old-backend");
		expect(router.listBackends().map((b) => b.id)).toEqual(["old-backend"]);

		router.reload({
			backends: [
				{
					id: "new-backend",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama4",
					baseUrl: "http://localhost:11434",
					contextWindow: 8192,
					tier: 2,
				},
			],
			default: "new-backend",
		});

		expect(router.getDefaultId()).toBe("new-backend");
		expect(router.listBackends().map((b) => b.id)).toEqual(["new-backend"]);
		expect(() => router.getBackend("old-backend")).toThrow("Unknown backend ID");
	});

	it("preserves router identity so held references see the updated state", () => {
		const router = createModelRouter(initialConfig);
		// Simulate long-held reference (agent-loop, scheduler, server).
		const heldRef = router;

		router.reload({
			backends: [
				{
					id: "swapped",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama4",
					baseUrl: "http://localhost:11434",
					contextWindow: 8192,
					tier: 1,
				},
			],
			default: "swapped",
		});

		// The previously held reference must reflect the new state — no indirection needed.
		expect(heldRef.getDefaultId()).toBe("swapped");
		expect(heldRef.listBackends().map((b) => b.id)).toEqual(["swapped"]);
	});

	it("refreshes effective capabilities after reload", () => {
		const router = createModelRouter(initialConfig);
		expect(router.getEffectiveCapabilities("old-backend")).not.toBeNull();

		router.reload({
			backends: [
				{
					id: "vision-capable",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llava",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					capabilities: { vision: true },
				},
			],
			default: "vision-capable",
		});

		expect(router.getEffectiveCapabilities("old-backend")).toBeNull();
		const caps = router.getEffectiveCapabilities("vision-capable");
		expect(caps?.vision).toBe(true);
	});

	it("refreshes thinking/effort config after reload", () => {
		const router = createModelRouter(initialConfig);
		expect(router.getThinkingConfig("old-backend")).toBeUndefined();

		router.reload({
			backends: [
				{
					id: "opus",
					provider: "bedrock",
					region: "us-east-1",
					model: "claude-opus-4-7",
					apiKey: "test-key",
					contextWindow: 1_000_000,
					thinking: { type: "adaptive" },
					effort: "xhigh",
				},
			],
			default: "opus",
		});

		const thinking = router.getThinkingConfig("opus");
		expect(thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(router.getEffort("opus")).toBe("xhigh");
	});

	it("clears rate-limit state for backends that disappear", () => {
		const router = createModelRouter(initialConfig);
		router.markRateLimited("old-backend", 60_000);
		expect(router.isRateLimited("old-backend")).toBe(true);

		router.reload({
			backends: [
				{
					id: "fresh",
					provider: "openai-compatible",
					apiKey: "test",
					model: "llama4",
					baseUrl: "http://localhost:11434",
					contextWindow: 8192,
				},
			],
			default: "fresh",
		});

		// old-backend no longer exists, so any query about it should return false,
		// and the new backend must start un-rate-limited.
		expect(router.isRateLimited("old-backend")).toBe(false);
		expect(router.isRateLimited("fresh")).toBe(false);
	});

	it("supports hub-only mode (empty backends) on reload", () => {
		const router = createModelRouter(initialConfig);
		router.reload({ backends: [], default: "" });

		expect(router.listBackends()).toEqual([]);
		expect(router.getDefaultId()).toBe("");
	});

	it("throws when new config's default is not present in backends", () => {
		const router = createModelRouter(initialConfig);
		expect(() =>
			router.reload({
				backends: [
					{
						id: "only-one",
						provider: "openai-compatible",
						apiKey: "test",
						model: "llama4",
						baseUrl: "http://localhost:11434",
						contextWindow: 8192,
					},
				],
				default: "not-in-backends",
			}),
		).toThrow(/Default backend .* not found/);
	});

	it("leaves router state unchanged when reload throws (invalid default)", () => {
		const router = createModelRouter(initialConfig);
		const before = {
			defaultId: router.getDefaultId(),
			ids: router.listBackends().map((b) => b.id),
		};

		try {
			router.reload({
				backends: [
					{
						id: "x",
						provider: "openai-compatible",
						apiKey: "test",
						model: "y",
						baseUrl: "http://localhost:11434",
						contextWindow: 8192,
					},
				],
				default: "not-x",
			});
		} catch {
			// expected
		}

		expect(router.getDefaultId()).toBe(before.defaultId);
		expect(router.listBackends().map((b) => b.id)).toEqual(before.ids);
	});
});

// ---------------------------------------------------------------------------
// Generic readiness contract (umans is the first implementer). These tests use
// a PROVIDER-NEUTRAL stub readiness backend to prove the router path has no
// umans-specific branching (AC.20), plus the umans factory case (AC.1).
// ---------------------------------------------------------------------------

const READY_CAPS: BackendCapabilities = {
	streaming: true,
	tool_use: true,
	system_prompt: true,
	prompt_caching: true,
	vision: false,
	extended_thinking: false,
	max_context: 100000,
};

/** Provider-neutral readiness backend stub — not umans. */
class StubReadinessBackend implements LLMBackend {
	readiness: BackendReadiness;
	private capturedRegistrar?: ModelRegistrar;
	private disposed = false;
	private ready = false;
	registerCalls = 0;

	constructor(
		private namespaceId: string,
		private models: ModelDescriptor[],
		private deferred = false,
	) {
		this.readiness = {
			isReady: () => this.ready,
			dispose: () => {
				this.disposed = true;
			},
			start: (registrar) => {
				this.capturedRegistrar = registrar;
				if (!this.deferred) this.fire();
			},
		};
	}

	/** Manually trigger expansion (for deferred backends). */
	fire(): void {
		if (this.disposed || !this.capturedRegistrar) return;
		this.ready = true;
		this.registerCalls++;
		this.capturedRegistrar.register(
			this.namespaceId,
			this.models.map((descriptor) => ({
				descriptor,
				backend: new MockBackend(descriptor.id),
			})),
		);
	}

	// biome-ignore lint/correctness/useYield: a namespace stub never yields — it throws.
	async *chat(): AsyncGenerator<never> {
		throw new LLMError("stub namespace not invokable", "stub");
	}
	capabilities() {
		return { ...READY_CAPS, max_context: 0 };
	}
}

describe("ModelRouter generic readiness (AC.20)", () => {
	function descriptor(id: string): ModelDescriptor {
		return {
			id,
			capabilities: { ...READY_CAPS },
			tier: 3,
			pricing: { inputPerM: 1, outputPerM: 2 },
			maxOutputTokens: 8192,
		};
	}

	it("excludes a not-ready readiness backend from listEligible/listBackends and isNotReady", () => {
		const stub = new StubReadinessBackend("ns", [descriptor("m-a")], true);
		const backends = new Map<string, LLMBackend>([["ns", stub]]);
		const router = new ModelRouter(backends, "ns");

		expect(router.isNotReady("ns")).toBe(true);
		expect(router.listBackends().map((b) => b.id)).not.toContain("ns");
		expect(router.listEligible().map((b) => b.id)).not.toContain("ns");
		expect(router.getReadinessBackends().map((r) => r.id)).toEqual(["ns"]);
	});

	it("expands via the registrar path: adds backends, clears not-ready, removes placeholder, redirects default", () => {
		const models = [descriptor("m-a"), descriptor("m-b")];
		const stub = new StubReadinessBackend("ns", models, true);
		const backends = new Map<string, LLMBackend>([["ns", stub]]);
		const router = new ModelRouter(backends, "ns");

		// Build a registrar that drives the router primitives (the real
		// CLI-layer registrar does the same + config writes).
		const registrar: ModelRegistrar = {
			register(_providerId, entries) {
				for (const { descriptor: d, backend } of entries) {
					router.addDynamicBackend(d.id, backend, d.capabilities);
				}
				router.redirectDefault("ns", entries[0].descriptor.id);
				router.removeBackend("ns");
			},
		};
		stub.readiness.start(registrar);
		stub.fire();

		expect(router.isNotReady("m-a")).toBe(false);
		expect(
			router
				.listBackends()
				.map((b) => b.id)
				.sort(),
		).toEqual(["m-a", "m-b"]);
		expect(router.tryGetBackend("ns")).toBeNull();
		expect(router.getDefaultId()).toBe("m-a");
		expect(router.getRouteId("m-a")).toBeNull();
	});

	it("resolves getMaxOutputTokens for a dynamically-registered backend (per-model output budget)", () => {
		// Regression: addDynamicBackend previously stored caps/tier but not the
		// output budget, so getMaxOutputTokens returned undefined for dynamic
		// (e.g. umans) models. The loop then sent no max_tokens and the provider
		// applied a low default (~4096), truncating heavy reasoners mid-thinking.
		// The descriptor's maxOutputTokens must reach backendConfigs.
		const models = [descriptor("m-a")]; // descriptor() sets maxOutputTokens: 8192
		const stub = new StubReadinessBackend("ns", models, true);
		const router = new ModelRouter(new Map<string, LLMBackend>([["ns", stub]]), "ns");

		const registrar: ModelRegistrar = {
			register(_providerId, entries) {
				for (const { descriptor: d, backend } of entries) {
					router.addDynamicBackend(d.id, backend, d.capabilities, d.maxOutputTokens);
				}
				router.redirectDefault("ns", entries[0].descriptor.id);
				router.removeBackend("ns");
			},
		};
		stub.readiness.start(registrar);
		stub.fire();

		expect(router.getMaxOutputTokens("m-a")).toBe(8192);
	});

	it("leaves getMaxOutputTokens undefined when a dynamic backend reports no budget", () => {
		// A dynamic backend without a per-model output limit stays undefined —
		// the caller (clampMaxOutputTokens) then omits max_tokens, unchanged.
		const stub = new StubReadinessBackend("ns", [descriptor("m-a")], true);
		const router = new ModelRouter(new Map<string, LLMBackend>([["ns", stub]]), "ns");
		router.addDynamicBackend("m-x", stub, { ...READY_CAPS }, undefined);
		expect(router.getMaxOutputTokens("m-x")).toBeUndefined();
	});

	it("markNotReady excludes a resolved static backend from selection + advertisement (R-MC4)", () => {
		// A static (non-readiness) backend starts ready. When the catalog layer
		// determines it lacks a resolved max_context, the CLI layer marks it
		// not-ready through this primitive so listBackends/listEligible exclude
		// it — the same mechanism readiness backends use — rather than inventing
		// a parallel gate. markNotReady/clearNotReady are symmetric.
		const backends = new Map<string, LLMBackend>([
			["ready-one", new MockBackend("ready-one")],
			["gapped", new MockBackend("gapped")],
		]);
		const router = new ModelRouter(backends, "ready-one");

		// Both start selectable (no readiness wiring).
		expect(router.isNotReady("gapped")).toBe(false);
		expect(router.listBackends().map((b) => b.id)).toContain("gapped");

		router.markNotReady("gapped");
		expect(router.isNotReady("gapped")).toBe(true);
		expect(router.listBackends().map((b) => b.id)).not.toContain("gapped");
		expect(router.listEligible().map((b) => b.id)).not.toContain("gapped");

		// A later refresh resolves the gap — clearNotReady flips it back.
		router.clearNotReady("gapped");
		expect(router.isNotReady("gapped")).toBe(false);
		expect(router.listBackends().map((b) => b.id)).toContain("gapped");
	});

	it("disposes superseded readiness backends on reload (AC.5)", () => {
		const stub = new StubReadinessBackend("ns", [descriptor("m-a")], true);
		let disposed = false;
		// Wrap dispose to observe it.
		const origDispose = stub.readiness.dispose;
		stub.readiness.dispose = () => {
			disposed = true;
			origDispose();
		};
		const backends = new Map<string, LLMBackend>([["ns", stub]]);
		const router = new ModelRouter(backends, "ns");

		// Reload to a config WITHOUT the readiness backend.
		router.reload({
			backends: [
				{
					id: "x",
					provider: "openai-compatible",
					apiKey: "test",
					model: "y",
					baseUrl: "http://localhost:11434",
					contextWindow: 8192,
				},
			],
			default: "x",
		});

		expect(disposed).toBe(true);
		// A late fire() from the disposed stub must NOT register into the router.
		const registrar: ModelRegistrar = {
			register() {
				router.addDynamicBackend("m-a", new MockBackend("m-a"), READY_CAPS);
			},
		};
		stub.readiness.start(registrar);
		stub.fire(); // no-op: disposed
		expect(router.tryGetBackend("m-a")).toBeNull();
	});
});

describe("ModelRouter umans factory case (AC.1)", () => {
	it("builds a not-ready umans namespace backend with readiness from a config-light entry", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "umans",
					provider: "umans",
					model: "",
					apiKey: "sk-test",
				} as unknown as ModelBackendsConfig["backends"][number],
			],
			default: "umans",
		});
		// The namespace exists but is not-ready (excluded from selection).
		expect(router.isNotReady("umans")).toBe(true);
		expect(router.tryGetBackend("umans")?.readiness).toBeDefined();
		expect(router.listBackends().map((b) => b.id)).not.toContain("umans");
		expect(router.getReadinessBackends().map((r) => r.id)).toEqual(["umans"]);
	});

	it("throws when a umans backend is missing api_key", () => {
		expect(() =>
			createModelRouter({
				backends: [
					{
						id: "umans",
						provider: "umans",
						model: "",
					} as unknown as ModelBackendsConfig["backends"][number],
				],
				default: "umans",
			}),
		).toThrow(/umans/i);
	});
});
