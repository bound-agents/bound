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
				yield { type: "done" as const, usage: { input_tokens: 5, output_tokens: 5 } };
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

		// Create a mock LLM backend that tracks all chat() calls
		const chatCalls: Array<{ purpose: string }> = [];

		class MockLLMBackend implements LLMBackend {
			async *chat(params: {
				messages: Array<{ role: string; content: string }>;
			}): AsyncGenerator<StreamChunk> {
				const lastMsg = params.messages[params.messages.length - 1];
				if (lastMsg?.content?.includes("Summarize")) {
					chatCalls.push({ purpose: "summary" });
					yield { type: "text" as const, content: "This was a conversation about greetings." };
				} else if (lastMsg?.content?.includes("Extract up to 3 key facts")) {
					chatCalls.push({ purpose: "facts" });
					yield { type: "text" as const, content: "- The conversation was about greetings" };
				} else {
					chatCalls.push({ purpose: "main" });
					yield { type: "text" as const, content: "Hello there!" };
				}
				yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 5 } };
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
		expect(thread.summary).toContain("greetings");
	});
});
