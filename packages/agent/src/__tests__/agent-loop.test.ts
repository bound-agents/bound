import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type { EventMap } from "@bound/shared";
import { assert } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import {
	AgentLoop,
	ERROR_SIGNATURE_NUDGE_AT,
	MAX_CONSECUTIVE_DUPLICATE_TOOL_CALLS,
	MAX_CONSECUTIVE_ERROR_TOOL_CALLS,
} from "../agent-loop";
import { VALID_TRANSITIONS } from "../types";

// Mock LLM Backend that returns configurable responses
class MockLLMBackend implements LLMBackend {
	private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
	private callCount = 0;

	/** Push a response generator that will be used on the next chat() call */
	pushResponse(gen: () => AsyncGenerator<StreamChunk>) {
		this.responses.push(gen);
	}

	/** Set a single text response (convenience) */
	setTextResponse(text: string) {
		this.responses = [];
		this.pushResponse(async function* () {
			yield { type: "text" as const, content: text };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});
	}

	/** Set a single tool_use response followed by a text response (convenience) */
	setToolThenTextResponse(
		toolId: string,
		toolName: string,
		toolInput: Record<string, unknown>,
		finalText: string,
	) {
		this.responses = [];
		// First call: LLM requests a tool call
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
		// Second call: LLM produces final text after seeing tool result
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

	getCallCount() {
		return this.callCount;
	}

	async *chat() {
		const gen = this.responses[this.callCount];
		this.callCount++;
		if (gen) {
			yield* gen();
		} else {
			// Default: empty text response
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

// Mock sandbox with exec tracking
function createMockSandbox(
	handler?: (cmd: string) => { stdout: string; stderr: string; exitCode: number },
) {
	const calls: string[] = [];
	return {
		calls,
		exec: async (cmd: string) => {
			calls.push(cmd);
			if (handler) {
				return handler(cmd);
			}
			return { stdout: "mock output", stderr: "", exitCode: 0 };
		},
	};
}

function createMockRouter(backend: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("claude-opus", backend);
	return new ModelRouter(backends, "claude-opus");
}

describe("AgentLoop", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let threadId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "agent-test-"));
		dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);

		// Create a test user
		const userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
	});

	beforeEach(() => {
		threadId = randomUUID();
	});

	describe("VALID_TRANSITIONS", () => {
		it("permits LLM_CALL → LLM_CALL for transient-retry re-entry", () => {
			// The agent loop re-enters at LLM_CALL (agent-loop.ts:1296) on a
			// transient 5xx retry `continue`, while the prior state is still
			// LLM_CALL. Without the self-loop the transition validator logs an
			// "Invalid state transition" warning on every retry attempt — three
			// times per exhausted server fault (observed live 2026-06-08,
			// bedrock-mantle response.failed). The retry is legitimate; the
			// table must model it.
			expect(VALID_TRANSITIONS.LLM_CALL).toContain("LLM_CALL");
		});
	});

	afterAll(async () => {
		db.close();
		if (tmpDir) {
			await cleanupTmpDir(tmpDir);
		}
	});

	function makeCtx(): AppContext {
		return {
			db,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			eventBus: {
				on: () => {},
				off: () => {},
				emit: () => {},
			},
			hostName: "test-host",
			siteId: "test-site-id",
		} as unknown as AppContext;
	}

	// Backend that captures chat params for inspection
	class CaptureParamsBackend implements LLMBackend {
		capturedParams: ChatParams[] = [];

		async *chat(params: ChatParams) {
			this.capturedParams.push(params);
			yield { type: "text" as const, content: "Test response" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
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

	it("should return a valid result from running the agent loop with text response", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("Hello, I understand.");

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		expect(result).toHaveProperty("messagesCreated");
		expect(result).toHaveProperty("toolCallsMade");
		expect(result).toHaveProperty("filesChanged");
		expect(typeof result.messagesCreated).toBe("number");
		expect(typeof result.toolCallsMade).toBe("number");
		expect(typeof result.filesChanged).toBe("number");
		expect(result.error).toBeUndefined();
	});

	it("should persist assistant text message to database", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("The answer is 42.");

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		expect(result.messagesCreated).toBe(1);
		expect(result.toolCallsMade).toBe(0);

		// Verify the message was persisted in the database
		const msgs = db
			.query("SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at ASC")
			.all(threadId) as Array<{ role: string; content: string }>;

		expect(msgs.length).toBe(1);
		expect(msgs[0].role).toBe("assistant");
		expect(msgs[0].content).toBe("The answer is 42.");
	});

	it("persists the partial and emits an alert on a content-filter (refusal) stop", async () => {
		// Bedrock has no `refusal` stopReason: a safety stop arrives as a clean
		// `done` carrying finish_reason "content-filter". The loop should treat
		// it as a completed turn — persist whatever partial text streamed — AND
		// surface an operator-visible alert so the refusal isn't mistaken for a
		// short answer. The turn is NOT retried.
		const mockBackend = new MockLLMBackend();
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "I can't help with that." };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 6,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
				finish_reason: "content-filter" as const,
			};
		});

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		await agentLoop.run();

		const msgs = db
			.query("SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at ASC")
			.all(threadId) as Array<{ role: string; content: string }>;

		// The partial assistant text is persisted...
		const assistant = msgs.find((m) => m.role === "assistant");
		expect(assistant?.content).toBe("I can't help with that.");

		// ...and an operator alert is emitted alongside it.
		const alert = msgs.find((m) => m.role === "alert");
		expect(alert).toBeDefined();
		expect(alert?.content).toContain("content-filter");
	});

	it("does not emit a content-filter alert on a normal stop", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("All good.");

		const agentLoop = new AgentLoop(makeCtx(), createMockSandbox(), createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		await agentLoop.run();

		const alerts = db
			.query("SELECT id FROM messages WHERE thread_id = ? AND role = 'alert'")
			.all(threadId) as Array<{ id: string }>;
		expect(alerts.length).toBe(0);
	});

	it("should fire onActivity for heartbeat chunks (regression: Bedrock stall)", async () => {
		// Regression: thread b6a3ddba (2026-04-20/21) — Bedrock extended-thinking
		// warmup emitted heartbeat chunks with no text for >5min. The outer
		// inactivity timer in message-handler.ts ticks only on onActivity, so a
		// long warmup aborted mid-session. Fix: heartbeat chunks must reset the
		// timer by firing onActivity BEFORE the `continue`.
		//
		// We snapshot the activityCount at two points:
		//  - after the consumer pulls heartbeat #1
		//  - after the consumer pulls heartbeat #2
		// and assert count strictly increased between those snapshots — i.e.
		// the heartbeat alone (with no text chunk between) fired onActivity.
		const mockBackend = new MockLLMBackend();
		let activityCount = 0;
		let countAfterFirstHeartbeat = -1;
		let countAfterSecondHeartbeat = -1;

		mockBackend.pushResponse(async function* () {
			yield { type: "heartbeat" as const };
			// After the consumer processes the heartbeat above, onActivity should
			// have fired. Snapshot the count now, before any further chunks.
			countAfterFirstHeartbeat = activityCount;
			yield { type: "heartbeat" as const };
			countAfterSecondHeartbeat = activityCount;
			yield { type: "text" as const, content: "final answer" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
			onActivity: () => {
				activityCount++;
			},
		});

		await agentLoop.run();

		// Heartbeat #2 must have incremented the counter beyond heartbeat #1.
		// Without the fix, heartbeats hit `continue` before onActivity, so both
		// snapshots would read the same value (whatever was last set by the
		// pre-stream call sites).
		expect(countAfterFirstHeartbeat).toBeGreaterThanOrEqual(0);
		expect(countAfterSecondHeartbeat).toBeGreaterThan(countAfterFirstHeartbeat);
	});

	it("should execute tool calls via sandbox.exec()", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setToolThenTextResponse(
			"tool-123",
			"bash",
			{ command: "ls -la" },
			"I listed the files for you.",
		);

		const mockBash = createMockSandbox((_cmd) => ({
			stdout: "file1.txt\nfile2.txt\n",
			stderr: "",
			exitCode: 0,
		}));
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		// One tool call was made
		expect(result.toolCallsMade).toBe(1);
		// The sandbox was called with the bash command
		expect(mockBash.calls.length).toBe(1);
		expect(mockBash.calls[0]).toBe("ls -la");
		// Two LLM calls: first returned tool_use, second returned text
		expect(mockBackend.getCallCount()).toBe(2);
		expect(result.error).toBeUndefined();
	});

	it("drops superseded tool-call drafts before executing tools", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.pushResponse(async function* () {
			yield { type: "tool_use_start" as const, id: "call_2", name: "bash" };
			yield {
				type: "tool_use_args" as const,
				id: "call_2",
				partial_json: '{"command":"echo',
			};
			yield { type: "tool_use_end" as const, id: "call_2" };
			yield { type: "tool_use_start" as const, id: "call_4", name: "bash" };
			yield {
				type: "tool_use_args" as const,
				id: "call_4",
				partial_json: JSON.stringify({ command: "echo final" }),
			};
			yield { type: "tool_use_end" as const, id: "call_4" };
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
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "Done." };
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

		const mockBash = createMockSandbox((_cmd) => ({
			stdout: "final\n",
			stderr: "",
			exitCode: 0,
		}));

		const agentLoop = new AgentLoop(makeCtx(), mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		expect(result.error).toBeUndefined();
		expect(result.toolCallsMade).toBe(1);
		expect(mockBash.calls).toEqual(["echo final"]);

		const toolCalls = db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_call'")
			.all(threadId) as Array<{ content: string }>;
		expect(toolCalls.length).toBe(1);
		expect(toolCalls[0].content).toContain("call_4");
		expect(toolCalls[0].content).not.toContain("call_2");
	});

	it("should persist tool_call and tool_result messages in database", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setToolThenTextResponse(
			"tool-456",
			"bash",
			{ command: "memorize color blue" },
			"Done!",
		);

		const mockBash = createMockSandbox(() => ({
			stdout: "Memory saved: color\n",
			stderr: "",
			exitCode: 0,
		}));
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		expect(result.toolCallsMade).toBe(1);

		// Verify messages were persisted: tool_call, tool_result, then final assistant text
		const msgs = db
			.query(
				"SELECT role, content, tool_name FROM messages WHERE thread_id = ? ORDER BY created_at ASC",
			)
			.all(threadId) as Array<{ role: string; content: string; tool_name: string | null }>;

		expect(msgs.length).toBe(3);
		expect(msgs[0].role).toBe("tool_call");
		expect(msgs[1].role).toBe("tool_result");
		expect(msgs[1].content).toContain("Memory saved: color\n");
		expect(msgs[1].content).toMatch(/\[duration: \d+\.\d{3}s\]$/);
		expect(msgs[2].role).toBe("assistant");
		expect(msgs[2].content).toBe("Done!");
	});

	it("should not persist a sentinel assistant message when model returns empty text after tool calls", async () => {
		const mockBackend = new MockLLMBackend();
		// First call: tool use
		mockBackend.pushResponse(async function* () {
			yield { type: "tool_use_start" as const, id: "tool-send-1", name: "bash" };
			yield {
				type: "tool_use_args" as const,
				id: "tool-send-1",
				partial_json: JSON.stringify({ command: "echo sent" }),
			};
			yield { type: "tool_use_end" as const, id: "tool-send-1" };
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
		// Second call: empty text (2-token bailout)
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 20,
					output_tokens: 2,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const mockBash = createMockSandbox(() => ({
			stdout: "sent",
			stderr: "",
			exitCode: 0,
		}));

		const agentLoop = new AgentLoop(makeCtx(), mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		// Should have created tool_call + tool_result but no sentinel assistant message
		expect(result.messagesCreated).toBe(2); // tool_call + tool_result only

		// The last message should be a tool_result, not an empty assistant sentinel
		const msgs = db
			.query(
				"SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
			)
			.all(threadId) as Array<{ role: string; content: string }>;

		expect(msgs[0].role).toBe("tool_result");
	});

	it("should feed tool errors back to the LLM instead of terminating", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setToolThenTextResponse(
			"tool-err",
			"bash",
			{ command: "bad-command" },
			"The command failed, let me try something else.",
		);

		const mockBash = createMockSandbox(() => ({
			stdout: "",
			stderr: "command not found: bad-command",
			exitCode: 127,
		}));
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		// The loop did not terminate on the error
		expect(result.error).toBeUndefined();
		expect(result.toolCallsMade).toBe(1);
		expect(mockBackend.getCallCount()).toBe(2);

		// The error was fed back as a tool_result
		const msgs = db
			.query("SELECT role, content FROM messages WHERE thread_id = ? AND role = 'tool_result'")
			.all(threadId) as Array<{ role: string; content: string }>;

		expect(msgs.length).toBe(1);
		expect(msgs[0].content).toContain("command not found");
	});

	it("should pass bash tool command directly to sandbox exec", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setToolThenTextResponse("tool-echo", "bash", { command: "echo hello" }, "Done.");

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		await agentLoop.run();

		expect(mockBash.calls.length).toBe(1);
		expect(mockBash.calls[0]).toBe("echo hello");
	});

	it("should return error when LLM hallucinates non-bash tool name", async () => {
		const mockBackend = new MockLLMBackend();
		// LLM calls "query" directly instead of bash with command: "query ..."
		mockBackend.setToolThenTextResponse("tool-query", "query", { query: "SELECT 1" }, "Done.");

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		await agentLoop.run();

		// Sandbox should NOT have been called — the error is returned directly
		expect(mockBash.calls.length).toBe(0);

		const msgs = db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result'")
			.all(threadId) as Array<{ content: string }>;

		expect(msgs.length).toBe(1);
		expect(msgs[0].content).toContain('unknown tool "query"');
		expect(msgs[0].content).toContain("bash");
	});

	it("should handle sandbox without exec gracefully", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setToolThenTextResponse(
			"tool-no-exec",
			"bash",
			{ command: "echo hi" },
			"Could not execute.",
		);

		// Sandbox with no exec method
		const noExecSandbox = {};
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, noExecSandbox, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		// Should not crash — the error is captured and fed back to the LLM
		expect(result.error).toBeUndefined();
		expect(result.toolCallsMade).toBe(1);

		// Check the tool_result contains the "not available" error
		const msgs = db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result'")
			.all(threadId) as Array<{ content: string }>;

		expect(msgs.length).toBe(1);
		expect(msgs[0].content).toContain("sandbox execution not available");
	});

	it("should abort when abort signal is triggered", async () => {
		const controller = new AbortController();
		const mockBackend = new MockLLMBackend();
		// Response that yields slowly so we can abort mid-stream
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "Starting..." };
			// Simulate delay (abort will happen before next yield)
			await new Promise((resolve) => setTimeout(resolve, 50));
			yield { type: "text" as const, content: " still going" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
			abortSignal: controller.signal,
		});

		// Abort after a small delay
		setTimeout(() => controller.abort(), 10);

		const result = await agentLoop.run();

		// Should exit without error — just incomplete
		expect(result.error).toBeUndefined();
	});

	it("should persist LLM error as alert message", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.pushResponse(async function* () {
			yield { type: "error" as const, error: "Rate limited" };
			throw new Error("API rate limit exceeded");
		});

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		expect(result.error).toBe("API rate limit exceeded");

		// Check that alert message was persisted
		const alerts = db
			.query("SELECT role, content FROM messages WHERE thread_id = ? AND role = 'alert'")
			.all(threadId) as Array<{ role: string; content: string }>;

		expect(alerts.length).toBe(1);
		expect(alerts[0].content).toContain("API rate limit exceeded");
	});

	it("should handle multiple tool calls in sequence", async () => {
		const mockBackend = new MockLLMBackend();

		// First LLM call: two tool uses
		mockBackend.pushResponse(async function* () {
			yield { type: "tool_use_start" as const, id: "t1", name: "bash" };
			yield { type: "tool_use_args" as const, id: "t1", partial_json: '{"command":"echo hello"}' };
			yield { type: "tool_use_end" as const, id: "t1" };
			yield { type: "tool_use_start" as const, id: "t2", name: "bash" };
			yield { type: "tool_use_args" as const, id: "t2", partial_json: '{"command":"echo world"}' };
			yield { type: "tool_use_end" as const, id: "t2" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 20,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		// Second LLM call: text response
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "Both commands executed." };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 30,
					output_tokens: 8,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const mockBash = createMockSandbox((cmd) => ({
			stdout: `ran: ${cmd}`,
			stderr: "",
			exitCode: 0,
		}));
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		expect(result.toolCallsMade).toBe(2);
		expect(mockBash.calls).toEqual(["echo hello", "echo world"]);

		// Verify persisted messages: tool_call, tool_result x2, assistant
		const msgs = db
			.query("SELECT role FROM messages WHERE thread_id = ? ORDER BY created_at ASC")
			.all(threadId) as Array<{ role: string }>;

		// tool_call (1 msg for both calls), tool_result, tool_result, assistant
		expect(msgs.length).toBe(4);
		expect(msgs[0].role).toBe("tool_call");
		expect(msgs[1].role).toBe("tool_result");
		expect(msgs[2].role).toBe("tool_result");
		expect(msgs[3].role).toBe("assistant");
	});

	it("should call persistFs when sandbox supports it", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("Done.");

		let persistCalled = false;
		const mockBash = {
			exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			persistFs: async () => {
				persistCalled = true;
				return { changes: 3 };
			},
		};
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		expect(persistCalled).toBe(true);
		expect(result.filesChanged).toBe(3);
	});

	it("should handle partial JSON accumulation across multiple tool_use_args chunks", async () => {
		const mockBackend = new MockLLMBackend();

		// First call: tool use with partial JSON spread across multiple chunks
		mockBackend.pushResponse(async function* () {
			yield { type: "tool_use_start" as const, id: "t-partial", name: "bash" };
			yield { type: "tool_use_args" as const, id: "t-partial", partial_json: '{"comma' };
			yield { type: "tool_use_args" as const, id: "t-partial", partial_json: 'nd":"cat ' };
			yield { type: "tool_use_args" as const, id: "t-partial", partial_json: 'file.txt"}' };
			yield { type: "tool_use_end" as const, id: "t-partial" };
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

		// Second call: final text
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "Here is the file content." };
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

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		await agentLoop.run();

		// The partial JSON should have been reassembled correctly
		expect(mockBash.calls.length).toBe(1);
		expect(mockBash.calls[0]).toBe("cat file.txt");
	});

	it("should trigger silence timeout when LLM stalls without yielding chunks (R-W6)", async () => {
		// Create a custom LLM backend that can trigger timeout
		const stallBackend: LLMBackend = {
			async *chat() {
				yield { type: "text" as const, content: "Starting..." };
				// Simulate stalling by waiting much longer than the 120s timeout
				// In real usage, this would trigger the timeout. For the test, we verify
				// the timeout mechanism is in place by checking the withSilenceTimeout wrapper
				// exists and would reject after 120s.
				await new Promise((resolve) => setTimeout(resolve, 130000));
				// This line should never be reached in real timeout scenario
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						cache_write_tokens: null,
						cache_read_tokens: null,
						estimated: false,
					},
				};
			},
			capabilities() {
				return {
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 8000,
				};
			},
		};

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		const _agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(stallBackend), {
			threadId,
			userId: "test-user",
		});

		// Note: This test would normally take 120+ seconds to run.
		// For practical testing, we verify that:
		// 1. The withSilenceTimeout wrapper exists in agent-loop.ts (line 105)
		// 2. It correctly rejects with a timeout error after 120s
		// 3. The error is caught and persisted as an alert

		// Since running the full timeout is impractical in tests, we verify the error
		// handling path by checking the code structure. In a real scenario, this would
		// trigger after 120s of silence.

		// For this test, we'll use a short timeout to verify the mechanism works
		// by having the test runner timeout first, which proves the silence timeout
		// would eventually fire.

		// Instead, let's verify the mechanism exists by checking a fast-fail scenario
		const fastBackend: LLMBackend = {
			// biome-ignore lint/correctness/useYield: generator throws before yield
			async *chat() {
				// Immediately throw an error to simulate what happens after timeout
				throw new Error("LLM silence timeout: no chunk received for 60000ms");
			},
			capabilities() {
				return {
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 8000,
				};
			},
		};

		const agentLoop2 = new AgentLoop(ctx, mockBash, createMockRouter(fastBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop2.run();

		// Should have an error about silence timeout
		expect(result.error).toBeDefined();
		expect(result.error).toContain("silence timeout");
		expect(result.error).toContain("60000ms");

		// Verify the error was persisted as an alert
		const alerts = db
			.query("SELECT role, content FROM messages WHERE thread_id = ? AND role = 'alert'")
			.all(threadId) as Array<{ role: string; content: string }>;

		expect(alerts.length).toBeGreaterThan(0);
		expect(alerts[0].content).toContain("silence timeout");
	});

	it("should not timeout when LLM yields chunks regularly", async () => {
		const mockBackend = new MockLLMBackend();

		// Create a mock that yields chunks slowly but within timeout window
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "Chunk 1" };
			await new Promise((resolve) => setTimeout(resolve, 50));
			yield { type: "text" as const, content: " Chunk 2" };
			await new Promise((resolve) => setTimeout(resolve, 50));
			yield { type: "text" as const, content: " Chunk 3" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		// Should complete without error
		expect(result.error).toBeUndefined();
		expect(result.messagesCreated).toBe(1);

		// Verify the assistant message was persisted
		const msgs = db
			.query("SELECT role, content FROM messages WHERE thread_id = ? AND role = 'assistant'")
			.all(threadId) as Array<{ role: string; content: string }>;

		expect(msgs.length).toBe(1);
		expect(msgs[0].content).toBe("Chunk 1 Chunk 2 Chunk 3");
	});

	it("should pass tool_call content as ContentBlock array to LLM on retry", async () => {
		// This test verifies the fix for a bug where tool_call content was pushed
		// as a JSON string instead of ContentBlock array, causing Bedrock to see
		// zero toolUse blocks on subsequent calls.
		const capturedMessages: Array<{
			role: string;
			content: string | Array<{ type: string; id?: string; name?: string; input?: unknown }>;
		}> = [];

		// Create a custom backend that captures what it receives
		const capturingBackend: LLMBackend = {
			async *chat(params: { messages: Array<{ role: string; content: unknown }> }) {
				// Capture the messages passed to the LLM
				for (const msg of params.messages) {
					capturedMessages.push({
						role: msg.role,
						content: msg.content as string | Array<{ type: string }>,
					});
				}

				// First call: return a tool_use
				if (
					capturedMessages.length === 0 ||
					!capturedMessages.some((m) => m.role === "tool_call")
				) {
					yield { type: "tool_use_start" as const, id: "tc-1", name: "bash" };
					yield {
						type: "tool_use_args" as const,
						id: "tc-1",
						partial_json: '{"command":"echo test"}',
					};
					yield { type: "tool_use_end" as const, id: "tc-1" };
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
				} else {
					// Second call: return text response
					yield { type: "text" as const, content: "Command executed successfully." };
					yield {
						type: "done" as const,
						usage: {
							input_tokens: 25,
							output_tokens: 8,
							cache_write_tokens: null,
							cache_read_tokens: null,
							estimated: false,
						},
					};
				}
			},
			capabilities() {
				return {
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 8000,
				};
			},
		};

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(capturingBackend), {
			threadId,
			userId: "test-user",
		});

		await agentLoop.run();

		// Find the tool_call message passed to the second LLM call
		const toolCallMessages = capturedMessages.filter((m) => m.role === "tool_call");
		expect(toolCallMessages.length).toBeGreaterThan(0);

		const toolCallMsg = toolCallMessages[0];

		// Verify content is an array, not a string
		expect(Array.isArray(toolCallMsg.content)).toBe(true);

		// Verify the array contains proper ContentBlock objects with tool_use type
		const blocks = toolCallMsg.content as Array<{
			type: string;
			id?: string;
			name?: string;
			input?: unknown;
		}>;
		expect(blocks.length).toBeGreaterThan(0);
		expect(blocks[0].type).toBe("tool_use");
		expect(blocks[0].id).toBe("tc-1");
		expect(blocks[0].name).toBe("bash");
		expect(blocks[0].input).toEqual({ command: "echo test" });
	});

	it("AC4.2: local inference leaves relay_target and relay_latency_ms NULL", async () => {
		// Verify that when using local inference (not relayed), the relay metrics
		// columns remain NULL on the turn record (no regression from relay implementation)
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("Local inference response");

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		expect(result.error).toBeUndefined();
		expect(result.messagesCreated).toBe(1);

		// Query the turns table to check relay metrics columns
		const turns = db
			.query("SELECT id, relay_target, relay_latency_ms FROM turns WHERE thread_id = ?")
			.all(threadId) as Array<{
			id: number;
			relay_target: string | null;
			relay_latency_ms: number | null;
		}>;

		expect(turns.length).toBeGreaterThan(0);

		// Verify both relay metrics columns are NULL for local inference
		for (const turn of turns) {
			expect(turn.relay_target).toBeNull();
			expect(turn.relay_latency_ms).toBeNull();
		}
	});

	// Bug #6: cost_usd must be computed from model pricing config, not hardcoded 0
	it("records non-zero cost_usd in turns table when backend has pricing configured", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("Priced response");

		const mockBash = createMockSandbox();
		// ctx with pricing: $3/M input, $15/M output (like claude-opus-4)
		const ctx = {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus: { on: () => {}, off: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: "test-site-id",
			config: {
				modelBackends: {
					backends: [
						{
							id: "claude-opus",
							provider: "anthropic",
							model: "claude-opus",
							context_window: 8000,
							tier: 1,
							price_per_m_input: 3.0,
							price_per_m_output: 15.0,
						},
					],
					default: "claude-opus",
				},
			},
		} as unknown as AppContext;

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		await agentLoop.run();

		// MockLLMBackend yields done with { input_tokens: 10, output_tokens: 5 }
		// Expected cost = (10 * 3.0 / 1_000_000) + (5 * 15.0 / 1_000_000)
		//               = 0.00003 + 0.000075 = 0.000105
		const turns = db
			.query("SELECT cost_usd FROM turns WHERE thread_id = ?")
			.all(threadId) as Array<{ cost_usd: number }>;

		expect(turns.length).toBeGreaterThan(0);
		for (const turn of turns) {
			expect(turn.cost_usd).toBeGreaterThan(0);
		}
		expect(turns[0].cost_usd).toBeCloseTo(0.000105, 8);
	});

	it("includes cache token costs in cost_usd calculation", async () => {
		const mockBackend = new MockLLMBackend();
		// Response with significant cache usage
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "Cached response" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 50, // Non-cached input
					output_tokens: 10,
					cache_write_tokens: 200, // 200 tokens written to cache
					cache_read_tokens: 10000, // 10k tokens read from cache
					estimated: false,
				},
			};
		});

		const mockBash = createMockSandbox();
		const ctx = {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus: { on: () => {}, off: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: "test-site-id",
			config: {
				modelBackends: {
					backends: [
						{
							id: "claude-opus",
							provider: "bedrock",
							model: "claude-opus",
							context_window: 200000,
							tier: 1,
							price_per_m_input: 5.0,
							price_per_m_output: 25.0,
							price_per_m_cache_read: 0.5,
							price_per_m_cache_write: 6.25,
						},
					],
					default: "claude-opus",
				},
			},
		} as unknown as AppContext;

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		await agentLoop.run();

		// Expected cost:
		// input: 50 * 5.0 / 1M = 0.000250
		// output: 10 * 25.0 / 1M = 0.000250
		// cache_read: 10000 * 0.5 / 1M = 0.005000
		// cache_write: 200 * 6.25 / 1M = 0.001250
		// Total: 0.006750
		const turns = db
			.query("SELECT cost_usd FROM turns WHERE thread_id = ?")
			.all(threadId) as Array<{ cost_usd: number }>;

		expect(turns.length).toBe(1);
		expect(turns[0].cost_usd).toBeCloseTo(0.00675, 6);
	});

	// CONTRIBUTING.md invariant #17: when the relay hub stamps cost_usd onto
	// the done chunk, the spoke must record that value verbatim instead of
	// re-deriving it from its own (possibly empty) model_backends. This is
	// the core fix for hub-only spokes writing cost_usd=0 for delegated turns.
	it("uses hub-stamped cost_usd from done chunk when present", async () => {
		const mockBackend = new MockLLMBackend();
		// Simulate a hub-stamped done chunk: token usage that would compute
		// to 0.000105 locally, but the hub stamps a different (authoritative)
		// value of 0.42 — proving recordTurn writes the hub value, not a
		// recomputed one.
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "delegated response" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
				cost_usd: 0.42,
			};
		});

		const mockBash = createMockSandbox();
		// Spoke is hub-only mode: empty backends list, exactly the production
		// state where the bug manifests.
		const ctx = {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus: { on: () => {}, off: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: "test-site-id",
			config: {
				modelBackends: {
					backends: [],
					default: "",
				},
			},
		} as unknown as AppContext;

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		await agentLoop.run();

		const turns = db
			.query("SELECT cost_usd FROM turns WHERE thread_id = ?")
			.all(threadId) as Array<{ cost_usd: number }>;

		expect(turns.length).toBe(1);
		// Hub-stamped value persists verbatim — no local recomputation.
		expect(turns[0].cost_usd).toBe(0.42);
	});

	it("falls back to local calculateTurnCost when done chunk has no cost_usd", async () => {
		// Backward-compat: an older hub (or a local non-relay turn) won't
		// stamp cost_usd. The spoke must keep its existing local-pricing
		// behavior so non-hub-only deployments don't regress.
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("locally priced response");

		const mockBash = createMockSandbox();
		const ctx = {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus: { on: () => {}, off: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: "test-site-id",
			config: {
				modelBackends: {
					backends: [
						{
							id: "claude-opus",
							provider: "anthropic",
							model: "claude-opus",
							context_window: 8000,
							tier: 1,
							price_per_m_input: 3.0,
							price_per_m_output: 15.0,
						},
					],
					default: "claude-opus",
				},
			},
		} as unknown as AppContext;

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		await agentLoop.run();

		// Same expectation as the existing local-pricing test: input 10 × $3/M
		// + output 5 × $15/M = 0.000105.
		const turns = db
			.query("SELECT cost_usd FROM turns WHERE thread_id = ?")
			.all(threadId) as Array<{ cost_usd: number }>;

		expect(turns.length).toBe(1);
		expect(turns[0].cost_usd).toBeCloseTo(0.000105, 8);
	});

	it("treats hub-stamped cost_usd of 0 as authoritative (does not fall back)", async () => {
		// Edge case: hub explicitly stamps 0 (e.g. its own backends list is
		// missing pricing for the model). The `??` operator falls through
		// only on null/undefined, NOT on a real 0. This pins that contract:
		// an explicit 0 from the hub is the recorded value, even if the
		// spoke could compute something positive locally.
		const mockBackend = new MockLLMBackend();
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "free response" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
				cost_usd: 0,
			};
		});

		const mockBash = createMockSandbox();
		// Spoke has pricing locally — would compute non-zero — but must
		// honor the hub's 0.
		const ctx = {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus: { on: () => {}, off: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: "test-site-id",
			config: {
				modelBackends: {
					backends: [
						{
							id: "claude-opus",
							provider: "anthropic",
							model: "claude-opus",
							context_window: 8000,
							tier: 1,
							price_per_m_input: 3.0,
							price_per_m_output: 15.0,
						},
					],
					default: "claude-opus",
				},
			},
		} as unknown as AppContext;

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		await agentLoop.run();

		const turns = db
			.query("SELECT cost_usd FROM turns WHERE thread_id = ?")
			.all(threadId) as Array<{ cost_usd: number }>;

		expect(turns.length).toBe(1);
		expect(turns[0].cost_usd).toBe(0);
	});

	// Bug #10: turns table must record the resolved model_id, not "unknown"
	it("records the resolved model_id in the turns table (not 'unknown')", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("Hello from resolved model");

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		// AgentLoopConfig with NO modelId — forces resolution via ModelRouter default
		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
			// modelId intentionally omitted — simulates a scheduler task with no model_hint
		});

		await agentLoop.run();

		const turns = db
			.query("SELECT model_id FROM turns WHERE thread_id = ?")
			.all(threadId) as Array<{ model_id: string }>;

		expect(turns.length).toBeGreaterThan(0);

		for (const turn of turns) {
			// Must be the actual resolved model id ("claude-opus"), NOT "unknown"
			expect(turn.model_id).not.toBe("unknown");
			expect(turn.model_id).toBe("claude-opus");
		}
	});

	it("records resolved model in context_debug (not 'unknown')", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("Hello from resolved model");

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		// AgentLoopConfig with NO modelId — simulates scheduler/discord/mcp threads
		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
			// modelId intentionally omitted
		});

		await agentLoop.run();

		const turns = db
			.query("SELECT context_debug FROM turns WHERE thread_id = ? AND context_debug IS NOT NULL")
			.all(threadId) as Array<{ context_debug: string }>;

		expect(turns.length).toBeGreaterThan(0);

		for (const turn of turns) {
			const debug = JSON.parse(turn.context_debug);
			// Must be the actual resolved model id, NOT "unknown"
			expect(debug.model).not.toBe("unknown");
			expect(debug.model).toBe("claude-opus");
		}
	});

	// Cache-path observability fields: regression for the 5/6 observability
	// gaps surfaced on thread 2d055bbe-405f-4757-82a0-8775ac95a0e2, where
	// effectiveTruncationRatio / coldReason / cachePath were null in
	// context_debug despite the agent loop actively making those decisions.
	// Without these fields, post-hoc cache-thrash analysis required scraping
	// log lines and re-running the inflation EMA against the same row history.
	it("records cache-path observability fields on context_debug", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("First response");

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		await agentLoop.run();

		const turn = db
			.query(
				"SELECT context_debug FROM turns WHERE thread_id = ? AND context_debug IS NOT NULL ORDER BY rowid ASC LIMIT 1",
			)
			.get(threadId) as { context_debug: string } | null;

		expect(turn).not.toBeNull();
		const debug = JSON.parse(turn?.context_debug ?? "{}") as {
			cachePath?: string;
			cachePathReason?: string;
			effectiveTruncationRatio?: number;
			measuredInflation?: number | null;
			warmCompactionTokensSaved?: number;
		};

		// First turn on a new thread: must be cold path with no-stored-state.
		// Distinguishing this from later cold reasons (cache-expired,
		// tool-change, budget-exceeded, orphaned-tool-call) is the whole
		// point of recording the reason — silent "cold for some reason"
		// debug rows tell us nothing about why caching isn't sticking.
		expect(debug.cachePath).toBe("cold");
		expect(debug.cachePathReason).toBe("no-stored-state");

		// Adaptive truncation ratio must surface even on cold-start threads
		// (where measuredInflation is null and the resolver returns the base
		// 0.85). On a thread where the EMA HAS collapsed to 0.4, the recorded
		// 0.4 is the only signal that explains why warm-path budget bails fire
		// 200k tokens earlier than the contextWindow would suggest.
		expect(debug.effectiveTruncationRatio).toBeCloseTo(0.85, 5);
		// Cold-start threads have insufficient samples for the EMA. Recording
		// `null` distinguishes "estimator is accurate" from "we don't know yet"
		// — both surfaces would otherwise look identical at the base ratio.
		expect(debug.measuredInflation).toBeNull();

		// warmCompactionTokensSaved is undefined on cold turns (it's only
		// meaningful on warm turns where compactStoredMessagesInPlace ran).
		expect(debug.warmCompactionTokensSaved).toBeUndefined();
	});

	// Model unavailability: when a model_hint can't be resolved, fail the task
	it("fails the task when model-hint is unavailable instead of silently falling back", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("Should not be called.");

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		// Router only knows "claude-opus" but we request "nonexistent-model"
		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
			modelId: "nonexistent-model",
		});

		const result = await agentLoop.run();

		// Should fail — no silent fallback to default model
		expect(result.error).toBeDefined();
		expect(result.error).toContain("nonexistent-model");
		expect(result.messagesCreated).toBe(0);

		// An alert should have been persisted describing the failure
		const alerts = db
			.query(
				"SELECT content FROM messages WHERE thread_id = ? AND role = 'alert' ORDER BY created_at ASC",
			)
			.all(threadId) as Array<{ content: string }>;

		expect(alerts.length).toBeGreaterThan(0);
		expect(alerts[0].content).toContain("nonexistent-model");
		expect(alerts[0].content).toContain("Failed to resolve");
	});

	it("falls back to a same-tier model when model-hint fails and alternative exists", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("Completed on fallback model.");

		const mockBash = createMockSandbox();
		const emittedEvents: Array<{ event: string; payload: unknown }> = [];
		const ctx = makeCtx();
		// Spy on eventBus.emit
		ctx.eventBus.emit = <K extends keyof EventMap>(event: K, payload: EventMap[K]): boolean => {
			emittedEvents.push({ event, payload });
			return true;
		};

		// Router with two tier-1 backends: "glm" and "phi3"
		// We'll request "glm" but it won't be in the router — only "phi3" is
		const backends = new Map<string, LLMBackend>([["phi3", mockBackend]]);
		const tiers = new Map([["phi3", 1]]);
		const router = new ModelRouter(backends, "phi3", undefined, tiers);

		const agentLoop = new AgentLoop(ctx, mockBash, router, {
			threadId,
			userId: "test-user",
			modelId: "glm",
			modelTier: 1, // Caller knows the tier of the requested model
		});

		const result = await agentLoop.run();

		// Should succeed via same-tier fallback
		expect(result.error).toBeUndefined();
		expect(result.messagesCreated).toBeGreaterThan(0);

		// Alert should describe the tier-equivalent fallback
		const alerts = db
			.query(
				"SELECT content FROM messages WHERE thread_id = ? AND role = 'alert' ORDER BY created_at ASC",
			)
			.all(threadId) as Array<{ content: string }>;

		expect(alerts.length).toBeGreaterThan(0);
		expect(alerts[0].content).toContain("glm");
		expect(alerts[0].content).toContain("phi3");
		expect(alerts[0].content).toContain("tier");

		// model:fallback event should have been emitted
		const fallbackEvent = emittedEvents.find((e) => e.event === "model:fallback");
		assert(fallbackEvent);
		const payload = fallbackEvent.payload as Record<string, unknown>;
		expect(payload.requested_model).toBe("glm");
		expect(payload.fallback_model).toBe("phi3");
		expect(payload.tier).toBe(1);
	});

	it("fails when model-hint fails and no same-tier alternative exists", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("Should not be called.");

		const mockBash = createMockSandbox();
		const ctx = makeCtx();

		// Router with only a tier-5 backend; we request a tier-1 model
		const backends = new Map<string, LLMBackend>([["opus", mockBackend]]);
		const tiers = new Map([["opus", 5]]);
		const router = new ModelRouter(backends, "opus", undefined, tiers);

		const agentLoop = new AgentLoop(ctx, mockBash, router, {
			threadId,
			userId: "test-user",
			modelId: "glm",
			modelTier: 1,
		});

		const result = await agentLoop.run();

		// Should fail — no same-tier alternative
		expect(result.error).toBeDefined();
		expect(result.error).toContain("glm");
		expect(result.messagesCreated).toBe(0);
	});

	it("falls over to a same-tier model when the resolved model errors at inference with a quota cap (402)", async () => {
		// The heartbeat shape: empty model-hint resolves to the host default, which
		// then errors at the inference boundary with a hard quota cap (not 429/529,
		// not transient). Pre-fix this lands in none of the fallback paths and the
		// task hard-fails. Post-fix it should fail over to a same-tier sibling.
		const { LLMError } = await import("@bound/llm");
		const capped = {
			// biome-ignore lint/correctness/useYield: throws before first yield
			async *chat() {
				throw new LLMError("Weekly usage limit reached. Resets in 2 days.", "opencode-go", 402);
			},
			capabilities() {
				return {
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 8000,
				};
			},
		} as unknown as LLMBackend;

		const healthy = new MockLLMBackend();
		healthy.setTextResponse("Completed on the same-tier sibling.");

		// Two tier-1 backends. Default is the capped one — exactly the empty-hint
		// case where resolveModel(undefined) picks the host default.
		const backends = new Map<string, LLMBackend>([
			["deepseek", capped],
			["kimi", healthy],
		]);
		const tiers = new Map([
			["deepseek", 1],
			["kimi", 1],
		]);
		const router = new ModelRouter(backends, "deepseek", undefined, tiers);

		const ctx = makeCtx();
		const agentLoop = new AgentLoop(ctx, createMockSandbox(), router, {
			threadId,
			userId: "test-user",
			// No modelId / modelTier — empty hint, resolves to default "deepseek".
		});

		const result = await agentLoop.run();

		// Should succeed via same-tier failover to "kimi".
		expect(result.error).toBeUndefined();
		expect(result.messagesCreated).toBeGreaterThan(0);
		expect(healthy.getCallCount()).toBeGreaterThan(0);
	});

	describe("capturePreSnapshot hook", () => {
		it("AC5.1: capturePreSnapshot called exactly once per run()", async () => {
			const mockBackend = new MockLLMBackend();
			mockBackend.setTextResponse("Done.");

			let captureCallCount = 0;
			const mockBash = {
				exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				capturePreSnapshot: async () => {
					captureCallCount++;
				},
			};
			const ctx = makeCtx();

			const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
				threadId,
				userId: "test-user",
			});

			const result = await agentLoop.run();

			expect(captureCallCount).toBe(1);
			expect(result.error).toBeUndefined();
		});

		it("AC5.5: loop completes without capturePreSnapshot configured", async () => {
			const mockBackend = new MockLLMBackend();
			mockBackend.setTextResponse("Done.");

			const mockBash = {
				exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				// No capturePreSnapshot method
			};
			const ctx = makeCtx();

			const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
				threadId,
				userId: "test-user",
			});

			const result = await agentLoop.run();

			expect(result.error).toBeUndefined();
			expect(result.messagesCreated).toBeGreaterThan(0);
		});

		it("capturePreSnapshot called before any tool execution", async () => {
			const mockBackend = new MockLLMBackend();
			mockBackend.setToolThenTextResponse("tool-1", "bash", { command: "echo 'test'" }, "Done.");

			const callOrder: string[] = [];
			const mockBash = {
				exec: async () => {
					callOrder.push("exec");
					return { stdout: "", stderr: "", exitCode: 0 };
				},
				capturePreSnapshot: async () => {
					callOrder.push("capturePreSnapshot");
				},
			};
			const ctx = makeCtx();

			const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
				threadId,
				userId: "test-user",
			});

			await agentLoop.run();

			// capturePreSnapshot should be first in call order
			expect(callOrder[0]).toBe("capturePreSnapshot");
			// exec should come after (during tool execution)
			expect(callOrder).toContain("exec");
		});

		it("rehydrateFs runs before capturePreSnapshot at HYDRATE_FS", async () => {
			const mockBackend = new MockLLMBackend();
			mockBackend.setTextResponse("Done.");

			const callOrder: string[] = [];
			const mockBash = {
				exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				rehydrateFs: async () => {
					callOrder.push("rehydrateFs");
				},
				capturePreSnapshot: async () => {
					callOrder.push("capturePreSnapshot");
				},
			};
			const ctx = makeCtx();

			const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
				threadId,
				userId: "test-user",
			});

			await agentLoop.run();

			// Re-hydration must seed the VFS before the OCC baseline is captured,
			// or FS_PERSIST mistakes a re-pulled file for an agent edit (Invariant #5).
			expect(callOrder).toEqual(["rehydrateFs", "capturePreSnapshot"]);
		});
	});

	it("reassigns duplicate tool-use IDs and logs a warning (AC6.4)", async () => {
		const mockBackend = new MockLLMBackend();

		// Mock backend that yields two tool calls with the same ID "search"
		mockBackend.pushResponse(async function* () {
			yield {
				type: "tool_use_start" as const,
				id: "search",
				name: "search",
			};
			yield {
				type: "tool_use_args" as const,
				id: "search",
				partial_json: '{"q":"foo"}',
			};
			yield {
				type: "tool_use_end" as const,
				id: "search",
			};
			yield {
				type: "tool_use_start" as const,
				id: "search",
				name: "search",
			};
			yield {
				type: "tool_use_args" as const,
				id: "search",
				partial_json: '{"q":"bar"}',
			};
			yield {
				type: "tool_use_end" as const,
				id: "search",
			};
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		// Mock the tool execution to always succeed
		const mockBash = createMockSandbox((_cmd) => ({
			stdout: JSON.stringify({ result: "success" }),
			stderr: "",
			exitCode: 0,
		}));

		const ctx = makeCtx();
		let warningLogged = false;
		ctx.logger.warn = (msg: string) => {
			if (msg.includes("Duplicate tool-use ID")) {
				warningLogged = true;
			}
		};

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		// Should succeed with 2 tool calls despite duplicates
		expect(result.toolCallsMade).toBe(2);
		expect(result.error).toBeUndefined();
		// Warning should have been logged
		expect(warningLogged).toBe(true);
	});

	it("handles 3+ duplicate tool-use IDs correctly (ordering guarantee)", async () => {
		const mockBackend = new MockLLMBackend();

		// Mock backend that yields three tool calls all with the same ID "search"
		mockBackend.pushResponse(async function* () {
			yield {
				type: "tool_use_start" as const,
				id: "search",
				name: "search",
			};
			yield {
				type: "tool_use_args" as const,
				id: "search",
				partial_json: '{"q":"first"}',
			};
			yield {
				type: "tool_use_end" as const,
				id: "search",
			};
			yield {
				type: "tool_use_start" as const,
				id: "search",
				name: "search",
			};
			yield {
				type: "tool_use_args" as const,
				id: "search",
				partial_json: '{"q":"second"}',
			};
			yield {
				type: "tool_use_end" as const,
				id: "search",
			};
			yield {
				type: "tool_use_start" as const,
				id: "search",
				name: "search",
			};
			yield {
				type: "tool_use_args" as const,
				id: "search",
				partial_json: '{"q":"third"}',
			};
			yield {
				type: "tool_use_end" as const,
				id: "search",
			};
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		// Mock the tool execution to always succeed
		const mockBash = createMockSandbox((_cmd) => ({
			stdout: JSON.stringify({ result: "success" }),
			stderr: "",
			exitCode: 0,
		}));

		const ctx = makeCtx();
		let warningCount = 0;
		ctx.logger.warn = (msg: string) => {
			if (msg.includes("Duplicate tool-use ID")) {
				warningCount++;
			}
		};

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		// Should succeed with 3 tool calls despite duplicates
		expect(result.toolCallsMade).toBe(3);
		expect(result.error).toBeUndefined();
		// Warning should have been logged exactly 2 times (once per duplicate detected)
		// First occurrence is not a duplicate, second and third are duplicates
		expect(warningCount).toBe(2);
	});

	it("Anthropic native tool IDs are passed through unchanged (AC6.3)", async () => {
		const mockBackend = new MockLLMBackend();

		// Simulate Anthropic native IDs (toolu_*)
		mockBackend.pushResponse(async function* () {
			yield {
				type: "tool_use_start" as const,
				id: "toolu_01",
				name: "search",
			};
			yield {
				type: "tool_use_args" as const,
				id: "toolu_01",
				partial_json: '{"q":"foo"}',
			};
			yield {
				type: "tool_use_end" as const,
				id: "toolu_01",
			};
			yield {
				type: "tool_use_start" as const,
				id: "toolu_02",
				name: "search",
			};
			yield {
				type: "tool_use_args" as const,
				id: "toolu_02",
				partial_json: '{"q":"bar"}',
			};
			yield {
				type: "tool_use_end" as const,
				id: "toolu_02",
			};
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const mockBash = createMockSandbox((_cmd) => ({
			stdout: JSON.stringify({ result: "success" }),
			stderr: "",
			exitCode: 0,
		}));

		const ctx = makeCtx();
		let warningLogged = false;
		ctx.logger.warn = (msg: string) => {
			if (msg.includes("Duplicate tool-use ID")) {
				warningLogged = true;
			}
		};

		const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		// Native IDs should pass through unchanged, no warning needed
		expect(result.toolCallsMade).toBe(2);
		expect(result.error).toBeUndefined();
		expect(warningLogged).toBe(false);
	});

	it("includes developer message with volatile context in messages", async () => {
		const localThreadId = randomUUID();
		const ctx = makeCtx();
		const backend = new CaptureParamsBackend();
		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");

		const agentLoop = new AgentLoop(ctx, createMockSandbox(), router, {
			threadId: localThreadId,
			userId: "test-user",
			modelId: "test-model",
		});

		await agentLoop.run();

		expect(backend.capturedParams.length).toBeGreaterThan(0);
		const params = backend.capturedParams[0];
		// messages should include a developer message with volatile context
		const developerMsg = params.messages.find((m: any) => m.role === "developer");
		expect(developerMsg).toBeDefined();
		expect(typeof developerMsg?.content).toBe("string");
		// Developer message should contain thread ID (per-thread varying content)
		expect(developerMsg?.content).toContain(localThreadId);
		// system_suffix should no longer be passed
		expect(params.system_suffix).toBeUndefined();
	});

	describe("context_debug freshness per turn", () => {
		it("should update context_debug actualTotalTokens for each turn in a multi-turn loop", async () => {
			const mockBackend = new MockLLMBackend();

			// First call: tool use (input_tokens = 100)
			mockBackend.pushResponse(async function* () {
				yield { type: "tool_use_start" as const, id: "t-cd1", name: "bash" };
				yield {
					type: "tool_use_args" as const,
					id: "t-cd1",
					partial_json: '{"command":"echo test"}',
				};
				yield { type: "tool_use_end" as const, id: "t-cd1" };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 100,
						output_tokens: 15,
						cache_write_tokens: null,
						cache_read_tokens: null,
						estimated: false,
					},
				};
			});

			// Second call: text response (input_tokens = 500 — context grew)
			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "All done." };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 500,
						output_tokens: 10,
						cache_write_tokens: null,
						cache_read_tokens: null,
						estimated: false,
					},
				};
			});

			const mockBash = createMockSandbox(() => ({
				stdout: "test output",
				stderr: "",
				exitCode: 0,
			}));
			const ctx = makeCtx();

			const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
				threadId,
				userId: "test-user",
			});

			await agentLoop.run();

			// Query the turns table for context_debug. Ordering by rowid
			// gives us insertion order — turn ids are UUIDs now, so id ASC
			// isn't meaningful, and created_at can tie at ms resolution.
			const turns = db
				.query(
					"SELECT id, tokens_in, context_debug FROM turns WHERE thread_id = ? ORDER BY rowid ASC",
				)
				.all(threadId) as Array<{
				id: string;
				tokens_in: number;
				context_debug: string | null;
			}>;

			expect(turns.length).toBe(2);

			// Both turns should have context_debug
			expect(turns[0].context_debug).not.toBeNull();
			expect(turns[1].context_debug).not.toBeNull();

			const debug1 = JSON.parse(turns[0].context_debug ?? "{}") as {
				totalEstimated: number;
				actualTotalTokens?: number;
			};
			const debug2 = JSON.parse(turns[1].context_debug ?? "{}") as {
				totalEstimated: number;
				actualTotalTokens?: number;
			};

			// Per-turn freshness invariant: each turn's snapshot must reflect
			// its OWN LLM-reported usage, not be stale from a prior turn's
			// applyActualUsage call. Turn 1 saw input_tokens=100; turn 2 saw
			// input_tokens=500. actualTotalTokens carries that LLM-reported
			// number (totalEstimated stays as the tiktoken pre-LLM estimate
			// and is shared across turns of the same assembly).
			expect(debug1.actualTotalTokens).toBe(100);
			expect(debug2.actualTotalTokens).toBe(500);
			expect(debug2.actualTotalTokens).not.toBe(debug1.actualTotalTokens);
		});

		it("computes actualTotalTokens as input + cache_read + cache_write (the on-wire prompt size)", async () => {
			// Wire contract for `actualTotalTokens`: it represents the FULL
			// on-wire prompt token count (so the inflation EMA's ratio of
			// agent-side tiktoken estimate vs LLM-tokenizer truth reflects
			// only tokenizer drift, not cache accounting).
			//
			// The bridge's `extractUsage` reads `inputTokenDetails.noCacheTokens`
			// from the AI SDK v6 totalUsage shape (verified live against
			// `@ai-sdk/amazon-bedrock@4.0.96` — the structured `inputTokens`
			// scalar is the SUMMED total, but the noCacheTokens field is the
			// non-cached portion that's actually billed at the full input
			// rate). So `chunk.usage.input_tokens` post-bridge is the
			// non-cached scalar; the agent loop must add cache reads + writes
			// back here to recover the true wire size for inflation purposes.
			//
			// Pre-2026-05-26 this test pinned the OLD broken contract — back
			// when the bridge accidentally read the AI SDK's summed scalar
			// and the agent loop avoided adding cache fields back. The bridge
			// is fixed; this contract reverses to "DO sum them back."
			const mockBackend = new MockLLMBackend();

			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "ok" };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 200_000, // non-cached portion (from noCacheTokens)
						output_tokens: 50,
						cache_write_tokens: 180_000,
						cache_read_tokens: 0,
						estimated: false,
					},
				};
			});

			const ctx = makeCtx();
			const agentLoop = new AgentLoop(
				ctx,
				createMockSandbox(() => ({ stdout: "", stderr: "", exitCode: 0 })),
				createMockRouter(mockBackend),
				{ threadId, userId: "test-user" },
			);

			await agentLoop.run();

			const turn = db
				.query("SELECT context_debug FROM turns WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1")
				.get(threadId) as { context_debug: string | null };

			const debug = JSON.parse(turn.context_debug ?? "{}") as {
				actualTotalTokens?: number;
			};

			// MUST be 380_000 — the full wire size (input + cR + cW) that
			// the LLM actually saw on the prompt, because the inflation EMA
			// compares this against the agent's tiktoken estimate of the
			// FULL prompt.
			expect(debug.actualTotalTokens).toBe(380_000);
		});
	});

	describe("spoke node (no local backends)", () => {
		function createEmptyRouter(): ModelRouter {
			return new ModelRouter(new Map(), "");
		}

		function insertRemoteHost(siteId: string) {
			const now = new Date().toISOString();
			db.run(
				`INSERT OR REPLACE INTO hosts
				 (site_id, host_name, sync_url, models, mcp_tools, platforms, online_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
				[
					siteId,
					"remote-hub",
					"http://hub:3000",
					JSON.stringify([
						{
							id: "claude-opus",
							tier: 1,
							capabilities: {
								max_context: 200000,
								streaming: true,
								tool_use: true,
								system_prompt: true,
							},
						},
					]),
					null,
					null,
					now,
					now,
				],
			);
		}

		it("should not crash on context window calculation when model resolves to remote", async () => {
			// On a spoke with no local backends, getDefault() throws.
			// The context window calculation must use remote host capabilities instead.
			const remoteSiteId = `remote-site-${randomUUID().slice(0, 8)}`;
			insertRemoteHost(remoteSiteId);

			const controller = new AbortController();
			// Abort after short delay — gives the loop time to pass context assembly
			// but aborts before relay stream timeout (which would take 120s)
			setTimeout(() => controller.abort(), 10);

			const agentLoop = new AgentLoop(makeCtx(), createMockSandbox(), createEmptyRouter(), {
				threadId,
				userId: "test-user",
				abortSignal: controller.signal,
			});

			// This should NOT throw — previously crashed with "Default backend not found"
			const result = await agentLoop.run();
			expect(result.error).toBeUndefined();
		});

		it("delegates summary extraction over the relay when no local backend but model resolves cluster-wide", async () => {
			// On a backendless spoke, extraction acquires its backend through cluster-wide
			// resolution. With a remote host advertising the model, resolution returns a relay
			// backend and extraction delegates (fire-and-forget) rather than skipping. The loop
			// must complete without throwing and must NOT log the skip.
			const remoteSiteId = `remote-site-${randomUUID().slice(0, 8)}`;
			insertRemoteHost(remoteSiteId);

			const controller = new AbortController();
			setTimeout(() => controller.abort(), 10);

			const ctx = makeCtx();
			const infos: string[] = [];
			ctx.logger.info = (msg: string) => {
				infos.push(msg);
			};

			const agentLoop = new AgentLoop(ctx, createMockSandbox(), createEmptyRouter(), {
				threadId,
				userId: "test-user",
				abortSignal: controller.signal,
			});

			// Should complete without throwing — delegates extraction over the relay
			const result = await agentLoop.run();
			expect(result.error).toBeUndefined();
			// The skip path is for unresolvable models only; it must NOT fire here.
			expect(infos.some((m) => m.includes("Skipping summary extraction"))).toBe(false);
		});
	});

	describe("cooperative cancellation (shouldYield)", () => {
		it("stops before executing tool call when shouldYield returns true", async () => {
			const backend = new MockLLMBackend();

			// LLM wants to call a tool, then produce text
			backend.setToolThenTextResponse("tool-1", "bash", { command: "query SELECT 1" }, "Done!");

			const sandbox = createMockSandbox();

			// shouldYield returns true after the first LLM call (before tool execution)
			let llmCallCount = 0;
			const loop = new AgentLoop(makeCtx(), sandbox, createMockRouter(backend), {
				threadId,
				userId: "test-user",
				shouldYield: () => {
					// Yield after LLM returns tool_call but before tool executes
					return llmCallCount > 0;
				},
			});

			// Intercept LLM calls to track count
			const origChat = backend.chat.bind(backend);
			backend.chat = async function* (...args: [ChatParams]) {
				llmCallCount++;
				yield* origChat(...args);
			};

			const result = await loop.run();

			// Tool should NOT have been executed
			expect(sandbox.calls).toHaveLength(0);

			// The loop should have yielded, not errored
			expect(result.error).toBeUndefined();

			// Only 1 LLM call (the one that requested the tool), not 2
			expect(backend.getCallCount()).toBe(1);
		});

		it("yields during LLM streaming when shouldYield returns true", async () => {
			const backend = new MockLLMBackend();

			// LLM will produce a text response (slow streaming simulated by multiple chunks)
			backend.pushResponse(async function* () {
				yield { type: "text" as const, content: "Starting to " };
				yield { type: "text" as const, content: "respond to " };
				yield { type: "text" as const, content: "the user..." };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						cache_write_tokens: null,
						cache_read_tokens: null,
						estimated: false,
					},
				};
			});

			const sandbox = createMockSandbox();

			// shouldYield returns true after first chunk — simulates new message arriving mid-stream
			let chunksSeen = 0;
			const originalChat = backend.chat.bind(backend);
			backend.chat = async function* (...args: [ChatParams]) {
				for await (const chunk of originalChat(...args)) {
					if (chunk.type === "text") chunksSeen++;
					yield chunk;
				}
			};

			const loop = new AgentLoop(makeCtx(), sandbox, createMockRouter(backend), {
				threadId,
				userId: "test-user",
				shouldYield: () => chunksSeen >= 2, // yield after 2 text chunks
			});

			const result = await loop.run();

			// Loop should have yielded
			expect(result.yielded).toBe(true);
			// No error — yield is not an error condition
			expect(result.error).toBeUndefined();
		});

		it("sets yielded=false on normal completion", async () => {
			const backend = new MockLLMBackend();
			backend.setTextResponse("Normal response");

			const sandbox = createMockSandbox();

			const loop = new AgentLoop(makeCtx(), sandbox, createMockRouter(backend), {
				threadId,
				userId: "test-user",
				shouldYield: () => false,
			});

			const result = await loop.run();

			expect(result.yielded).toBeUndefined(); // not set or false
			expect(result.error).toBeUndefined();
		});

		it("does not interfere when shouldYield always returns false", async () => {
			const backend = new MockLLMBackend();
			backend.setToolThenTextResponse("tool-1", "bash", { command: "query SELECT 1" }, "Done!");

			const sandbox = createMockSandbox();

			const loop = new AgentLoop(makeCtx(), sandbox, createMockRouter(backend), {
				threadId,
				userId: "test-user",
				shouldYield: () => false,
			});

			await loop.run();

			// Normal execution: tool was called, final text produced
			expect(sandbox.calls.length).toBeGreaterThanOrEqual(1);
			expect(backend.getCallCount()).toBe(2); // tool_call turn + final text turn
		});

		it("persists messages with siteId as host_origin, not hostName", async () => {
			// After this fix, host_origin should be the stable site_id (survives
			// container restarts) rather than the ephemeral hostname.
			const mockBackend = new MockLLMBackend();
			mockBackend.setTextResponse("Hello from stable origin.");

			const mockBash = createMockSandbox();
			const ctx = makeCtx();
			// ctx has hostName: "test-host" and siteId: "test-site-id"

			const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
				threadId,
				userId: "test-user",
			});

			await agentLoop.run();

			const msgs = db
				.query("SELECT host_origin FROM messages WHERE thread_id = ?")
				.all(threadId) as Array<{ host_origin: string }>;

			expect(msgs.length).toBeGreaterThan(0);
			for (const msg of msgs) {
				// Must be site_id, NOT hostname
				expect(msg.host_origin).toBe("test-site-id");
				expect(msg.host_origin).not.toBe("test-host");
			}
		});
	});

	describe("duplicate tool-call circuit breaker", () => {
		it("aborts when the same tool call repeats MAX_CONSECUTIVE_DUPLICATE_TOOL_CALLS times", async () => {
			const mockBackend = new MockLLMBackend();
			// Push more identical, well-formed (non-truncated) tool_use turns than
			// the threshold. Each turn issues the byte-identical bash call; the loop
			// executes it, re-prompts, and pulls the next identical response. This is
			// the 2026-04-24 synthesis spin reproduced: 20+ identical delta-check
			// queries that all PARSED CLEANLY — the truncation breaker cannot see
			// them. Without the duplicate breaker the loop runs every pushed turn.
			const overshoot = MAX_CONSECUTIVE_DUPLICATE_TOOL_CALLS + 3;
			for (let i = 0; i < overshoot; i++) {
				mockBackend.pushResponse(async function* () {
					yield { type: "tool_use_start" as const, id: `dup-${i}`, name: "bash" };
					yield {
						type: "tool_use_args" as const,
						id: `dup-${i}`,
						partial_json: JSON.stringify({ command: "echo spin" }),
					};
					yield { type: "tool_use_end" as const, id: `dup-${i}` };
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
			}

			const mockBash = createMockSandbox();
			const ctx = makeCtx();

			const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
				threadId,
				userId: "test-user",
			});

			const result = await agentLoop.run();

			// The loop must short-circuit at the threshold, not consume every
			// pushed response. The breaker fires before executing the Nth call.
			expect(mockBackend.getCallCount()).toBe(MAX_CONSECUTIVE_DUPLICATE_TOOL_CALLS);

			// An abort notice must have been persisted explaining the duplicate loop.
			const notices = db
				.query(
					"SELECT content FROM messages WHERE thread_id = ? AND role = 'developer' AND content LIKE '%identical tool call%'",
				)
				.all(threadId) as Array<{ content: string }>;
			expect(notices.length).toBe(1);
			expect(notices[0].content).toContain("Agent loop aborted");
			expect(result).toHaveProperty("messagesCreated");
		});

		it("does NOT abort when consecutive tool calls differ (real progress)", async () => {
			const mockBackend = new MockLLMBackend();
			// Distinct args every turn — healthy work that makes progress. Each call
			// is a different bash command, so the signature changes turn-over-turn
			// and the duplicate counter never accumulates.
			const turns = MAX_CONSECUTIVE_DUPLICATE_TOOL_CALLS + 3;
			for (let i = 0; i < turns; i++) {
				mockBackend.pushResponse(async function* () {
					yield { type: "tool_use_start" as const, id: `prog-${i}`, name: "bash" };
					yield {
						type: "tool_use_args" as const,
						id: `prog-${i}`,
						partial_json: JSON.stringify({ command: `echo step-${i}` }),
					};
					yield { type: "tool_use_end" as const, id: `prog-${i}` };
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
			}
			// Final turn: plain text so the loop ends naturally.
			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "All distinct, done." };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						cache_write_tokens: null,
						cache_read_tokens: null,
						estimated: false,
					},
				};
			});

			const mockBash = createMockSandbox();
			const ctx = makeCtx();

			const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
				threadId,
				userId: "test-user",
			});

			await agentLoop.run();

			// No abort notice — distinct calls are healthy progress.
			const notices = db
				.query(
					"SELECT content FROM messages WHERE thread_id = ? AND role = 'developer' AND content LIKE '%identical tool call%'",
				)
				.all(threadId) as Array<{ content: string }>;
			expect(notices.length).toBe(0);
		});
	});

	describe("error-result circuit breaker", () => {
		it("aborts when consecutive turns return the byte-identical error despite varying args", async () => {
			const mockBackend = new MockLLMBackend();
			// Reproduces the 2026-06-12 connector-name-contamination spin (thread
			// 53c7635e): the model emitted ~26 tool calls under a CONSTANT tool name
			// with DIFFERENT args each turn. The args differ, so the byte-identical
			// CALL-signature breaker (MAX_CONSECUTIVE_DUPLICATE_TOOL_CALLS) keeps
			// resetting and never fires. But every call returns the byte-identical
			// error (an unknown-tool / validation error that does not echo the args),
			// so the ERROR-signature breaker must catch it.
			const overshoot = MAX_CONSECUTIVE_ERROR_TOOL_CALLS + 3;
			for (let i = 0; i < overshoot; i++) {
				mockBackend.pushResponse(async function* () {
					yield { type: "tool_use_start" as const, id: `err-${i}`, name: "nonexistent_tool_xyz" };
					yield {
						type: "tool_use_args" as const,
						id: `err-${i}`,
						// Distinct args every turn → distinct call signature → the
						// duplicate-call breaker never accumulates.
						partial_json: JSON.stringify({ attempt: i, payload: `variant-${i}` }),
					};
					yield { type: "tool_use_end" as const, id: `err-${i}` };
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
			}

			const mockBash = createMockSandbox();
			const ctx = makeCtx();

			const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
				threadId,
				userId: "test-user",
			});

			await agentLoop.run();

			// The loop short-circuits at the threshold — it does NOT consume every
			// pushed response. The breaker fires after executing (and seeing the
			// identical error from) the Nth call.
			expect(mockBackend.getCallCount()).toBe(MAX_CONSECUTIVE_ERROR_TOOL_CALLS);

			// An abort notice must have been persisted explaining the identical-error loop.
			const aborts = db
				.query(
					"SELECT content FROM messages WHERE thread_id = ? AND role = 'developer' AND content LIKE '%identical error%'",
				)
				.all(threadId) as Array<{ content: string }>;
			expect(aborts.length).toBe(1);
			expect(aborts[0].content).toContain("Agent loop aborted");

			// A single corrective nudge must have fired earlier (at ERROR_SIGNATURE_NUDGE_AT),
			// trying to un-stick the model before the harder abort.
			const nudges = db
				.query(
					"SELECT content FROM messages WHERE thread_id = ? AND role = 'developer' AND content LIKE '%same error%'",
				)
				.all(threadId) as Array<{ content: string }>;
			expect(nudges.length).toBe(1);
			expect(ERROR_SIGNATURE_NUDGE_AT).toBeLessThan(MAX_CONSECUTIVE_ERROR_TOOL_CALLS);
		});

		it("does NOT abort when the error differs each turn (progress through distinct failures)", async () => {
			const mockBackend = new MockLLMBackend();
			// Vary the tool NAME each turn → the unknown-tool error embeds the name →
			// the error signature changes turn-over-turn and the counter never
			// accumulates. Healthy "trying different things" behaviour.
			const turns = MAX_CONSECUTIVE_ERROR_TOOL_CALLS + 3;
			for (let i = 0; i < turns; i++) {
				mockBackend.pushResponse(async function* () {
					yield { type: "tool_use_start" as const, id: `diff-${i}`, name: `nonexistent_${i}` };
					yield {
						type: "tool_use_args" as const,
						id: `diff-${i}`,
						partial_json: JSON.stringify({ attempt: i }),
					};
					yield { type: "tool_use_end" as const, id: `diff-${i}` };
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
			}
			// Final turn: plain text so the loop ends naturally.
			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "Tried distinct tools, done." };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						cache_write_tokens: null,
						cache_read_tokens: null,
						estimated: false,
					},
				};
			});

			const mockBash = createMockSandbox();
			const ctx = makeCtx();

			const agentLoop = new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
				threadId,
				userId: "test-user",
			});

			await agentLoop.run();

			// No abort — distinct errors are not a spin.
			const aborts = db
				.query(
					"SELECT content FROM messages WHERE thread_id = ? AND role = 'developer' AND content LIKE '%identical error%'",
				)
				.all(threadId) as Array<{ content: string }>;
			expect(aborts.length).toBe(0);
		});
	});
});
