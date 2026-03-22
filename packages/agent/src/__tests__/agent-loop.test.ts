import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { LLMBackend } from "@bound/llm";
import { AgentLoop } from "../agent-loop";

// Mock LLM Backend that returns a text response
class MockLLMBackend implements LLMBackend {
	private responseType: "text" | "tool_use" = "text";
	private toolUseId = "tool-123";
	private toolName = "memorize";

	setResponseType(type: "text" | "tool_use") {
		this.responseType = type;
	}

	async *chat() {
		if (this.responseType === "text") {
			yield { type: "text" as const, content: "Hello, I understand." };
			yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 5 } };
		} else if (this.responseType === "tool_use") {
			yield { type: "tool_use_start" as const, id: this.toolUseId, name: this.toolName };
			yield {
				type: "tool_use_args" as const,
				id: this.toolUseId,
				partial_json: '{"key":"test","value":"hello"}',
			};
			yield { type: "tool_use_end" as const, id: this.toolUseId };
			yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 15 } };
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

describe("AgentLoop", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "agent-test-"));
		dbPath = join(tmpDir, "test.db");

		// Create database and apply schema
		db = createDatabase(dbPath);
		applySchema(db);

		// Create a test user and thread
		const userId = randomUUID();

		db.run(
			"INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
	});

	afterAll(() => {
		db.close();
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("should return a valid result from running the agent loop", async () => {
		const mockBackend = new MockLLMBackend();
		mockBackend.setResponseType("text");

		// Create a minimal mock for Bash-like interface
		const mockBash = {};

		const mockCtx = {
			db,
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			hostName: "test-host",
		} as unknown as AppContext;

		const agentLoop = new AgentLoop(mockCtx, mockBash, mockBackend, {
			threadId: "test-thread",
			userId: "test-user",
		});

		const result = await agentLoop.run();

		expect(result).toHaveProperty("messagesCreated");
		expect(result).toHaveProperty("toolCallsMade");
		expect(result).toHaveProperty("filesChanged");
		expect(typeof result.messagesCreated).toBe("number");
		expect(typeof result.toolCallsMade).toBe("number");
		expect(typeof result.filesChanged).toBe("number");
	});
});
