import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { OpenAICompatibleDriver } from "../openai-driver";
import type { LLMMessage, StreamChunk } from "../types";

describe("OpenAICompatibleDriver", () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		global.fetch = originalFetch;
	});

	afterAll(() => {
		global.fetch = originalFetch;
	});

	it("should create a driver with capabilities", () => {
		const driver = new OpenAICompatibleDriver({
			baseUrl: "http://localhost:8000",
			apiKey: "test-key",
			model: "gpt-4",
			contextWindow: 8192,
		});

		const caps = driver.capabilities();
		expect(caps.streaming).toBe(true);
		expect(caps.tool_use).toBe(true);
		expect(caps.system_prompt).toBe(true);
		expect(caps.prompt_caching).toBe(false);
		expect(caps.vision).toBe(false);
		expect(caps.max_context).toBe(8192);
	});

	it("should translate user message correctly", async () => {
		const driver = new OpenAICompatibleDriver({
			baseUrl: "http://localhost:8000",
			apiKey: "test-key",
			model: "gpt-4",
			contextWindow: 8192,
		});

		const messages: LLMMessage[] = [
			{
				role: "user",
				content: "Hello, world!",
			},
		];

		let requestBody: string | null = null;

		global.fetch = (async (url: string, options: RequestInit) => {
			if (url.includes("/chat/completions")) {
				requestBody = options.body as string;
				const mockResponse = `data: ${JSON.stringify({
					id: "chatcmpl-123",
					object: "text_completion",
					created: 1234567890,
					model: "gpt-4",
					choices: [
						{
							index: 0,
							delta: { content: "Hello!" },
							finish_reason: null,
						},
					],
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
			model: "gpt-4",
			messages,
		})) {
			chunks.push(chunk);
		}

		expect(requestBody).not.toBeNull();
		if (!requestBody) throw new Error("requestBody is null");
		const request = JSON.parse(requestBody);
		expect(request.messages[0].role).toBe("user");
		expect(request.messages[0].content).toBe("Hello, world!");
	});

	it("should translate tool_call message correctly", async () => {
		const driver = new OpenAICompatibleDriver({
			baseUrl: "http://localhost:8000",
			apiKey: "test-key",
			model: "gpt-4",
			contextWindow: 8192,
		});

		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "call-1",
						name: "add",
						input: { a: 1, b: 2 },
					},
				],
			},
		];

		let requestBody: string | null = null;

		global.fetch = (async (url: string, options: RequestInit) => {
			if (url.includes("/chat/completions")) {
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
			model: "gpt-4",
			messages,
		})) {
			chunks.push(chunk);
		}

		expect(requestBody).not.toBeNull();
		if (!requestBody) throw new Error("requestBody is null");
		const request = JSON.parse(requestBody);
		expect(request.messages[0].role).toBe("assistant");
		expect(request.messages[0].tool_calls).toBeDefined();
		expect(request.messages[0].tool_calls[0].id).toBe("call-1");
		expect(request.messages[0].tool_calls[0].function.name).toBe("add");
	});

	it("should translate tool_result message correctly", async () => {
		const driver = new OpenAICompatibleDriver({
			baseUrl: "http://localhost:8000",
			apiKey: "test-key",
			model: "gpt-4",
			contextWindow: 8192,
		});

		const messages: LLMMessage[] = [
			{
				role: "tool_result",
				content: "3",
				tool_use_id: "call-1",
			},
		];

		let requestBody: string | null = null;

		global.fetch = (async (url: string, options: RequestInit) => {
			if (url.includes("/chat/completions")) {
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
			model: "gpt-4",
			messages,
		})) {
			chunks.push(chunk);
		}

		expect(requestBody).not.toBeNull();
		if (!requestBody) throw new Error("requestBody is null");
		const request = JSON.parse(requestBody);
		expect(request.messages[0].role).toBe("tool");
		expect(request.messages[0].tool_call_id).toBe("call-1");
		expect(request.messages[0].content).toBe("3");
	});

	it("should parse SSE stream correctly", async () => {
		const driver = new OpenAICompatibleDriver({
			baseUrl: "http://localhost:8000",
			apiKey: "test-key",
			model: "gpt-4",
			contextWindow: 8192,
		});

		const messages: LLMMessage[] = [
			{
				role: "user",
				content: "Hello",
			},
		];

		const sseResponse = `data: ${JSON.stringify({
			id: "chatcmpl-123",
			object: "text_completion",
			created: 1234567890,
			model: "gpt-4",
			choices: [
				{
					index: 0,
					delta: { content: "Hello" },
					finish_reason: null,
				},
			],
		})}

data: ${JSON.stringify({
			id: "chatcmpl-123",
			object: "text_completion",
			created: 1234567890,
			model: "gpt-4",
			choices: [
				{
					index: 0,
					delta: { content: " world" },
					finish_reason: null,
				},
			],
		})}

data: ${JSON.stringify({
			id: "chatcmpl-123",
			object: "text_completion",
			created: 1234567890,
			model: "gpt-4",
			choices: [
				{
					index: 0,
					delta: {},
					finish_reason: "stop",
				},
			],
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
			model: "gpt-4",
			messages,
		})) {
			chunks.push(chunk);
		}

		// Should have text chunks and a done chunk
		const textChunks = chunks.filter((c) => c.type === "text");
		expect(textChunks.length).toBeGreaterThan(0);

		const doneChunks = chunks.filter((c) => c.type === "done");
		expect(doneChunks.length).toBe(1);
	});

	describe("cache token extraction", () => {
		it("AC4.3 — should extract cache tokens when present", async () => {
			const driver = new OpenAICompatibleDriver({
				baseUrl: "http://localhost:8000",
				apiKey: "test-key",
				model: "gpt-4",
				contextWindow: 8192,
			});

			const messages: LLMMessage[] = [
				{
					role: "user",
					content: "Hello",
				},
			];

			const sseResponse = `data: ${JSON.stringify({
				id: "chatcmpl-123",
				object: "text_completion",
				created: 1234567890,
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: { content: "Response" },
						finish_reason: null,
					},
				],
			})}

data: ${JSON.stringify({
				id: "chatcmpl-123",
				object: "text_completion",
				created: 1234567890,
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: "stop",
					},
				],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 25,
					prompt_tokens_details: {
						cached_tokens: 50,
					},
				},
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
				model: "gpt-4",
				messages,
			})) {
				chunks.push(chunk);
			}

			const doneChunk = chunks.find((c) => c.type === "done");
			expect(doneChunk).toBeDefined();
			expect(doneChunk?.type).toBe("done");
			if (doneChunk?.type === "done") {
				expect(doneChunk.usage.input_tokens).toBe(100);
				expect(doneChunk.usage.output_tokens).toBe(25);
				expect(doneChunk.usage.cache_read_tokens).toBe(50);
				expect(doneChunk.usage.cache_write_tokens).toBeNull();
				expect(doneChunk.usage.estimated).toBe(false);
			}
		});

		it("AC4.5 — should apply zero-usage guard when all tokens are zero", async () => {
			const driver = new OpenAICompatibleDriver({
				baseUrl: "http://localhost:8000",
				apiKey: "test-key",
				model: "gpt-4",
				contextWindow: 8192,
			});

			const messages: LLMMessage[] = [
				{
					role: "user",
					content: "Hello world",
				},
			];

			const sseResponse = `data: ${JSON.stringify({
				id: "chatcmpl-123",
				object: "text_completion",
				created: 1234567890,
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: { content: "This is a response" },
						finish_reason: null,
					},
				],
			})}

data: ${JSON.stringify({
				id: "chatcmpl-123",
				object: "text_completion",
				created: 1234567890,
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: "stop",
					},
				],
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
				model: "gpt-4",
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
			const driver = new OpenAICompatibleDriver({
				baseUrl: "http://localhost:8000",
				apiKey: "test-key",
				model: "gpt-4",
				contextWindow: 8192,
			});

			const messages: LLMMessage[] = [
				{
					role: "user",
					content: "Hello",
				},
			];

			const sseResponse = `data: ${JSON.stringify({
				id: "chatcmpl-123",
				object: "text_completion",
				created: 1234567890,
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: { content: "Response" },
						finish_reason: null,
					},
				],
			})}

data: ${JSON.stringify({
				id: "chatcmpl-123",
				object: "text_completion",
				created: 1234567890,
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: "stop",
					},
				],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 25,
				},
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
				model: "gpt-4",
				messages,
			})) {
				chunks.push(chunk);
			}

			const doneChunk = chunks.find((c) => c.type === "done");
			expect(doneChunk).toBeDefined();
			expect(doneChunk?.type).toBe("done");
			if (doneChunk?.type === "done") {
				expect(doneChunk.usage.cache_read_tokens).toBeNull();
				expect(doneChunk.usage.cache_write_tokens).toBeNull();
				expect(doneChunk.usage.estimated).toBe(false);
			}
		});
	});

	it("should use correct base URL and authorization", async () => {
		const driver = new OpenAICompatibleDriver({
			baseUrl: "https://deepseek.example.com",
			apiKey: "sk-test-123",
			model: "deepseek-coder",
			contextWindow: 16000,
		});

		let capturedUrl = "";
		let capturedAuth = "";

		global.fetch = (async (url: string, options: RequestInit) => {
			capturedUrl = url as string;
			// biome-ignore lint/suspicious/noExplicitAny: partial mock or untyped parse result in test
			capturedAuth = (options.headers as any)?.Authorization || "";
			return new Response("data: {}", {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		try {
			for await (const chunk of driver.chat({
				model: "deepseek-coder",
				messages: [{ role: "user", content: "test" }],
			})) {
				chunks.push(chunk);
			}
		} catch {
			// Expected to fail with mock
		}

		expect(capturedUrl).toContain("deepseek.example.com");
		expect(capturedAuth).toBe("Bearer sk-test-123");
	});

	it("AC8.3: passes signal to fetch request", async () => {
		const driver = new OpenAICompatibleDriver({
			baseUrl: "http://localhost:8000",
			apiKey: "test-key",
			model: "gpt-4",
			contextWindow: 8192,
		});

		const controller = new AbortController();

		let capturedSignal: AbortSignal | undefined;
		global.fetch = (async (_url: string, options: RequestInit) => {
			capturedSignal = options?.signal;
			const mockResponse = `data: ${JSON.stringify({
				id: "chatcmpl-123",
				object: "text_completion",
				created: 1234567890,
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: { content: "Hello!" },
						finish_reason: null,
					},
				],
			})}\n`;

			return new Response(mockResponse, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		try {
			const chunks: StreamChunk[] = [];
			for await (const chunk of driver.chat({
				model: "gpt-4",
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

	it("two tool calls with distinct IDs from provider produce distinct IDs (AC6.2)", async () => {
		const driver = new OpenAICompatibleDriver({
			baseUrl: "http://localhost:8000",
			apiKey: "test-key",
			model: "gpt-4",
			contextWindow: 8192,
		});

		const sseResponse = `data: ${JSON.stringify({
			id: "chatcmpl-123",
			object: "text_completion",
			created: 1234567890,
			model: "gpt-4",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{ index: 0, id: "call_1", type: "function", function: { name: "search" } },
						],
					},
					finish_reason: null,
				},
			],
		})}

