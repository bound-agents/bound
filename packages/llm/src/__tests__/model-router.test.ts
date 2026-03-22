import { describe, expect, it } from "bun:test";
import { ModelRouter, createModelRouter } from "../model-router";
import type { LLMBackend, ModelBackendsConfig } from "../types";

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

describe("ModelRouter", () => {
	it("should create a router with multiple backends", () => {
		const backend1 = new MockBackend("backend1");
		const backend2 = new MockBackend("backend2");
		const backends = new Map<string, LLMBackend>([
			["backend1", backend1],
			["backend2", backend2],
		]);

		const router = new ModelRouter(backends, "backend1");
		expect(router).toBeDefined();
	});

	it("should retrieve backend by ID", () => {
		const backend1 = new MockBackend("backend1");
		const backend2 = new MockBackend("backend2");
		const backends = new Map<string, LLMBackend>([
			["backend1", backend1],
			["backend2", backend2],
		]);

		const router = new ModelRouter(backends, "backend1");
		const retrieved = router.getBackend("backend2");
		expect(retrieved).toBe(backend2);
	});

	it("should use default backend when no ID specified", () => {
		const backend1 = new MockBackend("backend1");
		const backends = new Map<string, LLMBackend>([["backend1", backend1]]);

		const router = new ModelRouter(backends, "backend1");
		const retrieved = router.getBackend();
		expect(retrieved).toBe(backend1);
	});

	it("should return default backend", () => {
		const backend1 = new MockBackend("backend1");
		const backends = new Map<string, LLMBackend>([["backend1", backend1]]);

		const router = new ModelRouter(backends, "backend1");
		const retrieved = router.getDefault();
		expect(retrieved).toBe(backend1);
	});

	it("should throw error for unknown backend ID", () => {
		const backend1 = new MockBackend("backend1");
		const backends = new Map<string, LLMBackend>([["backend1", backend1]]);

		const router = new ModelRouter(backends, "backend1");
		expect(() => router.getBackend("unknown")).toThrow("Unknown backend ID");
	});

	it("should list all backends with capabilities", () => {
		const backend1 = new MockBackend("backend1");
		const backend2 = new MockBackend("backend2");
		const backends = new Map<string, LLMBackend>([
			["backend1", backend1],
			["backend2", backend2],
		]);

		const router = new ModelRouter(backends, "backend1");
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
