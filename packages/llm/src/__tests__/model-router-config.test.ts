import { describe, expect, it } from "bun:test";
import { PooledBackend, createModelRouter } from "../model-router";
import type { ChatParams, LLMBackend, ModelBackendsConfig, StreamChunk } from "../types";
import { LLMError } from "../types";

// createBackendFromConfig is the dominant uncovered block in model-router.ts:
// the per-provider driver-construction switch. Each case is reachable by
// building a router from a one-backend config; construction alone (no chat())
// exercises the branch. The missing-field guards assert the required-key
// validation. No provider is contacted — drivers are constructed, not called.

function singleBackendRouter(config: ModelBackendsConfig) {
	return createModelRouter(config);
}

describe("createBackendFromConfig — driver construction per provider", () => {
	it("constructs a bedrock backend with region", () => {
		const router = singleBackendRouter({
			backends: [{ id: "b", provider: "bedrock", region: "us-east-1", model: "m" }],
			default: "b",
		});
		expect(router.getBackend("b").capabilities()).toBeDefined();
	});

	it("rejects a bedrock backend missing region", () => {
		expect(() =>
			singleBackendRouter({
				backends: [{ id: "b", provider: "bedrock", model: "m" }],
				default: "b",
			}),
		).toThrow("Bedrock driver requires region");
	});

	it("constructs an anthropic backend with apiKey", () => {
		const router = singleBackendRouter({
			backends: [{ id: "a", provider: "anthropic", apiKey: "k", model: "claude" }],
			default: "a",
		});
		expect(router.getBackend("a").capabilities()).toBeDefined();
	});

	it("rejects an anthropic backend missing apiKey", () => {
		expect(() =>
			singleBackendRouter({
				backends: [{ id: "a", provider: "anthropic", model: "claude" }],
				default: "a",
			}),
		).toThrow("Anthropic driver requires apiKey");
	});

	it("rejects an openai-compatible backend missing apiKey", () => {
		expect(() =>
			singleBackendRouter({
				backends: [{ id: "o", provider: "openai-compatible", model: "m" }],
				default: "o",
			}),
		).toThrow("OpenAI-compatible driver requires apiKey");
	});

	it("constructs a cerebras backend (openai-compatible under the hood)", () => {
		const router = singleBackendRouter({
			backends: [{ id: "c", provider: "cerebras", apiKey: "k", model: "m" }],
			default: "c",
		});
		expect(router.getBackend("c").capabilities()).toBeDefined();
	});

	it("rejects a cerebras backend missing apiKey", () => {
		expect(() =>
			singleBackendRouter({
				backends: [{ id: "c", provider: "cerebras", model: "m" }],
				default: "c",
			}),
		).toThrow("Cerebras driver requires apiKey");
	});

	it("constructs a zai backend with its default baseUrl", () => {
		const router = singleBackendRouter({
			backends: [{ id: "z", provider: "zai", apiKey: "k", model: "glm" }],
			default: "z",
		});
		expect(router.getBackend("z").capabilities()).toBeDefined();
	});

	it("rejects a zai backend missing apiKey", () => {
		expect(() =>
			singleBackendRouter({
				backends: [{ id: "z", provider: "zai", model: "glm" }],
				default: "z",
			}),
		).toThrow("z.AI driver requires apiKey");
	});

	it("constructs an opencode-go backend with apiKey", () => {
		const router = singleBackendRouter({
			backends: [{ id: "g", provider: "opencode-go", apiKey: "k", model: "m" }],
			default: "g",
		});
		expect(router.getBackend("g").capabilities()).toBeDefined();
	});

	it("rejects an opencode-go backend missing apiKey", () => {
		expect(() =>
			singleBackendRouter({
				backends: [{ id: "g", provider: "opencode-go", model: "m" }],
				default: "g",
			}),
		).toThrow("OpenCode Go driver requires apiKey");
	});

	it("constructs a umans backend with apiKey", () => {
		const router = singleBackendRouter({
			backends: [{ id: "u", provider: "umans", apiKey: "k", model: "m" }],
			default: "u",
		});
		// umans registers a not-ready NAMESPACE driver under the config id.
		expect(router.getBackend("u")).toBeDefined();
	});

	it("rejects a umans backend missing apiKey", () => {
		expect(() =>
			singleBackendRouter({
				backends: [{ id: "u", provider: "umans", model: "m" }],
				default: "u",
			}),
		).toThrow("umans driver requires apiKey");
	});

	it("constructs a bedrock-mantle backend with region and providerMode", () => {
		const router = singleBackendRouter({
			backends: [
				{
					id: "mantle",
					provider: "bedrock-mantle",
					region: "us-east-1",
					providerMode: "anthropic",
					model: "m",
				},
			],
			default: "mantle",
		});
		expect(router.getBackend("mantle").capabilities()).toBeDefined();
	});

	it("rejects a bedrock-mantle backend missing region", () => {
		expect(() =>
			singleBackendRouter({
				backends: [
					{ id: "mantle", provider: "bedrock-mantle", providerMode: "anthropic", model: "m" },
				],
				default: "mantle",
			}),
		).toThrow("Bedrock Mantle driver requires region");
	});

	it("rejects a bedrock-mantle backend missing providerMode", () => {
		expect(() =>
			singleBackendRouter({
				backends: [{ id: "mantle", provider: "bedrock-mantle", region: "us-east-1", model: "m" }],
				default: "mantle",
			}),
		).toThrow("Bedrock Mantle driver requires providerMode");
	});
});

