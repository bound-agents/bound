import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applySchema,
	challengeId,
	findChallengeById,
	markResolved,
	raiseChallenge,
} from "@bound/core";
import { OAuthError, OAuthErrorCode, auth } from "@modelcontextprotocol/client";
import {
	AuthChallengeRaisedError,
	McpOAuthProvider,
	endpointForLog,
	oauthLogFields,
} from "../oauth-provider";
import { RaiseDebouncer } from "../raise";
import { McpTokenStore } from "../token-store";

const SITE = "site-owner";
let dir: string;

// A path whose parent is a regular file: mkdir and rename under it fail on
// every OS. /dev/null/nope only fails on POSIX; on Windows it is writable.
function fileAsParentDir(): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "not-a-dir");
	writeFileSync(file, "");
	return file;
}
let store: McpTokenStore;
let db: Database;

beforeEach(() => {
	dir = join(tmpdir(), `mcp-oauth-${randomBytes(4).toString("hex")}`);
	store = new McpTokenStore(join(dir, "mcp-auth.json"));
	db = new Database(":memory:");
	applySchema(db);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function provider(): McpOAuthProvider {
	return new McpOAuthProvider(
		db,
		store,
		{ name: "srv", url: "https://mcp.example/mcp", scopes: ["read", "write"] },
		SITE,
		new RaiseDebouncer(),
	);
}

describe("McpOAuthProvider raise-instead-of-browser (R-MO10)", () => {
	it("redirectToAuthorization raises a pending challenge and throws, never opening a browser", () => {
		const p = provider();
		p.noteObservedChallenge(
			'Bearer scope="read write", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
		);
		expect(() => p.redirectToAuthorization(new URL("https://as.example/authorize"))).toThrow(
			AuthChallengeRaisedError,
		);
		const id = challengeId(SITE, "srv");
		const row = findChallengeById(db, id);
		expect(row?.status).toBe("pending");
		expect(row?.scope_demand).toBe("read write");
		expect(row?.resource_metadata_hint).toContain("oauth-protected-resource");
	});

	it("carries the challenge id and outcome text on the thrown error", () => {
		const p = provider();
		try {
			p.redirectToAuthorization(new URL("https://as.example/authorize"));
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(AuthChallengeRaisedError);
			const err = e as AuthChallengeRaisedError;
			expect(err.challengeId).toBe(challengeId(SITE, "srv"));
			expect(err.outcomeText).toContain("bound login --challenge");
		}
	});
});

describe("McpOAuthProvider token custody", () => {
	it("tokens() returns undefined with no stored bundle", () => {
		expect(provider().tokens()).toBeUndefined();
	});

	it("saveTokens persists a bundle the store can read back", async () => {
		const p = provider();
		await p.saveTokens({
			access_token: "at-1",
			token_type: "Bearer",
			refresh_token: "rt-1",
			scope: "read",
			issuer: "https://as.example",
		});
		const t = p.tokens();
		expect(t?.access_token).toBe("at-1");
		expect(t?.issuer).toBe("https://as.example");
	});

	it("saveTokens propagates a persistence failure (R-MO23)", async () => {
		const bad = new McpOAuthProvider(
			db,
			new McpTokenStore(join(fileAsParentDir(), "mcp-auth.json")),
			{ name: "srv", url: "https://mcp.example/mcp" },
			SITE,
			new RaiseDebouncer(),
		);
		await expect(
			bad.saveTokens({ access_token: "at", token_type: "Bearer" }),
		).rejects.toBeDefined();
	});
});

describe("McpOAuthProvider client identity (R-MO25)", () => {
	it("returns a config-declared client_id directly (ladder rung 1)", () => {
		const p = new McpOAuthProvider(
			db,
			store,
			{ name: "srv", url: "https://mcp.example/mcp", clientId: "cid-config" },
			SITE,
			new RaiseDebouncer(),
		);
		expect(p.clientInformation()?.client_id).toBe("cid-config");
	});

	it("falls back to a cached DCR registration keyed by issuer (ladder rung 2)", async () => {
		await store.saveRegistration("https://as.example", { clientId: "cid-dcr" });
		const p = provider();
		expect(p.clientInformation({ issuer: "https://as.example" })?.client_id).toBe("cid-dcr");
		expect(p.clientInformation({ issuer: "https://unknown" })).toBeUndefined();
	});

	it("advertises a public client in clientMetadata", () => {
		const md = provider().clientMetadata;
		expect(md.token_endpoint_auth_method).toBe("none");
		expect(md.redirect_uris[0]).toContain("/oauth/mcp/callback");
	});
});

describe("McpOAuthProvider PKCE/discovery persistence (R-MO18/R-MO23)", () => {
	it("round-trips the code verifier through the store", async () => {
		const p = provider();
		await p.saveCodeVerifier("verifier-abc");
		expect(p.codeVerifier()).toBe("verifier-abc");
	});

	it("round-trips discovery state through the store", async () => {
		const p = provider();
		await p.saveDiscoveryState({ issuer: "https://as.example" });
		expect(p.discoveryState()).toEqual({ issuer: "https://as.example" });
	});
});

describe("McpOAuthProvider terminal refresh rejection (#299)", () => {
	const AS = "https://as.example";
	const TOKEN_URL = `${AS}/token`;

	async function seedResolvedGrant(): Promise<void> {
		await store.saveBundle("srv", {
			accessToken: "old-at",
			refreshToken: "old-rt",
			scopes: "read write",
			accessTokenExpiresAt: 0,
			issuer: AS,
		});
		await store.saveDiscoveryState("srv", {
			authorizationServerUrl: AS,
			resourceMetadata: {
				resource: "https://mcp.example/mcp",
				authorization_servers: [AS],
			},
			authorizationServerMetadata: {
				issuer: AS,
				authorization_endpoint: `${AS}/authorize`,
				token_endpoint: TOKEN_URL,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
			},
		});
		const id = raiseChallenge(
			db,
			{
				serverName: "srv",
				owningSiteId: SITE,
				serverUrl: "https://mcp.example/mcp",
				scopeDemand: "read write",
				grantedScopes: "",
				resourceMetadataHint: null,
				clientId: "cid",
			},
			SITE,
		);
		expect(markResolved(db, id, SITE).ok).toBe(true);
	}

	function configuredProvider(): McpOAuthProvider {
		return new McpOAuthProvider(
			db,
			store,
			{ name: "srv", url: "https://mcp.example/mcp", scopes: ["read", "write"], clientId: "cid" },
			SITE,
			new RaiseDebouncer(),
		);
	}

	function tokenEndpoint(status: number, body: Record<string, unknown>) {
		const calls: string[] = [];
		const fetchFn = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			calls.push(url);
			if (url !== TOKEN_URL) throw new Error(`unexpected fetch ${url}`);
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		return { calls, fetchFn };
	}

	it("invalid_grant clears the refresh credentials and re-raises the challenge as pending", async () => {
		await seedResolvedGrant();
		const { calls, fetchFn } = tokenEndpoint(400, {
			error: "invalid_grant",
			error_description: "Grant not found",
		});
		const p = configuredProvider();

		await expect(auth(p, { serverUrl: "https://mcp.example/mcp", fetchFn })).rejects.toBeInstanceOf(
			AuthChallengeRaisedError,
		);

		// One refresh attempt, not a retry with the same rejected token.
		expect(calls).toEqual([TOKEN_URL]);
		const bundle = store.getBundle("srv");
		expect(bundle?.accessToken).toBe("");
		expect(bundle?.refreshToken).toBeUndefined();
		expect(p.tokens()).toBeUndefined();
		// Discovery state survives a tokens-only invalidation.
		expect(bundle?.discoveryState).toBeDefined();
		expect(findChallengeById(db, challengeId(SITE, "srv"))?.status).toBe("pending");
	});

	it("keeps credentials and the resolved challenge on a transient server_error", async () => {
		await seedResolvedGrant();
		const { fetchFn } = tokenEndpoint(503, { error: "temporarily_unavailable" });
		const p = configuredProvider();

		await expect(auth(p, { serverUrl: "https://mcp.example/mcp", fetchFn })).rejects.toBeDefined();

		const bundle = store.getBundle("srv");
		expect(bundle?.refreshToken).toBe("old-rt");
		expect(bundle?.accessToken).toBe("old-at");
		expect(findChallengeById(db, challengeId(SITE, "srv"))?.status).toBe("resolved");
	});

	it("invalidateCredentials('client') drops the cached DCR registration for the issuer", async () => {
		await store.saveRegistration(AS, { clientId: "dcr-client" });
		await store.saveBundle("srv", {
			accessToken: "at",
			refreshToken: "rt",
			scopes: "",
			accessTokenExpiresAt: 0,
			issuer: AS,
		});
		const p = provider();
		await p.invalidateCredentials("client");
		expect(store.getRegistration(AS)).toBeNull();
		expect(store.getBundle("srv")?.refreshToken).toBe("rt");
	});

	it("invalidateCredentials('all') clears tokens, verifier, and discovery state", async () => {
		await store.saveBundle("srv", {
			accessToken: "at",
			refreshToken: "rt",
			scopes: "read",
			accessTokenExpiresAt: 0,
			issuer: AS,
			codeVerifier: "v",
			discoveryState: { authorizationServerUrl: AS },
		});
		const p = provider();
		await p.invalidateCredentials("all");
		const b = store.getBundle("srv");
		expect(b?.accessToken ?? "").toBe("");
		expect(b?.refreshToken).toBeUndefined();
		expect(b?.codeVerifier).toBeUndefined();
		expect(b?.discoveryState).toBeUndefined();
	});

	it("raiseIfGrantLost turns an escaped invalid_grant into a pending challenge", async () => {
		await seedResolvedGrant();
		const p = configuredProvider();
		const raised = await p.raiseIfGrantLost(
			new OAuthError(OAuthErrorCode.InvalidGrant, "Grant not found"),
		);
		expect(raised).toBeInstanceOf(AuthChallengeRaisedError);
		expect(raised?.challengeId).toBe(challengeId(SITE, "srv"));
		expect(store.getBundle("srv")?.refreshToken).toBeUndefined();
		expect(findChallengeById(db, challengeId(SITE, "srv"))?.status).toBe("pending");
	});

	it("raiseIfGrantLost ignores transient and non-OAuth errors", async () => {
		await seedResolvedGrant();
		const p = configuredProvider();
		for (const e of [
			new OAuthError(OAuthErrorCode.ServerError, "HTTP 503"),
			new OAuthError(OAuthErrorCode.TemporarilyUnavailable, "later"),
			new TypeError("fetch failed"),
			new Error("invalid_grant mentioned in a plain message"),
		]) {
			expect(await p.raiseIfGrantLost(e)).toBeNull();
		}
		expect(store.getBundle("srv")?.refreshToken).toBe("old-rt");
		expect(findChallengeById(db, challengeId(SITE, "srv"))?.status).toBe("resolved");
	});
});

describe("McpOAuthProvider OAuth failure log fields (#318)", () => {
	it("endpointForLog drops the query string and fragment", () => {
		expect(endpointForLog("https://as.example/oauth/token?tenant=t-secret&code=abc#frag")).toBe(
			"https://as.example/oauth/token",
		);
		expect(endpointForLog(new URL("https://as.example:8443/token?x=1"))).toBe(
			"https://as.example:8443/token",
		);
		expect(endpointForLog("not a url")).toBeUndefined();
		expect(endpointForLog(undefined)).toBeUndefined();
	});

	it("oauthLogFields returns {} for a non-OAuth error and the code for a bare OAuthError", () => {
		expect(oauthLogFields(new TypeError("fetch failed"))).toEqual({});
		expect(oauthLogFields(new OAuthError(OAuthErrorCode.InvalidGrant, "Grant not found"))).toEqual({
			oauthError: "invalid_grant",
		});
	});

	it("observeFetch records only status, code, and the stripped URL of a failed token request", async () => {
		const p = provider();
		const base = (async () =>
			new Response(JSON.stringify({ error: "invalid_grant" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
		const observed = p.observeFetch(base);
		await observed("https://as.example/token?tenant=t-secret", {
			method: "POST",
			body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt-secret" }),
		});
		expect(p.lastTokenEndpointFailure()).toEqual({
			status: 400,
			oauthError: "invalid_grant",
			tokenEndpoint: "https://as.example/token",
		});
		expect(JSON.stringify(p.tokenFailureLogFields())).not.toContain("secret");

		// A non-token request (no grant_type form body) is not recorded.
		const q = provider();
		await q.observeFetch(base)("https://mcp.example/mcp", { method: "POST", body: "{}" });
		expect(q.lastTokenEndpointFailure()).toBeNull();
	});

	it("invalidateCredentials WARNs once with server, scope, and the observed cause", async () => {
		const warns: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
		const p = new McpOAuthProvider(
			db,
			store,
			{ name: "srv", url: "https://mcp.example/mcp" },
			SITE,
			new RaiseDebouncer(),
			{ warn: (msg, meta) => warns.push({ msg, meta }) },
		);
		const base = (async () =>
			new Response(JSON.stringify({ error: "invalid_grant" }), {
				status: 400,
			})) as unknown as typeof fetch;
		await p.observeFetch(base)("https://as.example/token", {
			method: "POST",
			body: new URLSearchParams({ grant_type: "refresh_token" }),
		});
		await p.invalidateCredentials("tokens");
		expect(warns).toEqual([
			{
				msg: "[mcp-oauth] invalidating tokens credentials for srv",
				meta: {
					server: "srv",
					scope: "tokens",
					oauthError: "invalid_grant",
					tokenEndpoint: "https://as.example/token",
					status: 400,
				},
			},
		]);
	});
});
