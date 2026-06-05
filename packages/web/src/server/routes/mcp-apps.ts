// Commit 1 (+ CORS proxy) of the MCP-Apps-in-web-UI feature: see project memory
// project:mcp-apps-web-ui:design-and-progress.
import type { McpAppsConfig } from "@bound/shared";
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

/**
 * Web-router endpoints backing MCP Apps in the web UI. The web UI is the MCP
 * Apps *host*: it opens the MCP connection in-page, registers each server's
 * tools as bound client tools (the boundless pattern), and renders UI-bearing
 * tool results as MCP Apps.
 *
 * Two routes, both web-router only (never the sync router):
 *
 *  - `GET /` lists the configured servers as `{ name, transport, proxyPath }`.
 *    The real upstream `url` and any `headers` (which may carry auth secrets)
 *    are deliberately NOT sent to the browser — the browser connects to the
 *    same-origin `proxyPath` instead.
 *
 *  - `ALL /proxy/:name` is a transparent reverse proxy to the configured
 *    server's real URL. Browsers can't connect to most MCP servers directly:
 *    the server has to opt into CORS, and almost none do (the typical failure
 *    is a non-2xx preflight + a 405 on the SSE GET). Proxying server-side dodges
 *    CORS entirely (it's a browser-only policy) and lets the configured auth
 *    `headers` be injected here rather than shipped to the client. Streamable
 *    HTTP responses (including `text/event-stream`) are streamed through
 *    unbuffered. NOTE: this path-rewriting proxy is correct for `http`
 *    (Streamable HTTP) servers; legacy `sse` servers advertise a message
 *    endpoint relative to their own origin, which this proxy does not rewrite.
 */
export function createMcpAppsRoutes(
	mcpApps: McpAppsConfig | null,
	fetchImpl: FetchImpl = fetch,
): Hono {
	const app = new Hono();
	const serversByName = new Map((mcpApps?.servers ?? []).map((s) => [s.name, s]));

	app.get("/", (c) => {
		const servers = (mcpApps?.servers ?? []).map((s) => ({
			name: s.name,
			transport: s.transport,
			// Browser connects here, NOT to the real url; secrets stay server-side.
			proxyPath: `/api/mcp-apps/proxy/${encodeURIComponent(s.name)}`,
		}));
		return c.json({ servers });
	});

	app.all("/proxy/:name", async (c) => {
		const server = serversByName.get(c.req.param("name"));
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
