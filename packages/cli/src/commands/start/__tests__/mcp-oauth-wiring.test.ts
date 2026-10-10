import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type AppContext,
	type McpAuthChallenge,
	applySchema,
	findChallengeByServer,
	raiseChallenge,
} from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { createMcpOAuthWiring } from "../mcp-oauth-wiring";

/**
 * Bridge claim-by-server-name tests (R-MO17 name-based claim). The resolver's
 * live discovery/DCR runs through a stubbed fetch (same shape as
 * resolver.test.ts) so a successful claim needs no network. The error paths
 * (ambiguity, not-configured) short-circuit before any fetch.
 */

const SITE = "site-this-host";
const OTHER_SITE = "site-other-host";
const AS_ORIGIN = "https://as.example.com";
const SERVER_URL = "https://mcp.sentry.dev/mcp";

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
});

afterEach(() => {
	db.close();
});

/** A fetch stub serving PRM + AS metadata so resolver.claim can mint an attempt. */
function makeFetchStub(): typeof fetch {
	return (async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.includes("/.well-known/oauth-protected-resource")) {
			return Response.json({ resource: SERVER_URL, authorization_servers: [AS_ORIGIN] });
		}
		if (
			url.includes("/.well-known/oauth-authorization-server") ||
			url.includes("/.well-known/openid-configuration")
		) {
			return Response.json({
				issuer: AS_ORIGIN,
				authorization_endpoint: `${AS_ORIGIN}/authorize`,
				token_endpoint: `${AS_ORIGIN}/token`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
				// A config client_id is supplied below, so DCR is never walked.
			});
		}
		return new Response("unexpected", { status: 500 });
	}) as typeof fetch;
}

/**
 * Minimal AppContext carrying only what createMcpOAuthWiring reads: the db, the
 * siteId, and an mcp optionalConfig whose servers drive `oauthServers`.
 */
function appContextWith(servers: unknown[]): AppContext {
	return {
		db,
		siteId: SITE,
		optionalConfig: { mcp: { ok: true, value: { servers } } },
		eventBus: new TypedEventEmitter(),
	} as unknown as AppContext;
}

function oauthServer(name: string, clientId = "cfg-client") {
	return {
		name,
		transport: "http",
		url: SERVER_URL,
		auth: { type: "oauth", client_id: clientId },
	};
}

function seedChallenge(
	serverName: string,
	owningSiteId: string,
	status: "pending" | "failed" = "pending",
): McpAuthChallenge {
	raiseChallenge(
		db,
		{ serverName, owningSiteId, serverUrl: SERVER_URL, scopeDemand: "", grantedScopes: "" },
		owningSiteId,
	);
	const row = findChallengeByServer(db, owningSiteId, serverName);
	if (!row) throw new Error("seed failed");
	if (status === "failed") {
		db.run(
			"UPDATE mcp_auth_challenges SET status = 'failed', failure_reason = 'access_denied' WHERE id = ?",
			[row.id],
		);
	}
	return findChallengeByServer(db, owningSiteId, serverName) as McpAuthChallenge;
}

describe("claimForLogin by server name (R-MO17)", () => {
	it("claims an existing pending challenge for the named server", async () => {
		const seeded = seedChallenge("sentry", SITE);
		const wiring = createMcpOAuthWiring(
			appContextWith([oauthServer("sentry")]),
			"config",
			() => {},
			3001,
			makeFetchStub(),
		);
		expect(wiring).not.toBeNull();
		const result = await wiring?.bridge.claimForLogin({ serverName: "sentry" });
		expect(result?.ok).toBe(true);
		if (result?.ok) {
			expect(result.challengeId).toBe(seeded.id);
			expect(result.authorizeUrl).toContain(`${AS_ORIGIN}/authorize`);
		}
	});

	it("raises then claims when no challenge exists but the server is oauth-configured", async () => {
		expect(findChallengeByServer(db, SITE, "sentry")).toBeNull();
		const wiring = createMcpOAuthWiring(
			appContextWith([oauthServer("sentry")]),
			"config",
			() => {},
			3001,
			makeFetchStub(),
		);
		const result = await wiring?.bridge.claimForLogin({ serverName: "sentry" });
		expect(result?.ok).toBe(true);
		// The pre-auth raise persisted a pending row before the claim.
		const raised = findChallengeByServer(db, SITE, "sentry");
		expect(raised?.status).toBe("pending");
	});

	it("returns a typed error when the server is not oauth-configured on this host", async () => {
		const wiring = createMcpOAuthWiring(
			// Configure a DIFFERENT oauth server so the wiring is non-null, but the
			// requested name has no local config.
			appContextWith([oauthServer("linear")]),
			"config",
			() => {},
			3001,
			makeFetchStub(),
		);
		const result = await wiring?.bridge.claimForLogin({ serverName: "sentry" });
		expect(result?.ok).toBe(false);
		if (result && !result.ok) {
			expect(result.error).toContain('no MCP server named "sentry"');
			expect(result.error).toContain("mcp.json");
		}
	});

	it("disambiguates when the same name has challenges on more than one host", async () => {
		seedChallenge("sentry", SITE);
		seedChallenge("sentry", OTHER_SITE);
		const wiring = createMcpOAuthWiring(
			appContextWith([oauthServer("sentry")]),
			"config",
			() => {},
			3001,
			makeFetchStub(),
		);
		const result = await wiring?.bridge.claimForLogin({ serverName: "sentry" });
		expect(result?.ok).toBe(false);
		if (result && !result.ok) {
			expect(result.error).toContain("more than one host");
			expect(result.error).toContain(SITE);
			expect(result.error).toContain(OTHER_SITE);
		}
	});

	it("still claims by challenge_id directly (unchanged path)", async () => {
		const seeded = seedChallenge("sentry", SITE);
		const wiring = createMcpOAuthWiring(
			appContextWith([oauthServer("sentry")]),
			"config",
			() => {},
			3001,
			makeFetchStub(),
		);
		const result = await wiring?.bridge.claimForLogin({ challengeId: seeded.id });
		expect(result?.ok).toBe(true);
		if (result?.ok) expect(result.challengeId).toBe(seeded.id);
	});
});
