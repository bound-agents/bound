import { describe, expect, it } from "bun:test";
import { ModelRouter, PooledBackend, createModelRouter } from "../model-router";
import type {
	BackendCapabilities,
	ChatParams,
	LLMBackend,
	ModelBackendsConfig,
	StreamChunk,
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
					provider: "ollama",
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
					provider: "ollama",
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

		expect(() => createModelRouter(config)).toThrow("Provider not yet implemented");
	});

	it("should use default values for Ollama config", () => {
		const config: ModelBackendsConfig = {
			backends: [
				{
					id: "ollama-local",
					provider: "ollama",
					model: "llama2",
				},
			],
			default: "ollama-local",
		};

		const router = createModelRouter(config);
		const backend = router.getBackend();
		const caps = backend.capabilities();
		expect(caps.max_context).toBe(4096);
	});

	it("should support case-insensitive provider names", () => {
		const config: ModelBackendsConfig = {
			backends: [
				{
					id: "ollama-local",
					provider: "OLLAMA",
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
					provider: "ollama",
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
		expect(caps?.vision).toBe(false); // Ollama baseline has vision: false
		expect(caps?.tool_use).toBe(true); // Ollama baseline has tool_use: true
	});

	// AC3.1 — capabilities override adds vision: true to an Ollama backend
	it("merges capabilities override with driver baseline (AC3.1)", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "test",
					provider: "ollama",
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
					provider: "ollama",
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
					provider: "anthropic",
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
					provider: "ollama",
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

	it("isRateLimited returns false after expiry", async () => {
		const router = createModelRouter({
			backends: [
				{
					id: "test",
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
			],
			default: "test",
		});
		router.markRateLimited("test", 1); // 1ms — expires immediately
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(router.isRateLimited("test")).toBe(false);
	});

	// AC5.4 — listEligible excludes rate-limited backends
	it("listEligible excludes rate-limited backends (AC5.4)", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "a",
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
				{
					id: "b",
					provider: "ollama",
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
					provider: "ollama",
					model: "llava",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: true },
				},
				{
					id: "no-vision",
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
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
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
				{
					id: "b",
					provider: "ollama",
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
					provider: "ollama",
					model: "llava",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: true },
				},
				{
					id: "vision-backend-2",
					provider: "ollama",
					model: "llava",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 2,
					capabilities: { vision: true },
				},
				{
					id: "no-vision",
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
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
					provider: "ollama",
					model: "llava",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: true },
				},
				{
					id: "no-vision",
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
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
					provider: "ollama",
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
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
				{
					id: "backend-b",
					provider: "ollama",
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
					provider: "anthropic",
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
					provider: "ollama",
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
					provider: "ollama",
					model: "llava",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: true, tool_use: false },
				},
				{
					id: "partial-2",
					provider: "ollama",
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

describe("ModelRouter tier awareness", () => {
	it("getBackendTier returns the tier for a registered backend", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "cheap",
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					pricePerMInput: 0,
				},
				{
					id: "expensive",
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 5,
					pricePerMInput: 15,
				},
			],
			default: "cheap",
		});

		expect(router.getBackendTier("cheap")).toBe(1);
		expect(router.getBackendTier("expensive")).toBe(5);
	});

	it("getBackendTier returns null for unknown backend", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "test",
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
			],
			default: "test",
		});

		expect(router.getBackendTier("nonexistent")).toBeNull();
	});

	it("listEligibleByTier returns only backends matching the requested tier", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "cheap-a",
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
				{
					id: "cheap-b",
					provider: "ollama",
					model: "phi3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
				{
					id: "expensive",
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 5,
				},
			],
			default: "cheap-a",
		});

		const tier1 = router.listEligibleByTier(1);
		expect(tier1.map((b) => b.id)).toEqual(["cheap-a", "cheap-b"]);

		const tier5 = router.listEligibleByTier(5);
		expect(tier5.map((b) => b.id)).toEqual(["expensive"]);

		const tier3 = router.listEligibleByTier(3);
		expect(tier3).toHaveLength(0);
	});

	it("listEligibleByTier respects capability requirements", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "vision-cheap",
					provider: "ollama",
					model: "llava",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
					capabilities: { vision: true },
				},
				{
					id: "no-vision-cheap",
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
			],
			default: "no-vision-cheap",
		});

		const eligible = router.listEligibleByTier(1, { vision: true });
		expect(eligible.map((b) => b.id)).toEqual(["vision-cheap"]);
	});

	it("listEligibleByTier excludes rate-limited backends", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "a",
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
				{
					id: "b",
					provider: "ollama",
					model: "phi3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
					tier: 1,
				},
			],
			default: "a",
		});

		router.markRateLimited("a", 60_000);
		const eligible = router.listEligibleByTier(1);
		expect(eligible.map((b) => b.id)).toEqual(["b"]);
	});
});

