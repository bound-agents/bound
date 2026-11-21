/**
 * GitHub Copilot direct-API auth core — the device-flow machinery behind
 * `bound login --copilot`.
 *
 * This is the direct HTTP path (NOT the Copilot CLI or SDK): an OAuth 2.0
 * Device Authorization Grant against github.com using bound's own public
 * GitHub App client id, yielding a `ghu_` access token usable as a Bearer
 * against the Copilot API, plus a rotating `ghr_` refresh token.
 *
 * Verified wire facts (live probes against Free + Enterprise accounts,
 * 2026-11-20/21):
 *   - Device flow: POST github.com/login/device/code → {device_code, user_code,
 *     verification_uri, interval}; poll POST github.com/login/oauth/access_token
 *     with grant_type urn:ietf:params:oauth:grant-type:device_code. Handle
 *     `authorization_pending` (keep polling at interval) and `slow_down` (bump
 *     the interval). Success → ghu_ access_token (expires_in 28800), ghr_
 *     refresh_token (refresh_token_expires_in ~6 months).
 *   - Refresh WITHOUT a client_secret works and ROTATES both tokens: the old
 *     refresh token dies, so the caller MUST persist the new bundle before
 *     using it and serialize concurrent refreshes (see token-store).
 *   - The documented `copilot_internal/v2/token` exchange returns 403 — DO NOT
 *     use it. The ghu_ token is sent directly as the Bearer.
 *   - Account lookup: GET api.github.com/copilot_internal/user with the Bearer +
 *     `X-GitHub-Api-Version: 2025-04-01` returns {chat_enabled, copilot_plan,
 *     endpoints:{api}, quota_snapshots}. The per-plan `endpoints.api` host MUST
 *     be validated against the Copilot allowlist before any request rides it.
 *
 * The module is pure over an injected `fetch` and a `now()` clock so the whole
 * flow — device start, poll, refresh-with-rotation, expiry gating, endpoint
 * validation — is unit-testable with no network and no wall-clock.
 *
 * The client_id is a PUBLIC GitHub App identifier (bound-org app); the device
 * flow needs no secret.
 */

/** Public GitHub App client id for the bound-org Copilot app. */
export const COPILOT_CLIENT_ID = "Iv23liQUc6i14pH9z9P0";
export const COPILOT_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const COPILOT_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
/** GitHub API host for the account/plan lookup (NOT the Copilot API host). */
export const COPILOT_USER_INFO_URL = "https://api.github.com/copilot_internal/user";
/** The device-flow grant type (RFC 8628). */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Refresh this many milliseconds BEFORE the access token's expiry, so an
 * in-flight request never races the boundary. Mirrors the chatgpt-oauth skew.
 */
export const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

/** The X-GitHub-Api-Version for the account/plan lookup. */
export const COPILOT_USER_INFO_API_VERSION = "2025-04-01";

export interface AuthCoreDeps {
	fetch: typeof fetch;
	now?: () => number;
}

/** The device-authorization response that opens the flow. */
export interface DeviceCodeGrant {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	/** Polling interval in seconds the server asked for. */
	intervalSeconds: number;
	/** Absolute epoch-ms when the device code expires. */
	expiresAt: number;
}

/** Raw JSON shape of the device-code endpoint. */
interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

/**
 * The persisted token bundle. `accessTokenExpiresAt` is an absolute epoch-ms so
 * expiry gating never depends on a separately-stored `expires_in` + write time.
 */
export interface CopilotTokens {
	accessToken: string;
	refreshToken: string;
	accessTokenExpiresAt: number;
}

/** Raw JSON shape of the token endpoint (device poll + refresh). */
interface AccessTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	token_type?: string;
	scope?: string;
	interval?: number;
	error?: string;
	error_description?: string;
}

/** The subset of the Copilot quota snapshot we read for plan gating. */
export interface CopilotQuotaSnapshot {
	has_quota?: boolean;
	remaining?: number;
	unlimited?: boolean;
	[key: string]: unknown;
}

