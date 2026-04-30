import type { Database } from "bun:sqlite";
import type { KeyringConfig, Logger, StatusForwardPayload, TypedEventEmitter } from "@bound/shared";
import type { KeyManager, RelayExecutor } from "@bound/sync";
import type {
	ChangelogAckPayload,
	ChangelogPushPayload,
	RelayAckPayload,
	RelaySendPayload,
} from "@bound/sync";
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
	emitToolCancel?: (
		entries: Array<{ event_payload: string | null; claimed_by: string | null; message_id: string }>,
		threadId: string,
		reason: "thread_canceled" | "dispatch_expired" | "session_reset",
	) => void;
	requestConsistency?: (tables: string[]) => Promise<Map<string, { count: number; pks: string[] }>>;
}

export interface SyncAppConfig {
	siteId: string;
	keyring: KeyringConfig;
	logger: Logger;
	relayExecutor?: RelayExecutor;
	hubSiteId?: string;
	keyManager?: KeyManager;
	wsConfig?: {
		idleTimeout?: number;
		backpressureLimit?: number;
	};
	wsTransportHolder?: {
		addPeer: (
			siteId: string,
			sendFrame: (frame: Uint8Array) => boolean,
			symmetricKey: Uint8Array,
		) => void;
		removePeer: (siteId: string) => void;
		handleChangelogPush: (siteId: string, payload: ChangelogPushPayload) => void;
		handleChangelogAck: (siteId: string, payload: ChangelogAckPayload) => void;
		drainChangelog: (siteId: string) => void;
		handleRelaySend: (sourceSiteId: string, payload: RelaySendPayload) => void;
		handleRelayAck: (sourceSiteId: string, payload: RelayAckPayload) => void;
		drainRelayInbox: (siteId: string) => void;
		seedNewPeer: (siteId: string) => void;
		handleSnapshotAck: (siteId: string, payload: unknown) => void;
		continueSnapshotSeed: (siteId: string) => void;
		applySnapshotChunk: (tableName: string, rows: Array<Record<string, unknown>>) => number;
		handleReseedRequest: (siteId: string, payload: unknown) => void;
		handleConsistencyRequest: (siteId: string, payload: unknown) => void;
		handleRowPullRequest: (siteId: string, payload: unknown) => void;
		handleRowPullAck: (siteId: string, payload: unknown) => void;
		continueRowPull: (siteId: string) => void;
	} | null;
}

/**
 * Create the web/API Hono app: API routes, webhook routes, static assets, DNS-rebinding protection.
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
		emitToolCancel: config.emitToolCancel,
		requestConsistency: config.requestConsistency,
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
