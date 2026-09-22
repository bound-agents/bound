import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, findChallengeById } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { writeHandoff } from "../handoff";
import { AuthChallengeRaisedError, McpOAuthProvider } from "../oauth-provider";
import { consumeHandoff } from "../owner-exchange";
import { RaiseDebouncer } from "../raise";
import { McpChallengeResolver } from "../resolver";
import { McpTokenStore } from "../token-store";
import { findUnconsumedWaiters, upsertWaiter } from "../waiters";
import { reconcileWaitersOnBoot } from "../wake";

/**
 * MCP OAuth BRIDGE-INTEGRATION end-to-end test (slice 3.5).
 *
 * MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md — R-MO2 wiring,
 * R-MO11/R-MO14/R-MO15 (settle-and-waiter), R-MO17/R-MO19/R-MO20 (resolver +
 * handoff + owner exchange), R-MO16/R-MO16b (terminal-status wake).
 *
 * Runs the whole loop against a stubbed authorization server + stubbed MCP
 * transport (via the provider's redirectToAuthorization seam), with an
 * in-memory DB and a single owning+resolving host (the common two-hosts-coincide
 * case). Every network hop is a fetch stub; no real socket opens.
 *
 * The chain asserted, in order:
 *   1. An oauth-configured server's call hits 401 → the provider raises a
 *      challenge row and throws AuthChallengeRaisedError carrying the
 *      auth_challenge_raised outcome text (R-MO10/R-MO11).
 *   2. The loop-side settle writes a requester-local waiter binding
 *      (challenge_id, thread_id) (R-MO14/R-MO15). [modeled by the settle helper]
 *   3. The resolver claims the pending challenge and mints an authorize URL
 *      (R-MO17); a callback with code + state forwards a handoff (R-MO19).
 *   4. The owner consumes the handoff, exchanges the code for a token against
 *      the stubbed token endpoint, saves the bundle, and flips the row resolved
 *      (R-MO20).
 *   5. The terminal-status wake enqueues a wakeup for the waiting thread with
 *      idempotency key challenge-wake:<cid>:<tid> (R-MO16).
 */

const SITE = "site-a"; // owning + resolving + requesting host (the two-coincide case)
const SERVER_URL = "https://mcp.example.com";
const AS_ORIGIN = "https://as.example.com";
const THREAD = "thread-e2e";

let dir: string;
let db: Database;
let store: McpTokenStore;
let bus: TypedEventEmitter;

beforeEach(() => {
	dir = join(tmpdir(), `mcp-e2e-${randomBytes(4).toString("hex")}`);
	db = new Database(":memory:");
	applySchema(db);
	store = new McpTokenStore(join(dir, "mcp-auth.json"));
	bus = new EventEmitter() as unknown as TypedEventEmitter;
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * A fetch stub serving RFC 9728 PRM, RFC 8414 AS metadata (with a DCR
 * registration_endpoint), and a token endpoint that mints an access token.
 */
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
				registration_endpoint: `${AS_ORIGIN}/register`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
			});
		}
		if (url.includes("/register")) {
			return Response.json(
				{ client_id: "dcr-client", redirect_uris: ["http://localhost:3001/oauth/mcp/callback"] },
				{ status: 201 },
			);
		}
		if (url.includes("/token")) {
			return Response.json({
				access_token: "at-e2e",
				token_type: "Bearer",
				refresh_token: "rt-e2e",
				expires_in: 3600,
				scope: "read",
			});
		}
		return new Response("unexpected", { status: 500 });
	}) as typeof fetch;
}