/** Account/plan info from `copilot_internal/user`. */
export interface CopilotAccountInfo {
	chatEnabled: boolean;
	copilotPlan?: string;
	accessTypeSku?: string;
	/** The validated Copilot API base (host checked against the allowlist). */
	apiEndpoint: string;
	quotaSnapshots?: Record<string, CopilotQuotaSnapshot>;
}

/** Raw JSON shape of `copilot_internal/user`. */
interface UserInfoResponse {
	chat_enabled?: boolean;
	copilot_plan?: string;
	access_type_sku?: string;
	endpoints?: { api?: string };
	quota_snapshots?: Record<string, CopilotQuotaSnapshot>;
}

/**
 * Validate a Copilot API endpoint host. The account lookup returns a per-plan
 * `endpoints.api` (Free `https://api.individual.githubcopilot.com`, Enterprise
 * `https://api.enterprise.githubcopilot.com`), so the host must NEVER be
 * hardcoded — but it also must never be trusted blindly: only `https` on
 * `githubcopilot.com` or a `.githubcopilot.com` subdomain is accepted. Anything
 * else (an injected evil host, http, a look-alike domain) is rejected.
 */
export function validateCopilotApiEndpoint(endpoint: string): string {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error(`Copilot API endpoint is not a valid URL: ${endpoint}`);
	}
	if (url.protocol !== "https:") {
		throw new Error(`Copilot API endpoint must be https, got: ${endpoint}`);
	}
	const host = url.hostname.toLowerCase();
	if (host !== "githubcopilot.com" && !host.endsWith(".githubcopilot.com")) {
		throw new Error(
			`Copilot API endpoint host is not a githubcopilot.com domain (possible spoofed endpoint): ${endpoint}`,
		);
	}
	// Normalize to origin — drop any path/query the response might have carried.
	return url.origin;
}

/** Start the device-authorization flow. Returns the user code + poll params. */
export async function startDeviceFlow(deps: AuthCoreDeps): Promise<DeviceCodeGrant> {
	const now = (deps.now ?? Date.now)();
	const res = await deps.fetch(COPILOT_DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ client_id: COPILOT_CLIENT_ID }),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`device code request failed: ${res.status} ${res.statusText} ${detail}`.trim());
	}
	const json = (await res.json()) as DeviceCodeResponse;
	if (!json.device_code || !json.user_code || !json.verification_uri) {
		throw new Error("device code response is missing required fields");
	}
	return {
		deviceCode: json.device_code,
		userCode: json.user_code,
		verificationUri: json.verification_uri,
		intervalSeconds: json.interval ?? 5,
		expiresAt: now + (json.expires_in ?? 900) * 1000,
	};
}

/** The outcome of one device-flow poll. */
export type DevicePollResult =
	| { status: "complete"; tokens: CopilotTokens }
	| { status: "pending" }
	| { status: "slow_down"; intervalSeconds: number };

/**
 * Poll the token endpoint once for a device-flow authorization.
 *   - `authorization_pending` → keep polling at the current interval.
 *   - `slow_down` → bump the interval (use the returned one, else +5s).
 *   - success → the token bundle.
 * Any other error throws (expired/denied/unsupported).
 */
export async function pollDeviceToken(
	deps: AuthCoreDeps,
	params: { deviceCode: string; currentIntervalSeconds: number },
): Promise<DevicePollResult> {
	const now = (deps.now ?? Date.now)();
	const res = await deps.fetch(COPILOT_ACCESS_TOKEN_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			client_id: COPILOT_CLIENT_ID,
			device_code: params.deviceCode,
			grant_type: DEVICE_CODE_GRANT_TYPE,
		}),
	});
	// GitHub returns HTTP 200 for authorization_pending/slow_down (the error is
	// carried in the JSON body), but defensively tolerate non-200 that still
	// carries a parseable error body.
	const json = (await res.json().catch(() => ({}))) as AccessTokenResponse;
	if (json.error === "authorization_pending") return { status: "pending" };
	if (json.error === "slow_down") {
		// GitHub may return a bumped `interval`; otherwise RFC 8628 says add 5s.
		return {
			status: "slow_down",
			intervalSeconds: json.interval ?? params.currentIntervalSeconds + 5,
		};
	}
	if (json.error) {
		throw new Error(
			`device authorization failed: ${json.error}${json.error_description ? ` — ${json.error_description}` : ""}`,
		);
	}
	if (!res.ok) {
		throw new Error(`device token poll failed: ${res.status} ${res.statusText}`.trim());
	}
	if (!json.access_token) {
		throw new Error("device token response has no access_token");
	}
	return { status: "complete", tokens: toTokens(json, now) };
}

