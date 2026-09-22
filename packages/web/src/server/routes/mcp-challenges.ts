// The web-chat consent-card surface for pending MCP OAuth challenges (R-MO27c).
//
// MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md, §11 R-MO27(c). A
// pending challenge (an unmet authorization demand for an http MCP server)
// renders as a consent card in the web UI. This route enumerates the pending
// challenges and, under a LOOPBACK web bind, exposes the live claim path so the
// card can carry an authorize URL.
//
// Loopback gating is the load-bearing rule (R-MO27c). Under a loopback
// `WEB_BIND_HOST` (the default), the browser viewing the card is by
// construction on the machine of the daemon serving it: that daemon claims the
// challenge and acts as resolver, and the authorize URL round-trips through its
// own canonical loopback callback (R-MO27). Under a NON-loopback bind
// (`WEB_BIND_HOST=0.0.0.0`, the documented hub setting) a loopback
// `redirect_uri` is unreachable from a remote browser, so the card carries NO
// authorize affordance and instead directs the operator to `bound login
// --challenge <id>` from a local session.
import type { Database } from "bun:sqlite";
import { findPendingChallenges } from "@bound/core";
import { Hono } from "hono";
import type { OauthMcpResolverBridge } from "./oauth-mcp";

/** The loopback bind hosts that gate the live web-chat authorize path (R-MO27c). */
const LOOPBACK_BIND_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True when the web server's bind host is loopback — the only bind under which the card carries a live authorize flow (R-MO27c). */
export function isLoopbackBind(host: string): boolean {
	return LOOPBACK_BIND_HOSTS.has(host);
}

/** The per-challenge shape the consent card renders. */
interface PendingChallengeView {
	challengeId: string;
	serverName: string;
	/** Space-delimited scope demand parsed from the 401/403 (empty for a first-use 401). */
	scopeDemand: string;
	/** Terminal OAuth error retained from a prior failed attempt, else null. */
	failureReason: string | null;
}

/**
 * The pending-challenge list surface (R-MO27c). `GET /` enumerates pending
 * challenges plus the surface's `loopback` disposition so the client knows
 * whether to render a live authorize affordance or the CLI instruction. Under a
 * loopback bind, `POST /:id/claim` proxies to the resolver bridge to mint the
 * per-attempt authorize URL for the card to open; under a non-loopback bind the
 * claim path returns 409 (the card never offers it).
 *
 * `webBindHost` is the server's actual bind host, forwarded from the web server
 * config. `bridge` is the resolving host's in-process MCP OAuth resolver (the
 * same one backing the oauth-mcp callback route); null when this host runs no
 * resolver, in which case the claim path is unavailable.
 */
export function createMcpChallengesRoutes(
	db: Database,
	webBindHost: string,
	bridge: OauthMcpResolverBridge | null,
): Hono {
	const app = new Hono();
	const loopback = isLoopbackBind(webBindHost);

	app.get("/", (c) => {
		try {
			const rows = findPendingChallenges(db);
			const challenges: PendingChallengeView[] = rows.map((r) => ({
				challengeId: r.id,
				serverName: r.server_name,
				scopeDemand: r.scope_demand,
				failureReason: r.failure_reason,
			}));
			// The card reads `loopback` to decide its affordance: a live authorize
			// button (loopback) or the `bound login --challenge <id>` instruction
			// (non-loopback). Also report whether a resolver is present at all —
			// a loopback bind with no resolver still cannot mint a URL.
			return c.json({
				challenges,
				loopback,
				canResolve: loopback && bridge !== null,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to list pending challenges", details: message }, 500);
		}
	});

	app.post("/:id/claim", async (c) => {
		// R-MO27c: the live authorize flow exists ONLY under a loopback bind. A
		// callback minted for a loopback `redirect_uri` would land nowhere from a
		// remote browser, so refuse rather than hand back an unreachable URL.
		if (!loopback) {
			return c.json(
				{
					error:
						"the web consent card cannot resolve a challenge on a non-loopback bind; run `bound login --challenge <id>` from a local session",
				},
				409,
			);
		}
		if (!bridge) {
			return c.json({ error: "this host runs no MCP OAuth resolver" }, 503);
		}
		const id = c.req.param("id");
		const result = await bridge.claimForLogin({ challengeId: id });
		if (!result.ok) {
			return c.json({ error: result.error }, 400);
		}
		return c.json({ authorizeUrl: result.authorizeUrl, challengeId: result.challengeId });
	});

	return app;
}
