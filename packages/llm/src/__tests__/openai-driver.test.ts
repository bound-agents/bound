import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { OpenAICompatibleDriver, toOpenAIMessages } from "../openai-driver";
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
		// messages[0] is the user-first placeholder prepended by toOpenAIMessages
		expect(request.messages[0].role).toBe("user");
		expect(request.messages[1].role).toBe("assistant");
		expect(request.messages[1].tool_calls).toBeDefined();
		expect(request.messages[1].tool_calls[0].id).toBe("call-1");
		expect(request.messages[1].tool_calls[0].function.name).toBe("add");
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
		// messages[0] is the user-first placeholder prepended by toOpenAIMessages
		expect(request.messages[0].role).toBe("user");
		expect(request.messages[1].role).toBe("tool");
		expect(request.messages[1].tool_call_id).toBe("call-1");
		expect(request.messages[1].content).toBe("3");
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

describe("OpenAI stream — empty tool args detection", () => {
	const originalFetch = global.fetch;

	afterAll(() => {
		global.fetch = originalFetch;
	});

	it("emits error chunk when tool call finishes with no argument data (GLM arg dropping)", async () => {
		const driver = new OpenAICompatibleDriver({
			baseUrl: "http://localhost:8000",
			apiKey: "test-key",
			model: "glm-4.7",
			contextWindow: 131000,
		});

		// Simulate GLM dropping args: tool_use_start with name, but NO argument chunks
		const sseResponse = [
			`data: ${JSON.stringify({
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_dropped",
									type: "function",
									function: { name: "bash" },
								},
							],
						},
						finish_reason: null,
					},
				],
			})}`,
			"",
			// Finalize immediately with no argument chunks in between
			`data: ${JSON.stringify({
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: "tool_calls",
					},
				],
			})}`,
			"",
			"data: [DONE]",
			"",
		].join("\n");

		global.fetch = (async () => {
			return new Response(sseResponse, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		for await (const chunk of driver.chat({
			model: "glm-4.7",
			messages: [{ role: "user", content: "write a file" }],
		})) {
			chunks.push(chunk);
		}

		// Should contain an error chunk about dropped arguments
		const errorChunks = chunks.filter((c) => c.type === "error");
		expect(errorChunks.length).toBeGreaterThanOrEqual(1);
		expect((errorChunks[0] as { error: string }).error).toContain("bash");
		expect((errorChunks[0] as { error: string }).error).toContain("empty");
	});

	it("does not emit error for tool calls that legitimately have arguments", async () => {
		const driver = new OpenAICompatibleDriver({
			baseUrl: "http://localhost:8000",
			apiKey: "test-key",
			model: "glm-4.7",
			contextWindow: 131000,
		});

		const sseResponse = [
			`data: ${JSON.stringify({
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_ok",
									type: "function",
									function: { name: "bash", arguments: '{"command":' },
								},
							],
						},
						finish_reason: null,
					},
				],
			})}`,
			"",
			`data: ${JSON.stringify({
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									function: { arguments: '"ls"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			})}`,
			"",
			`data: ${JSON.stringify({
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: "tool_calls",
					},
				],
			})}`,
			"",
			"data: [DONE]",
			"",
		].join("\n");

		global.fetch = (async () => {
			return new Response(sseResponse, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		for await (const chunk of driver.chat({
			model: "glm-4.7",
			messages: [{ role: "user", content: "list files" }],
		})) {
			chunks.push(chunk);
		}

		// No error chunks
		const errorChunks = chunks.filter((c) => c.type === "error");
		expect(errorChunks.length).toBe(0);
	});
});

describe("toOpenAIMessages — tool_call string content parsing", () => {
	it("parses JSON string tool_call content into tool_calls array", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: JSON.stringify([
					{
						type: "tool_use",
						id: "call_123",
						name: "search",
						input: { query: "test" },
					},
				]),
			},
		];
		const result = toOpenAIMessages(messages);
		// +1 for user-first placeholder
		expect(result).toHaveLength(2);
		expect(result[0].role).toBe("user");
		expect(result[1].role).toBe("assistant");
		expect(result[1].tool_calls).toBeDefined();
		expect(result[1].tool_calls).toHaveLength(1);
		expect(result[1].tool_calls?.[0].id).toBe("call_123");
		expect(result[1].tool_calls?.[0].function.name).toBe("search");
		expect(result[1].tool_calls?.[0].function.arguments).toBe('{"query":"test"}');
	});

	it("falls back to plain content when JSON parse fails", () => {
		const messages: LLMMessage[] = [{ role: "tool_call", content: "I will help you with that." }];
		const result = toOpenAIMessages(messages);
		// +1 for user-first placeholder
		expect(result).toHaveLength(2);
		expect(result[0].role).toBe("user");
		expect(result[1].role).toBe("assistant");
		expect(result[1].content).toBe("I will help you with that.");
		expect(result[1].tool_calls).toBeUndefined();
	});

	it("ensures tool_result following string tool_call has matching tool_calls", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: JSON.stringify([
					{ type: "tool_use", id: "call_abc", name: "query", input: { sql: "SELECT 1" } },
				]),
			},
			{
				role: "tool_result",
				content: "Result: 1",
				tool_use_id: "call_abc",
			},
		];
		const result = toOpenAIMessages(messages);
		// +1 for user-first placeholder
		expect(result).toHaveLength(3);
		expect(result[0].role).toBe("user");
		// Assistant must have tool_calls for the tool result to be valid
		expect(result[1].role).toBe("assistant");
		expect(result[1].tool_calls).toBeDefined();
		expect(result[1].tool_calls?.[0].id).toBe("call_abc");
		// Tool result follows
		expect(result[2].role).toBe("tool");
		expect(result[2].tool_call_id).toBe("call_abc");
	});
});

