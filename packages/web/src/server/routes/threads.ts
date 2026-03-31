import { getSiteId } from "@bound/core";

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow } from "@bound/core";
import type { StatusForwardPayload, Thread } from "@bound/shared";
import { Hono } from "hono";

export function createThreadsRoutes(
	db: Database,
	defaultModel?: string,
	statusForwardCache?: Map<string, StatusForwardPayload>,
	activeLoops?: Set<string>,
): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		try {
			const threads = db
				.query(
					`
				SELECT * FROM threads
				WHERE deleted = 0 AND user_id = ?
				ORDER BY last_message_at DESC
			`,
				)
				.all("default_web_user") as Thread[];

			return c.json(threads);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to list threads",
					details: message,
				},
				500,
			);
		}
	});

	app.post("/", (c) => {
		try {
			const threadId = randomUUID();
			const now = new Date().toISOString();

			console.log(`[web] POST /api/threads - creating thread ${threadId}`);

			const siteId = getSiteId(db);

			// Assign next palette color by cycling (0-9) per spec R-U18
			// Pick up from the last thread's color so colors always advance
			const lastThread = db
				.query("SELECT color FROM threads ORDER BY created_at DESC LIMIT 1")
				.get() as { color: number } | null;
			const nextColor = lastThread !== null ? (lastThread.color + 1) % 10 : 0;

			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "default_web_user",
					interface: "web",
					host_origin: "localhost:3000",
					color: nextColor,
					title: "",
					summary: null,
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			const thread = db.query("SELECT * FROM threads WHERE id = ?").get(threadId) as Thread;

			return c.json(thread, 201);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to create thread",
					details: message,
				},
				500,
			);
		}
	});

	app.get("/:id", (c) => {
		try {
			const { id } = c.req.param();
			const thread = db.query("SELECT * FROM threads WHERE id = ? AND deleted = 0").get(id) as
				| Thread
				| undefined;

			if (!thread) {
				return c.json(
					{
						error: "Thread not found",
					},
					404,
				);
			}

			return c.json(thread);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get thread",
					details: message,
				},
				500,
			);
		}
	});

	app.get("/:id/status", (c) => {
		try {
			const { id } = c.req.param();

			const thread = db.query("SELECT * FROM threads WHERE id = ? AND deleted = 0").get(id) as
				| Thread
				| undefined;

			if (!thread) {
				return c.json(
					{
						error: "Thread not found",
					},
					404,
				);
			}

			// Check for forwarded status (delegated loops)
			const forwarded = statusForwardCache?.get(id);

			const runningTask = db
				.query("SELECT id FROM tasks WHERE thread_id = ? AND status = 'running' LIMIT 1")
				.get(id) as { id: string } | null;

			const localLoopActive = activeLoops?.has(id) ?? false;
			const isActive =
				localLoopActive ||
				!!runningTask ||
				forwarded?.status === "thinking" ||
				forwarded?.status === "tool_call";

			return c.json({
				active: isActive,
				state: forwarded?.status ?? (localLoopActive || runningTask ? "thinking" : null),
				detail: forwarded?.detail ?? null,
				tokens: forwarded?.tokens ?? 0,
				model: defaultModel ?? null,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get thread status",
					details: message,
				},
				500,
			);
		}
	});

	app.get("/:id/context-debug", (c) => {
		try {
			const { id } = c.req.param();

			const rows = db
				.query(
					`SELECT id, model_id, tokens_in, tokens_out, context_debug, created_at
					 FROM turns
					 WHERE thread_id = ? AND context_debug IS NOT NULL
					 ORDER BY created_at ASC`,
				)
				.all(id) as Array<{
				id: number;
				model_id: string;
				tokens_in: number;
				tokens_out: number;
				context_debug: string;
				created_at: string;
			}>;

			const result = rows.map((row) => ({
				turn_id: row.id,
				model_id: row.model_id,
				tokens_in: row.tokens_in,
				tokens_out: row.tokens_out,
				context_debug: JSON.parse(row.context_debug),
				created_at: row.created_at,
			}));

			return c.json(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get context debug data",
					details: message,
				},
				500,
			);
		}
	});

	return app;
}
