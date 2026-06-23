import {
	findLiveMessageByIdAndThread,
	findLiveThreadById,
	getSiteId,
	listLiveMessagesByThreadNewestFirst,
	listMessagesByThread,
} from "@bound/core";

import type { Database } from "bun:sqlite";
import { redactMessage, redactThread } from "@bound/agent";
import type { Message, TypedEventEmitter } from "@bound/shared";
import { Hono } from "hono";

export function createMessagesRoutes(db: Database, _eventBus: TypedEventEmitter): Hono {
	const app = new Hono();

	app.get("/:threadId/messages", (c) => {
		try {
			const { threadId } = c.req.param();
			const limitParam = c.req.query("limit");

			const thread = findLiveThreadById(db, threadId);

			if (!thread) {
				return c.json(
					{
						error: "Thread not found",
					},
					404,
				);
			}

			let messages: Message[];
			if (limitParam) {
				const limit = Math.max(1, Math.min(Number.parseInt(limitParam, 10) || 1000, 10000));
				// Fetch the newest N messages, then return in chronological order
				messages = listLiveMessagesByThreadNewestFirst(db, threadId, limit);
			} else {
				messages = listMessagesByThread(db, threadId);
			}

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

			const thread = findLiveThreadById(db, threadId);

			if (!thread) {
				return c.json({ error: "Thread not found" }, 404);
			}

			const message = findLiveMessageByIdAndThread(db, messageId, threadId);

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

			const thread = findLiveThreadById(db, threadId);

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
