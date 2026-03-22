import type { Database } from "bun:sqlite";
import type { TypedEventEmitter } from "@bound/shared";
import { createApp } from "./index";
import { createWebSocketHandler } from "./websocket";

export interface WebServerConfig {
	port?: number;
	host?: string;
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

	// Ensure the Svelte SPA is built
	const { join } = await import("node:path");
	const { existsSync } = await import("node:fs");

	const distPath = join(import.meta.dir, "../../../dist/client");
	const spaAvailable = existsSync(join(distPath, "index.html"));
	if (!spaAvailable) {
		console.warn(
			"Svelte SPA not found at",
			distPath,
			"— web UI will not be available. API endpoints will still work.",
		);
	}

	// Create the Hono app with all routes
	const app = createApp(db, eventBus);

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
					if (
						new URL(request.url).pathname === "/ws" &&
						request.headers.get("upgrade") === "websocket"
					) {
						if (server.upgrade(request, { data: undefined })) {
							return; // Bun handles the upgrade
						}
						return new Response("WebSocket upgrade failed", { status: 500 });
					}
					// All other requests go to the Hono app
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