describe("toOpenAIMessages — user-first placeholder", () => {
	it("prepends a user placeholder when first message is assistant (tool_call)", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "call_1",
						name: "memory",
						input: { subcommand: "search", query: "test" },
					},
				],
			},
			{
				role: "tool_result",
				content: "found: test entry",
				tool_use_id: "call_1",
			},
		];
		const result = toOpenAIMessages(messages);
		// First message must be role=user (placeholder)
		expect(result[0].role).toBe("user");
		expect(typeof result[0].content).toBe("string");
		// Original messages follow
		expect(result[1].role).toBe("assistant");
		expect(result[2].role).toBe("tool");
	});

	it("does not prepend placeholder when first message is already user", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		];
		const result = toOpenAIMessages(messages);
		expect(result[0].role).toBe("user");
		expect(result[0].content).toBe("hello");
		expect(result).toHaveLength(2);
	});

	it("prepends placeholder when first message is a system-converted-to-user note", () => {
		// System messages get converted to user role with <system-note> wrapper.
		// But if the ONLY messages are system (converted to user), that's fine.
		// This test verifies: when first original message is tool_result (role=tool),
		// a placeholder is prepended.
		const messages: LLMMessage[] = [
			{
				role: "tool_result",
				content: "some result",
				tool_use_id: "call_orphan",
			},
		];
		const result = toOpenAIMessages(messages);
		expect(result[0].role).toBe("user");
		// The tool message should follow
		expect(result.some((m) => m.role === "tool")).toBe(true);
	});
});

