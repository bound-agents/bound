import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, challengeId, findChallengeById } from "@bound/core";
import { AuthChallengeRaisedError, McpOAuthProvider } from "../oauth-provider";
import { RaiseDebouncer } from "../raise";
import { McpTokenStore } from "../token-store";

const SITE = "site-owner";
let dir: string;
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
			new McpTokenStore(join("/dev/null/nope", "mcp-auth.json")),
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
