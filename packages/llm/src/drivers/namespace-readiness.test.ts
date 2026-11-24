import { describe, expect, it } from "bun:test";
import type { DiscoveredModel } from "../catalog/discovery";
import type { LLMBackend, ModelDescriptor, ModelRegistrar } from "../types";
import { LLMError } from "../types";
import { AnthropicDriver } from "./anthropic";
import { ChatGptOAuthDriver } from "./chatgpt-oauth/driver";
import type { TokenManager } from "./chatgpt-oauth/token-store";
import {
	NamespaceLineupReadiness,
	buildNamespaceDescriptor,
	lineupFromDiscovered,
} from "./namespace-readiness";
import { OpenAICompatibleDriver } from "./openai-compatible";

type Registered = Array<{ descriptor: ModelDescriptor; backend: LLMBackend }>;

function captureRegistrar() {
	const calls: Array<{ providerId: string; models: Registered }> = [];
	let resolveFirst: () => void = () => {};
	const first = new Promise<void>((resolve) => {
		resolveFirst = resolve;
	});
	const registrar: ModelRegistrar = {
		register(providerId, models) {
			calls.push({ providerId, models });
			resolveFirst();
		},
	};
	return { calls, first, registrar };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of iterable) {
		// drain
	}
}

const tokenManager = {
	getAccessToken: async () => ({ accessToken: "access-token", accountId: "acct_123" }),
	forceRefresh: async () => true,
} as unknown as TokenManager;

describe("buildNamespaceDescriptor", () => {
	const discovered: DiscoveredModel = {
		providerModelId: "m1",
		capabilities: {
			vision: true,
			max_context: 200_000,
			reasoning: { supported: true, effort_values: ["low", "high"] },
		},
		maxOutputTokens: 64_000,
	};

	it("maps discovery metadata onto the expanded descriptor", () => {
		expect(
			buildNamespaceDescriptor({ namespaceId: "ns", entry: { id: "m1", discovered } }),
		).toEqual({
			id: "ns-m1",
			providerModelId: "m1",
			discovered,
			capabilities: {
				streaming: true,
				tool_use: true,
				system_prompt: true,
				prompt_caching: false,
				vision: true,
				extended_thinking: true,
				max_context: 200_000,
			},
			maxOutputTokens: 64_000,
		});
	});

	it("applies per-model overrides ahead of discovery and the caching default", () => {
		const descriptor = buildNamespaceDescriptor({
			namespaceId: "ns",
			entry: { id: "m1", discovered },
			override: {
				contextWindow: 100_000,
				promptCaching: false,
				logicalModel: "big",
				maxOutputTokens: 8000,
			},
			defaultPromptCaching: true,
		});
		expect(descriptor.capabilities.max_context).toBe(100_000);
		expect(descriptor.capabilities.prompt_caching).toBe(false);
		expect(descriptor.logicalModel).toBe("big");
		expect(descriptor.maxOutputTokens).toBe(8000);
	});

	it("omits max_context and maxOutputTokens when nothing publishes them", () => {
		const descriptor = buildNamespaceDescriptor({
			namespaceId: "ns",
			entry: { id: "bare", discovered: { providerModelId: "bare" } },
			defaultPromptCaching: true,
		});
		expect(descriptor.capabilities.max_context).toBeUndefined();
		expect(descriptor.capabilities.prompt_caching).toBe(true);
		expect(descriptor.capabilities.vision).toBe(false);
		expect("maxOutputTokens" in descriptor).toBe(false);
		expect("logicalModel" in descriptor).toBe(false);
	});
});

describe("lineupFromDiscovered", () => {
	it("keys entries by provider model id and drops empty ids", () => {
		const rows: DiscoveredModel[] = [{ providerModelId: "a" }, { providerModelId: "" }];
		expect(lineupFromDiscovered(rows)).toEqual([{ id: "a", discovered: rows[0] }]);
	});
});

