import type { Database } from "bun:sqlite";
import type { TypedEventEmitter, KeyringConfig } from "@bound/shared";
import type { MCPClient } from "@bound/agent";
import { type ModelsConfig, type AppConfig, createApp } from "./index";
import { createWebSocketHandler } from "./websocket";

export type { ModelsConfig };

export interface WebServerConfig {
	port?: number;
	host?: string;
	models?: ModelsConfig;
	mcpClients?: Map<string, MCPClient>;
	keyring?: KeyringConfig;
}

export interface WebServer {
	start(): Promise<void>;
	stop(): Promise<void>;
	address(): string;
}

/**
 * Create and start the web server with Hono API routes, WebSocket support, and static asset serving
 */
export async function createWebServer(
	db: Database,
	eventBus: TypedEventEmitter,
	config: WebServerConfig = {},
): Promise<WebServer> {
	const port = config.port ?? 3000;
	const host = config.host ?? "localhost";

	const appConfig: AppConfig = {
		modelsConfig: config.models,
		mcpClients: config.mcpClients,
		keyring: config.keyring,
	};

	// Create the Hono app with all routes (loads embedded assets if available)
	const app = await createApp(db, eventBus, appConfig);

	// Request logging middleware
	app.use("*", async (c, next) => {
		const method = c.req.method;
		const path = new URL(c.req.url).pathname;
		console.log(`[web] ${method} ${path}`);
		return next();
	});

	// Create WebSocket handler
	const wsHandler = createWebSocketHandler(eventBus);

	// Start the server with Bun.serve
	let server: ReturnType<typeof Bun.serve> | null = null;

	return {
		async start(): Promise<void> {
			server = Bun.serve({
				port,
				hostname: host,
				fetch(request: Request, server) {
					// Check for WebSocket upgrade on /ws path
					const url = new URL(request.url);
					if (
						url.pathname === "/ws" &&
						request.headers.get("upgrade") === "websocket"
					) {
						if (server.upgrade(request, { data: undefined })) {
							return;
						}
						return new Response("WebSocket upgrade failed", { status: 500 });
					}
					// Pass to Hono (no extra args — Bun server object confuses Hono's Env)
					return app.fetch(request);
				},
				websocket: wsHandler,
			});

			console.log(`Web server listening on http://${host}:${port}`);
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
