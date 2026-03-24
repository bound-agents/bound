import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { AgentLoop } from "../agent-loop";

describe("Memory Threshold Check (R-W2)", () => {
	let tmpDir: string;
	let db: Database;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "mem-threshold-test-"));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);

		// Create a test user
		const userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
	});

	afterAll(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeCtx(): AppContext {
		return {
			db,
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			eventBus: {
				on: () => {},
				emit: () => {},
			},
			hostName: "test-host",
			siteId: "test-site-id",
		} as unknown as AppContext;
	}

	it("terminates the loop when sandbox reports memory over threshold", async () => {
		const threadId = randomUUID();
		let toolCallCount = 0;

		class MockLLMBackend implements LLMBackend {
			private callIndex = 0;
			async *chat(): AsyncGenerator<StreamChunk> {
				if (this.callIndex === 0) {
					this.callIndex++;
					// First call: request a tool execution
					yield { type: "tool_use_start" as const, id: "t1", name: "bash" };
					yield {
						type: "tool_use_args" as const,
						id: "t1",
						partial_json: '{"command":"echo hello"}',
					};
					yield { type: "tool_use_end" as const, id: "t1" };
					yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 15 } };
				} else {
					// This should NOT be reached if memory threshold breaks the loop
					yield { type: "text" as const, content: "This should not appear." };
					yield { type: "done" as const, usage: { input_tokens: 5, output_tokens: 3 } };
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

		const mockSandbox = {
			exec: async (cmd: string) => {
				toolCallCount++;
				return { stdout: "ok", stderr: "", exitCode: 0 };
			},
			checkMemoryThreshold: () => ({
				overThreshold: true,
				usageBytes: 60 * 1024 * 1024, // 60MB
				thresholdBytes: 50 * 1024 * 1024, // 50MB
			}),
		};

		const ctx = makeCtx();
		const agentLoop = new AgentLoop(ctx, mockSandbox, new MockLLMBackend(), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		// The tool was executed once
		expect(toolCallCount).toBe(1);
		expect(result.toolCallsMade).toBe(1);
		// The loop should have terminated early - no final text response persisted
		// (the second LLM call that would have produced text was never made)
		expect(result.error).toBeUndefined();
	});

	it("continues the loop when memory is under threshold", async () => {
		const threadId = randomUUID();

		class MockLLMBackend implements LLMBackend {
			private callIndex = 0;
			async *chat(): AsyncGenerator<StreamChunk> {
				if (this.callIndex === 0) {
					this.callIndex++;
					yield { type: "tool_use_start" as const, id: "t1", name: "bash" };
					yield {
						type: "tool_use_args" as const,
						id: "t1",
						partial_json: '{"command":"echo hi"}',
					};
					yield { type: "tool_use_end" as const, id: "t1" };
					yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 15 } };
				} else {
					yield { type: "text" as const, content: "All done." };
					yield { type: "done" as const, usage: { input_tokens: 20, output_tokens: 5 } };
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

		const mockSandbox = {
			exec: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
			checkMemoryThreshold: () => ({
				overThreshold: false,
				usageBytes: 10 * 1024 * 1024, // 10MB
				thresholdBytes: 50 * 1024 * 1024, // 50MB
			}),
		};

		const ctx = makeCtx();
		const agentLoop = new AgentLoop(ctx, mockSandbox, new MockLLMBackend(), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		// The loop continued through the second LLM call
		expect(result.toolCallsMade).toBe(1);
		expect(result.messagesCreated).toBeGreaterThan(1);
		expect(result.error).toBeUndefined();

		// Final assistant message should be persisted
		const msgs = db
			.query(
				"SELECT role, content FROM messages WHERE thread_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
			)
			.all(threadId) as Array<{ role: string; content: string }>;
		expect(msgs.length).toBe(1);
		expect(msgs[0].content).toBe("All done.");
	});

	it("works fine when sandbox has no checkMemoryThreshold", async () => {
		const threadId = randomUUID();

		class MockLLMBackend implements LLMBackend {
			private callIndex = 0;
			async *chat(): AsyncGenerator<StreamChunk> {
				if (this.callIndex === 0) {
					this.callIndex++;
					yield { type: "tool_use_start" as const, id: "t1", name: "bash" };
					yield {
						type: "tool_use_args" as const,
						id: "t1",
						partial_json: '{"command":"echo test"}',
					};
					yield { type: "tool_use_end" as const, id: "t1" };
					yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 15 } };
				} else {
					yield { type: "text" as const, content: "Completed." };
					yield { type: "done" as const, usage: { input_tokens: 20, output_tokens: 5 } };
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

		// No checkMemoryThreshold on sandbox
		const mockSandbox = {
			exec: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
		};

		const ctx = makeCtx();
		const agentLoop = new AgentLoop(ctx, mockSandbox, new MockLLMBackend(), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();

		// Should complete normally without crashing
		expect(result.toolCallsMade).toBe(1);
		expect(result.error).toBeUndefined();
	});
});
