import { getSiteId } from "@bound/core";

import type { Database } from "bun:sqlite";
import { updateRow } from "@bound/core";
import type { Task } from "@bound/shared";
import { Hono } from "hono";
import { extractDisplayName, extractSchedule } from "../lib/task-display";

interface TaskWithComputed extends Task {
	displayName: string;
	schedule: string | null;
	hostName: string | null;
	lastDurationMs: number | null;
}

export function createTasksRoutes(db: Database): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		try {
			const status = c.req.query("status");

			let query = "SELECT * FROM tasks WHERE deleted = 0";
			const params: string[] = [];

			if (status) {
				query += " AND status = ?";
				params.push(status);
			}

			query += " ORDER BY created_at DESC";

			const tasks = db.query(query).all(...params) as Task[];

			const hosts = db
				.query("SELECT site_id, host_name FROM hosts WHERE deleted = 0")
				.all() as Array<{
				site_id: string;
				host_name: string;
			}>;
			const hostMap = new Map(hosts.map((h) => [h.site_id, h.host_name]));

			const enrichedTasks: TaskWithComputed[] = tasks.map((task) => {
				const displayName = extractDisplayName(task);
				const schedule = extractSchedule(task);
				const hostName = task.claimed_by ? (hostMap.get(task.claimed_by) ?? null) : null;

				let lastDurationMs: number | null = null;
				if (task.claimed_at && task.thread_id) {
					const lastTurnRow = db
						.query(
							"SELECT MAX(created_at) as last_turn_at FROM turns WHERE thread_id = ? AND task_id = ?",
						)
						.get(task.thread_id, task.id) as { last_turn_at: string | null } | null;

					if (lastTurnRow?.last_turn_at) {
						const claimedTime = Date.parse(task.claimed_at);
						const lastTurnTime = Date.parse(lastTurnRow.last_turn_at);
						lastDurationMs = Math.max(0, lastTurnTime - claimedTime);
					}
				}

				return {
					...task,
					displayName,
					schedule,
					hostName,
					lastDurationMs,
				};
			});

			return c.json(enrichedTasks);
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

	app.get("/:id", (c) => {
		try {
			const { id } = c.req.param();
			const task = db.query("SELECT * FROM tasks WHERE id = ? AND deleted = 0").get(id) as Record<
				string,
				unknown
			> | null;

			if (!task) {
				return c.json({ error: "Task not found" }, 404);
			}

			return c.json(task);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to get task", details: message }, 500);
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
