import type { Database } from "bun:sqlite";
import type { ChallengeDemand } from "@bound/core";
import {
	type OAuthClientMetadata,
	type OAuthDiscoveryState,
	OAuthError,
	OAuthErrorCode,
	type StoredOAuthClientInformation,
	type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {
	type RaiseDebouncer,
	type RaiseOutcome,
	parseWwwAuthenticate,
	raiseAuthChallenge,
} from "./raise";
import type { McpTokenBundle, McpTokenStore } from "./token-store";

/**
 * Owner-side v2 `OAuthClientProvider` for an http MCP server.
 *
 * MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md, §6/§9, R-MO2 /
 * R-MO10 / R-MO23. Backs `tokens()`/`saveTokens()` with the per-host
 * {@link McpTokenStore}, persists PKCE/discovery ephemera per-server, and — the
 * load-bearing owner deviation — turns `redirectToAuthorization` into a
 * challenge RAISE rather than a browser open (R-MO10): the provider records the
 * demand and throws {@link AuthChallengeRaisedError}, so the transport's call
 * fails fast into the raise path and the tool call settles immediately with the
 * `auth_challenge_raised` outcome (R-MO11).
 *
 * NOTE the SDK's `redirectToAuthorization(url)` receives the fully-built
 * authorize URL, but the owner never has an observed 401/403 header at that
 * point — the demand it raises is built from config plus whatever last-observed
 * challenge the caller stashed via {@link noteObservedChallenge}. The provider
 * is instantiated per (server, owning host); a single loop's callTool wrapper
 * catches the throw and maps it to the outcome text.
 */

/** The v2 loopback callback path all resolvers catch on (R-MO27). Replayed byte-for-byte in slice 3. */
export const MCP_OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";

/** The daemon web-router port (WEB_PORT, loopback) the callback lands on (R-MO27). */
export const MCP_OAUTH_CALLBACK_URL = `http://localhost:3001${MCP_OAUTH_CALLBACK_PATH}`;

/**
 * Thrown from `redirectToAuthorization` (R-MO10): the owner does not open a
 * browser, it raises a challenge and fails the call fast. The callTool wrapper
 * catches this and produces the `auth_challenge_raised` tool result.
 */
export class AuthChallengeRaisedError extends Error {
	constructor(
		readonly challengeId: string,
		/** The `auth_challenge_raised` outcome text (R-MO11). */
		readonly outcomeText: string,
	) {
		super(`MCP OAuth challenge raised: ${challengeId}`);
		this.name = "AuthChallengeRaisedError";
	}
}

/** The oauth-relevant slice of an http MCP server config (R-MO1). */
export interface McpOAuthServerConfig {
	name: string;
	url: string;
	scopes?: string[];
	clientId?: string;
	clientSecret?: string;
}

/** An observed 401/403 the provider folds into the demand it raises (R-MO6). */
export interface ObservedChallenge {
	scopeDemand: string;
	resourceMetadataHint: string | null;
}

/** OAuth codes that mean the stored grant or client is dead, not temporarily unreachable. */
const TERMINAL_GRANT_ERRORS = new Set<string>([
	OAuthErrorCode.InvalidGrant,
	OAuthErrorCode.InvalidClient,
	OAuthErrorCode.UnauthorizedClient,
]);

/** The WARN sink the provider logs invalidations to; `Logger` satisfies it. */
export interface McpOAuthLogger {
	warn(message: string, meta?: Record<string, unknown>): void;
}

/** The last non-2xx response a token-endpoint request got, as observed on the transport fetch. */
export interface TokenEndpointFailure {
	status: number;
	/** The response body's OAuth `error` code, when the body is OAuth JSON. */
	oauthError?: string;
	/** origin + pathname of the request URL; the query string is dropped. */
	tokenEndpoint?: string;
}

/**
 * A URL as it may be logged: origin + pathname only. The query string and
 * fragment are dropped so a credential carried there never reaches a log line.
 * Returns undefined for anything that does not parse as a URL.
 */
export function endpointForLog(url: string | URL | undefined | null): string | undefined {
	if (url === undefined || url === null) return undefined;
	try {
		const u = new URL(String(url));
		return `${u.origin}${u.pathname}`;
	} catch {
		return undefined;
	}
}

function requestUrl(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** The first OAuthError on an error's cause chain (the transport may wrap it). */
function findOAuthError(error: unknown): OAuthError | null {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current; depth++) {
		if (current instanceof OAuthError) return current;
		current = (current as { cause?: unknown }).cause;
	}
	return null;
}

/**
 * Structured log fields for an MCP connect failure (#318). An OAuthError yields
 * `oauthError` (its `.code` — `.message` is only the server's description), the
 * `tokenEndpoint` (from the observed token request, else cached discovery
 * metadata; query stripped), and the observed HTTP `status` when the provider
 * saw the failing response. Anything else yields `{}`, so non-OAuth records
 * stay exactly `{ error }`. Never includes token, secret, code, or verifier values.
 */
export function oauthLogFields(error: unknown, provider?: unknown): Record<string, unknown> {
	const oauth = findOAuthError(error);
	if (!oauth) return {};
	const fields: Record<string, unknown> = { oauthError: oauth.code };
	if (!(provider instanceof McpOAuthProvider)) return fields;
	const failure = provider.lastTokenEndpointFailure();
	const tokenEndpoint = failure?.tokenEndpoint ?? provider.tokenEndpointForLog();
	if (tokenEndpoint) fields.tokenEndpoint = tokenEndpoint;
	// The observed status belongs to this error only when the codes agree (a
	// non-JSON body parses to server_error with no recorded code).
	if (failure && (failure.oauthError === undefined || failure.oauthError === oauth.code)) {
		fields.status = failure.status;
	}
	return fields;
}

export class McpOAuthProvider {
	private observed: ObservedChallenge | null = null;
	private lastRaise: RaiseOutcome | null = null;
	private tokenFailure: TokenEndpointFailure | null = null;

	constructor(
		private readonly db: Database,
		private readonly store: McpTokenStore,
		private readonly server: McpOAuthServerConfig,
		private readonly owningSiteId: string,
		private readonly debouncer: RaiseDebouncer,
		private readonly logger?: McpOAuthLogger,
	) {}

	/**
	 * Wrap the transport fetch so a failed token-endpoint request is recorded
	 * (#318): `invalidateCredentials` never receives the SDK's error, so the
	 * provider captures the rejected response's status and OAuth `error` code
	 * where it can see it. A token request is a form POST carrying `grant_type`.
	 * Only the status, the `error` code, and the query-stripped URL are kept;
	 * request bodies (refresh tokens, codes, verifiers, secrets) are never read.
	 */
	observeFetch(base?: typeof fetch): typeof fetch {
		const observed = async (
			input: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			const isTokenRequest = init?.body instanceof URLSearchParams && init.body.has("grant_type");
			if (isTokenRequest) this.tokenFailure = null;
			const response = await (base ?? globalThis.fetch)(input, init);
			if (isTokenRequest && !response.ok) {
				let oauthError: string | undefined;
				try {
					const body = (await response.clone().json()) as { error?: unknown };
					if (typeof body?.error === "string") oauthError = body.error;
				} catch {
					// Not OAuth JSON; the status alone is recorded.
				}
				this.tokenFailure = {
					status: response.status,
					oauthError,
					tokenEndpoint: endpointForLog(requestUrl(input)),
				};
			}
			return response;
		};
		return observed as typeof fetch;
	}

	/** The last failed token-endpoint response the observed fetch saw, if any. */
	lastTokenEndpointFailure(): TokenEndpointFailure | null {
		return this.tokenFailure;
	}

	/** The cached discovery token endpoint, query stripped, when known. */
	tokenEndpointForLog(): string | undefined {
		return endpointForLog(this.discoveryState()?.authorizationServerMetadata?.token_endpoint);
	}

	/**
	 * Log fields for the last failed token-endpoint response, or `{}` when the
	 * observed fetch saw none. The connect site attaches these to the "needs
	 * authorization" line so a raised challenge records why (#318).
	 */
	tokenFailureLogFields(): Record<string, unknown> {
		return this.tokenFailure ? this.observedFailureFields() : {};
	}

	private observedFailureFields(): Record<string, unknown> {
		const f = this.tokenFailure;
		const fields: Record<string, unknown> = {};
		if (f?.oauthError) fields.oauthError = f.oauthError;
		const tokenEndpoint = f?.tokenEndpoint ?? this.tokenEndpointForLog();
		if (tokenEndpoint) fields.tokenEndpoint = tokenEndpoint;
		if (f) fields.status = f.status;
		return fields;
	}

	private async invalidateWithReason(
		scope: "all" | "client" | "tokens" | "verifier" | "discovery",
		fields: Record<string, unknown>,
	): Promise<void> {
		this.logger?.warn(`[mcp-oauth] invalidating ${scope} credentials for ${this.server.name}`, {
			server: this.server.name,
			scope,
			...fields,
		});
		await this.store.invalidate(this.server.name, scope, this.issuer());
	}

	/**
	 * Record the demand observed on a real 401/403 (parsed WWW-Authenticate),
	 * so the challenge the SDK's `redirectToAuthorization` triggers carries the
	 * owner's own observation of the failure (R-MO6). Called by the callTool
	 * wrapper before it lets the SDK re-run auth.
	 */
	noteObservedChallenge(header: string | null | undefined): void {
		const parsed = parseWwwAuthenticate(header);
		this.observed = {
			scopeDemand: parsed.scope,
			resourceMetadataHint: parsed.resourceMetadata,
		};
	}

	/** The outcome of the most recent raise, for the callTool wrapper to surface. */
	takeLastRaise(): RaiseOutcome | null {
		const r = this.lastRaise;
		this.lastRaise = null;
		return r;
	}

	private scopesString(): string {
		return this.server.scopes && this.server.scopes.length > 0 ? this.server.scopes.join(" ") : "";
	}

	private currentGrantedScopes(): string {
		return this.store.getBundle(this.server.name)?.scopes ?? "";
	}

	private buildDemand(): ChallengeDemand {
		// Scope demand: the observed 401/403 scope if present, else the config
		// scopes (a first-use 401 with no scope param).
		const observedScope = this.observed?.scopeDemand ?? "";
		return {
			serverName: this.server.name,
			owningSiteId: this.owningSiteId,
			serverUrl: this.server.url,
			scopeDemand: observedScope.length > 0 ? observedScope : this.scopesString(),
			grantedScopes: this.currentGrantedScopes(),
			resourceMetadataHint: this.observed?.resourceMetadataHint ?? null,
			clientId: this.server.clientId ?? null,
		};
	}

	// --- OAuthClientProvider surface ------------------------------------

	get redirectUrl(): string {
		return MCP_OAUTH_CALLBACK_URL;
	}

	get clientMetadata(): OAuthClientMetadata {
		// Every registration bound performs is a PUBLIC client (R-MO25): PKCE is
		// the proof, no client_secret is requested. A confidential client is
		// supported only via operator pre-registration (config client_id +
		// owner-config client_secret, R-MO4) — never minted here.
		return {
			client_name: `bound (${this.server.name})`,
			redirect_uris: [MCP_OAUTH_CALLBACK_URL],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			scope: this.scopesString() || undefined,
		};
	}

	clientInformation(ctx?: { issuer: string }): StoredOAuthClientInformation | undefined {
		// Config-declared client_id wins (registration ladder rung 1, R-MO25).
		if (this.server.clientId) {
			return { client_id: this.server.clientId };
		}
		// Else a cached DCR registration keyed by AS issuer (rung 2).
		if (ctx?.issuer) {
			const reg = this.store.getRegistration(ctx.issuer);
			if (reg) return { client_id: reg.clientId };
		}
		return undefined;
	}

	async saveClientInformation(
		info: StoredOAuthClientInformation,
		ctx?: { issuer: string },
	): Promise<void> {
		const issuer = ctx?.issuer ?? info.issuer;
		if (!issuer) return;
		await this.store.saveRegistration(issuer, { clientId: info.client_id });
	}

	tokens(_ctx?: { issuer: string }): StoredOAuthTokens | undefined {
		const bundle = this.store.getBundle(this.server.name);
		if (!bundle || bundle.accessToken === "") return undefined;
		return {
			access_token: bundle.accessToken,
			token_type: "Bearer",
			refresh_token: bundle.refreshToken,
			scope: bundle.scopes || undefined,
			issuer: bundle.issuer,
		};
	}

	/** R-MO23: propagate a persistence failure — never leave an in-memory token the disk lacks. */
	async saveTokens(tokens: StoredOAuthTokens, _ctx?: { issuer: string }): Promise<void> {
		const bundle: McpTokenBundle = {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			scopes: typeof tokens.scope === "string" ? tokens.scope : this.scopesString(),
			accessTokenExpiresAt:
				Date.now() + (typeof tokens.expires_in === "number" ? tokens.expires_in * 1000 : 3600_000),
			issuer: tokens.issuer,
		};
		// saveBundle rejects on a persistence failure; the throw propagates to
		// the SDK caller, which is the contract R-MO23 requires.
		await this.store.saveBundle(this.server.name, bundle);
	}

	/**
	 * SDK hook (#299): the authorization server rejected stored credentials with
	 * a terminal OAuth error (`invalid_grant` → `tokens`; `invalid_client` /
	 * `unauthorized_client` → `client` then `tokens`). The SDK gates the call on
	 * those codes, so transient failures (5xx, 429, network) never reach here.
	 * Clearing durably means the SDK's retry sees no refresh token and falls
	 * through to {@link redirectToAuthorization}, which raises a fresh challenge
	 * instead of replaying the rejected grant.
	 */
	async invalidateCredentials(
		scope: "all" | "client" | "tokens" | "verifier" | "discovery",
	): Promise<void> {
		// The SDK passes only the scope; the reason comes from the token-endpoint
		// response the observed fetch recorded (#318).
		await this.invalidateWithReason(scope, this.observedFailureFields());
	}

	/**
	 * Map an error that escaped the SDK's auth flow to a fresh challenge when it
	 * is a terminal OAuth rejection of the stored grant (#299): `invalid_grant`,
	 * `invalid_client`, or `unauthorized_client`. Clears the stored tokens and
	 * takes the same raise path as {@link redirectToAuthorization}. Any other
	 * error — network, 5xx, 429, `temporarily_unavailable`, non-OAuth — returns
	 * null and leaves credentials untouched, so a transient outage never costs
	 * the operator a re-consent.
	 */
	async raiseIfGrantLost(error: unknown): Promise<AuthChallengeRaisedError | null> {
		if (!(error instanceof OAuthError) || !TERMINAL_GRANT_ERRORS.has(error.code)) return null;
		const fields = oauthLogFields(error, this);
		if (error.code !== OAuthErrorCode.InvalidGrant)
			await this.invalidateWithReason("client", fields);
		await this.invalidateWithReason("tokens", fields);
		try {
			this.redirectToAuthorization(new URL(this.server.url));
		} catch (e) {
			if (e instanceof AuthChallengeRaisedError) return e;
			throw e;
		}
		return null;
	}

	private issuer(): string | undefined {
		const bundle = this.store.getBundle(this.server.name);
		const state = bundle?.discoveryState as OAuthDiscoveryState | undefined;
		return (
			bundle?.issuer ?? state?.authorizationServerMetadata?.issuer ?? state?.authorizationServerUrl
		);
	}

	/**
	 * R-MO10: DO NOT open a browser. Raise (or re-raise, debounced) a challenge
	 * row from the owner's config + observed 401/403, then throw so the
	 * transport's call fails fast into the raise path. The authorize URL the SDK
	 * built is discarded here — the resolver mints its own per-attempt URL in
	 * slice 3.
	 */
	redirectToAuthorization(_authorizationUrl: URL): void {
		const outcome = raiseAuthChallenge(
			this.db,
			this.buildDemand(),
			this.owningSiteId,
			this.debouncer,
		);
		this.lastRaise = outcome;
		throw new AuthChallengeRaisedError(outcome.challengeId, outcome.text);
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		await this.store.saveCodeVerifier(this.server.name, codeVerifier);
	}

	codeVerifier(): string {
		const v = this.store.getBundle(this.server.name)?.codeVerifier;
		if (!v) throw new Error(`No PKCE code verifier persisted for MCP server "${this.server.name}"`);
		return v;
	}

	async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
		await this.store.saveDiscoveryState(this.server.name, state);
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.store.getBundle(this.server.name)?.discoveryState as
			OAuthDiscoveryState | undefined;
	}
}
