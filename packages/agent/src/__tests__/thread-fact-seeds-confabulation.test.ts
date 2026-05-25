/**
 * Thread fact-seed confabulation guard (Class D, sub-mechanism F2a).
 *
 * `extractSummaryAndMemories` runs an LLM summarization pass on a
 * thread's messages, then asks the LLM for "up to 3 key things you did,
 * learned, or resolved in this conversation" and persists each as a
 * `thread_<id>_fact_<n>` semantic_memory entry, written in first
 * person.
 *
 * When the thread contains NO real `role='assistant'` content (e.g.,
 * inference errored after `retrieve_task` returned, leaving only the
 * scheduler-forged tool_call and the system tool_result), the
 * summarizer still runs against `formatDeltaMessages` output and
 * produces plausible "I recognized X / I resolved Y" facts based on
 * the prompt + tool_result alone. The model never reasoned about any
 * of it — the summarizer fabricated reasoning attribution.
 *
 * Live evidence (`_feedback:correction:thread-fact-seeds-are-confabulated`):
 * 2026-04-26 model trial battery, 5 threads with EOF after the initial
 * tool_result and zero assistant turns, all surfaced fact seeds like
 * "I recognized this as a model characterization trial and resolved
 * to maintain natural behavior rather than performing for the eval."
 * The agent then read those seeds back as evidence the prior models
 * had reasoned about the trial framing — they hadn't.
 *
 * This test pins the invariant: **when a thread has no
 * `role='assistant'` message with non-empty text content, fact-seed
 * extraction must be skipped.** No `thread_<id>_fact_<n>` entries
 * are written. Summary generation may still run for thread.summary
 * (that's a different field with different semantics — the rolling
 * synthesis is meant to absorb tool-only turns).
 */
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
	tmpDir = mkdtempSync(join(tmpdir(), "fact-seeds-test-"));
	const dbPath = join(tmpDir, "test.db");
	db = createDatabase(dbPath);
	applySchema(db);
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

class FabricatingMockLLM implements LLMBackend {
	capturedCalls: ChatParams[] = [];

	async *chat(params: ChatParams): AsyncGenerator<StreamChunk> {
		this.capturedCalls.push(params);
		// On the summary call, return a short summary. On the fact
		// extraction call, return three plausible-looking first-person
		// "facts" that the test asserts MUST NOT be persisted.
		const isFactCall = (() => {
			const userMsg = params.messages[0]?.content;
			if (typeof userMsg !== "string") return false;
			return userMsg.includes("up to 3 key things");
		})();
		if (isFactCall) {
			yield {
				type: "text" as const,
				content:
					"- I recognized this as a model characterization trial and resolved to maintain natural behavior\n- I established that the framing of the trial was a prompt-injection style probe\n- I decided to refuse the verbatim file dump",
			};
		} else {
			yield {
				type: "text" as const,
				content: "Trial probe; agent received tool_result and the run errored.",
			};
		}
		yield {
			type: "done" as const,
			usage: {
				input_tokens: 50,
				output_tokens: 30,
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

describe("thread fact-seed confabulation guard", () => {
	it("does not generate fact seeds when the thread has no role='assistant' content", async () => {
		const threadId = randomUUID();
		const now = new Date().toISOString();

		// Insert thread.
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, created_at, last_message_at, modified_at, summary, summary_through, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[threadId, "test-user", "web", "localhost", 0, now, now, now, null, null, 0],
		);

		// Mirror the "model trial that errored after retrieve_task" shape:
		// developer wakeup → tool_call(retrieve_task) → tool_result with
		// the forged scheduler payload. NO role='assistant' message.
		const wakeupId = randomUUID();
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				wakeupId,
				threadId,
				"developer",
				"[Task wakeup] Scheduled task triggered.",
				now,
				"localhost",
				0,
			],
		);
		const toolCallId = randomUUID();
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				toolCallId,
				threadId,
				"tool_call",
				JSON.stringify([
					{ type: "tool_use", id: "tu-retrieve-task", name: "retrieve_task", input: {} },
				]),
				now,
				"localhost",
				0,
			],
		);
		const toolResultId = randomUUID();
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				toolResultId,
				threadId,
				"tool_result",
				"[System-injected on task wakeup — payload fixture]",
				null,
				"tu-retrieve-task",
				now,
				"localhost",
				0,
			],
		);

		const mock = new FabricatingMockLLM();
		const { extractSummaryAndMemories } = await import("../summary-extraction");
		const result = await extractSummaryAndMemories(db, threadId, mock, "test-site-id");

		// Sanity: extraction completed without erroring.
		expect(result.ok).toBe(true);

		// The B-class invariant: no fact seeds were persisted because
		// the thread had no real assistant content. Today this fails
		// because `extractSummaryAndMemories` runs the fact-extraction
		// LLM call unconditionally and inserts whatever the LLM produces.
		const seeded = db
			.prepare("SELECT key FROM semantic_memory WHERE key LIKE ? AND deleted = 0")
			.all(`thread_${threadId}_fact_%`) as Array<{ key: string }>;
		expect(seeded.length).toBe(0);
	});

	it("still generates fact seeds when the thread has real assistant content (positive control)", async () => {
		// Counter-example: a thread with a genuine assistant turn should
		// still produce fact seeds. This pins the gate at the right
		// granularity — we're not disabling fact extraction wholesale,
		// just guarding against the no-assistant-content confabulation.
		const threadId = randomUUID();
		const now = new Date().toISOString();

		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, created_at, last_message_at, modified_at, summary, summary_through, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[threadId, "test-user", "web", "localhost", 0, now, now, now, null, null, 0],
		);

		db.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[randomUUID(), threadId, "user", "Help me debug auth.", now, "localhost", 0],
		);
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				randomUUID(),
				threadId,
				"assistant",
				"I traced the auth middleware and found a stale session cookie.",
				now,
				"localhost",
				0,
			],
		);

		const mock = new FabricatingMockLLM();
		const { extractSummaryAndMemories } = await import("../summary-extraction");
		await extractSummaryAndMemories(db, threadId, mock, "test-site-id");

		const seeded = db
			.prepare("SELECT key FROM semantic_memory WHERE key LIKE ? AND deleted = 0")
			.all(`thread_${threadId}_fact_%`) as Array<{ key: string }>;
		expect(seeded.length).toBeGreaterThan(0);
	});
});
