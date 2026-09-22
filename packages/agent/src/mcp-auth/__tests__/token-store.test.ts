import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@bound/shared";
import {
	type McpTokenBundle,
	McpTokenStore,
	type RefreshFn,
	classifyTokenEndpointError,
} from "../token-store";

let dir: string;
let path: string;

beforeEach(() => {
	dir = join(tmpdir(), `mcp-auth-${randomBytes(4).toString("hex")}`);
	path = join(dir, "mcp-auth.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function bundle(over: Partial<McpTokenBundle> = {}): McpTokenBundle {
	return {
		accessToken: "at-1",
		refreshToken: "rt-1",
		scopes: "read",
		accessTokenExpiresAt: Date.now() + 3600_000,
		issuer: "https://as.example",
		...over,
	};
}

describe("McpTokenStore round-trip", () => {
	it("persists and reads back a bundle", async () => {
		const store = new McpTokenStore(path);
		await store.saveBundle("srv", bundle());
		const back = store.getBundle("srv");
		expect(back?.accessToken).toBe("at-1");
		expect(back?.issuer).toBe("https://as.example");
	});

	it("persists and reads back a registration keyed by issuer", async () => {
		const store = new McpTokenStore(path);
		await store.saveRegistration("https://as.example", { clientId: "cid-1" });
		expect(store.getRegistration("https://as.example")?.clientId).toBe("cid-1");
		expect(store.getRegistration("https://other")).toBeNull();
	});

	it("returns null for an unknown server", () => {
		const store = new McpTokenStore(path);
		expect(store.getBundle("nope")).toBeNull();
	});
});

describe("write-temp-plus-rename atomicity", () => {
	it("leaves no .tmp file behind after a write", async () => {
		const store = new McpTokenStore(path);
		await store.saveBundle("srv", bundle());
		const leftover = readdirSync(dir).filter((f) => f.includes(".tmp."));
		expect(leftover).toEqual([]);
		expect(existsSync(path)).toBe(true);
	});

	it("a concurrent second server write does not clobber the first (no lost RMW)", async () => {
		const store = new McpTokenStore(path);
		await Promise.all([
			store.saveBundle("a", bundle({ accessToken: "at-a" })),
			store.saveBundle("b", bundle({ accessToken: "at-b" })),
		]);
		expect(store.getBundle("a")?.accessToken).toBe("at-a");
		expect(store.getBundle("b")?.accessToken).toBe("at-b");
	});
});

describe("scope-union-never-narrows (R-MO20 custody clause)", () => {
	it("unions scopes on write, never dropping a held scope", async () => {
		const store = new McpTokenStore(path);
		await store.saveBundle("srv", bundle({ scopes: "read write" }));
		await store.saveBundle("srv", bundle({ scopes: "read" }));
		const back = store.getBundle("srv");
		expect(back?.scopes.split(" ").sort()).toEqual(["read", "write"]);
	});

	it("widens on a step-up write", async () => {
		const store = new McpTokenStore(path);
		await store.saveBundle("srv", bundle({ scopes: "read" }));
		await store.saveBundle("srv", bundle({ scopes: "admin" }));
		const back = store.getBundle("srv");
		expect(back?.scopes.split(" ").sort()).toEqual(["admin", "read"]);
	});
});

describe("saveTokens-failure propagation (R-MO23)", () => {
	it("propagates a persistence failure and leaves the disk without the token", async () => {
		// Point the store at a path whose parent is a FILE, so mkdir/rename fails.
		const badStore = new McpTokenStore(join("/dev/null/nope", "mcp-auth.json"));
		await expect(badStore.saveBundle("srv", bundle())).rejects.toBeDefined();
		expect(badStore.getBundle("srv")).toBeNull();
	});
});

describe("expiry-gated access + single-flight refresh (R-MO22)", () => {
	it("returns the current token when unexpired without refreshing", async () => {
		const store = new McpTokenStore(path);
		await store.saveBundle("srv", bundle({ accessTokenExpiresAt: Date.now() + 3600_000 }));
		let calls = 0;
		const refresh: RefreshFn = async () => {
			calls++;
			return ok(bundle());
		};
		const r = await store.getValidAccessToken("srv", refresh);
		expect(r.ok && r.value).toBe("at-1");
		expect(calls).toBe(0);
	});

	it("refreshes when expired and persists the rotated bundle before returning", async () => {
		const clockNow = 10_000_000;
		const store = new McpTokenStore(path, () => clockNow);
		await store.saveBundle("srv", bundle({ accessToken: "old", accessTokenExpiresAt: clockNow }));
		const refresh: RefreshFn = async () =>
			ok(
				bundle({
					accessToken: "new",
					refreshToken: "rt-2",
					accessTokenExpiresAt: clockNow + 3600_000,
				}),
			);
		const r = await store.getValidAccessToken("srv", refresh);
		expect(r.ok && r.value).toBe("new");
		// Rotated bundle is on disk before the token came back.
		expect(store.getBundle("srv")?.accessToken).toBe("new");
		expect(store.getBundle("srv")?.refreshToken).toBe("rt-2");
	});

	it("shares ONE refresh POST across concurrent expiry checks for the same server", async () => {
		const clockNow = 10_000_000;
		const store = new McpTokenStore(path, () => clockNow);
		await store.saveBundle("srv", bundle({ accessTokenExpiresAt: clockNow }));
		let calls = 0;
		const refresh: RefreshFn = async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 20));
			return ok(bundle({ accessToken: "new", accessTokenExpiresAt: clockNow + 3600_000 }));
		};
		const [a, b, c] = await Promise.all([
			store.getValidAccessToken("srv", refresh),
			store.getValidAccessToken("srv", refresh),
			store.getValidAccessToken("srv", refresh),
		]);
		expect(calls).toBe(1);
		expect(a.ok && a.value).toBe("new");
		expect(b.ok && b.value).toBe("new");
		expect(c.ok && c.value).toBe("new");
	});

	it("surfaces a terminal refresh error as a lost grant and leaves the disk token intact", async () => {
		const clockNow = 10_000_000;
		const store = new McpTokenStore(path, () => clockNow);
		await store.saveBundle("srv", bundle({ accessToken: "old", accessTokenExpiresAt: clockNow }));
		const refresh: RefreshFn = async () => err({ kind: "lost_grant", error: "invalid_grant" });
		const r = await store.getValidAccessToken("srv", refresh);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.kind).toBe("lost_grant");
		// The on-disk token is untouched by a failed refresh.
		expect(store.getBundle("srv")?.accessToken).toBe("old");
	});

	it("surfaces a transient refresh error and leaves the disk token intact", async () => {
		const clockNow = 10_000_000;
		const store = new McpTokenStore(path, () => clockNow);
		await store.saveBundle("srv", bundle({ accessToken: "old", accessTokenExpiresAt: clockNow }));
		const refresh: RefreshFn = async () => err({ kind: "transient", detail: "503" });
		const r = await store.getValidAccessToken("srv", refresh);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.kind).toBe("transient");
		expect(store.getBundle("srv")?.accessToken).toBe("old");
	});

	it("returns no_bundle when nothing is stored", async () => {
		const store = new McpTokenStore(path);
		const r = await store.getValidAccessToken("srv", async () => ok(bundle()));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.kind).toBe("no_bundle");
	});
});

describe("classifyTokenEndpointError (R-MO12)", () => {
	it("classifies terminal errors", () => {
		expect(classifyTokenEndpointError("invalid_grant")).toBe("terminal");
		expect(classifyTokenEndpointError("invalid_client")).toBe("terminal");
	});
	it("classifies transient and unlisted errors as transient", () => {
		expect(classifyTokenEndpointError("temporarily_unavailable")).toBe("transient");
		expect(classifyTokenEndpointError("weird_unlisted_error")).toBe("transient");
		expect(classifyTokenEndpointError(undefined)).toBe("transient");
	});
});
