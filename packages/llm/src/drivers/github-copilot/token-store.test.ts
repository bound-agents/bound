import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthCoreDeps, CopilotTokens } from "./auth-core";
import { COPILOT_ACCESS_TOKEN_URL } from "./auth-core";
import { CopilotTokenManager, FileCopilotTokenStore } from "./token-store";

const paths: string[] = [];

function tempPath(): string {
	const path = join(tmpdir(), `bound-copilot-${randomBytes(8).toString("hex")}.json`);
	paths.push(path);
	return path;
}

afterEach(() => {
	for (const path of paths.splice(0)) {
		rmSync(path, { force: true, maxRetries: 5, retryDelay: 100 });
	}
});

function tokens(overrides: Partial<CopilotTokens> = {}): CopilotTokens {
	return {
		accessToken: "ghu_old",
		refreshToken: "ghr_old",
		accessTokenExpiresAt: 2_000_000,
		...overrides,
	};
}

describe("FileCopilotTokenStore", () => {
	it("round-trips the full token bundle", () => {
		const store = new FileCopilotTokenStore(tempPath());
		const bundle = tokens();
		store.save(bundle);
		expect(store.load()).toEqual(bundle);
	});

	it("returns null for a missing or malformed file", async () => {
		const missing = new FileCopilotTokenStore(tempPath());
		expect(missing.load()).toBeNull();

		const malformedPath = tempPath();
		await Bun.write(malformedPath, "not JSON");
		expect(new FileCopilotTokenStore(malformedPath).load()).toBeNull();
	});
});

describe("CopilotTokenManager", () => {
	it("returns the current access token when not expired", async () => {
		let calls = 0;
		const deps: AuthCoreDeps = {
			fetch: (async () => {
				calls++;
				return new Response("{}");
			}) as typeof fetch,
			now: () => 0, // far before expiry
		};
		const mgr = new CopilotTokenManager(tokens({ accessTokenExpiresAt: 10_000_000 }), deps, {
			save: () => {},
		});
		expect(await mgr.getAccessToken()).toBe("ghu_old");
		expect(calls).toBe(0);
	});

	it("refreshes and persists the rotated bundle before returning the new token", async () => {
		let seen: Request | undefined;
		const saved: CopilotTokens[] = [];
		const deps: AuthCoreDeps = {
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				seen = new Request(input, init);
				return new Response(
					JSON.stringify({ access_token: "ghu_new", refresh_token: "ghr_new", expires_in: 28800 }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}) as typeof fetch,
			now: () => 5_000_000, // past expiry
		};
		const mgr = new CopilotTokenManager(tokens(), deps, {
			save: (t) => {
				saved.push(t);
			},
		});
		const token = await mgr.getAccessToken();
		expect(seen?.url).toBe(COPILOT_ACCESS_TOKEN_URL);
		expect(token).toBe("ghu_new");
		// Persistence happened, and with the rotated refresh token.
		expect(saved).toHaveLength(1);
		expect(saved[0]).toEqual({
			accessToken: "ghu_new",
			refreshToken: "ghr_new",
			accessTokenExpiresAt: 5_000_000 + 28800 * 1000,
		});
	});

	it("serializes concurrent refreshes into a single POST (single-flight)", async () => {
		let postCount = 0;
		const deps: AuthCoreDeps = {
			fetch: (async () => {
				postCount++;
				// Delay so both callers observe the same in-flight promise.
				await new Promise((r) => setTimeout(r, 10));
				return new Response(
					JSON.stringify({ access_token: "ghu_new", refresh_token: "ghr_new", expires_in: 28800 }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}) as typeof fetch,
			now: () => 5_000_000,
		};
		const mgr = new CopilotTokenManager(tokens(), deps, { save: () => {} });
		const [a, b] = await Promise.all([mgr.getAccessToken(), mgr.getAccessToken()]);
		expect(a).toBe("ghu_new");
		expect(b).toBe("ghu_new");
		expect(postCount).toBe(1);
	});
});
