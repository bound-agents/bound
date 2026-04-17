import { getSiteId } from "@bound/core";

import type { Database } from "bun:sqlite";
import { redactMessage, redactThread } from "@bound/agent";
import type { Message, TypedEventEmitter } from "@bound/shared";
import { Hono } from "hono";

export function createMessagesRoutes(db: Database, _eventBus: TypedEventEmitter): Hono {
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
				WHERE thread_id = ? AND deleted = 0
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

	app.post("/:threadId/messages", (c) => {
		return c.json(
			{
				error: "POST endpoint removed. Use WebSocket message:send instead.",
			},
			404,
		);
	});

	app.post("/:threadId/messages/:messageId/redact", (c) => {
		try {
			const { threadId, messageId } = c.req.param();

			const thread = db.query("SELECT * FROM threads WHERE id = ? AND deleted = 0").get(threadId);

			if (!thread) {
				return c.json({ error: "Thread not found" }, 404);
			}

			const message = db
				.query("SELECT * FROM messages WHERE id = ? AND thread_id = ? AND deleted = 0")
				.get(messageId, threadId);

			if (!message) {
				return c.json({ error: "Message not found" }, 404);
			}

			const siteId = getSiteId(db);
			const result = redactMessage(db, messageId, siteId);

			if (!result.ok) {
				return c.json({ error: "Failed to redact message", details: result.error.message }, 500);
			}

			return c.json({ redacted: true, messageId });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to redact message", details: message }, 500);
		}
	});

	app.post("/:threadId/redact", (c) => {
		try {
			const { threadId } = c.req.param();

			const thread = db.query("SELECT * FROM threads WHERE id = ? AND deleted = 0").get(threadId);

			if (!thread) {
				return c.json({ error: "Thread not found" }, 404);
			}

			const siteId = getSiteId(db);
			const result = redactThread(db, threadId, siteId);

			if (!result.ok) {
				return c.json({ error: "Failed to redact thread", details: result.error.message }, 500);
			}

			return c.json({
				redacted: true,
				threadId,
				messagesRedacted: result.value.messagesRedacted,
				memoriesAffected: result.value.memoriesAffected,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to redact thread", details: message }, 500);
		}
	});

	return app;
}
