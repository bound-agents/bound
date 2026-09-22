import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, findChallengeById, markResolved, raiseChallenge } from "@bound/core";
import {
	type McpAuthHandoffPayload,
	type OwnerServerConfig,
	classifyAuthorizeError,
	consumeHandoff,
} from "../owner-exchange";
import { McpTokenStore } from "../token-store";

/**
 * Owner-exchange tests (R-MO17c/R-MO20/R-MO21). Discovery + token exchange are
 * driven through a stubbed fetch — no network.
 */

const SITE = "site-owner";
const SERVER_URL = "https://mcp.example.com";
const AS_ORIGIN = "https://as.example.com";

let dir: string;
let store: McpTokenStore;
let db: Database;

beforeEach(() => {
	dir = join(tmpdir(), `mcp-owner-${randomBytes(4).toString("hex")}`);
	store = new McpTokenStore(join(dir, "mcp-auth.json"));
	db = new Database(":memory:");
	applySchema(db);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function seedPending(serverName: string, granted = ""): string {
	return raiseChallenge(
		db,
		{
			serverName,
			owningSiteId: SITE,
			serverUrl: SERVER_URL,
			scopeDemand: "read",
			grantedScopes: granted,
			resourceMetadataHint: null,
			clientId: null,
		},
		SITE,
	);
}

function ownerConfig(overrides: Partial<OwnerServerConfig> = {}): OwnerServerConfig {
	return { name: "srv", url: SERVER_URL, scopes: ["read"], clientId: "owner-client", ...overrides };
}

/** Fetch stub serving PRM + AS metadata + a token endpoint. */
function makeFetchStub(opts: { tokenResponse?: Response | (() => Response) } = {}) {
	return async (input: string | URL | Request): Promise<Response> => {
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
			});
		}
		if (url.includes("/token")) {
			if (opts.tokenResponse) {
				return typeof opts.tokenResponse === "function" ? opts.tokenResponse() : opts.tokenResponse;
			}
			return Response.json({
				access_token: "at-123",
				token_type: "Bearer",
				refresh_token: "rt-123",
				expires_in: 3600,
				scope: "read write",
			});
		}
		return new Response("unexpected", { status: 500 });
	};
}

function codeHandoff(
	id: string,
	overrides: Partial<McpAuthHandoffPayload> = {},
): McpAuthHandoffPayload {
	return {
		challenge_id: id,
		server_name: "srv",
		state: "state-1",
		code: "auth-code-1",
		code_verifier: "verifier-1",
		redirect_uri: "http://localhost:3001/oauth/mcp/callback",
		resource: SERVER_URL,
		issuer: AS_ORIGIN,
		client_id: "owner-client",
		...overrides,
	};
}

describe("classifyAuthorizeError (R-MO17c)", () => {
	it("access_denied / invalid_scope / unauthorized_client / invalid_request are terminal", () => {
		for (const code of [
			"access_denied",
			"invalid_scope",
			"unauthorized_client",
			"invalid_request",
		]) {
			expect(classifyAuthorizeError(code)).toBe("terminal");
		}
	});
	it("temporarily_unavailable / server_error are transient", () => {
		expect(classifyAuthorizeError("temporarily_unavailable")).toBe("transient");
		expect(classifyAuthorizeError("server_error")).toBe("transient");
	});
	it("an UNLISTED code defaults to terminal (asymmetry with token endpoint)", () => {
		expect(classifyAuthorizeError("login_required")).toBe("terminal");
		expect(classifyAuthorizeError("consent_required")).toBe("terminal");
		expect(classifyAuthorizeError("some_novel_code")).toBe("terminal");
	});
});

