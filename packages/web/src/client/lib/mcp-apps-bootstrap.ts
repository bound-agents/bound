import { isToolVisibilityAppOnly } from "@modelcontextprotocol/ext-apps/app-bridge";
// MCP-Apps-in-web-UI feature: see project memory project:mcp-apps-web-ui:design-and-progress.
//
// One-time bootstrap that turns the web UI into an MCP Apps *renderer* (NOT a
// tool provider). App-bearing servers are sourced from the agent-side mcp.json
// — the agent connects to them server-side and calls their tools as usual, so
// the browser must NOT also register them as bound client tools (that would
// create two doors for the same tool: an agent-side one and a dead browser-side
// one whenever there's no live web session — see invariant #21). Instead the
// browser opens an in-page MCP connection to each app-bearing server purely so
// it can (a) read the server's `ui://` app resources and (b) route an app's
// AppBridge.callServerTool callbacks back to the server. The render trigger
// watches the conversation message stream for results on tools the capability
// inventory flags as UI-bearing (see mcp-app-store / McpAppPanel).
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpAppHost, connectToMcpServer } from "./mcp-app-host";
import { mcpAppHost } from "./mcp-app-store";

/**
 * Shape of one server entry from GET /api/mcp-apps. The real upstream URL and
 * any auth `headers` stay server-side; the browser connects to `proxyPath`, a
 * same-origin reverse proxy in the web router that forwards to the real server
 * (sidestepping CORS, which most MCP servers don't enable for browser origins).
 * `tools` lists the server's UI-bearing tools (the ones the renderer should
 * mount as apps when their results land in the message stream).
 */
export interface McpAppServer {
	name: string;
	transport: "http" | "sse";
	proxyPath: string;
	tools?: Array<{ name: string; uiResourceUri: string }>;
}

/** Connector used to open an MCP session; injectable for tests. */
export type ConnectFn = (url: URL, headers?: Record<string, string>) => Promise<Client>;

let started = false;

/** Fetch the configured MCP App servers from the web router. */
async function fetchMcpAppServers(): Promise<McpAppServer[]> {
	const res = await fetch("/api/mcp-apps");
	if (!res.ok) {
		throw new Error(`GET /api/mcp-apps failed: ${res.status}`);
	}
	const body = (await res.json()) as { servers?: McpAppServer[] };
	return body.servers ?? [];
}

/**
 * Connect to each server, list its tools, and register them on a fresh
 * `McpAppHost`. Per-server failures are logged and skipped so one unreachable
 * server doesn't sink the rest. Pure of module/client state so it can be unit
 * tested; the caller decides what to do with the returned host.
 */
export async function connectMcpServers(
	servers: McpAppServer[],
	connect: ConnectFn = connectToMcpServer,
	origin: string = typeof window !== "undefined" ? window.location.origin : "http://localhost",
): Promise<McpAppHost> {
	const host = new McpAppHost();
	for (const server of servers) {
		try {
			// proxyPath is same-origin; resolve against the page origin. Auth
			// headers are injected by the web-router proxy, not sent from here.
			const mcpClient = await connect(new URL(server.proxyPath, origin));
			const { tools } = await mcpClient.listTools();
			// Honor MCP Apps tool visibility (_meta.ui.visibility). App-only tools
			// (e.g. ["app"]) are widget-only: the rendered app calls them back via
			// AppBridge.callServerTool — which routes through the in-page SDK client
			// directly, not this host — so dropping them here hides them from the
			// model without breaking the app's ability to invoke them. Default
			// (absent) and ["model"]/["model","app"] stay visible to the model.
			const modelTools = tools.filter((t) => !isToolVisibilityAppOnly(t));
			// The SDK Client satisfies McpClientLike at runtime; its callTool union
			// is broader at the type level (legacy toolResult variant), so cast.
			const defs = host.registerServer(
				server.name,
				mcpClient as unknown as Parameters<McpAppHost["registerServer"]>[1],
				modelTools as Parameters<McpAppHost["registerServer"]>[2],
			);
			console.info(`[mcp-apps] ${server.name}: registered ${defs.length} tool(s)`);
		} catch (err) {
			console.error(`[mcp-apps] failed to connect to "${server.name}" (${server.proxyPath}):`, err);
		}
	}
	return host;
}

/**
 * One-time startup hook: load the app-bearing servers from mcp.json, open an
 * in-page MCP connection to each (so the renderer can read their `ui://` app
 * resources and route AppBridge.callServerTool callbacks), and expose the
 * connected host. The agent calls these servers' tools SERVER-SIDE, so we do
 * NOT register them on the BoundClient as client tools — that would double the
 * tool surface and strand the browser door whenever no live session exists
 * (invariant #21). Idempotent — only the first call does work. A failed
 * server-list fetch is logged and swallowed so the UI is never blocked.
 */
export async function initMcpApps(
	fetchServers: () => Promise<McpAppServer[]> = fetchMcpAppServers,
): Promise<McpAppHost | null> {
	if (started) return null;
	started = true;

	let servers: McpAppServer[];
	try {
		servers = await fetchServers();
	} catch (err) {
		console.error("[mcp-apps] could not load server list:", err);
		return null;
	}
	if (servers.length === 0) return null;

	const host = await connectMcpServers(servers);
	// Expose the connected host so per-thread views can resolve persisted tool
	// names back to UI-bearing registrations and mount app panels from the
	// conversation message stream (see mcp-app-store / McpAppPanel).
	mcpAppHost.set(host);
	return host;
}
