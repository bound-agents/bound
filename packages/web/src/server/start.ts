import type { Database } from "bun:sqlite";
import type { StatusForwardPayload, TypedEventEmitter } from "@bound/shared";
import type { McpAppsConfig } from "@bound/shared";
import { createLogger } from "@bound/shared";
import { WsConnectionManager, createWsHandlers } from "@bound/sync";
import type { MountableFs } from "just-bash";
import type { BackendPricing, ModelsConfig, SyncAppConfig, WebAppConfig } from "./index";
import { createWebApp } from "./index";
import { handleWebhookRequest } from "./webhook-handler.js";
import { createWebSocketHandler } from "./websocket";
import type { ConnectionRegistry } from "./websocket";

const logger = createLogger("@bound/web", "server-start");

export type { ModelsConfig, BackendPricing };

export interface WebServerConfig {
	port?: number;
	host?: string;
	hostName?: string;
	operatorUserId: string;
	models?: ModelsConfig | (() => ModelsConfig | undefined);
	backendPricing?: BackendPricing[];
	siteId?: string;
	/**
	 * The sync server's bind host (PORT/BIND_HOST env). Forwarded to the
	 * webhooks route so it can enumerate the local webhook delivery URL.
	 * Webhook ingestion is on the sync server (port 3000), distinct from
	 * the web port (3001) — see #36.
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
	requestConsistency?: (tables: string[]) => Promise<Map<string, { count: number; pks: string[] }>>;
	/**
	 * Optional cross-handler-invocation span tracker. Forwarded to the WS
	 * handler so `tool:result` reception closes the matching `tool.dispatch`
	 * span. Typed as a minimal interface so this package doesn't import
	 * `@bound/agent`.
	 */
	handleMessageTracker?: {
		closeDispatch(callId: string, status?: "ok" | "error", reason?: string): void;
	};
	/**
	 * Live sandbox cluster filesystem. When provided, exposes
	 * `/api/sandbox/file` for arbitrary path read/write — used by the
	 * `boundless_copy` tool to bridge host and sandbox filesystems
	 * without round-tripping bytes through the LLM context window.
	 */
	clusterFs?: MountableFs | null;
	/**
	 * Browser-reachable MCP App servers (`mcp_apps.json`), forwarded to the web
	 * app and served via `GET /api/mcp-apps`. Web-router only.
	 */
	mcpApps?: McpAppsConfig | null;
}

export interface SyncServerConfig extends SyncAppConfig {
	port?: number;
	host?: string;
}

export interface WebServer {
	start(): Promise<void>;
	stop(): Promise<void>;
	address(): string;
	wsConnectionManager?: WsConnectionManager;
	wsRegistry?: ConnectionRegistry;
	emitToolCancel?: (
		entries: Array<{ event_payload: string | null; claimed_by: string | null; message_id: string }>,
		threadId: string,
		reason: "thread_canceled" | "dispatch_expired" | "session_reset",
	) => void;
}

/**
 * Create the web server: API routes, WebSocket, static assets, DNS-rebinding protection.
 * Binds to WEB_PORT (default 3001) on WEB_BIND_HOST (default localhost).
 */
