import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { AnthropicDriver } from "../anthropic-driver";
import { BedrockDriver } from "../bedrock-driver";
import { OllamaDriver } from "../ollama-driver";
import { OpenAICompatibleDriver } from "../openai-driver";
import type { BackendCapabilities, ChatParams, StreamChunk } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBedrockStream(events: Record<string, unknown>[]) {
	return {
		stream: (async function* () {
			for (const event of events) {
				yield event;
			}
		})(),
	};
}

async function collectChunks(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = [];
	for await (const c of iter) {
		chunks.push(c);
	}
	return chunks;
}

// ---------------------------------------------------------------------------
// Type-level tests
// ---------------------------------------------------------------------------

describe("Extended thinking types", () => {
	it("StreamChunk includes thinking type in union", () => {
		const chunk: StreamChunk = { type: "thinking", content: "Let me reason about this..." };
		expect(chunk.type).toBe("thinking");
		expect(chunk.content).toBe("Let me reason about this...");
	});

	it("ChatParams accepts thinking configuration", () => {
		const params: ChatParams = {
			messages: [{ role: "user", content: "Hello" }],
			thinking: {
				type: "enabled",
				budget_tokens: 10000,
			},
		};
		expect(params.thinking).toBeDefined();
		expect(params.thinking?.type).toBe("enabled");
		expect(params.thinking?.budget_tokens).toBe(10000);
	});

	it("ChatParams.thinking is optional", () => {
		const params: ChatParams = {
			messages: [{ role: "user", content: "Hello" }],
		};
		expect(params.thinking).toBeUndefined();
	});

	it("BackendCapabilities includes extended_thinking field", () => {
		const caps: BackendCapabilities = {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: true,
			max_context: 200000,
			extended_thinking: true,
		};
		expect(caps.extended_thinking).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Anthropic driver — thinking integration
// ---------------------------------------------------------------------------

describe("AnthropicDriver extended thinking", () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		global.fetch = originalFetch;
	});

	afterAll(() => {
		global.fetch = originalFetch;
	});

	it("includes thinking parameter in request body when thinking is set", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-sonnet-4-20250514",
			contextWindow: 200000,
		});

		let requestBody: string | null = null;

		global.fetch = (async (_url: string, options: RequestInit) => {
			requestBody = options.body as string;
			return new Response("data: {}", {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		for await (const _ of driver.chat({
			messages: [{ role: "user", content: "Think carefully about this" }],
			thinking: { type: "enabled", budget_tokens: 10000 },
		})) {
			// drain
		}

		expect(requestBody).not.toBeNull();
		const request = JSON.parse(requestBody as string);
		expect(request.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
	});

	it("omits temperature from request when thinking is enabled", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-sonnet-4-20250514",
			contextWindow: 200000,
		});

		let requestBody: string | null = null;

		global.fetch = (async (_url: string, options: RequestInit) => {
			requestBody = options.body as string;
			return new Response("data: {}", {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		for await (const _ of driver.chat({
			messages: [{ role: "user", content: "Hello" }],
			thinking: { type: "enabled", budget_tokens: 5000 },
			temperature: 0.7,
		})) {
			// drain
		}

		expect(requestBody).not.toBeNull();
		const request = JSON.parse(requestBody as string);
		// Temperature must be omitted when thinking is enabled
		expect(request.temperature).toBeUndefined();
		expect(request.thinking).toBeDefined();
	});

	it("does not include thinking in request when not set", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-sonnet-4-20250514",
			contextWindow: 200000,
		});

		let requestBody: string | null = null;

		global.fetch = (async (_url: string, options: RequestInit) => {
			requestBody = options.body as string;
			return new Response("data: {}", {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		for await (const _ of driver.chat({
			messages: [{ role: "user", content: "Hello" }],
		})) {
			// drain
		}

		const request = JSON.parse(requestBody as string);
		expect(request.thinking).toBeUndefined();
	});

	it("parses thinking SSE events into thinking StreamChunks", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-sonnet-4-20250514",
			contextWindow: 200000,
		});

		// Simulate Anthropic SSE stream with thinking blocks
		const sseResponse = `data: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg-123",
				type: "message",
				role: "assistant",
				content: [],
				usage: { input_tokens: 50, output_tokens: 0 },
			},
		})}

data: ${JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "thinking" },
		})}

data: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: "Let me analyze" },
		})}

data: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: " this problem carefully" },
		})}

data: ${JSON.stringify({
			type: "content_block_stop",
			index: 0,
		})}

data: ${JSON.stringify({
			type: "content_block_start",
			index: 1,
			content_block: { type: "text" },
		})}

data: ${JSON.stringify({
			type: "content_block_delta",
			index: 1,
			delta: { type: "text_delta", text: "Here is my answer" },
		})}

data: ${JSON.stringify({
			type: "content_block_stop",
			index: 1,
		})}

data: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 30 },
		})}

data: ${JSON.stringify({
			type: "message_stop",
		})}
`;

		global.fetch = (async () => {
			return new Response(sseResponse, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		for await (const chunk of driver.chat({
			messages: [{ role: "user", content: "Think about this" }],
			thinking: { type: "enabled", budget_tokens: 10000 },
		})) {
			chunks.push(chunk);
		}

		// Should have thinking chunks, text chunks, and done
		const thinkingChunks = chunks.filter((c) => c.type === "thinking");
		expect(thinkingChunks.length).toBe(2);
		expect(thinkingChunks[0].type === "thinking" && thinkingChunks[0].content).toBe(
			"Let me analyze",
		);
		expect(thinkingChunks[1].type === "thinking" && thinkingChunks[1].content).toBe(
			" this problem carefully",
		);

		const textChunks = chunks.filter((c) => c.type === "text");
		expect(textChunks.length).toBe(1);

		const doneChunks = chunks.filter((c) => c.type === "done");
		expect(doneChunks.length).toBe(1);
	});

	it("reports extended_thinking: true in capabilities", () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-sonnet-4-20250514",
			contextWindow: 200000,
		});
		expect(driver.capabilities().extended_thinking).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Bedrock driver — thinking integration
// ---------------------------------------------------------------------------

describe("BedrockDriver extended thinking", () => {
	let sendSpy: ReturnType<typeof spyOn<BedrockRuntimeClient, "send">>;

	beforeEach(() => {
		sendSpy = spyOn(BedrockRuntimeClient.prototype, "send");
	});

	afterEach(() => {
		sendSpy.mockRestore();
	});

	it("includes performanceConfig in command when thinking is set", async () => {
		sendSpy.mockImplementation(() => {
			return Promise.resolve(
				createMockBedrockStream([{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } }]),
			);
		});

		const driver = new BedrockDriver({
			region: "us-east-1",
			model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
			contextWindow: 200000,
		});

		await collectChunks(
			driver.chat({
				messages: [{ role: "user", content: "Think about this" }],
				thinking: { type: "enabled", budget_tokens: 8000 },
			}),
		);

		expect(sendSpy.mock.calls).toHaveLength(1);
		const commandInput = (sendSpy.mock.calls[0][0] as { input: Record<string, unknown> }).input;
		expect(commandInput.performanceConfig).toEqual({
			thinking: {
				type: "enabled",
				budgetTokens: 8000,
			},
		});
	});

	it("omits temperature from inferenceConfig when thinking is enabled", async () => {
		sendSpy.mockImplementation(() =>
			Promise.resolve(
				createMockBedrockStream([{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } }]),
			),
		);

		const driver = new BedrockDriver({
			region: "us-east-1",
			model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
			contextWindow: 200000,
		});

		await collectChunks(
			driver.chat({
				messages: [{ role: "user", content: "Hello" }],
				thinking: { type: "enabled", budget_tokens: 5000 },
				temperature: 0.7,
				max_tokens: 4096,
			}),
		);

		const commandInput = (sendSpy.mock.calls[0][0] as { input: Record<string, unknown> }).input;
		const inferenceConfig = commandInput.inferenceConfig as Record<string, unknown> | undefined;
		// Temperature must be omitted when thinking is enabled
		expect(inferenceConfig?.temperature).toBeUndefined();
		// max_tokens should still be present
		expect(inferenceConfig?.maxTokens).toBe(4096);
	});

	it("does not include performanceConfig when thinking is not set", async () => {
		sendSpy.mockImplementation(() =>
			Promise.resolve(
				createMockBedrockStream([{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } }]),
			),
		);

		const driver = new BedrockDriver({
			region: "us-east-1",
			model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
			contextWindow: 200000,
		});

		await collectChunks(
			driver.chat({
				messages: [{ role: "user", content: "Hello" }],
			}),
		);

		const commandInput = (sendSpy.mock.calls[0][0] as { input: Record<string, unknown> }).input;
		expect(commandInput.performanceConfig).toBeUndefined();
	});

	it("parses thinking blocks from Bedrock ConverseStream into thinking StreamChunks", async () => {
		sendSpy.mockImplementation(() =>
			Promise.resolve(
				createMockBedrockStream([
					// Thinking block
					{
						contentBlockStart: {
							contentBlockIndex: 0,
							start: { thinking: {} },
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { thinking: { text: "Analyzing the " } },
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { thinking: { text: "problem..." } },
						},
					},
					{ contentBlockStop: { contentBlockIndex: 0 } },
					// Regular text block
					{
						contentBlockDelta: {
							contentBlockIndex: 1,
							delta: { text: "Here is my answer" },
						},
					},
					{ metadata: { usage: { inputTokens: 50, outputTokens: 30 } } },
				]),
			),
		);

		const driver = new BedrockDriver({
			region: "us-east-1",
			model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
			contextWindow: 200000,
		});

		const chunks = await collectChunks(
			driver.chat({
				messages: [{ role: "user", content: "Think about this" }],
				thinking: { type: "enabled", budget_tokens: 10000 },
			}),
		);

		const thinkingChunks = chunks.filter((c) => c.type === "thinking");
		expect(thinkingChunks.length).toBe(2);
		expect(thinkingChunks[0].type === "thinking" && thinkingChunks[0].content).toBe(
			"Analyzing the ",
		);
		expect(thinkingChunks[1].type === "thinking" && thinkingChunks[1].content).toBe("problem...");

		const textChunks = chunks.filter((c) => c.type === "text");
		expect(textChunks.length).toBe(1);

		const doneChunks = chunks.filter((c) => c.type === "done");
		expect(doneChunks.length).toBe(1);
	});

	it("reports extended_thinking: true in capabilities", () => {
		const driver = new BedrockDriver({
			region: "us-east-1",
			model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
			contextWindow: 200000,
		});
		expect(driver.capabilities().extended_thinking).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// OpenAI-compatible driver — thinking integration
// ---------------------------------------------------------------------------

describe("OpenAICompatibleDriver extended thinking", () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		global.fetch = originalFetch;
	});

	afterAll(() => {
		global.fetch = originalFetch;
	});

	it("parses reasoning_content from SSE deltas into thinking StreamChunks", async () => {
		const driver = new OpenAICompatibleDriver({
			baseUrl: "http://localhost:8000",
			apiKey: "test-key",
			model: "o4-mini",
			contextWindow: 128000,
		});

		// Simulate OpenAI SSE stream with reasoning_content on deltas
		const sseResponse = `data: ${JSON.stringify({
			id: "chatcmpl-123",
			choices: [
				{
					index: 0,
					delta: { reasoning_content: "Let me think about " },
					finish_reason: null,
				},
			],
		})}

data: ${JSON.stringify({
			id: "chatcmpl-123",
			choices: [
				{
					index: 0,
					delta: { reasoning_content: "this carefully." },
					finish_reason: null,
				},
			],
		})}

data: ${JSON.stringify({
			id: "chatcmpl-123",
			choices: [
				{
					index: 0,
					delta: { content: "Here is my answer." },
					finish_reason: null,
				},
			],
		})}

data: ${JSON.stringify({
			id: "chatcmpl-123",
			choices: [
				{
					index: 0,
					delta: {},
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 50, completion_tokens: 30 },
		})}

data: [DONE]
`;

		global.fetch = (async () => {
			return new Response(sseResponse, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		for await (const chunk of driver.chat({
			messages: [{ role: "user", content: "Think about this" }],
		})) {
			chunks.push(chunk);
		}

		const thinkingChunks = chunks.filter((c) => c.type === "thinking");
		expect(thinkingChunks.length).toBe(2);
		expect(thinkingChunks[0].type === "thinking" && thinkingChunks[0].content).toBe(
			"Let me think about ",
		);
		expect(thinkingChunks[1].type === "thinking" && thinkingChunks[1].content).toBe(
			"this carefully.",
		);

		const textChunks = chunks.filter((c) => c.type === "text");
		expect(textChunks.length).toBe(1);

		const doneChunks = chunks.filter((c) => c.type === "done");
		expect(doneChunks.length).toBe(1);
	});

	it("does not emit thinking chunks when reasoning_content is absent", async () => {
		const driver = new OpenAICompatibleDriver({
			baseUrl: "http://localhost:8000",
			apiKey: "test-key",
			model: "gpt-4",
			contextWindow: 8192,
		});

		const sseResponse = `data: ${JSON.stringify({
			id: "chatcmpl-123",
			choices: [{ index: 0, delta: { content: "Normal response" }, finish_reason: null }],
		})}

data: ${JSON.stringify({
			id: "chatcmpl-123",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}

data: [DONE]
`;

		global.fetch = (async () => {
			return new Response(sseResponse, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		for await (const chunk of driver.chat({
			messages: [{ role: "user", content: "Hello" }],
		})) {
			chunks.push(chunk);
		}

		const thinkingChunks = chunks.filter((c) => c.type === "thinking");
		expect(thinkingChunks.length).toBe(0);
	});

	it("reports extended_thinking: true in capabilities", () => {
		const driver = new OpenAICompatibleDriver({
			baseUrl: "http://localhost:8000",
			apiKey: "test-key",
			model: "o4-mini",
			contextWindow: 128000,
		});
		expect(driver.capabilities().extended_thinking).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Ollama driver — thinking integration
// ---------------------------------------------------------------------------

describe("OllamaDriver extended thinking", () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		global.fetch = originalFetch;
	});

	afterAll(() => {
		global.fetch = originalFetch;
	});

	it("sends think: true in request when thinking is enabled", async () => {
		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "deepseek-r1",
			contextWindow: 32000,
		});

		let requestBody: string | null = null;

		global.fetch = (async (_url: string, options: RequestInit) => {
			requestBody = options.body as string;
			return new Response(
				JSON.stringify({
					model: "deepseek-r1",
					created_at: "2024-01-01T00:00:00Z",
					message: { role: "assistant", content: "Answer" },
					done: true,
					prompt_eval_count: 10,
					eval_count: 5,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		for await (const _ of driver.chat({
			messages: [{ role: "user", content: "Think about this" }],
			thinking: { type: "enabled", budget_tokens: 10000 },
		})) {
			// drain
		}

		expect(requestBody).not.toBeNull();
		const request = JSON.parse(requestBody as string);
		expect(request.think).toBe(true);
	});

	it("does not send think when thinking is not set", async () => {
		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "llama3",
			contextWindow: 4096,
		});

		let requestBody: string | null = null;

		global.fetch = (async (_url: string, options: RequestInit) => {
			requestBody = options.body as string;
			return new Response(
				JSON.stringify({
					model: "llama3",
					created_at: "2024-01-01T00:00:00Z",
					message: { role: "assistant", content: "Answer" },
					done: true,
					prompt_eval_count: 10,
					eval_count: 5,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		for await (const _ of driver.chat({
			messages: [{ role: "user", content: "Hello" }],
		})) {
			// drain
		}

		const request = JSON.parse(requestBody as string);
		expect(request.think).toBeUndefined();
	});

	it("parses thinking field from streaming NDJSON into thinking StreamChunks", async () => {
		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "deepseek-r1",
			contextWindow: 32000,
		});

		const ndjson = [
			JSON.stringify({
				model: "deepseek-r1",
				created_at: "2024-01-01T00:00:00Z",
				message: { role: "assistant", content: "", thinking: "Let me analyze " },
				done: false,
			}),
			JSON.stringify({
				model: "deepseek-r1",
				created_at: "2024-01-01T00:00:00Z",
				message: { role: "assistant", content: "", thinking: "this problem." },
				done: false,
			}),
			JSON.stringify({
				model: "deepseek-r1",
				created_at: "2024-01-01T00:00:00Z",
				message: { role: "assistant", content: "Here is my answer." },
				done: false,
			}),
			JSON.stringify({
				model: "deepseek-r1",
				created_at: "2024-01-01T00:00:00Z",
				message: { role: "assistant", content: "" },
				done: true,
				prompt_eval_count: 50,
				eval_count: 30,
			}),
		];

		global.fetch = (async () => {
			return new Response(ndjson.join("\n"), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		for await (const chunk of driver.chat({
			messages: [{ role: "user", content: "Think about this" }],
			thinking: { type: "enabled", budget_tokens: 10000 },
		})) {
			chunks.push(chunk);
		}

		const thinkingChunks = chunks.filter((c) => c.type === "thinking");
		expect(thinkingChunks.length).toBe(2);
		expect(thinkingChunks[0].type === "thinking" && thinkingChunks[0].content).toBe(
			"Let me analyze ",
		);
		expect(thinkingChunks[1].type === "thinking" && thinkingChunks[1].content).toBe(
			"this problem.",
		);

		const textChunks = chunks.filter((c) => c.type === "text");
		expect(textChunks.length).toBe(1);

		const doneChunks = chunks.filter((c) => c.type === "done");
		expect(doneChunks.length).toBe(1);
	});

	it("reports extended_thinking: true in capabilities", () => {
		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "deepseek-r1",
			contextWindow: 32000,
		});
		expect(driver.capabilities().extended_thinking).toBe(true);
	});
});
