/**
 * Integration test: built-in file tools through a real AgentLoop with InMemoryFs.
 *
 * Scripts the LLM to call write → read → edit in sequence and verifies
 * tool results, file content, and that bash exec is NOT invoked for these tools.
 */
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
import { InMemoryFs } from "just-bash";
import { AgentLoop } from "../agent-loop";
import { createBuiltInTools } from "../built-in-tools";

// ─── Mock LLM ───────────────────────────────────────────────────────

class ScriptedLLMBackend implements LLMBackend {
	private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
	private callIdx = 0;

	push(gen: () => AsyncGenerator<StreamChunk>) {
		this.responses.push(gen);
	}

	pushToolCall(toolId: string, toolName: string, toolInput: Record<string, unknown>) {
		this.push(async function* () {
			yield { type: "tool_use_start" as const, id: toolId, name: toolName };
			yield { type: "tool_use_args" as const, id: toolId, partial_json: JSON.stringify(toolInput) };
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
	}

	pushText(text: string) {
		this.push(async function* () {
			yield { type: "text" as const, content: text };
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
		});
	}

	async *chat() {
		const gen = this.responses[this.callIdx];
		this.callIdx++;
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

// ─── Test suite ─────────────────────────────────────────────────────

describe("built-in tools integration", () => {
	let tmpDir: string;
	let db: Database;
	let threadId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "built-in-integ-"));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
		applyMetricsSchema(db);

		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[randomUUID(), "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
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

	it("write → read → edit flow through AgentLoop", async () => {
		const fs = new InMemoryFs();
		const builtInTools = createBuiltInTools(fs);

		const bashCalls: string[] = [];
		const sandbox = {
			exec: async (cmd: string) => {
				bashCalls.push(cmd);
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			builtInTools,
		};

		const backend = new ScriptedLLMBackend();

		// Step 1: LLM calls write
		backend.pushToolCall("t1", "write", {
			path: "/home/user/test.py",
			content: 'print("hello world")\n',
		});
		// Step 2: LLM calls read
		backend.pushToolCall("t2", "read", { path: "/home/user/test.py" });
		// Step 3: LLM calls edit
		backend.pushToolCall("t3", "edit", {
			path: "/home/user/test.py",
			edits: [{ old_text: "hello world", new_text: "goodbye world" }],
		});
		// Step 4: LLM finishes
		backend.pushText("All done.");

		const router = new ModelRouter(new Map([["test", backend]]), "test");
		const toolDefs = Array.from(builtInTools.values(), (t) => t.toolDefinition);

		const loop = new AgentLoop(makeCtx(), sandbox, router, {
			threadId,
			userId: "test-user",
			tools: toolDefs,
		});

		const result = await loop.run();

		// Should have made 3 tool calls
		expect(result.toolCallsMade).toBe(3);
		expect(result.error).toBeUndefined();

		// bash exec should NEVER have been called
		expect(bashCalls.length).toBe(0);

		// Verify file content after the edit
		const finalContent = await fs.readFile("/home/user/test.py");
		expect(finalContent).toBe('print("goodbye world")\n');

		// Verify tool_result messages in DB
		const toolResults = db
			.prepare(
				"SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result' ORDER BY created_at ASC",
			)
			.all(threadId) as Array<{ content: string }>;

		expect(toolResults.length).toBe(3);
		// write result
		expect(toolResults[0].content).toContain("Wrote");
		expect(toolResults[0].content).toContain("21 bytes");
		// read result
		expect(toolResults[1].content).toContain('print("hello world")');
		// edit result (unified diff)
		expect(toolResults[2].content).toContain('-print("hello world")');
		expect(toolResults[2].content).toContain('+print("goodbye world")');
	});

	it("built-in tool error does not crash the loop", async () => {
		const fs = new InMemoryFs();
		const builtInTools = createBuiltInTools(fs);

		const sandbox = { builtInTools };

		const backend = new ScriptedLLMBackend();
		// Try to read a file that doesn't exist
		backend.pushToolCall("t1", "read", { path: "/nope.txt" });
		backend.pushText("The file was not found.");

		const router = new ModelRouter(new Map([["test", backend]]), "test");
		const toolDefs = Array.from(builtInTools.values(), (t) => t.toolDefinition);

		const loop = new AgentLoop(makeCtx(), sandbox, router, {
			threadId,
			userId: "test-user",
			tools: toolDefs,
		});

		const result = await loop.run();
		expect(result.toolCallsMade).toBe(1);
		expect(result.error).toBeUndefined();

		// Verify error was captured as tool result
		const toolResult = db
			.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result' LIMIT 1")
			.get(threadId) as { content: string } | null;
		expect(toolResult).not.toBeNull();
		expect(toolResult?.content).toContain("Error: file not found");
	});
});
