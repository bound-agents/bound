import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { BackendCapabilities, ContentBlock } from "@bound/llm";
import { assembleContext } from "../context-assembly";

/**
 * Tests for content block substitution in context assembly.
 * Verifies that image and document blocks are properly replaced when
 * the target backend lacks the required capabilities.
 */

function insertThread(db: Database, threadId: string, userId: string) {
	db.run(
		"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[
			threadId,
			userId,
			"web",
			"local",
			0,
			"Test Thread",
			null,
			null,
			null,
			null,
			new Date().toISOString(),
			new Date().toISOString(),
			new Date().toISOString(),
			0,
		],
	);
}

function insertMessage(
	db: Database,
	threadId: string,
	role: string,
	content: string,
	opts?: {
		id?: string;
		model_id?: string;
		tool_name?: string;
		offset?: number;
		timestamp?: string;
	},
) {
	const id = opts?.id ?? randomUUID();
	const ts = opts?.timestamp ?? new Date(new Date().getTime() + (opts?.offset ?? 0)).toISOString();
	db.run(
		"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[id, threadId, role, content, opts?.model_id ?? null, opts?.tool_name ?? null, ts, ts, "local"],
	);
	return id;
}

function insertFile(db: Database, fileId: string, content: string) {
	db.run(
		"INSERT INTO files (id, path, size_bytes, is_binary, content, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		[
			fileId,
			`/file/${fileId}`,
			content.length,
			0,
			content,
			new Date().toISOString(),
			new Date().toISOString(),
			0,
		],
	);
}

