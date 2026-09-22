// The canonical loopback OAuth callback for MCP challenge resolution (R-MO27).
//
// MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md, §8, R-MO17.6-8 /
// R-MO17c / R-MO31 / R-MO32. Every resolution surface catches its authorize-leg
// redirect at ONE path — `GET /oauth/mcp/callback` on the daemon's WEB_PORT
// (3001, loopback). The route is a pure FORWARDER: it never exchanges the code
// (R-MO17c) — the owning host alone does that (R-MO20). The `state` parameter is
// the PRECONDITION OF FORWARDING ANY OUTCOME (R-MO31): a callback whose `state`
// is missing, or does not match the currently-awaited resolution attempt, is
// rejected `400` with NO outcome shipped — even when it names a pending
// challenge. Only a state-matched callback forwards: a code handoff on the
// success path, an error-outcome handoff on the RFC 6749 §4.1.2.1 error path.
//
// The daemon's DNS-rebinding Host guard already fronts every route; the loopback
// callback names `localhost`, which the guard's allow-list clears (R-MO27 loopback
// origin) — so this route inherits that protection without its own Host check.
import type { ResolverAttempt } from "@bound/agent";
import { Hono } from "hono";

/**
 * The one thing this route needs from the resolving host's in-process resolver:
 * find the live attempt a callback `state` is bound to (R-MO17b), and forward
 * its caught outcome to the owner over durable_work (R-MO19). Injected so the
 * web layer holds no agent-loop wiring and tests drive it with a fake.
 */
export interface OauthMcpResolverBridge {
	/**
	 * The attempt this `state` is the currently-awaited state for, or null. Only
	 * the live attempt matches; a superseded attempt's state has been overwritten
	 * and returns null — the route rejects it `400` (R-MO31).
	 */
	attemptForState(state: string): ResolverAttempt | null;
	/**
	 * Forward a state-matched outcome to the owning host (R-MO19). The bridge
	 * writes the durable_work handoff and discards the attempt's ephemera. Never
	 * called for an unmatched state.
	 */
	forwardOutcome(
		attempt: ResolverAttempt,
		outcome:
			| { kind: "code"; code: string }
			| { kind: "error"; error: string; errorDescription?: string },
	): void;
	/**
	 * Claim a challenge (by id) or raise-and-claim a server's challenge (by name)
	 * and mint the per-attempt authorize URL (R-MO17). Backs `POST /oauth/mcp/claim`,
	 * the daemon-mediated entry point `bound login --challenge`/`--mcp` drives
	 * (R-MO27e). Returns the authorize URL + challenge id, or an actionable error.
	 */
	claimForLogin(target: { challengeId?: string; serverName?: string }): Promise<
		{ ok: true; authorizeUrl: string; challengeId: string } | { ok: false; error: string }
	>;
}

/** The path this route mounts at, exported for the server index and tests. */
export const OAUTH_MCP_CALLBACK_PATH = "/oauth/mcp/callback";

/**
 * Build the OAuth-MCP callback route. `bridge` is null when the host runs no
 * resolver (the route still mounts and answers, but every callback is a
 * no-awaited-attempt `400` — nothing to forward).
 */
export function createOauthMcpRoutes(bridge: OauthMcpResolverBridge | null): Hono {
	const app = new Hono();

	// GET /oauth/mcp/callback — the authorize-leg redirect lands here.
	app.get("/callback", (c) => {
		const state = c.req.query("state");
		const code = c.req.query("code");
		const error = c.req.query("error");
		const errorDescription = c.req.query("error_description");

		// R-MO31: `state` is the precondition of forwarding. Missing → 400, no outcome.
		if (!state) {
			return c.text("Invalid callback: missing state parameter.", 400);
		}

		// R-MO17b/R-MO31: state must name the CURRENTLY-AWAITED attempt. A stale
		// state (superseded attempt) or one naming no awaited attempt → 400, no
		// outcome shipped — even if it names a pending challenge.
		const attempt = bridge?.attemptForState(state) ?? null;
		if (!attempt) {
			return c.text("Invalid or superseded authorization callback. You can close this tab.", 400);
		}

		// R-MO17c: an `error` param in place of a code is an attempt OUTCOME
		// (RFC 6749 §4.1.2.1). Forward it as an error outcome; the OWNER classifies
		// terminal vs transient (R-MO12/R-MO17c). The resolver never classifies.
		if (error) {
			bridge?.forwardOutcome(attempt, {
				kind: "error",
				error,
				errorDescription: errorDescription ?? undefined,
			});
			return c.text(
				`Authorization was not granted (${error}). You can close this tab and return to your terminal.`,
				200,
			);
		}

		// Success path: a state-matched code. Hand off to the owner for exchange
		// (R-MO19). NEVER exchange here (R-MO17c).
		if (code) {
			bridge?.forwardOutcome(attempt, { kind: "code", code });
			return c.text(
				`Authorization received for "${attempt.serverName}". You can close this tab and return to your terminal.`,
				200,
			);
		}

		// A state-matched callback with neither code nor error is malformed; the
		// attempt stays awaited (no outcome forwarded) so a well-formed retry can
		// still land.
		return c.text("Invalid callback: neither code nor error present.", 400);
	});

	// POST /oauth/mcp/claim — the daemon-mediated claim entry point (R-MO27e).
	// `bound login --challenge <id>` / `--mcp <server>` drives this: the daemon's
	// in-process resolver claims (or raise-and-claims) and mints the per-attempt
	// authorize URL. NEVER exposes verifier/state (resolver-local, R-MO18).
	app.post("/claim", async (c) => {
		if (!bridge) {
			return c.json({ error: "this host runs no MCP OAuth resolver" }, 503);
		}
		let body: { challenge_id?: string; server_name?: string };
		try {
			body = (await c.req.json()) as { challenge_id?: string; server_name?: string };
		} catch {
			return c.json({ error: "invalid JSON body" }, 400);
		}
		if (!body.challenge_id && !body.server_name) {
			return c.json({ error: "claim requires challenge_id or server_name" }, 400);
		}
		const result = await bridge.claimForLogin({
			challengeId: body.challenge_id,
			serverName: body.server_name,
		});
		if (!result.ok) {
			return c.json({ error: result.error }, 400);
		}
		return c.json({ authorize_url: result.authorizeUrl, challenge_id: result.challengeId });
	});

	return app;
}
