import {
	findLiveMessageByIdAndThread,
	findLiveThreadById,
	getSiteId,
	listLiveMessagesByThreadNewestFirst,
	listMessagesByThread,
	listTurnsByThread,
} from "@bound/core";

import type { Database } from "bun:sqlite";
import { redactMessage, redactThread } from "@bound/agent";
import type { Message } from "@bound/shared";
import { Hono } from "hono";

export function createMessagesRoutes(db: Database): Hono {
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

	// GET /:threadId/provenance — per-turn routing provenance for the message
	// footers (2026-11-21-model-routing.md §9.1). Each turn names the served model
	// and route; a multi-attempt turn carries its per-attempt breakdown (parsed out
	// of the turn's cost_breakdown JSON) so the expanded footer can list every
	// attempt, including discarded refusals and failed route trials.
	app.get("/:threadId/provenance", (c) => {
		try {
			const { threadId } = c.req.param();
			const thread = findLiveThreadById(db, threadId);
			if (!thread) {
				return c.json({ error: "Thread not found" }, 404);
			}
			const turns = listTurnsByThread(db, threadId).map((t) => {
				let attempts: unknown = null;
				if (t.cost_breakdown) {
					try {
						const parsed = JSON.parse(t.cost_breakdown) as { attempts?: unknown };
						if (Array.isArray(parsed.attempts)) attempts = parsed.attempts;
					} catch {
						// Malformed cost_breakdown — omit attempts, keep the turn row.
					}
				}
				return {
					id: t.id,
					created_at: t.created_at,
					model_id: t.model_id,
					route_id: t.route_id,
					substituted_from: t.substituted_from,
					status: t.status,
					cost_usd: t.cost_usd,
					attempts,
				};
			});
			return c.json({ turns });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to read provenance", details: message }, 500);
		}
	});

	return app;
}
