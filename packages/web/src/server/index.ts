import type { Database } from "bun:sqlite";
import type { TypedEventEmitter } from "@bound/shared";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { embeddedAssets } from "./embedded-assets";
import { registerRoutes } from "./routes/index";

export async function createApp(
	db: Database,
	eventBus: TypedEventEmitter,
): Promise<Hono> {
	const app = new Hono();
	const routes = registerRoutes(db, eventBus);

	// Host header validation middleware - only allow localhost/loopback
	app.use("*", (c, next) => {
		const host = c.req.header("host");
		if (host) {
			const hostName = host.split(":")[0];
			const allowedHosts = ["localhost", "127.0.0.1", "[::1]"];
			if (!allowedHosts.includes(hostName)) {
				return c.json({ error: "Invalid Host header" }, 400);
			}
		}
		return next();
	});

	// API routes
	app.route("/api/threads", routes.threads);
	app.route("/api/threads", routes.messages);
	app.route("/api/files", routes.files);
	app.route("/api/status", routes.status);
	app.route("/api/tasks", routes.tasks);

	// Serve static Svelte SPA assets
	if (embeddedAssets.size > 0) {
		// Explicit routes for each embedded asset
		for (const [path, asset] of embeddedAssets) {
			app.get(path, () => {
				return new Response(asset.content, {
					headers: { "content-type": asset.contentType },
				});
			});
		}
		// SPA fallback — serve index.html for unknown paths (client-side routing)
		app.get("/", () => {
			const index = embeddedAssets.get("/index.html");
			return new Response(index!.content, {
				headers: { "content-type": index!.contentType },
			});
		});
	} else {
		app.use(
			"/*",
			serveStatic({ root: "./dist/client", rewritePathRegex: /(?:\/)?index\.html/ }),
		);
	}

	return app;
}
