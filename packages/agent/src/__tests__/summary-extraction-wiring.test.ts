import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { AgentLoop } from "../agent-loop";

function createMockRouter(backend: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("claude-opus", backend);
	return new ModelRouter(backends, "claude-opus");
}

describe("extractSummaryAndMemories wiring (R-E17/idle trigger)", () => {
	let tmpDir: string;
	let db: Database;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "summary-wiring-test-"));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);

		// Set up host_meta for change-log outbox
		db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', 'test-site-id')");

		// Create a test user
		const userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
	});

	afterAll(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// Bug #5: extracted memories must not contain the literal placeholder "Extracted from conversation"
	it("extractSummaryAndMemories stores actual LLM-derived content, not a placeholder", async () => {
		const threadId = randomUUID();
		const now = new Date(Date.now() - 5000).toISOString(); // slightly in the past

		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[threadId, "test-user", "web", "localhost", now, now, now],
		);
		for (let i = 0; i < 4; i++) {
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					threadId,
					i % 2 === 0 ? "user" : "assistant",
					`Message ${i}`,
					now,
					"localhost",
				],
			);
		}

		let callNumber = 0;
		class FactMockLLMBackend implements LLMBackend {
			async *chat(): AsyncGenerator<StreamChunk> {
				callNumber++;
				if (callNumber === 1) {
					// First call: summary
					yield { type: "text" as const, content: "The user discussed topic Alpha and Beta." };
				} else {
					// Second call: fact extraction
					yield {
						type: "text" as const,
						content: "- The user discussed topic Alpha\n- The user discussed topic Beta",
					};
				}
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 5,
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

		const { extractSummaryAndMemories } = await import("../summary-extraction");
		const result = await extractSummaryAndMemories(
			db,
			threadId,
			new FactMockLLMBackend(),
			"test-site",
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.memoriesExtracted).toBeGreaterThan(0);
		}

		// No memory must contain the literal placeholder
		const memories = db
			.prepare("SELECT value FROM semantic_memory WHERE source = ?")
			.all(threadId) as Array<{ value: string }>;

		expect(memories.length).toBeGreaterThan(0);
		for (const mem of memories) {
			expect(mem.value).not.toBe("Extracted from conversation");
			// Values must contain real content from the LLM response
			expect(mem.value.length).toBeGreaterThan(5);
		}
	});

	it("summary update creates change_log entry for threads table", async () => {
		const threadId = randomUUID();
		const now = new Date(Date.now() - 5000).toISOString();

		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[threadId, "test-user", "web", "localhost", now, now, now],
		);
		for (let i = 0; i < 4; i++) {
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
				[randomUUID(), threadId, i % 2 === 0 ? "user" : "assistant", `Msg ${i}`, now, "localhost"],
			);
		}

		let callNumber = 0;
		class SummaryMockLLM implements LLMBackend {
			async *chat(): AsyncGenerator<StreamChunk> {
				callNumber++;
				if (callNumber === 1) {
					yield { type: "text" as const, content: "Thread summary content here." };
				} else {
					yield { type: "text" as const, content: "- I learned something" };
				}
				yield {
					type: "done" as const,
					usage: { input_tokens: 5, output_tokens: 5, cache_write_tokens: null, cache_read_tokens: null, estimated: false },
				};
			}
			capabilities() {
				return { streaming: true, tool_use: true, system_prompt: true, prompt_caching: false, vision: false, max_context: 8000 };
			}
		}

		// Count change_log entries for this thread before extraction
		const beforeCount = (
			db.prepare("SELECT count(*) as cnt FROM change_log WHERE table_name = 'threads' AND row_id = ?").get(threadId) as { cnt: number }
		).cnt;

		const { extractSummaryAndMemories } = await import("../summary-extraction");
		await extractSummaryAndMemories(db, threadId, new SummaryMockLLM(), "test-site");

		// Verify summary was written
		const thread = db.prepare("SELECT summary FROM threads WHERE id = ?").get(threadId) as { summary: string | null };
		expect(thread.summary).toBeTruthy();

		// Verify change_log entry was created (critical for sync)
		const afterCount = (
			db.prepare("SELECT count(*) as cnt FROM change_log WHERE table_name = 'threads' AND row_id = ?").get(threadId) as { cnt: number }
		).cnt;
		expect(afterCount).toBeGreaterThan(beforeCount);
	});

	it("fires extractSummaryAndMemories after loop completion", async () => {
		const threadId = randomUUID();
		const now = new Date().toISOString();

		// Create the thread so summary extraction can find it
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[threadId, "test-user", "web", "localhost", now, now, now],
		);

		// Insert a user message so the thread has content
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
			[randomUUID(), threadId, "user", "Hello world", now, "localhost"],
		);

		// Create a mock LLM backend that tracks all chat() calls including prompts
		const chatCalls: Array<{ purpose: string; systemPrompt?: string; userPrompt: string }> = [];

		class MockLLMBackend implements LLMBackend {
			async *chat(params: {
				system?: string;
				messages: Array<{ role: string; content: string }>;
			}): AsyncGenerator<StreamChunk> {
				const lastMsg = params.messages[params.messages.length - 1];
				const userPrompt = typeof lastMsg?.content === "string" ? lastMsg.content : "";
				if (
					userPrompt.toLowerCase().includes("summarize") ||
					userPrompt.toLowerCase().includes("reflecting") ||
					userPrompt.toLowerCase().includes("summary")
				) {
					chatCalls.push({ purpose: "summary", systemPrompt: params.system, userPrompt });
					yield {
						type: "text" as const,
						content: "I helped the user test a greeting interaction.",
					};
				} else if (userPrompt.includes("key facts") || userPrompt.includes("key things")) {
					chatCalls.push({ purpose: "facts", systemPrompt: params.system, userPrompt });
					yield { type: "text" as const, content: "- I responded to a greeting from the user" };
				} else {
					chatCalls.push({ purpose: "main", systemPrompt: params.system, userPrompt });
					yield { type: "text" as const, content: "Hello there!" };
				}
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

		const mockSandbox = {};
		const ctx = {
			db,
			logger: { info: () => {}, warn: () => {}, error: () => {} },
			eventBus: { on: () => {}, off: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: "test-site-id",
		} as unknown as AppContext;

		const agentLoop = new AgentLoop(ctx, mockSandbox, createMockRouter(new MockLLMBackend()), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();
		expect(result.error).toBeUndefined();
		expect(result.messagesCreated).toBeGreaterThan(0);

		// Wait briefly for the fire-and-forget extractSummaryAndMemories to complete
		await new Promise((resolve) => setTimeout(resolve, 200));

		// The main loop made 1 call; extraction made a summary call + a facts call
		expect(chatCalls.length).toBe(3);
		expect(chatCalls[0].purpose).toBe("main");
		expect(chatCalls[1].purpose).toBe("summary");
		expect(chatCalls[2].purpose).toBe("facts");

		// Verify the thread's summary was updated
		const thread = db.prepare("SELECT summary FROM threads WHERE id = ?").get(threadId) as {
			summary: string | null;
		};
		expect(thread.summary).toBeTruthy();

		// The summarization and fact-extraction calls must include first-person framing
		// so the agent experiences summarization as its own reflection, not as a third-party
		// observer. This ensures summaries read "I helped..." rather than "The user asked..."
		const summaryCall = chatCalls.find((c) => c.purpose === "summary");
		expect(summaryCall).toBeDefined();
		// Either the system prompt or the user prompt must convey first-person perspective
		const summaryContext = (summaryCall?.systemPrompt ?? "") + summaryCall?.userPrompt;
		const hasFirstPersonFraming =
			summaryContext.toLowerCase().includes("first person") ||
			summaryContext.toLowerCase().includes("your own") ||
			summaryContext.toLowerCase().includes("you are") ||
			summaryContext.toLowerCase().includes("reflecting");
		expect(hasFirstPersonFraming).toBe(true);
	});
});
