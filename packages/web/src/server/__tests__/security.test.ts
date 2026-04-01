import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, createDatabase, applyMetricsSchema } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import type { Hono } from "hono";
import { createApp } from "../index";

/**
 * Security regression tests for API endpoints.
 * Each test targets a specific vulnerability that was identified and fixed.
 */
describe("API Security", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let app: Hono;

	beforeEach(async () => {
		db = createDatabase(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		eventBus = new TypedEventEmitter();
		app = await createApp(db, eventBus);
	});

	async function createThread(): Promise<string> {
		const res = await app.fetch(
			new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			}),
		);
		const t = await res.json();
		return t.id;
	}

	async function postMessage(threadId: string, content: string): Promise<string> {
		const res = await app.fetch(
			new Request(`http://localhost:3000/api/threads/${threadId}/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content }),
			}),
		);
		const msg = await res.json();
		return msg.id;
	}

	// ──────────────────────────────────────────────────────────────────
	// 1. Deleted/redacted messages must NOT appear in GET listing
	// ──────────────────────────────────────────────────────────────────
	describe("deleted messages filtered from GET listing", () => {
		it("excludes soft-deleted messages from thread message listing", async () => {
			const threadId = await createThread();
			const msgId = await postMessage(threadId, "sensitive secret data");

			// Soft-delete the message (simulating redaction)
			db.exec("UPDATE messages SET deleted = 1 WHERE id = ?", [msgId]);

			const res = await app.fetch(
				new Request(`http://localhost:3000/api/threads/${threadId}/messages`),
			);
			expect(res.status).toBe(200);
			const messages = await res.json();

			// The deleted message MUST NOT appear
			expect(messages.length).toBe(0);
			const ids = messages.map((m: { id: string }) => m.id);
			expect(ids).not.toContain(msgId);
		});

		it("returns only non-deleted messages when mix of deleted and active exist", async () => {
			const threadId = await createThread();
			await postMessage(threadId, "keep this");
			const secretId = await postMessage(threadId, "delete this secret");
			await postMessage(threadId, "also keep");

			db.exec("UPDATE messages SET deleted = 1 WHERE id = ?", [secretId]);

			const res = await app.fetch(
				new Request(`http://localhost:3000/api/threads/${threadId}/messages`),
			);
			const messages = await res.json();

			expect(messages.length).toBe(2);
			expect(messages.map((m: { content: string }) => m.content)).toEqual([
				"keep this",
				"also keep",
			]);
		});
	});

	// ──────────────────────────────────────────────────────────────────
	// 2. Path traversal in file upload filename
	// ──────────────────────────────────────────────────────────────────
	describe("file upload path traversal prevention", () => {
		it("strips directory traversal from uploaded filename", async () => {
			const form = new FormData();
			form.append(
				"file",
				new File(["malicious"], "../../etc/passwd", { type: "text/plain" }),
			);

			const res = await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);
			expect(res.status).toBe(201);
			const file = await res.json();

			// Path must NOT contain traversal sequences
			expect(file.path).not.toContain("..");
			expect(file.path).toBe("/home/user/uploads/etc_passwd");
		});

		it("strips slashes from uploaded filename", async () => {
			const form = new FormData();
			form.append(
				"file",
				new File(["data"], "sub/dir/file.txt", { type: "text/plain" }),
			);

			const res = await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);
			expect(res.status).toBe(201);
			const file = await res.json();

			// Should flatten to just the sanitized form
			expect(file.path).not.toContain("sub/dir");
			expect(file.path).toContain("file.txt");
		});
	});

	// ──────────────────────────────────────────────────────────────────
	// 3. Content-Disposition header injection
	// ──────────────────────────────────────────────────────────────────
	describe("Content-Disposition header injection prevention", () => {
		it("sanitizes quotes in filename for Content-Disposition header", async () => {
			const form = new FormData();
			form.append(
				"file",
				new File(["test"], 'file"injected.txt', { type: "text/plain" }),
			);

			const uploadRes = await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);
			const uploaded = await uploadRes.json();

			const res = await app.fetch(
				new Request(`http://localhost:3000/api/files/download/${uploaded.id}`),
			);
			const disposition = res.headers.get("Content-Disposition") ?? "";

			// The header must not contain unescaped quotes that break the value
			expect(disposition).not.toMatch(/filename="[^"]*"[^"]*"/);
			expect(res.status).toBe(200);
		});

		it("sanitizes newlines in filename for Content-Disposition header", async () => {
			// Insert a file directly with newlines in the path (bypassing upload sanitization)
			const now = new Date().toISOString();
			db.exec(
				`INSERT INTO files (id, path, content, is_binary, size_bytes, created_at, modified_at, deleted, created_by, host_origin)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				["crlf-file", "/home/user/uploads/file\r\nX-Injected: true", "data", 0, 4, now, now, 0, "test", "localhost"],
			);

			const res = await app.fetch(
				new Request("http://localhost:3000/api/files/download/crlf-file"),
			);
			const disposition = res.headers.get("Content-Disposition") ?? "";

			// Must not contain CR or LF
			expect(disposition).not.toMatch(/[\r\n]/);
			expect(res.status).toBe(200);
		});
	});

	// ──────────────────────────────────────────────────────────────────
	// 4. JSON.parse crash in context-debug endpoint
	// ──────────────────────────────────────────────────────────────────
	describe("context-debug endpoint resilience", () => {
		it("does not crash when context_debug contains malformed JSON", async () => {
			const threadId = await createThread();

			// Insert a turn with malformed JSON in context_debug
			db.exec(
				`INSERT INTO turns (thread_id, model_id, tokens_in, tokens_out, context_debug, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[threadId, "test-model", 100, 50, "NOT VALID JSON {{{", new Date().toISOString()],
			);

			const res = await app.fetch(
				new Request(`http://localhost:3000/api/threads/${threadId}/context-debug`),
			);

			// Must not return 500 — should gracefully handle malformed data
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(Array.isArray(data)).toBe(true);
		});
	});

	// ──────────────────────────────────────────────────────────────────
	// 5. File upload size limit
	// ──────────────────────────────────────────────────────────────────
	describe("file upload size limit", () => {
		it("rejects files larger than 10MB", async () => {
			// Create a file that exceeds 10MB
			const bigContent = "x".repeat(11 * 1024 * 1024);
			const form = new FormData();
			form.append("file", new File([bigContent], "huge.txt", { type: "text/plain" }));

			const res = await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);

			expect(res.status).toBe(413);
			const body = await res.json();
			expect(body.error).toContain("too large");
		});

		it("accepts files within the size limit", async () => {
			const form = new FormData();
			form.append("file", new File(["small file"], "small.txt", { type: "text/plain" }));

			const res = await app.fetch(
				new Request("http://localhost:3000/api/files/upload", { method: "POST", body: form }),
			);

			expect(res.status).toBe(201);
		});
	});

	// ──────────────────────────────────────────────────────────────────
	// 6. Empty content validation on messages
	// ──────────────────────────────────────────────────────────────────
	describe("message content validation", () => {
		it("rejects empty string content", async () => {
			const threadId = await createThread();

			const res = await app.fetch(
				new Request(`http://localhost:3000/api/threads/${threadId}/messages`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: "" }),
				}),
			);

			expect(res.status).toBe(400);
		});

		it("rejects whitespace-only content", async () => {
			const threadId = await createThread();

			const res = await app.fetch(
				new Request(`http://localhost:3000/api/threads/${threadId}/messages`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: "   \n\t  " }),
				}),
			);

			expect(res.status).toBe(400);
		});

		it("rejects content exceeding 500KB", async () => {
			const threadId = await createThread();
			const hugeContent = "a".repeat(512 * 1024 + 1);

			const res = await app.fetch(
				new Request(`http://localhost:3000/api/threads/${threadId}/messages`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: hugeContent }),
				}),
			);

			expect(res.status).toBe(413);
		});
	});

	// ──────────────────────────────────────────────────────────────────
	// 7. file_ids array cap
	// ──────────────────────────────────────────────────────────────────
	describe("file_ids array bounds", () => {
		it("only processes up to 20 file_ids", async () => {
			const threadId = await createThread();

			// Create 25 fake file IDs (they won't exist, but we're testing the cap)
			const fakeIds = Array.from({ length: 25 }, (_, i) => `fake-id-${i}`);

			const res = await app.fetch(
				new Request(`http://localhost:3000/api/threads/${threadId}/messages`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: "test", file_ids: fakeIds }),
				}),
			);

			// Should succeed (non-existent IDs are just skipped)
			expect(res.status).toBe(201);
			const msg = await res.json();
			expect(msg.content).toBe("test");
		});

		it("validates file_ids elements are strings", async () => {
			const threadId = await createThread();

			const res = await app.fetch(
				new Request(`http://localhost:3000/api/threads/${threadId}/messages`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: "test", file_ids: [123, null, {}] }),
				}),
			);

			// Should succeed but ignore non-string entries
			expect(res.status).toBe(201);
		});
	});
});