describe("consumeHandoff exchange success (R-MO20)", () => {
	it("exchanges, saves the bundle (unioned scopes), marks resolved, and reconnects", async () => {
		const id = seedPending("srv", "read");
		let reconnected = "";
		const outcome = await consumeHandoff(db, codeHandoff(id), {
			siteId: SITE,
			store,
			resolveConfig: () => ownerConfig(),
			reconnect: (s) => {
				reconnected = s;
			},
			fetchFn: makeFetchStub(),
		});
		expect(outcome.kind).toBe("resolved");
		expect(findChallengeById(db, id)?.status).toBe("resolved");
		const bundle = store.getBundle("srv");
		expect(bundle?.accessToken).toBe("at-123");
		// scope union of prior granted (read) + exchanged (read write).
		expect(bundle?.scopes.split(" ").sort()).toEqual(["read", "write"]);
		expect(reconnected).toBe("srv");
	});
});

describe("consumeHandoff idempotency + validation (R-MO20)", () => {
	it("drops a handoff for an already-resolved challenge without exchange", async () => {
		const id = seedPending("srv");
		markResolved(db, id, SITE);
		let tokenFetched = false;
		const outcome = await consumeHandoff(db, codeHandoff(id), {
			siteId: SITE,
			store,
			resolveConfig: () => ownerConfig(),
			fetchFn: async (input) => {
				const url =
					typeof input === "string" ? input : ((input as URL).href ?? (input as Request).url);
				if (url.includes("/token")) tokenFetched = true;
				return new Response("{}", { status: 200 });
			},
		});
		expect(outcome.kind).toBe("dropped");
		expect(tokenFetched).toBe(false);
	});

	it("dead-letters on a resource mismatch (no exchange)", async () => {
		const id = seedPending("srv");
		const outcome = await consumeHandoff(
			db,
			codeHandoff(id, { resource: "https://evil.example.com" }),
			{
				siteId: SITE,
				store,
				resolveConfig: () => ownerConfig(),
				fetchFn: makeFetchStub(),
			},
		);
		expect(outcome.kind).toBe("dead_letter");
		expect(findChallengeById(db, id)?.status).toBe("pending");
	});

	it("dead-letters on an issuer mismatch (no exchange)", async () => {
		const id = seedPending("srv");
		const outcome = await consumeHandoff(
			db,
			codeHandoff(id, { issuer: "https://other-idp.example.com" }),
			{
				siteId: SITE,
				store,
				resolveConfig: () => ownerConfig(),
				fetchFn: makeFetchStub(),
			},
		);
		expect(outcome.kind).toBe("dead_letter");
	});
});

describe("consumeHandoff error outcomes (R-MO17c)", () => {
	it("terminal authorize error → markFailed with the error code", async () => {
		const id = seedPending("srv");
		const outcome = await consumeHandoff(
			db,
			codeHandoff(id, { code: undefined, code_verifier: undefined, error: "access_denied" }),
			{
				siteId: SITE,
				store,
				resolveConfig: () => ownerConfig(),
				fetchFn: makeFetchStub(),
			},
		);
		expect(outcome.kind).toBe("failed");
		const row = findChallengeById(db, id);
		expect(row?.status).toBe("failed");
		expect(row?.failure_reason).toBe("access_denied");
	});

	it("transient authorize error → dropped, row stays pending", async () => {
		const id = seedPending("srv");
		const outcome = await consumeHandoff(
			db,
			codeHandoff(id, {
				code: undefined,
				code_verifier: undefined,
				error: "temporarily_unavailable",
			}),
			{
				siteId: SITE,
				store,
				resolveConfig: () => ownerConfig(),
				fetchFn: makeFetchStub(),
			},
		);
		expect(outcome.kind).toBe("dropped");
		expect(findChallengeById(db, id)?.status).toBe("pending");
	});

	it("terminal token-endpoint error → markFailed (R-MO12/R-MO21)", async () => {
		const id = seedPending("srv");
		const outcome = await consumeHandoff(db, codeHandoff(id), {
			siteId: SITE,
			store,
			resolveConfig: () => ownerConfig(),
			fetchFn: makeFetchStub({
				tokenResponse: () => Response.json({ error: "invalid_grant" }, { status: 400 }),
			}),
		});
		expect(outcome.kind).toBe("failed");
		expect(findChallengeById(db, id)?.failure_reason).toBe("invalid_grant");
	});
});
