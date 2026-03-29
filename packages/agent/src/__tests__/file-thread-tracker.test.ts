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
import { getLastThreadForFile, trackFilePath } from "../file-thread-tracker";

function createMockRouter(backend: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("claude-opus", backend);
	return new ModelRouter(backends, "claude-opus");
}

describe("File-Thread Tracker (R-E20)", () => {
	let tmpDir: string;
	let db: Database;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "file-thread-test-"));
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

	describe("trackFilePath unit", () => {
		it("stores a file-thread association in semantic_memory", () => {
			const filePath = "/workspace/test.txt";
			const threadId = randomUUID();
			trackFilePath(db, filePath, threadId);

			const lastThread = getLastThreadForFile(db, filePath);
			expect(lastThread).toBe(threadId);
		});

		it("updates existing association when tracked again", () => {
			const filePath = "/workspace/updated.txt";
			const thread1 = randomUUID();
			const thread2 = randomUUID();

			trackFilePath(db, filePath, thread1);
			expect(getLastThreadForFile(db, filePath)).toBe(thread1);

			trackFilePath(db, filePath, thread2);
			expect(getLastThreadForFile(db, filePath)).toBe(thread2);
		});
	});

	describe("agent loop integration", () => {
		it("calls trackFilePath during FS_PERSIST when files change", async () => {
			const threadId = randomUUID();

			class MockLLMBackend implements LLMBackend {
				async *chat() {
					yield { type: "text" as const, content: "Done." };
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

			const changedPaths = ["/workspace/foo.txt", "/workspace/bar.txt"];

			const mockSandbox = {
				exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				persistFs: async () => ({
					changes: 2,
					changedPaths,
				}),
			};

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
			expect(result.filesChanged).toBe(2);

			// Verify both files are tracked to this thread
			for (const fp of changedPaths) {
				const tracked = getLastThreadForFile(db, fp);
				expect(tracked).toBe(threadId);
			}
		});

		it("does not track files when changedPaths is not provided", async () => {
			const threadId = randomUUID();
			const uniqueFile = `/workspace/no-track-${randomUUID()}.txt`;

			class MockLLMBackend implements LLMBackend {
				async *chat() {
					yield { type: "text" as const, content: "Done." };
					yield { type: "done" as const, usage: { input_tokens: 5, output_tokens: 3 } };
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

			const mockSandbox = {
				exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				persistFs: async () => ({ changes: 1 }),
			};

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

			await agentLoop.run();

			// uniqueFile should not be tracked
			const tracked = getLastThreadForFile(db, uniqueFile);
			expect(tracked).toBeNull();
		});
	});
});
