import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultTokenStorePath, seedFromCodex } from "../login";

/** base64url a JSON payload into an inert JWT (header/sig are never verified). */
function mintJwt(payload: Record<string, unknown>): string {
	const seg = (o: unknown) =>
		Buffer.from(JSON.stringify(o))
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	return `${seg({ alg: "RS256", typ: "JWT" })}.${seg(payload)}.sig`;
}

/** A Codex auth.json in ChatGPT-account mode. */
function codexChatGptAuthJson(): string {
	return JSON.stringify({
		OPENAI_API_KEY: null,
		tokens: {
			access_token: mintJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
			refresh_token: "refresh_codex",
			id_token: mintJwt({
				email: "user@example.com",
				auth: { chatgpt_account_id: "acct_codex_1" },
			}),
			account_id: "acct_codex_1",
		},
		last_refresh: new Date().toISOString(),
	});
}

describe("defaultTokenStorePath", () => {
	it("places the store beside the config dir", () => {
		expect(defaultTokenStorePath("config")).toMatch(/config[\\/]chatgpt-auth\.json$/);
	});
});

describe("seedFromCodex", () => {
	it("imports a ChatGPT-account Codex session", () => {
		const seeded = seedFromCodex(codexChatGptAuthJson());
		expect(seeded).not.toBeNull();
		expect(seeded?.accountId).toBe("acct_codex_1");
		expect(seeded?.refreshToken).toBe("refresh_codex");
		expect(seeded?.accessTokenExpiresAt).toBeGreaterThan(Date.now());
	});

	it("returns null for an API-key-only auth.json (no OAuth tokens)", () => {
		expect(seedFromCodex(JSON.stringify({ OPENAI_API_KEY: "sk-abc" }))).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(seedFromCodex("{not json")).toBeNull();
	});

	it("falls back to tokens.account_id when the id_token omits the claim", () => {
		const raw = JSON.stringify({
			tokens: {
				access_token: mintJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
				refresh_token: "r",
				id_token: mintJwt({ email: "u@e.com" }),
				account_id: "acct_fallback",
			},
		});
		expect(seedFromCodex(raw)?.accountId).toBe("acct_fallback");
	});

	it("returns null when no account id can be resolved anywhere", () => {
		const raw = JSON.stringify({
			tokens: {
				access_token: mintJwt({ exp: 1 }),
				refresh_token: "r",
				id_token: mintJwt({ email: "u@e.com" }),
			},
		});
		expect(seedFromCodex(raw)).toBeNull();
	});
});

describe("seedFromCodex round-trips onto disk", () => {
	let dir: string;
	beforeEach(() => {
		dir = join(tmpdir(), `login-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(dir, { recursive: true });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("produces a bundle a FileTokenStore can persist and reload", async () => {
		const { FileTokenStore } = await import("@bound/llm");
		const seeded = seedFromCodex(codexChatGptAuthJson());
		expect(seeded).not.toBeNull();
		if (!seeded) throw new Error("seed failed");
		const path = join(dir, "chatgpt-auth.json");
		const store = new FileTokenStore(path);
		store.save(seeded);
		const reloaded = store.load();
		expect(reloaded?.accountId).toBe("acct_codex_1");
		expect(reloaded?.refreshToken).toBe("refresh_codex");
	});

	it("does not read from a nonexistent codex file path", () => {
		// Sanity: writing an unrelated file in the temp dir must not leak into seed.
		writeFileSync(join(dir, "unrelated.txt"), "x");
		expect(seedFromCodex("")).toBeNull();
	});
});
