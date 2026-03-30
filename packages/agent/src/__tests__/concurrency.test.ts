import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { LLMBackend } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { AgentLoop } from "../agent-loop";
import { findPendingUserMessage } from "../agent-loop-utils";

// Mock LLM Backend that returns text responses
class MockLLMBackend implements LLMBackend {
	async *chat() {
		yield { type: "text" as const, content: "Response from LLM" };
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

// Mock sandbox
function createMockSandbox() {
	return {
		exec: async () => ({ stdout: "mock output", stderr: "", exitCode: 0 }),
	};
}

function createMockRouter(backend: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("claude-opus", backend);
	return new ModelRouter(backends, "claude-opus");
}

describe("Concurrent agent loops with WAL serialization (R-U3)", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let userId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "concurrency-test-"));
		dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);

		// Create a test user
		userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
	});

	afterAll(() => {
		db.close();
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
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
				off: () => {},
				emit: () => {},
			},
			hostName: "test-host",
			siteId: "test-site-id",
		} as unknown as AppContext;
	}

	it("should run two agent loops concurrently on the same database without deadlocking", async () => {
		// Create two threads with initial user messages
		const threadId1 = randomUUID();
		const threadId2 = randomUUID();

		// Create threads
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId1,
				userId,
				"web",
				"local",
				0,
				"Thread 1",
				null,
				null,
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId2,
				userId,
				"web",
				"local",
				0,
				"Thread 2",
				null,
				null,
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		// Insert user messages in both threads
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				randomUUID(),
				threadId1,
				"user",
				"Hello from thread 1",
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				"local",
			],
		);

		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				randomUUID(),
				threadId2,
				"user",
				"Hello from thread 2",
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				"local",
			],
		);

		// Create two AgentLoop instances with mock LLM backends
		const mockBackend1 = new MockLLMBackend();
		const mockBackend2 = new MockLLMBackend();
		const mockBash1 = createMockSandbox();
		const mockBash2 = createMockSandbox();
		const ctx = makeCtx();

		const agentLoop1 = new AgentLoop(ctx, mockBash1, createMockRouter(mockBackend1), {
			threadId: threadId1,
			userId,
		});

		const agentLoop2 = new AgentLoop(ctx, mockBash2, createMockRouter(mockBackend2), {
			threadId: threadId2,
			userId,
		});

		// Run both loops concurrently
		const [result1, result2] = await Promise.all([agentLoop1.run(), agentLoop2.run()]);

		// Verify both completed without errors
		expect(result1.error).toBeUndefined();
		expect(result2.error).toBeUndefined();

		// Verify both created assistant responses
		expect(result1.messagesCreated).toBeGreaterThan(0);
		expect(result2.messagesCreated).toBeGreaterThan(0);

		// Verify both threads have assistant messages in the database
		const thread1Messages = db
			.query("SELECT role, content FROM messages WHERE thread_id = ? AND role = 'assistant'")
			.all(threadId1) as Array<{ role: string; content: string }>;

		const thread2Messages = db
			.query("SELECT role, content FROM messages WHERE thread_id = ? AND role = 'assistant'")
			.all(threadId2) as Array<{ role: string; content: string }>;

		expect(thread1Messages.length).toBeGreaterThan(0);
		expect(thread2Messages.length).toBeGreaterThan(0);
		expect(thread1Messages[0].content).toBe("Response from LLM");
		expect(thread2Messages[0].content).toBe("Response from LLM");
	});

	it("should handle multiple concurrent writes to different tables without deadlock", async () => {
		// Create multiple threads
		const threadIds = Array.from({ length: 3 }, () => randomUUID());

		for (const threadId of threadIds) {
			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					threadId,
					userId,
					"web",
					"local",
					0,
					`Thread ${threadId}`,
					null,
					null,
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					new Date().toISOString(),
					0,
				],
			);

			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					threadId,
					"user",
					`Message in ${threadId}`,
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);
		}

		// Create agent loops for all threads
		const ctx = makeCtx();
		const loops = threadIds.map((threadId) => {
			const mockBackend = new MockLLMBackend();
			const mockBash = createMockSandbox();
			return new AgentLoop(ctx, mockBash, createMockRouter(mockBackend), {
				threadId,
				userId,
			});
		});

		// Run all loops concurrently
		const results = await Promise.all(loops.map((loop) => loop.run()));

		// All should complete successfully
		for (const result of results) {
			expect(result.error).toBeUndefined();
			expect(result.messagesCreated).toBeGreaterThan(0);
		}

		// Verify all threads have assistant responses
		for (const threadId of threadIds) {
			const messages = db
				.query("SELECT COUNT(*) as count FROM messages WHERE thread_id = ? AND role = 'assistant'")
				.get(threadId) as { count: number };

			expect(messages.count).toBeGreaterThan(0);
		}
	});
});

// When a user message arrives while a loop is already active for that thread, start.ts
// drops it (activeLoops.has check). After the loop finishes, start.ts must check for
// unprocessed messages and re-trigger. findPendingUserMessage() encapsulates this check.
describe("findPendingUserMessage — queue-skip re-trigger detection", () => {
	let tmpDir: string;
	let db: Database;
	let threadId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "queue-skip-test-"));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
		threadId = randomUUID();
		const userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Queue Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				userId,
				"web",
				"local",
				0,
				"Queue Test",
				null,
				null,
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				new Date().toISOString(),
				0,
			],
		);
	});

	afterAll(() => {
		db.close();
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null when no user messages exist", () => {
		expect(findPendingUserMessage(db, threadId)).toBeNull();
	});

	it("returns null when the only user message has a subsequent assistant response", () => {
		const t1 = new Date(Date.now() - 4000).toISOString();
		const t2 = new Date(Date.now() - 3000).toISOString();
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[randomUUID(), threadId, "user", "first question", null, null, t1, t1, "local"],
		);
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[randomUUID(), threadId, "assistant", "first answer", "model-a", null, t2, t2, "local"],
		);
		expect(findPendingUserMessage(db, threadId)).toBeNull();
	});

	it("returns the pending user message that arrived after the last assistant response", () => {
		// Arrange: user2 arrived AFTER the assistant response
		const t3 = new Date(Date.now() - 1000).toISOString();
		const pendingId = randomUUID();
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				pendingId,
				threadId,
				"user",
				"second question (arrived while loop was active)",
				null,
				null,
				t3,
				t3,
				"local",
			],
		);

		const pending = findPendingUserMessage(db, threadId);
		expect(pending).not.toBeNull();
		expect(pending!.id).toBe(pendingId);
	});

	it("returns null once the pending message has been answered", () => {
		const t4 = new Date().toISOString();
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[randomUUID(), threadId, "assistant", "second answer", "model-a", null, t4, t4, "local"],
		);
		expect(findPendingUserMessage(db, threadId)).toBeNull();
	});
});
