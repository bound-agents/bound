import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ResolverAttempt } from "@bound/agent";
import { applySchema, raiseChallenge } from "@bound/core";
import { createMcpChallengesRoutes, isLoopbackBind } from "../mcp-challenges";
import type { OauthMcpResolverBridge } from "../oauth-mcp";

const OWNER = "site-owner-1";

// A resolver bridge that records claims and mints a fixed authorize URL, so a
// loopback claim can be asserted end to end.
class FakeBridge implements OauthMcpResolverBridge {
	claims: Array<{ challengeId?: string; serverName?: string }> = [];
	constructor(private readonly ok: boolean) {}
	attemptForState(): ResolverAttempt | null {
		return null;
	}
	forwardOutcome(): void {}
	async claimForLogin(target: { challengeId?: string; serverName?: string }) {
		this.claims.push(target);
		return this.ok
			? {
					ok: true as const,
					authorizeUrl: "https://as.example.com/authorize?state=abc",
					challengeId: target.challengeId ?? "chal-x",
				}
			: { ok: false as const, error: "no such challenge" };
	}
}

let db: Database;

function seedPending(serverName: string, scopeDemand = "read write"): string {
	return raiseChallenge(
		db,
		{
			serverName,
			owningSiteId: OWNER,
			serverUrl: "https://mcp.example.com",
			scopeDemand,
			grantedScopes: "",
		},
		OWNER,
	);
}

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
});

afterEach(() => {
	db.close();
});

describe("isLoopbackBind", () => {
	it("classifies loopback hosts", () => {
		expect(isLoopbackBind("localhost")).toBe(true);
		expect(isLoopbackBind("127.0.0.1")).toBe(true);
		expect(isLoopbackBind("::1")).toBe(true);
		expect(isLoopbackBind("0.0.0.0")).toBe(false);
		expect(isLoopbackBind("10.0.0.5")).toBe(false);
	});
});

describe("GET /api/mcp-challenges — enumeration + loopback gating (R-MO27c)", () => {
	it("lists pending challenges and reports loopback=true under a loopback bind", async () => {
		const id = seedPending("linear");
		const app = createMcpChallengesRoutes(db, "localhost", new FakeBridge(true));
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			challenges: Array<{ challengeId: string; serverName: string; scopeDemand: string }>;
			loopback: boolean;
			canResolve: boolean;
		};
		expect(body.loopback).toBe(true);
		expect(body.canResolve).toBe(true);
		expect(body.challenges).toHaveLength(1);
		expect(body.challenges[0]).toMatchObject({
			challengeId: id,
			serverName: "linear",
			scopeDemand: "read write",
		});
	});

	it("reports loopback=false and canResolve=false on a non-loopback bind", async () => {
		seedPending("github");
		const app = createMcpChallengesRoutes(db, "0.0.0.0", new FakeBridge(true));
		const res = await app.request("/");
		const body = (await res.json()) as { loopback: boolean; canResolve: boolean };
		expect(body.loopback).toBe(false);
		// Even with a resolver present, a non-loopback bind cannot mint a
		// reachable authorize URL, so the card must not offer the live flow.
		expect(body.canResolve).toBe(false);
	});

	it("reports canResolve=false when no resolver is present even on loopback", async () => {
		seedPending("notion");
		const app = createMcpChallengesRoutes(db, "localhost", null);
		const res = await app.request("/");
		const body = (await res.json()) as { loopback: boolean; canResolve: boolean };
		expect(body.loopback).toBe(true);
		expect(body.canResolve).toBe(false);
	});
});

describe("POST /api/mcp-challenges/:id/claim — live authorize flow (R-MO27c)", () => {
	it("mints an authorize URL under a loopback bind", async () => {
		const id = seedPending("linear");
		const bridge = new FakeBridge(true);
		const app = createMcpChallengesRoutes(db, "localhost", bridge);
		const res = await app.request(`/${id}/claim`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { authorizeUrl: string };
		expect(body.authorizeUrl).toBe("https://as.example.com/authorize?state=abc");
		expect(bridge.claims).toEqual([{ challengeId: id }]);
	});

	it("refuses the claim with 409 on a non-loopback bind — no URL minted", async () => {
		const id = seedPending("github");
		const bridge = new FakeBridge(true);
		const app = createMcpChallengesRoutes(db, "0.0.0.0", bridge);
		const res = await app.request(`/${id}/claim`, { method: "POST" });
		expect(res.status).toBe(409);
		// The card is directed to the CLI instead; the bridge is never asked to
		// mint a URL that would name an unreachable loopback redirect_uri.
		expect(bridge.claims).toHaveLength(0);
	});

	it("returns 503 when the host runs no resolver", async () => {
		const id = seedPending("notion");
		const app = createMcpChallengesRoutes(db, "localhost", null);
		const res = await app.request(`/${id}/claim`, { method: "POST" });
		expect(res.status).toBe(503);
	});

	it("surfaces a bridge claim failure as 400", async () => {
		const id = seedPending("linear");
		const app = createMcpChallengesRoutes(db, "localhost", new FakeBridge(false));
		const res = await app.request(`/${id}/claim`, { method: "POST" });
		expect(res.status).toBe(400);
	});
});
