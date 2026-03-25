import type { Database } from "bun:sqlite";
import type { MCPClient } from "@bound/agent";
import { formatError } from "@bound/shared";
import type { KeyringConfig, Logger, TypedEventEmitter } from "@bound/shared";
import type { EagerPushConfig, RelayExecutor } from "@bound/sync";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { type ModelsConfig, type RoutesConfig, registerRoutes } from "./routes/index";

type AssetMap = Map<string, { content: string; contentType: string }>;

async function loadEmbeddedAssets(): Promise<AssetMap> {
	try {
		const mod = await import("./embedded-assets");
		return mod.embeddedAssets ?? new Map();
	} catch {
		return new Map();
	}
}

export type { ModelsConfig };

export interface AppConfig {
	modelsConfig?: ModelsConfig;
	mcpClients?: Map<string, MCPClient>;
	keyring?: KeyringConfig;
	siteId?: string;
	logger?: Logger;
	relayExecutor?: RelayExecutor;
	hubSiteId?: string;
	eagerPushConfig?: EagerPushConfig;
}

export async function createApp(
	db: Database,
	eventBus: TypedEventEmitter,
	appConfig?: AppConfig | ModelsConfig,
): Promise<Hono> {
	// Accept either the new AppConfig shape or the legacy ModelsConfig shape for backwards compat
	let routesConfig: RoutesConfig;
	if (appConfig && "mcpClients" in appConfig) {
		routesConfig = {
			modelsConfig: appConfig.modelsConfig,
			mcpClients: appConfig.mcpClients,
			keyring: appConfig.keyring,
		};
	} else {
		routesConfig = { modelsConfig: appConfig as ModelsConfig | undefined };
	}

	const app = new Hono();
	const routes = registerRoutes(db, eventBus, routesConfig);

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
	app.route("/api/advisories", routes.advisories);
	if (routes.mcpProxy) {
		// Mount at root — the route itself registers /api/mcp-proxy including auth middleware
		app.route("/", routes.mcpProxy);
	}

	// Mount sync routes if siteId, keyring, and logger are available
	if (
		appConfig &&
		"siteId" in appConfig &&
		appConfig.siteId &&
		appConfig.keyring &&
		appConfig.logger
	) {
		try {
			const { createSyncRoutes } = await import("@bound/sync");
			const syncRoutes = createSyncRoutes(
				db,
				appConfig.siteId,
				appConfig.keyring,
				eventBus,
				appConfig.logger,
				appConfig.relayExecutor,
				appConfig.hubSiteId,
				appConfig.eagerPushConfig,
			);
			app.route("/", syncRoutes);
		} catch (error) {
			console.warn("[web] Sync routes unavailable:", formatError(error));
		}
	}

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
		app.use("/*", serveStatic({ root: "./dist/client", rewritePathRegex: /(?:\/)?index\.html/ }));
	}

	return app;
}
