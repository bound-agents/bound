import type { Database } from "bun:sqlite";
import { type McpAuthChallenge, findChallengeById } from "@bound/core";
import {
	type AuthorizationServerMetadata,
	type OAuthClientInformationMixed,
	type OAuthClientMetadata,
	type OAuthProtectedResourceMetadata,
	discoverAuthorizationServerMetadata,
	discoverOAuthProtectedResourceMetadata,
	registerClient,
	startAuthorization,
} from "@modelcontextprotocol/client";
import { MCP_OAUTH_CALLBACK_PATH } from "./oauth-provider";

/**
 * Resolver-side attempt flow for an MCP OAuth challenge.
 *
 * MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md, §6/§8,
 * R-MO17 / R-MO17b / R-MO18 / R-MO25 / R-MO26 / R-MO31 / R-MO32.
 *
 * A resolver claims a `pending` challenge and, at RESOLUTION TIME (never on a
 * snapshot the row carried), performs live RFC 9728 protected-resource-metadata
 * discovery and RFC 8414 authorization-server-metadata discovery, walks the
 * registration ladder (config client_id → public-client DCR → terminal error),
 * mints FRESH PKCE + `state` (R-MO32), and builds the authorize URL whose
 * `redirect_uri` names the daemon web router's canonical callback (R-MO27) and
 * whose scope is the union of config ∪ row.granted ∪ demand (R-MO12b).
 *
 * The resolver holds AT MOST ONE live `state` per challenge (R-MO17b): minting a
 * new attempt invalidates the prior. All ephemera (state, verifier, discovery
 * metadata) are PROVIDER-LOCAL and NEVER sync (R-MO18) — they live only in this
 * in-process resolver for the duration of one attempt. The resolver NEVER
 * exchanges the code (R-MO17c); it forwards the caught outcome to the owner
 * (§8, handled by the callback route + handoff writer).
 */

/** The oauth-relevant config the resolver reads for a server (R-MO1). */
export interface ResolverServerConfig {
	name: string;
	url: string;
	scopes?: string[];
	/** Config-declared client_id (registration-ladder rung 1, R-MO25). Non-secret. */
	clientId?: string;
}

/**
 * One live resolution attempt's provider-local ephemera (R-MO18). Held in the
 * {@link McpChallengeResolver} keyed by challenge id; a fresh attempt overwrites
 * it, which is exactly the R-MO17b "at most one live state" invalidation.
 */
export interface ResolverAttempt {
	challengeId: string;
	serverName: string;
	/** Fresh per-attempt CSRF state (R-MO31/R-MO32). */
	state: string;
	/** Fresh per-attempt PKCE verifier minted by startAuthorization (R-MO32). */
	codeVerifier: string;
	/** The exact redirect_uri string used at /authorize; byte-replayed by the owner (R-MO19). */
	redirectUri: string;
	/** The canonical RFC 8707 resource used at /authorize; byte-replayed + owner-confirmed (R-MO19/R-MO20). */
	resource: string;
	/** The discovered authorization-server issuer (owner re-validates independently, R-MO20). */
	issuer: string;
	/** The registration client_id used (config or DCR result); NEVER a secret (R-MO19). */
	clientId: string;
	/** The built authorize URL for the surface to open. */
	authorizationUrl: string;
}

/** A terminal resolver-side failure that cannot forward an outcome to the owner. */
export interface ResolverError {
	kind:
		| "no_challenge"
		| "not_pending"
		| "discovery_failed"
		| "no_registration"
		| "as_metadata_failed";
	detail: string;
}

/**
 * Space-delimited union of the scope inputs (R-MO12b): config-declared scopes,
 * the currently-granted scopes carried on the row, and the newly-demanded scopes
 * from the 401/403 — so a step-up widens the grant without dropping held scopes.
 */
export function unionAttemptScopes(
	config: string[] | undefined,
	granted: string,
	demand: string,
): string {
	const seen = new Set<string>();
	for (const s of [...(config ?? []), ...granted.split(/\s+/), ...demand.split(/\s+/)]) {
		if (s.length > 0) seen.add(s);
	}
	return [...seen].join(" ");
}

