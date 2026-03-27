import { afterAll, describe, expect, it } from "bun:test";
import { OllamaDriver } from "../ollama-driver";
import type { LLMMessage, StreamChunk } from "../types";

describe("OllamaDriver", () => {
	const originalFetch = global.fetch;

	afterAll(() => {
		global.fetch = originalFetch;
	});
	it("should create a driver with capabilities", () => {
		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "llama2",
			contextWindow: 4096,
		});

		const caps = driver.capabilities();
		expect(caps.streaming).toBe(true);
		expect(caps.tool_use).toBe(true);
		expect(caps.system_prompt).toBe(true);
		expect(caps.prompt_caching).toBe(false);
		expect(caps.vision).toBe(false);
		expect(caps.max_context).toBe(4096);
	});

	it("should translate user message correctly", async () => {
		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "llama2",
			contextWindow: 4096,
		});

		const messages: LLMMessage[] = [
			{
				role: "user",
				content: "Hello, world!",
			},
		];

		let requestBody: string | null = null;

		global.fetch = (async (url: string, options: RequestInit) => {
			if (url.includes("/api/chat")) {
				requestBody = options.body as string;
				const mockResponse = JSON.stringify({
					model: "llama2",
					created_at: "2024-01-01T00:00:00Z",
					message: {
						role: "assistant",
						content: "Hello!",
					},
					done: true,
					prompt_eval_count: 10,
					eval_count: 5,
				});

				return new Response(mockResponse, {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		for await (const chunk of driver.chat({
			model: "llama2",
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

	it("should handle tool_call message correctly", async () => {
		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "llama2",
			contextWindow: 4096,
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
			if (url.includes("/api/chat")) {
				requestBody = options.body as string;
				return new Response(
					JSON.stringify({
						model: "llama2",
						created_at: "2024-01-01T00:00:00Z",
						message: {
							role: "assistant",
							content: "",
						},
						done: true,
						prompt_eval_count: 10,
						eval_count: 0,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		for await (const _chunk of driver.chat({
			model: "llama2",
			messages,
		})) {
			// Consume chunks
		}

		expect(requestBody).not.toBeNull();
		if (!requestBody) throw new Error("requestBody is null");
		const request = JSON.parse(requestBody);
		expect(request.messages[0].role).toBe("assistant");
		expect(request.messages[0].tool_calls).toBeDefined();
		expect(request.messages[0].tool_calls[0].function.name).toBe("add");
	});

	it("should handle tool_result message correctly", async () => {
		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "llama2",
			contextWindow: 4096,
		});

		const messages: LLMMessage[] = [
			{
				role: "tool_result",
				content: "Result: 3",
				tool_use_id: "tool-1",
			},
		];

		let requestBody: string | null = null;

		global.fetch = (async (url: string, options: RequestInit) => {
			if (url.includes("/api/chat")) {
				requestBody = options.body as string;
				return new Response(
					JSON.stringify({
						model: "llama2",
						created_at: "2024-01-01T00:00:00Z",
						message: {
							role: "assistant",
							content: "",
						},
						done: true,
						prompt_eval_count: 10,
						eval_count: 0,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		for await (const _chunk of driver.chat({
			model: "llama2",
			messages,
		})) {
			// Consume chunks
		}

		expect(requestBody).not.toBeNull();
		if (!requestBody) throw new Error("requestBody is null");
		const request = JSON.parse(requestBody);
		expect(request.messages[0].role).toBe("tool");
		expect(request.messages[0].tool_name).toBe("tool-1");
	});

	it("should parse streaming text response correctly", async () => {
		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "llama2",
			contextWindow: 4096,
		});

		global.fetch = (async () => {
			const ndjson = [
				JSON.stringify({
					model: "llama2",
					created_at: "2024-01-01T00:00:00Z",
					message: { role: "assistant", content: "Hello, " },
					done: false,
				}),
				JSON.stringify({
					model: "llama2",
					created_at: "2024-01-01T00:00:00Z",
					message: { role: "assistant", content: "world!" },
					done: false,
				}),
				JSON.stringify({
					model: "llama2",
					created_at: "2024-01-01T00:00:00Z",
					message: { role: "assistant", content: "" },
					done: true,
					prompt_eval_count: 5,
					eval_count: 3,
				}),
			];

			return new Response(ndjson.join("\n"), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		for await (const chunk of driver.chat({
			model: "llama2",
			messages: [{ role: "user", content: "Hi" }],
		})) {
			chunks.push(chunk);
		}

		expect(chunks).toContainEqual({
			type: "text",
			content: "Hello, ",
		});
		expect(chunks).toContainEqual({
			type: "text",
			content: "world!",
		});
		expect(chunks.some((c) => c.type === "done")).toBe(true);
	});

	it("should handle tool_calls in stream response correctly", async () => {
		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "llama2",
			contextWindow: 4096,
		});

		global.fetch = (async () => {
			const ndjson = [
				JSON.stringify({
					model: "llama2",
					created_at: "2024-01-01T00:00:00Z",
					message: {
						role: "assistant",
						content: "I'll add these numbers.",
						tool_calls: [
							{
								function: {
									name: "add",
									arguments: '{"a": 1, "b": 2}',
								},
							},
						],
					},
					done: true,
					prompt_eval_count: 10,
					eval_count: 5,
				}),
			];

			return new Response(ndjson.join("\n"), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		for await (const chunk of driver.chat({
			model: "llama2",
			messages: [{ role: "user", content: "Add 1 and 2" }],
		})) {
			chunks.push(chunk);
		}

		expect(chunks).toContainEqual({
			type: "tool_use_start",
			id: "add",
			name: "add",
		});
		expect(chunks.some((c) => c.type === "tool_use_args")).toBe(true);
		expect(chunks).toContainEqual({
			type: "tool_use_end",
			id: "add",
		});
	});

	it("should throw LLMError on connection failure", async () => {
		const driver = new OllamaDriver({
			baseUrl: "http://invalid-host:99999",
			model: "llama2",
			contextWindow: 4096,
		});

		global.fetch = (async () => {
			throw new Error("Failed to connect");
		}) as typeof fetch;

		try {
			for await (const _chunk of driver.chat({
				model: "llama2",
				messages: [{ role: "user", content: "Hi" }],
			})) {
				// Should not reach here
			}
			expect(false).toBe(true);
		} catch (error: unknown) {
			const e = error as Record<string, unknown>;
			expect(e.provider).toBe("ollama");
			expect(String(e.message)).toContain("Failed to connect");
		}
	});

	it("should throw LLMError on non-200 response", async () => {
		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "llama2",
			contextWindow: 4096,
		});

		global.fetch = (async () => {
			return new Response("Model not found", {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		try {
			for await (const _chunk of driver.chat({
				model: "nonexistent",
				messages: [{ role: "user", content: "Hi" }],
			})) {
				// Should not reach here
			}
			expect(false).toBe(true);
		} catch (error: unknown) {
			const e = error as Record<string, unknown>;
			expect(e.provider).toBe("ollama");
			expect(e.statusCode).toBe(404);
			expect(String(e.message)).toContain("404");
		}
	});

	it("AC8.4: passes signal to fetch request", async () => {
		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "llama2",
			contextWindow: 4096,
		});

		const controller = new AbortController();

		let capturedSignal: AbortSignal | undefined;
		global.fetch = (async (_url: string, options: RequestInit) => {
			capturedSignal = options?.signal;
			const ndjson = [
				JSON.stringify({
					model: "llama2",
					created_at: "2024-01-01T00:00:00Z",
					message: { role: "assistant", content: "Hello" },
					done: true,
					prompt_eval_count: 5,
					eval_count: 3,
				}),
			];

			return new Response(ndjson.join("\n"), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		try {
			const chunks: unknown[] = [];
			for await (const chunk of driver.chat({
				model: "llama2",
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
});
