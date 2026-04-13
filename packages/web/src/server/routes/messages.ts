import { getSiteId } from "@bound/core";

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { redactMessage, redactThread } from "@bound/agent";
import { insertRow } from "@bound/core";
import type { Message, TypedEventEmitter } from "@bound/shared";
import { Hono } from "hono";
import { z } from "zod";

const createMessageSchema = z.object({
	content: z.string(),
	file_ids: z.array(z.unknown()).optional(),
	model_id: z.string().optional(),
});

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

	app.post("/:threadId/messages", async (c) => {
		try {
			const { threadId } = c.req.param();
			console.log(`[web] POST /api/threads/${threadId}/messages - message received`);

			const parseResult = createMessageSchema.safeParse(await c.req.json());
			if (!parseResult.success) {
				return c.json(
					{
						error: "Invalid request body",
						details: parseResult.error.message,
					},
					400,
				);
			}
			const body = parseResult.data;

			const MAX_CONTENT_LENGTH = 512 * 1024; // 512KB

			if (!body.content.trim()) {
				return c.json(
					{
						error: "Invalid request body",
						details: "content must not be empty",
					},
					400,
				);
			}

			if (body.content.length > MAX_CONTENT_LENGTH) {
				return c.json(
					{
						error: "Content too large",
						details: `Maximum content length is ${MAX_CONTENT_LENGTH / 1024}KB`,
					},
					413,
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

			// Append any referenced file contents to the message so the agent can see them.
			let content: string = body.content;
			const MAX_FILE_IDS = 20;
			const fileIds: string[] = (Array.isArray(body.file_ids) ? body.file_ids : [])
				.filter((id: unknown): id is string => typeof id === "string")
				.slice(0, MAX_FILE_IDS);
			for (const fileId of fileIds) {
				const file = db.query("SELECT * FROM files WHERE id = ? AND deleted = 0").get(fileId) as {
					path: string;
					content: string | null;
					is_binary: number;
					size_bytes: number;
				} | null;
				if (!file) continue;
				const name = file.path.split("/").pop() ?? file.path;
				if (file.is_binary) {
					// Binary files: mention metadata only (don't dump base64 into the prompt)
					content += `\n\n[Attached file: ${name} (binary, ${file.size_bytes} bytes)]`;
				} else {
					content += `\n\n[Attached file: ${name}]\n${file.content ?? ""}`;
				}
			}

			const messageId = randomUUID();
			const now = new Date().toISOString();

			const siteId = getSiteId(db);

			insertRow(
				db,
				"messages",
				{
					id: messageId,
					thread_id: threadId,
					role: "user",
					content,
					model_id: body.model_id || null,
					tool_name: null,
					created_at: now,
					modified_at: now,
					host_origin: "localhost:3000",
				},
				siteId,
			);

			const message = db.query("SELECT * FROM messages WHERE id = ?").get(messageId) as Message;

			console.log(
				`[web] POST /api/threads/${threadId}/messages - message persisted (id=${messageId})`,
			);

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
