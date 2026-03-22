import type { Database } from "bun:sqlite";
import type { TypedEventEmitter } from "@bound/shared";
import { Hono } from "hono";
import { registerRoutes } from "./routes/index";

export function createApp(db: Database, eventBus: TypedEventEmitter): Hono {
	const app = new Hono();
	const routes = registerRoutes(db, eventBus);

	app.get("/", (c) => {
		return c.text("Bound Web Server");
	});

	app.route("/api/threads", routes.threads);
	app.route("/api/threads", routes.messages);
	app.route("/api/files", routes.files);
	app.route("/api/status", routes.status);
	app.route("/api/tasks", routes.tasks);

	return app;
}
