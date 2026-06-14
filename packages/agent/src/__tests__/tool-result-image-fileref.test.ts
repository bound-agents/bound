/**
 * High-level guarantee: when a tool returns an inline base64 image block, the
 * agent loop converts it to a `file_ref` BEFORE persistence, so the heavy
 * base64 never reaches the universal tool-result cap (which would corrupt a
 * ~256KB+ image by middle-cutting it). The bytes land in the `files` table;
 * `messages.content` stays light. Stage 5b substitution re-inflates the
 * file_ref to image data at inference time (tested in substitute.test.ts).
 *
 * Mirrors the prompt-image path documented in README (image attachments are
 * persisted as file_ref, resolved at inference) — now extended to tool output.
 *
 * The renderer / model-side delivery is covered by substitute.test.ts; the
 * persisted conversation-state shape is guaranteed here.
 */
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { ContentBlock, LLMBackend } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { AgentLoop } from "../agent-loop";
import type { RegisteredTool } from "../types";

// A 1x1 PNG, then padded so the base64 is unmistakably "large" relative to a
// file_ref pointer. The exact bytes don't matter — only that the persisted
// tool_result is light and the files row holds this string verbatim.
const PNG_BASE64 = `${"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="}${"A".repeat(2048)}`;

const IMAGE_TOOL = "fake_image_read";

function imageToolRegistry(): Map<string, RegisteredTool> {
	return new Map([
		[
			IMAGE_TOOL,
			{
				kind: "builtin",
				toolDefinition: {
					type: "function",
					function: {
						name: IMAGE_TOOL,
						description: "Returns an inline base64 image block",
						parameters: { type: "object", properties: {} },
					},
				},
				execute: async (): Promise<ContentBlock[]> => [
					{ type: "text", text: "Image file: /home/user/x.png" },
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: PNG_BASE64 },
					},
				],
			} as unknown as RegisteredTool,
		],
	]);
}

// Scripted LLM: one tool call to IMAGE_TOOL, then final text.
class ScriptedLLMBackend implements LLMBackend {
	private idx = 0;
	private readonly toolId = "img-call-1";

	async *chat() {
		const turn = this.idx++;
		if (turn === 0) {
			yield { type: "tool_use_start" as const, id: this.toolId, name: IMAGE_TOOL };
			yield { type: "tool_use_args" as const, id: this.toolId, partial_json: "{}" };
			yield { type: "tool_use_end" as const, id: this.toolId };
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
			return;
		}
		yield { type: "text" as const, content: "done" };
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
	}

	capabilities() {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: true,
			max_context: 8000,
		};
	}
}

function makeCtx(db: Database): AppContext {
	return {
		db,
		logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		eventBus: { on: () => {}, off: () => {}, emit: () => {} },
		hostName: "test-host",
		siteId: "test-site-id",
	} as unknown as AppContext;
}

function createMockRouter(backend: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("claude-opus", backend);
	return new ModelRouter(backends, "claude-opus");
}

describe("tool-result image blocks persisted as file_ref", () => {
	let tmpDir: string;
	let db: Database;
	let threadId: string;
	const sandbox = {
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	};

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "tool-img-fileref-"));
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

	it("rewrites an inline base64 image to a file_ref and stores the bytes in files", async () => {
		const backend = new ScriptedLLMBackend();
		const loop = new AgentLoop(makeCtx(db), sandbox, createMockRouter(backend), {
			threadId,
			userId: "test-user",
			toolRegistry: imageToolRegistry(),
		});
		await loop.run();

		const row = db
			.query(
				"SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result' ORDER BY created_at ASC LIMIT 1",
			)
			.get(threadId) as { content: string } | null;
		expect(row).not.toBeNull();

		// Persisted content must NOT carry the heavy base64 inline.
		expect((row as { content: string }).content).not.toContain(PNG_BASE64);

		const blocks = JSON.parse((row as { content: string }).content) as ContentBlock[];
		const image = blocks.find((b) => b.type === "image") as
			| { type: "image"; source: { type: string; file_id?: string; media_type?: string } }
			| undefined;
		expect(image).toBeDefined();
		expect(image?.source.type).toBe("file_ref");
		expect(image?.source.media_type).toBe("image/png");
		const fileId = image?.source.file_id;
		expect(typeof fileId).toBe("string");

		// The bytes live in the files table, base64, undamaged.
		const fileRow = db
			.query("SELECT content, is_binary FROM files WHERE id = ? AND deleted = 0")
			.get(fileId as string) as { content: string; is_binary: number } | null;
		expect(fileRow).not.toBeNull();
		expect((fileRow as { is_binary: number }).is_binary).toBe(1);
		expect((fileRow as { content: string }).content).toBe(PNG_BASE64);
	});
});
