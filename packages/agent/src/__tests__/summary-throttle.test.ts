/**
 * Summary regeneration throttle — boundary-aware byte stability.
 *
 * Background. `extractSummaryAndMemories` is called from the agent-loop at
 * the end of every turn (agent-loop.ts:2401). It regenerates `thread.summary`
 * via an LLM call whenever any messages exist after `summary_through`. That
 * regeneration produces non-deterministic LLM output — different bytes each
 * time even when the semantic content is identical.
 *
 * The cold-path assembly (context-assembly.ts:1015-1032) reads the fresh
 * `thread.summary` and prepends it as a developer message. The bridge
 * converts that head developer into msg[0] of the wire request. Bedrock
 * sees a different msg[0] every time the summary regenerates, breaking
 * the prefix bytes leading up to the message-level cachePoint.
 *
 * Live evidence (thread `7339231f-…` post-bucket-aligned-placer fix):
 * msg[0] mutated from "I (the assistant) previously left a review..." to
 * "I previously left a review..." across two turns 22 seconds apart. The
 * cachePoint position was stable (msg index 14, byte ~80k both turns) but
 * the prefix bytes leading up to it differed → message-level cache miss.
 *
 * Boundary-aware throttle. The compaction boundary is the index of the
 * latest user message (history-compaction/compact.ts:32). Within an inner-
 * loop tool round (no new user message), the boundary is FROZEN — no new
 * messages are getting compacted, so the summary doesn't need to absorb
 * anything new. Skip regeneration in that regime. When a new user message
 * arrives, the boundary advances and previously-uncompacted assistant +
 * tool_result messages from the prior turn move below the boundary; the
 * summary then needs to absorb them.
 *
 * Property pinned here:
 *
 *   T1 (load-bearing) — calling `extractSummaryAndMemories` twice in
 *      succession on a thread WITHOUT a new user message in between MUST
 *      produce a byte-identical `thread.summary`. Today this FAILS because
 *      the second call regenerates the summary via the LLM (which returns
 *      different bytes). After the throttle lands, the second call is a
 *      no-op and the bytes stay identical.
 *
 *   T2 — when a new user message is inserted between calls, the second
 *      call MAY regenerate (the boundary advanced past `summary_through`).
 *      This guards against the throttle being too aggressive — the summary
 *      MUST absorb newly-compacted content so the agent doesn't lose
 *      orientation mid-thread.
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
	tmpDir = mkdtempSync(join(tmpdir(), "summary-throttle-test-"));
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

/**
 * Returns DIFFERENT bytes on each call, mimicking real LLM nondeterminism.
 * The throttle's job is to make this irrelevant — even with a fully
 * adversarial mock, the summary bytes must stay stable when the boundary
 * hasn't advanced.
 */
class NondeterministicMockLLM implements LLMBackend {
	private callCount = 0;