describe("context assembly content substitution", () => {
	let tmpDir: string;
	let db: Database;
	let userId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "substitution-test-"));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);

		userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
	});

	afterAll(() => {
		db.close();
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("replaces image blocks in assembled context when targetCapabilities.vision is false (AC1.5)", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		// Insert a user message with image content
		const imageBlock = JSON.stringify([
			{
				type: "image",
				source: { type: "base64", media_type: "image/jpeg", data: "base64data" },
				description: "A test image",
			},
		]);
		insertMessage(db, threadId, "user", imageBlock, { offset: 0 });

		const nonVisionCaps: BackendCapabilities = {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: false,
			max_context: 8000,
		};

		const { messages } = assembleContext({
			db,
			threadId,
			userId,
			targetCapabilities: nonVisionCaps,
		});

		// Find the user message in the assembled context (skip system messages)
		const userMessages = messages.filter((m) => m.role === "user");
		expect(userMessages.length).toBeGreaterThan(0);

		const userMsg = userMessages[0];
		// Content should be substituted: either array or JSON string
		if (typeof userMsg.content === "string") {
			// Should not contain the original image block
			expect(userMsg.content).not.toContain('"type":"image"');
			// Should contain the text annotation
			expect(userMsg.content).toContain("[Image:");
		} else if (Array.isArray(userMsg.content)) {
			// Should not contain any image blocks
			const hasImage = userMsg.content.some((b: ContentBlock) => b.type === "image");
			expect(hasImage).toBe(false);
			// Should contain a text block with annotation
			const hasAnnotation = userMsg.content.some(
				(b: ContentBlock) => b.type === "text" && "text" in b && b.text.includes("[Image:"),
			);
			expect(hasAnnotation).toBe(true);
		}
	});

	it("does not modify database row after substitution (AC1.5)", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		const imageBlock = JSON.stringify([
			{
				type: "image",
				source: { type: "base64", media_type: "image/jpeg", data: "base64data" },
				description: "A test image",
			},
		]);
		const msgId = insertMessage(db, threadId, "user", imageBlock, { offset: 0 });

		const nonVisionCaps: BackendCapabilities = {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: false,
			max_context: 8000,
		};

		// Call assembleContext with targetCapabilities
		assembleContext({
			db,
			threadId,
			userId,
			targetCapabilities: nonVisionCaps,
		});

		// Re-query the messages table
		const row = db.query("SELECT content FROM messages WHERE id = ?").get(msgId) as {
			content: string;
		} | null;

		expect(row).not.toBeNull();
		// The DB row should still have the original image block
		expect(row?.content).toContain('"type":"image"');
	});

	it("does not replace image blocks when targetCapabilities.vision is true", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		const imageBlock = JSON.stringify([
			{
				type: "image",
				source: { type: "base64", media_type: "image/jpeg", data: "base64data" },
				description: "A test image",
			},
		]);
		insertMessage(db, threadId, "user", imageBlock, { offset: 0 });

		const visionCaps: BackendCapabilities = {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: true,
			max_context: 8000,
		};

		const { messages } = assembleContext({
			db,
			threadId,
			userId,
			targetCapabilities: visionCaps,
		});

		const userMessages = messages.filter((m) => m.role === "user");
		expect(userMessages.length).toBeGreaterThan(0);

		const userMsg = userMessages[0];
		if (Array.isArray(userMsg.content)) {
			// Should contain the image block unchanged
			const hasImage = userMsg.content.some((b: ContentBlock) => b.type === "image");
			expect(hasImage).toBe(true);
		} else if (typeof userMsg.content === "string") {
			// JSON parsed should have image block
			const parsed = JSON.parse(userMsg.content);
			if (Array.isArray(parsed)) {
				const hasImage = parsed.some((b: ContentBlock) => b.type === "image");
				expect(hasImage).toBe(true);
			}
		}
	});

	it("document blocks are always converted to text_representation", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		const documentBlock = JSON.stringify([
			{
				type: "document",
				text_representation: "This is the document content",
			},
		]);
		insertMessage(db, threadId, "user", documentBlock, { offset: 0 });

		const caps: BackendCapabilities = {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: true,
			max_context: 8000,
		};

		const { messages } = assembleContext({
			db,
			threadId,
			userId,
			targetCapabilities: caps,
		});

		const userMessages = messages.filter((m) => m.role === "user");
		expect(userMessages.length).toBeGreaterThan(0);

		const userMsg = userMessages[0];
		if (Array.isArray(userMsg.content)) {
			// Should not contain document block
			const hasDoc = userMsg.content.some((b: ContentBlock) => b.type === "document");
			expect(hasDoc).toBe(false);
			// Should contain text block with document content
			const hasText = userMsg.content.some(
				(b: ContentBlock) =>
					b.type === "text" && "text" in b && b.text.includes("This is the document content"),
			);
			expect(hasText).toBe(true);
		}
	});

	it("file_ref image source is resolved from files table when vision is supported", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		const fileId = randomUUID();
		const fileContent = "base64encodedimagedata";
		insertFile(db, fileId, fileContent);

		const imageBlock = JSON.stringify([
			{
				type: "image",
				source: { type: "file_ref", file_id: fileId },
				description: "Image from file",
			},
		]);
		insertMessage(db, threadId, "user", imageBlock, { offset: 0 });

		const visionCaps: BackendCapabilities = {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: true,
			max_context: 8000,
		};

		const { messages } = assembleContext({
			db,
			threadId,
			userId,
			targetCapabilities: visionCaps,
		});

		const userMessages = messages.filter((m) => m.role === "user");
		expect(userMessages.length).toBeGreaterThan(0);

		const userMsg = userMessages[0];
		if (Array.isArray(userMsg.content)) {
			// Should have an image block with resolved base64 content
			const imageBlocks = userMsg.content.filter((b: ContentBlock) => b.type === "image");
			expect(imageBlocks.length).toBeGreaterThan(0);
			const resolvedImage = imageBlocks[0] as {
				source: { type: string; media_type: string; data: string };
			};
			expect(resolvedImage.source).toEqual({
				type: "base64",
				media_type: "image/jpeg",
				data: fileContent,
			});
		}
	});

	it("file_ref with missing file falls back to text placeholder", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		const missingFileId = randomUUID();
		const imageBlock = JSON.stringify([
			{
				type: "image",
				source: { type: "file_ref", file_id: missingFileId },
				description: "Missing image",
			},
		]);
		insertMessage(db, threadId, "user", imageBlock, { offset: 0 });

		const visionCaps: BackendCapabilities = {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: true,
			max_context: 8000,
		};

		const { messages } = assembleContext({
			db,
			threadId,
			userId,
			targetCapabilities: visionCaps,
		});

		const userMessages = messages.filter((m) => m.role === "user");
		expect(userMessages.length).toBeGreaterThan(0);

		const userMsg = userMessages[0];
		if (Array.isArray(userMsg.content)) {
			// Should have a text block placeholder
			const textBlocks = userMsg.content.filter((b: ContentBlock) => b.type === "text");
			expect(textBlocks.length).toBeGreaterThan(0);
			const placeholder = textBlocks[0] as { text: string };
			expect(placeholder.text).toContain("[Image file unavailable:");
		}
	});

	it("assembleContext without targetCapabilities passes content unchanged (backward-compat)", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		const imageBlock = JSON.stringify([
			{
				type: "image",
				source: { type: "base64", media_type: "image/jpeg", data: "base64data" },
				description: "A test image",
			},
		]);
		insertMessage(db, threadId, "user", imageBlock, { offset: 0 });

		// Call without targetCapabilities
		const { messages } = assembleContext({
			db,
			threadId,
			userId,
		});

		const userMessages = messages.filter((m) => m.role === "user");
		expect(userMessages.length).toBeGreaterThan(0);

		const userMsg = userMessages[0];
		// Content should pass through unchanged (no substitution)
		if (Array.isArray(userMsg.content)) {
			const hasImage = userMsg.content.some((b: ContentBlock) => b.type === "image");
			expect(hasImage).toBe(true);
		} else if (typeof userMsg.content === "string") {
			// Should still be able to parse as JSON with image block
			const parsed = JSON.parse(userMsg.content);
			if (Array.isArray(parsed)) {
				const hasImage = parsed.some((b: ContentBlock) => b.type === "image");
				expect(hasImage).toBe(true);
			}
		}
	});
});