/**
 * The canonical loopback callback the resolver's browser returns to (R-MO27).
 * Named at the daemon's WEB_PORT loopback; the authorization server validates it
 * by string equality on the token POST, so the owner byte-replays this exact
 * value (R-MO19/R-MO20). Injectable web port for tests / non-default deployments.
 */
export function resolverCallbackUrl(webPort = 3001): string {
	return `http://localhost:${webPort}${MCP_OAUTH_CALLBACK_PATH}`;
}

/**
 * The RFC 8707 resource indicator for a server: the canonical resource URL the
 * protected-resource metadata names, else the server URL itself. Derived per
 * attempt and byte-replayed; the owner re-derives its own and confirms equality
 * (R-MO20).
 */
export function canonicalResource(
	serverUrl: string,
	prm: OAuthProtectedResourceMetadata | undefined,
): string {
	const named = prm?.resource;
	if (typeof named === "string" && named.length > 0) return named;
	return serverUrl;
}

/** Public-client metadata for DCR (R-MO25): PKCE is the proof, no client_secret. */
function publicClientMetadata(
	server: ResolverServerConfig,
	redirectUri: string,
): OAuthClientMetadata {
	const scope = server.scopes && server.scopes.length > 0 ? server.scopes.join(" ") : undefined;
	return {
		client_name: `bound (${server.name})`,
		redirect_uris: [redirectUri],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		scope,
	};
}

/**
 * The resolver: a per-process holder of live attempt state. One instance serves
 * all challenges on a resolving host; attempts are keyed by challenge id so a
 * re-claim of the same challenge invalidates the prior attempt's `state`
 * (R-MO17b). The `fetch` and web port are injected so tests drive the whole flow
 * with stubs and no network.
 */
export class McpChallengeResolver {
	private readonly attempts = new Map<string, ResolverAttempt>();

	constructor(
		private readonly db: Database,
		private readonly resolveServerConfig: (serverName: string) => ResolverServerConfig | null,
		private readonly fetchFn: typeof fetch = globalThis.fetch,
		private readonly webPort = 3001,
	) {}

	/** The currently-awaited attempt for a challenge, or null. */
	awaitedAttempt(challengeId: string): ResolverAttempt | null {
		return this.attempts.get(challengeId) ?? null;
	}

	/**
	 * Look up the attempt an inbound callback `state` is bound to (R-MO17b). Only
	 * the currently-awaited attempt's state matches; a stale attempt's state has
	 * already been overwritten in the map and so does not match — the callback
	 * route rejects it with 400 (R-MO31).
	 */
	attemptForState(state: string): ResolverAttempt | null {
		for (const attempt of this.attempts.values()) {
			if (attempt.state === state) return attempt;
		}
		return null;
	}

	/** Discard a completed attempt's ephemera (called after the outcome is forwarded). */
	discardAttempt(challengeId: string): void {
		this.attempts.delete(challengeId);
	}

