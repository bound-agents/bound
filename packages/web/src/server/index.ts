import type { Database } from "bun:sqlite";
import type { TypedEventEmitter } from "@bound/shared";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { type ModelsConfig, registerRoutes } from "./routes/index";

type AssetMap = Map<string, { content: string; contentType: string }>;

async function loadEmbeddedAssets(): Promise<AssetMap> {
	try {
		const mod = await import("./embedded-assets");
		return mod.embeddedAssets ?? new Map();
	} catch {
		return new Map();
	}
}

export { type ModelsConfig };

export async function createApp(
	db: Database,
	eventBus: TypedEventEmitter,
	modelsConfig?: ModelsConfig,
): Promise<Hono> {
	const app = new Hono();
	const routes = registerRoutes(db, eventBus, modelsConfig);

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
	const assets = await loadEmbeddedAssets();
	if (assets.size > 0) {
		for (const [path, asset] of assets) {
			app.get(path, () => {
				return new Response(asset.content, {
					headers: { "content-type": asset.contentType },
				});
			});
		}
		app.get("/", () => {
			const index = assets.get("/index.html")!;
			return new Response(index.content, {
				headers: { "content-type": index.contentType },
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
