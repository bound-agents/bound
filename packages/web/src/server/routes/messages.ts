import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow } from "@bound/core";
import type { Message, TypedEventEmitter } from "@bound/shared";
import { Hono } from "hono";

export function createMessagesRoutes(db: Database, eventBus: TypedEventEmitter): Hono {
	const app = new Hono();

	app.get("/:threadId/messages", (c) => {
		try {
			const { threadId } = c.req.param();

			const thread = db.query("SELECT * FROM threads WHERE id = ? AND deleted = 0").get(threadId);

			if (!thread) {
				return c.json(
					{
						error: "Thread not found",
					},
					404,
				);
			}

			const messages = db
				.query(
					`
				SELECT * FROM messages
				WHERE thread_id = ?
				ORDER BY created_at ASC
			`,
				)
				.all(threadId) as Message[];

			return c.json(messages);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to list messages",
					details: message,
				},
				500,
			);
		}
	});

	app.post("/:threadId/messages", async (c) => {
		try {
			const { threadId } = c.req.param();
			console.log(`[web] POST /api/threads/${threadId}/messages - message received`);
			const body = await c.req.json();

			if (typeof body.content !== "string") {
				return c.json(
					{
						error: "Invalid request body",
						details: "content must be a string",
					},
					400,
				);
			}

			const thread = db.query("SELECT * FROM threads WHERE id = ? AND deleted = 0").get(threadId);

			if (!thread) {
				return c.json(
					{
						error: "Thread not found",
					},
					404,
				);
			}

			const messageId = randomUUID();
			const now = new Date().toISOString();

			const siteIdRow = db.query("SELECT value FROM host_meta WHERE key = 'site_id'").get() as
				| { value: string }
				| undefined;
			const siteId = siteIdRow?.value ?? "unknown";

			insertRow(db, "messages", {
				id: messageId,
				thread_id: threadId,
				role: "user",
				content: body.content,
				model_id: body.model_id || null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: "localhost:3000",
			}, siteId);

			const message = db.query("SELECT * FROM messages WHERE id = ?").get(messageId) as Message;

			console.log(`[web] POST /api/threads/${threadId}/messages - message persisted (id=${messageId})`);

			eventBus.emit("message:created", {
				message,
				thread_id: threadId,
			});

			console.log(`[web] POST /api/threads/${threadId}/messages - event emitted`);

			return c.json(message, 201);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to create message",
					details: message,
				},
				500,
			);
		}
	});

	return app;
}
