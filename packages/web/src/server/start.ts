import type { Database } from "bun:sqlite";
import type { StatusForwardPayload, TypedEventEmitter } from "@bound/shared";
import { WsConnectionManager, createWsHandlers } from "@bound/sync";
import type { ModelsConfig, SyncAppConfig, WebAppConfig } from "./index";
import { createWebApp } from "./index";
import { createWebSocketHandler } from "./websocket";

export type { ModelsConfig };

export interface WebServerConfig {
	port?: number;
	host?: string;
	hostName?: string;
	operatorUserId: string;
	models?: ModelsConfig;
	siteId?: string;
	statusForwardCache?: Map<string, StatusForwardPayload>;
	activeDelegations?: Map<string, { targetSiteId: string; processOutboxId: string }>;
	activeLoops?: Set<string>;
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

	const webAppConfig: WebAppConfig = {
		modelsConfig: config.models,
		hostName: config.hostName,
		operatorUserId: config.operatorUserId,
		siteId: config.siteId,
		statusForwardCache: config.statusForwardCache,
		activeDelegations: config.activeDelegations,
		activeLoops: config.activeLoops,
	};

	const app = await createWebApp(db, eventBus, webAppConfig);

	// Request logging middleware
	app.use("*", async (c, next) => {
		const method = c.req.method;
		const path = new URL(c.req.url).pathname;
		console.log(`[web] ${method} ${path}`);
		return next();
	});

	// Create WebSocket handler
	const wsHandler = createWebSocketHandler(eventBus);

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

			console.log(`Web server listening on http://${host}:${port}`);
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
	};
}

/**
 * Create the sync server: WebSocket sync transport with Ed25519 auth.
 * Binds to PORT (default 3000) on BIND_HOST (default localhost).
 * Returns null if sync prerequisites are missing.
 */
export async function createSyncServer(
	_db: Database,
	_eventBus: TypedEventEmitter,
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
					// No other HTTP routes — all sync traffic is WebSocket
					return new Response("Not found", { status: 404 });
				},
				websocket: wsHandlers.websocket,
			});

			console.log(`Sync server listening on http://${host}:${port}`);
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
