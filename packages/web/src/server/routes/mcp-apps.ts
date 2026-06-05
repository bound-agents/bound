import type { McpAppsConfig } from "@bound/shared";
import { Hono } from "hono";

/**
 * Web-router endpoint that hands the browser the list of MCP App servers it
 * should connect to directly. The web UI is the MCP Apps *host*: it opens the
 * MCP connection in-page, registers each server's tools as bound client tools
 * (the boundless pattern), and renders UI-bearing tool results as MCP Apps.
 *
 * This lives entirely in the web router (:3001) and never touches the sync
 * router (:3000). `mcp_apps.json` is distinct from `mcp.json` — the latter is
 * connected to server-side by the agent's MCP bridge and may carry secrets in
 * `env`/`headers` that must not reach the browser. Only the browser-reachable
 * `mcpApps` entries are served here. Operators should treat any `headers` in
 * `mcp_apps.json` as client-visible.
 */
export function createMcpAppsRoutes(mcpApps: McpAppsConfig | null): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		return c.json({ servers: mcpApps?.servers ?? [] });
	});

	return app;
}
