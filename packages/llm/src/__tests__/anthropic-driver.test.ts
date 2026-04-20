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

	it("should preserve image ContentBlocks in user messages", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
			contextWindow: 200000,
		});

		const messages: LLMMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "What is in this image?" },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "iVBORw0KGgo=",
						},
					},
				],
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

		for await (const _chunk of driver.chat({ model: "claude-3-sonnet-20240229", messages })) {
			// consume
		}

		expect(requestBody).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		const request = JSON.parse(requestBody!);
		const userContent = request.messages[0].content;
		expect(userContent.length).toBe(2);
		expect(userContent[0]).toEqual({ type: "text", text: "What is in this image?" });
		expect(userContent[1].type).toBe("image");
		expect(userContent[1].source.type).toBe("base64");
		expect(userContent[1].source.data).toBe("iVBORw0KGgo=");
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
		const request = JSON.parse(requestBody as string);

		// All three tool_result messages must be merged into a single user message
		const userMessages = request.messages.filter((m: any) => m.role === "user");
		const lastUser = userMessages[userMessages.length - 1];
		const toolResultBlocks = lastUser.content.filter((b: any) => b.type === "tool_result");
		expect(toolResultBlocks).toHaveLength(3);
		expect(toolResultBlocks[0].tool_use_id).toBe("tu-1");
		expect(toolResultBlocks[1].tool_use_id).toBe("tu-2");
		expect(toolResultBlocks[2].tool_use_id).toBe("tu-3");
	});

	it("should include image blocks in tool_result content", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
			contextWindow: 200000,
		});

		const messages: LLMMessage[] = [
			{ role: "user", content: "What's in this screenshot?" },
			{
				role: "tool_call",
				content: JSON.stringify([{ type: "tool_use", id: "tu-1", name: "screenshot", input: {} }]),
			},
			{
				role: "tool_result",
				content: [
					{ type: "text", text: "Here is the screenshot" },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
						},
					},
				],
				tool_use_id: "tu-1",
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

		for await (const _ of driver.chat({ model: "claude-3-sonnet-20240229", messages })) {
			// drain stream
		}

		expect(requestBody).not.toBeNull();
		const request = JSON.parse(requestBody as string);

		// Find the tool_result block in the user message
		const userMessages = request.messages.filter((m: any) => m.role === "user");
		const lastUser = userMessages[userMessages.length - 1];
		const toolResultBlocks = lastUser.content.filter((b: any) => b.type === "tool_result");
		expect(toolResultBlocks).toHaveLength(1);

		// The tool_result content should contain both text and image blocks
		const resultContent = toolResultBlocks[0].content;
		expect(resultContent).toHaveLength(2);
		expect(resultContent[0]).toEqual({ type: "text", text: "Here is the screenshot" });
		expect(resultContent[1]).toEqual({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			},
		});
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

	describe("cache token extraction", () => {
		it("AC4.1 — should extract cache tokens when present", async () => {
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
				type: "message_start",
				message: {
					id: "msg-123",
					type: "message",
					role: "assistant",
					content: [],
					usage: {
						input_tokens: 100,
						output_tokens: 0,
						cache_creation_input_tokens: 150,
						cache_read_input_tokens: 200,
					},
				},
			})}

data: ${JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text" },
			})}

data: ${JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Response" },
			})}

data: ${JSON.stringify({
				type: "content_block_stop",
				index: 0,
			})}

