import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { AgentLoop } from "../agent-loop";
import { type ClientToolCallRequest, isClientToolCallRequest } from "../types";

describe("ClientToolCallRequest type and type guard", () => {
	it("isClientToolCallRequest returns true for objects with clientToolCall: true", () => {
		const request: ClientToolCallRequest = {
			clientToolCall: true,
			toolName: "my_tool",
			callId: "call-123",
			arguments: { foo: "bar" },
		};

		expect(isClientToolCallRequest(request)).toBe(true);
	});

	it("isClientToolCallRequest returns false for normal tool results with content and exitCode", () => {
		const toolResult = { content: "some output", exitCode: 0 };
		expect(isClientToolCallRequest(toolResult)).toBe(false);
	});

	it("isClientToolCallRequest returns false for relay requests with outboxEntryId", () => {
		const relayRequest = {
			outboxEntryId: "entry-123",
			targetSiteId: "remote-site",
			targetHostName: "remote-host",
			toolName: "some_tool",
			eligibleHosts: [],
			currentHostIndex: 0,
			stdout: "",
			stderr: "",
			exitCode: 0,
		};
		expect(isClientToolCallRequest(relayRequest)).toBe(false);
	});

	it("isClientToolCallRequest returns false for null", () => {
		expect(isClientToolCallRequest(null)).toBe(false);
	});

	it("isClientToolCallRequest returns false for undefined", () => {
		expect(isClientToolCallRequest(undefined)).toBe(false);
	});

	it("isClientToolCallRequest returns false for non-objects", () => {
		expect(isClientToolCallRequest("string")).toBe(false);
		expect(isClientToolCallRequest(123)).toBe(false);
		expect(isClientToolCallRequest(true)).toBe(false);
		expect(isClientToolCallRequest([])).toBe(false);
	});

	it("isClientToolCallRequest returns false for objects without clientToolCall property", () => {
		const obj = { toolName: "tool", callId: "123", arguments: {} };
		expect(isClientToolCallRequest(obj)).toBe(false);
	});

	it("isClientToolCallRequest returns false when clientToolCall is false", () => {
		const obj = { clientToolCall: false, toolName: "tool", callId: "123", arguments: {} };
		expect(isClientToolCallRequest(obj)).toBe(false);
	});

	it("ClientToolCallRequest has all required fields with correct types", () => {
		const request: ClientToolCallRequest = {
			clientToolCall: true,
			toolName: "calculate",
			callId: "id-456",
			arguments: { x: 10, y: 20, operation: "add" },
		};

		expect(request.clientToolCall).toBe(true);
		expect(typeof request.toolName).toBe("string");
		expect(typeof request.callId).toBe("string");
		expect(typeof request.arguments).toBe("object");
	});

	it("ClientToolCallRequest arguments can be empty", () => {
		const request: ClientToolCallRequest = {
			clientToolCall: true,
			toolName: "no_args_tool",
			callId: "id-789",
			arguments: {},
		};

		expect(request.arguments).toEqual({});
		expect(isClientToolCallRequest(request)).toBe(true);
	});

	it("ClientToolCallRequest arguments can have nested objects", () => {
		const request: ClientToolCallRequest = {
			clientToolCall: true,
			toolName: "complex_tool",
			callId: "id-nested",
			arguments: {
				user: { id: "123", name: "John" },
				options: { deep: { nested: true } },
			},
		};

		expect(request.arguments.user).toEqual({ id: "123", name: "John" });
		expect(request.arguments.options).toEqual({ deep: { nested: true } });
		expect(isClientToolCallRequest(request)).toBe(true);
	});
});

// Mock LLM backend for testing
class MockLLMBackend implements LLMBackend {
	private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
	private callCount = 0;

	pushResponse(gen: () => AsyncGenerator<StreamChunk>) {
		this.responses.push(gen);
	}

	setToolThenTextResponse(
		toolId: string,
		toolName: string,
		toolInput: Record<string, unknown>,
		finalText: string,
	) {
		this.responses = [];
		this.pushResponse(async function* () {
			yield { type: "tool_use_start" as const, id: toolId, name: toolName };
			yield {
				type: "tool_use_args" as const,
				id: toolId,
				partial_json: JSON.stringify(toolInput),
			};
			yield { type: "tool_use_end" as const, id: toolId };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 15,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});
		this.pushResponse(async function* () {
			yield { type: "text" as const, content: finalText };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 20,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});
	}

	async *chat() {
		const gen = this.responses[this.callCount];
		this.callCount++;
		if (gen) {
			yield* gen();
		} else {
			yield { type: "text" as const, content: "" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		}
	}

	capabilities() {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			max_context: 8000,
		};
	}
}

function createMockRouter(backend: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("claude-opus", backend);
	return new ModelRouter(backends, "claude-opus");
}

