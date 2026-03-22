import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Thread } from "@bound/shared";
import { Hono } from "hono";

export function createThreadsRoutes(db: Database): Hono {
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

			db.run(
				`
				INSERT INTO threads (
					id, user_id, interface, host_origin, color, title,
					summary, created_at, last_message_at, deleted
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
				[
					threadId,
					"default_web_user",
					"web",
					"localhost:3000",
					Math.floor(Math.random() * 10),
					"New Thread",
					null,
					now,
					now,
					0,
				],
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

			const status = {
				active: false,
				state: null,
				model: "gpt-4",
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