/**
 * Refresh an expired/expiring token bundle. Refresh tokens ROTATE — the caller
 * MUST persist the returned bundle so the next refresh uses the new token. No
 * client_secret is required (verified).
 */
export async function refreshTokens(
	deps: AuthCoreDeps,
	current: CopilotTokens,
): Promise<CopilotTokens> {
	const now = (deps.now ?? Date.now)();
	const res = await deps.fetch(COPILOT_ACCESS_TOKEN_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			client_id: COPILOT_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: current.refreshToken,
		}),
	});
	const json = (await res.json().catch(() => ({}))) as AccessTokenResponse;
	if (json.error) {
		// GitHub answers a dead or revoked refresh token with
		// `incorrect_client_credentials` (verified: a fabricated ghr_ gets the
		// same error while the device-flow endpoint still accepts the client_id),
		// which reads like an app misconfiguration. Name the real remedy.
		if (json.error === "incorrect_client_credentials" || json.error === "bad_refresh_token") {
			throw new Error(
				`Copilot login expired or was revoked (${json.error}) — run \`bound login --copilot\``,
			);
		}
		throw new Error(
			`token refresh failed: ${json.error}${json.error_description ? ` — ${json.error_description}` : ""}`,
		);
	}
	if (!res.ok) {
		throw new Error(`token refresh failed: ${res.status} ${res.statusText}`.trim());
	}
	if (!json.access_token) {
		throw new Error("token refresh response has no access_token");
	}
	return toTokens(json, now, current.refreshToken);
}

/** Assemble a `CopilotTokens` from a raw token response + a prior refresh token. */
function toTokens(
	res: AccessTokenResponse,
	now: number,
	priorRefreshToken?: string,
): CopilotTokens {
	if (!res.access_token) {
		throw new Error("token response has no access_token");
	}
	// GitHub rotates the refresh token on every refresh and invalidates the
	// prior one, but per RFC 6749 a response may omit a new one — carry forward.
	const refreshToken = res.refresh_token ?? priorRefreshToken ?? "";
	// expires_in is seconds (28800 = 8h observed).
	const accessTokenExpiresAt = now + (res.expires_in ?? 28800) * 1000;
	return {
		accessToken: res.access_token,
		refreshToken,
		accessTokenExpiresAt,
	};
}

/**
 * Fetch and validate the Copilot account/plan info. Throws a clear error when
 * chat is not enabled or the endpoint host fails validation.
 */
export async function fetchAccountInfo(
	deps: AuthCoreDeps,
	accessToken: string,
): Promise<CopilotAccountInfo> {
	const res = await deps.fetch(COPILOT_USER_INFO_URL, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
			"X-GitHub-Api-Version": COPILOT_USER_INFO_API_VERSION,
			"User-Agent": "bound",
		},
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`Copilot account lookup failed: ${res.status} ${res.statusText} ${detail}`.trim(),
		);
	}
	const json = (await res.json()) as UserInfoResponse;
	const apiRaw = json.endpoints?.api;
	if (!apiRaw) {
		throw new Error("Copilot account lookup returned no endpoints.api");
	}
	const apiEndpoint = validateCopilotApiEndpoint(apiRaw);
	if (json.chat_enabled === false) {
		throw new Error(
			"Copilot chat is not enabled for this account — enable GitHub Copilot, then retry.",
		);
	}
	return {
		chatEnabled: json.chat_enabled ?? true,
		copilotPlan: json.copilot_plan,
		accessTypeSku: json.access_type_sku,
		apiEndpoint,
		quotaSnapshots: json.quota_snapshots,
	};
}

/** True if the access token is expired or within the refresh-skew window. */
export function isExpired(tokens: CopilotTokens, now: number): boolean {
	return now >= tokens.accessTokenExpiresAt - TOKEN_REFRESH_SKEW_MS;
}
