import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type CoLocationServerConfig,
	buildOwnerRefreshFn,
	getCoLocationAccessToken,
	handleOwnerMcpAppProxy,
} from "../co-location";
import { type McpTokenBundle, McpTokenStore } from "../token-store";

/**
 * Co-location owner-side OAuth (R-MO27b LEG A + LEG B). Discovery, refresh, and
 * the proxy fetch are all driven through a stubbed fetch — no network. The
 * token store is a real on-disk McpTokenStore under os.tmpdir().
 */

const SERVER_URL = "https://mcp.example.com";
const AS_ORIGIN = "https://as.example.com";

let dir: string;
let store: McpTokenStore;

beforeEach(() => {
	dir = join(tmpdir(), `co-location-${randomBytes(4).toString("hex")}`);
	store = new McpTokenStore(join(dir, "mcp-auth.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function ownerConfig(overrides: Partial<CoLocationServerConfig> = {}): CoLocationServerConfig {
	return {
		name: "srv",
		url: SERVER_URL,
		scopes: ["read"],
		clientId: "owner-client",
		clientSecret: "owner-secret",
		...overrides,
	};
}

/** Fetch stub serving PRM + AS metadata + a token endpoint for the refresh. */
function makeFetchStub(
	opts: {
		tokenResponse?: Response | (() => Response);
		prmThrows?: boolean;
		asThrows?: boolean;
		proxyResponse?: () => Response;
		onProxyRequest?: (url: string, init: RequestInit) => void;
	} = {},
): typeof globalThis.fetch {
	return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.includes("/.well-known/oauth-protected-resource")) {
			if (opts.prmThrows) throw new Error("PRM unreachable");
			return Response.json({ resource: SERVER_URL, authorization_servers: [AS_ORIGIN] });
		}
		if (
			url.includes("/.well-known/oauth-authorization-server") ||
			url.includes("/.well-known/openid-configuration")
		) {
			if (opts.asThrows) throw new Error("AS metadata unreachable");
			// Issuer must match the discovery seed origin (RFC 8414 §3.3). The seed is
			// the PRM-advertised AS origin on the happy path, or config.url when PRM
			// discovery throws — derive it from the request so both seeds validate.
			const origin = new URL(url).origin;
			return Response.json({
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
			});
		}
		if (url.includes("/token")) {
			if (opts.tokenResponse) {
				return typeof opts.tokenResponse === "function" ? opts.tokenResponse() : opts.tokenResponse;
			}
			return Response.json({
				access_token: "rotated-at",
				token_type: "Bearer",
				refresh_token: "rotated-rt",
				expires_in: 3600,
				scope: "read",
			});
		}
		// Treat everything else as the upstream MCP endpoint (proxy fetch).
		opts.onProxyRequest?.(url, init ?? {});
		if (opts.proxyResponse) return opts.proxyResponse();
		return new Response("unexpected", { status: 500 });
	}) as typeof globalThis.fetch;
}

async function seedExpiredBundle(serverName: string): Promise<void> {
	const bundle: McpTokenBundle = {
		accessToken: "stale-at",
		refreshToken: "rt-123",
		scopes: "read",
		// Already past the refresh skew, so getValidAccessToken forces a refresh.
		accessTokenExpiresAt: Date.now() - 1_000,
		issuer: AS_ORIGIN,
	};
	await store.saveBundle(serverName, bundle);
}

async function seedLiveBundle(serverName: string): Promise<void> {
	const bundle: McpTokenBundle = {
		accessToken: "live-at",
		refreshToken: "rt-123",
		scopes: "read",
		accessTokenExpiresAt: Date.now() + 3_600_000,
		issuer: AS_ORIGIN,
	};
	await store.saveBundle(serverName, bundle);
}

