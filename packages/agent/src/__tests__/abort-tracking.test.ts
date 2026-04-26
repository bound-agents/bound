import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { AgentLoop } from "../agent-loop";

function createMockRouter(backend: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("claude-opus", backend);
	return new ModelRouter(backends, "claude-opus");
}

function createMockSandbox() {
	return {
		exec: async (_cmd: string) => ({
			stdout: "mock output",
			stderr: "",
			exitCode: 0,
		}),
	};
}

describe("Abort state tracking", () => {
	let tmpDir: string;
	let db: Database;
	let threadId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "abort-test-"));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);

		const userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
	});

	beforeEach(() => {
		threadId = randomUUID();
	});

	afterAll(async () => {
		db.close();
		if (tmpDir) await cleanupTmpDir(tmpDir);
	});

	function makeCtx(): AppContext {
		return {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus: { on: () => {}, off: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: "test-site-id",
		} as unknown as AppContext;
	}

	it("should not record a 0/0 ghost turn when aborted mid-stream", async () => {
		const abortController = new AbortController();

		// Backend that yields one chunk then stalls, giving time to abort
		const stallBackend: LLMBackend = {
			async *chat(): AsyncGenerator<StreamChunk> {
				// Trigger abort immediately — the for-await loop will see this.aborted on next iteration
				abortController.abort();
				// Yield a text chunk that will be collected before the abort check
				yield { type: "text" as const, content: "partial..." };
				// This would be the done chunk, but abort fires first
				await new Promise((resolve) => setTimeout(resolve, 100));
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_write_tokens: null,
						cache_read_tokens: null,
						estimated: false,
					},
				};
			},
			capabilities() {
				return {
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 8000,
				};
			},
		};

		const loop = new AgentLoop(makeCtx(), createMockSandbox(), createMockRouter(stallBackend), {
			threadId,
			userId: "test-user",
			abortSignal: abortController.signal,
		});

		await loop.run();

		// Before bound_issue:turns-table:observability-gap: aborted streams
		// with zero usage wrote NO turn row at all. Now we record the turn
		// with status='aborted' so cost/usage analysis can attribute the
		// attempt to the right model/task, while still filtering it out of
		// success-path metrics. The contract is: no aborted row pollutes
		// status='ok' rollups.
		const okTurns = db
			.query(
				"SELECT tokens_in, tokens_out, status FROM turns WHERE thread_id = ? AND status = 'ok'",
			)
			.all(threadId) as Array<{ tokens_in: number; tokens_out: number; status: string }>;

		const ghostOkTurns = okTurns.filter((t) => t.tokens_in === 0 && t.tokens_out === 0);
		expect(ghostOkTurns.length).toBe(0);

		// But the aborted attempt IS recorded, explicitly marked.
		const abortedTurns = db
			.query("SELECT status FROM turns WHERE thread_id = ? AND status = 'aborted'")
			.all(threadId) as Array<{ status: string }>;
		expect(abortedTurns.length).toBeGreaterThan(0);
	});

	it("should persist an abort notice as a system message", async () => {
		const abortController = new AbortController();

		// Backend that stalls long enough for abort to fire before any chunks
		const stallBackend: LLMBackend = {
			async *chat(): AsyncGenerator<StreamChunk> {
				abortController.abort();
				await new Promise((resolve) => setTimeout(resolve, 50));
				yield { type: "text" as const, content: "never seen" };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_write_tokens: null,
						cache_read_tokens: null,
						estimated: false,
					},
				};
			},
			capabilities() {
				return {
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 8000,
				};
			},
		};

		const loop = new AgentLoop(makeCtx(), createMockSandbox(), createMockRouter(stallBackend), {
			threadId,
			userId: "test-user",
			abortSignal: abortController.signal,
		});

		await loop.run();

		// Should have a developer message about the abort
		const msgs = db
			.query(
				"SELECT role, content FROM messages WHERE thread_id = ? AND role = 'developer' ORDER BY created_at DESC",
			)
			.all(threadId) as Array<{ role: string; content: string }>;

		const cancelMsgs = msgs.filter((m) => m.content.includes("cancelled"));
		expect(cancelMsgs.length).toBeGreaterThan(0);
		expect(cancelMsgs[0].content).toContain("Turn cancelled");
	});

	// bound_issue:turns-table:observability-gap sub-gap 2c:
	// pre-stream provider errors (e.g. Bedrock rejecting a request before
	// any chunk arrives — nova-pro's max_tokens cap before d4bfde8) used to
	// produce NO turn row at all, leaving failed inferences invisible to
	// cost/usage tracking. Now the agent loop records an error turn with
	// status='error' so the attempt shows up attributed to the right model.
	it("records a status='error' turn when the LLM throws before any chunks", async () => {
		const errorBackend: LLMBackend = {
			async *chat(): AsyncGenerator<StreamChunk> {
				throw new Error("provider boom");
				// biome-ignore lint/correctness/noUnreachable: required for generator shape
				yield { type: "text", content: "" };
			},
			capabilities() {
				return {
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 8000,
				};
			},
		};

		const loop = new AgentLoop(makeCtx(), createMockSandbox(), createMockRouter(errorBackend), {
			threadId,
			userId: "test-user",
		});

		const result = await loop.run();
		expect(result.error).toBeTruthy();

		const errorTurns = db
			.query(
				"SELECT model_id, status, tokens_in, tokens_out FROM turns WHERE thread_id = ? AND status = 'error'",
			)
			.all(threadId) as Array<{
			model_id: string;
			status: string;
			tokens_in: number;
			tokens_out: number;
		}>;
		expect(errorTurns.length).toBe(1);
		expect(errorTurns[0].tokens_in).toBe(0);
		expect(errorTurns[0].tokens_out).toBe(0);
		expect(errorTurns[0].model_id).toBe("claude-opus");
	});
});