describe("MCP OAuth bridge integration (slice 3.5, end to end)", () => {
	it("401 → challenge raised → settled + waiter → resolve → exchange → resolved → wake", async () => {
		const fetchStub = makeFetchStub();

		// --- Step 1: the oauth-configured server's call hits 401. The provider's
		// redirectToAuthorization is the owner seam the v2 SDK triggers instead of
		// opening a browser (R-MO10) — it raises the challenge and throws. This is
		// exactly what the transport's callTool surfaces to the loop.
		const provider = new McpOAuthProvider(
			db,
			store,
			{ name: "srv", url: SERVER_URL, scopes: ["read"], clientId: "cfg-client" },
			SITE,
			new RaiseDebouncer(),
		);
		provider.noteObservedChallenge('Bearer scope="read"');

		let raised: AuthChallengeRaisedError | null = null;
		try {
			provider.redirectToAuthorization(new URL(`${AS_ORIGIN}/authorize`));
		} catch (e) {
			if (e instanceof AuthChallengeRaisedError) raised = e;
			else throw e;
		}
		expect(raised).not.toBeNull();
		if (!raised) return;
		const challengeId = raised.challengeId;
		// R-MO11: the outcome text is actionable — names the challenge and the demand.
		expect(raised.outcomeText).toContain(challengeId);
		expect(raised.outcomeText).toContain("srv");

		// The challenge row is pending and synced-shaped.
		const rowAfterRaise = findChallengeById(db, challengeId);
		expect(rowAfterRaise?.status).toBe("pending");
		expect(rowAfterRaise?.owning_site_id).toBe(SITE);

		// --- Step 2: the loop-side settle writes the requester-local waiter binding
		// (challenge_id, thread_id) (R-MO14/R-MO15). The mcp-bridge callTool catch
		// does exactly this on AuthChallengeRaisedError; here we drive the same seam.
		upsertWaiter(db, challengeId, THREAD);
		expect(findUnconsumedWaiters(db, challengeId)).toHaveLength(1);

		// --- Step 3: a resolver claims the pending challenge and mints an authorize
		// URL (R-MO17), then a callback with code + state forwards a handoff (R-MO19).
		const resolver = new McpChallengeResolver(
			db,
			(name) =>
				name === "srv"
					? { name: "srv", url: SERVER_URL, scopes: ["read"], clientId: "cfg-client" }
					: null,
			fetchStub,
		);
		const claim = await resolver.claim(challengeId);
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;
		const attempt = claim.value;
		expect(attempt.authorizationUrl).toContain(`${AS_ORIGIN}/authorize`);
		expect(attempt.issuer).toBe(AS_ORIGIN);

		// The callback route correlates the state to the live attempt (R-MO17b) and
		// forwards a code outcome (R-MO19). The bridge writes the handoff.
		const matched = resolver.attemptForState(attempt.state);
		expect(matched?.challengeId).toBe(challengeId);
		const handoff = writeHandoff(db, {
			attempt,
			outcome: { kind: "code", code: "authcode-e2e" },
			ownerSiteId: SITE,
			localSiteId: SITE,
		});
		expect(handoff).not.toBeNull();
		resolver.discardAttempt(challengeId);

		// --- Step 4: the owner consumes the handoff and exchanges the code for a
		// token (R-MO20). Read the durable_work handoff row's payload the way the
		// relay-processor's consumer would, then run consumeHandoff.
		const handoffRow = db
			.query("SELECT payload FROM durable_work WHERE kind = 'mcp_auth_handoff'")
			.get() as { payload: string } | null;
		expect(handoffRow).not.toBeNull();
		if (!handoffRow) return;
		const payload = JSON.parse(handoffRow.payload) as Record<string, unknown>;
		const outcome = await consumeHandoff(db, payload as never, {
			siteId: SITE,
			store,
			resolveConfig: (name) =>
				name === "srv"
					? { name: "srv", url: SERVER_URL, scopes: ["read"], clientId: "cfg-client" }
					: null,
			fetchFn: fetchStub,
		});
		expect(outcome.kind).toBe("resolved");

		// The token bundle was saved (R-MO20 custody) and the row is resolved.
		const bundle = store.getBundle("srv");
		expect(bundle?.accessToken).toBe("at-e2e");
		const resolvedRow = findChallengeById(db, challengeId);
		expect(resolvedRow?.status).toBe("resolved");

		// --- Step 5: the terminal-status wake enqueues a wakeup for the waiting
		// thread with idempotency key challenge-wake:<cid>:<tid> (R-MO16). The
		// requester's changelog:written subscription calls reconcileWaitersOnBoot;
		// here we drive that same sweep.
		const woken = reconcileWaitersOnBoot(db, bus, SITE);
		expect(woken).toBe(1);
		expect(findUnconsumedWaiters(db, challengeId)).toHaveLength(0);

		// The wake landed as a durable dispatch_message carrying the fence key.
		const dispatchRow = db
			.query("SELECT payload FROM durable_work WHERE kind = 'dispatch_message'")
			.get() as { payload: string } | null;
		expect(dispatchRow).not.toBeNull();
		if (!dispatchRow) return;
		const outer = JSON.parse(dispatchRow.payload) as { event_payload: string };
		const notif = JSON.parse(outer.event_payload) as { notification_id: string; text: string };
		expect(notif.notification_id).toBe(`challenge-wake:${challengeId}:${THREAD}`);
		// The resolved wake invites re-issue (R-MO16 invitation, not directive).
		expect(notif.text.toLowerCase()).toContain("re-issue");
	});
});
