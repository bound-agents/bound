import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockDriver, toBedrockMessages } from "../bedrock-driver";
import { LLMError } from "../types";
import type { LLMMessage, StreamChunk } from "../types";

const shouldSkip = process.env.SKIP_BEDROCK === "1";

function createMockStream(events: Record<string, unknown>[]) {
	return {
		stream: (async function* () {
			for (const event of events) {
				yield event;
			}
		})(),
	};
}

function createErrorStream(events: Record<string, unknown>[], errorMsg: string) {
	return {
		stream: (async function* () {
			for (const event of events) {
				yield event;
			}
			throw new Error(errorMsg);
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

function makeDriver(overrides?: { profile?: string }) {
	return new BedrockDriver({
		region: "us-east-1",
		model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
		contextWindow: 200000,
		...overrides,
	});
}

describe("BedrockDriver", () => {
	let sendSpy: ReturnType<typeof spyOn<BedrockRuntimeClient, "send">>;

	beforeEach(() => {
		sendSpy = spyOn(BedrockRuntimeClient.prototype, "send");
	});

	afterEach(() => {
		sendSpy.mockRestore();
	});

	it.skipIf(shouldSkip)("capabilities returns correct fields", () => {
		const driver = makeDriver();
		const caps = driver.capabilities();
		expect(caps.streaming).toBe(true);
		expect(caps.tool_use).toBe(true);
		expect(caps.system_prompt).toBe(true);
		expect(caps.prompt_caching).toBe(true);
		expect(caps.vision).toBe(true);
		expect(caps.max_context).toBe(200000);
	});

	it.skipIf(shouldSkip)("streams text chunks and done chunk", async () => {
		sendSpy.mockImplementation(() =>
			Promise.resolve(
				createMockStream([
					{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello " } } },
					{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "world" } } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			),
		);

		const driver = makeDriver();
		const chunks = await collectChunks(
			driver.chat({
				model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
				messages: [{ role: "user", content: "Hi" }],
			}),
		);

		expect(chunks).toHaveLength(3);
		expect(chunks[0]).toEqual({ type: "text", content: "Hello " });
		expect(chunks[1]).toEqual({ type: "text", content: "world" });
		expect(chunks[2]).toEqual({
			type: "done",
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				cache_write_tokens: null,
				cache_read_tokens: null,
				estimated: false,
			},
		});
	});

	describe("cache token extraction", () => {
		it.skipIf(shouldSkip)("AC4.2 — should extract cache tokens when present", async () => {
			sendSpy.mockImplementation(() =>
				Promise.resolve(
					createMockStream([
						{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello " } } },
						{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "world" } } },
						{
							metadata: {
								usage: {
									inputTokens: 10,
									outputTokens: 5,
									cacheWriteInputTokens: 80,
									cacheReadInputTokens: 120,
								},
							},
						},
					]),
				),
			);

			const driver = makeDriver();
			const chunks = await collectChunks(
				driver.chat({
					model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
					messages: [{ role: "user", content: "Hi" }],
				}),
			);

			expect(chunks).toHaveLength(3);
			const doneChunk = chunks[2];
			expect(doneChunk.type).toBe("done");
			if (doneChunk.type === "done") {
				expect(doneChunk.usage.cache_write_tokens).toBe(80);
				expect(doneChunk.usage.cache_read_tokens).toBe(120);
				expect(doneChunk.usage.estimated).toBe(false);
			}
		});

		it.skipIf(shouldSkip)(
			"AC4.5 — should apply zero-usage guard when all tokens are zero",
			async () => {
				sendSpy.mockImplementation(() =>
					Promise.resolve(
						createMockStream([
							{
								contentBlockDelta: { contentBlockIndex: 0, delta: { text: "This is a response" } },
							},
							{ metadata: { usage: { inputTokens: 0, outputTokens: 0 } } },
						]),
					),
				);

				const driver = makeDriver();
				const chunks = await collectChunks(
					driver.chat({
						model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
						messages: [{ role: "user", content: "Hello world" }],
					}),
				);

				expect(chunks).toHaveLength(2);
				const doneChunk = chunks[1];
				expect(doneChunk.type).toBe("done");
				if (doneChunk.type === "done") {
					expect(doneChunk.usage.estimated).toBe(true);
					expect(doneChunk.usage.input_tokens).toBeGreaterThan(0);
					expect(doneChunk.usage.output_tokens).toBeGreaterThan(0);
				}
			},
		);

		it.skipIf(shouldSkip)("should have null cache tokens when not present", async () => {
			sendSpy.mockImplementation(() =>
				Promise.resolve(
					createMockStream([
						{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Response" } } },
						{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
					]),
				),
			);

			const driver = makeDriver();
			const chunks = await collectChunks(
				driver.chat({
					model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
					messages: [{ role: "user", content: "Hi" }],
				}),
			);

			expect(chunks).toHaveLength(2);
			const doneChunk = chunks[1];
			expect(doneChunk.type).toBe("done");
			if (doneChunk.type === "done") {
				expect(doneChunk.usage.cache_write_tokens).toBeNull();
				expect(doneChunk.usage.cache_read_tokens).toBeNull();
				expect(doneChunk.usage.estimated).toBe(false);
			}
		});
	});

	it.skipIf(shouldSkip)("streams tool use events", async () => {
		sendSpy.mockImplementation(() =>
			Promise.resolve(
				createMockStream([
					{
						contentBlockStart: {
							contentBlockIndex: 0,
							start: { toolUse: { toolUseId: "tool-1", name: "add" } },
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { toolUse: { input: '{"a":1,' } },
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { toolUse: { input: '"b":2}' } },
						},
					},
					{ contentBlockStop: { contentBlockIndex: 0 } },
					{ metadata: { usage: { inputTokens: 20, outputTokens: 15 } } },
				]),
			),
		);

		const driver = makeDriver();
		const chunks = await collectChunks(
			driver.chat({
				model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
				messages: [{ role: "user", content: "add 1 and 2" }],
			}),
		);

		expect(chunks).toHaveLength(5);
		expect(chunks[0]).toEqual({ type: "tool_use_start", id: "tool-1", name: "add" });
		expect(chunks[1]).toEqual({ type: "tool_use_args", id: "tool-1", partial_json: '{"a":1,' });
		expect(chunks[2]).toEqual({ type: "tool_use_args", id: "tool-1", partial_json: '"b":2}' });
		expect(chunks[3]).toEqual({ type: "tool_use_end", id: "tool-1" });
		expect(chunks[4]).toEqual({
			type: "done",
			usage: {
				input_tokens: 20,
				output_tokens: 15,
				cache_write_tokens: null,
				cache_read_tokens: null,
				estimated: false,
			},
		});
	});

	it.skipIf(shouldSkip)("translates messages, system, and toolConfig correctly", async () => {
		sendSpy.mockImplementation(() =>
			Promise.resolve(
				createMockStream([{ metadata: { usage: { inputTokens: 1, outputTokens: 1 } } }]),
			),
		);

		const driver = makeDriver();
		await collectChunks(
			driver.chat({
				model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
				system: "You are a helpful assistant.",
				messages: [
					{ role: "user", content: "Use the add tool" },
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
					{
						role: "tool_result",
						content: [{ type: "text", text: "3" }],
						tool_use_id: "tool-1",
					},
				],
				tools: [
					{
						type: "function",
						function: {
							name: "add",
							description: "Adds two numbers",
							parameters: {
								type: "object",
								properties: { a: { type: "number" }, b: { type: "number" } },
							},
						},
					},
				],
			}),
		);

		expect(sendSpy.mock.calls).toHaveLength(1);
		const commandInput = (sendSpy.mock.calls[0][0] as { input: Record<string, unknown> }).input;

		expect(commandInput.modelId).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
		expect(commandInput.system).toEqual([{ text: "You are a helpful assistant." }]);

		const messages = commandInput.messages as Array<Record<string, unknown>>;
		expect(messages).toHaveLength(3);

		expect(messages[0]).toEqual({
			role: "user",
			content: [{ text: "Use the add tool" }],
		});

		expect(messages[1]).toEqual({
			role: "assistant",
			content: [
				{
					toolUse: {
						toolUseId: "tool-1",
						name: "add",
						input: { a: 1, b: 2 },
					},
				},
			],
		});

		expect(messages[2]).toEqual({
			role: "user",
			content: [
				{
					toolResult: {
						toolUseId: "tool-1",
						content: [{ text: "3" }],
					},
				},
			],
		});

		const toolConfig = commandInput.toolConfig as Record<string, unknown>;
		const tools = toolConfig.tools as Array<Record<string, unknown>>;
		expect(tools).toHaveLength(1);
		expect(tools[0]).toEqual({
			toolSpec: {
				name: "add",
				description: "Adds two numbers",
				inputSchema: {
					json: {
						type: "object",
						properties: { a: { type: "number" }, b: { type: "number" } },
					},
				},
			},
		});
	});

	it.skipIf(shouldSkip)("works when profile is configured", async () => {
		sendSpy.mockImplementation(() =>
			Promise.resolve(
				createMockStream([{ metadata: { usage: { inputTokens: 1, outputTokens: 1 } } }]),
			),
		);

		const driver = makeDriver({ profile: "my-aws-profile" });
		const chunks = await collectChunks(
			driver.chat({
				model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].type).toBe("done");
	});

	it.skipIf(shouldSkip)("throws LLMError when send throws", async () => {
		sendSpy.mockImplementation(() => Promise.reject(new Error("network failure")));

		const driver = makeDriver();
		let caught: unknown;
		try {
			await collectChunks(
				driver.chat({
					model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
					messages: [{ role: "user", content: "hello" }],
				}),
			);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(LLMError);
		expect((caught as LLMError).provider).toBe("bedrock");
		expect((caught as LLMError).message).toContain("network failure");
	});

	it.skipIf(shouldSkip)("extracts HTTP status code from AWS SDK $metadata", async () => {
		const awsError = new Error("The request body is not valid JSON.");
		// AWS SDK errors carry $metadata with the HTTP status code
		// biome-ignore lint/suspicious/noExplicitAny: AWS SDK error shape
		(awsError as any).$metadata = { httpStatusCode: 400 };
		// biome-ignore lint/suspicious/noExplicitAny: AWS SDK error shape
		(awsError as any).name = "ValidationException";
		sendSpy.mockImplementation(() => Promise.reject(awsError));

		const driver = makeDriver();
		let caught: unknown;
		try {
			await collectChunks(
				driver.chat({
					model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
					messages: [{ role: "user", content: "hello" }],
				}),
			);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(LLMError);
		expect((caught as LLMError).statusCode).toBe(400);
		expect((caught as LLMError).message).toContain("not valid JSON");
	});

	it.skipIf(shouldSkip)("throws LLMError when stream throws mid-iteration", async () => {
		sendSpy.mockImplementation(() =>
			Promise.resolve(
				createErrorStream(
					[{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } }],
					"stream interrupted",
				),
			),
		);

		const driver = makeDriver();
		let caught: unknown;
		try {
			await collectChunks(
				driver.chat({
					model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
					messages: [{ role: "user", content: "hello" }],
				}),
			);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(LLMError);
		expect((caught as LLMError).provider).toBe("bedrock");
		expect((caught as LLMError).message).toContain("stream interrupted");
	});

	it.skipIf(shouldSkip)("throws LLMError when response has no stream", async () => {
		sendSpy.mockImplementation(() => Promise.resolve({}));

		const driver = makeDriver();
		let caught: unknown;
		try {
			await collectChunks(
				driver.chat({
					model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
					messages: [{ role: "user", content: "hello" }],
				}),
			);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(LLMError);
		expect((caught as LLMError).provider).toBe("bedrock");
		expect((caught as LLMError).message.toLowerCase()).toContain("no stream");
	});

	describe("Bedrock message conversion compatibility", () => {
		it.skipIf(shouldSkip)("skips messages with non-standard roles (alert, purge)", async () => {
			sendSpy.mockImplementation(() =>
				Promise.resolve(
					createMockStream([{ metadata: { usage: { inputTokens: 1, outputTokens: 1 } } }]),
				),
			);

			const driver = makeDriver();
			await collectChunks(
				driver.chat({
					model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
					messages: [
						{ role: "user", content: "Hello" },
						// These would be cast from non-standard roles if context assembly leaked them
						{ role: "alert" as "user", content: "Internal error" },
						{ role: "purge" as "user", content: "Purge data" },
						{ role: "assistant", content: "Response" },
					],
				}),
			);

			expect(sendSpy.mock.calls).toHaveLength(1);
			const commandInput = (sendSpy.mock.calls[0][0] as { input: Record<string, unknown> }).input;
			const messages = commandInput.messages as Array<{ role: string }>;

			// Only user and assistant roles should appear — no alert or purge
			for (const msg of messages) {
				expect(["user", "assistant"]).toContain(msg.role);
			}

			// Should have exactly 2 messages: user + assistant (alert and purge filtered)
			expect(messages).toHaveLength(2);
		});

		it.skipIf(shouldSkip)("handles tool_result with empty tool_use_id gracefully", async () => {
			sendSpy.mockImplementation(() =>
				Promise.resolve(
					createMockStream([{ metadata: { usage: { inputTokens: 1, outputTokens: 1 } } }]),
				),
			);

			const driver = makeDriver();
			await collectChunks(
				driver.chat({
					model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
					messages: [
						{ role: "user", content: "Run query" },
						{
							role: "tool_call",
							content: [
								{
									type: "tool_use",
									id: "tu-abc",
									name: "query",
									input: { sql: "SELECT 1" },
								},
							],
						},
						{
							role: "tool_result",
							content: "Result: 1",
							tool_use_id: "", // empty — simulates the bug
						},
						{
							role: "tool_result",
							content: "Result: 2",
							// tool_use_id is undefined — simulates the bug
						},
					],
				}),
			);

			expect(sendSpy.mock.calls).toHaveLength(1);
			const commandInput = (sendSpy.mock.calls[0][0] as { input: Record<string, unknown> }).input;
			const messages = commandInput.messages as Array<{
				role: string;
				content: Array<{ toolResult?: { toolUseId: string } }>;
			}>;

			// Find all toolResult blocks
			const toolResults = messages.flatMap((m) => (m.content || []).filter((b) => b.toolResult));

			// Every toolResult must have a non-empty toolUseId
			for (const tr of toolResults) {
				expect(tr.toolResult?.toolUseId.length).toBeGreaterThan(0);
			}
		});

		it.skipIf(shouldSkip)(
			"merges consecutive tool_result messages into a single user message for multi-tool responses",
			async () => {
				sendSpy.mockImplementation(() =>
					Promise.resolve(
						createMockStream([{ metadata: { usage: { inputTokens: 1, outputTokens: 1 } } }]),
					),
				);

				const driver = makeDriver();
				await collectChunks(
					driver.chat({
						model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
						messages: [
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
						],
					}),
				);

				const commandInput = (sendSpy.mock.calls[0][0] as { input: Record<string, unknown> }).input;
				const messages = commandInput.messages as Array<{
					role: string;
					content: Array<{ toolResult?: { toolUseId: string; content: Array<{ text: string }> } }>;
				}>;

				// All three tool_result messages must be merged into a single user message
				const userMessages = messages.filter((m) => m.role === "user");
				// The last user message should contain all three toolResult blocks
				const toolResultBlocks = userMessages[userMessages.length - 1].content.filter(
					(b) => b.toolResult,
				);
				expect(toolResultBlocks).toHaveLength(3);
				expect(toolResultBlocks[0].toolResult?.toolUseId).toBe("tu-1");
				expect(toolResultBlocks[1].toolResult?.toolUseId).toBe("tu-2");
				expect(toolResultBlocks[2].toolResult?.toolUseId).toBe("tu-3");
			},
		);

		it.skipIf(shouldSkip)(
			"converts tool_call with ContentBlock array to assistant with toolUse blocks",
			async () => {
				sendSpy.mockImplementation(() =>
					Promise.resolve(
						createMockStream([{ metadata: { usage: { inputTokens: 1, outputTokens: 1 } } }]),
					),
				);

				const driver = makeDriver();
				await collectChunks(
					driver.chat({
						model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
						messages: [
							{ role: "user", content: "List files" },
							{
								role: "tool_call",
								content: [
									{
										type: "tool_use",
										id: "tool-123",
										name: "bash",
										input: { command: "ls -la" },
									},
									{
										type: "tool_use",
										id: "tool-456",
										name: "memorize",
										input: { key: "project", value: "bound" },
									},
								],
							},
						],
					}),
				);

				expect(sendSpy.mock.calls).toHaveLength(1);
				const commandInput = (sendSpy.mock.calls[0][0] as { input: Record<string, unknown> }).input;
				const messages = commandInput.messages as Array<{
					role: string;
					content: Array<{ toolUse?: { toolUseId: string; name: string; input: unknown } }>;
				}>;

				// Find the assistant message with toolUse blocks
				const assistantMsg = messages.find((m) => m.role === "assistant");
				expect(assistantMsg).toBeDefined();

				const toolUseBlocks = assistantMsg?.content.filter((b) => b.toolUse) || [];
				expect(toolUseBlocks.length).toBe(2);

				expect(toolUseBlocks[0].toolUse?.toolUseId).toBe("tool-123");
				expect(toolUseBlocks[0].toolUse?.name).toBe("bash");
				expect(toolUseBlocks[0].toolUse?.input).toEqual({ command: "ls -la" });

				expect(toolUseBlocks[1].toolUse?.toolUseId).toBe("tool-456");
				expect(toolUseBlocks[1].toolUse?.name).toBe("memorize");
				expect(toolUseBlocks[1].toolUse?.input).toEqual({ key: "project", value: "bound" });
			},
		);

		it.skipIf(shouldSkip)("handles tool_call with JSON string content by parsing it", async () => {
			sendSpy.mockImplementation(() =>
				Promise.resolve(
					createMockStream([{ metadata: { usage: { inputTokens: 1, outputTokens: 1 } } }]),
				),
			);

			const driver = makeDriver();
			// This simulates messages loaded from DB where tool_call content is a JSON string
			const jsonString = JSON.stringify([
				{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } },
			]);

			await collectChunks(
				driver.chat({
					model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
					messages: [
						{ role: "user", content: "Run command" },
						{
							role: "tool_call",
							content: jsonString, // String instead of array (from DB)
						},
					],
				}),
			);

			expect(sendSpy.mock.calls).toHaveLength(1);
			const commandInput = (sendSpy.mock.calls[0][0] as { input: Record<string, unknown> }).input;
			const messages = commandInput.messages as Array<{
				role: string;
				content: Array<{
					text?: string;
					toolUse?: { toolUseId: string; name: string; input: unknown };
				}>;
			}>;

			// The driver should parse the JSON string and convert to toolUse blocks
			const assistantMsg = messages.find((m) => m.role === "assistant");
			expect(assistantMsg).toBeDefined();

			// Should have toolUse block (driver parses JSON string from DB)
			const toolUseBlocks = assistantMsg?.content.filter((b) => b.toolUse) || [];
			expect(toolUseBlocks.length).toBe(1);
			expect(toolUseBlocks[0].toolUse?.toolUseId).toBe("t1");
			expect(toolUseBlocks[0].toolUse?.name).toBe("bash");
			expect(toolUseBlocks[0].toolUse?.input).toEqual({ command: "echo hi" });
		});
	});

	it.skipIf(shouldSkip)("AC8.2: passes signal to AWS SDK send()", async () => {
		const controller = new AbortController();

		let abortSignalReceived: AbortSignal | undefined;
		sendSpy.mockImplementation(
			async (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
				abortSignalReceived = options?.abortSignal;
				return createMockStream([
					{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello " } } },
					{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "world" } } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]);
			},
		);

		const driver = makeDriver();
		const chunks = await collectChunks(
			driver.chat({
				model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
				messages: [{ role: "user", content: "hi" }],
				signal: controller.signal,
			}),
		);

		expect(chunks.length).toBeGreaterThan(0);
		expect(abortSignalReceived).toBe(controller.signal);
	});

	// -----------------------------------------------------------------------
	// Prompt caching support
	// -----------------------------------------------------------------------
	describe("prompt caching", () => {
		it.skipIf(shouldSkip)("reports prompt_caching as true in capabilities", () => {
			const driver = makeDriver();
			expect(driver.capabilities().prompt_caching).toBe(true);
		});

		it.skipIf(shouldSkip)("injects cachePoint at breakpoint message indices", async () => {
			let capturedInput: Record<string, unknown> | undefined;
			sendSpy.mockImplementation((command: unknown) => {
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				capturedInput = (command as any).input;
				return Promise.resolve(
					createMockStream([
						{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "OK" } } },
						{
							metadata: {
								usage: {
									inputTokens: 100,
									outputTokens: 5,
									cacheWriteInputTokens: 50,
									cacheReadInputTokens: 0,
								},
							},
						},
					]),
				);
			});

			const driver = makeDriver();
			const chunks = await collectChunks(
				driver.chat({
					messages: [
						{ role: "user", content: "message 1" },
						{ role: "assistant", content: "response 1" },
						{ role: "user", content: "message 2" },
					],
					cache_breakpoints: [1], // Mark the assistant response (index 1)
				}),
			);

			// The message at index 1 should have cachePoint appended to its content
			expect(capturedInput).toBeDefined();
			const messages = capturedInput?.messages as Array<{
				role: string;
				content: Array<Record<string, unknown>>;
			}>;
			expect(messages[1].content).toEqual([
				{ text: "response 1" },
				{ cachePoint: { type: "default" } },
			]);
			// Other messages should NOT have cachePoint
			expect(messages[0].content).toEqual([{ text: "message 1" }]);
			expect(messages[2].content).toEqual([{ text: "message 2" }]);

			// Done chunk should carry cache tokens
			const done = chunks.find((c) => c.type === "done");
			expect(done).toBeDefined();
			if (done?.type === "done") {
				expect(done.usage.cache_write_tokens).toBe(50);
				expect(done.usage.cache_read_tokens).toBe(0);
			}
		});

		it.skipIf(shouldSkip)("ignores cache_ttl and uses plain default cachePoint", async () => {
			let capturedInput: Record<string, unknown> | undefined;
			sendSpy.mockImplementation((command: unknown) => {
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				capturedInput = (command as any).input;
				return Promise.resolve(
					createMockStream([
						{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "OK" } } },
						{ metadata: { usage: { inputTokens: 100, outputTokens: 5 } } },
					]),
				);
			});

			const driver = makeDriver();
			await collectChunks(
				driver.chat({
					messages: [
						{ role: "user", content: "message 1" },
						{ role: "assistant", content: "response 1" },
						{ role: "user", content: "message 2" },
					],
					system: "You are helpful.",
					cache_breakpoints: [1],
					cache_ttl: "1h",
				}),
			);

			// cache_ttl should NOT be passed through — ttl on cachePoint broke
			// message-level caching for large contexts
			const messages = capturedInput?.messages as Array<{
				role: string;
				content: Array<Record<string, unknown>>;
			}>;
			expect(messages[1].content).toEqual([
				{ text: "response 1" },
				{ cachePoint: { type: "default" } },
			]);

			const system = capturedInput?.system as Array<Record<string, unknown>>;
			expect(system[1]).toEqual({ cachePoint: { type: "default" } });
		});

		it.skipIf(shouldSkip)(
			"places cachePoint correctly when tool_result merging shortens the message array",
			async () => {
				let capturedInput: Record<string, unknown> | undefined;
				sendSpy.mockImplementation((command: unknown) => {
					// biome-ignore lint/suspicious/noExplicitAny: test mock
					capturedInput = (command as any).input;
					return Promise.resolve(
						createMockStream([
							{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "OK" } } },
							{
								metadata: {
									usage: {
										inputTokens: 100,
										outputTokens: 5,
										cacheWriteInputTokens: 80,
										cacheReadInputTokens: 0,
									},
								},
							},
						]),
					);
				});

				// 5 input messages: tool_call + 3 consecutive tool_results + user
				// toBedrockMessages merges the 3 tool_results into 1 user message,
				// producing only 3 Bedrock messages (assistant, user, user).
				// The caller passes breakpoint index 3 (= 5 - 2) which would be
				// out of bounds on the 3-element Bedrock array. The fix re-computes
				// the breakpoint from messages.length - 2 = 1.
				const driver = makeDriver();
				await collectChunks(
					driver.chat({
						messages: [
							{
								role: "tool_call",
								content: JSON.stringify([
									{ type: "tool_use", id: "tc-1", name: "query", input: {} },
									{ type: "tool_use", id: "tc-2", name: "memorize", input: {} },
									{ type: "tool_use", id: "tc-3", name: "emit", input: {} },
								]),
							},
							{ role: "tool_result", content: "result 1", tool_use_id: "tc-1" },
							{ role: "tool_result", content: "result 2", tool_use_id: "tc-2" },
							{ role: "tool_result", content: "result 3", tool_use_id: "tc-3" },
							{ role: "user", content: "thanks" },
						],
						cache_breakpoints: [3], // 5 - 2 = 3, but Bedrock array is only 3 elements
					}),
				);

				const messages = capturedInput?.messages as Array<{
					role: string;
					content: Array<Record<string, unknown>>;
				}>;
				// Bedrock messages: [assistant(tool_use), user(3 toolResults), user(text)]
				expect(messages.length).toBe(3);
				// cachePoint should be on messages[1] (= 3 - 2), not messages[3] (out of bounds)
				const cachedMsg = messages[1].content;
				expect(cachedMsg.at(-1)).toEqual({ cachePoint: { type: "default" } });
				// Last message should NOT have cachePoint
				expect(messages[2].content).toEqual([{ text: "thanks" }]);
			},
		);

		it.skipIf(shouldSkip)("caches system prompt when breakpoints are provided", async () => {
			let capturedInput: Record<string, unknown> | undefined;
			sendSpy.mockImplementation((command: unknown) => {
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				capturedInput = (command as any).input;
				return Promise.resolve(
					createMockStream([
						{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "OK" } } },
						{ metadata: { usage: { inputTokens: 100, outputTokens: 5 } } },
					]),
				);
			});

			const driver = makeDriver();
			await collectChunks(
				driver.chat({
					messages: [
						{ role: "user", content: "msg 1" },
						{ role: "assistant", content: "resp 1" },
						{ role: "user", content: "msg 2" },
					],
					system: "You are a helpful assistant.",
					cache_breakpoints: [1],
				}),
			);

			// System blocks should include a cachePoint
			const system = capturedInput?.system as Array<Record<string, unknown>>;
			expect(system).toBeDefined();
			expect(system.length).toBe(2);
			expect(system[0]).toEqual({ text: "You are a helpful assistant." });
			expect(system[1]).toEqual({ cachePoint: { type: "default" } });
		});
	});
});

describe("toBedrockMessages — blank text guard", () => {
	it("replaces empty string content with placeholder for user messages", () => {
		const messages: LLMMessage[] = [{ role: "user", content: "" }];
		const result = toBedrockMessages(messages);
		expect(result).toHaveLength(1);
		const textBlock = result[0].content?.[0];
		expect(textBlock).toBeDefined();
		// The text field must NOT be blank — Bedrock rejects it
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect(textBlock).toBeDefined()
		expect("text" in textBlock! && textBlock.text).toBeTruthy();
	});

	it("replaces empty ContentBlock[] text with placeholder for user messages", () => {
		const messages: LLMMessage[] = [{ role: "user", content: [{ type: "text", text: "" }] }];
		const result = toBedrockMessages(messages);
		expect(result).toHaveLength(1);
		const textBlock = result[0].content?.[0];
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect(textBlock).toBeDefined()
		expect("text" in textBlock! && textBlock.text).toBeTruthy();
	});

	it("replaces empty tool_call fallback text with placeholder", () => {
		const messages: LLMMessage[] = [{ role: "tool_call", content: [] }];
		const result = toBedrockMessages(messages);
		expect(result).toHaveLength(1);
		const textBlock = result[0].content?.[0];
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect(textBlock).toBeDefined()
		expect("text" in textBlock! && textBlock.text).toBeTruthy();
	});

	it("does not modify non-empty text content", () => {
		const messages: LLMMessage[] = [{ role: "user", content: "Hello world" }];
		const result = toBedrockMessages(messages);
		expect(result).toHaveLength(1);
		const textBlock = result[0].content?.[0];
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect(textBlock).toBeDefined()
		expect("text" in textBlock! && textBlock.text).toBe("Hello world");
	});
});
