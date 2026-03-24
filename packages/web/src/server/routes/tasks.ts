import { getSiteId } from "@bound/core";

import type { Database } from "bun:sqlite";
import { updateRow } from "@bound/core";
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

	app.post("/:id/cancel", (c) => {
		try {
			const { id } = c.req.param();
			const task = db
				.query("SELECT * FROM tasks WHERE id = ? AND deleted = 0")
				.get(id) as Task | null;

			if (!task) {
				return c.json({ error: "Task not found" }, 404);
			}

			if (task.status !== "pending" && task.status !== "running" && task.status !== "claimed") {
				return c.json(
					{
						error: `Cannot cancel task in '${task.status}' status`,
					},
					400,
				);
			}

	const siteId = getSiteId(db);

			updateRow(db, "tasks", id, { status: "cancelled" }, siteId);

			const updated = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Task;
			return c.json(updated);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to cancel task",
					details: message,
				},
				500,
			);
		}
	});

	return app;
}
