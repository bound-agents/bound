import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, findChallengeById, raiseChallenge } from "@bound/core";
import { McpChallengeResolver, type ResolverServerConfig, unionAttemptScopes } from "../resolver";

/**
 * Resolver attempt-flow tests (R-MO17/R-MO17b/R-MO25/R-MO32). All discovery +
 * DCR + authorize is driven through a stubbed fetch — no network. The stub
 * serves RFC 9728 PRM, RFC 8414 AS metadata, and a DCR registration_endpoint.
 */

const SITE = "site-owner";

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
});

afterEach(() => {
	db.close();
});

const AS_ORIGIN = "https://as.example.com";
const SERVER_URL = "https://mcp.example.com";

/**
 * A fetch stub serving PRM + AS-metadata (+ optional registration_endpoint).
 * Returns 404 for the PRM well-known when `advertisePrm` is false so the
 * resolver falls back to the server URL as the AS seed + resource.
 */
function makeFetchStub(opts: { advertisePrm?: boolean; registrationEndpoint?: boolean } = {}) {
	const advertisePrm = opts.advertisePrm ?? true;
	return async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.includes("/.well-known/oauth-protected-resource")) {
			if (!advertisePrm) return new Response("not found", { status: 404 });
			return Response.json({
				resource: SERVER_URL,
				authorization_servers: [AS_ORIGIN],
			});
		}
		if (
			url.includes("/.well-known/oauth-authorization-server") ||
			url.includes("/.well-known/openid-configuration")
		) {
			const meta: Record<string, unknown> = {
				issuer: AS_ORIGIN,
				authorization_endpoint: `${AS_ORIGIN}/authorize`,
				token_endpoint: `${AS_ORIGIN}/token`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
			};
			if (opts.registrationEndpoint) meta.registration_endpoint = `${AS_ORIGIN}/register`;
			return Response.json(meta);
		}
		if (url.includes("/register")) {
			return Response.json(
				{
					client_id: "dcr-generated-client",
					redirect_uris: ["http://localhost:3001/oauth/mcp/callback"],
				},
				{ status: 201 },
			);
		}
		return new Response("unexpected", { status: 500 });
	};
}

function seedPendingChallenge(serverName: string, scopeDemand = "read", granted = ""): string {
	return raiseChallenge(
		db,
		{
			serverName,
			owningSiteId: SITE,
			serverUrl: SERVER_URL,
			scopeDemand,
			grantedScopes: granted,
			resourceMetadataHint: null,
			clientId: null,
		},
		SITE,
	);
}

describe("unionAttemptScopes (R-MO12b)", () => {
	it("unions config, granted, and demanded scopes without dropping held scopes", () => {
		expect(unionAttemptScopes(["a", "b"], "b c", "d").split(" ").sort()).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
	});
	it("is empty when all inputs are empty", () => {
		expect(unionAttemptScopes(undefined, "", "")).toBe("");
	});
});

describe("McpChallengeResolver.claim (R-MO17)", () => {
	it("claims a pending challenge with a config client_id and mints an authorize URL", async () => {
		const id = seedPendingChallenge("srv");
		const config: ResolverServerConfig = {
			name: "srv",
			url: SERVER_URL,
			scopes: ["read"],
			clientId: "config-client",
		};
		const resolver = new McpChallengeResolver(db, () => config, makeFetchStub());
		const result = await resolver.claim(id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.clientId).toBe("config-client");
		expect(result.value.issuer).toBe(AS_ORIGIN);
		expect(result.value.state.length).toBeGreaterThan(0);
		expect(result.value.codeVerifier.length).toBeGreaterThan(0);
		expect(result.value.authorizationUrl).toContain(`${AS_ORIGIN}/authorize`);
		expect(result.value.authorizationUrl).toContain("state=");
		// R-MO27: redirect_uri names the loopback web-router callback path.
		expect(result.value.redirectUri).toContain("/oauth/mcp/callback");
	});

	it("registration ladder: DCR public client when no config client_id (R-MO25)", async () => {
		const id = seedPendingChallenge("srv");
		const config: ResolverServerConfig = { name: "srv", url: SERVER_URL, scopes: ["read"] };
		const resolver = new McpChallengeResolver(
			db,
			() => config,
			makeFetchStub({ registrationEndpoint: true }),
		);
		const result = await resolver.claim(id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.clientId).toBe("dcr-generated-client");
	});

	it("terminal registration error when no config client_id AND no DCR endpoint (R-MO25)", async () => {
		const id = seedPendingChallenge("srv");
		const config: ResolverServerConfig = { name: "srv", url: SERVER_URL, scopes: ["read"] };
		const resolver = new McpChallengeResolver(
			db,
			() => config,
			makeFetchStub({ registrationEndpoint: false }),
		);
		const result = await resolver.claim(id);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("no_registration");
	});

	it("refuses a non-pending challenge", async () => {
		const id = seedPendingChallenge("srv");
		// Flip to resolved out of band.
		const config: ResolverServerConfig = { name: "srv", url: SERVER_URL, clientId: "c" };
		const resolver = new McpChallengeResolver(db, () => config, makeFetchStub());
		const row = findChallengeById(db, id);
		expect(row?.status).toBe("pending");
		// mark resolved directly through the repo writer
		const { markResolved } = await import("@bound/core");
		markResolved(db, id, SITE);
		const result = await resolver.claim(id);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("not_pending");
	});
});

describe("McpChallengeResolver single-flight state (R-MO17b)", () => {
	it("a new attempt invalidates the prior attempt's state", async () => {
		const id = seedPendingChallenge("srv");
		const config: ResolverServerConfig = { name: "srv", url: SERVER_URL, clientId: "c" };
		const resolver = new McpChallengeResolver(db, () => config, makeFetchStub());

		const first = await resolver.claim(id);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const firstState = first.value.state;
		// The first attempt's state resolves to the live attempt.
		expect(resolver.attemptForState(firstState)?.state).toBe(firstState);

		const second = await resolver.claim(id);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.value.state).not.toBe(firstState);
		// R-MO17b: the prior state no longer matches any awaited attempt.
		expect(resolver.attemptForState(firstState)).toBeNull();
		expect(resolver.attemptForState(second.value.state)?.state).toBe(second.value.state);
	});

	it("discardAttempt clears the live attempt", async () => {
		const id = seedPendingChallenge("srv");
		const config: ResolverServerConfig = { name: "srv", url: SERVER_URL, clientId: "c" };
		const resolver = new McpChallengeResolver(db, () => config, makeFetchStub());
		const r = await resolver.claim(id);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		resolver.discardAttempt(id);
		expect(resolver.attemptForState(r.value.state)).toBeNull();
	});
});
