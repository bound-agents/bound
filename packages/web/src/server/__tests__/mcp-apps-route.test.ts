import type { Database } from "bun:sqlite";
import { Database as BunDatabase } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { type ChallengeDemand, applySchema, insertRow, raiseChallenge } from "@bound/core";
import type { McpConfig } from "@bound/shared";
import {
	type FetchImpl,
	type GetAccessTokenForServer,
	type RelayMcpAppProxy,
	createMcpAppsRoutes,
} from "../routes/mcp-apps";

const LOCAL_SITE = "site-local";
const PEER_SITE = "site-peer";

/** Seed a host row carrying an app-bearing capability binding + configured-server ownership. */
function seedHost(
	db: Database,
	siteId: string,
	opts: { servers: string[]; capabilities: Record<string, unknown> },
): void {
	insertRow(
		db,
		"hosts",
		{
			site_id: siteId,
			host_name: siteId,
			version: null,
			sync_url: null,
			mcp_servers: JSON.stringify(opts.servers),
			mcp_tools: null,
			models: null,
			online_at: "2026-09-22T00:00:00.000Z",
			modified_at: new Date().toISOString(),
			deleted: 0,
			platforms: null,
			mcp_tool_annotations: null,
			mcp_capabilities: JSON.stringify(opts.capabilities),
			commit_hash: null,
		},
		siteId,
	);
}

/** A local mcp.json with one no-auth http server, one oauth http server, one static-header server. */
function localConfig(): McpConfig {
	return {
		servers: [
			{ name: "docs", transport: "http", url: "https://docs.example/mcp" },
			{
				name: "gh",
				transport: "http",
				url: "https://gh.example/mcp",
				auth: { type: "oauth", scopes: ["repo"] },
			},
			{
				name: "static",
				transport: "http",
				url: "https://static.example/mcp",
				headers: { authorization: "Bearer static-token" },
			},
		],
	} as McpConfig;
}

const APP_BINDING = {
	docs: { tools: [{ name: "search", uiResourceUri: "ui://docs/search" }] },
	gh: { tools: [{ name: "get_me", uiResourceUri: "ui://gh/get-me" }] },
	static: { tools: [{ name: "run", uiResourceUri: "ui://static/run" }] },
};

let db: Database;

beforeEach(() => {
	db = new BunDatabase(":memory:");
	applySchema(db);
	db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", LOCAL_SITE);
});