describe("toOpenAIMessages — dangling assistant-text replay artifacts", () => {
	it("drops a trailing assistant-text message that follows a tool result", () => {
		// Legacy thread shape: tool_call, tool_result, then a stale assistant-text
		// row that was persisted separately for the inline text emitted alongside
		// the tool_call. On replay this looks like a prefill request and breaks
		// qwen3 (enable_thinking) / GLM providers.
		const messages: LLMMessage[] = [
			{ role: "user", content: "check a file" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "call_1",
						name: "read",
						input: { path: "/tmp/x" },
					},
				],
			},
			{
				role: "tool_result",
				content: "file contents",
				tool_use_id: "call_1",
			},
			{ role: "assistant", content: "Yep — got one right here." },
		];
		const result = toOpenAIMessages(messages);
		// The stale trailing assistant-text row must be dropped.
		expect(result).toHaveLength(3);
		expect(result[0].role).toBe("user");
		expect(result[1].role).toBe("assistant");
		expect(result[1].tool_calls?.length).toBe(1);
		expect(result[2].role).toBe("tool");
	});

	it("drops assistant-text interleaved between tool_call and tool_result", () => {
		// Real observed shape from thread 8871bab2: the inline text row got
		// timestamped between the tool_call and the tool_result. After conversion,
		// we end up with [user, assistant(tool_calls), assistant(text), tool].
		// The dangling assistant(text) sits between the tool_call and the tool
		// role, which is also invalid. The guard drops it.
		const messages: LLMMessage[] = [
			{ role: "user", content: "check" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "call_1",
						name: "read",
						input: {},
					},
				],
			},
			{ role: "assistant", content: "Quick smoke test:" },
			{
				role: "tool_result",
				content: "ok",
				tool_use_id: "call_1",
			},
		];
		const result = toOpenAIMessages(messages);
		// After conversion the stale assistant-text message sits between the
		// tool_call-bearing assistant and the tool role. It's NOT caught by the
		// "assistant-after-tool" guard because the tool comes after, not before.
		// But it's still problematic: two consecutive assistants with the second
		// lacking tool_calls. We tolerate this case because the immediately
		// following tool message re-anchors the conversation — providers accept
		// assistant, assistant, tool as a valid (if odd) sequence. The critical
		// failure mode is a TRAILING assistant after a tool, which the guard
		// handles.
		expect(result).toHaveLength(4);
		expect(result[0].role).toBe("user");
		expect(result[1].role).toBe("assistant");
		expect(result[1].tool_calls?.length).toBe(1);
		expect(result[2].role).toBe("assistant");
		expect(result[3].role).toBe("tool");
	});

	it("preserves assistant messages that have tool_calls even after a tool", () => {
		// A normal multi-turn flow: tool_call → tool_result → assistant(tool_call
		// again for the next step). Must NOT be dropped.
		const messages: LLMMessage[] = [
			{ role: "user", content: "do two things" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "call_1",
						name: "read",
						input: {},
					},
				],
			},
			{
				role: "tool_result",
				content: "result 1",
				tool_use_id: "call_1",
			},
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "call_2",
						name: "write",
						input: {},
					},
				],
			},
		];
		const result = toOpenAIMessages(messages);
		expect(result).toHaveLength(4);
		expect(result[3].role).toBe("assistant");
		expect(result[3].tool_calls?.length).toBe(1);
	});

	it("preserves a normal assistant text reply that follows a tool_result", () => {
		// The normal end-of-turn shape: tool_call → tool_result → assistant(text)
		// saying "here's what I found". This IS a legitimate pattern during an
		// active conversation, but at replay-time in agent-loop it only occurs
		// when the assistant has finished speaking for that turn. The dangling-
		// assistant guard drops it, which is correct because on replay the next
		// user message will arrive and the assistant would regenerate anyway.
		// For the legitimate mid-turn case (provider just produced the text and
		// we're about to return to the user), agent-loop doesn't call back into
		// the LLM, so this code path doesn't fire.
		const messages: LLMMessage[] = [
			{ role: "user", content: "read it" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "call_1",
						name: "read",
						input: {},
					},
				],
			},
			{
				role: "tool_result",
				content: "ok",
				tool_use_id: "call_1",
			},
			{ role: "assistant", content: "Done — the file was empty." },
			{ role: "user", content: "great, now do X" },
		];
		const result = toOpenAIMessages(messages);
		// The assistant text is NOT a trailing-after-tool here because the user
		// message comes after it. It's preserved.
		expect(result).toHaveLength(5);
		expect(result[3].role).toBe("assistant");
		expect(result[3].content).toBe("Done — the file was empty.");
		expect(result[4].role).toBe("user");
	});
});
