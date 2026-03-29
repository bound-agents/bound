import type { Database } from "bun:sqlite";
import { formatError } from "@bound/shared";
import type { KeyringConfig, Logger, StatusForwardPayload, TypedEventEmitter } from "@bound/shared";
import type { EagerPushConfig, RelayExecutor } from "@bound/sync";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { type ModelsConfig, type RoutesConfig, registerRoutes } from "./routes/index";
import { createWebhookRoutes } from "./routes/webhooks";

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
	hostName?: string;
	siteId?: string;
	keyring?: KeyringConfig;
	logger?: Logger;
	relayExecutor?: RelayExecutor;
	hubSiteId?: string;
	eagerPushConfig?: EagerPushConfig;
	statusForwardCache?: Map<string, StatusForwardPayload>;
	activeDelegations?: Map<string, { targetSiteId: string; processOutboxId: string }>;
}

export async function createApp(
	db: Database,
	eventBus: TypedEventEmitter,
	appConfig?: AppConfig | ModelsConfig,
): Promise<Hono> {
	const modelsConfig =
		appConfig && "modelsConfig" in appConfig
			? (appConfig as AppConfig).modelsConfig
			: (appConfig as ModelsConfig | undefined);
	const typedAppConfig =
		appConfig && "hostName" in appConfig ? (appConfig as AppConfig) : undefined;
	const routesConfig: RoutesConfig = {
		modelsConfig,
		hostName: typedAppConfig?.hostName,
		siteId: typedAppConfig?.siteId,
		statusForwardCache: typedAppConfig?.statusForwardCache,
		activeDelegations: typedAppConfig?.activeDelegations,
	};

	const app = new Hono();
	const routes = registerRoutes(db, eventBus, routesConfig);

	// Host header validation middleware — DNS-rebinding protection for unauthenticated routes.
	// /sync/* and /api/relay-deliver are exempt: they carry Ed25519 signature auth and must be
	// reachable by remote spokes connecting to a hub through a reverse proxy.
	app.use("*", async (c, next) => {
		const host = c.req.header("host");
		if (host) {
			const hostName = host.split(":")[0];
			const allowedHosts = ["localhost", "127.0.0.1", "[::1]"];
			if (!allowedHosts.includes(hostName)) {
				const path = new URL(c.req.url).pathname;
				if (!path.startsWith("/sync/") && path !== "/api/relay-deliver") {
					return c.json({ error: "Invalid Host header" }, 400);
				}
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
	app.route("/api/mcp", routes.mcp);

	// Webhook routes
	app.route("/hooks", createWebhookRoutes(eventBus));

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
			const index = assets.get("/index.html") ?? assets.values().next().value;
			if (!index) return new Response("Not found", { status: 404 });
			return new Response(index.content, {
				headers: { "content-type": index.contentType },
			});
		});
	} else {
		app.use("/*", serveStatic({ root: "./dist/client" }));
	}

	return app;
}