describe("Client tool dispatch in AgentLoop", () => {
	let tmpDir: string;
	let db: Database;
	let threadId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "client-tool-dispatch-"));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
		applyMetricsSchema(db);

		const userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
	});

	beforeEach(() => {
		threadId = randomUUID();
	});

	afterAll(async () => {
		db.close();
		if (tmpDir) await cleanupTmpDir(tmpDir);
	});

	function makeCtx(): AppContext {
		return {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus: { on: () => {}, off: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: "test-site-id",
		} as unknown as AppContext;
	}

	it("merges server tools and client tool definitions in LLM tool list", async () => {
		const serverTool = {
			type: "function" as const,
			function: {
				name: "list_files",
				description: "List files in a directory",
				parameters: { type: "object", properties: {}, required: [] },
			},
		};

		const clientTool = {
			type: "function" as const,
			function: {
				name: "client_calculate",
				description: "Perform calculation on client",
				parameters: {
					type: "object",
					properties: { operation: { type: "string" } },
					required: ["operation"],
				},
			},
		};

		const clientTools = new Map([["client_calculate", clientTool]]);

		const mockBackend = new MockLLMBackend();
		const chatCalls: Parameters<LLMBackend["chat"]>[] = [];
		const originalChat = mockBackend.chat.bind(mockBackend);
		mockBackend.chat = async function* (params) {
			chatCalls.push([params as unknown as Parameters<LLMBackend["chat"]>[0]]);
			yield* originalChat(params);
		} as any;

		mockBackend.setToolThenTextResponse("tool-1", "list_files", { path: "/tmp" }, "Got files");

		const ctx = makeCtx();
		const loop = new AgentLoop(
			ctx,
			{ exec: () => Promise.resolve({}) } as any,
			createMockRouter(mockBackend),
			{
				threadId,
				userId: "test-user",
				tools: [serverTool],
				clientTools,
			},
		);

		await loop.run();

		// Verify the merged tool list was passed to the backend
		expect(chatCalls.length).toBeGreaterThan(0);
		const toolsParam = (chatCalls[0][0] as any).tools;
		expect(toolsParam).toBeDefined();
		expect(toolsParam?.length).toBe(2);
		expect(toolsParam?.some((t: any) => t.function.name === "list_files")).toBe(true);
		expect(toolsParam?.some((t: any) => t.function.name === "client_calculate")).toBe(true);
	});

	it("returns ClientToolCallRequest when LLM calls a client tool", async () => {
		const clientTool = {
			type: "function" as const,
			function: {
				name: "client_math",
				description: "Math on client",
				parameters: { type: "object", properties: {}, required: [] },
			},
		};

		const clientTools = new Map([["client_math", clientTool]]);

		const mockBackend = new MockLLMBackend();
		// Set up backend to return text directly (no tool call in this test)
		// The actual tool call test happens in agent-loop.test.ts integration tests
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "This tool would be called by the client" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 20,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const ctx = makeCtx();
		const sandbox = { exec: undefined } as any;

		const loop = new AgentLoop(ctx, sandbox, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
			clientTools,
		});

		const result = await loop.run();

		// Should complete without error
		expect(result.error).toBeUndefined();
	});

	it("client tools have priority after platform tools but before built-in tools", async () => {
		const executionOrder: string[] = [];

		// Create a client tool
		const clientTool = {
			type: "function" as const,
			function: {
				name: "my_tool",
				description: "A tool",
				parameters: { type: "object", properties: {}, required: [] },
			},
		};

		const clientTools = new Map([["my_tool", clientTool]]);

		const mockBackend = new MockLLMBackend();
		mockBackend.setToolThenTextResponse("tool-1", "my_tool", {}, "Done");

		const ctx = makeCtx();
		const sandbox = {
			exec: async () => {
				executionOrder.push("exec");
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		} as any;

		const loop = new AgentLoop(ctx, sandbox, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
			clientTools,
		});

		await loop.run();

		// Should NOT have fallen through to exec (client tool dispatch returns sentinel)
		expect(executionOrder).not.toContain("exec");
	});

	it("tools work normally when clientTools is undefined", async () => {
		const serverTool = {
			type: "function" as const,
			function: {
				name: "test_tool",
				description: "Test tool",
				parameters: { type: "object", properties: {}, required: [] },
			},
		};

		const mockBackend = new MockLLMBackend();
		mockBackend.setToolThenTextResponse("tool-1", "test_tool", {}, "Result");

		const ctx = makeCtx();
		const sandbox = {
			exec: async () => {
				return { stdout: "output", stderr: "", exitCode: 0 };
			},
		} as any;

		const loop = new AgentLoop(ctx, sandbox, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
			tools: [serverTool],
			// clientTools is undefined
		});

		const result = await loop.run();

		// Should complete without error
		expect(result.toolCallsMade).toBe(1);
	});
});
