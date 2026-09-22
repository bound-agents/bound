import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import type { McpConfig } from "@bound/shared";
import { type GetAccessTokenForServer, createMcpAppsRoutes } from "../mcp-apps";

const LOCAL_SITE = "site-local";

/**
 * Seed a hosts row carrying an `mcp_capabilities` inventory. The capture
 * (updateHostMCPInfo) records per-tool `uiResourceUri` bindings for UI-bearing
 * tools; the route reads them to decide which servers are MCP-App-bearing.
 * `mcp_servers` records the set of server names that host configures — the
 * ownership signal the route joins for location transparency (R-MO27b).
 */
function seedHost(
	db: Database,
	siteId: string,
	hostName: string,
	capabilities: Record<string, unknown>,
): void {
	insertRow(
		db,
		"hosts",
		{
			site_id: siteId,
			host_name: hostName,
			version: null,
			sync_url: null,
			mcp_servers: JSON.stringify(Object.keys(capabilities)),
			mcp_tools: null,
			models: null,
			online_at: "2026-06-13T00:00:00.000Z",
			modified_at: new Date().toISOString(),
			deleted: 0,
			platforms: null,
			mcp_tool_annotations: null,
			mcp_capabilities: JSON.stringify(capabilities),
			commit_hash: null,
		},
		siteId,
	);
}

describe("createMcpAppsRoutes GET / (app-bearing servers from mcp.json)", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	it("returns only http servers that carry an MCP-App tool binding, with the bindings", async () => {
		seedHost(db, LOCAL_SITE, "alpha", {
			github: {
				serverInfo: { name: "github-mcp-server" },
				tools: [
					{ name: "get_me", uiResourceUri: "ui://github-mcp-server/get-me" },
					{ name: "list_issues" },
				],
			},
			"aws-knowledge": {
				serverInfo: { name: "aws-knowledge" },
				tools: [{ name: "search" }],
			},
		});

		const mcpConfig: McpConfig = {
			servers: [
				{
					name: "github",
					transport: "http",
					url: "https://api.githubcopilot.com/mcp/x/all/readonly/insiders",
					headers: { Authorization: "Bearer secret" },
				},
				// http but no UI binding in the inventory -> excluded
				{ name: "aws-knowledge", transport: "http", url: "https://knowledge.example/mcp" },
				// stdio -> a browser can't reach it -> excluded
				{ name: "metacog", transport: "stdio", command: "metacog-bin" },
			],
		};

		const app = createMcpAppsRoutes(db, mcpConfig, LOCAL_SITE);
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			servers: Array<{
				name: string;
				transport: string;
				proxyPath: string;
				tools: Array<{ name: string; uiResourceUri: string }>;
				url?: string;
				headers?: unknown;
			}>;
		};

		expect(body.servers).toHaveLength(1);
		expect(body.servers[0]).toEqual({
			name: "github",
			transport: "http",
			// The proxyPath carries the owning site_id (R-MO27b).
			proxyPath: `/api/mcp-apps/proxy/${LOCAL_SITE}/github`,
			tools: [{ name: "get_me", uiResourceUri: "ui://github-mcp-server/get-me" }],
		});
		// Secrets and the real upstream URL never reach the browser.
		expect(body.servers[0].url).toBeUndefined();
		expect(body.servers[0].headers).toBeUndefined();
	});

	it("unions tool bindings across hosts (a server is app-bearing if any host saw the binding)", async () => {
		// alpha's capture predates the /insiders flip — no binding yet.
		seedHost(db, LOCAL_SITE, "alpha", {
			github: { serverInfo: { name: "github-mcp-server" }, tools: [{ name: "get_me" }] },
		});
		// bravo captured the binding.
		seedHost(db, "site-b", "bravo", {
			github: {
				serverInfo: { name: "github-mcp-server" },
				tools: [{ name: "get_me", uiResourceUri: "ui://github-mcp-server/get-me" }],
			},
		});

		const mcpConfig: McpConfig = {
			servers: [{ name: "github", transport: "http", url: "https://example/mcp" }],
		};

		const body = (await (
			await createMcpAppsRoutes(db, mcpConfig, LOCAL_SITE).request("/")
		).json()) as {
			servers: Array<{ name: string; tools: Array<{ name: string; uiResourceUri: string }> }>;
		};
		expect(body.servers).toHaveLength(1);
		expect(body.servers[0].tools).toEqual([
			{ name: "get_me", uiResourceUri: "ui://github-mcp-server/get-me" },
		]);
	});

	it("percent-encodes server names with unsafe path characters", async () => {
		seedHost(db, LOCAL_SITE, "alpha", {
			"my server/v2": {
				serverInfo: {},
				tools: [{ name: "render", uiResourceUri: "ui://x/render" }],
			},
		});
		const mcpConfig: McpConfig = {
			servers: [{ name: "my server/v2", transport: "http", url: "https://example.com/mcp" }],
		};
		const body = (await (
			await createMcpAppsRoutes(db, mcpConfig, LOCAL_SITE).request("/")
		).json()) as {
			servers: Array<{ proxyPath: string }>;
		};
		expect(body.servers[0].proxyPath).toBe(`/api/mcp-apps/proxy/${LOCAL_SITE}/my%20server%2Fv2`);
	});

	it("includes an app-bearing server configured only on a peer host, carrying the peer site", async () => {
		seedHost(db, "site-peer", "peer", {
			"remote-only": { serverInfo: {}, tools: [{ name: "t", uiResourceUri: "ui://remote/t" }] },
		});
		const body = (await (
			await createMcpAppsRoutes(db, { servers: [] } as McpConfig, LOCAL_SITE).request("/")
		).json()) as {
			servers: Array<{ name: string; proxyPath: string }>;
		};
		expect(body.servers).toHaveLength(1);
		expect(body.servers[0].name).toBe("remote-only");
		expect(body.servers[0].proxyPath).toBe("/api/mcp-apps/proxy/site-peer/remote-only");
	});

	it("returns an empty server list when mcp.json is absent", async () => {
		const res = await createMcpAppsRoutes(db, null, LOCAL_SITE).request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { servers: unknown[] };
		expect(body.servers).toEqual([]);
	});

	it("returns an empty server list when no configured server is app-bearing", async () => {
		seedHost(db, LOCAL_SITE, "alpha", {
			github: { serverInfo: {}, tools: [{ name: "get_me" }] },
		});
		const mcpConfig: McpConfig = {
			servers: [{ name: "github", transport: "http", url: "https://example/mcp" }],
		};
		const body = (await (
			await createMcpAppsRoutes(db, mcpConfig, LOCAL_SITE).request("/")
		).json()) as {
			servers: unknown[];
		};
		expect(body.servers).toEqual([]);
	});
});

