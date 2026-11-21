import { describe, expect, it } from "bun:test";
import {
	COPILOT_ACCESS_TOKEN_URL,
	COPILOT_CLIENT_ID,
	COPILOT_DEVICE_CODE_URL,
	COPILOT_USER_INFO_URL,
	type CopilotTokens,
	fetchAccountInfo,
	isExpired,
	pollDeviceToken,
	refreshTokens,
	startDeviceFlow,
	validateCopilotApiEndpoint,
} from "./auth-core";

/** A fetch stub that records the request and returns a canned JSON response. */
function jsonFetch(status: number, body: unknown, capture?: (req: Request) => void): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		capture?.(new Request(input, init));
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

describe("startDeviceFlow", () => {
	it("POSTs the public client id and returns the user code + poll params", async () => {
		let seen: Request | undefined;
		const deps = {
			fetch: jsonFetch(
				200,
				{
					device_code: "dev-123",
					user_code: "WDJB-MJHT",
					verification_uri: "https://github.com/login/device",
					expires_in: 900,
					interval: 5,
				},
				(req) => {
					seen = req;
				},
			),
			now: () => 1_000_000,
		};
		const grant = await startDeviceFlow(deps);
		expect(seen?.url).toBe(COPILOT_DEVICE_CODE_URL);
		expect(seen?.method).toBe("POST");
		expect(await seen?.clone().json()).toEqual({ client_id: COPILOT_CLIENT_ID });
		expect(grant.deviceCode).toBe("dev-123");
		expect(grant.userCode).toBe("WDJB-MJHT");
		expect(grant.verificationUri).toBe("https://github.com/login/device");
		expect(grant.intervalSeconds).toBe(5);
		expect(grant.expiresAt).toBe(1_000_000 + 900 * 1000);
	});

	it("throws on a non-OK device-code response", async () => {
		const deps = { fetch: jsonFetch(400, { error: "bad" }) };
		await expect(startDeviceFlow(deps)).rejects.toThrow(/device code request failed/);
	});
});

