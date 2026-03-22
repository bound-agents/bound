import type { Database } from "bun:sqlite";
import type { TypedEventEmitter } from "@bound/shared";
import { serveStatic } from "hono/bun";
import { Hono } from "hono";
import { registerRoutes } from "./routes/index";

export function createApp(db: Database, eventBus: TypedEventEmitter): Hono {
	const app = new Hono();
	const routes = registerRoutes(db, eventBus);

	app.route("/api/threads", routes.threads);
	app.route("/api/threads", routes.messages);
	app.route("/api/files", routes.files);
	app.route("/api/status", routes.status);
	app.route("/api/tasks", routes.tasks);

	// Serve static Svelte SPA assets from dist/client/
	// This must be after API routes so they take precedence
	app.use("/*", serveStatic({ root: "./dist/client", rewritePathRegex: /(?:\/)?index\.html/ }));

	return app;
}