	/**
	 * Claim a pending challenge and mint a fresh resolution attempt (R-MO17). Runs
	 * live PRM (RFC 9728) + AS-metadata (RFC 8414) discovery, walks the
	 * registration ladder, mints fresh PKCE + state via the SDK's
	 * startAuthorization, and returns the attempt (authorize URL + the
	 * byte-replay fields the handoff will carry). A new attempt for a challenge
	 * that already has one INVALIDATES the prior (R-MO17b) — the map overwrite is
	 * the invalidation.
	 */
	async claim(
		challengeId: string,
	): Promise<{ ok: true; value: ResolverAttempt } | { ok: false; error: ResolverError }> {
		const row = findChallengeById(this.db, challengeId);
		if (row === null) {
			return { ok: false, error: { kind: "no_challenge", detail: `no challenge ${challengeId}` } };
		}
		if (row.status !== "pending") {
			return {
				ok: false,
				error: { kind: "not_pending", detail: `challenge ${challengeId} is ${row.status}` },
			};
		}
		const server = this.resolveServerConfig(row.server_name);
		if (server === null) {
			return {
				ok: false,
				error: { kind: "no_registration", detail: `no config for server ${row.server_name}` },
			};
		}

		const redirectUri = resolverCallbackUrl(this.webPort);

		// RFC 9728: live protected-resource-metadata discovery at resolution time.
		let prm: OAuthProtectedResourceMetadata | undefined;
		try {
			prm = await discoverOAuthProtectedResourceMetadata(
				server.url,
				row.resource_metadata_hint
					? { resourceMetadataUrl: row.resource_metadata_hint }
					: undefined,
				this.fetchFn,
			);
		} catch {
			// PRM is optional (a server may not advertise it); a hard failure is
			// non-fatal — fall back to the server URL as the authorization-server
			// seed and resource. A real discovery error surfaces on AS metadata below.
			prm = undefined;
		}

		const asSeed = prm?.authorization_servers?.[0] || server.url;

		// RFC 8414: live authorization-server-metadata discovery.
		let asMetadata: AuthorizationServerMetadata | undefined;
		try {
			asMetadata = await discoverAuthorizationServerMetadata(asSeed, { fetchFn: this.fetchFn });
		} catch (e) {
			return {
				ok: false,
				error: {
					kind: "as_metadata_failed",
					detail: `AS metadata discovery failed for ${asSeed}: ${e instanceof Error ? e.message : String(e)}`,
				},
			};
		}
		if (!asMetadata) {
			return {
				ok: false,
				error: { kind: "as_metadata_failed", detail: `no AS metadata at ${asSeed}` },
			};
		}
		const issuer = asMetadata.issuer;
		const resource = canonicalResource(server.url, prm);
		const scope = unionAttemptScopes(server.scopes, row.granted_scopes, row.scope_demand);

		// Registration ladder (R-MO25): config client_id first, else public DCR.
		const clientInformation = await this.resolveRegistration(
			server,
			asMetadata,
			redirectUri,
			scope,
		);
		if (clientInformation === null) {
			return {
				ok: false,
				error: {
					kind: "no_registration",
					detail: `server ${server.name} has no client_id and its AS advertises no registration_endpoint for DCR`,
				},
			};
		}

		// Fresh PKCE + state per attempt (R-MO32). startAuthorization mints the
		// verifier and builds the authorize URL with the RFC 8707 resource + union
		// scope; state is our own fresh anti-CSRF value bound to this attempt.
		const state = crypto.randomUUID();
		const { authorizationUrl, codeVerifier } = await startAuthorization(asSeed, {
			metadata: asMetadata,
			clientInformation,
			redirectUrl: redirectUri,
			scope,
			state,
			resource: new URL(resource),
		});

		const attempt: ResolverAttempt = {
			challengeId,
			serverName: row.server_name,
			state,
			codeVerifier,
			redirectUri,
			resource,
			issuer,
			clientId: clientInformation.client_id,
			authorizationUrl: authorizationUrl.toString(),
		};
		// R-MO17b: overwrite invalidates any prior live attempt for this challenge.
		this.attempts.set(challengeId, attempt);
		return { ok: true, value: attempt };
	}

	/**
	 * Registration ladder (R-MO25): a config-declared client_id wins; otherwise
	 * register a PUBLIC client via DCR against the AS `registration_endpoint`. The
	 * DCR result is a non-secret client_id carried in the handoff and cached by
	 * the OWNER (R-MO19/R-MO25) — the resolver keeps no durable registration.
	 * Returns null when neither rung applies (no config id AND no DCR endpoint):
	 * a terminal, actionable registration gap.
	 */
	private async resolveRegistration(
		server: ResolverServerConfig,
		asMetadata: AuthorizationServerMetadata,
		redirectUri: string,
		scope: string,
	): Promise<OAuthClientInformationMixed | null> {
		if (server.clientId) {
			return { client_id: server.clientId };
		}
		if (!asMetadata.registration_endpoint) {
			return null;
		}
		try {
			const full = await registerClient(asMetadata.issuer, {
				metadata: asMetadata,
				clientMetadata: publicClientMetadata(server, redirectUri),
				scope: scope || undefined,
				fetchFn: this.fetchFn,
			});
			return full;
		} catch {
			return null;
		}
	}
}

/** Re-export the challenge type for callers that build a resolver over a row. */
export type { McpAuthChallenge };