describe("PooledBackend", () => {
	const defaultCaps: BackendCapabilities = {
		streaming: true,
		tool_use: true,
		system_prompt: true,
		prompt_caching: false,
		vision: false,
		extended_thinking: false,
		max_context: 4096,
	};

	function createSuccessBackend(_id: string): LLMBackend & { chatCalled: boolean } {
		const backend = {
			chatCalled: false,
			async *chat(): AsyncIterable<StreamChunk> {
				backend.chatCalled = true;
				yield {
					type: "delta" as const,
					text: "ok",
				};
			},
			capabilities: () => defaultCaps,
		};
		return backend;
	}

	function createFailingBackend(
		_id: string,
		statusCode: number,
	): LLMBackend & { chatCalled: boolean } {
		const backend = {
			chatCalled: false,
			// biome-ignore lint/correctness/useYield: throwing before yield is intentional
			async *chat(): AsyncIterable<StreamChunk> {
				backend.chatCalled = true;
				throw new LLMError(`HTTP ${statusCode}`, "test-provider", statusCode);
			},
			capabilities: () => defaultCaps,
		};
		return backend;
	}

	const mockParams: ChatParams = {
		messages: [{ role: "user", content: "test" }],
	};

	it("falls through to next backend on 429 rate limit", async () => {
		const backend1 = createFailingBackend("b1", 429);
		const backend2 = createSuccessBackend("b2");
		const pool = new PooledBackend([
			{ backend: backend1, tier: 1, pricePerMInput: 0 },
			{ backend: backend2, tier: 2, pricePerMInput: 0 },
		]);

		const chunks: StreamChunk[] = [];
		for await (const chunk of pool.chat(mockParams)) {
			chunks.push(chunk);
		}

		expect(backend1.chatCalled).toBe(true);
		expect(backend2.chatCalled).toBe(true);
		expect(chunks.length).toBeGreaterThan(0);
	});

	it("falls through to next backend on 500 server error", async () => {
		const backend1 = createFailingBackend("b1", 500);
		const backend2 = createSuccessBackend("b2");
		const pool = new PooledBackend([
			{ backend: backend1, tier: 1, pricePerMInput: 0 },
			{ backend: backend2, tier: 2, pricePerMInput: 0 },
		]);

		const chunks: StreamChunk[] = [];
		for await (const chunk of pool.chat(mockParams)) {
			chunks.push(chunk);
		}

		expect(backend1.chatCalled).toBe(true);
		expect(backend2.chatCalled).toBe(true);
	});

	it("propagates 400 client error immediately without fallback", async () => {
		const backend1 = createFailingBackend("b1", 400);
		const backend2 = createSuccessBackend("b2");
		const pool = new PooledBackend([
			{ backend: backend1, tier: 1, pricePerMInput: 0 },
			{ backend: backend2, tier: 2, pricePerMInput: 0 },
		]);

		let caught: LLMError | null = null;
		try {
			for await (const _chunk of pool.chat(mockParams)) {
				// should not reach here
			}
		} catch (error) {
			caught = error as LLMError;
		}

		expect(caught).not.toBeNull();
		expect(caught?.statusCode).toBe(400);
		expect(backend2.chatCalled).toBe(false); // No fallback
	});

	it("falls through to next backend on 402 Payment Required", async () => {
		const backend1 = createFailingBackend("b1", 402);
		const backend2 = createSuccessBackend("b2");
		const pool = new PooledBackend([
			{ backend: backend1, tier: 1, pricePerMInput: 0 },
			{ backend: backend2, tier: 2, pricePerMInput: 0 },
		]);

		const chunks: StreamChunk[] = [];
		for await (const chunk of pool.chat(mockParams)) {
			chunks.push(chunk);
		}

		expect(backend1.chatCalled).toBe(true);
		expect(backend2.chatCalled).toBe(true);
		expect(chunks.length).toBeGreaterThan(0);
	});
});

describe("ModelRouter thinking config", () => {
	it("getThinkingConfig returns undefined when no thinking config on backend", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "test",
					provider: "ollama",
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
					provider: "anthropic",
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
					provider: "anthropic",
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
					provider: "ollama",
					model: "llama3",
					baseUrl: "http://localhost:11434",
					contextWindow: 4096,
				},
			],
			default: "test",
		});
		expect(router.getThinkingConfig("nonexistent")).toBeUndefined();
	});
});
