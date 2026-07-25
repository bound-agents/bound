import type { Database } from "bun:sqlite";
import type { ModelRouter } from "@bound/llm";
import type { StatusForwardPayload, TypedEventEmitter } from "@bound/shared";
import type { McpConfig } from "@bound/shared";
import { createLogger } from "@bound/shared";
import { WsConnectionManager, createWsHandlers } from "@bound/sync";
import type { MountableFs } from "just-bash";
import type { BackendPricing, ModelsConfig, SyncAppConfig, WebAppConfig } from "./index";
import { createWebApp } from "./index";
import { MAX_WEBHOOK_BODY_BYTES, handleWebhookRequest } from "./webhook-handler.js";
import { createWebSocketHandler } from "./websocket";
import type { ConnectionRegistry } from "./websocket";

const logger = createLogger("@bound/web", "server-start");
const LOOPBACK_BIND_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const UNSAFE_WEB_BIND_OVERRIDE = "BOUND_ALLOW_UNSAFE_WEB_BIND";
// A heartbeating connection unheard-from for this long while holding an
// in-flight client tool call is treated as wedged/dead and force-closed. 45s =
// 3 missed 15s client heartbeats: rides out a GC pause, still recovers fast.
const WS_LIVENESS_STALE_MS = 45_000;

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
	 * Agent-side MCP server config (`mcp.json`), forwarded to the web app. The
	 * MCP-Apps route sources app-bearing http servers from it and proxies the
	 * browser to them. Web-router only.
	 */
	mcpConfig?: McpConfig | null;
	/**
	 * In-process model router. When provided, exposes `POST /v1/responses`
	 * (OpenAI Responses-API-compatible inference over HTTP).
	 */
	modelRouter?: ModelRouter | null;
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

function extractHostName(hostHeader: string): string {
	if (hostHeader.startsWith("[")) {
		const end = hostHeader.indexOf("]");
		return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
	}
	return hostHeader.split(":")[0];
}

function isLoopbackHost(host: string): boolean {
	return LOOPBACK_BIND_HOSTS.has(host);
}

function hasValidLoopbackHostHeader(request: Request): boolean {
	const host = request.headers.get("host");
	if (!host) return true;
	return isLoopbackHost(extractHostName(host));
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
		activeLoops: config.activeLoops,
		emitToolCancel: wsHandler.emitToolCancel,
		requestConsistency: config.requestConsistency,
		clusterFs: config.clusterFs,
		mcpConfig: config.mcpConfig,
		modelRouter: config.modelRouter,
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
				// idleTimeout (10s) kills the connection mid-stream. 300s
				// matches the relay inference timeout.
				idleTimeout: 300,
				fetch(request: Request, server) {
					const url = new URL(request.url);
					if (url.pathname === "/ws" && request.headers.get("upgrade") === "websocket") {
						if (!hasValidLoopbackHostHeader(request)) {
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
