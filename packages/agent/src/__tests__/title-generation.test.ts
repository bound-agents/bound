import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { generateThreadTitle } from "../title-generation";

describe("Title Generation", () => {
	let db: Database.Database;
	const siteId = "test-site";

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("should generate a title from first messages", async () => {
		const userId = randomUUID();
		const threadId = randomUUID();
		const now = new Date().toISOString();

		// Create user
		db.prepare(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
		).run(userId, "Test User", now, now);

		// Create thread (without title)
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(threadId, userId, "web", "localhost", now, now);

		// Create messages
		db.prepare(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
		).run(randomUUID(), threadId, "user", "What is the capital of France?", now, "localhost");
		db.prepare(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
		).run(randomUUID(), threadId, "assistant", "Paris is the capital of France.", now, "localhost");

		// Mock LLM backend
		const mockBackend: LLMBackend = {
			chat: async function* () {
				yield {
					type: "text",
					content: "Capital of France",
				} as StreamChunk;
				yield {
					type: "done",
					usage: { input_tokens: 10, output_tokens: 3 },
				} as StreamChunk;
			},
			capabilities: () => ({
				streaming: true,
				tool_use: true,
				system_prompt: true,
				prompt_caching: false,
				vision: false,
				max_context: 8192,
			}),
		};

		const result = await generateThreadTitle(db, threadId, mockBackend, siteId);

		expect(result.ok).toBe(true);
		expect(result.value).toBe("Capital of France");

		// Verify title was stored
		const thread = db.prepare("SELECT title FROM threads WHERE id = ?").get(threadId) as {
			title: string;
		};
		expect(thread.title).toBe("Capital of France");
	});

	it("should not regenerate if title already exists", async () => {
		const userId = randomUUID();
		const threadId = randomUUID();
		const now = new Date().toISOString();

		// Create user
		db.prepare(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
		).run(userId, "Test User", now, now);

		// Create thread with existing title
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, title, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(threadId, userId, "web", "localhost", "Existing Title", now, now);

		// Create messages
		db.prepare(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
		).run(randomUUID(), threadId, "user", "Question", now, "localhost");

		// Track if LLM was called
		let llmCalled = false;

		const mockBackend: LLMBackend = {
			chat: async function* () {
				llmCalled = true;
				yield {
					type: "text",
					content: "New Title",
				} as StreamChunk;
			},
			capabilities: () => ({
				streaming: true,
				tool_use: true,
				system_prompt: true,
				prompt_caching: false,
				vision: false,
				max_context: 8192,
			}),
		};

		const result = await generateThreadTitle(db, threadId, mockBackend, siteId);

		expect(result.ok).toBe(true);
		expect(result.value).toBe("Existing Title");
		expect(llmCalled).toBe(false); // LLM should not have been called
	});

	it("should handle error when no user message exists", async () => {
		const userId = randomUUID();
		const threadId = randomUUID();
		const now = new Date().toISOString();

		// Create user
		db.prepare(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
		).run(userId, "Test User", now, now);

		// Create thread without messages
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(threadId, userId, "web", "localhost", now, now);

		const mockBackend: LLMBackend = {
			chat: async function* () {
				// Should not be called
				yield {
					type: "done",
					usage: { input_tokens: 0, output_tokens: 0 },
				} as StreamChunk;
			},
			capabilities: () => ({
				streaming: true,
				tool_use: true,
				system_prompt: true,
				prompt_caching: false,
				vision: false,
				max_context: 8192,
			}),
		};

		const result = await generateThreadTitle(db, threadId, mockBackend, siteId);

		expect(result.ok).toBe(false);
		expect(result.error?.message).toContain("No user message found");
	});
});