describe("createMcpAppsRoutes ALL /proxy/:site/:name (local owner, LEG A)", () => {
	let db: Database;
	const mcpConfig: McpConfig = {
		servers: [
			{
				name: "github",
				transport: "http",
				url: "https://api.githubcopilot.com/mcp",
				headers: { Authorization: "Bearer secret-token" },
			},
			// stdio servers are not proxyable and must not be reachable through the proxy.
			{ name: "metacog", transport: "stdio", command: "metacog-bin" },
		],
	};

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		seedHost(db, LOCAL_SITE, "alpha", {
			github: {
				serverInfo: { name: "github-mcp-server" },
				tools: [{ name: "get_me", uiResourceUri: "ui://github-mcp-server/get-me" }],
			},
			linear: { serverInfo: {}, tools: [{ name: "t", uiResourceUri: "ui://linear/t" }] },
		});
	});

	it("forwards the request to the real upstream URL and injects configured headers", async () => {
		let seen: { url: string; method: string; auth: string | null; body: string } | undefined;
		const app = createMcpAppsRoutes(db, mcpConfig, LOCAL_SITE, async (url, init) => {
			seen = {
				url: String(url),
				method: init?.method ?? "GET",
				auth: new Headers(init?.headers).get("authorization"),
				body: init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "",
			};
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
				status: 200,
				headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
			});
		});

		const res = await app.request(`/proxy/${LOCAL_SITE}/github`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});

		expect(seen?.url).toBe("https://api.githubcopilot.com/mcp");
		expect(seen?.method).toBe("POST");
		expect(seen?.auth).toBe("Bearer secret-token");
		expect(seen?.body).toContain("initialize");
		expect(res.status).toBe(200);
		expect(res.headers.get("mcp-session-id")).toBe("sess-1");
	});

	it("strips upstream CORS and hop-by-hop response headers", async () => {
		const app = createMcpAppsRoutes(db, mcpConfig, LOCAL_SITE, async () => {
			return new Response("ok", {
				status: 200,
				headers: {
					"content-type": "text/plain",
					"access-control-allow-origin": "*",
					"content-encoding": "gzip",
				},
			});
		});
		const res = await app.request(`/proxy/${LOCAL_SITE}/github`, { method: "POST" });
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
		expect(res.headers.get("content-encoding")).toBeNull();
		expect(res.headers.get("content-type")).toBe("text/plain");
	});

	it("404s an unknown server name", async () => {
		const res = await createMcpAppsRoutes(db, mcpConfig, LOCAL_SITE).request(
			`/proxy/${LOCAL_SITE}/nope`,
			{ method: "POST" },
		);
		expect(res.status).toBe(404);
	});

	it("404s a stdio server (not proxyable)", async () => {
		const res = await createMcpAppsRoutes(db, mcpConfig, LOCAL_SITE).request(
			`/proxy/${LOCAL_SITE}/metacog`,
			{ method: "POST" },
		);
		expect(res.status).toBe(404);
	});

	it("502s when the upstream fetch throws", async () => {
		const app = createMcpAppsRoutes(db, mcpConfig, LOCAL_SITE, async () => {
			throw new Error("ECONNREFUSED");
		});
		const res = await app.request(`/proxy/${LOCAL_SITE}/github`, { method: "POST" });
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("ECONNREFUSED");
	});

	it("attaches the owner's OAuth token when the accessor holds a live grant", async () => {
		// An `auth: { type: "oauth" }` entry whose token lives in the owner's store:
		// the proxy attaches Authorization: Bearer at this fetch edge (LEG A).
		let seenAuth: string | null = null;
		const authConfig: McpConfig = {
			servers: [
				{
					name: "linear",
					transport: "http",
					url: "https://mcp.linear.app/mcp",
					auth: { type: "oauth" },
				},
			],
		};
		const getToken: GetAccessTokenForServer = async () => ({ ok: true, value: "owner-token" });
		const app = createMcpAppsRoutes(
			db,
			authConfig,
			LOCAL_SITE,
			async (_url, init) => {
				seenAuth = new Headers(init?.headers).get("authorization");
				return new Response("ok", { status: 200 });
			},
			getToken,
		);
		const res = await app.request(`/proxy/${LOCAL_SITE}/linear`, { method: "POST" });
		expect(res.status).toBe(200);
		expect(seenAuth).toBe("Bearer owner-token");
	});

	it("401s an OAuth-bearing server with no live grant, never fetching unauthenticated", async () => {
		let fetched = false;
		const authConfig: McpConfig = {
			servers: [
				{
					name: "linear",
					transport: "http",
					url: "https://mcp.linear.app/mcp",
					auth: { type: "oauth" },
				},
			],
		};
		const getToken: GetAccessTokenForServer = async () => ({
			ok: false,
			error: { kind: "no_bundle" },
		});
		const app = createMcpAppsRoutes(
			db,
			authConfig,
			LOCAL_SITE,
			async () => {
				fetched = true;
				return new Response("ok", { status: 200 });
			},
			getToken,
		);
		const res = await app.request(`/proxy/${LOCAL_SITE}/linear`, { method: "POST" });
		expect(res.status).toBe(401);
		expect(fetched).toBe(false);
	});

	it("proxies an OAuth-bearing server that DOES carry static headers (co-located owner)", async () => {
		// A statically-headered entry has a credential the owner injects here — the
		// co-location case R-MO27b permits. It proxies normally with the static header.
		let seenAuth: string | null = null;
		const authConfig: McpConfig = {
			servers: [
				{
					name: "linear",
					transport: "http",
					url: "https://mcp.linear.app/mcp",
					auth: { type: "oauth" },
					headers: { Authorization: "Bearer owner-token" },
				},
			],
		};
		const app = createMcpAppsRoutes(db, authConfig, LOCAL_SITE, async (_url, init) => {
			seenAuth = new Headers(init?.headers).get("authorization");
			return new Response("ok", { status: 200 });
		});
		const res = await app.request(`/proxy/${LOCAL_SITE}/linear`, { method: "POST" });
		expect(res.status).toBe(200);
		expect(seenAuth).toBe("Bearer owner-token");
	});
});
