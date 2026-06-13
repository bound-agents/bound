// MCP-Apps-in-web-UI feature: see project memory project:mcp-apps-web-ui:design-and-progress.
//
// The web UI is a pure *renderer* of MCP Apps, not a tool provider. App-bearing
// servers are sourced from the agent-side `mcp.json` (NOT a dedicated
// `mcp_apps.json`): the agent connects to them server-side as usual, and the web
// UI watches the message stream and renders an app whenever a result lands for a
// tool the capability inventory flags as UI-bearing. This route supplies the two
// things the browser renderer needs — which configured servers are app-bearing
// (with their tool->uiResourceUri bindings), and a same-origin proxy to reach
// each one without leaking the upstream URL or auth headers to the client.
import type { Database } from "bun:sqlite";
import type { McpConfig } from "@bound/shared";
import { Hono } from "hono";

/** Request/response header names dropped when forwarding through the proxy. */
const HOP_BY_HOP_REQUEST_HEADERS = new Set(["host", "connection", "content-length"]);
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
]);

/** Injectable fetch for tests; defaults to the runtime global. */
export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A tool that carries an MCP-App UI binding (`_meta.ui.resourceUri`). */
interface AppToolBinding {
	name: string;
	uiResourceUri: string;
}

/** Shape we read out of a host's `mcp_capabilities` JSON for one server. */
interface CapabilityEntry {
	tools?: Array<{ name?: unknown; uiResourceUri?: unknown }>;
}

/**
 * Union the per-server tool->uiResourceUri bindings across every host's
 * capability inventory. A server is app-bearing if ANY host captured a
 * `uiResourceUri` for one of its tools — this tolerates a host whose capture
 * predates the binding (e.g. an endpoint that only later enabled UI support).
 * Returns a map keyed by server name; each value is keyed by tool name so a
 * tool seen on multiple hosts collapses to one binding.
 */
function collectAppBindings(db: Database): Map<string, Map<string, string>> {
	const rows = db
		.query("SELECT mcp_capabilities FROM hosts WHERE deleted = 0 AND mcp_capabilities IS NOT NULL")
		.all() as Array<{ mcp_capabilities: string }>;

	const byServer = new Map<string, Map<string, string>>();
	for (const row of rows) {
		let parsed: Record<string, CapabilityEntry>;
		try {
			parsed = JSON.parse(row.mcp_capabilities) as Record<string, CapabilityEntry>;
		} catch {
			continue;
		}
		for (const [serverName, entry] of Object.entries(parsed)) {
			for (const tool of entry?.tools ?? []) {
				if (typeof tool?.name !== "string" || typeof tool?.uiResourceUri !== "string") {
					continue;
				}
				let tools = byServer.get(serverName);
				if (!tools) {
					tools = new Map();
					byServer.set(serverName, tools);
				}
				// First host to report a binding wins; identical across hosts anyway.
				if (!tools.has(tool.name)) {
					tools.set(tool.name, tool.uiResourceUri);
				}
			}
		}
	}
	return byServer;
}

/**
 * Web-router endpoints backing MCP Apps in the web UI.
 *
 * Two routes, both web-router only (never the sync router):
 *
 *  - `GET /` lists the app-bearing servers from `mcp.json` as
 *    `{ name, transport, proxyPath, tools }`, where `tools` is the set of
 *    UI-bearing tools (name + `uiResourceUri`) the renderer should mount as
 *    apps. Only `http` servers that the inventory flags as app-bearing appear;
 *    `stdio` servers (a browser can't reach them) and http servers with no UI
 *    binding are omitted. The real upstream `url` and any auth `headers` are
 *    deliberately NOT sent to the browser — it connects to the same-origin
 *    `proxyPath` instead.
 *
 *  - `ALL /proxy/:name` is a transparent reverse proxy to the configured
 *    `http` server's real URL. Browsers can't connect to most MCP servers
 *    directly: the server has to opt into CORS, and almost none do. Proxying
 *    server-side dodges CORS entirely (it's a browser-only policy) and lets the
 *    configured auth `headers` be injected here rather than shipped to the
 *    client. Streamable HTTP responses (including `text/event-stream`) are
 *    streamed through unbuffered.
 */
export function createMcpAppsRoutes(
	db: Database,
	mcpConfig: McpConfig | null,
	fetchImpl: FetchImpl = fetch,
): Hono {
	const app = new Hono();

	// Only http servers are proxyable from a browser; index them by name.
	const httpServersByName = new Map(
		(mcpConfig?.servers ?? [])
			.filter((s): s is Extract<typeof s, { transport: "http" }> => s.transport === "http")
			.map((s) => [s.name, s]),
	);

	app.get("/", (c) => {
		const bindings = collectAppBindings(db);
		const servers: Array<{
			name: string;
			transport: "http";
			proxyPath: string;
			tools: AppToolBinding[];
		}> = [];

		for (const [name, server] of httpServersByName) {
			const toolMap = bindings.get(name);
			if (!toolMap || toolMap.size === 0) continue; // not app-bearing
			const tools: AppToolBinding[] = [...toolMap].map(([toolName, uiResourceUri]) => ({
				name: toolName,
				uiResourceUri,
			}));
			servers.push({
				name: server.name,
				transport: "http",
				// Browser connects here, NOT to the real url; secrets stay server-side.
				proxyPath: `/api/mcp-apps/proxy/${encodeURIComponent(server.name)}`,
				tools,
			});
		}

		return c.json({ servers });
	});

	app.all("/proxy/:name", async (c) => {
		const server = httpServersByName.get(c.req.param("name"));
		if (!server) {
			return c.json({ error: `Unknown MCP App server: ${c.req.param("name")}` }, 404);
		}

		const forwardHeaders = new Headers();
		for (const [key, value] of c.req.raw.headers) {
			if (!HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase())) {
				forwardHeaders.set(key, value);
			}
		}
		// Configured headers (e.g. auth) are injected here so they never reach
		// the browser. They override any client-supplied value of the same name.
		for (const [key, value] of Object.entries(server.headers ?? {})) {
			forwardHeaders.set(key, value);
		}

		const method = c.req.method;
		const hasBody = method !== "GET" && method !== "HEAD";
		let upstream: Response;
		try {
			upstream = await fetchImpl(server.url, {
				method,
				headers: forwardHeaders,
				body: hasBody ? await c.req.raw.arrayBuffer() : undefined,
				redirect: "follow",
			});
		} catch (err) {
			return c.json(
				{
					error: `MCP App proxy to "${server.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
				},
				502,
			);
		}

		const responseHeaders = new Headers();
		for (const [key, value] of upstream.headers) {
			const lower = key.toLowerCase();
			// Drop hop-by-hop headers and any upstream CORS headers (the browser
			// talks to us same-origin, so they're unnecessary and can conflict).
			if (!HOP_BY_HOP_RESPONSE_HEADERS.has(lower) && !lower.startsWith("access-control-")) {
				responseHeaders.set(key, value);
			}
		}

		// Stream the body through unbuffered so SSE / chunked responses work.
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: responseHeaders,
		});
	});

	return app;
}
