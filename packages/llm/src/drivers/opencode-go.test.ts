import { describe, expect, it } from "bun:test";
import type { LLMBackend, ModelDescriptor, StreamChunk } from "../types";
import {
	OpenCodeGoDriver,
	classifyOpenCodeGoProtocol,
	deriveOpenCodeGoBaseUrl,
	stripOpenCodeGoModelPrefix,
} from "./opencode-go";
import { DEEPSEEK_ROW, OPENCODE_GO_LISTING } from "./opencode-go-fixtures";

/**
 * Pure helpers for the OpenCode Go driver: base-URL derivation, model-prefix
 * stripping, and protocol classification (the subscription exposes two protocol
 * surfaces behind one key, selected by model family).
 */

describe("deriveOpenCodeGoBaseUrl", () => {
	it("falls back to the default zen endpoint when no override is given", () => {
		expect(deriveOpenCodeGoBaseUrl()).toBe("https://opencode.ai/zen/go/v1");
	});

	it("uses the override verbatim when present", () => {
		expect(deriveOpenCodeGoBaseUrl("https://proxy.example/v1")).toBe("https://proxy.example/v1");
	});
});

describe("stripOpenCodeGoModelPrefix", () => {
	it("removes a leading opencode-go/ prefix", () => {
		expect(stripOpenCodeGoModelPrefix("opencode-go/glm-4.6")).toBe("glm-4.6");
	});

	it("leaves an unprefixed model id unchanged", () => {
		expect(stripOpenCodeGoModelPrefix("glm-4.6")).toBe("glm-4.6");
	});
});

describe("classifyOpenCodeGoProtocol", () => {
	it("routes minimax models to the Anthropic surface", () => {
		expect(classifyOpenCodeGoProtocol("opencode-go/minimax-m2")).toBe("anthropic");
	});

	it("routes qwen models to the Anthropic surface", () => {
		expect(classifyOpenCodeGoProtocol("qwen3-max")).toBe("anthropic");
	});

	it("routes everything else to the OpenAI-compatible surface", () => {
		expect(classifyOpenCodeGoProtocol("opencode-go/glm-4.6")).toBe("openai-compatible");
		expect(classifyOpenCodeGoProtocol("kimi-k2")).toBe("openai-compatible");
	});

	it("classifies case-insensitively", () => {
		expect(classifyOpenCodeGoProtocol("opencode-go/MiniMax-M2")).toBe("anthropic");
	});
});

// ─── Driver: discovery, protocols, namespace ────────────────────────────────

interface Captured {
	url: string;
	headers: Headers;
	body: Record<string, unknown> | undefined;
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Minimal /responses SSE the @ai-sdk/openai Responses parser accepts. */
function responsesSse(modelId: string): Response {
	const events = [
		`event: response.created\ndata: ${JSON.stringify({
			type: "response.created",
			response: { id: "resp_1", model: modelId },
		})}`,
		`event: response.completed\ndata: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_1",
				model: modelId,
				status: "completed",
				usage: {
					input_tokens: 3,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 1,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: 4,
				},
			},
		})}`,
	].join("\n\n");
	return new Response(`${events}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** Minimal /chat/completions SSE. */
function chatSse(modelId: string): Response {
	const chunks = [
		{
			id: "c1",
			object: "chat.completion.chunk",
			model: modelId,
			choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }],
		},
		{
			id: "c1",
			object: "chat.completion.chunk",
			model: modelId,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
		},
	];
	const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Minimal Anthropic /messages SSE. */
function messagesSse(modelId: string): Response {
	const events = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: modelId,
				content: [],
				stop_reason: null,
				usage: { input_tokens: 3, output_tokens: 0 },
			},
		})}`,
		`event: content_block_start\ndata: ${JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		})}`,
		`event: content_block_delta\ndata: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "hi" },
		})}`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 1 },
		})}`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
	].join("\n\n");
	return new Response(`${events}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function recordingFetch(respond: (url: string) => Response, captured: Captured[]): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const raw = init?.body;
		captured.push({
			url,
			headers: new Headers(init?.headers),
			body: typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
		});
		return respond(url);
	}) as typeof fetch;
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const out: StreamChunk[] = [];
	for await (const chunk of stream) out.push(chunk);
	return out;
}