describe("NamespaceLineupReadiness", () => {
	const stubBackend = {} as LLMBackend;

	it("retries a failed then empty fetch with backoff and registers once populated", async () => {
		let calls = 0;
		const readiness = new NamespaceLineupReadiness({
			providerName: "p",
			namespaceId: "ns",
			retryBaseMs: 1,
			retryMaxMs: 2,
			loadLineup: async () => {
				calls++;
				if (calls === 1) throw new Error("boom");
				if (calls === 2) return [];
				return [{ id: "m", discovered: { providerModelId: "m" } }];
			},
			buildPerModelBackend: () => stubBackend,
		});
		const { calls: registered, first, registrar } = captureRegistrar();
		readiness.start(registrar);
		await first;
		expect(calls).toBe(3);
		expect(readiness.isReady()).toBe(true);
		expect(registered).toHaveLength(1);
		expect(registered[0]?.providerId).toBe("ns");
		expect(registered[0]?.models[0]?.descriptor.id).toBe("ns-m");
		expect(registered[0]?.models[0]?.backend).toBe(stubBackend);
	});

	it("passes the resolved context window to the per-model builder", async () => {
		const windows: number[] = [];
		const readiness = new NamespaceLineupReadiness({
			providerName: "p",
			namespaceId: "ns",
			modelOverrides: { b: { contextWindow: 9000 } },
			loadLineup: async () => [
				{ id: "a", discovered: { providerModelId: "a", capabilities: { max_context: 5000 } } },
				{ id: "b", discovered: { providerModelId: "b" } },
				{ id: "c", discovered: { providerModelId: "c" } },
			],
			buildPerModelBackend: (_entry, contextWindow) => {
				windows.push(contextWindow);
				return stubBackend;
			},
		});
		const { first, registrar } = captureRegistrar();
		readiness.start(registrar);
		await first;
		expect(windows).toEqual([5000, 9000, 0]);
	});

	it("never registers when disposed while the fetch is in flight", async () => {
		let release: (value: Array<{ id: string; discovered: DiscoveredModel }>) => void = () => {};
		let sawSignal: AbortSignal | undefined;
		const readiness = new NamespaceLineupReadiness({
			providerName: "p",
			namespaceId: "ns",
			loadLineup: (signal) => {
				sawSignal = signal;
				return new Promise((resolve) => {
					release = resolve;
				});
			},
			buildPerModelBackend: () => stubBackend,
		});
		const { calls, registrar } = captureRegistrar();
		readiness.start(registrar);
		readiness.dispose();
		expect(sawSignal?.aborted).toBe(true);
		release([{ id: "m", discovered: { providerModelId: "m" } }]);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(calls).toHaveLength(0);
		expect(readiness.isReady()).toBe(false);
	});

	it("stops retrying once disposed during backoff", async () => {
		let calls = 0;
		const readiness = new NamespaceLineupReadiness({
			providerName: "p",
			namespaceId: "ns",
			retryBaseMs: 1,
			retryMaxMs: 1,
			loadLineup: async () => {
				calls++;
				return [];
			},
			buildPerModelBackend: () => stubBackend,
		});
		const { calls: registered, registrar } = captureRegistrar();
		readiness.start(registrar);
		await new Promise((resolve) => setTimeout(resolve, 5));
		readiness.dispose();
		const seen = calls;
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls).toBeLessThanOrEqual(seen + 1);
		expect(registered).toHaveLength(0);
	});
});

const CODEX_MODELS = {
	models: [
		{
			slug: "gpt-6.2-sol",
			display_name: "GPT-6.2 Sol",
			visibility: "list",
			supported_in_api: true,
			context_window: 1_050_000,
			input_modalities: ["text", "image"],
			supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
		},
		{ slug: "gpt-6-luna", visibility: "list", context_window: 400_000 },
		{ slug: "codex-auto-review", visibility: "hide" },
	],
};

