/**
 * ChatGPT-account OAuth core — the auth machinery behind "Sign in with ChatGPT".
 *
 * This is the subscription-auth path (NOT the api.openai.com API-key path):
 * an OAuth 2.0 Authorization Code + PKCE flow against `auth.openai.com`,
 * yielding an access_token (JWT) usable as a Bearer against the ChatGPT
 * backend Responses API, plus a rotating refresh_token and an id_token whose
 * claims carry the mandatory `chatgpt-account-id`.
 *
 * The module is pure over an injected `fetch` and a `now()` clock so the whole
 * flow — PKCE derivation, code exchange, refresh-with-rotation, expiry gating —
 * is unit-testable with no network and no wall-clock. The one impure edge, the
 * loopback browser capture, lives in the `login` command, not here.
 *
 * Modeled after OpenAI Codex CLI (codex-rs/login) and its reimplementations
 * (openclaw, cliproxyapi, the `codex-oauth` Rust crate). The client_id is a
 * PUBLIC client shared across those tools — PKCE, not a secret, is the proof.
 */

import { createHash, randomBytes } from "node:crypto";

/** Public OAuth client id used by Codex CLI and compatible tools. */
export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CHATGPT_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Loopback callback Codex binds; matched exactly by the authorization server. */
export const CHATGPT_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CHATGPT_OAUTH_SCOPE = "openid profile email offline_access";
/** The ChatGPT-backend Responses API base — NOT api.openai.com. */
export const CHATGPT_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";

/**
 * Refresh this many milliseconds BEFORE the access token's `exp`, so an
 * in-flight request never races the boundary. Codex refreshes proactively
 * during use; we mirror that with a skew window.
 */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

/** base64url without padding, per RFC 7636. */
function base64url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface PkcePair {
	verifier: string;
	challenge: string;
}

/**
 * Generate a PKCE code_verifier (43-char base64url of 32 random bytes) and its
 * S256 code_challenge = base64url(sha256(verifier)).
 */