const CHAT_PARAMS = {
	threadId: "thread-1",
	messages: [{ role: "user" as const, content: "hello" }],
};

describe("OpenCodeGoDriver.discoverModels", () => {
	it("GETs <base>/models with bearer auth + bound UA and returns routable chat models only", async () => {
		const captured: Captured[] = [];
		const driver = new OpenCodeGoDriver({
			apiKey: "sk-test",
			model: "glm-5",
			contextWindow: 1,
			fetch: recordingFetch(() => jsonResponse(OPENCODE_GO_LISTING), captured),
		});
		const models = await driver.discoverModels();
		expect(captured[0]?.url).toBe("https://opencode.ai/zen/go/v1/models");
		expect(captured[0]?.headers.get("authorization")).toBe("Bearer sk-test");
		expect(captured[0]?.headers.get("user-agent")).toBe("bound");
		expect(models.map((m) => m.providerModelId)).toEqual(["deepseek-v4.1-flash", "gpt-6-astra"]);
		expect(models[0]?.capabilities?.max_context).toBe(1_000_000);
		expect(models[0]?.pricing?.tiers?.[0]?.threshold).toBe(100_000);
	});

	it("strips a trailing slash from a baseUrl override", async () => {
		const captured: Captured[] = [];
		const driver = new OpenCodeGoDriver({
			apiKey: "k",
			model: "glm-5",
			baseUrl: "https://proxy.example/v1/",
			fetch: recordingFetch(() => jsonResponse({ data: [] }), captured),
		});
		expect(await driver.discoverModels()).toEqual([]);
		expect(captured[0]?.url).toBe("https://proxy.example/v1/models");
	});

	it("rejects on a non-2xx response", async () => {
		const driver = new OpenCodeGoDriver({
			apiKey: "k",
			model: "glm-5",
			fetch: recordingFetch(() => jsonResponse({ error: "no" }, 401), []),
		});
		await expect(driver.discoverModels()).rejects.toThrow("HTTP 401");
	});
});

