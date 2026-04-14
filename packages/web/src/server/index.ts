import type { Database } from "bun:sqlite";
import { formatError } from "@bound/shared";
import type { KeyringConfig, Logger, StatusForwardPayload, TypedEventEmitter } from "@bound/shared";
import type { EagerPushConfig, KeyManager, RelayExecutor } from "@bound/sync";
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

export interface WebAppConfig {
	modelsConfig?: ModelsConfig;
	hostName?: string;
	siteId?: string;
	operatorUserId: string;
	statusForwardCache?: Map<string, StatusForwardPayload>;
	activeDelegations?: Map<string, { targetSiteId: string; processOutboxId: string }>;
	activeLoops?: Set<string>;
}

export interface SyncAppConfig {
	siteId: string;
	keyring: KeyringConfig;
	logger: Logger;
	relayExecutor?: RelayExecutor;
	hubSiteId?: string;
	eagerPushConfig?: EagerPushConfig;
	keyManager?: KeyManager;
}

/**
 * Create the web/API Hono app: API routes, webhook routes, static assets, DNS-rebinding protection.
 * Does NOT include sync routes — those live on a separate listener via createSyncApp().
 */
export async function createWebApp(
	db: Database,
	eventBus: TypedEventEmitter,
	config: WebAppConfig,
): Promise<Hono> {
	if (!config.operatorUserId) {
		throw new Error(
			"operatorUserId is required in WebAppConfig. " +
				"Resolve it from allowlist: deterministicUUID(BOUND_NAMESPACE, allowlist.default_web_user)",
		);
	}

	const routesConfig: RoutesConfig = {
		modelsConfig: config.modelsConfig,
		hostName: config.hostName,
		siteId: config.siteId,
		operatorUserId: config.operatorUserId,
		statusForwardCache: config.statusForwardCache,
		activeDelegations: config.activeDelegations,
		activeLoops: config.activeLoops,
	};

	const app = new Hono();
	const routes = registerRoutes(db, eventBus, routesConfig);

	// Host header validation middleware — DNS-rebinding protection for unauthenticated routes.
	app.use("*", async (c, next) => {
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
	app.route("/api/memory", routes.memory);
	app.route("/api/status", routes.status);
	app.route("/api/tasks", routes.tasks);
	app.route("/api/advisories", routes.advisories);
	app.route("/api/mcp", routes.mcp);

	// Webhook routes
	app.route("/hooks", createWebhookRoutes(eventBus));

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

/**
 * Create the sync Hono app: sync routes + relay-deliver with Ed25519 auth.
 * Served on the primary port, externally accessible for hub-spoke replication.
 */
export async function createSyncApp(
	db: Database,
	eventBus: TypedEventEmitter,
	config: SyncAppConfig,
): Promise<Hono | null> {
	try {
		const { createSyncRoutes } = await import("@bound/sync");
		const syncRoutes = createSyncRoutes(
			db,
			config.siteId,
			config.keyring,
			eventBus,
			config.logger,
			config.relayExecutor,
			config.hubSiteId,
			config.eagerPushConfig,
			undefined,
			config.keyManager,
		);
		const app = new Hono();
		app.route("/", syncRoutes);
		return app;
	} catch (error) {
		console.warn("[sync] Sync routes unavailable:", formatError(error));
		return null;
	}
}
