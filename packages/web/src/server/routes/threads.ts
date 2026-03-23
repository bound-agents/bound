import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow } from "@bound/core";
import type { Thread } from "@bound/shared";
import { Hono } from "hono";

export function createThreadsRoutes(db: Database, defaultModel?: string): Hono {
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
				.all(["default_web_user"]) as Thread[];

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

			const siteIdRow = db.query("SELECT value FROM host_meta WHERE key = 'site_id'").get() as
				| { value: string }
				| undefined;
			const siteId = siteIdRow?.value ?? "unknown";

			insertRow(db, "threads", {
				id: threadId,
				user_id: "default_web_user",
				interface: "web",
				host_origin: "localhost:3000",
				color: Math.floor(Math.random() * 10),
				title: "",
				summary: null,
				created_at: now,
				last_message_at: now,
				deleted: 0,
			}, siteId);

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

			const runningTask = db
				.query("SELECT * FROM tasks WHERE thread_id = ? AND status = 'running' LIMIT 1")
				.get(id) as Record<string, unknown> | undefined;

			const status = runningTask
				? {
						active: true,
						state: "running",
						model: defaultModel ?? null,
					}
				: {
						active: false,
						state: null,
						model: defaultModel ?? null,
					};

			return c.json(status);
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

	return app;
}