describe("OpenCodeGoDriver protocols", () => {
	it("serves protocol=responses via /responses with store:false, encrypted reasoning, effort, and session header", async () => {
		const captured: Captured[] = [];
		const driver = new OpenCodeGoDriver({
			apiKey: "k",
			model: "gpt-6-astra",
			contextWindow: 1_050_000,
			protocol: "responses",
			apiBaseUrl: "https://opencode.ai/inference/go/openai/v1",
			siteId: "site-a",
			fetch: recordingFetch(() => responsesSse("gpt-6-astra"), captured),
		});
		const chunks = await drain(driver.chat({ ...CHAT_PARAMS, effort: "high" }));
		expect(chunks.some((c) => c.type === "done")).toBe(true);
		const req = captured[0];
		expect(req?.url).toBe("https://opencode.ai/inference/go/openai/v1/responses");
		expect(req?.headers.get("x-opencode-session")).toBe("thread-1");
		expect(req?.headers.get("user-agent")).toBe("bound");
		expect(req?.headers.get("authorization")).toBe("Bearer k");
		expect(req?.body?.model).toBe("gpt-6-astra");
		expect(req?.body?.store).toBe(false);
		expect(req?.body?.include).toEqual(["reasoning.encrypted_content"]);
		expect((req?.body?.reasoning as { effort?: string } | undefined)?.effort).toBe("high");
	});

	it("omits reasoning effort on Responses when params.effort is unset", async () => {
		const captured: Captured[] = [];
		const driver = new OpenCodeGoDriver({
			apiKey: "k",
			model: "gpt-6-astra",
			protocol: "responses",
			fetch: recordingFetch(() => responsesSse("gpt-6-astra"), captured),
		});
		await drain(driver.chat(CHAT_PARAMS));
		// No apiBaseUrl => the zen/go root serves the protocol.
		expect(captured[0]?.url).toBe("https://opencode.ai/zen/go/v1/responses");
		expect(
			(captured[0]?.body?.reasoning as { effort?: string } | undefined)?.effort,
		).toBeUndefined();
	});

	it("serves protocol=chat-completions on the published apiBaseUrl", async () => {
		const captured: Captured[] = [];
		const driver = new OpenCodeGoDriver({
			apiKey: "k",
			model: "deepseek-v4.1-flash",
			protocol: "chat-completions",
			apiBaseUrl: "https://opencode.ai/inference/go/openai/v1",
			fetch: recordingFetch(() => chatSse("deepseek-v4.1-flash"), captured),
		});
		await drain(driver.chat(CHAT_PARAMS));
		expect(captured[0]?.url).toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
		expect(captured[0]?.headers.get("x-opencode-session")).toBe("thread-1");
	});

	it("serves protocol=messages on the published apiBaseUrl even for a non-qwen/minimax id", async () => {
		const captured: Captured[] = [];
		const driver = new OpenCodeGoDriver({
			apiKey: "k",
			model: "glm-5",
			protocol: "messages",
			apiBaseUrl: "https://opencode.ai/inference/go/anthropic/v1",
			fetch: recordingFetch(() => messagesSse("glm-5"), captured),
		});
		await drain(driver.chat(CHAT_PARAMS));
		expect(captured[0]?.url).toBe("https://opencode.ai/inference/go/anthropic/v1/messages");
	});

	it("keeps static-config behavior: no protocol => family classification on the zen/go root", async () => {
		const captured: Captured[] = [];
		const driver = new OpenCodeGoDriver({
			apiKey: "k",
			model: "opencode-go/minimax-m3",
			contextWindow: 1_000_000,
			fetch: recordingFetch(
				(url) => (url.endsWith("/messages") ? messagesSse("minimax-m3") : chatSse("glm-5")),
				captured,
			),
		});
		await drain(driver.chat(CHAT_PARAMS));
		await drain(driver.chat({ ...CHAT_PARAMS, model: "glm-5" }));
		expect(captured.map((c) => c.url)).toEqual([
			"https://opencode.ai/zen/go/v1/messages",
			"https://opencode.ai/zen/go/v1/chat/completions",
		]);
		expect(captured[0]?.body?.model).toBe("minimax-m3");
		expect(driver.capabilities().max_context).toBe(1_000_000);
	});

	it("still rejects a missing threadId", async () => {
		const driver = new OpenCodeGoDriver({ apiKey: "k", model: "glm-5", contextWindow: 1 });
		await expect(drain(driver.chat({ messages: CHAT_PARAMS.messages }))).rejects.toThrow(
			"non-empty Bound threadId",
		);
	});
});

