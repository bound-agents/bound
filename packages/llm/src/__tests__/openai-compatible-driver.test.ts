import { describe, expect, it } from "bun:test";
import { OpenAICompatibleDriver } from "../openai-compatible-driver";
import type { ChatParams, StreamChunk } from "../types";

// A minimal OpenAI-compatible /chat/completions SSE body: one content delta,
// a stop, then the [DONE] sentinel. Enough for the AI SDK to assemble a clean
// stream so chat() runs to completion without throwing.
function sseResponse(): Response {
	const body =
		'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\n' +
		'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
		"data: [DONE]\n\n";
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function drain(it: AsyncIterable<StreamChunk>): Promise<void> {
	for await (const _ of it) {
		// consume — we only care about the captured request
	}
}

const baseParams: ChatParams = {
	model: "test-model",
	messages: [{ role: "user", content: "hello" }],
};

describe("OpenAICompatibleDriver custom headers", () => {
	it("forwards additionalHeaders onto the outgoing request", async () => {
		let seen: Request | undefined;
		const captureFetch: typeof fetch = async (input, init) => {
			seen = new Request(input as RequestInfo, init);
			return sseResponse();
		};

		const driver = new OpenAICompatibleDriver({
			baseUrl: "https://example.test/v1",
			apiKey: "sk-test",
			model: "test-model",
			contextWindow: 8192,
			additionalHeaders: {
				"X-Custom-Header": "custom-value",
				"X-Org-Id": "org-42",
			},
			fetch: captureFetch,
		});

		await drain(driver.chat(baseParams));

		expect(seen).toBeDefined();
		expect(seen?.headers.get("X-Custom-Header")).toBe("custom-value");
		expect(seen?.headers.get("X-Org-Id")).toBe("org-42");
		// The apiKey-derived Authorization header must still be present.
		expect(seen?.headers.get("authorization")).toBe("Bearer sk-test");
	});

	it("omits additionalHeaders cleanly when none are configured", async () => {
		let seen: Request | undefined;
		const captureFetch: typeof fetch = async (input, init) => {
			seen = new Request(input as RequestInfo, init);
			return sseResponse();
		};

		const driver = new OpenAICompatibleDriver({
			baseUrl: "https://example.test/v1",
			apiKey: "sk-test",
			model: "test-model",
			contextWindow: 8192,
			fetch: captureFetch,
		});

		await drain(driver.chat(baseParams));

		expect(seen).toBeDefined();
		expect(seen?.headers.get("X-Custom-Header")).toBeNull();
		expect(seen?.headers.get("authorization")).toBe("Bearer sk-test");
	});
});

describe("OpenAICompatibleDriver reasoning effort", () => {
	it("threads params.effort into reasoning_effort on the wire body", async () => {
		let seenBody: Record<string, unknown> | undefined;
		const captureFetch: typeof fetch = async (_input, init) => {
			seenBody = init?.body ? JSON.parse(init.body as string) : undefined;
			return sseResponse();
		};

		const driver = new OpenAICompatibleDriver({
			baseUrl: "https://example.test/v1",
			apiKey: "sk-test",
			model: "test-model",
			contextWindow: 8192,
			providerName: "zai",
			fetch: captureFetch,
		});

		await drain(driver.chat({ ...baseParams, effort: "high" }));

		expect(seenBody).toBeDefined();
		expect(seenBody?.reasoning_effort).toBe("high");
	});

	it("passes 'max' straight through — z.ai supports it natively, unlike the mantle path", async () => {
		let seenBody: Record<string, unknown> | undefined;
		const captureFetch: typeof fetch = async (_input, init) => {
			seenBody = init?.body ? JSON.parse(init.body as string) : undefined;
			return sseResponse();
		};

		const driver = new OpenAICompatibleDriver({
			baseUrl: "https://example.test/v1",
			apiKey: "sk-test",
			model: "test-model",
			contextWindow: 8192,
			providerName: "zai",
			fetch: captureFetch,
		});

		await drain(driver.chat({ ...baseParams, effort: "max" }));

		expect(seenBody).toBeDefined();
		expect(seenBody?.reasoning_effort).toBe("max");
	});

	it("omits reasoning_effort entirely when effort is unset", async () => {
		let seenBody: Record<string, unknown> | undefined;
		const captureFetch: typeof fetch = async (_input, init) => {
			seenBody = init?.body ? JSON.parse(init.body as string) : undefined;
			return sseResponse();
		};

		const driver = new OpenAICompatibleDriver({
			baseUrl: "https://example.test/v1",
			apiKey: "sk-test",
			model: "test-model",
			contextWindow: 8192,
			providerName: "zai",
			fetch: captureFetch,
		});

		await drain(driver.chat(baseParams));

		expect(seenBody).toBeDefined();
		expect("reasoning_effort" in (seenBody ?? {})).toBe(false);
	});
});
