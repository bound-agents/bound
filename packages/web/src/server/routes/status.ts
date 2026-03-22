import type { Database } from "bun:sqlite";
import type { TypedEventEmitter } from "@bound/shared";
import { Hono } from "hono";

export function createStatusRoutes(db: Database, eventBus: TypedEventEmitter): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		try {
			const uptime = process.uptime();
			const activeLoops = db
				.query("SELECT COUNT(*) as count FROM tasks WHERE status = 'running'")
				.get() as { count: number };

			const status = {
				host_info: {
					uptime_seconds: Math.floor(uptime),
					active_loops: activeLoops.count,
				},
			};

			return c.json(status);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get status",
					details: message,
				},
				500,
			);
		}
	});

	app.post("/cancel/:threadId", (c) => {
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

			// Emit cancel event on eventBus to signal agent loop to stop
			eventBus.emit("agent:cancel", { thread_id: threadId });

			return c.json({
				cancelled: true,
				thread_id: threadId,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to cancel agent loop",
					details: message,
				},
				500,
			);
		}
	});

	return app;
}
