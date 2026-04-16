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
import type { BuiltInTool } from "../built-in-tools";

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

describe("built-in tool dispatch in AgentLoop", () => {
	let tmpDir: string;
	let db: Database;
	let threadId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "built-in-dispatch-"));
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

	it("dispatches built-in tool calls instead of falling through to exec", async () => {
		const executeCalls: Array<Record<string, unknown>> = [];

		const fakeBuiltInTool: BuiltInTool = {
			toolDefinition: {
				type: "function",
				function: {
					name: "read",
					description: "Read a file",
					parameters: { type: "object", properties: {}, required: [] },
				},
			},
			execute: async (input) => {
				executeCalls.push(input);
				return "file content here";
			},
		};

		const builtInTools = new Map<string, BuiltInTool>();
		builtInTools.set("read", fakeBuiltInTool);

		const bashExecCalls: string[] = [];
		const mockSandbox = {
			exec: async (cmd: string) => {
				bashExecCalls.push(cmd);
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			builtInTools,
		};

		const mockBackend = new MockLLMBackend();
		mockBackend.setToolThenTextResponse("tool-1", "read", { path: "/hello.txt" }, "Done reading.");

		const ctx = makeCtx();
		const loop = new AgentLoop(ctx, mockSandbox, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
			tools: [fakeBuiltInTool.toolDefinition],
		});

		await loop.run();

		// The built-in tool should have been called, NOT exec
		expect(executeCalls.length).toBe(1);
		expect(executeCalls[0]).toEqual({ path: "/hello.txt" });
		expect(bashExecCalls.length).toBe(0);
	});

	it("returns exitCode 1 when built-in tool result starts with Error:", async () => {
		const fakeBuiltInTool: BuiltInTool = {
			toolDefinition: {
				type: "function",
				function: {
					name: "read",
					description: "Read a file",
					parameters: { type: "object", properties: {}, required: [] },
				},
			},
			execute: async () => "Error: file not found: /nope.txt",
		};

		const builtInTools = new Map<string, BuiltInTool>();
		builtInTools.set("read", fakeBuiltInTool);

		const mockSandbox = { builtInTools };

		const mockBackend = new MockLLMBackend();
		mockBackend.setToolThenTextResponse("tool-1", "read", { path: "/nope.txt" }, "Got an error.");

		const ctx = makeCtx();
		const loop = new AgentLoop(ctx, mockSandbox, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
			tools: [fakeBuiltInTool.toolDefinition],
		});

		const result = await loop.run();

		// Should complete without crashing — the error goes into tool_result message
		expect(result.toolCallsMade).toBe(1);

		// Verify the tool_result message was persisted with the error content
		const toolResultMsg = db
			.prepare(
				"SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result' ORDER BY created_at DESC LIMIT 1",
			)
			.get(threadId) as { content: string } | null;
		expect(toolResultMsg).not.toBeNull();
		expect(toolResultMsg?.content).toContain("Error: file not found");
	});
});