describe("buildOwnerRefreshFn", () => {
	it("refreshes against the owner's own discovered AS and rotates the bundle", async () => {
		const refresh = buildOwnerRefreshFn("srv", () => ownerConfig(), makeFetchStub());
		const result = await refresh({
			accessToken: "stale",
			refreshToken: "rt-123",
			scopes: "read",
			accessTokenExpiresAt: 0,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.accessToken).toBe("rotated-at");
			expect(result.value.issuer).toBe(AS_ORIGIN);
		}
	});

	it("returns transient when the server has no owner config", async () => {
		const refresh = buildOwnerRefreshFn("srv", () => null, makeFetchStub());
		const result = await refresh({
			accessToken: "x",
			refreshToken: "rt-123",
			scopes: "read",
			accessTokenExpiresAt: 0,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("transient");
	});

	it("returns lost_grant when there is no refresh token to present", async () => {
		const refresh = buildOwnerRefreshFn("srv", () => ownerConfig(), makeFetchStub());
		const result = await refresh({ accessToken: "x", scopes: "read", accessTokenExpiresAt: 0 });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("lost_grant");
			if (result.error.kind === "lost_grant") expect(result.error.error).toBe("invalid_grant");
		}
	});

	it("falls back to the config URL as AS seed when PRM discovery throws", async () => {
		// PRM throws → asSeed falls back to config.url; AS metadata still resolves.
		const refresh = buildOwnerRefreshFn(
			"srv",
			() => ownerConfig(),
			makeFetchStub({ prmThrows: true }),
		);
		const result = await refresh({
			accessToken: "stale",
			refreshToken: "rt-123",
			scopes: "read",
			accessTokenExpiresAt: 0,
		});
		expect(result.ok).toBe(true);
	});

	it("returns transient when AS metadata discovery fails", async () => {
		const refresh = buildOwnerRefreshFn(
			"srv",
			() => ownerConfig(),
			makeFetchStub({ asThrows: true }),
		);
		const result = await refresh({
			accessToken: "stale",
			refreshToken: "rt-123",
			scopes: "read",
			accessTokenExpiresAt: 0,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("transient");
	});

	it("returns transient when no client_id is configured", async () => {
		const refresh = buildOwnerRefreshFn(
			"srv",
			() => ownerConfig({ clientId: undefined, clientSecret: undefined }),
			makeFetchStub(),
		);
		const result = await refresh({
			accessToken: "stale",
			refreshToken: "rt-123",
			scopes: "read",
			accessTokenExpiresAt: 0,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("transient");
	});

	it("classifies a terminal token-endpoint error as lost_grant", async () => {
		const refresh = buildOwnerRefreshFn(
			"srv",
			() => ownerConfig(),
			makeFetchStub({
				tokenResponse: () => Response.json({ error: "invalid_grant" }, { status: 400 }),
			}),
		);
		const result = await refresh({
			accessToken: "stale",
			refreshToken: "rt-123",
			scopes: "read",
			accessTokenExpiresAt: 0,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("lost_grant");
			if (result.error.kind === "lost_grant") expect(result.error.error).toBe("invalid_grant");
		}
	});

	it("classifies a 5xx token-endpoint error as transient", async () => {
		const refresh = buildOwnerRefreshFn(
			"srv",
			() => ownerConfig(),
			makeFetchStub({
				tokenResponse: () => Response.json({ error: "server_error" }, { status: 503 }),
			}),
		);
		const result = await refresh({
			accessToken: "stale",
			refreshToken: "rt-123",
			scopes: "read",
			accessTokenExpiresAt: 0,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("transient");
	});
});

describe("getCoLocationAccessToken", () => {
	it("returns not_oauth when the server is not oauth-configured", async () => {
		const result = await getCoLocationAccessToken(store, "srv", () => null, makeFetchStub());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("not_oauth");
	});

	it("returns a live token without refresh when the bundle is unexpired", async () => {
		await seedLiveBundle("srv");
		const result = await getCoLocationAccessToken(
			store,
			"srv",
			() => ownerConfig(),
			makeFetchStub(),
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe("live-at");
	});

	it("refreshes an expired bundle and returns the rotated token", async () => {
		await seedExpiredBundle("srv");
		const result = await getCoLocationAccessToken(
			store,
			"srv",
			() => ownerConfig(),
			makeFetchStub(),
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe("rotated-at");
	});

	it("surfaces no_bundle when oauth-configured but no token is stored", async () => {
		const result = await getCoLocationAccessToken(
			store,
			"srv",
			() => ownerConfig(),
			makeFetchStub(),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("no_bundle");
	});
});

describe("handleOwnerMcpAppProxy", () => {
	const proxyPayload = (overrides: Partial<Parameters<typeof handleOwnerMcpAppProxy>[2]> = {}) => ({
		server_name: "srv",
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body_base64: Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "ping" })).toString("base64"),
		...overrides,
	});

	it("502s for a server this owner does not configure", async () => {
		const result = await handleOwnerMcpAppProxy(store, () => null, proxyPayload(), makeFetchStub());
		expect(result.status).toBe(502);
		expect(result.body_base64).toBe("");
	});

	it("401s when there is no live grant (no_bundle), without direct-fetching", async () => {
		let upstreamCalls = 0;
		const result = await handleOwnerMcpAppProxy(
			store,
			() => ownerConfig(),
			proxyPayload(),
			makeFetchStub({ onProxyRequest: () => upstreamCalls++ }),
		);
		expect(result.status).toBe(401);
		expect(upstreamCalls).toBe(0);
	});

	it("attaches the owner's bearer token and relays the upstream response", async () => {
		await seedLiveBundle("srv");
		let seenAuth: string | undefined;
		let seenMethod: string | undefined;
		const result = await handleOwnerMcpAppProxy(
			store,
			() => ownerConfig(),
			proxyPayload(),
			makeFetchStub({
				onProxyRequest: (_url, init) => {
					const headers = new Headers(init.headers as HeadersInit);
					seenAuth = headers.get("authorization") ?? undefined;
					seenMethod = init.method;
				},
				proxyResponse: () =>
					new Response(JSON.stringify({ jsonrpc: "2.0", result: "pong" }), {
						status: 200,
						headers: {
							"content-type": "application/json",
							// Hop-by-hop + CORS headers must be stripped from the output.
							"content-length": "42",
							"transfer-encoding": "chunked",
							"access-control-allow-origin": "*",
						},
					}),
			}),
		);
		expect(result.status).toBe(200);
		expect(seenAuth).toBe("Bearer live-at");
		expect(seenMethod).toBe("POST");
		expect(Buffer.from(result.body_base64, "base64").toString()).toContain("pong");
		// Stripped headers must not appear in the relayed output.
		const outKeys = Object.keys(result.headers).map((k) => k.toLowerCase());
		expect(outKeys).toContain("content-type");
		expect(outKeys).not.toContain("content-length");
		expect(outKeys).not.toContain("transfer-encoding");
		expect(outKeys.some((k) => k.startsWith("access-control-"))).toBe(false);
	});

	it("does not send a request body for a GET method", async () => {
		await seedLiveBundle("srv");
		let hadBody = false;
		const result = await handleOwnerMcpAppProxy(
			store,
			() => ownerConfig(),
			proxyPayload({ method: "GET" }),
			makeFetchStub({
				onProxyRequest: (_url, init) => {
					hadBody = init.body !== undefined && init.body !== null;
				},
				proxyResponse: () => new Response("ok", { status: 200 }),
			}),
		);
		expect(result.status).toBe(200);
		expect(hadBody).toBe(false);
	});
});
