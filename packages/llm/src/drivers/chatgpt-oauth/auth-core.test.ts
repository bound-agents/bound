import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	CHATGPT_OAUTH_CLIENT_ID,
	CHATGPT_OAUTH_REDIRECT_URI,
	type ChatGptTokens,
	TOKEN_REFRESH_SKEW_MS,
	buildAuthorizeUrl,
	decodeJwtPayload,
	exchangeCodeForTokens,
	extractIdClaims,
	generatePkce,
	generateState,
	isExpired,
	refreshTokens,
} from "./auth-core";

/** base64url without padding — mirror the module's encoding for test fixtures. */
function b64url(input: string | Buffer): string {
	return Buffer.from(input)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** Mint a JWT with the given payload (header/signature are inert — we never verify). */
function mintJwt(payload: Record<string, unknown>): string {
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const body = b64url(JSON.stringify(payload));
	return `${header}.${body}.sig`;
}

const ACCOUNT_ID = "acct_test_123";

/** An id_token carrying the Codex-shaped `auth` claim. */
function mintIdToken(overrides: Record<string, unknown> = {}): string {
	return mintJwt({
		email: "user@example.com",
		auth: {
			chatgpt_account_id: ACCOUNT_ID,
			chatgpt_plan_type: "pro",
			chatgpt_user_id: "user_abc",
		},
		...overrides,
	});
}

/** An access_token whose `exp` is `secondsFromNow` seconds out. */
function mintAccessToken(secondsFromNow: number, nowMs = Date.now()): string {
	return mintJwt({ exp: Math.floor(nowMs / 1000) + secondsFromNow });
}

describe("PKCE", () => {
	it("generates a verifier and an S256 challenge that verifies", () => {
		const { verifier, challenge } = generatePkce();
		expect(verifier.length).toBeGreaterThanOrEqual(43);
		expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
		// The challenge must be base64url(sha256(verifier)).
		const expected = createHash("sha256")
			.update(verifier)
			.digest("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		expect(challenge).toBe(expected);
	});

	it("generates distinct verifiers across calls", () => {
		expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
	});
});

describe("buildAuthorizeUrl", () => {
	it("carries all required OAuth params", () => {
		const pkce = generatePkce();
		const state = generateState();
		const url = new URL(buildAuthorizeUrl({ pkce, state }));
		expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
		expect(url.searchParams.get("client_id")).toBe(CHATGPT_OAUTH_CLIENT_ID);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("redirect_uri")).toBe(CHATGPT_OAUTH_REDIRECT_URI);
		expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
		expect(url.searchParams.get("state")).toBe(state);
		expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	});
});

describe("decodeJwtPayload", () => {
	it("decodes the middle segment", () => {
		const jwt = mintJwt({ hello: "world", n: 42 });
		expect(decodeJwtPayload(jwt)).toEqual({ hello: "world", n: 42 });
	});

	it("rejects a non-three-segment token", () => {
		expect(() => decodeJwtPayload("a.b")).toThrow(/three/);
	});
});

describe("extractIdClaims", () => {
	it("reads chatgpt_account_id from the nested auth claim", () => {
		const claims = extractIdClaims(mintIdToken());
		expect(claims.chatgptAccountId).toBe(ACCOUNT_ID);
		expect(claims.chatgptPlanType).toBe("pro");
		expect(claims.chatgptUserId).toBe("user_abc");
		expect(claims.email).toBe("user@example.com");
	});

	it("falls back to the https://api.openai.com/auth namespaced claim", () => {
		const jwt = mintJwt({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct_ns" },
		});
		expect(extractIdClaims(jwt).chatgptAccountId).toBe("acct_ns");
	});

	it("falls back to user_id when chatgpt_user_id is absent", () => {
		const jwt = mintJwt({ auth: { chatgpt_account_id: "a", user_id: "legacy_uid" } });
		expect(extractIdClaims(jwt).chatgptUserId).toBe("legacy_uid");
	});
});

/** A fetch stub that returns one canned JSON body and captures the request. */
function stubFetch(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fn = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		return {
			ok: opts.ok ?? true,
			status: opts.status ?? 200,
			statusText: "OK",
			json: async () => body,
			text: async () => JSON.stringify(body),
		} as Response;
	}) as unknown as typeof fetch;
	return { fetch: fn, calls };
}

