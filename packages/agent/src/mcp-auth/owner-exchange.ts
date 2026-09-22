import type { Database } from "bun:sqlite";
import { type McpAuthChallenge, findChallengeById, markFailed, markResolved } from "@bound/core";
import type { mcpAuthHandoffPayloadSchema } from "@bound/shared";
import {
	type AuthorizationServerMetadata,
	type OAuthClientInformationMixed,
	assertSecureTokenEndpoint,
	discoverAuthorizationServerMetadata,
	discoverOAuthProtectedResourceMetadata,
	exchangeAuthorization,
} from "@modelcontextprotocol/client";
import type { z } from "zod";
import { canonicalResource } from "./resolver";
import { type McpTokenBundle, type McpTokenStore, classifyTokenEndpointError } from "./token-store";

/**
 * Owner-side consumption of a resolver → owner handoff (§8, R-MO20/R-MO21).
 *
 * MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md, §8.
 *
 * The owning host — and ONLY it — performs the code-for-token exchange with its
 * own client credentials. Consumption is exactly-once (the caller token-fences
 * the durable_work claim) and idempotent per challenge: a handoff for a
 * challenge already `resolved` is dropped without exchange (R-MO20). Before
 * exchanging, the owner INDEPENDENTLY validates the issuer (discovers AS
 * metadata from its own seed, confirms the token endpoint belongs to the
 * issuer) and confirms the handoff `resource` against the resource it derives
 * from its own config — a mismatch dead-letters (R-MO20). It byte-replays the
 * `redirect_uri` and `resource` on the token POST (R-MO19) with its own
 * client_secret (if configured). On success it saves the bundle (the store
 * unions scopes) and flips the row `resolved`; on a terminal token-endpoint
 * error it marks `failed`. An error-outcome handoff is classified here
 * (R-MO17c) — the resolver never classifies.
 */

export type McpAuthHandoffPayload = z.infer<typeof mcpAuthHandoffPayloadSchema>;

/** The owner's config for a server: url + client credentials it holds (R-MO4). */
export interface OwnerServerConfig {
	name: string;
	url: string;
	scopes?: string[];
	clientId?: string;
	/** The confidential-client secret; owner-host config only, NEVER handed off (R-MO30). */
	clientSecret?: string;
}

/** The disposition of a consumed handoff. */
export type ExchangeOutcome =
	| { kind: "resolved"; grantedScopes: string }
	| { kind: "failed"; reason: string }
	| { kind: "dropped"; reason: string }
	| { kind: "dead_letter"; reason: string };

/**
 * Terminal authorize-leg error codes (R-MO17c): a denial is an answer. Any code
 * OUTSIDE the transient set defaults to terminal (the deliberate asymmetry with
 * the token endpoint's default-to-transient) — an unrecognized authorize-leg
 * code is more likely a mis-request or unhandleable interactive demand than a
 * transient outage.
 */
const TRANSIENT_AUTHORIZE_ERRORS = new Set(["temporarily_unavailable", "server_error"]);

/**
 * Classify an authorize-leg error code (R-MO17c). Transient → the attempt is
 * discarded and the row stays `pending`; terminal (everything else, incl.
 * unlisted) → the row is marked `failed` with the raw code.
 */
export function classifyAuthorizeError(errorCode: string): "terminal" | "transient" {
	return TRANSIENT_AUTHORIZE_ERRORS.has(errorCode) ? "transient" : "terminal";
}

/**
 * Consume one handoff (R-MO20). `siteId` is the owner's own site id (the writer
 * of every status transition, R-MO8a). `resolveConfig` reads the owner's config
 * for the named server; `reconnect` re-runs MCP connect for a server that failed
 * connect-time auth (R-MO13b) — called only on the resolved path. `fetchFn` is
 * injected so tests drive the exchange with a stub and no network.
 *
 * Returns the disposition so the durable_work consumer knows whether to ack
 * (resolved / failed / dropped — all terminal for the row) or dead-letter.
 */
