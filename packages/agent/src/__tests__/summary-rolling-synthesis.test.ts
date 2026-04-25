import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import { cleanupTmpDir } from "@bound/shared/test-utils";

let tmpDir: string;
let db: Database;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "summary-rolling-test-"));
	const dbPath = join(tmpDir, "test.db");
	db = createDatabase(dbPath);
	applySchema(db);
	db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', 'test-site-id')");
	// Create a test user so summary extraction can resolve the display name
	const now = new Date().toISOString();
	db.run(
		"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
		["test-user", "Kara", null, now, now, 0],
	);
});

afterAll(async () => {
	db.close();
	await cleanupTmpDir(tmpDir);
});

function insertThread(
	threadDb: Database,
	threadId: string,
	opts?: { summary?: string; summaryThrough?: string },
) {
	const now = new Date(Date.now() - 5000).toISOString();
	threadDb.run(
		"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, summary, summary_through) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[
			threadId,
			"test-user",
			"web",
			"localhost",
			now,
			now,
			now,
			opts?.summary ?? null,
			opts?.summaryThrough ?? null,
		],
	);
}

function insertMessage(
	threadDb: Database,
	threadId: string,
	role: string,
	content: string,
	createdAt?: string,
) {
	threadDb.run(
		"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
		[randomUUID(), threadId, role, content, createdAt ?? new Date().toISOString(), "localhost"],
	);
}

/** Mock LLM that captures all chat params and returns configurable responses. */
class CapturingMockLLM implements LLMBackend {
	capturedCalls: ChatParams[] = [];
	private responseText: string;

	constructor(responseText = "Mock summary response.") {
		this.responseText = responseText;
	}

