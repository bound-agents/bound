import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import { AnthropicDriver, type LLMBackend, ModelRouter } from "@bound/llm";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { MainAgentLoop } from "../agent-loop";

// A real driver (AnthropicDriver over a mocked fetch) on a thread whose
// persisted tool_result holds an item the bridge maps to a schema-invalid
// prompt item: a base64 image block that lost its media_type. Without the
// prompt-schema guard in toModelMessages, ai's validatePrompt rejects the
// prompt before any fetch, on every turn, and the thread is wedged.

function anthropicSse(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "claude-test",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 10, output_tokens: 1 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]
		.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
		.join("");
	return new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("MainAgentLoop — persisted prompt item outside the ModelMessage schema", () => {
	let tmpDir: string;
	let db: Database;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "agent-prompt-guard-"));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	it("completes a turn through a real driver instead of wedging", async () => {
		const threadId = randomUUID();
		const insert = (role: string, content: string, offsetMs: number) => {
			const at = new Date(Date.now() - 10_000 + offsetMs).toISOString();
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					threadId,
					role,
					content,
					null,
					role === "tool_result" ? "read" : null,
					at,
					at,
					"local",
					0,
				],
			);
		};
		insert("user", "look at this", 0);
		insert(
			"tool_call",
			JSON.stringify([{ type: "tool_use", id: "call_1", name: "read", input: { path: "a.png" } }]),
			1000,
		);
		// Drifted persisted shape: base64 source without media_type.
		insert(
			"tool_result",
			JSON.stringify([
				{ type: "text", text: "image follows" },
				{ type: "image", source: { type: "base64", data: "aGk=" } },
			]),
			2000,
		);
		insert("user", "and?", 3000);

		const bodies: string[] = [];
		const driver = new AnthropicDriver({
			apiKey: "test-key",
			model: "claude-test",
			contextWindow: 200_000,
			fetch: async (_input, init) => {
				bodies.push(String(init?.body ?? ""));
				return anthropicSse();
			},
		});
		const router = new ModelRouter(
			new Map<string, LLMBackend>([["claude-test", driver]]),
			"claude-test",
		);
		const ctx = {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus: { on: () => {}, off: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: "test-site-id",
		} as unknown as AppContext;
		const sandbox = { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) };

		const loop = new MainAgentLoop(ctx, sandbox, router, {
			threadId,
			userId: "test-user",
			modelId: "claude-test",
		});
		const result = await loop.run();

		expect(result.error).toBeUndefined();
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toContain("image follows");
		expect(bodies[0]).toContain("Unsupported file content omitted");
		const reply = db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant'")
			.all(threadId) as Array<{ content: string }>;
		expect(reply.map((r) => r.content).join("")).toContain("recovered");
		const alerts = db
			.query("SELECT id FROM messages WHERE thread_id = ? AND role = 'alert'")
			.all(threadId);
		expect(alerts).toHaveLength(0);
	});
});
