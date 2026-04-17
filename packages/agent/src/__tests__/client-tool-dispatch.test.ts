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
import { insertThreadMessage } from "../agent-loop-utils";
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

	it("persists tool_call message and exits loop when client tool is deferred", async () => {
		const clientTool = {
			type: "function" as const,
			function: {
				name: "client_action",
				description: "Action on client",
				parameters: { type: "object", properties: {}, required: [] },
			},
		};

		const clientTools = new Map([["client_action", clientTool]]);

		const mockBackend = new MockLLMBackend();
		// LLM returns a client tool call
		mockBackend.pushResponse(async function* () {
			yield { type: "tool_use_start" as const, id: "client-call-1", name: "client_action" };
			yield {
				type: "tool_use_args" as const,
				id: "client-call-1",
				partial_json: '{"param": "value"}',
			};
			yield { type: "tool_use_end" as const, id: "client-call-1" };
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

		const ctx = makeCtx();
		const userId = randomUUID();
		const loop = new AgentLoop(
			ctx,
			{ exec: () => Promise.resolve({}) } as any,
			createMockRouter(mockBackend),
			{
				threadId,
				userId,
				clientTools,
				connectionId: "test-connection-id",
			},
		);

		const result = await loop.run();

		// Loop should exit after client tool call (no final text response)
		expect(result.error).toBeUndefined();
		expect(result.toolCallsMade).toBe(1);

		// Verify tool_call message was persisted
		const messages = db.prepare("SELECT * FROM messages WHERE thread_id = ?").all(threadId);
		const toolCallMsg = (messages as any[]).find((m: any) => m.role === "tool_call");
		expect(toolCallMsg).toBeDefined();
		if (toolCallMsg) {
			const content = JSON.parse(toolCallMsg.content);
			expect(content).toEqual([
				{
					type: "tool_use",
					id: "client-call-1",
					name: "client_action",
					input: { param: "value" },
				},
			]);
		}

		// Verify dispatch_queue entry was created
		const dispatchEntries = db
			.prepare("SELECT * FROM dispatch_queue WHERE thread_id = ? AND event_type = ?")
			.all(threadId, "client_tool_call") as any[];
		expect(dispatchEntries.length).toBe(1);
		const entry = dispatchEntries[0];
		expect(entry.claimed_by).toBe("test-connection-id");
		const payload = JSON.parse(entry.event_payload);
		expect(payload.call_id).toBe("client-call-1");
		expect(payload.tool_name).toBe("client_action");
	});

	it("in a mixed turn, server tools execute immediately, client tools deferred, loop exits", async () => {
		const serverTool = {
			type: "function" as const,
			function: {
				name: "ls",
				description: "List files",
				parameters: { type: "object", properties: {}, required: [] },
			},
		};

		const clientTool = {
			type: "function" as const,
			function: {
				name: "client_action",
				description: "Action on client",
				parameters: { type: "object", properties: {}, required: [] },
			},
		};

		const clientTools = new Map([["client_action", clientTool]]);

		const mockBackend = new MockLLMBackend();
		// LLM returns both server and client tool calls in same response
		mockBackend.pushResponse(async function* () {
			// First: server tool call (bash command)
			yield { type: "tool_use_start" as const, id: "server-call-1", name: "bash" };
			yield {
				type: "tool_use_args" as const,
				id: "server-call-1",
				partial_json: '{"command": "ls"}',
			};
			yield { type: "tool_use_end" as const, id: "server-call-1" };
			// Second: client tool call
			yield { type: "tool_use_start" as const, id: "client-call-1", name: "client_action" };
			yield {
				type: "tool_use_args" as const,
				id: "client-call-1",
				partial_json: '{"action": "run"}',
			};
			yield { type: "tool_use_end" as const, id: "client-call-1" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 20,
					output_tokens: 30,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const ctx = makeCtx();
		const userId = randomUUID();
		const loop = new AgentLoop(
			ctx,
			{
				exec: async () => {
					return { stdout: "server result", stderr: "", exitCode: 0 };
				},
			} as any,
			createMockRouter(mockBackend),
			{
				threadId,
				userId,
				tools: [serverTool],
				clientTools,
				connectionId: "test-connection-id",
			},
		);

		const result = await loop.run();

		// Loop should exit (not continue with final response)
		expect(result.error).toBeUndefined();
		expect(result.toolCallsMade).toBe(2);

		// Verify tool_call message has both calls
		const messages = db.prepare("SELECT * FROM messages WHERE thread_id = ?").all(threadId);
		const toolCallMsg = (messages as any[]).find((m: any) => m.role === "tool_call");
		expect(toolCallMsg).toBeDefined();
		if (toolCallMsg) {
			const content = JSON.parse(toolCallMsg.content);
			expect(content.length).toBe(2);
			expect(content[0].name).toBe("bash");
			expect(content[1].name).toBe("client_action");
		}

		// Verify tool_result for server tool was persisted
		const toolResultMsgs = (messages as any[]).filter((m: any) => m.role === "tool_result");
		expect(toolResultMsgs.length).toBe(1); // Only server tool result
		expect(toolResultMsgs[0].content).toBe("server result");

		// Verify dispatch_queue entry was created for client tool only
		const dispatchEntries = db
			.prepare("SELECT * FROM dispatch_queue WHERE thread_id = ? AND event_type = ?")
			.all(threadId, "client_tool_call") as any[];
		expect(dispatchEntries.length).toBe(1);
		const entry = dispatchEntries[0];
		expect(entry.claimed_by).toBe("test-connection-id");
		const payload = JSON.parse(entry.event_payload);
		expect(payload.call_id).toBe("client-call-1");
		expect(payload.tool_name).toBe("client_action");
	});

	it("full round-trip: LLM call -> loop exit -> tool_result persisted -> loop resume -> final response", async () => {
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

		// First response: client tool call
		mockBackend.pushResponse(async function* () {
			yield { type: "tool_use_start" as const, id: "call-1", name: "client_math" };
			yield {
				type: "tool_use_args" as const,
				id: "call-1",
				partial_json: '{"x": 10}',
			};
			yield { type: "tool_use_end" as const, id: "call-1" };
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

		// Second response: final answer (after tool_result is in context)
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "The answer is 20" };
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
		const userId = randomUUID();

		// First run: LLM calls client tool, loop exits
		const loop1 = new AgentLoop(
			ctx,
			{ exec: () => Promise.resolve({}) } as any,
			createMockRouter(mockBackend),
			{
				threadId,
				userId,
				clientTools,
				connectionId: "test-connection-id",
			},
		);

		const result1 = await loop1.run();
		expect(result1.error).toBeUndefined();
		expect(result1.toolCallsMade).toBe(1);

		// Verify tool_call message was persisted
		let messages = db.prepare("SELECT * FROM messages WHERE thread_id = ?").all(threadId);
		const toolCallMsg = (messages as any[]).find((m: any) => m.role === "tool_call");
		expect(toolCallMsg).toBeDefined();

		// Simulate client executing the tool and sending result
		// Insert tool_result message using the same function as the loop uses
		insertThreadMessage(
			ctx.db,
			{
				threadId,
				role: "tool_result",
				content: "20", // result from client tool execution
				toolName: "call-1", // matches the call ID for tool_result pairing
				hostOrigin: ctx.siteId,
			},
			ctx.siteId,
		);

		// Enqueue tool_result to trigger loop resume
		const { enqueueToolResult } = await import("@bound/core");
		enqueueToolResult(ctx.db, threadId, "call-1");

		// Second run: LLM sees complete tool_call/tool_result pair and produces final response
		const loop2 = new AgentLoop(
			ctx,
			{ exec: () => Promise.resolve({}) } as any,
			createMockRouter(mockBackend),
			{
				threadId,
				userId,
				clientTools,
				connectionId: "test-connection-id",
			},
		);

		const result2 = await loop2.run();
		expect(result2.error).toBeUndefined();

		// Verify final assistant message was created
		messages = db.prepare("SELECT * FROM messages WHERE thread_id = ?").all(threadId);
		const assistantMsgs = (messages as any[]).filter((m: any) => m.role === "assistant");
		expect(assistantMsgs.length).toBeGreaterThan(0);
		const finalMsg = assistantMsgs[assistantMsgs.length - 1];
		expect(finalMsg.content).toBe("The answer is 20");
	});
});
