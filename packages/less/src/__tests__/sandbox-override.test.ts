import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	type SandboxOverride,
	SandboxOverrideStore,
	applySandboxOverride,
	describeSandboxOverride,
} from "../tools/sandbox-override";
import { DISABLED_SANDBOX, type ResolvedSandboxConfig } from "../tools/sandbox-policy";

/**
 * The per-thread sandbox override is an OPERATOR-ONLY, session-scoped, in-process
 * control surface driven exclusively by `/sandbox` typed into the boundless TUI.
 * It must never be reachable from a tool, tool parameter, or ACP method. These
 * tests pin the pure override math (applySandboxOverride), the store's per-thread
 * keying and reset semantics, and the structural guarantee that nothing on the
 * bash tool path can mutate it (see "operator-only" below).
 */

const ENABLED: ResolvedSandboxConfig = {
	enabled: true,
	writablePaths: [],
	network: "open",
	onUnavailable: "error",
};

describe("applySandboxOverride", () => {
	it("returns the base config unchanged when there is no override", () => {
		expect(applySandboxOverride(ENABLED, undefined)).toEqual(ENABLED);
	});

	it("'off' disables the sandbox regardless of the base", () => {
		const effective = applySandboxOverride(ENABLED, { mode: "off" });
		expect(effective.enabled).toBe(false);
		// Matches the explicit "run unsandboxed" posture.
		expect(effective).toEqual(DISABLED_SANDBOX);
	});

	it("'allow' keeps the sandbox enabled and appends extra writable paths", () => {
		const effective = applySandboxOverride(ENABLED, {
			mode: "allow",
			writablePaths: ["/opt/extra", "/srv/data"],
		});
		expect(effective.enabled).toBe(true);
		expect(effective.network).toBe("open");
		expect(effective.onUnavailable).toBe("error");
		expect(effective.writablePaths).toEqual(["/opt/extra", "/srv/data"]);
	});

	it("'allow' unions extra paths onto any paths the base already granted", () => {
		const base: ResolvedSandboxConfig = { ...ENABLED, writablePaths: ["/base/one"] };
		const effective = applySandboxOverride(base, {
			mode: "allow",
			writablePaths: ["/extra/two"],
		});
		expect(effective.writablePaths).toEqual(["/base/one", "/extra/two"]);
	});

	it("'allow' de-duplicates a path already present in the base", () => {
		const base: ResolvedSandboxConfig = { ...ENABLED, writablePaths: ["/shared"] };
		const effective = applySandboxOverride(base, {
			mode: "allow",
			writablePaths: ["/shared", "/new"],
		});
		expect(effective.writablePaths).toEqual(["/shared", "/new"]);
	});

	it("preserves the captured git worktree metadata through 'allow'", () => {
		const base: ResolvedSandboxConfig = {
			...ENABLED,
			gitWorktreeMetadata: {
				gitdir: "/repo/.git",
				commondir: "/repo/.git",
				protectedPaths: ["/repo/.git/hooks"],
			},
		};
		const effective = applySandboxOverride(base, { mode: "allow", writablePaths: ["/x"] });
		expect(effective.gitWorktreeMetadata).toEqual(base.gitWorktreeMetadata);
	});
});