describe("GET /api/mcp-apps list endpoint", () => {
	it("lists local app-bearing servers with a site-carrying proxyPath", async () => {
		seedHost(db, LOCAL_SITE, {
			servers: ["docs", "gh", "static"],
			capabilities: APP_BINDING,
		});
		const app = createMcpAppsRoutes(db, localConfig(), LOCAL_SITE);
		const res = await app.fetch(new Request("http://localhost/", { method: "GET" }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			servers: Array<{ name: string; proxyPath: string; tools: unknown[] }>;
		};
		const names = body.servers.map((s) => s.name).sort();
		expect(names).toEqual(["docs", "gh", "static"]);
		for (const s of body.servers) {
			expect(s.proxyPath).toBe(
				`/api/mcp-apps/proxy/${encodeURIComponent(LOCAL_SITE)}/${encodeURIComponent(s.name)}`,
			);
		}
	});

	it("includes an app-bearing server configured only on a peer host", async () => {
		// Local host configures nothing; a peer owns `remote-only` and captured its binding.
		seedHost(db, PEER_SITE, {
			servers: ["remote-only"],
			capabilities: { "remote-only": { tools: [{ name: "t", uiResourceUri: "ui://remote/t" }] } },
		});
		const app = createMcpAppsRoutes(db, { servers: [] } as McpConfig, LOCAL_SITE);
		const res = await app.fetch(new Request("http://localhost/", { method: "GET" }));
		const body = (await res.json()) as {
			servers: Array<{ name: string; proxyPath: string }>;
		};
		expect(body.servers).toHaveLength(1);
		expect(body.servers[0].name).toBe("remote-only");
		expect(body.servers[0].proxyPath).toBe(
			`/api/mcp-apps/proxy/${encodeURIComponent(PEER_SITE)}/remote-only`,
		);
	});
});

describe("ALL /proxy/:site/:name — LEG A (local owner)", () => {
	it("no-auth local server: forwards unchanged, no Authorization added", async () => {
		seedHost(db, LOCAL_SITE, { servers: ["docs"], capabilities: APP_BINDING });
		let sawAuth: string | null = "unset";
		const fetchImpl: FetchImpl = async (_url, init) => {
			sawAuth = new Headers(init?.headers).get("authorization");
			return new Response('{"ok":true}', { status: 200 });
		};
		const app = createMcpAppsRoutes(db, localConfig(), LOCAL_SITE, fetchImpl);
		const res = await app.fetch(
			new Request(`http://localhost/proxy/${LOCAL_SITE}/docs`, {
				method: "POST",
				body: '{"jsonrpc":"2.0"}',
			}),
		);
		expect(res.status).toBe(200);
		expect(sawAuth).toBeNull();
	});

	it("static-header local server: injects the configured header byte-identically", async () => {
		seedHost(db, LOCAL_SITE, { servers: ["static"], capabilities: APP_BINDING });
		let sawAuth: string | null = null;
		const fetchImpl: FetchImpl = async (_url, init) => {
			sawAuth = new Headers(init?.headers).get("authorization");
			return new Response("{}", { status: 200 });
		};
		const app = createMcpAppsRoutes(db, localConfig(), LOCAL_SITE, fetchImpl);
		await app.fetch(
			new Request(`http://localhost/proxy/${LOCAL_SITE}/static`, {
				method: "POST",
				body: "{}",
			}),
		);
		expect(sawAuth).toBe("Bearer static-token");
	});

	it("oauth local server with a token: attaches the owner's Bearer from the store", async () => {
		seedHost(db, LOCAL_SITE, { servers: ["gh"], capabilities: APP_BINDING });
		let sawAuth: string | null = null;
		const fetchImpl: FetchImpl = async (_url, init) => {
			sawAuth = new Headers(init?.headers).get("authorization");
			return new Response("{}", { status: 200 });
		};
		const getToken: GetAccessTokenForServer = async () => ({
			ok: true,
			value: "live-access-token",
		});
		const app = createMcpAppsRoutes(db, localConfig(), LOCAL_SITE, fetchImpl, getToken);
		const res = await app.fetch(
			new Request(`http://localhost/proxy/${LOCAL_SITE}/gh`, { method: "POST", body: "{}" }),
		);
		expect(res.status).toBe(200);
		expect(sawAuth).toBe("Bearer live-access-token");
	});

	it("oauth local server with no grant: 401 naming the pending challenge, never fetches", async () => {
		seedHost(db, LOCAL_SITE, { servers: ["gh"], capabilities: APP_BINDING });
		const demand: ChallengeDemand = {
			serverName: "gh",
			owningSiteId: LOCAL_SITE,
			serverUrl: "https://gh.example/mcp",
			scopeDemand: "repo",
			grantedScopes: "",
		};
		raiseChallenge(db, demand, LOCAL_SITE);
		let fetched = false;
		const fetchImpl: FetchImpl = async () => {
			fetched = true;
			return new Response("{}", { status: 200 });
		};
		const getToken: GetAccessTokenForServer = async () => ({
			ok: false,
			error: { kind: "no_bundle" },
		});
		const app = createMcpAppsRoutes(db, localConfig(), LOCAL_SITE, fetchImpl, getToken);
		const res = await app.fetch(
			new Request(`http://localhost/proxy/${LOCAL_SITE}/gh`, { method: "POST", body: "{}" }),
		);
		expect(res.status).toBe(401);
		expect(fetched).toBe(false);
		const body = (await res.json()) as { challenge_id?: string; pending?: boolean };
		expect(body.challenge_id).toBeTruthy();
		expect(body.pending).toBe(true);
	});

	it("unknown local selector: 404 before any fetch", async () => {
		seedHost(db, LOCAL_SITE, { servers: ["docs"], capabilities: APP_BINDING });
		let fetched = false;
		const fetchImpl: FetchImpl = async () => {
			fetched = true;
			return new Response("{}", { status: 200 });
		};
		const app = createMcpAppsRoutes(db, localConfig(), LOCAL_SITE, fetchImpl);
		const res = await app.fetch(
			new Request(`http://localhost/proxy/${LOCAL_SITE}/nonexistent`, {
				method: "POST",
				body: "{}",
			}),
		);
		expect(res.status).toBe(404);
		expect(fetched).toBe(false);
	});
});

describe("ALL /proxy/:site/:name — LEG B (peer owner relay)", () => {
	it("relays to the owning host and returns the relayed response", async () => {
		seedHost(db, PEER_SITE, {
			servers: ["remote"],
			capabilities: { remote: { tools: [{ name: "t", uiResourceUri: "ui://remote/t" }] } },
		});
		let relayedTo: string | null = null;
		let relayedPayload: { server_name: string; headers: Record<string, string> } | null = null;
		const relay: RelayMcpAppProxy = async (ownerSiteId, payload) => {
			relayedTo = ownerSiteId;
			relayedPayload = payload;
			return {
				status: 200,
				headers: { "content-type": "application/json" },
				body_base64: Buffer.from('{"relayed":true}').toString("base64"),
			};
		};
		const app = createMcpAppsRoutes(
			db,
			{ servers: [] } as McpConfig,
			LOCAL_SITE,
			undefined,
			undefined,
			relay,
		);
		const res = await app.fetch(
			new Request(`http://localhost/proxy/${PEER_SITE}/remote`, {
				method: "POST",
				headers: { "content-type": "application/json", cookie: "session=secret" },
				body: '{"jsonrpc":"2.0"}',
			}),
		);
		expect(res.status).toBe(200);
		expect(relayedTo).toBe(PEER_SITE);
		expect(relayedPayload?.server_name).toBe("remote");
		// Browser cookie/authorization NEVER forwarded; content-type IS forwarded.
		expect(relayedPayload?.headers.cookie).toBeUndefined();
		expect(relayedPayload?.headers.authorization).toBeUndefined();
		expect(relayedPayload?.headers["content-type"]).toBe("application/json");
		expect(await res.text()).toBe('{"relayed":true}');
	});

	it("browser Authorization header is never relayed to the owner", async () => {
		seedHost(db, PEER_SITE, {
			servers: ["remote"],
			capabilities: { remote: { tools: [{ name: "t", uiResourceUri: "ui://remote/t" }] } },
		});
		let relayedHeaders: Record<string, string> = {};
		const relay: RelayMcpAppProxy = async (_owner, payload) => {
			relayedHeaders = payload.headers;
			return { status: 200, headers: {}, body_base64: "" };
		};
		const app = createMcpAppsRoutes(
			db,
			{ servers: [] } as McpConfig,
			LOCAL_SITE,
			undefined,
			undefined,
			relay,
		);
		await app.fetch(
			new Request(`http://localhost/proxy/${PEER_SITE}/remote`, {
				method: "POST",
				headers: { authorization: "Bearer browser-forged", "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(relayedHeaders.authorization).toBeUndefined();
	});

	it("ambiguous / unknown peer selector: 404 before relaying", async () => {
		seedHost(db, PEER_SITE, {
			servers: ["remote"],
			capabilities: { remote: { tools: [{ name: "t", uiResourceUri: "ui://remote/t" }] } },
		});
		let relayed = false;
		const relay: RelayMcpAppProxy = async () => {
			relayed = true;
			return { status: 200, headers: {}, body_base64: "" };
		};
		const app = createMcpAppsRoutes(
			db,
			{ servers: [] } as McpConfig,
			LOCAL_SITE,
			undefined,
			undefined,
			relay,
		);
		// A site that does not own this server → unknown selector.
		const res = await app.fetch(
			new Request("http://localhost/proxy/site-nobody/remote", { method: "POST", body: "{}" }),
		);
		expect(res.status).toBe(404);
		expect(relayed).toBe(false);
	});

	it("relay timeout: 504 with a clear body", async () => {
		seedHost(db, PEER_SITE, {
			servers: ["remote"],
			capabilities: { remote: { tools: [{ name: "t", uiResourceUri: "ui://remote/t" }] } },
		});
		const relay: RelayMcpAppProxy = async () => {
			throw new Error("Timeout waiting for mcp_app_proxy response from site-peer");
		};
		const app = createMcpAppsRoutes(
			db,
			{ servers: [] } as McpConfig,
			LOCAL_SITE,
			undefined,
			undefined,
			relay,
		);
		const res = await app.fetch(
			new Request(`http://localhost/proxy/${PEER_SITE}/remote`, { method: "POST", body: "{}" }),
		);
		expect(res.status).toBe(504);
	});
});
