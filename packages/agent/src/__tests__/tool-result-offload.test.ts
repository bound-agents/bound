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
import { MainAgentLoop } from "../agent-loop";
import { offloadToolResultPath } from "../tool-result-offload";

// --- Unit test for the agent-local offload path helper ---
// (TOOL_RESULT_OFFLOAD_THRESHOLD and buildOffloadMessage are shared with the
// host surface and tested at their source in @bound/shared's offload.test.ts;
// offloadToolResultPath is the only piece owned by this surface.)

describe("offloadToolResultPath", () => {
	it("should generate a path under /home/user/.tool-results/", () => {
		const path = offloadToolResultPath("tool-abc-123");
		expect(path).toBe("/home/user/.tool-results/tool-abc-123.txt");
	});

	it("should use the tool call ID in the filename", () => {
		const id = "tooluse_6UcYmU0dFxuh3MBuVdR3WX";
		const path = offloadToolResultPath(id);
		expect(path).toContain(id);
		expect(path).toEndWith(".txt");
	});
});

// --- Integration tests with MainAgentLoop ---

class MockLLMBackend implements LLMBackend {
	private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
	private callCount = 0;

	pushResponse(gen: () => AsyncGenerator<StreamChunk>) {
		this.responses.push(gen);
	}

	setToolThenTextResponse(
		toolId: string,
		toolName: string,
		toolInput: Record<string, unknown>,
		finalText: string,
	) {
		this.responses = [];
		this.pushResponse(async function* () {
			yield { type: "tool_use_start" as const, id: toolId, name: toolName };
			yield {
				type: "tool_use_args" as const,
				id: toolId,
				partial_json: JSON.stringify(toolInput),
			};
			yield { type: "tool_use_end" as const, id: toolId };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 15,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});
		this.pushResponse(async function* () {
			yield { type: "text" as const, content: finalText };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 20,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});
	}

	getCallCount() {
		return this.callCount;
	}

	async *chat() {
		const gen = this.responses[this.callCount];
		this.callCount++;
		if (gen) {
			yield* gen();
		} else {
			yield { type: "text" as const, content: "" };
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
		}
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

function createMockRouter(backend: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("claude-opus", backend);
	return new ModelRouter(backends, "claude-opus");
}

describe("MainAgentLoop tool result offloading", () => {
	let tmpDir: string;
	let db: Database;
	let threadId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "offload-test-"));
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

	it("should offload tool results over 50k chars to a file", async () => {
		const largeOutput = "x".repeat(60_000);
		const writeFileCalls: Array<{ path: string; content: string }> = [];

		const mockBackend = new MockLLMBackend();
		mockBackend.setToolThenTextResponse(
			"tool-big-1",
			"bash",
			{ command: "cat huge-file.txt" },
			"Done reading the file.",
		);

		const sandbox = {
			exec: async (_cmd: string) => ({
				stdout: largeOutput,
				stderr: "",
				exitCode: 0,
			}),
			writeFile: async (path: string, content: string) => {
				writeFileCalls.push({ path, content });
			},
		};

		const loop = new MainAgentLoop(makeCtx(), sandbox, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		await loop.run();

		// writeFile should have been called with the full content
		expect(writeFileCalls.length).toBe(1);
		expect(writeFileCalls[0].content).toBe(largeOutput);
		expect(writeFileCalls[0].path).toContain("tool-big-1");
		expect(writeFileCalls[0].path).toStartWith("/home/user/.tool-results/");

		// The DB should store the shortened message, not the full content
		const results = db
			.query(
				"SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result' ORDER BY created_at",
			)
			.all(threadId) as Array<{ content: string }>;

		expect(results.length).toBe(1);
		expect(results[0].content.length).toBeLessThan(1000);
		expect(results[0].content).toContain("offloaded");
		expect(results[0].content).toContain("60000");
	});

	it("should NOT offload tool results under 50k chars", async () => {
		const smallOutput = "x".repeat(49_999);
		const writeFileCalls: Array<{ path: string; content: string }> = [];

		const mockBackend = new MockLLMBackend();
		mockBackend.setToolThenTextResponse("tool-small-1", "bash", { command: "echo hi" }, "Done.");

		const sandbox = {
			exec: async (_cmd: string) => ({
				stdout: smallOutput,
				stderr: "",
				exitCode: 0,
			}),
			writeFile: async (path: string, content: string) => {
				writeFileCalls.push({ path, content });
			},
		};

		const loop = new MainAgentLoop(makeCtx(), sandbox, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		await loop.run();

		// writeFile should NOT have been called
		expect(writeFileCalls.length).toBe(0);

		// The DB should store the original content
		const results = db
			.query(
				"SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result' ORDER BY created_at",
			)
			.all(threadId) as Array<{ content: string }>;

		expect(results.length).toBe(1);
		expect(results[0].content).toContain(smallOutput);
		expect(results[0].content).toMatch(/\[duration: \d+\.\d{3}s\]$/);
	});

	it("should gracefully skip offloading when writeFile is not available", async () => {
		const largeOutput = "x".repeat(60_000);

		const mockBackend = new MockLLMBackend();
		mockBackend.setToolThenTextResponse(
			"tool-nofs-1",
			"bash",
			{ command: "cat huge-file.txt" },
			"Done.",
		);

		// No writeFile on sandbox
		const sandbox = {
			exec: async (_cmd: string) => ({
				stdout: largeOutput,
				stderr: "",
				exitCode: 0,
			}),
		};

		const loop = new MainAgentLoop(makeCtx(), sandbox, createMockRouter(mockBackend), {
			threadId,
			userId: "test-user",
		});

		await loop.run();

		// The DB should store the original content (no offloading possible)
		const results = db
			.query(
				"SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result' ORDER BY created_at",
			)
			.all(threadId) as Array<{ content: string }>;

		expect(results.length).toBe(1);
		expect(results[0].content).toContain(largeOutput);
		expect(results[0].content).toMatch(/\[duration: \d+\.\d{3}s\]$/);
	});
});