describe("SandboxOverrideStore — per-thread, session-scoped", () => {
	it("returns the base config for a thread with no override", () => {
		const store = new SandboxOverrideStore();
		expect(store.get("thread-a")).toBeUndefined();
		expect(store.resolve("thread-a", ENABLED)).toEqual(ENABLED);
	});

	it("keys overrides by thread ID — one thread's override does not leak to another", () => {
		const store = new SandboxOverrideStore();
		store.set("thread-a", { mode: "off" });
		expect(store.resolve("thread-a", ENABLED).enabled).toBe(false);
		// A different thread is untouched: /attach to it uses that thread's (none).
		expect(store.resolve("thread-b", ENABLED)).toEqual(ENABLED);
		expect(store.get("thread-b")).toBeUndefined();
	});

	it("clear() returns a thread to the configured default", () => {
		const store = new SandboxOverrideStore();
		store.set("thread-a", { mode: "off" });
		store.clear("thread-a");
		expect(store.get("thread-a")).toBeUndefined();
		expect(store.resolve("thread-a", ENABLED)).toEqual(ENABLED);
	});

	it("addWritablePath accumulates paths into an 'allow' override (repeatable)", () => {
		const dirOne = mkdtempSync(join(tmpdir(), "sbo-one-"));
		const dirTwo = mkdtempSync(join(tmpdir(), "sbo-two-"));
		try {
			const store = new SandboxOverrideStore();
			const first = store.addWritablePath("thread-a", dirOne);
			expect(first.ok).toBe(true);
			const second = store.addWritablePath("thread-a", dirTwo);
			expect(second.ok).toBe(true);
			const override = store.get("thread-a");
			expect(override?.mode).toBe("allow");
			expect((override as { writablePaths: string[] }).writablePaths.length).toBe(2);
		} finally {
			rmSync(dirOne, { recursive: true, force: true });
			rmSync(dirTwo, { recursive: true, force: true });
		}
	});

	it("addWritablePath rejects a path that does not exist with a clear message", () => {
		const store = new SandboxOverrideStore();
		const missing = join(tmpdir(), `sbo-nope-${Date.now()}`);
		const result = store.addWritablePath("thread-a", missing);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(missing);
		// A rejected add must not create a half-formed override.
		expect(store.get("thread-a")).toBeUndefined();
	});

	it("addWritablePath resolves the path through realpath to an absolute form", () => {
		const dir = mkdtempSync(join(tmpdir(), "sbo-real-"));
		try {
			const store = new SandboxOverrideStore();
			const result = store.addWritablePath("thread-a", dir);
			expect(result.ok).toBe(true);
			if (result.ok) {
				// realpath may prepend /private on macOS or return a drive-letter path on
				// Windows; either way the stored path is absolute.
				expect(isAbsolute(result.value)).toBe(true);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("describeSandboxOverride — HUD / notice phrasing", () => {
	it("flags 'off' as a loud warning state", () => {
		const text = describeSandboxOverride({ mode: "off" });
		expect(text.toLowerCase()).toContain("off");
	});

	it("flags 'allow' with the count of extra paths", () => {
		const text = describeSandboxOverride({ mode: "allow", writablePaths: ["/a", "/b"] });
		expect(text.toLowerCase()).toContain("loosened");
	});

	it("returns null for the default (no override) so the HUD shows nothing", () => {
		expect(describeSandboxOverride(undefined)).toBeNull();
	});
});

describe("operator-only: the bash tool path cannot change the override", () => {
	/**
	 * The store is a plain in-process object owned by the boundless client. The
	 * bash tool receives, at most, a READ-ONLY resolver (a function that maps a
	 * base config to the effective one). There is no write method on that
	 * resolver and the override type is not a tool parameter. This test asserts
	 * the structural contract: a resolver handed the store exposes no mutation.
	 */
	it("a sandbox resolver derived from the store has no mutation surface", () => {
		const store = new SandboxOverrideStore();
		store.set("thread-a", { mode: "off" });
		// The only thing the tool layer is ever given: resolve a base → effective.
		const resolver = store.resolverFor("thread-a");
		expect(typeof resolver).toBe("function");
		// It is a bare function: no set/clear/addWritablePath leaked onto it.
		const asRecord = resolver as unknown as Record<string, unknown>;
		expect(asRecord.set).toBeUndefined();
		expect(asRecord.clear).toBeUndefined();
		expect(asRecord.addWritablePath).toBeUndefined();
		// Calling it only reads: it returns the effective config and the store is
		// unchanged afterward.
		const effective = resolver(ENABLED);
		expect(effective.enabled).toBe(false);
		expect(store.get("thread-a")).toEqual({ mode: "off" } satisfies SandboxOverride);
	});

	it("resolverFor captures the thread at creation — the tool cannot retarget it", () => {
		const store = new SandboxOverrideStore();
		store.set("thread-a", { mode: "off" });
		const resolver = store.resolverFor("thread-a");
		// Later override of a DIFFERENT thread must not change what this resolver sees.
		store.set("thread-b", { mode: "allow", writablePaths: ["/x"] });
		expect(resolver(ENABLED).enabled).toBe(false);
	});
});
