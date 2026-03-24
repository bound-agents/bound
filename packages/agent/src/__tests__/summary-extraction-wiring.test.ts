import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { AgentLoop } from "../agent-loop";

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
			"INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
	});

	afterAll(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
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
			async *chat(params: { messages: Array<{ role: string; content: string }> }): AsyncGenerator<StreamChunk> {
				// Check if this is a summary extraction call (single user message with "Summarize")
				const lastMsg = params.messages[params.messages.length - 1];
				if (lastMsg?.content?.includes("Summarize")) {
					chatCalls.push({ purpose: "summary" });
					yield { type: "text" as const, content: "This was a conversation about greetings." };
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
			eventBus: { on: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: "test-site-id",
		} as unknown as AppContext;

		const agentLoop = new AgentLoop(ctx, mockSandbox, new MockLLMBackend(), {
			threadId,
			userId: "test-user",
		});

		const result = await agentLoop.run();
		expect(result.error).toBeUndefined();
		expect(result.messagesCreated).toBeGreaterThan(0);

		// Wait briefly for the fire-and-forget extractSummaryAndMemories to complete
		await new Promise((resolve) => setTimeout(resolve, 200));

		// The main loop made 1 call; the extraction made another
		expect(chatCalls.length).toBe(2);
		expect(chatCalls[0].purpose).toBe("main");
		expect(chatCalls[1].purpose).toBe("summary");

		// Verify the thread's summary was updated
		const thread = db.prepare("SELECT summary FROM threads WHERE id = ?").get(threadId) as {
			summary: string | null;
		};
		expect(thread.summary).toBeTruthy();
		expect(thread.summary).toContain("greetings");
	});
});
