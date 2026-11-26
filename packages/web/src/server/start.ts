import type { Database } from "bun:sqlite";
import type { TypedEventEmitter } from "@bound/shared";
import { createLogger } from "@bound/shared";
import { WsConnectionManager, createWsHandlers } from "@bound/sync";
import type { SyncAppConfig, WebAppConfig } from "./index";
import { createWebApp } from "./index";
import type { EmitToolCancel, HandleMessageTracker } from "./lib/handler-types";
import { hasLoopbackHostHeader, isLoopbackHost } from "./lib/loopback";
import { instrumentSyncWebSocketHandlers } from "./sync-websocket-lifecycle.js";
import { MAX_WEBHOOK_BODY_BYTES, handleWebhookRequest } from "./webhook-handler.js";
import { createWebSocketHandler } from "./websocket";
import type { ConnectionRegistry } from "./websocket";

const logger = createLogger("@bound/web", "server-start");
const UNSAFE_WEB_BIND_OVERRIDE = "BOUND_ALLOW_UNSAFE_WEB_BIND";
// A heartbeating connection unheard-from for this long while holding an
// in-flight client tool call is treated as wedged/dead and force-closed. 45s =
// 3 missed 15s client heartbeats: rides out a GC pause, still recovers fast.
const WS_LIVENESS_STALE_MS = 45_000;

export type WebServerConfig = Omit<WebAppConfig, "modelsConfig" | "emitToolCancel"> & {
	port?: number;
	host?: string;
	models?: WebAppConfig["modelsConfig"];
	handleMessageTracker?: HandleMessageTracker;
};

export interface SyncServerConfig extends SyncAppConfig {
	port?: number;
	host?: string;
}

export interface WebServer {
	start(): Promise<void>;
	stop(): Promise<void>;
	address(): string;
	/**
	 * The real listening port, read back from the live `Bun.serve` instance
	 * after `start()`. Differs from the configured `config.port` when the
	 * caller passed `port: 0` to request an OS-assigned ephemeral port — the
	 * in-process boot tests (`bound start` → `startNode`) pass `0` and dial
	 * this value. Returns the configured port before `start()` or `0` if the
	 * server is not currently listening.
	 */
	port(): number;
	wsConnectionManager?: WsConnectionManager;
	wsRegistry?: ConnectionRegistry;
	emitToolCancel?: EmitToolCancel;
}

