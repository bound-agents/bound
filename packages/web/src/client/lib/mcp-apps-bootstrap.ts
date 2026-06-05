// Commit 5 of the MCP-Apps-in-web-UI feature: see project memory
// project:mcp-apps-web-ui:design-and-progress.
//
// One-time bootstrap that turns the web UI into an MCP Apps host + bound
// tool-provider client (the boundless pattern). On startup it asks the web
// router which MCP App servers to connect to (GET /api/mcp-apps, served from
// mcp_apps.json — web-router only, never the sync router), opens an in-page MCP
// connection to each, lists their tools, and registers them on the shared
// BoundClient as client tools. When the agent invokes one, the deferred
// tool:call is dispatched here against the in-page MCP client; UI-bearing tools
// additionally render an app panel (see mcp-app-store / McpAppPanel).
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { client } from "./bound";
import { McpAppHost, connectToMcpServer } from "./mcp-app-host";
import { createToolCallHandler } from "./mcp-app-store";

/**
 * Shape of one server entry from GET /api/mcp-apps. The real upstream URL and
 * any auth `headers` stay server-side; the browser connects to `proxyPath`, a
 * same-origin reverse proxy in the web router that forwards to the real server
 * (sidestepping CORS, which most MCP servers don't enable for browser origins).
 */
export interface McpAppServer {
	name: string;
	transport: "http" | "sse";
	proxyPath: string;
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
			// The SDK Client satisfies McpClientLike at runtime; its callTool union
			// is broader at the type level (legacy toolResult variant), so cast.
			const defs = host.registerServer(
				server.name,
				mcpClient as unknown as Parameters<McpAppHost["registerServer"]>[1],
				tools as Parameters<McpAppHost["registerServer"]>[2],
			);
			console.info(`[mcp-apps] ${server.name}: registered ${defs.length} tool(s)`);
		} catch (err) {
			console.error(`[mcp-apps] failed to connect to "${server.name}" (${server.proxyPath}):`, err);
		}
	}
	return host;
}

/**
 * Wire a populated host onto the shared BoundClient as client tools. No-op when
 * the host has no tools, so we never send an empty `session:configure`.
 * `configureTools` is re-sent automatically on every (re)connect, so ordering
 * against the WS connection does not matter. Returns whether tools were wired.
 */
export function registerHostOnClient(host: McpAppHost): boolean {
	const toolDefinitions = host.getToolDefinitions();
	if (toolDefinitions.length === 0) {
		console.warn("[mcp-apps] no tools registered from any server; leaving client unconfigured");
		return false;
	}
	const toolNames = toolDefinitions.map((d) => d.function.name).join(", ");
	client.onToolCall(createToolCallHandler(host));
	client.configureTools(toolDefinitions, {
		systemPromptAddition: `The web UI has connected MCP App tools available. Call them like any other tool; results that carry an interactive app render inline for the user. Available MCP App tools: ${toolNames}.`,
	});
	return true;
}

/**
 * One-time startup hook: load the configured MCP App servers, connect to them,
 * and register their tools on the shared BoundClient. Idempotent — only the
 * first call does work. A failed server-list fetch is logged and swallowed so
 * the UI is never blocked.
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
	registerHostOnClient(host);
	return host;
}
