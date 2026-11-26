import { describe, expect, it } from "bun:test";
import { OpenCodeGoDriver } from "../drivers/opencode-go";
import type { StreamChunk } from "../types";

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
	for await (const _ of stream) {
		// Consume the stream so the injected fetch runs.
	}
}

function openAiSse(): Response {
	return new Response(
		'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n' +
			'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
			"data: [DONE]\n\n",
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function emptyOpenAiSse(): Response {
	return new Response(
		'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
			"data: [DONE]\n\n",
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function anthropicSse(): Response {
	return new Response(
		`${[
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"qwen-test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
			'event: message_stop\ndata: {"type":"message_stop"}',
		].join("\n\n")}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

async function captureHeaders(model: string, response: () => Response): Promise<Headers> {
	let request: Request | undefined;
	const driver = new OpenCodeGoDriver({
		apiKey: "test-key",
		model,
		contextWindow: 128_000,
		baseUrl: "https://example.test/v1",
		fetch: async (input, init) => {
			request = new Request(input as RequestInfo, init);
			return response();
		},
	});

	await drain(
		driver.chat({
			threadId: "thread-123",
			messages: [{ role: "user", content: "hello" }],
		}),
	);
	if (!request) throw new Error("provider did not issue a request");
	return request.headers;
}

describe("OpenCodeGoDriver request identity", () => {
	it("sends exact identity and preserves authentication on the OpenAI-compatible surface", async () => {
		const headers = await captureHeaders("glm-test", openAiSse);
		expect(headers.get("user-agent")).toBe("bound");
		expect(headers.get("x-opencode-session")).toBe("thread-123");
		expect(headers.get("authorization")).toBe("Bearer test-key");
		expect([...headers.keys()]).toContain("x-opencode-session");
	});

	it("sends exact identity and preserves authentication on the Anthropic surface", async () => {
		const headers = await captureHeaders("qwen-test", anthropicSse);
		expect(headers.get("user-agent")).toBe("bound");
		expect(headers.get("x-opencode-session")).toBe("thread-123");
		expect(headers.get("x-api-key")).toBe("test-key");
		expect([...headers.keys()]).toContain("x-opencode-session");
	});

	it("refuses to issue a provider request without a Bound thread id", async () => {
		let requested = false;
		const driver = new OpenCodeGoDriver({
			apiKey: "test-key",
			model: "glm-test",
			contextWindow: 128_000,
			baseUrl: "https://example.test/v1",
			fetch: async () => {
				requested = true;
				return openAiSse();
			},
		});

		expect(drain(driver.chat({ messages: [{ role: "user", content: "hello" }] }))).rejects.toThrow(
			"OpenCode Go requests require a non-empty Bound threadId of at most 256 characters",
		);
		expect(requested).toBe(false);
	});

	it("rejects an oversized session id before issuing a provider request", async () => {
		let requested = false;
		const driver = new OpenCodeGoDriver({
			apiKey: "test-key",
			model: "glm-test",
			contextWindow: 128_000,
			baseUrl: "https://example.test/v1",
			fetch: async () => {
				requested = true;
				return openAiSse();
			},
		});

		expect(
			drain(
				driver.chat({
					threadId: "x".repeat(257),
					messages: [{ role: "user", content: "hello" }],
				}),
			),
		).rejects.toThrow("at most 256 characters");
		expect(requested).toBe(false);
	});

	it("reuses the same exact identity headers on empty-completion retry", async () => {
		const requests: Request[] = [];
		const driver = new OpenCodeGoDriver({
			apiKey: "test-key",
			model: "glm-test",
			contextWindow: 128_000,
			baseUrl: "https://example.test/v1",
			fetch: async (input, init) => {
				requests.push(new Request(input as RequestInfo, init));
				return requests.length === 1 ? emptyOpenAiSse() : openAiSse();
			},
		});

		await drain(
			driver.chat({
				threadId: "thread-retry",
				messages: [{ role: "user", content: "hello" }],
			}),
		);
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request.headers.get("user-agent")).toBe("bound");
			expect(request.headers.get("x-opencode-session")).toBe("thread-retry");
		}
	});
});

describe("OpenCodeGoDriver tool-result media", () => {
	it("sends a tool-result image as a text placeholder on the chat-completions leg", async () => {
		const imageData = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MjQyNDI=";
		let body: { messages: Array<{ role: string; content: unknown }> } | undefined;
		const driver = new OpenCodeGoDriver({
			apiKey: "test-key",
			model: "glm-test",
			contextWindow: 128_000,
			baseUrl: "https://example.test/v1",
			fetch: async (_input, init) => {
				body = JSON.parse(String(init?.body));
				return openAiSse();
			},
		});

		await drain(
			driver.chat({
				threadId: "thread-321",
				messages: [
					{ role: "user", content: "look" },
					{
						role: "tool_call",
						content: [{ type: "tool_use", id: "c1", name: "read", input: { path: "a.png" } }],
					},
					{
						role: "tool_result",
						tool_use_id: "c1",
						content: [
							{ type: "text", text: "before" },
							{
								type: "image",
								source: { type: "base64", media_type: "image/png", data: imageData },
							},
							{ type: "text", text: "after" },
						],
					},
				],
			}),
		);

		const tool = body?.messages.find((m) => m.role === "tool");
		const content = tool?.content as string;
		expect(content).toContain("[Image omitted: file_id=(inline) media_type=image/png");
		expect(content).toContain("before");
		expect(content).toContain("after");
		expect(JSON.stringify(body)).not.toContain(imageData);
	});
});
