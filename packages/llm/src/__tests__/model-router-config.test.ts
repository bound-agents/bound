import { describe, expect, it } from "bun:test";
import { OpenCodeGoDriver } from "../drivers/opencode-go";
import { createModelRouter } from "../model-router";
import type { ModelBackendsConfig } from "../types";

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

	it("constructs a self-configuring opencode-go namespace backend when model is omitted", () => {
		const router = singleBackendRouter({
			backends: [{ id: "ocg", provider: "opencode-go", apiKey: "k" }],
			default: "ocg",
		});
		const backend = router.getBackend("ocg") as OpenCodeGoDriver;
		expect(backend).toBeInstanceOf(OpenCodeGoDriver);
		expect(backend.readiness?.isReady()).toBe(false);
		backend.readiness?.dispose();
	});

	it("constructs a concrete opencode-go backend (no readiness) when model is set", () => {
		const router = singleBackendRouter({
			backends: [{ id: "g", provider: "opencode-go", apiKey: "k", model: "glm-5" }],
			default: "g",
		});
		expect((router.getBackend("g") as OpenCodeGoDriver).readiness).toBeUndefined();
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

describe("buildRouterState — flat registry (R-RT1, slice 2)", () => {
	it("keeps the last entry when two configs share an id (no pooling)", () => {
		// PooledBackend is gone: two entries sharing an id no longer merge into a
		// pool. The flat registry is last-wins, so the operator surface lists one
		// route per id and the later entry's capabilities win.
		const router = createModelRouter({
			backends: [
				{
					id: "dup",
					provider: "openai-compatible",
					apiKey: "k",
					model: "m",
					baseUrl: "http://localhost:1",
					contextWindow: 4096,
				},
				{
					id: "dup",
					provider: "cerebras",
					apiKey: "k",
					model: "m",
					contextWindow: 8192,
				},
			],
			default: "dup",
		});
		expect(router.listBackends().filter((b) => b.id === "dup")).toHaveLength(1);
		expect(router.getEffectiveCapabilities("dup")?.max_context).toBe(8192);
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