describe("buildRouterState — pooling backends under a shared id", () => {
	it("pools two backends under one id, merging tier to the best (lowest)", () => {
		// Two configs with the SAME id are pooled into a PooledBackend; the merged
		// backend takes the lowest tier.
		const router = createModelRouter({
			backends: [
				{
					id: "pooled",
					provider: "openai-compatible",
					apiKey: "k",
					model: "m",
					baseUrl: "http://localhost:1",
					tier: 3,
				},
				{
					id: "pooled",
					provider: "cerebras",
					apiKey: "k",
					model: "m",
					tier: 1,
				},
			],
			default: "pooled",
		});
		const backend = router.getBackend("pooled");
		expect(backend).toBeInstanceOf(PooledBackend);
		// listEligibleByTier keys off the merged (best) tier.
		expect(router.listEligibleByTier(1).some((b) => b.id === "pooled")).toBe(true);
		expect(router.listEligibleByTier(3).some((b) => b.id === "pooled")).toBe(false);
	});
});

describe("PooledBackend — network-error fall-through and exhaustion", () => {
	const caps = {
		streaming: true,
		tool_use: true,
		system_prompt: true,
		prompt_caching: false,
		vision: false,
		extended_thinking: false,
		max_context: 4096,
	};
	const params: ChatParams = { messages: [{ role: "user", content: "hi" }] };

	it("falls through to the next backend on a non-LLMError network failure", async () => {
		let secondCalled = false;
		const first: LLMBackend = {
			// biome-ignore lint/correctness/useYield: throws before yielding
			async *chat(): AsyncIterable<StreamChunk> {
				throw new TypeError("fetch failed: ECONNREFUSED");
			},
			capabilities: () => caps,
		};
		const second: LLMBackend = {
			async *chat(): AsyncIterable<StreamChunk> {
				secondCalled = true;
				yield { type: "delta", text: "ok" };
			},
			capabilities: () => caps,
		};
		const pool = new PooledBackend([
			{ backend: first, tier: 1, pricePerMInput: 0 },
			{ backend: second, tier: 2, pricePerMInput: 0 },
		]);
		const chunks: StreamChunk[] = [];
		for await (const c of pool.chat(params)) chunks.push(c);
		expect(secondCalled).toBe(true);
		expect(chunks.length).toBeGreaterThan(0);
	});

	it("throws the last error when every pooled backend fails", async () => {
		const makeFailing = (code: number): LLMBackend => ({
			// biome-ignore lint/correctness/useYield: throws before yielding
			async *chat(): AsyncIterable<StreamChunk> {
				throw new LLMError(`HTTP ${code}`, "p", code);
			},
			capabilities: () => caps,
		});
		const pool = new PooledBackend([
			{ backend: makeFailing(429), tier: 1, pricePerMInput: 0 },
			{ backend: makeFailing(500), tier: 2, pricePerMInput: 0 },
		]);
		let caught: unknown = null;
		try {
			for await (const _c of pool.chat(params)) {
				// no success
			}
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(LLMError);
	});
});

describe("createBackendFromConfig — github-copilot token sharing", () => {
	it("shares one token manager across backends over the same store file", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { cleanupTmpDirSync } = await import("@bound/shared/test-utils");
		const dir = mkdtempSync(join(tmpdir(), "copilot-share-"));
		try {
			const storePath = join(dir, "copilot-auth.json");
			writeFileSync(
				storePath,
				JSON.stringify({
					accessToken: "ghu_a",
					refreshToken: "ghr_a",
					accessTokenExpiresAt: Date.now() + 3_600_000,
				}),
			);
			const router = createModelRouter({
				backends: [
					{
						id: "c1",
						provider: "github-copilot",
						model: "claude-sonnet-5.5",
						tokenStorePath: storePath,
					},
					{ id: "c2", provider: "github-copilot", model: "gpt-6.2-sol", tokenStorePath: storePath },
				],
				default: "c1",
			});
			const managerOf = (id: string) =>
				(router.getBackend(id) as unknown as { tokenManager: unknown }).tokenManager;
			expect(managerOf("c1")).toBeDefined();
			expect(managerOf("c1")).toBe(managerOf("c2"));
			expect(router.getBackend("c1").capabilities().extended_thinking).toBe(true);
			expect(router.getBackend("c2").capabilities().extended_thinking).toBe(false);
		} finally {
			cleanupTmpDirSync(dir);
		}
	});
});