describe("pollDeviceToken", () => {
	it("maps authorization_pending to a pending result", async () => {
		const deps = { fetch: jsonFetch(200, { error: "authorization_pending" }) };
		const result = await pollDeviceToken(deps, {
			deviceCode: "dev-123",
			currentIntervalSeconds: 5,
		});
		expect(result.status).toBe("pending");
	});

	it("maps slow_down to a bumped interval, preferring the server value", async () => {
		const withServerInterval = { fetch: jsonFetch(200, { error: "slow_down", interval: 10 }) };
		const r1 = await pollDeviceToken(withServerInterval, {
			deviceCode: "dev-123",
			currentIntervalSeconds: 5,
		});
		expect(r1).toEqual({ status: "slow_down", intervalSeconds: 10 });

		const withoutServerInterval = { fetch: jsonFetch(200, { error: "slow_down" }) };
		const r2 = await pollDeviceToken(withoutServerInterval, {
			deviceCode: "dev-123",
			currentIntervalSeconds: 5,
		});
		expect(r2).toEqual({ status: "slow_down", intervalSeconds: 10 });
	});

	it("returns the token bundle on success with an absolute expiry", async () => {
		let seen: Request | undefined;
		const deps = {
			fetch: jsonFetch(
				200,
				{
					access_token: "ghu_abc",
					refresh_token: "ghr_def",
					expires_in: 28800,
					token_type: "bearer",
				},
				(req) => {
					seen = req;
				},
			),
			now: () => 2_000_000,
		};
		const result = await pollDeviceToken(deps, {
			deviceCode: "dev-123",
			currentIntervalSeconds: 5,
		});
		expect(seen?.url).toBe(COPILOT_ACCESS_TOKEN_URL);
		const body = (await seen?.clone().json()) as Record<string, unknown>;
		expect(body.client_id).toBe(COPILOT_CLIENT_ID);
		expect(body.device_code).toBe("dev-123");
		expect(body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
		expect(result).toEqual({
			status: "complete",
			tokens: {
				accessToken: "ghu_abc",
				refreshToken: "ghr_def",
				accessTokenExpiresAt: 2_000_000 + 28800 * 1000,
			},
		});
	});

	it("throws on a terminal device error", async () => {
		const deps = {
			fetch: jsonFetch(200, { error: "expired_token", error_description: "expired" }),
		};
		await expect(
			pollDeviceToken(deps, { deviceCode: "dev-123", currentIntervalSeconds: 5 }),
		).rejects.toThrow(/expired_token/);
	});
});

describe("refreshTokens", () => {
	it("refreshes without a client_secret and returns the rotated bundle", async () => {
		let seen: Request | undefined;
		const deps = {
			fetch: jsonFetch(
				200,
				{ access_token: "ghu_new", refresh_token: "ghr_new", expires_in: 28800 },
				(req) => {
					seen = req;
				},
			),
			now: () => 3_000_000,
		};
		const current: CopilotTokens = {
			accessToken: "ghu_old",
			refreshToken: "ghr_old",
			accessTokenExpiresAt: 3_000_000,
		};
		const rotated = await refreshTokens(deps, current);
		const body = (await seen?.clone().json()) as Record<string, unknown>;
		expect(body.client_id).toBe(COPILOT_CLIENT_ID);
		expect(body.grant_type).toBe("refresh_token");
		expect(body.refresh_token).toBe("ghr_old");
		expect("client_secret" in body).toBe(false);
		expect(rotated).toEqual({
			accessToken: "ghu_new",
			refreshToken: "ghr_new",
			accessTokenExpiresAt: 3_000_000 + 28800 * 1000,
		});
	});

	it("carries forward the prior refresh token when the response omits one", async () => {
		const deps = {
			fetch: jsonFetch(200, { access_token: "ghu_new", expires_in: 28800 }),
			now: () => 0,
		};
		const current: CopilotTokens = {
			accessToken: "ghu_old",
			refreshToken: "ghr_old",
			accessTokenExpiresAt: 0,
		};
		const rotated = await refreshTokens(deps, current);
		expect(rotated.refreshToken).toBe("ghr_old");
	});

	it("throws on a refresh error body", async () => {
		const deps = {
			fetch: jsonFetch(200, { error: "bad_refresh_token" }),
		};
		const current: CopilotTokens = {
			accessToken: "ghu_old",
			refreshToken: "ghr_old",
			accessTokenExpiresAt: 0,
		};
		await expect(refreshTokens(deps, current)).rejects.toThrow(/bad_refresh_token/);
	});
});

describe("validateCopilotApiEndpoint", () => {
	it("accepts the apex and subdomains of githubcopilot.com over https", () => {
		expect(validateCopilotApiEndpoint("https://api.individual.githubcopilot.com")).toBe(
			"https://api.individual.githubcopilot.com",
		);
		expect(validateCopilotApiEndpoint("https://api.enterprise.githubcopilot.com")).toBe(
			"https://api.enterprise.githubcopilot.com",
		);
		expect(validateCopilotApiEndpoint("https://githubcopilot.com")).toBe(
			"https://githubcopilot.com",
		);
	});

	it("normalizes to the origin, dropping any path", () => {
		expect(validateCopilotApiEndpoint("https://api.individual.githubcopilot.com/v1/models")).toBe(
			"https://api.individual.githubcopilot.com",
		);
	});

	it("rejects a non-https endpoint", () => {
		expect(() => validateCopilotApiEndpoint("http://api.individual.githubcopilot.com")).toThrow(
			/must be https/,
		);
	});

	it("rejects a spoofed look-alike host", () => {
		expect(() => validateCopilotApiEndpoint("https://evil.com")).toThrow(/not a githubcopilot/);
		expect(() => validateCopilotApiEndpoint("https://githubcopilot.com.evil.com")).toThrow(
			/not a githubcopilot/,
		);
		expect(() => validateCopilotApiEndpoint("https://api.githubcopilot.com.attacker.net")).toThrow(
			/not a githubcopilot/,
		);
	});

	it("rejects a non-URL string", () => {
		expect(() => validateCopilotApiEndpoint("not a url")).toThrow(/not a valid URL/);
	});
});

describe("fetchAccountInfo", () => {
	it("validates the endpoint and returns the plan info", async () => {
		let seen: Request | undefined;
		const deps = {
			fetch: jsonFetch(
				200,
				{
					chat_enabled: true,
					copilot_plan: "individual",
					access_type_sku: "copilot_individual",
					endpoints: { api: "https://api.individual.githubcopilot.com" },
					quota_snapshots: { premium_interactions: { has_quota: false } },
				},
				(req) => {
					seen = req;
				},
			),
		};
		const info = await fetchAccountInfo(deps, "ghu_abc");
		expect(seen?.url).toBe(COPILOT_USER_INFO_URL);
		expect(seen?.headers.get("authorization")).toBe("Bearer ghu_abc");
		expect(seen?.headers.get("x-github-api-version")).toBe("2025-04-01");
		expect(info.apiEndpoint).toBe("https://api.individual.githubcopilot.com");
		expect(info.copilotPlan).toBe("individual");
		expect(info.quotaSnapshots?.premium_interactions?.has_quota).toBe(false);
	});

	it("rejects a spoofed endpoint returned by the account lookup", async () => {
		const deps = {
			fetch: jsonFetch(200, {
				chat_enabled: true,
				endpoints: { api: "https://evil.example.com" },
			}),
		};
		await expect(fetchAccountInfo(deps, "ghu_abc")).rejects.toThrow(/not a githubcopilot/);
	});

	it("throws a clear error when chat is not enabled", async () => {
		const deps = {
			fetch: jsonFetch(200, {
				chat_enabled: false,
				endpoints: { api: "https://api.individual.githubcopilot.com" },
			}),
		};
		await expect(fetchAccountInfo(deps, "ghu_abc")).rejects.toThrow(/chat is not enabled/);
	});
});

describe("isExpired", () => {
	it("is true within the refresh-skew window", () => {
		const tokens: CopilotTokens = {
			accessToken: "ghu_x",
			refreshToken: "ghr_x",
			accessTokenExpiresAt: 1_000_000,
		};
		// 5min skew → expired once now >= expiry - 300_000.
		expect(isExpired(tokens, 1_000_000 - 300_000)).toBe(true);
		expect(isExpired(tokens, 1_000_000 - 300_001)).toBe(false);
	});
});

describe("startDeviceFlow error paths", () => {
	it("throws when the device-code response omits required fields", async () => {
		// 200 OK but no device_code/user_code/verification_uri — a malformed body
		// must not silently yield an unusable grant.
		const deps = { fetch: jsonFetch(200, { user_code: "WDJB-MJHT" }) };
		await expect(startDeviceFlow(deps)).rejects.toThrow(/missing required fields/);
	});
});

describe("pollDeviceToken error paths", () => {
	it("throws on a non-OK poll with no parseable error body", async () => {
		// No json.error (so the pending/slow_down/terminal branches are skipped),
		// non-200 status → the status-line throw fires.
		const deps = { fetch: jsonFetch(500, {}) };
		await expect(
			pollDeviceToken(deps, { deviceCode: "dev-123", currentIntervalSeconds: 5 }),
		).rejects.toThrow(/device token poll failed: 500/);
	});

	it("throws when a 200 success body carries no access_token", async () => {
		// 200, no error, but access_token absent — not a usable completion.
		const deps = { fetch: jsonFetch(200, { token_type: "bearer" }) };
		await expect(
			pollDeviceToken(deps, { deviceCode: "dev-123", currentIntervalSeconds: 5 }),
		).rejects.toThrow(/device token response has no access_token/);
	});
});

describe("refreshTokens error paths", () => {
	it("throws on a non-OK refresh with no error body", async () => {
		// No json.error → skip the error-body branch; non-200 → status-line throw.
		const deps = { fetch: jsonFetch(502, {}) };
		const current: CopilotTokens = {
			accessToken: "ghu_old",
			refreshToken: "ghr_old",
			accessTokenExpiresAt: 0,
		};
		await expect(refreshTokens(deps, current)).rejects.toThrow(/token refresh failed: 502/);
	});

	it("throws when a 200 refresh body carries no access_token", async () => {
		// 200, no error, but access_token absent: refreshTokens must reject rather
		// than build a bundle with an empty access token.
		const deps = { fetch: jsonFetch(200, { refresh_token: "ghr_new" }) };
		const current: CopilotTokens = {
			accessToken: "ghu_old",
			refreshToken: "ghr_old",
			accessTokenExpiresAt: 0,
		};
		await expect(refreshTokens(deps, current)).rejects.toThrow(
			/token refresh response has no access_token/,
		);
	});
});

describe("fetchAccountInfo error paths", () => {
	it("throws with the status line and detail text on a non-OK account lookup", async () => {
		// A non-JSON 401 body: the stub returns text, and the thrown message must
		// carry both the status and the detail so a plan/auth failure is legible.
		const deps = {
			fetch: (async () =>
				new Response("token revoked", {
					status: 401,
					statusText: "Unauthorized",
					headers: { "content-type": "text/plain" },
				})) as typeof fetch,
		};
		await expect(fetchAccountInfo(deps, "ghu_abc")).rejects.toThrow(
			/Copilot account lookup failed: 401 Unauthorized token revoked/,
		);
	});

	it("throws when the account lookup returns no endpoints.api", async () => {
		// 200 with chat enabled but no endpoints.api — there is no base URL to ride,
		// so the driver must refuse rather than hardcode a host.
		const deps = { fetch: jsonFetch(200, { chat_enabled: true, endpoints: {} }) };
		await expect(fetchAccountInfo(deps, "ghu_abc")).rejects.toThrow(/returned no endpoints\.api/);
	});
});