describe("ChatGptOAuthDriver discovery", () => {
	it("queries the Codex /models inventory with OAuth headers and client_version", async () => {
		let seen: Request | undefined;
		const driver = new ChatGptOAuthDriver({
			tokenManager,
			model: "gpt-6-astra",
			contextWindow: 1000,
			fetch: async (input, init) => {
				seen = new Request(input as RequestInfo, init);
				return jsonResponse(CODEX_MODELS);
			},
		});
		const models = await driver.discoverModels();
		expect(seen?.url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.0.0");
		expect(seen?.headers.get("authorization")).toBe("Bearer access-token");
		expect(seen?.headers.get("chatgpt-account-id")).toBe("acct_123");
		expect(seen?.headers.get("accept")).toBe("application/json");
		expect(models.map((m) => m.providerModelId)).toEqual(["gpt-6.2-sol", "gpt-6-luna"]);
	});

	it("throws an LLMError on a non-OK inventory response", async () => {
		const driver = new ChatGptOAuthDriver({
			tokenManager,
			model: "gpt-6-astra",
			fetch: async () => jsonResponse({ detail: "nope" }, 403),
		});
		await expect(driver.discoverModels()).rejects.toThrow(
			"chatgpt-oauth model discovery failed: HTTP 403",
		);
	});
});

describe("ChatGptOAuthDriver namespace mode", () => {
	it("has readiness only when constructed without a model", () => {
		expect(new ChatGptOAuthDriver({ tokenManager, model: "m" }).readiness).toBeUndefined();
		const ns = new ChatGptOAuthDriver({ tokenManager });
		expect(ns.readiness?.isReady()).toBe(false);
		ns.readiness?.dispose();
	});

	it("refuses to serve inference as a namespace placeholder", async () => {
		const ns = new ChatGptOAuthDriver({ tokenManager });
		const error = await drain(ns.chat({ messages: [{ role: "user", content: "hi" }] })).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(LLMError);
		expect((error as Error).message).toContain("namespace backend is not directly invokable");
		ns.readiness?.dispose();
	});

	it("expands the listed lineup into concrete backends sharing the TokenManager", async () => {
		const ns = new ChatGptOAuthDriver({
			tokenManager,
			namespaceId: "codex",
			modelOverrides: { "gpt-6-luna": { logicalModel: "luna", maxOutputTokens: 32_000 } },
			fetch: async () => jsonResponse(CODEX_MODELS),
		});
		const { calls, first, registrar } = captureRegistrar();
		ns.readiness?.start(registrar);
		await first;
		expect(ns.readiness?.isReady()).toBe(true);
		expect(calls[0]?.providerId).toBe("codex");
		const models = calls[0]?.models ?? [];
		expect(models.map((m) => m.descriptor.id)).toEqual(["codex-gpt-6.2-sol", "codex-gpt-6-luna"]);

		const sol = models[0];
		expect(sol?.descriptor.providerModelId).toBe("gpt-6.2-sol");
		expect(sol?.descriptor.discovered?.displayName).toBe("GPT-6.2 Sol");
		expect(sol?.descriptor.capabilities).toEqual({
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: true,
			extended_thinking: true,
			max_context: 1_050_000,
		});
		expect(sol?.backend).toBeInstanceOf(ChatGptOAuthDriver);
		expect(sol?.backend.capabilities().max_context).toBe(1_050_000);
		expect((sol?.backend as ChatGptOAuthDriver).readiness).toBeUndefined();
		expect((sol?.backend as unknown as { tokenManager: unknown }).tokenManager).toBe(tokenManager);

		const luna = models[1];
		expect(luna?.descriptor.logicalModel).toBe("luna");
		expect(luna?.descriptor.maxOutputTokens).toBe(32_000);
		expect(luna?.descriptor.capabilities.vision).toBe(false);
		expect(luna?.descriptor.capabilities.extended_thinking).toBe(false);
	});
});

describe("OpenAICompatibleDriver namespace mode", () => {
	const base = { baseUrl: "https://api.example.test/v1", apiKey: "k" };

	it("has readiness only when constructed without a model", () => {
		expect(new OpenAICompatibleDriver({ ...base, model: "m" }).readiness).toBeUndefined();
		const ns = new OpenAICompatibleDriver(base);
		expect(ns.readiness?.isReady()).toBe(false);
		ns.readiness?.dispose();
	});

	it("refuses to serve inference as a namespace placeholder", async () => {
		const ns = new OpenAICompatibleDriver({ ...base, providerName: "cerebras" });
		const error = await drain(ns.chat({ messages: [{ role: "user", content: "hi" }] })).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(LLMError);
		expect((error as Error).message).toContain("cerebras namespace backend");
		ns.readiness?.dispose();
	});

	it("expands /models into concrete backends carrying the namespace's endpoint", async () => {
		const urls: string[] = [];
		const ns = new OpenAICompatibleDriver({
			...base,
			providerName: "zai",
			namespaceId: "z",
			additionalHeaders: { "x-extra": "1" },
			modelOverrides: { "glm-5": { contextWindow: 200_000, promptCaching: true } },
			fetch: async (input) => {
				urls.push(String(input));
				return jsonResponse({ object: "list", data: [{ id: "glm-5" }, { id: "glm-5-air" }] });
			},
		});
		const { calls, first, registrar } = captureRegistrar();
		ns.readiness?.start(registrar);
		await first;
		expect(urls).toEqual(["https://api.example.test/v1/models"]);
		const models = calls[0]?.models ?? [];
		expect(calls[0]?.providerId).toBe("z");
		expect(models.map((m) => m.descriptor.id)).toEqual(["z-glm-5", "z-glm-5-air"]);
		expect(models[0]?.descriptor.providerModelId).toBe("glm-5");
		expect(models[0]?.descriptor.discovered?.providerModelId).toBe("glm-5");
		expect(models[0]?.descriptor.capabilities.max_context).toBe(200_000);
		expect(models[0]?.descriptor.capabilities.prompt_caching).toBe(true);
		expect(models[1]?.descriptor.capabilities.prompt_caching).toBe(false);
		expect(models[0]?.backend).toBeInstanceOf(OpenAICompatibleDriver);
		expect(models[0]?.backend.capabilities().max_context).toBe(200_000);
		expect(models[1]?.backend.capabilities().max_context).toBe(0);
		expect((models[0]?.backend as OpenAICompatibleDriver).readiness).toBeUndefined();
	});
});

describe("AnthropicDriver namespace mode", () => {
	it("has readiness only when constructed without a model", () => {
		expect(new AnthropicDriver({ apiKey: "k", model: "claude" }).readiness).toBeUndefined();
		const ns = new AnthropicDriver({ apiKey: "k" });
		expect(ns.readiness?.isReady()).toBe(false);
		ns.readiness?.dispose();
	});

	it("refuses to serve inference as a namespace placeholder", async () => {
		const ns = new AnthropicDriver({ apiKey: "k" });
		const error = await drain(ns.chat({ messages: [{ role: "user", content: "hi" }] })).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(LLMError);
		expect((error as Error).message).toContain("anthropic namespace backend");
		ns.readiness?.dispose();
	});

	it("expands /v1/models into concrete backends with prompt caching on", async () => {
		const urls: string[] = [];
		const ns = new AnthropicDriver({
			apiKey: "k",
			baseUrl: "https://anthropic.example.test/v1",
			namespaceId: "claude",
			fetch: async (input) => {
				urls.push(String(input));
				return jsonResponse({
					data: [
						{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
						{ type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" },
					],
					has_more: false,
				});
			},
		});
		const { calls, first, registrar } = captureRegistrar();
		ns.readiness?.start(registrar);
		await first;
		expect(urls).toEqual(["https://anthropic.example.test/v1/models"]);
		const models = calls[0]?.models ?? [];
		expect(calls[0]?.providerId).toBe("claude");
		expect(models.map((m) => m.descriptor.id)).toEqual([
			"claude-claude-opus-5-5",
			"claude-claude-haiku-5-5",
		]);
		expect(models[0]?.descriptor.providerModelId).toBe("claude-opus-5-5");
		expect(models[0]?.descriptor.discovered?.providerModelId).toBe("claude-opus-5-5");
		expect(models[0]?.descriptor.capabilities.prompt_caching).toBe(true);
		expect(models[0]?.backend).toBeInstanceOf(AnthropicDriver);
		expect((models[0]?.backend as AnthropicDriver).readiness).toBeUndefined();
	});
});
