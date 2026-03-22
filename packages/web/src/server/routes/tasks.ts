import type { Database } from "bun:sqlite";
import type { Task } from "@bound/shared";
import { Hono } from "hono";

export function createTasksRoutes(db: Database): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		try {
			const status = c.req.query("status");

			let query = "SELECT * FROM tasks WHERE deleted = 0";
			const params: unknown[] = [];

			if (status) {
				query += " AND status = ?";
				params.push(status);
			}

			query += " ORDER BY created_at DESC";

			const tasks = db.query(query).all(...params) as Task[];

			return c.json(tasks);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to list tasks",
					details: message,
				},
				500,
			);
		}
	});

	return app;
}