describe("exchangeCodeForTokens", () => {
	it("POSTs the authorization_code grant and assembles tokens", async () => {
		const idToken = mintIdToken();
		const accessToken = mintAccessToken(3600);
		const { fetch, calls } = stubFetch({
			access_token: accessToken,
			refresh_token: "refresh_1",
			id_token: idToken,
			token_type: "Bearer",
		});
		const tokens = await exchangeCodeForTokens({ fetch }, { code: "the_code", codeVerifier: "v" });
		expect(tokens.accessToken).toBe(accessToken);
		expect(tokens.refreshToken).toBe("refresh_1");
		expect(tokens.accountId).toBe(ACCOUNT_ID);
		// exp-derived absolute expiry, ~1h out.
		expect(tokens.accessTokenExpiresAt).toBeGreaterThan(Date.now() + 3000_000);

		expect(calls).toHaveLength(1);
		const body = new URLSearchParams((calls[0].init?.body as string) ?? "");
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("the_code");
		expect(body.get("code_verifier")).toBe("v");
		expect(body.get("client_id")).toBe(CHATGPT_OAUTH_CLIENT_ID);
	});

	it("throws when the id_token lacks chatgpt_account_id", async () => {
		const { fetch } = stubFetch({
			access_token: mintAccessToken(3600),
			refresh_token: "r",
			id_token: mintJwt({ auth: { chatgpt_plan_type: "pro" } }),
		});
		await expect(
			exchangeCodeForTokens({ fetch }, { code: "c", codeVerifier: "v" }),
		).rejects.toThrow(/chatgpt_account_id/);
	});

	it("surfaces a non-ok token endpoint response", async () => {
		const { fetch } = stubFetch({ error: "invalid_grant" }, { ok: false, status: 400 });
		await expect(
			exchangeCodeForTokens({ fetch }, { code: "c", codeVerifier: "v" }),
		).rejects.toThrow(/token exchange failed: 400/);
	});
});

describe("refreshTokens", () => {
	const current: ChatGptTokens = {
		accessToken: mintAccessToken(-10),
		refreshToken: "refresh_old",
		idToken: mintIdToken(),
		accountId: ACCOUNT_ID,
		accessTokenExpiresAt: Date.now() - 10_000,
	};

	it("sends the refresh_token grant and rotates to the new refresh token", async () => {
		const { fetch, calls } = stubFetch({
			access_token: mintAccessToken(3600),
			refresh_token: "refresh_new",
			id_token: mintIdToken(),
		});
		const next = await refreshTokens({ fetch }, current);
		expect(next.refreshToken).toBe("refresh_new");
		const body = new URLSearchParams((calls[0].init?.body as string) ?? "");
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("refresh_old");
	});

	it("carries the prior refresh token forward when the response omits one", async () => {
		const { fetch } = stubFetch({
			access_token: mintAccessToken(3600),
			id_token: mintIdToken(),
		});
		const next = await refreshTokens({ fetch }, current);
		expect(next.refreshToken).toBe("refresh_old");
	});

	it("surfaces a rejected refresh (rotated/expired token)", async () => {
		const { fetch } = stubFetch({ error: "invalid_grant" }, { ok: false, status: 400 });
		await expect(refreshTokens({ fetch }, current)).rejects.toThrow(/token refresh failed: 400/);
	});
});

describe("isExpired", () => {
	const base: ChatGptTokens = {
		accessToken: "a",
		refreshToken: "r",
		idToken: "i",
		accountId: ACCOUNT_ID,
		accessTokenExpiresAt: 1_000_000,
	};

	it("is false well before expiry", () => {
		expect(isExpired(base, 1_000_000 - TOKEN_REFRESH_SKEW_MS - 1)).toBe(false);
	});

	it("is true inside the skew window before the hard expiry", () => {
		expect(isExpired(base, 1_000_000 - TOKEN_REFRESH_SKEW_MS + 1)).toBe(true);
	});

	it("is true at and after expiry", () => {
		expect(isExpired(base, 1_000_000)).toBe(true);
		expect(isExpired(base, 2_000_000)).toBe(true);
	});
});
