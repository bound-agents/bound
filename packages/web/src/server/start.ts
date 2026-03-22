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
	if (!existsSync(join(distPath, "index.html"))) {
		throw new Error(
			`Svelte SPA not built. Run 'cd packages/web && bun run build' to build the client.`,
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
				fetch(request: Request) {
					// Check for WebSocket upgrade on /ws path
					if (
						new URL(request.url).pathname === "/ws" &&
						request.headers.get("upgrade") === "websocket"
					) {
						// Bun.serve will call the websocket handler for this upgrade
						// biome-ignore lint/suspicious/noExplicitAny: Bun handles upgrade
						return undefined as any;
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
