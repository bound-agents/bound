import { describe, expect, it } from "bun:test";
import type { ResolverAttempt } from "@bound/agent";
import { type OauthMcpResolverBridge, createOauthMcpRoutes } from "../oauth-mcp";

/**
 * Callback-route tests (R-MO17.6-8/R-MO17c/R-MO31). The route is a pure
 * forwarder: `state` is the precondition of forwarding any outcome. A fake
 * bridge records what it was asked to forward.
 */

function makeAttempt(state: string): ResolverAttempt {
	return {
		challengeId: "chal-1",
		serverName: "srv",
		state,
		codeVerifier: "verifier",
		redirectUri: "http://localhost:3001/oauth/mcp/callback",
		resource: "https://mcp.example.com",
		issuer: "https://as.example.com",
		clientId: "client-1",
		authorizationUrl: `https://as.example.com/authorize?state=${state}`,
	};
}

class FakeBridge implements OauthMcpResolverBridge {
	forwarded: Array<{ attempt: ResolverAttempt; outcome: unknown }> = [];
	constructor(private readonly liveState: string | null) {}
	attemptForState(state: string): ResolverAttempt | null {
		return this.liveState !== null && state === this.liveState ? makeAttempt(state) : null;
	}
	forwardOutcome(attempt: ResolverAttempt, outcome: unknown): void {
		this.forwarded.push({ attempt, outcome });
	}
	async claimForLogin() {
		return {
			ok: true as const,
			authorizeUrl: "https://as.example.com/authorize",
			challengeId: "chal-1",
		};
	}
}

let bridge: FakeBridge;

function app(b: OauthMcpResolverBridge | null) {
	return createOauthMcpRoutes(b);
}

describe("GET /oauth/mcp/callback — state gate (R-MO31)", () => {
	it("missing state → 400, nothing forwarded", async () => {
		bridge = new FakeBridge("live-state");
		const res = await app(bridge).request("/callback?code=abc");
		expect(res.status).toBe(400);
		expect(bridge.forwarded).toHaveLength(0);
	});

	it("stale state (no matching awaited attempt) → 400, nothing forwarded", async () => {
		bridge = new FakeBridge("live-state");
		const res = await app(bridge).request("/callback?state=stale-state&code=abc");
		expect(res.status).toBe(400);
		expect(bridge.forwarded).toHaveLength(0);
	});

	it("matching state + code → code handoff forwarded", async () => {
		bridge = new FakeBridge("live-state");
		const res = await app(bridge).request("/callback?state=live-state&code=the-code");
		expect(res.status).toBe(200);
		expect(bridge.forwarded).toHaveLength(1);
		expect(bridge.forwarded[0].outcome).toEqual({ kind: "code", code: "the-code" });
	});

	it("matching state + error → error outcome forwarded (R-MO17c)", async () => {
		bridge = new FakeBridge("live-state");
		const res = await app(bridge).request(
			"/callback?state=live-state&error=access_denied&error_description=user+declined",
		);
		expect(res.status).toBe(200);
		expect(bridge.forwarded).toHaveLength(1);
		expect(bridge.forwarded[0].outcome).toEqual({
			kind: "error",
			error: "access_denied",
			errorDescription: "user declined",
		});
	});

	it("stale state + error → 400, error NOT forwarded (a decline of a superseded attempt is inert)", async () => {
		bridge = new FakeBridge("live-state");
		const res = await app(bridge).request("/callback?state=stale&error=access_denied");
		expect(res.status).toBe(400);
		expect(bridge.forwarded).toHaveLength(0);
	});

	it("matching state but neither code nor error → 400, nothing forwarded", async () => {
		bridge = new FakeBridge("live-state");
		const res = await app(bridge).request("/callback?state=live-state");
		expect(res.status).toBe(400);
		expect(bridge.forwarded).toHaveLength(0);
	});

	it("no resolver on this host (null bridge) → 400 for any callback", async () => {
		const res = await app(null).request("/callback?state=anything&code=x");
		expect(res.status).toBe(400);
	});
});

describe("POST /oauth/mcp/claim (R-MO27e)", () => {
	it("claim by challenge_id returns the authorize URL", async () => {
		bridge = new FakeBridge("live-state");
		const res = await app(bridge).request("/claim", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ challenge_id: "chal-1" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { authorize_url: string; challenge_id: string };
		expect(body.authorize_url).toContain("/authorize");
		expect(body.challenge_id).toBe("chal-1");
	});

	it("claim with neither field → 400", async () => {
		bridge = new FakeBridge("live-state");
		const res = await app(bridge).request("/claim", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("no resolver on this host → 503", async () => {
		const res = await app(null).request("/claim", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ challenge_id: "chal-1" }),
		});
		expect(res.status).toBe(503);
	});
});
