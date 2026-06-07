import type { Database } from "bun:sqlite";
import type { KeyringConfig, Logger, StatusForwardPayload, TypedEventEmitter } from "@bound/shared";
import type { McpAppsConfig } from "@bound/shared";
import type { KeyManager, RelayExecutor } from "@bound/sync";
import type {
	ChangelogAckPayload,
	ChangelogPushPayload,
	RelayAckPayload,
	RelaySendPayload,
} from "@bound/sync";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { MountableFs } from "just-bash";
import { EMBEDDED_ASSETS_ENCODING, decodeAssetContent } from "./embedded-assets-codec";
import {
	type BackendPricing,
	type ModelsConfig,
	type RoutesConfig,
	registerRoutes,
} from "./routes/index";

type AssetMap = Map<string, { content: string; contentType: string }>;

async function loadEmbeddedAssets(): Promise<AssetMap> {
	try {
		const mod = await import("./embedded-assets");
		const raw = mod.embeddedAssets;
		if (!raw) return new Map();
		// Assets are stored gzip+base64 (see embedded-assets-codec.ts). Decode back
		// to their original text here so the serve path stays byte-identical. Older
		// generated modules without the marker hold raw content and pass through.
		if (mod.embeddedAssetsEncoding !== EMBEDDED_ASSETS_ENCODING) return raw;
		const decoded: AssetMap = new Map();
		for (const [path, asset] of raw) {
			decoded.set(path, {
				content: decodeAssetContent(asset.content),
				contentType: asset.contentType,
			});
		}
		return decoded;
	} catch {
		return new Map();
	}
}

export type { ModelsConfig, BackendPricing };

export interface WebAppConfig {
	modelsConfig?: ModelsConfig | (() => ModelsConfig | undefined);
	backendPricing?: BackendPricing[];
	hostName?: string;
	siteId?: string;
	operatorUserId: string;
	/**
	 * The sync server's bind host and port (PORT/BIND_HOST env). Forwarded
	 * to the webhooks route so it can enumerate the local webhook delivery
	 * URL — webhook ingestion is on the sync port (3000), distinct from the
	 * web port (3001). See #36.
	 */
	syncBindHost?: string;
	syncPort?: number;
	/**
	 * `sync.hub` from config, if this node is a spoke. Forwarded to the
	 * webhooks route so the hub's public webhook URL appears in the URL
	 * enumeration alongside the local URLs.
	 */
	hubUrl?: string;
	statusForwardCache?: Map<string, StatusForwardPayload>;
	activeDelegations?: Map<string, { targetSiteId: string; processOutboxId: string }>;
	activeLoops?: Set<string>;
	emitToolCancel?: (
		entries: Array<{ event_payload: string | null; claimed_by: string | null; message_id: string }>,
		threadId: string,
		reason: "thread_canceled" | "dispatch_expired" | "session_reset",
	) => void;
	requestConsistency?: (tables: string[]) => Promise<Map<string, { count: number; pks: string[] }>>;
	/**
	 * Live sandbox cluster filesystem. When provided, exposes
	 * `/api/sandbox/file` for arbitrary path read/write — used by the
	 * `boundless_copy` tool to bridge host and sandbox filesystems
	 * without round-tripping bytes through the LLM context window.
	 */
	clusterFs?: MountableFs | null;
	/**
	 * Browser-reachable MCP App servers (`mcp_apps.json`). Served to the web UI
	 * via `GET /api/mcp-apps`. Web-router only; never touches the sync router.
	 */
	mcpAppsConfig?: McpAppsConfig | null;
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
		continueConsistencyStream: (siteId: string) => void;
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
		backendPricing: config.backendPricing,
		hostName: config.hostName,
		siteId: config.siteId,
		operatorUserId: config.operatorUserId,
		syncBindHost: config.syncBindHost,
		syncPort: config.syncPort,
		hubUrl: config.hubUrl,
		statusForwardCache: config.statusForwardCache,
		activeDelegations: config.activeDelegations,
		activeLoops: config.activeLoops,
		emitToolCancel: config.emitToolCancel,
		requestConsistency: config.requestConsistency,
		clusterFs: config.clusterFs,
		mcpAppsConfig: config.mcpAppsConfig,
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
	app.route("/api/mcp-apps", routes.mcpApps);
	app.route("/api/webhooks", routes.webhooks);
	app.route("/api/skills", routes.skills);
	app.route("/api/metrics", routes.metrics);
	app.route("/api/sandbox", routes.sandbox);
	app.route("/api/persona", routes.persona);

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