export function generatePkce(): PkcePair {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

/** Opaque anti-CSRF state, echoed back on the callback. */
export function generateState(): string {
	return base64url(randomBytes(32));
}

/** Build the browser authorize URL for a fresh PKCE + state. */
export function buildAuthorizeUrl(params: { pkce: PkcePair; state: string }): string {
	const url = new URL(CHATGPT_OAUTH_AUTHORIZE_URL);
	url.searchParams.set("client_id", CHATGPT_OAUTH_CLIENT_ID);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", CHATGPT_OAUTH_REDIRECT_URI);
	url.searchParams.set("scope", CHATGPT_OAUTH_SCOPE);
	url.searchParams.set("state", params.state);
	url.searchParams.set("code_challenge", params.pkce.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

/** Claims we extract from the id_token JWT. `chatgpt_account_id` is load-bearing. */
export interface ChatGptIdClaims {
	chatgptAccountId?: string;
	chatgptPlanType?: string;
	chatgptUserId?: string;
	email?: string;
}

/**
 * The persisted token bundle. `accessTokenExpiresAt` is an absolute epoch-ms
 * derived from the access_token's `exp` claim at store time so expiry gating
 * never depends on a separately-stored `expires_in` + write timestamp.
 */
export interface ChatGptTokens {
	accessToken: string;
	refreshToken: string;
	idToken: string;
	accountId: string;
	accessTokenExpiresAt: number;
}

/** Raw JSON shape returned by the token endpoint. */
interface TokenEndpointResponse {
	access_token: string;
	refresh_token?: string;
	id_token: string;
	expires_in?: number;
	token_type?: string;
}

/**
 * Decode a JWT payload (middle segment) without signature verification. This is
 * for LOCAL claim extraction only — never a security/authorization decision.
 * OpenAI signs these; we consume them purely to read `chatgpt_account_id` +
 * `exp`, and the tokens are only ever sent back to OpenAI's own backend.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
	const parts = jwt.split(".");
	if (parts.length !== 3) {
		throw new Error("invalid JWT: expected three dot-separated segments");
	}
	const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
	const json = Buffer.from(payload, "base64").toString("utf8");
	const parsed = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("invalid JWT payload: not an object");
	}
	return parsed as Record<string, unknown>;
}

/**
 * Extract the ChatGPT claims from an id_token. Codex nests the account fields
 * under an `auth` claim (`https://api.openai.com/auth` in some issuers), with
 * `chatgpt_account_id` / `chatgpt_plan_type` / `chatgpt_user_id`. Email is
 * either top-level or under `profile`. We read both nestings defensively.
 */
export function extractIdClaims(idToken: string): ChatGptIdClaims {
	const payload = decodeJwtPayload(idToken);
	const authClaim =
		(payload.auth as Record<string, unknown> | undefined) ??
		(payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined);
	const profile = payload.profile as Record<string, unknown> | undefined;
	const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
	return {
		chatgptAccountId: asString(authClaim?.chatgpt_account_id),
		chatgptPlanType: asString(authClaim?.chatgpt_plan_type),
		chatgptUserId: asString(authClaim?.chatgpt_user_id) ?? asString(authClaim?.user_id),
		email: asString(payload.email) ?? asString(profile?.email),
	};
}

/** Read the access_token's `exp` (seconds) → absolute epoch-ms, or 0 if absent. */
function accessTokenExpiryMs(accessToken: string): number {
	try {
		const payload = decodeJwtPayload(accessToken);
		const exp = payload.exp;
		return typeof exp === "number" ? exp * 1000 : 0;
	} catch {
		return 0;
	}
}

/** Assemble a `ChatGptTokens` from a raw endpoint response + a prior refresh token. */
function toTokens(res: TokenEndpointResponse, priorRefreshToken?: string): ChatGptTokens {
	const claims = extractIdClaims(res.id_token);
	if (!claims.chatgptAccountId) {
		throw new Error(
			"id_token is missing chatgpt_account_id — the ChatGPT-account path requires it as the chatgpt-account-id header",
		);
	}
	// Refresh responses may omit a new refresh_token; per RFC 6749 the prior one
	// stays valid then. But OpenAI ROTATES on refresh, so prefer the new one.
	const refreshToken = res.refresh_token ?? priorRefreshToken;
	if (!refreshToken) {
		throw new Error("token response has no refresh_token and none was carried forward");
	}
	// Prefer the JWT `exp`; fall back to expires_in only if the token is opaque.
	const jwtExpiry = accessTokenExpiryMs(res.access_token);
	const accessTokenExpiresAt =
		jwtExpiry > 0 ? jwtExpiry : Date.now() + (res.expires_in ?? 0) * 1000;
	return {
		accessToken: res.access_token,
		refreshToken,
		idToken: res.id_token,
		accountId: claims.chatgptAccountId,
		accessTokenExpiresAt,
	};
}

export interface AuthCoreDeps {
	fetch: typeof fetch;
	now?: () => number;
}

/**
 * Exchange an authorization code (+ the PKCE verifier that produced the
 * challenge) for the initial token bundle.
 */
export async function exchangeCodeForTokens(
	deps: AuthCoreDeps,
	params: { code: string; codeVerifier: string },
): Promise<ChatGptTokens> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: CHATGPT_OAUTH_CLIENT_ID,
		code: params.code,
		redirect_uri: CHATGPT_OAUTH_REDIRECT_URI,
		code_verifier: params.codeVerifier,
	});
	const res = await deps.fetch(CHATGPT_OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`token exchange failed: ${res.status} ${res.statusText} ${detail}`.trim());
	}
	const json = (await res.json()) as TokenEndpointResponse;
	return toTokens(json);
}

/**
 * Refresh an expired/expiring token bundle. Refresh tokens ROTATE — the caller
 * MUST persist the returned bundle so the next refresh uses the new token.
 */
export async function refreshTokens(
	deps: AuthCoreDeps,
	current: ChatGptTokens,
): Promise<ChatGptTokens> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: CHATGPT_OAUTH_CLIENT_ID,
		refresh_token: current.refreshToken,
		scope: CHATGPT_OAUTH_SCOPE,
	});
	const res = await deps.fetch(CHATGPT_OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`token refresh failed: ${res.status} ${res.statusText} ${detail}`.trim());
	}
	const json = (await res.json()) as TokenEndpointResponse;
	return toTokens(json, current.refreshToken);
}

/** True if the access token is expired or within the refresh-skew window. */
export function isExpired(tokens: ChatGptTokens, now: number): boolean {
	return now >= tokens.accessTokenExpiresAt - TOKEN_REFRESH_SKEW_MS;
}