export async function createWebServer(
	db: Database,
	eventBus: TypedEventEmitter,
	config: WebServerConfig,
): Promise<WebServer> {
	const port = config.port ?? 3001;
	const host = config.host ?? "localhost";

	// Create WebSocket handler first to get emitToolCancel
	const wsHandler = createWebSocketHandler({
		eventBus,
		db,
		siteId: config.siteId,
		defaultUserId: config.operatorUserId,
		handleMessageTracker: config.handleMessageTracker,
	});

	const webAppConfig: WebAppConfig = {
		modelsConfig: config.models,
		backendPricing: config.backendPricing,
		hostName: config.hostName,
		operatorUserId: config.operatorUserId,
		siteId: config.siteId,
		syncBindHost: config.syncBindHost,
		syncPort: config.syncPort,
		hubUrl: config.hubUrl,
		statusForwardCache: config.statusForwardCache,
		activeDelegations: config.activeDelegations,
		activeLoops: config.activeLoops,
		emitToolCancel: wsHandler.emitToolCancel,
		requestConsistency: config.requestConsistency,
		clusterFs: config.clusterFs,
		mcpAppsConfig: config.mcpApps,
	};

	const app = await createWebApp(db, eventBus, webAppConfig);

	// Request logging middleware (debug level — access logs are noisy by default)
	app.use("*", async (c, next) => {
		const method = c.req.method;
		const path = new URL(c.req.url).pathname;
		logger.debug("request", { method, path });
		return next();
	});

	let server: ReturnType<typeof Bun.serve> | null = null;

	return {
		async start(): Promise<void> {
			server = Bun.serve({
				port,
				hostname: host,
				fetch(request: Request, server) {
					const url = new URL(request.url);
					if (url.pathname === "/ws" && request.headers.get("upgrade") === "websocket") {
						if (server.upgrade(request, { data: undefined })) {
							return;
						}
						return new Response("WebSocket upgrade failed", { status: 500 });
					}
					return app.fetch(request);
				},
				websocket: wsHandler,
			});

			logger.info("Web server listening", { host, port, url: `http://${host}:${port}` });
		},

		async stop(): Promise<void> {
			wsHandler.cleanup();
			if (server) {
				server.stop(true);
				server = null;
			}
		},

		address(): string {
			return `http://${host}:${port}`;
		},

		wsRegistry: wsHandler.registry,
		emitToolCancel: wsHandler.emitToolCancel,
	};
}

/**
 * Create the sync server: WebSocket sync transport with Ed25519 auth.
 * Binds to PORT (default 3000) on BIND_HOST (default localhost).
 * Returns null if sync prerequisites are missing.
 */
export async function createSyncServer(
	db: Database,
	eventBus: TypedEventEmitter,
	config: SyncServerConfig,
): Promise<WebServer | null> {
	const port = config.port ?? 3000;
	const host = config.host ?? "localhost";

	// Create WebSocket connection manager and handlers
	// WS upgrade requires keyManager for Ed25519 authentication
	if (!config.keyManager) {
		throw new Error("keyManager is required for WebSocket sync transport");
	}

	const wsConnectionManager = new WsConnectionManager();
	const wsHandlers = createWsHandlers({
		connectionManager: wsConnectionManager,
		keyring: config.keyring,
		keyManager: config.keyManager,
		logger: config.logger,
		idleTimeout: config.wsConfig?.idleTimeout,
		backpressureLimit: config.wsConfig?.backpressureLimit,
		wsTransport: config.wsTransportHolder ?? undefined,
	});

	let server: ReturnType<typeof Bun.serve> | null = null;

	return {
		wsConnectionManager,

		async start(): Promise<void> {
			server = Bun.serve({
				port,
				hostname: host,
				maxRequestBodySize: 128 * 1024 * 1024, // 128 MB — chunked push keeps payloads well under this
				fetch(request: Request, bunServer) {
					const url = new URL(request.url);
					if (url.pathname === "/sync/ws" && request.headers.get("upgrade") === "websocket") {
						// handleUpgrade is async, so always return the Promise
						return wsHandlers.handleUpgrade(
							request,
							bunServer as Parameters<typeof wsHandlers.handleUpgrade>[1],
						);
					}

					// Webhook route: POST /webhook/:name
					const webhookMatch = url.pathname.match(/^\/webhook\/([a-z0-9][a-z0-9_-]{0,63})$/);
					if (webhookMatch) {
						if (request.method !== "POST") {
							return new Response("Not found", { status: 404 });
						}
						return handleWebhookRequest(request, webhookMatch[1], {
							db,
							siteId: config.siteId,
							eventBus,
						});
					}

					return new Response("Not found", { status: 404 });
				},
				websocket: wsHandlers.websocket,
			});

			logger.info("Sync server listening", { host, port, url: `http://${host}:${port}` });
		},

		async stop(): Promise<void> {
			if (server) {
				server.stop(true);
				server = null;
			}
		},

		address(): string {
			return `http://${host}:${port}`;
		},
	};
}