	async *chat(params: ChatParams): AsyncGenerator<StreamChunk> {
		this.callCount++;
		const userMsg = params.messages[0]?.content;
		const isFactCall = typeof userMsg === "string" && userMsg.includes("up to 3 key things");
		if (isFactCall) {
			yield {
				type: "text" as const,
				content: "- Did some work\n- Made a decision\n- Resolved an issue",
			};
		} else {
			// Different bytes on each summary call — the throttle's job is to
			// make this immaterial.
			yield {
				type: "text" as const,
				content: `Summary version ${this.callCount}: I am working on the task.`,
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

function insertThread(threadId: string): void {
	const now = new Date().toISOString();
	db.run(
		"INSERT INTO threads (id, user_id, interface, host_origin, color, created_at, last_message_at, modified_at, summary, summary_through, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[threadId, "test-user", "web", "localhost", 0, now, now, now, null, null, 0],
	);
}

function insertMessage(
	threadId: string,
	role: string,
	content: string,
	createdAt?: string,
): string {
	const id = randomUUID();
	const ts = createdAt ?? new Date().toISOString();
	db.run(
		"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
		[id, threadId, role, content, ts, "localhost", 0],
	);
	return id;
}

function getSummary(threadId: string): { summary: string | null; summary_through: string | null } {
	return db.prepare("SELECT summary, summary_through FROM threads WHERE id = ?").get(threadId) as {
		summary: string | null;
		summary_through: string | null;
	};
}

describe("Summary regeneration throttle — boundary-aware byte stability", () => {
	it("T1 (load-bearing): two consecutive extractSummaryAndMemories calls without a new user message must produce byte-equal thread.summary", async () => {
		const threadId = randomUUID();
		insertThread(threadId);

		// Set up a thread with: user → assistant → tool_call → tool_result.
		// The compaction boundary will be at the user message index.
		const baseTime = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min ago
		insertMessage(threadId, "user", "Please help me investigate this bug.", baseTime);
		insertMessage(threadId, "assistant", "Sure, let me start by checking the logs.", baseTime);
		insertMessage(
			threadId,
			"tool_call",
			`[{"type":"tool_use","id":"t1","name":"bash","input":{}}]`,
			baseTime,
		);
		insertMessage(threadId, "tool_result", "Found the root cause in line 42.", baseTime);

		const mock = new NondeterministicMockLLM();
		const { extractSummaryAndMemories } = await import("../summary-extraction");

		// First call: generates the initial summary.
		const r1 = await extractSummaryAndMemories(db, threadId, mock, "test-site-id");
		expect(r1.ok).toBe(true);
		const after1 = getSummary(threadId);
		expect(after1.summary).not.toBeNull();

		// Simulate an inner-loop tool round: agent appended one more
		// assistant + tool_result WITHOUT a new user message. The
		// compaction boundary (= index of latest user) is unchanged.
		insertMessage(threadId, "assistant", "Now let me apply the fix.", new Date().toISOString());
		insertMessage(threadId, "tool_result", "Fix applied successfully.", new Date().toISOString());

		// Second call: SHOULD be a no-op because the boundary hasn't
		// advanced past summary_through. Today FAILS — the call regenerates
		// the summary via the LLM (which returns different bytes per the
		// NondeterministicMockLLM), and `thread.summary` mutates.
		const r2 = await extractSummaryAndMemories(db, threadId, mock, "test-site-id");
		expect(r2.ok).toBe(true);
		const after2 = getSummary(threadId);

		expect(after2.summary).toBe(after1.summary);
	});

	it("T2: a new user message between calls advances the boundary and may trigger regeneration", async () => {
		const threadId = randomUUID();
		insertThread(threadId);

		const baseTime = new Date(Date.now() - 10 * 60_000).toISOString();
		insertMessage(threadId, "user", "Investigate the build failure.", baseTime);
		insertMessage(threadId, "assistant", "Looking at the error logs now.", baseTime);
		insertMessage(
			threadId,
			"tool_call",
			`[{"type":"tool_use","id":"t1","name":"bash","input":{}}]`,
			baseTime,
		);
		insertMessage(threadId, "tool_result", "Build succeeded after retry.", baseTime);

		const mock = new NondeterministicMockLLM();
		const { extractSummaryAndMemories } = await import("../summary-extraction");

		const r1 = await extractSummaryAndMemories(db, threadId, mock, "test-site-id");
		expect(r1.ok).toBe(true);
		const after1 = getSummary(threadId);
		expect(after1.summary).not.toBeNull();

		// Advance the boundary by inserting a new user message. The
		// previously-uncompacted assistant + tool_result now sit BEFORE
		// the boundary (compactable) and need to be absorbed into the
		// summary. Force a strictly-future timestamp so the SELECT
		// `created_at > summary_through` check in extractSummaryAndMemories
		// can't be tripped by a same-millisecond collision.
		const futureTs = new Date(Date.now() + 5_000).toISOString();
		insertMessage(threadId, "user", "Now also verify the deployment works.", futureTs);

		const r2 = await extractSummaryAndMemories(db, threadId, mock, "test-site-id");
		expect(r2.ok).toBe(true);
		const after2 = getSummary(threadId);

		// The throttle must NOT skip when the boundary advances — content
		// would be lost from orientation otherwise. The summary should
		// change because the mock LLM returns different bytes per call.
		// (Asserting summary_through advanced is unreliable — successive
		// calls can land in the same millisecond on fast machines.)
		expect(after2.summary).not.toBe(after1.summary);
	});
});
