import { describe, expect, it } from "bun:test";
import { ModelRouter, createModelRouter } from "../model-router";
import type { BackendCapabilities, LLMBackend, ModelBackendsConfig } from "../types";

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
			backends: [{ id: "test", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1 }],
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
			backends: [{
				id: "test",
				provider: "ollama",
				model: "llava",
				baseUrl: "http://localhost:11434",
				contextWindow: 4096,
				tier: 1,
				capabilities: { vision: true },
			}],
			default: "test",
		});
		const caps = router.getEffectiveCapabilities("test");
		expect(caps?.vision).toBe(true); // Override applied
		expect(caps?.tool_use).toBe(true); // Baseline retained (AC3.2)
	});

	// AC3.2 — unspecified fields retain provider default
	it("unspecified override fields retain provider defaults (AC3.2)", () => {
		const router = createModelRouter({
			backends: [{
				id: "test",
				provider: "ollama",
				model: "llama3",
				baseUrl: "http://localhost:11434",
				contextWindow: 4096,
				tier: 1,
				capabilities: { vision: true }, // Only override vision
			}],
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
			backends: [{
				id: "claude",
				provider: "anthropic",
				model: "claude-3-opus",
				apiKey: "test-key",
				contextWindow: 200000,
				tier: 1,
				capabilities: { vision: false }, // Suppress vision
			}],
			default: "claude",
		});
		const caps = router.getEffectiveCapabilities("claude");
		expect(caps?.vision).toBe(false);
	});

	// AC5.1 — markRateLimited + isRateLimited round-trip
	it("markRateLimited + isRateLimited round-trip (AC5.1)", () => {
		const router = createModelRouter({
			backends: [{ id: "test", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1 }],
			default: "test",
		});
		expect(router.isRateLimited("test")).toBe(false);
		router.markRateLimited("test", 60_000);
		expect(router.isRateLimited("test")).toBe(true);
	});

	it("isRateLimited returns false after expiry", async () => {
		const router = createModelRouter({
			backends: [{ id: "test", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1 }],
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
				{ id: "a", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1 },
				{ id: "b", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 2 },
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
				{ id: "vision-backend", provider: "ollama", model: "llava", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1, capabilities: { vision: true } },
				{ id: "no-vision", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1 },
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
				{ id: "a", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1 },
				{ id: "b", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1 },
			],
			default: "a",
		});
		const eligible = router.listEligible();
		expect(eligible).toHaveLength(2);
	});
});
