import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkSandboxAvailable, spawnSandboxed } from "../tools/sandbox";
import type { ResolvedSandboxConfig } from "../tools/sandbox-policy";

/**
 * Live mxc enforcement. Unlike `sandbox-policy.test.ts` (pure, SDK-free, runs
 * everywhere), this file imports `../tools/sandbox`, which lazy-loads
 * `@microsoft/mxc-sdk` on first call. The import itself is cheap — node-pty is
 * only touched when `checkSandboxAvailable`/`spawnSandboxed` actually run, and a
 * failed native-addon load surfaces as `{ supported: false }` rather than a
 * module-eval crash. So this file loads safely on every runner; the real
 * enforcement block below only RUNS where mxc can contain.
 */
describe("checkSandboxAvailable", () => {
	it("returns a well-formed result without throwing on any platform", async () => {
		const result = await checkSandboxAvailable();
		expect(typeof result.supported).toBe("boolean");
		if (!result.supported) expect(typeof result.reason).toBe("string");
	});
});

/**
 * End-to-end write denial. Only runs where mxc can actually contain (a staged
 * binary + supported backend); skipped on runners without one so the suite
 * stays green cross-platform while still proving real enforcement where it can.
 * The skip gate uses a top-level await of `checkSandboxAvailable()` — the SDK is
 * lazy-loaded, so availability can only be known asynchronously.
 *
 * NOTE on cwd: the sandbox is spawned with `process.cwd()` as the working
 * directory, exactly as production does (the boundless bash tool's cwd is the
 * launch directory). mxc's backend fails to exec (exit 255, no output) when the
 * working directory differs from the spawning process's cwd, so tests must not
 * invent a fresh workdir to pass as cwd. Write targets are absolute paths
 * instead: tmpdir() (always in the writable set → allowed) and a home-dir path
 * (outside it → denied).
 */
const sandboxLive = (await checkSandboxAvailable()).supported;

/**
 * Detect a NESTED runner — i.e. this test process is itself running inside a
 * filesystem sandbox (the boundless shell's own mxc sandbox). When nested, the
 * outer sandbox denies the inner mxc backend's child-spawn for any spawn that
 * carries non-empty `experimental.seatbelt` content (the identity mach-lookups
 * we always inject land there), so every live spawn exits 255 regardless of the
 * policy under test. That is a containment artifact of the test environment, not
 * a product failure: un-nested runners (CI macOS, a developer's shell) spawn
 * cleanly and exercise the real enforcement, including getpwuid resolution.
 *
 * The probe writes outside the repo and tmpdir (home dir). A non-sandboxed
 * runner succeeds; a nested one gets EPERM. We clean up on success.
 */
const nestedRunner = (() => {
	const probe = join(homedir(), `.boundless-nesting-probe-${randomBytes(4).toString("hex")}`);
	try {
		writeFileSync(probe, "probe");
		rmSync(probe, { force: true });
		return false;
	} catch {
		return true;
	}
})();

describe.skipIf(!sandboxLive || nestedRunner)("spawnSandboxed (real enforcement)", () => {
	const enabled: ResolvedSandboxConfig = {
		enabled: true,
		writablePaths: [],
		network: "open",
		onUnavailable: "passthrough",
	};

	it("allows a write to a path in the writable set (tmpdir)", async () => {
		const target = join(tmpdir(), `sandbox-live-allow-${randomBytes(4).toString("hex")}.txt`);
		try {
			const proc = await spawnSandboxed(`echo hello > "${target}"`, process.cwd(), enabled);
			const code = await proc.exited;
			expect(code).toBe(0);
			expect(readFileSync(target, "utf-8").trim()).toBe("hello");
		} finally {
			rmSync(target, { force: true });
		}
	});

	it("denies a write to a path outside the writable set (home dir)", async () => {
		const target = join(homedir(), `.sandbox-live-deny-${randomBytes(4).toString("hex")}`);
		const proc = await spawnSandboxed(`echo secret > "${target}"`, process.cwd(), enabled);
		const code = await proc.exited;
		// The shell redirect fails when the open() is denied: non-zero exit.
		expect(code).not.toBe(0);
		// And nothing is written to disk.
		let created = false;
		try {
			readFileSync(target, "utf-8");
			created = true;
			rmSync(target, { force: true });
		} catch {
			created = false;
		}
		expect(created).toBe(false);
	});

	// Identity resolution: getpwuid(3) must work inside the sandbox, or `ssh`
	// (hence `git push`) aborts with "No user exists for uid N" before reading
	// its config. mxc's baseline seatbelt profile blocks the opendirectoryd Mach
	// lookups that back it; we re-allow them via IDENTITY_MACH_LOOKUPS. The
	// regression signature is precise: `whoami` prints the bare numeric uid
	// instead of the username when the lookup is denied.
	it("resolves the current user via getpwuid (whoami is not a bare uid)", async () => {
		const proc = await spawnSandboxed("whoami", process.cwd(), enabled);
		let out = "";
		proc.stdout?.on("data", (d: Buffer) => {
			out += d.toString();
		});
		const code = await proc.exited;
		const who = out.trim();
		expect(code).toBe(0);
		// The bug surfaces as a purely-numeric uid; a resolved name is not.
		expect(who).not.toMatch(/^\d+$/);
		expect(who.length).toBeGreaterThan(0);
	});
});