describe("OpenCodeGoDriver namespace mode", () => {
	type Registered = Array<{ descriptor: ModelDescriptor; backend: LLMBackend }>;

	function captureRegistrar() {
		const calls: Array<{ providerId: string; models: Registered }> = [];
		let resolveFirst: () => void = () => {};
		const first = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		return {
			calls,
			first,
			registrar: {
				register(providerId: string, models: Registered) {
					calls.push({ providerId, models });
					resolveFirst();
				},
			},
		};
	}

	it("has readiness only when constructed without a model", () => {
		expect(new OpenCodeGoDriver({ apiKey: "k", model: "glm-5" }).readiness).toBeUndefined();
		const ns = new OpenCodeGoDriver({ apiKey: "k", namespaceId: "ocg" });
		expect(ns.readiness?.isReady()).toBe(false);
		ns.readiness?.dispose();
	});

	it("throws a clear guard error when the namespace placeholder is invoked", async () => {
		const ns = new OpenCodeGoDriver({ apiKey: "k", namespaceId: "ocg" });
		await expect(drain(ns.chat(CHAT_PARAMS))).rejects.toThrow("not directly invokable");
	});

	it("expands routable chat models into per-model backends with discovered metadata + overrides", async () => {
		const captured: Captured[] = [];
		const ns = new OpenCodeGoDriver({
			apiKey: "k",
			namespaceId: "ocg",
			siteId: "site-a",
			modelOverrides: {
				"gpt-6-astra": { logicalModel: "astra", contextWindow: 400_000, maxOutputTokens: 64_000 },
			},
			fetch: recordingFetch(
				(url) =>
					url.endsWith("/models") ? jsonResponse(OPENCODE_GO_LISTING) : responsesSse("gpt-6-astra"),
				captured,
			),
		});
		const { calls, first, registrar } = captureRegistrar();
		ns.readiness?.start(registrar);
		await first;
		expect(ns.readiness?.isReady()).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.providerId).toBe("ocg");
		const models = calls[0]?.models ?? [];
		expect(models.map((m) => m.descriptor.id)).toEqual([
			"ocg-deepseek-v4.1-flash",
			"ocg-gpt-6-astra",
		]);

		const deepseek = models[0]?.descriptor;
		expect(deepseek?.providerModelId).toBe("deepseek-v4.1-flash");
		expect(deepseek?.discovered?.displayName).toBe("DeepSeek V4.1 Flash 1017");
		expect(deepseek?.maxOutputTokens).toBe(384_000);
		expect(deepseek?.capabilities).toMatchObject({
			tool_use: true,
			vision: true,
			extended_thinking: true,
			max_context: 1_000_000,
		});

		const astra = models[1]?.descriptor;
		expect(astra?.logicalModel).toBe("astra");
		expect(astra?.maxOutputTokens).toBe(64_000);
		expect(astra?.capabilities.max_context).toBe(400_000);

		// The expanded backend is a concrete driver on the entry's protocol + base URL.
		const backend = models[1]?.backend;
		expect(backend).toBeInstanceOf(OpenCodeGoDriver);
		expect(backend?.capabilities().max_context).toBe(400_000);
		await drain(backend?.chat(CHAT_PARAMS) ?? (async function* () {})());
		expect(captured.at(-1)?.url).toBe("https://opencode.ai/inference/go/openai/v1/responses");
		ns.readiness?.dispose();
	});

	it("retries with backoff after a failed and an empty fetch", async () => {
		let calls = 0;
		const ns = new OpenCodeGoDriver({
			apiKey: "k",
			namespaceId: "ocg",
			lineupRetryBaseMs: 1,
			lineupRetryMaxMs: 2,
			fetch: (async () => {
				calls++;
				if (calls === 1) return jsonResponse({ error: "down" }, 503);
				if (calls === 2) return jsonResponse({ data: [] });
				return jsonResponse({ data: [DEEPSEEK_ROW] });
			}) as unknown as typeof fetch,
		});
		const { calls: registered, first, registrar } = captureRegistrar();
		ns.readiness?.start(registrar);
		await first;
		expect(calls).toBe(3);
		expect(registered[0]?.models.map((m) => m.descriptor.id)).toEqual(["ocg-deepseek-v4.1-flash"]);
		ns.readiness?.dispose();
	});

	it("never registers once disposed, and aborts the in-flight fetch", async () => {
		let release: (r: Response) => void = () => {};
		let seenSignal: AbortSignal | undefined;
		const ns = new OpenCodeGoDriver({
			apiKey: "k",
			namespaceId: "ocg",
			fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
				seenSignal = init?.signal ?? undefined;
				return new Promise<Response>((resolve) => {
					release = resolve;
				});
			}) as unknown as typeof fetch,
		});
		const { calls, registrar } = captureRegistrar();
		ns.readiness?.start(registrar);
		await Promise.resolve();
		ns.readiness?.dispose();
		expect(seenSignal?.aborted).toBe(true);
		release(jsonResponse(OPENCODE_GO_LISTING));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls).toHaveLength(0);
		expect(ns.readiness?.isReady()).toBe(false);
	});
});
