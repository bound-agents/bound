// The web UI is a pure *renderer* of MCP Apps, not a tool provider. App-bearing
// servers are sourced from the agent-side `mcp.json` (NOT a dedicated
// `mcp_apps.json`): the agent connects to them server-side as usual, and the web
// UI watches the message stream and renders an app whenever a result lands for a
// tool the capability inventory flags as UI-bearing. This route supplies the two
// things the browser renderer needs — which configured servers are app-bearing
// (with their tool->uiResourceUri bindings), and a same-origin proxy to reach
// each one without leaking the upstream URL or auth headers to the client.
//
// Location transparency (R-MO27b): the app proxy is NOT limited to servers in
// THIS host's local `mcp.json`. Server identity is per-host — `(site_id, name)`
// — and the proxyPath carries the owning `site_id`, so an app-bearing server
// configured only on another host still renders here. For a server this host
// owns, the proxy fetches upstream directly and attaches the owner's own token
// at its own fetch edge (LEG A). For a server another host owns, the proxy
// relays the MCP call through the owning host over the durable-work spool (the
// `mcp_app_proxy` relay kind), and the owner attaches its token at ITS edge
// (LEG B) — same doctrine as R-UD12 tool dispatch: any host serves any surface,
// affinity is an optimization. Tokens never move (R-MO24); only the request body
// and an allow-listed header subset cross the relay, never a browser credential.
import type { Database } from "bun:sqlite";
import { listHostMcpInfo } from "@bound/core";
import { findChallengeByServer } from "@bound/core";
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

/**
 * The MCP protocol headers the cross-host relay is allowed to carry from the
 * browser to the owning host (R-MO27b). Cookies and Authorization are NEVER on
 * this list — the browser holds no upstream credential, and the owner mints its
 * own token at its own edge. Everything outside this set is dropped before the
 * relay payload is built.
 */
const RELAY_FORWARD_REQUEST_HEADERS = new Set([
	"accept",
	"content-type",
	"mcp-session-id",
	"mcp-protocol-version",
	"last-event-id",
]);

/** Injectable fetch for tests; defaults to the runtime global. */
export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Co-location token accessor (R-MO27b LEG A). Returns a live access token for a
 * locally-owned oauth server, running the refresh path. Wired from the CLI start
 * MCP-OAuth wiring; absent on hosts with no oauth-configured MCP server.
 */
export type GetAccessTokenForServer = (
	serverName: string,
) => Promise<
	| { ok: true; value: string }
	| { ok: false; error: { kind: "no_bundle" | "lost_grant" | "transient" | "not_oauth" | string } }
>;

/**
 * Cross-host relay dispatcher (R-MO27b LEG B). Relays a browser MCP-App proxy
 * request to the owning `site_id` over the `mcp_app_proxy` durable-work kind and
 * awaits the owner's response. Wired from the CLI start path (it composes
 * `insertDurableWork` + the response awaiter); absent when this host cannot
 * relay. Throws on a routing error (target not `work_spool_capable`, R-DW14) or
 * a relay timeout so the route maps it to a 502/504.
 */
export type RelayMcpAppProxy = (
	ownerSiteId: string,
	payload: {
		server_name: string;
		method: string;
		headers: Record<string, string>;
		body_base64: string;
	},
) => Promise<{ status: number; headers: Record<string, string>; body_base64: string }>;

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
 * An app-bearing server resolved to its owning host. `siteId` is the owner's
 * `site_id` (server identity is per-host, `(site_id, name)`); `local` marks the
 * serving host as the owner (LEG A direct fetch) vs. a peer owner (LEG B relay).
 */
interface ResolvedAppServer {
	name: string;
	siteId: string;
	local: boolean;
	tools: AppToolBinding[];
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
	const rows = listHostMcpInfo(db);

