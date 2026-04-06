import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, createDatabase } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import type { Hono } from "hono";
import { createWebApp } from "../index";

describe("Redaction API Endpoints (R-E18)", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let app: Hono;

	beforeEach(async () => {
		db = createDatabase(":memory:");
		applySchema(db);
		eventBus = new TypedEventEmitter();
		app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });
	});

	async function createThread(): Promise<string> {
		const res = await app.fetch(
			new Request("http://localhost:3000/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			}),
		);
		const thread = await res.json();
		return thread.id;
	}

	async function createMessage(threadId: string, content: string): Promise<string> {
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

	describe("POST /:threadId/messages/:messageId/redact", () => {
		it("redacts a single message and returns 200", async () => {
			const threadId = await createThread();
			const messageId = await createMessage(threadId, "Secret content here");

			const res = await app.fetch(
				new Request(`http://localhost:3000/api/threads/${threadId}/messages/${messageId}/redact`, {
					method: "POST",
				}),
			);

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.redacted).toBe(true);
			expect(body.messageId).toBe(messageId);

			// Verify content is actually redacted in the database
			const msg = db.prepare("SELECT content FROM messages WHERE id = ?").get(messageId) as {
				content: string;
			};
			expect(msg.content).toBe("[redacted]");
		});

		it("returns 404 for non-existent thread", async () => {
			const res = await app.fetch(
				new Request(
					`http://localhost:3000/api/threads/${randomUUID()}/messages/${randomUUID()}/redact`,
					{ method: "POST" },
				),
			);

			expect(res.status).toBe(404);
		});

		it("returns 404 for non-existent message", async () => {
			const threadId = await createThread();

			const res = await app.fetch(
				new Request(
					`http://localhost:3000/api/threads/${threadId}/messages/${randomUUID()}/redact`,
					{ method: "POST" },
				),
			);

			expect(res.status).toBe(404);
		});
	});

	describe("POST /:threadId/redact", () => {
		it("redacts all messages in a thread", async () => {
			const threadId = await createThread();
			await createMessage(threadId, "Message one");
			await createMessage(threadId, "Message two");

			const res = await app.fetch(
				new Request(`http://localhost:3000/api/threads/${threadId}/redact`, {
					method: "POST",
				}),
			);

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.redacted).toBe(true);
			expect(body.threadId).toBe(threadId);
			expect(body.messagesRedacted).toBe(2);

			// Verify all messages are redacted
			const messages = db
				.prepare("SELECT content FROM messages WHERE thread_id = ?")
				.all(threadId) as Array<{ content: string }>;
			for (const msg of messages) {
				expect(msg.content).toBe("[redacted]");
			}
		});

		it("returns 404 for non-existent thread", async () => {
			const res = await app.fetch(
				new Request(`http://localhost:3000/api/threads/${randomUUID()}/redact`, {
					method: "POST",
				}),
			);

			expect(res.status).toBe(404);
		});

		it("reports affected memories when redacting a thread", async () => {
			const threadId = await createThread();
			await createMessage(threadId, "Message with memory");

			// Insert a semantic memory sourced from this thread
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
			).run(randomUUID(), "test_key", "test_value", threadId, now, now);

			const res = await app.fetch(
				new Request(`http://localhost:3000/api/threads/${threadId}/redact`, {
					method: "POST",
				}),
			);

			const body = await res.json();
			expect(body.memoriesAffected).toBe(1);
		});
	});
});