data: ${JSON.stringify({
			id: "chatcmpl-123",
			object: "text_completion",
			created: 1234567890,
			model: "gpt-4",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{ index: 0, id: "", type: "function", function: { arguments: '{"q":"foo"}' } },
						],
					},
					finish_reason: null,
				},
			],
		})}

data: ${JSON.stringify({
			id: "chatcmpl-123",
			object: "text_completion",
			created: 1234567890,
			model: "gpt-4",
			choices: [
				{
					index: 1,
					delta: {
						tool_calls: [
							{ index: 1, id: "call_2", type: "function", function: { name: "search" } },
						],
					},
					finish_reason: null,
				},
			],
		})}

data: ${JSON.stringify({
			id: "chatcmpl-123",
			object: "text_completion",
			created: 1234567890,
			model: "gpt-4",
			choices: [
				{
					index: 1,
					delta: {
						tool_calls: [
							{ index: 1, id: "", type: "function", function: { arguments: '{"q":"bar"}' } },
						],
					},
					finish_reason: "tool_calls",
				},
			],
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
			model: "gpt-4",
			messages: [{ role: "user", content: "Search for foo and bar" }],
		})) {
			chunks.push(chunk);
		}

		const startChunks = chunks.filter((c) => c.type === "tool_use_start");
		expect(startChunks).toHaveLength(2);

		const ids = startChunks.map((c) => (c as { id: string }).id);
		expect(ids[0]).not.toEqual(ids[1]);
		expect(ids[0]).toBe("call_1");
		expect(ids[1]).toBe("call_2");
	});

	it("tool calls with missing IDs from provider get synthesized IDs (AC6.2)", async () => {
		const driver = new OpenAICompatibleDriver({
			baseUrl: "http://localhost:8000",
			apiKey: "test-key",
			model: "gpt-4",
			contextWindow: 8192,
		});

		const sseResponse = `data: ${JSON.stringify({
			id: "chatcmpl-123",
			object: "text_completion",
			created: 1234567890,
			model: "gpt-4",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [{ index: 0, id: "", type: "function", function: { name: "search" } }],
					},
					finish_reason: null,
				},
			],
		})}

data: ${JSON.stringify({
			id: "chatcmpl-123",
			object: "text_completion",
			created: 1234567890,
			model: "gpt-4",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{ index: 0, id: "", type: "function", function: { arguments: '{"q":"foo"}' } },
						],
					},
					finish_reason: null,
				},
			],
		})}

data: ${JSON.stringify({
			id: "chatcmpl-123",
			object: "text_completion",
			created: 1234567890,
			model: "gpt-4",
			choices: [
				{
					index: 1,
					delta: {
						tool_calls: [{ index: 1, id: "", type: "function", function: { name: "search" } }],
					},
					finish_reason: null,
				},
			],
		})}

data: ${JSON.stringify({
			id: "chatcmpl-123",
			object: "text_completion",
			created: 1234567890,
			model: "gpt-4",
			choices: [
				{
					index: 1,
					delta: {
						tool_calls: [
							{ index: 1, id: "", type: "function", function: { arguments: '{"q":"bar"}' } },
						],
					},
					finish_reason: "tool_calls",
				},
			],
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
			model: "gpt-4",
			messages: [{ role: "user", content: "Search for foo and bar" }],
		})) {
			chunks.push(chunk);
		}

		const startChunks = chunks.filter((c) => c.type === "tool_use_start");
		expect(startChunks).toHaveLength(2);

		const ids = startChunks.map((c) => (c as { id: string }).id);
		expect(ids[0]).not.toEqual(ids[1]);
		expect(ids[0]).toMatch(/^openai-\d+-\d+$/);
		expect(ids[1]).toMatch(/^openai-\d+-\d+$/);
	});
});