	const byServer = new Map<string, Map<string, string>>();
	for (const row of rows) {
		if (!row.mcp_capabilities) continue;
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
 * The ownership map: which host(s) configure each MCP server by name, from the
 * synced `hosts.mcp_servers` inventory (written by each host's MCP bridge as the
 * set of server names it connects to). Returns a map keyed by server name to the
 * set of owning `site_id`s — a server name configured on two hosts is a distinct
 * `(site_id, name)` on each, so the selector must name the site to disambiguate.
 */
function collectServerOwners(db: Database): Map<string, Set<string>> {
	const rows = listHostMcpInfo(db);
	const owners = new Map<string, Set<string>>();
	for (const row of rows) {
		if (!row.mcp_servers) continue;
		let names: unknown;
		try {
			names = JSON.parse(row.mcp_servers);
		} catch {
			continue;
		}
		if (!Array.isArray(names)) continue;
		for (const name of names) {
			if (typeof name !== "string") continue;
			let set = owners.get(name);
			if (!set) {
				set = new Set();
				owners.set(name, set);
			}
			set.add(row.site_id);
		}
	}
	return owners;
}

/**
 * Resolve app-bearing servers to their owning hosts. A server is included when
 * (a) the capability inventory flags it app-bearing AND (b) some host configures
 * it. The serving host's own local `mcp.json` is the authority for LOCAL
 * ownership (it may configure a server whose capabilities another host captured);
 * peer ownership comes from the synced `hosts.mcp_servers` map. When the local
 * host and a peer both own the same name, the local entry wins (this host serves
 * it directly, LEG A) — the browser still names `(site_id, name)` so the peer
 * copy stays addressable if the local one is later removed.
 */
function resolveAppServers(
	db: Database,
	localSiteId: string,
	localHttpServerNames: Set<string>,
): ResolvedAppServer[] {
	const bindings = collectAppBindings(db);
	const owners = collectServerOwners(db);
	const resolved: ResolvedAppServer[] = [];
	const seen = new Set<string>(); // `${siteId}\u0000${name}`

	const pushServer = (name: string, siteId: string, local: boolean): void => {
		const toolMap = bindings.get(name);
		if (!toolMap || toolMap.size === 0) return; // not app-bearing
		const key = `${siteId}\u0000${name}`;
		if (seen.has(key)) return;
		seen.add(key);
		resolved.push({
			name,
			siteId,
			local,
			tools: [...toolMap].map(([toolName, uiResourceUri]) => ({ name: toolName, uiResourceUri })),
		});
	};

	// Local http servers owned by this host (LEG A direct-fetch candidates).
	for (const name of localHttpServerNames) {
		pushServer(name, localSiteId, true);
	}
	// Peer-owned servers from the synced ownership map (LEG B relay candidates). A
	// name this host configures locally is served directly (LEG A) and suppresses
	// every peer-owned copy of the SAME name — the local owner is the one door for
	// that name, so the browser never sees a redundant second entry. (Two DIFFERENT
	// names each owned by a distinct peer still both appear; only a name collision
	// with the local config is collapsed.)
	for (const [name, siteIds] of owners) {
		if (localHttpServerNames.has(name)) continue; // local owner wins the name
		for (const siteId of siteIds) {
			if (siteId === localSiteId) continue; // local ownership already handled above
			pushServer(name, siteId, false);
		}
	}
	return resolved;
}

/**
 * Web-router endpoints backing MCP Apps in the web UI.
 *
 * Two routes, both web-router only (never the sync router):
 *
 *  - `GET /` lists the app-bearing servers as `{ name, transport, proxyPath,
 *    tools }`, joining the local `mcp.json` with the synced capability inventory
 *    and ownership map so app-bearing servers on ANY host appear. `proxyPath`
 *    carries the owning `site_id` so the selector is unambiguous. The real
 *    upstream `url` and any auth `headers` are deliberately NOT sent to the
 *    browser — it connects to the same-origin `proxyPath` instead.
 *
 *  - `ALL /proxy/:site/:name` is the reverse proxy. Browsers can't connect to
 *    most MCP servers directly (CORS), so proxying server-side dodges it. For a
 *    server this host owns (`:site` == localSiteId) the proxy fetches upstream
 *    directly and injects the configured static headers OR the owner's OAuth
 *    token (LEG A). For a peer-owned server it relays the MCP call through the
 *    owning host over the `mcp_app_proxy` durable-work kind (LEG B). A selector
 *    that does not resolve to exactly one known `(site, name)` is rejected
 *    BEFORE any fetch (R-MO27b). The proxy carries Streamable HTTP
 *    request/response POST; there is no standalone server→client GET SSE stream
 *    the bootstrap subscribes to (verified against mcp-app-host.ts +
 *    mcp-apps-bootstrap.ts), so the relay is request/response only.
 */
export function createMcpAppsRoutes(
	db: Database,
	mcpConfig: McpConfig | null,
	localSiteId: string,
	fetchImpl: FetchImpl = fetch,
	getAccessTokenForServer?: GetAccessTokenForServer,
	relayMcpAppProxy?: RelayMcpAppProxy,
): Hono {
	const app = new Hono();

	// Only http servers are proxyable from a browser; index this host's own by name.
	const httpServersByName = new Map(
		(mcpConfig?.servers ?? [])
			.filter((s): s is Extract<typeof s, { transport: "http" }> => s.transport === "http")
			.map((s) => [s.name, s]),
	);

	app.get("/", (c) => {
		const servers = resolveAppServers(db, localSiteId, new Set(httpServersByName.keys())).map(
			(s) => ({
				name: s.name,
				transport: "http" as const,
				// Browser connects here, NOT to the real url; secrets stay server-side.
				// The path carries the owning site so `(site, name)` is unambiguous.
				proxyPath: `/api/mcp-apps/proxy/${encodeURIComponent(s.siteId)}/${encodeURIComponent(s.name)}`,
				tools: s.tools,
			}),
		);
		return c.json({ servers });
	});

	app.all("/proxy/:site/:name", async (c) => {
		// R-MO27b binding: the upstream URL and credential resolve SERVER-SIDE from
		// config, keyed by the `(site, name)` selector this route controls (never a
		// browser-supplied URL). A selector that does not resolve to exactly one
		// known server is rejected BEFORE any fetch.
		const site = c.req.param("site");
		const name = c.req.param("name");

		if (site === localSiteId) {
			// LEG A: this host owns the server. Fetch upstream directly and attach the
			// credential at this edge. Only a server in THIS host's local config is
			// directly fetchable — a browser-supplied `(site, name)` naming a server
			// this host does not configure is rejected before any fetch.
			const server = httpServersByName.get(name);
			if (!server) {
				return c.json({ error: `Unknown MCP App server: ${site}/${name}` }, 404);
			}

			const forwardHeaders = new Headers();
			for (const [key, value] of c.req.raw.headers) {
				if (!HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase())) {
					forwardHeaders.set(key, value);
				}
			}

			if (server.auth?.type === "oauth" && !server.headers) {
				// R-MO27b LEG A: the credential is a bound-owned OAuth token whose custody
				// belongs to this owning host. Attach `Authorization: Bearer` at this fetch
				// edge, sourced through the owner's token store (with its refresh path). A
				// missing bundle / lost grant → 401 naming the pending challenge; NEVER a
				// direct unauthenticated fetch (it would 401-loop upstream).
				if (!getAccessTokenForServer) {
					return c.json(
						{
							error: `MCP App server "${name}" requires OAuth but no token accessor is wired on this host.`,
						},
						503,
					);
				}
				const tokenResult = await getAccessTokenForServer(name);
				if (!tokenResult.ok) {
					const challenge = findChallengeByServer(db, localSiteId, name);
					return c.json(
						{
							error: `MCP App server "${name}" has no live OAuth grant (${tokenResult.error.kind}). Resolve it (bound login --mcp ${name}) before the app can load.`,
							challenge_id: challenge?.id,
							pending: challenge?.status === "pending",
						},
						401,
					);
				}
				forwardHeaders.set("authorization", `Bearer ${tokenResult.value}`);
			} else {
				// Static-headers and no-auth servers keep byte-identical behavior:
				// configured headers are injected here so they never reach the browser.
				for (const [key, value] of Object.entries(server.headers ?? {})) {
					forwardHeaders.set(key, value);
				}
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
						error: `MCP App proxy to "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
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
		}

		// LEG B: a peer owns the server. Relay the MCP call through the owning host
		// (R-UD12 doctrine). Reject a `(site, name)` that no host advertises as
		// app-bearing BEFORE relaying — the owner-side resolution is keyed by name,
		// and an unknown selector must not spend a relay hop.
		const owners = collectServerOwners(db);
		const bindings = collectAppBindings(db);
		if (!owners.get(name)?.has(site) || !bindings.get(name)?.size) {
			return c.json({ error: `Unknown MCP App server: ${site}/${name}` }, 404);
		}
		if (!relayMcpAppProxy) {
			return c.json(
				{
					error: `MCP App server "${name}" is owned by ${site}; this host cannot relay to it (no relay dispatcher wired).`,
				},
				502,
			);
		}

		// Build the relay payload: the JSON-RPC body + an ALLOW-LISTED header subset.
		// Browser cookies and Authorization are NEVER forwarded — the owner mints its
		// own token at its own edge (R-MO27b).
		const relayHeaders: Record<string, string> = {};
		for (const [key, value] of c.req.raw.headers) {
			if (RELAY_FORWARD_REQUEST_HEADERS.has(key.toLowerCase())) {
				relayHeaders[key] = value;
			}
		}
		const method = c.req.method;
		const hasBody = method !== "GET" && method !== "HEAD";
		const bodyBuf = hasBody ? Buffer.from(await c.req.raw.arrayBuffer()) : Buffer.alloc(0);

		let relayed: { status: number; headers: Record<string, string>; body_base64: string };
		try {
			relayed = await relayMcpAppProxy(site, {
				server_name: name,
				method,
				headers: relayHeaders,
				body_base64: bodyBuf.toString("base64"),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// A relay timeout is a distinct, retryable class; everything else is a bad
			// upstream/relay hop (502). The dispatcher tags timeouts in its message.
			const isTimeout = /timeout|timed out/i.test(message);
			return c.json(
				{
					error: `MCP App proxy relay to owner ${site} for "${name}" ${isTimeout ? "timed out" : "failed"}: ${message}`,
				},
				isTimeout ? 504 : 502,
			);
		}

		const responseHeaders = new Headers();
		for (const [key, value] of Object.entries(relayed.headers)) {
			const lower = key.toLowerCase();
			if (!HOP_BY_HOP_RESPONSE_HEADERS.has(lower) && !lower.startsWith("access-control-")) {
				responseHeaders.set(key, value);
			}
		}
		return new Response(
			relayed.body_base64.length > 0 ? Buffer.from(relayed.body_base64, "base64") : null,
			{
				status: relayed.status,
				headers: responseHeaders,
			},
		);
	});

	return app;
}
