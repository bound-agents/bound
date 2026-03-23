/**
 * Cross-host MCP tool proxy endpoint.
 * Implements spec §7.5: transparent proxying of tool calls to remote hosts.
 */

import type { Database } from "bun:sqlite";
import type { MCPClient } from "@bound/agent";
import type { KeyringConfig } from "@bound/shared";
import { createSyncAuthMiddleware } from "@bound/sync";
import { Hono } from "hono";

interface ProxyRequestBody {
	server: string;
	tool: string;
	arguments: Record<string, unknown>;
	idempotency_key?: string;
}

type AppContext = {
	Variables: {
		siteId: string;
		hostName: string;
		rawBody: string;
	};
};

export function createMCPProxyRoutes(
	_db: Database,
	mcpClients: Map<string, MCPClient>,
	keyring: KeyringConfig,
): Hono<AppContext> {
	const app = new Hono<AppContext>();

	// Apply sync auth middleware — proxy requests must be signed with a known site key
	app.use("/api/mcp-proxy", createSyncAuthMiddleware(keyring));

	app.post("/api/mcp-proxy", async (c) => {
		const rawBody = c.get("rawBody");
		let body: ProxyRequestBody;
		try {
			body = JSON.parse(rawBody) as ProxyRequestBody;
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const { server, tool, arguments: toolArgs } = body;

		if (!server || typeof server !== "string") {
			return c.json({ error: "Missing required field: server" }, 400);
		}
		if (!tool || typeof tool !== "string") {
			return c.json({ error: "Missing required field: tool" }, 400);
		}
		if (!toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
			return c.json({ error: "Missing or invalid field: arguments" }, 400);
		}

		const client = mcpClients.get(server);
		if (!client) {
			return c.json({ error: `MCP server not found: ${server}` }, 404);
		}

		if (!client.isConnected()) {
			return c.json({ error: `MCP server not connected: ${server}` }, 503);
		}

		try {
			const result = await client.callTool(tool, toolArgs);
			return c.json({ result });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ error: `Tool call failed: ${message}` }, 500);
		}
	});

	return app;
}