data: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
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

			const doneChunk = chunks.find((c) => c.type === "done");
			expect(doneChunk).toBeDefined();
			expect(doneChunk?.type).toBe("done");
			if (doneChunk?.type === "done") {
				expect(doneChunk.usage.cache_write_tokens).toBe(150);
				expect(doneChunk.usage.cache_read_tokens).toBe(200);
				expect(doneChunk.usage.estimated).toBe(false);
			}
		});

		it("AC4.5 — should apply zero-usage guard when all tokens are zero", async () => {
			const driver = new AnthropicDriver({
				apiKey: "test-key",
				model: "claude-3-sonnet-20240229",
				contextWindow: 200000,
			});

			const messages: LLMMessage[] = [
				{
					role: "user",
					content: "Hello world",
				},
			];

			const sseResponse = `data: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg-123",
					type: "message",
					role: "assistant",
					content: [],
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			})}

data: ${JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text" },
			})}

data: ${JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "This is a response" },
			})}

data: ${JSON.stringify({
				type: "content_block_stop",
				index: 0,
			})}

data: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 0 },
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

			const doneChunk = chunks.find((c) => c.type === "done");
			expect(doneChunk).toBeDefined();
			expect(doneChunk?.type).toBe("done");
			if (doneChunk?.type === "done") {
				expect(doneChunk.usage.estimated).toBe(true);
				expect(doneChunk.usage.input_tokens).toBeGreaterThan(0);
				expect(doneChunk.usage.output_tokens).toBeGreaterThan(0);
			}
		});

		it("should have null cache tokens when not present", async () => {
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
				type: "message_start",
				message: {
					id: "msg-123",
					type: "message",
					role: "assistant",
					content: [],
					usage: { input_tokens: 100, output_tokens: 0 },
				},
			})}

data: ${JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text" },
			})}

data: ${JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Response" },
			})}

data: ${JSON.stringify({
				type: "content_block_stop",
				index: 0,
			})}

data: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
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

			const doneChunk = chunks.find((c) => c.type === "done");
			expect(doneChunk).toBeDefined();
			expect(doneChunk?.type).toBe("done");
			if (doneChunk?.type === "done") {
				expect(doneChunk.usage.cache_write_tokens).toBeNull();
				expect(doneChunk.usage.cache_read_tokens).toBeNull();
				expect(doneChunk.usage.estimated).toBe(false);
			}
		});
	});

	it("should send anthropic-beta prompt-caching header when cache_breakpoints provided", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
			contextWindow: 200000,
		});

		let capturedHeaders: Record<string, string> = {};

		global.fetch = (async (_url: string, options: RequestInit) => {
			const headers = options.headers as Record<string, string>;
			capturedHeaders = { ...headers };
			return new Response("data: {}", {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		for await (const _ of driver.chat({
			model: "claude-3-sonnet-20240229",
			messages: [
				{ role: "user", content: "Message 1" },
				{ role: "assistant", content: "Response 1" },
				{ role: "user", content: "Message 2" },
			],
			cache_breakpoints: [1],
		})) {
			// drain
		}

		expect(capturedHeaders["anthropic-beta"]).toBeDefined();
		expect(capturedHeaders["anthropic-beta"]).toContain("prompt-caching");
	});

	it("should ignore cache_ttl and use plain ephemeral for Anthropic direct API", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
			contextWindow: 200000,
		});

		let requestBody: string | null = null;
		let capturedHeaders: Record<string, string> = {};

		global.fetch = (async (_url: string, options: RequestInit) => {
			requestBody = options.body as string;
			capturedHeaders = { ...(options.headers as Record<string, string>) };
			return new Response("data: {}", {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		for await (const _ of driver.chat({
			model: "claude-3-sonnet-20240229",
			messages: [
				{ role: "user", content: "Message 1" },
				{ role: "assistant", content: "Response 1" },
				{ role: "user", content: "Message 2" },
			],
			cache_breakpoints: [1],
			cache_ttl: "1h",
		})) {
			// drain
		}

		const request = JSON.parse(requestBody as string);
		// cache_ttl should NOT be passed through — extended TTL breaks Anthropic caching
		expect(request.messages[1].cache_control).toEqual({ type: "ephemeral" });
		// No extended-cache-ttl beta header
		expect(capturedHeaders["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
		expect(capturedHeaders["anthropic-beta"]).not.toContain("extended-cache-ttl");
	});

	it("should NOT send prompt-caching beta header when no cache_breakpoints", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
			contextWindow: 200000,
		});

		let capturedHeaders: Record<string, string> = {};

		global.fetch = (async (_url: string, options: RequestInit) => {
			const headers = options.headers as Record<string, string>;
			capturedHeaders = { ...headers };
			return new Response("data: {}", {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		for await (const _ of driver.chat({
			model: "claude-3-sonnet-20240229",
			messages: [{ role: "user", content: "Hello" }],
		})) {
			// drain
		}

		// No beta header needed when not caching
		expect(capturedHeaders["anthropic-beta"]).toBeUndefined();
	});

	it("should send system prompt as cacheable content blocks when cache_breakpoints provided", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
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
			model: "claude-3-sonnet-20240229",
			messages: [
				{ role: "user", content: "Message 1" },
				{ role: "assistant", content: "Response 1" },
				{ role: "user", content: "Message 2" },
			],
			system: "You are a helpful assistant.",
			cache_breakpoints: [1],
		})) {
			// drain
		}

		expect(requestBody).not.toBeNull();
		const request = JSON.parse(requestBody as string);
		// System should be an array of content blocks, not a plain string
		expect(Array.isArray(request.system)).toBe(true);
		expect(request.system[0].type).toBe("text");
		expect(request.system[0].text).toBe("You are a helpful assistant.");
		expect(request.system[0].cache_control).toEqual({ type: "ephemeral" });
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

	it("AC8.1: passes signal to fetch request", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
			contextWindow: 200000,
		});

		const controller = new AbortController();

		let capturedSignal: AbortSignal | undefined;
		global.fetch = (async (_url: string, options: RequestInit) => {
			capturedSignal = options?.signal;
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
		}) as typeof fetch;

		try {
			const chunks: StreamChunk[] = [];
			for await (const chunk of driver.chat({
				model: "claude-3-sonnet-20240229",
				messages: [{ role: "user", content: "hi" }],
				signal: controller.signal,
			})) {
				chunks.push(chunk);
			}

			expect(capturedSignal).toBe(controller.signal);
		} finally {
			global.fetch = originalFetch;
		}
	});

	it("sends system_suffix as uncached second block when cache_breakpoints provided", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
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
			model: "claude-3-sonnet-20240229",
			messages: [
				{ role: "user", content: "Message 1" },
				{ role: "assistant", content: "Response 1" },
				{ role: "user", content: "Message 2" },
			],
			system: "You are a helpful assistant.",
			system_suffix: "Current Model: opus\nThread ID: abc-123",
			cache_breakpoints: [1],
		})) {
			// drain
		}

		expect(requestBody).not.toBeNull();
		const request = JSON.parse(requestBody as string);
		// System should be an array with two content blocks
		expect(Array.isArray(request.system)).toBe(true);
		expect(request.system).toHaveLength(2);
		// First block: cached stable prefix
		expect(request.system[0].type).toBe("text");
		expect(request.system[0].text).toBe("You are a helpful assistant.");
		expect(request.system[0].cache_control).toEqual({ type: "ephemeral" });
		// Second block: uncached varying suffix
		expect(request.system[1].type).toBe("text");
		expect(request.system[1].text).toBe("Current Model: opus\nThread ID: abc-123");
		expect(request.system[1].cache_control).toBeUndefined();
	});

	it("ignores system_suffix when no cache_breakpoints provided", async () => {
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-3-sonnet-20240229",
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
			model: "claude-3-sonnet-20240229",
			messages: [{ role: "user", content: "Hello" }],
			system: "You are a helpful assistant.",
			system_suffix: "Current Model: opus",
		})) {
			// drain
		}

		expect(requestBody).not.toBeNull();
		const request = JSON.parse(requestBody as string);
		// Without cache_breakpoints, system_suffix is appended as plain string
		expect(typeof request.system).toBe("string");
		expect(request.system).toContain("You are a helpful assistant.");
		expect(request.system).toContain("Current Model: opus");
	});
});