function assertSafeWebBindHost(host: string): void {
	if (isLoopbackHost(host)) return;
	if (process.env[UNSAFE_WEB_BIND_OVERRIDE] === "1") {
		logger.warn("Starting web server on a non-loopback host by explicit override", {
			host,
			override: UNSAFE_WEB_BIND_OVERRIDE,
		});
		return;
	}
	throw new Error(
		`Refusing to bind unauthenticated web server to ${host}; set ${UNSAFE_WEB_BIND_OVERRIDE}=1 to override`,
	);
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
	assertSafeWebBindHost(host);

	const wsHandler = createWebSocketHandler({
		eventBus,
		db,
		siteId: config.siteId,
		defaultUserId: config.operatorUserId,
		logger,
		handleMessageTracker: config.handleMessageTracker,
	});

	const { port: _port, host: _host, models, handleMessageTracker: _tracker, ...shared } = config;
	const app = await createWebApp(db, eventBus, {
		...shared,
		modelsConfig: models,
		emitToolCancel: wsHandler.emitToolCancel,
		onRequest: (method, path) => logger.debug("request", { method, path }),
	});

	let server: ReturnType<typeof Bun.serve> | null = null;
	let reapInterval: ReturnType<typeof setInterval> | null = null;
	let livenessInterval: ReturnType<typeof setInterval> | null = null;

	return {
		async start(): Promise<void> {
			server = Bun.serve({
				port,
				hostname: host,
				// SSE streaming (e.g. /v1/responses) can have long gaps between
				// the initial events and the first model token — Opus with 155K
				// input tokens has a TTFT well over 10s. Bun's default
				// idleTimeout (10s) kills the connection mid-stream. 255 is
				// Bun's hard cap; the SSE heartbeat in SseEmitter keeps the
				// connection alive during the TTFT gap.
				idleTimeout: 255,
				fetch(request: Request, server) {
					const url = new URL(request.url);
					if (url.pathname === "/ws" && request.headers.get("upgrade") === "websocket") {
						if (!hasLoopbackHostHeader(request.headers.get("host"))) {
							return new Response("Invalid Host header", { status: 400 });
						}
						if (server.upgrade(request, { data: undefined })) {
							return;
						}
						return new Response("WebSocket upgrade failed", { status: 500 });
					}
					return app.fetch(request);
				},
				websocket: wsHandler,
			});

			// Reap sessions orphaned by an unclean shutdown — a killed process
			// or crashed host never fires WebSocket `close`, so `deleted = 0`
			// rows accumulate and the thread-list badge shows stale sessions.
			const startupReaped = wsHandler.reapStaleSessions();
			if (startupReaped > 0) {
				logger.info("Reaped orphaned client sessions on startup", {
					count: startupReaped,
				});
			}

			// Periodic reaper for dropped TCP connections that never fire close.
			reapInterval = setInterval(() => {
				const reaped = wsHandler.reapStaleSessions();
				if (reaped > 0) {
					logger.debug("Reaped stale client sessions", { count: reaped });
				}
			}, 60_000);

			// Liveness sweep: force-close heartbeating connections that have gone
			// silent while holding an in-flight client tool call, so a wedged/dead
			// editor whose socket is still TCP-open no longer parks its thread until
			// the operator kills the TUI. staleMs (45s) is 3 missed 15s client
			// heartbeats — long enough to ride out a GC pause, short enough to
			// recover fast. Only connections that heartbeat are eligible (older
			// clients / the web UI are untouched), so this is safe to run always.
			livenessInterval = setInterval(() => {
				const closed = wsHandler.sweepUnresponsiveConnections(WS_LIVENESS_STALE_MS);
				if (closed > 0) {
					logger.info("Force-closed unresponsive client connections", { count: closed });
				}
			}, 15_000);

			logger.info("Web server listening", { host, port, url: `http://${host}:${port}` });
		},

		async stop(): Promise<void> {
			if (reapInterval) clearInterval(reapInterval);
			if (livenessInterval) clearInterval(livenessInterval);
			wsHandler.cleanup();
			if (server) {
				server.stop(true);
				server = null;
			}
		},

		address(): string {
			return `http://${host}:${port}`;
		},

		port(): number {
			// The live OS-assigned port when `port: 0` was requested; the configured
			// port once bound; 0 before start / after stop.
			return server?.port ?? port;
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
	const wsHandlers = instrumentSyncWebSocketHandlers(
		createWsHandlers({
			connectionManager: wsConnectionManager,
			keyring: config.keyring,
			keyManager: config.keyManager,
			logger: config.logger,
			idleTimeout: config.wsConfig?.idleTimeout,
			backpressureLimit: config.wsConfig?.backpressureLimit,
			wsTransport: config.wsTransportHolder ?? undefined,
		}),
	);

	let server: ReturnType<typeof Bun.serve> | null = null;

	return {
		wsConnectionManager,

		async start(): Promise<void> {
			server = Bun.serve({
				port,
				hostname: host,
				maxRequestBodySize: MAX_WEBHOOK_BODY_BYTES,
				fetch(request: Request, bunServer) {
					const url = new URL(request.url);
					if (url.pathname === "/sync/ws" && request.headers.get("upgrade") === "websocket") {
						// handleUpgrade is async, so always return the Promise
						return wsHandlers.handleUpgrade(
							request,
							bunServer as Parameters<typeof wsHandlers.handleUpgrade>[1],
						);
					}

					const webhookMatch = url.pathname.match(/^\/webhook\/([a-z0-9][a-z0-9_-]{0,63})$/);
					if (webhookMatch) {
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

		port(): number {
			// The live OS-assigned port when `port: 0` was requested; the configured
			// port once bound; 0 before start / after stop.
			return server?.port ?? port;
		},
	};
}