export async function consumeHandoff(
	db: Database,
	payload: McpAuthHandoffPayload,
	deps: {
		siteId: string;
		store: McpTokenStore;
		resolveConfig: (serverName: string) => OwnerServerConfig | null;
		reconnect?: (serverName: string) => Promise<void> | void;
		fetchFn?: typeof fetch;
		now?: () => number;
	},
): Promise<ExchangeOutcome> {
	const fetchFn = deps.fetchFn ?? globalThis.fetch;
	const now = deps.now ?? Date.now;

	const row = findChallengeById(db, payload.challenge_id);
	if (row === null) {
		return { kind: "dropped", reason: `no challenge ${payload.challenge_id}` };
	}
	// Idempotent per challenge (R-MO20): a handoff for an already-resolved
	// challenge is dropped without exchange — the second code is never burned.
	if (row.status === "resolved") {
		return { kind: "dropped", reason: "challenge already resolved" };
	}

	// Error-outcome consumption (R-MO17c): the owner classifies.
	if (payload.error) {
		const cls = classifyAuthorizeError(payload.error);
		if (cls === "transient") {
			// Discard the attempt; the row stays pending (no status write).
			return { kind: "dropped", reason: `transient authorize error ${payload.error}` };
		}
		const reason = payload.error_description
			? `${payload.error}: ${payload.error_description}`
			: payload.error;
		// Guarded pending → failed (dropped without effect if a concurrent attempt resolved).
		markFailed(db, payload.challenge_id, reason, deps.siteId);
		return { kind: "failed", reason };
	}

	// Success path requires a code + verifier + byte-replay fields.
	if (!payload.code || !payload.code_verifier || !payload.redirect_uri) {
		return { kind: "dead_letter", reason: "code handoff missing code/verifier/redirect_uri" };
	}

	const config = deps.resolveConfig(payload.server_name);
	if (config === null) {
		return { kind: "dead_letter", reason: `owner has no config for server ${payload.server_name}` };
	}

	// Owner-side resource confirmation (R-MO20): derive the canonical resource
	// from the owner's own config and confirm the handoff matches. A mismatch
	// dead-letters rather than minting a mis-audienced token.
	let ownerPrm: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>> | undefined;
	try {
		ownerPrm = await discoverOAuthProtectedResourceMetadata(config.url, undefined, fetchFn);
	} catch {
		ownerPrm = undefined;
	}
	const ownerResource = canonicalResource(config.url, ownerPrm);
	if (payload.resource !== undefined && payload.resource !== ownerResource) {
		return {
			kind: "dead_letter",
			reason: `resource mismatch: handoff ${payload.resource} != owner-derived ${ownerResource}`,
		};
	}

	// Independent issuer validation (R-MO20): discover AS metadata from the
	// owner's own seed and confirm the token endpoint belongs to the issuer
	// (RFC 9207 issuer consistency). Do not act on the resolver's word.
	const asSeed = ownerPrm?.authorization_servers?.[0] || config.url;
	let asMetadata: AuthorizationServerMetadata | undefined;
	try {
		asMetadata = await discoverAuthorizationServerMetadata(asSeed, { fetchFn });
	} catch (e) {
		return {
			kind: "dead_letter",
			reason: `owner AS metadata discovery failed: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
	if (!asMetadata) {
		return { kind: "dead_letter", reason: `owner found no AS metadata at ${asSeed}` };
	}
	if (payload.issuer !== undefined && asMetadata.issuer !== payload.issuer) {
		return {
			kind: "dead_letter",
			reason: `issuer mismatch: handoff ${payload.issuer} != owner-discovered ${asMetadata.issuer}`,
		};
	}
	if (!asMetadata.token_endpoint) {
		return { kind: "dead_letter", reason: "owner AS metadata carries no token_endpoint" };
	}
	try {
		// RFC 9207 / secure-endpoint: the token endpoint must be HTTPS and belong
		// to the issuer origin the owner discovered.
		assertSecureTokenEndpoint(asMetadata.token_endpoint);
		const tokenOrigin = new URL(asMetadata.token_endpoint).origin;
		const issuerOrigin = new URL(asMetadata.issuer).origin;
		if (tokenOrigin !== issuerOrigin) {
			return {
				kind: "dead_letter",
				reason: `token endpoint ${tokenOrigin} does not belong to issuer ${issuerOrigin}`,
			};
		}
	} catch (e) {
		return {
			kind: "dead_letter",
			reason: `insecure/invalid token endpoint: ${e instanceof Error ? e.message : String(e)}`,
		};
	}

	// The owner's client identity (R-MO20): config client_id (+ optional secret).
	// A public client (DCR client_id from the handoff) carries no secret.
	const clientInformation: OAuthClientInformationMixed = config.clientId
		? config.clientSecret
			? { client_id: config.clientId, client_secret: config.clientSecret }
			: { client_id: config.clientId }
		: { client_id: payload.client_id ?? "" };
	if (!clientInformation.client_id) {
		return { kind: "dead_letter", reason: "no client_id available for exchange" };
	}

	// Byte-replay redirect_uri + resource on the token POST (R-MO19/R-MO20). The
	// AS validates both by string equality against what it saw at /authorize.
	try {
		const tokens = await exchangeAuthorization(asSeed, {
			metadata: asMetadata,
			clientInformation,
			authorizationCode: payload.code,
			codeVerifier: payload.code_verifier,
			redirectUri: payload.redirect_uri,
			resource: payload.resource ? new URL(payload.resource) : undefined,
			fetchFn,
		});

		const fallbackScopes = config.scopes && config.scopes.length > 0 ? config.scopes.join(" ") : "";
		const scopes =
			typeof tokens.scope === "string" && tokens.scope.length > 0 ? tokens.scope : fallbackScopes;
		const expiresInMs = typeof tokens.expires_in === "number" ? tokens.expires_in * 1000 : 3600_000;
		const bundle: McpTokenBundle = {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			scopes,
			accessTokenExpiresAt: now() + expiresInMs,
			// exchangeAuthorization returns OAuthTokens without an issuer stamp; the
			// issuer is the AS metadata's issuer the owner independently validated.
			issuer: asMetadata.issuer,
		};
		// saveBundle unions scopes on write, so a resolution never narrows a
		// previously-held grant (R-MO20 custody clause).
		await deps.store.saveBundle(payload.server_name, bundle);
		// Union what the store now holds for the resolved row's granted_scopes.
		const persisted = deps.store.getBundle(payload.server_name);
		const grantedScopes = persisted?.scopes ?? scopes;
		markResolved(db, payload.challenge_id, deps.siteId, { grantedScopes });

		// R-MO13b: re-run connect for a server that failed connect-time auth, so
		// the next call rides an authenticated session.
		if (deps.reconnect) {
			try {
				await deps.reconnect(payload.server_name);
			} catch {
				// A reconnect failure does not un-resolve the grant; the next call
				// re-attempts connect on its own.
			}
		}
		return { kind: "resolved", grantedScopes };
	} catch (e) {
		// Classify the token-endpoint failure by its OAuth error body (R-MO12).
		const errorCode = extractOAuthErrorCode(e);
		const cls = classifyTokenEndpointError(errorCode);
		if (cls === "terminal") {
			const reason = errorCode ?? "invalid_grant";
			markFailed(db, payload.challenge_id, reason, deps.siteId);
			return { kind: "failed", reason };
		}
		// Transient token-endpoint failure: leave the row pending, dead-letter the
		// handoff row for redrive (the code is likely dead, but the row is not our
		// to un-resolve; a fresh use raises a fresh challenge, R-MO21).
		return {
			kind: "dead_letter",
			reason: `transient token-endpoint error: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

/**
 * Pull an RFC 6749 §5.2 error code out of an SDK exchange throw. The v2 SDK
 * raises `OAuthError` / `OAuthClientFlowError` whose message or `.errorCode`
 * carries the code; fall back to scanning the message for the terminal codes.
 */
function extractOAuthErrorCode(e: unknown): string | undefined {
	if (typeof e === "object" && e !== null) {
		const rec = e as Record<string, unknown>;
		if (typeof rec.errorCode === "string") return rec.errorCode;
		if (typeof rec.error === "string") return rec.error;
	}
	const msg = e instanceof Error ? e.message : String(e);
	for (const code of ["invalid_grant", "invalid_client"]) {
		if (msg.includes(code)) return code;
	}
	return undefined;
}

export type { McpAuthChallenge };
