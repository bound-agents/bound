import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { AnthropicDriver } from "../anthropic-driver";
import type { LLMMessage, StreamChunk } from "../types";

const _shouldSkip = process.env.SKIP_ANTHROPIC === "1";

describe("AnthropicDriver", () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		// Reset fetch before each test
		global.fetch = originalFetch;
	});

	afterAll(() => {
		global.fetch = originalFetch;
	});

	it("should create a driver with capabilities", () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
			contextWindow: 200000,
		});

		const caps = driver.capabilities();
		expect(caps.streaming).toBe(true);
		expect(caps.tool_use).toBe(true);
		expect(caps.system_prompt).toBe(true);
		expect(caps.prompt_caching).toBe(true);
		expect(caps.vision).toBe(true);
		expect(caps.max_context).toBe(200000);
	});

	it("should translate user message correctly", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
			contextWindow: 200000,
		});

		const messages: LLMMessage[] = [
			{
				role: "user",
				content: "Hello, world!",
			},
		];

		let requestBody: string | null = null;

		global.fetch = (async (url: string, options: RequestInit) => {
			if (url.includes("anthropic.com")) {
				requestBody = options.body as string;
				const mockResponse = `data: ${JSON.stringify({
					type: "message_start",
					message: {
						id: "msg-123",
						type: "message",
						role: "assistant",
						content: [],
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				})}\n`;

				return new Response(mockResponse, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		for await (const chunk of driver.chat({
			model: "claude-3-sonnet-20240229",
			messages,
		})) {
			chunks.push(chunk);
		}

		expect(requestBody).not.toBeNull();
		if (!requestBody) throw new Error("requestBody is null");
		const request = JSON.parse(requestBody);
		expect(request.messages[0].role).toBe("user");
		expect(request.messages[0].content).toEqual([{ type: "text", text: "Hello, world!" }]);
	});

	it("should translate tool_call message correctly", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
			contextWindow: 200000,
		});

		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "tool-1",
						name: "add",
						input: { a: 1, b: 2 },
					},
				],
			},
		];

		let requestBody: string | null = null;

		global.fetch = (async (url: string, options: RequestInit) => {
			if (url.includes("anthropic.com")) {
				requestBody = options.body as string;
				return new Response("data: {}", {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		for await (const chunk of driver.chat({
			model: "claude-3-sonnet-20240229",
			messages,
		})) {
			chunks.push(chunk);
		}

		expect(requestBody).not.toBeNull();
		if (!requestBody) throw new Error("requestBody is null");
		const request = JSON.parse(requestBody);
		expect(request.messages[0].role).toBe("assistant");
		const toolUseContent = request.messages[0].content.find(
			(block: any) => block.type === "tool_use",
		);
		expect(toolUseContent).toBeDefined();
		expect(toolUseContent.name).toBe("add");
		expect(toolUseContent.input).toEqual({ a: 1, b: 2 });
	});

	it("should translate tool_result message correctly", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
			contextWindow: 200000,
		});

		const messages: LLMMessage[] = [
			{
				role: "tool_result",
				content: "3",
				tool_use_id: "tool-1",
			},
		];

		let requestBody: string | null = null;

		global.fetch = (async (url: string, options: RequestInit) => {
			if (url.includes("anthropic.com")) {
				requestBody = options.body as string;
				return new Response("data: {}", {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		for await (const chunk of driver.chat({
			model: "claude-3-sonnet-20240229",
			messages,
		})) {
			chunks.push(chunk);
		}

		expect(requestBody).not.toBeNull();
		if (!requestBody) throw new Error("requestBody is null");
		const request = JSON.parse(requestBody);
		expect(request.messages[0].role).toBe("user");
		const toolResultContent = request.messages[0].content.find(
			(block: any) => block.type === "tool_result",
		);
		expect(toolResultContent).toBeDefined();
		expect(toolResultContent.tool_use_id).toBe("tool-1");
		expect(toolResultContent.content).toEqual([{ type: "text", text: "3" }]);
	});

	it("merges consecutive tool_result messages into a single user message for multi-tool responses", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
			contextWindow: 200000,
		});

		const messages: LLMMessage[] = [
			{ role: "user", content: "Run a systems check" },
			{
				role: "tool_call",
				content: JSON.stringify([
					{ type: "tool_use", id: "tu-1", name: "bash", input: { command: "ping" } },
					{ type: "tool_use", id: "tu-2", name: "commands", input: {} },
					{ type: "tool_use", id: "tu-3", name: "hostinfo", input: {} },
				]),
			},
			{ role: "tool_result", content: "pong", tool_use_id: "tu-1" },
			{ role: "tool_result", content: "cmd list", tool_use_id: "tu-2" },
			{ role: "tool_result", content: "host: local", tool_use_id: "tu-3" },
		];

		let requestBody: string | null = null;

		global.fetch = (async (url: string, options: RequestInit) => {
			if (url.includes("anthropic.com")) {
				requestBody = options.body as string;
				return new Response("data: {}", {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		for await (const _ of driver.chat({ model: "claude-3-sonnet-20240229", messages })) {
			// drain stream
		}

		expect(requestBody).not.toBeNull();
		const request = JSON.parse(requestBody!);

		// All three tool_result messages must be merged into a single user message
		const userMessages = request.messages.filter((m: any) => m.role === "user");
		const lastUser = userMessages[userMessages.length - 1];
		const toolResultBlocks = lastUser.content.filter((b: any) => b.type === "tool_result");
		expect(toolResultBlocks).toHaveLength(3);
		expect(toolResultBlocks[0].tool_use_id).toBe("tu-1");
		expect(toolResultBlocks[1].tool_use_id).toBe("tu-2");
		expect(toolResultBlocks[2].tool_use_id).toBe("tu-3");
	});

	it("should parse SSE stream correctly", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
			contextWindow: 200000,
		});

		const messages: LLMMessage[] = [
			{
				role: "user",
				content: "Hello",
			},
		];

		const sseResponse = `data: ${JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text" },
		})}

data: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Hello" },
		})}

data: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: " world" },
		})}

data: ${JSON.stringify({
			type: "content_block_stop",
			index: 0,
		})}

data: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 2 },
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
			model: "claude-3-sonnet-20240229",
			messages,
		})) {
			chunks.push(chunk);
		}

		// Should have text chunks and a done chunk
		const textChunks = chunks.filter((c) => c.type === "text");
		expect(textChunks.length).toBeGreaterThan(0);
		expect(textChunks[0].type).toBe("text");

		const doneChunks = chunks.filter((c) => c.type === "done");
		expect(doneChunks.length).toBe(1);
	});

	it("should add cache_control at breakpoint indices", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
			contextWindow: 200000,
		});

		const messages: LLMMessage[] = [
			{
				role: "user",
				content: "Message 1",
			},
			{
				role: "assistant",
				content: "Response 1",
			},
			{
				role: "user",
				content: "Message 2",
			},
		];

		let requestBody: string | null = null;

		global.fetch = (async (url: string, options: RequestInit) => {
			if (url.includes("anthropic.com")) {
				requestBody = options.body as string;
				return new Response("data: {}", {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		for await (const chunk of driver.chat({
			model: "claude-3-sonnet-20240229",
			messages,
			cache_breakpoints: [1], // Cache after message at index 1
		})) {
			chunks.push(chunk);
		}

		expect(requestBody).not.toBeNull();
		if (!requestBody) throw new Error("requestBody is null");
		const request = JSON.parse(requestBody);
		expect(request.messages[1].cache_control).toEqual({ type: "ephemeral" });
		expect(request.messages[0].cache_control).toBeUndefined();
		expect(request.messages[2].cache_control).toBeUndefined();
	});

	it("should handle system prompt separately", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
			contextWindow: 200000,
		});

		const messages: LLMMessage[] = [
			{
				role: "user",
				content: "Hello",
			},
		];

		let requestBody: string | null = null;

		global.fetch = (async (url: string, options: RequestInit) => {
			if (url.includes("anthropic.com")) {
				requestBody = options.body as string;
				return new Response("data: {}", {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		for await (const chunk of driver.chat({
			model: "claude-3-sonnet-20240229",
			messages,
			system: "You are a helpful assistant.",
		})) {
			chunks.push(chunk);
		}

		expect(requestBody).not.toBeNull();
		if (!requestBody) throw new Error("requestBody is null");
		const request = JSON.parse(requestBody);
		expect(request.system).toBe("You are a helpful assistant.");
	});
});
