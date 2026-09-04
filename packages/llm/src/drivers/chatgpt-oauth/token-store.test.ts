import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatGptTokens } from "./auth-core";
import { FileTokenStore, TokenManager } from "./token-store";

const paths: string[] = [];

function tempPath(): string {
	const path = join(tmpdir(), `bound-chatgpt-oauth-${randomBytes(8).toString("hex")}.json`);
	paths.push(path);
	return path;
}

afterEach(() => {
	for (const path of paths.splice(0)) {
		rmSync(path, { force: true, maxRetries: 5, retryDelay: 100 });
	}
});

function tokens(overrides: Partial<ChatGptTokens> = {}): ChatGptTokens {
	return {
		accessToken: "access-old",
		refreshToken: "refresh-old",
		idToken: "eyJhbGciOiJSUzI1NiJ9.eyJhdXRoIjp7ImNoYXRncHRfYWNjb3VudF9pZCI6ImFjY3QtdGVzdCJ9fQ.sig",
		accountId: "acct-test",
		accessTokenExpiresAt: 2_000_000,
		...overrides,
	};
}

function refreshResponse() {
	return {
		access_token: "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjM2MDB9.sig",
		refresh_token: "refresh-new",
		id_token: "eyJhbGciOiJSUzI1NiJ9.eyJhdXRoIjp7ImNoYXRncHRfYWNjb3VudF9pZCI6ImFjY3QtdGVzdCJ9fQ.sig",
	};
}

describe("FileTokenStore", () => {
	it("round-trips the full token bundle", async () => {
		const store = new FileTokenStore(tempPath());
		const bundle = tokens();
		await store.save(bundle);
		expect(await store.load()).toEqual(bundle);
	});

	it("returns null for a missing or malformed file", async () => {
		const missing = new FileTokenStore(tempPath());
		expect(await missing.load()).toBeNull();

		const malformedPath = tempPath();
		await Bun.write(malformedPath, "not JSON");
		expect(await new FileTokenStore(malformedPath).load()).toBeNull();
	});
});

describe("TokenManager", () => {
	it("returns the cached token without fetching when it is not expired", async () => {
		const store = new FileTokenStore(tempPath());
		let calls = 0;
		const manager = new TokenManager(
			tokens(),
			{
				fetch: (async () => {
					calls++;
					throw new Error("must not fetch");
				}) as typeof fetch,
				now: () => 1_000_000,
			},
			store,
		);

		expect(await manager.getAccessToken()).toEqual({
			accessToken: "access-old",
			accountId: "acct-test",
		});
		expect(calls).toBe(0);
	});

	it("refreshes an expired bundle and persists its rotation before returning", async () => {
		const path = tempPath();
		const store = new FileTokenStore(path);
		const manager = new TokenManager(
			tokens({ accessTokenExpiresAt: 1_000_000 }),
			{
				fetch: (async () =>
					new Response(JSON.stringify(refreshResponse()), { status: 200 })) as typeof fetch,
				now: () => 1_000_000,
			},
			store,
		);

		expect(await manager.getAccessToken()).toEqual({
			accessToken: refreshResponse().access_token,
			accountId: "acct-test",
		});
		expect(existsSync(path)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8")).refreshToken).toBe("refresh-new");
	});

	it("single-flights concurrent refreshes and returns the rotated token to both callers", async () => {
		const store = new FileTokenStore(tempPath());
		let calls = 0;
		const manager = new TokenManager(
			tokens({ accessTokenExpiresAt: 1_000_000 }),
			{
				fetch: (async () => {
					calls++;
					await Promise.resolve();
					return new Response(JSON.stringify(refreshResponse()), { status: 200 });
				}) as typeof fetch,
				now: () => 1_000_000,
			},
			store,
		);

		const [first, second] = await Promise.all([manager.getAccessToken(), manager.getAccessToken()]);
		expect(calls).toBe(1);
		expect(first).toEqual({ accessToken: refreshResponse().access_token, accountId: "acct-test" });
		expect(second).toEqual(first);
		expect((await store.load())?.refreshToken).toBe("refresh-new");
	});
});