	async *chat(params: ChatParams): AsyncGenerator<StreamChunk> {
		this.capturedCalls.push(params);
		yield { type: "text" as const, content: this.responseText };
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

describe("rolling synthesis summary extraction", () => {
	it("includes previous summary in the prompt when one exists", async () => {
		const threadId = randomUUID();
		const previousSummary =
			"I investigated a cost spike on 4/22. The root cause was missing cache tokens in the cost formula.";
		const summaryThrough = new Date(Date.now() - 60_000).toISOString();

		insertThread(db, threadId, { summary: previousSummary, summaryThrough });
		insertMessage(
			db,
			threadId,
			"user",
			"Can you also check the token counts?",
			new Date().toISOString(),
		);
		insertMessage(
			db,
			threadId,
			"assistant",
			"Sure, looking into it now.",
			new Date().toISOString(),
		);

		const mock = new CapturingMockLLM("Updated summary with token counts.");
		const { extractSummaryAndMemories } = await import("../summary-extraction");
		await extractSummaryAndMemories(db, threadId, mock, "test-site");

		// The summarization call (first call) must include the previous summary
		expect(mock.capturedCalls.length).toBeGreaterThanOrEqual(1);
		const summaryCall = mock.capturedCalls[0];
		const userPrompt =
			typeof summaryCall.messages[0]?.content === "string" ? summaryCall.messages[0].content : "";

		expect(userPrompt).toContain(previousSummary);
		// Should frame as an UPDATE, not a fresh generation
		expect(userPrompt.toLowerCase()).toContain("previous summary");
	});

	it("generates a first-run summary when no previous summary exists", async () => {
		const threadId = randomUUID();
		insertThread(db, threadId); // no summary

		insertMessage(db, threadId, "user", "Help me debug this auth issue");
		insertMessage(db, threadId, "assistant", "Let me look at the auth middleware.");

		const mock = new CapturingMockLLM("I helped debug an auth issue in the middleware.");
		const { extractSummaryAndMemories } = await import("../summary-extraction");
		await extractSummaryAndMemories(db, threadId, mock, "test-site");

		expect(mock.capturedCalls.length).toBeGreaterThanOrEqual(1);
		const summaryCall = mock.capturedCalls[0];
		const userPrompt =
			typeof summaryCall.messages[0]?.content === "string" ? summaryCall.messages[0].content : "";

		// First-run should NOT reference a previous summary
		expect(userPrompt.toLowerCase()).not.toContain("previous summary");
		// Should mention goal/context/state orientation concepts
		expect(userPrompt.toLowerCase()).toMatch(/goal|context|state/);
	});

	it("formats delta messages: truncates tool results, compresses tool calls, skips system/developer", async () => {
		const threadId = randomUUID();
		const summaryThrough = new Date(Date.now() - 60_000).toISOString();
		insertThread(db, threadId, { summary: "Previous work.", summaryThrough });

		const now = new Date();
		// Insert messages of different roles
		insertMessage(
			db,
			threadId,
			"user",
			"Read the config file",
			new Date(now.getTime() + 1).toISOString(),
		);
		insertMessage(
			db,
			threadId,
			"tool_call",
			'[{"type":"tool_use","name":"bash","input":{"command":"cat config.json"}}]',
			new Date(now.getTime() + 2).toISOString(),
		);
		insertMessage(
			db,
			threadId,
			"tool_result",
			"A".repeat(5000),
			new Date(now.getTime() + 3).toISOString(),
		); // large tool result
		insertMessage(
			db,
			threadId,
			"assistant",
			"The config looks correct.",
			new Date(now.getTime() + 4).toISOString(),
		);
		insertMessage(
			db,
			threadId,
			"system",
			"Internal system notification",
			new Date(now.getTime() + 5).toISOString(),
		);
		insertMessage(
			db,
			threadId,
			"developer",
			"Volatile context injection",
			new Date(now.getTime() + 6).toISOString(),
		);

		const mock = new CapturingMockLLM();
		const { extractSummaryAndMemories } = await import("../summary-extraction");
		await extractSummaryAndMemories(db, threadId, mock, "test-site");

		const summaryCall = mock.capturedCalls[0];
		const userPrompt =
			typeof summaryCall.messages[0]?.content === "string" ? summaryCall.messages[0].content : "";

		// User and assistant messages should be included in full
		expect(userPrompt).toContain("Read the config file");
		expect(userPrompt).toContain("The config looks correct.");

		// Tool result should be truncated (5000 chars -> much shorter)
		expect(userPrompt).not.toContain("A".repeat(5000));
		expect(userPrompt).toContain("[Tool result");

		// System and developer messages should be excluded
		expect(userPrompt).not.toContain("Internal system notification");
		expect(userPrompt).not.toContain("Volatile context injection");
	});

	it("uses a token budget of at least 500 (up from 200)", async () => {
		const threadId = randomUUID();
		insertThread(db, threadId);
		insertMessage(db, threadId, "user", "Hello");

		const mock = new CapturingMockLLM();
		const { extractSummaryAndMemories } = await import("../summary-extraction");
		await extractSummaryAndMemories(db, threadId, mock, "test-site");

		const summaryCall = mock.capturedCalls[0];
		expect(summaryCall.max_tokens).toBeGreaterThanOrEqual(500);
	});

	it("accumulates context across multiple extractions", async () => {
		const threadId = randomUUID();
		insertThread(db, threadId); // fresh thread, no summary

		// First batch of messages
		const t1 = new Date(Date.now() - 30_000).toISOString();
		insertMessage(db, threadId, "user", "Investigate the cost spike on April 22", t1);
		insertMessage(
			db,
			threadId,
			"assistant",
			"Found that cache tokens were missing from cost formula.",
			t1,
		);

		// First extraction — generates initial summary
		const mock1 = new CapturingMockLLM(
			"I investigated a cost spike. Cache tokens were missing from the cost formula.",
		);
		const { extractSummaryAndMemories } = await import("../summary-extraction");
		await extractSummaryAndMemories(db, threadId, mock1, "test-site");

		// Verify first summary was written
		const thread1 = db
			.prepare("SELECT summary, summary_through FROM threads WHERE id = ?")
			.get(threadId) as {
			summary: string;
			summary_through: string;
		};
		expect(thread1.summary).toContain("cost");

		// Second batch of messages — must be AFTER summary_through from the first extraction.
		// Add 2 seconds to ensure the delta query picks them up.
		const t2 = new Date(Date.now() + 2000).toISOString();
		insertMessage(db, threadId, "user", "Now fix the TurnStateStore to use AppContext", t2);
		insertMessage(
			db,
			threadId,
			"assistant",
			"I'll move the cached state from instance to context level.",
			t2,
		);

		// Second extraction — should receive the first summary in its prompt
		const mock2 = new CapturingMockLLM(
			"I investigated a cost spike (cache tokens missing). Now working on TurnStateStore refactor.",
		);
		await extractSummaryAndMemories(db, threadId, mock2, "test-site");

		// The second call must have received the first summary
		expect(mock2.capturedCalls.length).toBeGreaterThanOrEqual(1);
		const userPrompt =
			typeof mock2.capturedCalls[0].messages[0]?.content === "string"
				? mock2.capturedCalls[0].messages[0].content
				: "";
		expect(userPrompt).toContain("cost");
		expect(userPrompt).toContain("Cache tokens");

		// Final summary in DB should reflect both phases
		const thread2 = db.prepare("SELECT summary FROM threads WHERE id = ?").get(threadId) as {
			summary: string;
		};
		expect(thread2.summary).toContain("TurnStateStore");
	});

	it("includes user display name in the system prompt and instructs not to use 'you'", async () => {
		const threadId = randomUUID();
		insertThread(db, threadId);
		insertMessage(db, threadId, "user", "What's the status of the deployment?");

		const mock = new CapturingMockLLM();
		const { extractSummaryAndMemories } = await import("../summary-extraction");
		await extractSummaryAndMemories(db, threadId, mock, "test-site");

		expect(mock.capturedCalls.length).toBeGreaterThanOrEqual(1);
		const systemPrompt = mock.capturedCalls[0].system ?? "";

		// Should include the user's name
		expect(systemPrompt).toContain("Kara");
		// Should instruct against using "you"
		expect(systemPrompt).toContain('never as "you"');
	});
});
