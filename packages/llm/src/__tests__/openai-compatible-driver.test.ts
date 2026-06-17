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
