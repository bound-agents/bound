/**
 * Regression test for cancel propagation into synchronous aux invocations.
 *
 * Incident (2026-08-18, thread 5411b76f): a foreground `aux` invoke ran for
 * ~20 minutes; the operator fired `agent:cancel` three times. The parent
 * loop's AbortController aborted, but createAuxLoopRunner never handed the
 * parent's abortSignal to the AuxAgentLoop config, so the child kept issuing
 * LLM calls for another ten minutes while the parent sat blocked in
 * `await auxLoop.run()`.
 *
 * The contract pinned here: an aux loop dispatched under an aborted (or
 * later-aborted) parent signal must stop without making further LLM calls.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AppContext } from "@bound/core";
import { applyMetricsSchema, applySchema } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { TypedEventEmitter } from "@bound/shared";
import { createAgentLoopFactory } from "../commands/start/agent-factory";

class CountingBackend implements LLMBackend {
	callCount = 0;

	async *chat(): AsyncGenerator<StreamChunk> {
		this.callCount++;
		yield { type: "text" as const, content: "should never stream" };
		yield {
			type: "done" as const,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
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

function makeDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
	return db;
}

function makeAppContext(db: Database): AppContext {
	return {
		db,
		logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		eventBus: new TypedEventEmitter(),
		hostName: "test-host",
		siteId: "test-site-id",
		optionalConfig: {},
	} as unknown as AppContext;
}

function seedThread(db: Database): { threadId: string; userId: string; agentId: string } {
	const now = new Date().toISOString();
	const userId = randomUUID();
	const threadId = randomUUID();
	const agentId = randomUUID();
	db.run(
		"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
		[userId, "Test User", null, now, now, 0],
	);
	db.run(
		"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[threadId, userId, "aux", "test-site-id", now, now, now, 0, agentId],
	);
	db.run(
		"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
		[randomUUID(), threadId, "user", "do the errand", now, "test-site-id", 0],
	);
	return { threadId, userId, agentId };
}

describe("aux loop abort propagation", () => {
	it("makes no LLM calls when the parent signal is already aborted", async () => {
		const db = makeDb();
		const appContext = makeAppContext(db);
		const backend = new CountingBackend();
		const backends = new Map<string, LLMBackend>([["mock-model", backend]]);
		const router = new ModelRouter(backends, "mock-model");

		const factory = createAgentLoopFactory(appContext, router, undefined, null);

		const controller = new AbortController();
		controller.abort();

		const runner = factory.createAuxLoopRunner({ abortSignal: controller.signal });
		const { threadId, userId, agentId } = seedThread(db);

		const result = await runner({
			threadId,
			agentId,
			persona: "a test aux persona",
			modelHint: null,
			allowlistedTools: null,
			instructions: "do the errand",
			userId,
			parentThreadId: randomUUID(),
		});

		expect(backend.callCount).toBe(0);
		expect(result).toBeDefined();
		db.close();
	});
});
