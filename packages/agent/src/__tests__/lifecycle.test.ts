/**
 * Agent loop lifecycle integration tests.
 *
 * Verifies that the agent loop calls all expected lifecycle hooks:
 * - recordTurn is called after each LLM response
 * - extractSummaryAndMemories is called on completion
 * - agent:cancel events abort the loop
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase, insertRow } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { TypedEventEmitter } from "@bound/shared";
import { AgentLoop } from "../agent-loop";

// ---------------------------------------------------------------------------
// Mock LLM Backend
// ---------------------------------------------------------------------------
class MockLLMBackend implements LLMBackend {
	private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
	private callCount = 0;

	pushResponse(gen: () => AsyncGenerator<StreamChunk>) {
		this.responses.push(gen);
	}

	setTextResponse(text: string) {
		this.responses = [];
		this.pushResponse(async function* () {
			yield { type: "text" as const, content: text };
			yield {
				type: "done" as const,
				usage: { input_tokens: 100, output_tokens: 50 },
			};
		});
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
				usage: { input_tokens: 100, output_tokens: 80 },
			};
		});
		this.pushResponse(async function* () {
			yield { type: "text" as const, content: finalText };
			yield {
				type: "done" as const,
				usage: { input_tokens: 200, output_tokens: 60 },
			};
		});
	}

	/**
	 * Return a generator that yields many small chunks with short delays.
	 * The abort check runs between each chunk, so this gives the cancel
	 * signal a chance to be noticed without waiting for one long sleep.
	 */
	setManyChunksResponse(chunkCount: number, delayPerChunkMs: number) {
		this.responses = [];
		this.pushResponse(async function* () {
			for (let i = 0; i < chunkCount; i++) {
				await new Promise((resolve) => setTimeout(resolve, delayPerChunkMs));
				yield { type: "text" as const, content: `chunk-${i} ` };
			}
			yield {
				type: "done" as const,
				usage: { input_tokens: 10, output_tokens: 5 },
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
			yield { type: "text" as const, content: "" };
			yield {
				type: "done" as const,
				usage: { input_tokens: 0, output_tokens: 0 },
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

function createMockSandbox() {
	return {
		exec: async (_cmd: string) => ({ stdout: "ok", stderr: "", exitCode: 0 }),
	};
}

describe("AgentLoop lifecycle", () => {
	let tmpDir: string;
	let db: Database;
	let eventBus: TypedEventEmitter;
	let threadId: string;
	let siteId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(
			join(tmpdir(), `lifecycle-test-${randomBytes(4).toString("hex")}-`),
		);
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);

		// Insert a test user
		const userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted) VALUES (?, ?, NULL, ?, ?, 0)",
			[userId, "LifecycleUser", new Date().toISOString(), new Date().toISOString()],
		);
	});

	beforeEach(() => {
		threadId = randomUUID();
		siteId = randomUUID();
		eventBus = new TypedEventEmitter();

		// Seed host_meta
		db.run("DELETE FROM host_meta");
		db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);
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
			eventBus,
			hostName: "test-host",
			siteId,
			config: {
				allowlist: { default_web_user: "test", users: { test: { display_name: "Test" } } },
				modelBackends: {
					backends: [
						{
							id: "mock",
							provider: "ollama",
							model: "mock",
							base_url: "http://localhost:11434",
							context_window: 8000,
							tier: 1,
							price_per_m_input: 0,
							price_per_m_output: 0,
						},
					],
					default: "mock",
				},
			},
			optionalConfig: {},
		} as unknown as AppContext;
	}

	// -----------------------------------------------------------------------
	// recordTurn after LLM response
	// -----------------------------------------------------------------------
	it("calls recordTurn after LLM response (row inserted into turns table)", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("Hello from the agent.");

		const ctx = makeCtx();
		const agentLoop = new AgentLoop(ctx, createMockSandbox(), mockBackend, {
			threadId,
			userId: "test-user",
			modelId: "mock",
		});

		const turnsBefore = (
			db.query("SELECT COUNT(*) as count FROM turns WHERE thread_id = ?").get(threadId) as {
				count: number;
			}
		).count;

		await agentLoop.run();

		const turnsAfter = (
			db.query("SELECT COUNT(*) as count FROM turns WHERE thread_id = ?").get(threadId) as {
				count: number;
			}
		).count;

		expect(turnsAfter).toBeGreaterThan(turnsBefore);

		// Verify the turn record has expected fields
		const turn = db
			.query(
				"SELECT thread_id, model_id, tokens_in, tokens_out FROM turns WHERE thread_id = ? ORDER BY id DESC LIMIT 1",
			)
			.get(threadId) as {
			thread_id: string;
			model_id: string;
			tokens_in: number;
			tokens_out: number;
		} | null;

		expect(turn).not.toBeNull();
		expect(turn!.thread_id).toBe(threadId);
		expect(turn!.model_id).toBe("mock");
		expect(turn!.tokens_in).toBeGreaterThan(0);
		expect(turn!.tokens_out).toBeGreaterThan(0);
	});

	it("records multiple turns when tool calls produce multiple LLM round-trips", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setToolThenTextResponse(
			"tc-1",
			"bash",
			{ command: "echo hi" },
			"Done.",
		);

		const ctx = makeCtx();
		const agentLoop = new AgentLoop(ctx, createMockSandbox(), mockBackend, {
			threadId,
			userId: "test-user",
			modelId: "mock",
		});

		await agentLoop.run();

		const turns = db
			.query("SELECT * FROM turns WHERE thread_id = ? ORDER BY id ASC")
			.all(threadId) as Array<{ tokens_in: number; tokens_out: number }>;

		// Two LLM calls = two turns
		expect(turns.length).toBe(2);
		expect(turns[0].tokens_in).toBe(100);
		expect(turns[0].tokens_out).toBe(80);
		expect(turns[1].tokens_in).toBe(200);
		expect(turns[1].tokens_out).toBe(60);
	});

	// -----------------------------------------------------------------------
	// extractSummaryAndMemories on completion
	// -----------------------------------------------------------------------
	it("calls extractSummaryAndMemories on completion", async () => {
		const userId = randomUUID();
		const now = new Date().toISOString();

		// Create a thread in the database so extractSummaryAndMemories can find it
		db.run(
			"INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted) VALUES (?, ?, NULL, ?, ?, 0)",
			[userId, "SummaryUser", now, now],
		);
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, 'web', 'localhost', 0, 'Test', NULL, ?, ?, ?, 0)",
			[threadId, userId, now, now, now],
		);

		// Insert a user message so there is context for summarization
		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: threadId,
				role: "user",
				content: "Tell me about TypeScript.",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: "test-host",
			},
			siteId,
		);

		const mockBackend = new MockLLMBackend();
		// First call: the agent's main response
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "TypeScript is a typed superset of JavaScript." };
			yield {
				type: "done" as const,
				usage: { input_tokens: 50, output_tokens: 30 },
			};
		});
		// Second call: will be used by extractSummaryAndMemories
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "Discussion about TypeScript." };
			yield {
				type: "done" as const,
				usage: { input_tokens: 20, output_tokens: 10 },
			};
		});

		const ctx = makeCtx();
		const agentLoop = new AgentLoop(ctx, createMockSandbox(), mockBackend, {
			threadId,
			userId: userId,
			modelId: "mock",
		});

		await agentLoop.run();

		// Give the fire-and-forget extractSummaryAndMemories a moment to complete
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Verify that extractSummaryAndMemories was called by checking its side-effects:
		// It generates a summary LLM call (the second call), so the backend should have
		// been called at least 2 times: once for the main response and once for summary.
		expect(mockBackend.getCallCount()).toBeGreaterThanOrEqual(2);
	});

	// -----------------------------------------------------------------------
	// agent:cancel event
	// -----------------------------------------------------------------------
	it("listens for agent:cancel events and aborts the loop", async () => {
		const mockBackend = new MockLLMBackend();
		// Yield 50 chunks with 50ms delay each (total ~2500ms if uninterrupted).
		// Cancel fires at 100ms, so abort should be detected within a few chunks.
		mockBackend.setManyChunksResponse(50, 50);

		const ctx = makeCtx();
		const agentLoop = new AgentLoop(ctx, createMockSandbox(), mockBackend, {
			threadId,
			userId: "test-user",
			modelId: "mock",
		});

		// Emit cancel shortly after the loop starts
		setTimeout(() => {
			eventBus.emit("agent:cancel", { thread_id: threadId });
		}, 100);

		const startTime = Date.now();
		const result = await agentLoop.run();
		const elapsed = Date.now() - startTime;

		// The loop should have exited well before all 50 chunks were consumed
		expect(elapsed).toBeLessThan(1500);
		// No error because cancel is a controlled exit
		expect(result.error).toBeUndefined();
	});

	it("ignores agent:cancel events for different thread_ids", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setTextResponse("Uninterrupted response.");

		const ctx = makeCtx();
		const agentLoop = new AgentLoop(ctx, createMockSandbox(), mockBackend, {
			threadId,
			userId: "test-user",
			modelId: "mock",
		});

		// Emit cancel for a *different* thread
		setTimeout(() => {
			eventBus.emit("agent:cancel", { thread_id: randomUUID() });
		}, 10);

		const result = await agentLoop.run();

		// Should complete normally
		expect(result.messagesCreated).toBe(1);
		expect(result.error).toBeUndefined();
	});

	it("aborts via AbortSignal as well", async () => {
		const controller = new AbortController();
		const mockBackend = new MockLLMBackend();
		// Same multi-chunk approach: 50 chunks x 50ms = ~2500ms uninterrupted
		mockBackend.setManyChunksResponse(50, 50);

		const ctx = makeCtx();
		const agentLoop = new AgentLoop(ctx, createMockSandbox(), mockBackend, {
			threadId,
			userId: "test-user",
			modelId: "mock",
			abortSignal: controller.signal,
		});

		setTimeout(() => controller.abort(), 100);

		const startTime = Date.now();
		const result = await agentLoop.run();
		const elapsed = Date.now() - startTime;

		expect(elapsed).toBeLessThan(1500);
		expect(result.error).toBeUndefined();
	});

	// -----------------------------------------------------------------------
	// Messages are persisted immediately after tool execution
	// -----------------------------------------------------------------------
	it("persists tool_call and tool_result messages before the next LLM call", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setToolThenTextResponse(
			"tc-persist",
			"bash",
			{ command: "echo test" },
			"Final.",
		);

		const ctx = makeCtx();
		const agentLoop = new AgentLoop(ctx, createMockSandbox(), mockBackend, {
			threadId,
			userId: "test-user",
			modelId: "mock",
		});

		await agentLoop.run();

		const msgs = db
			.query(
				"SELECT role, created_at FROM messages WHERE thread_id = ? ORDER BY created_at ASC",
			)
			.all(threadId) as Array<{ role: string; created_at: string }>;

		// tool_call comes first, then tool_result, then assistant
		expect(msgs.length).toBe(3);
		expect(msgs[0].role).toBe("tool_call");
		expect(msgs[1].role).toBe("tool_result");
		expect(msgs[2].role).toBe("assistant");

		// Timestamps must be ordered: tool messages before final assistant
		expect(msgs[0].created_at <= msgs[2].created_at).toBe(true);
		expect(msgs[1].created_at <= msgs[2].created_at).toBe(true);
	});
});
