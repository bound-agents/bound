import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ResolvedSandboxConfig,
	buildPolicy,
	checkWritePath,
	computeGitProtectedPaths,
	computeWritableRoots,
	decideSandboxSpawn,
	formatWriteDenied,
	resolveSandboxConfig,
} from "../tools/sandbox-policy";

/**
 * Cross-platform coverage for the mxc filesystem-sandbox PURE logic. Everything
 * here imports only `../tools/sandbox-policy`, which pulls in NO `@microsoft/
 * mxc-sdk` (and therefore no transitive node-pty native addon). So this file
 * loads and runs identically on every CI runner — Linux, macOS, Windows —
 * regardless of whether a sandbox binary or node-pty prebuilt is present.
 *
 * It covers the security heart of the feature: config→policy normalization, the
 * deny-writes-only policy shape, and the enabled/available/onUnavailable spawn
 * decision. Real end-to-end write-denial (which needs a live binary) lives in
 * `sandbox.test.ts`, gated to platforms where mxc can actually contain.
 */
describe("resolveSandboxConfig", () => {
	it("defaults to ON when the setting is absent (opt-out)", () => {
		expect(resolveSandboxConfig(undefined)).toEqual({
			enabled: true,
			writablePaths: [],
			network: "open",
			onUnavailable: "passthrough",
		});
	});

	it("treats `true` as the same enabled default", () => {
		expect(resolveSandboxConfig(true)).toEqual({
			enabled: true,
			writablePaths: [],
			network: "open",
			onUnavailable: "passthrough",
		});
	});

	it("treats `false` as fully disabled", () => {
		expect(resolveSandboxConfig(false)).toEqual({
			enabled: false,
			writablePaths: [],
			network: "open",
			onUnavailable: "passthrough",
		});
	});

	it("fills per-field defaults for a partial object", () => {
		expect(resolveSandboxConfig({ writablePaths: ["/opt/extra"] })).toEqual({
			enabled: true,
			writablePaths: ["/opt/extra"],
			network: "open",
			onUnavailable: "passthrough",
		});
	});

	it("carries every explicit object field through", () => {
		expect(
			resolveSandboxConfig({
				enabled: true,
				writablePaths: ["/a", "/b"],
				network: "blocked",
				onUnavailable: "error",
			}),
		).toEqual({
			enabled: true,
			writablePaths: ["/a", "/b"],
			network: "blocked",
			onUnavailable: "error",
		});
	});

	it("honors `enabled: false` in object form", () => {
		expect(resolveSandboxConfig({ enabled: false }).enabled).toBe(false);
	});
});

describe("buildPolicy (deny-writes-only contract)", () => {
	const enabled: ResolvedSandboxConfig = {
		enabled: true,
		writablePaths: [],
		network: "open",
		onUnavailable: "passthrough",
	};

	it("grants the whole tree read-only so reads are unrestricted", () => {
		const policy = buildPolicy(process.cwd(), enabled);
		// The whole tree is granted read-only so reads stay unrestricted. The set
		// may also carry the `.git` exec-surface carve-out when cwd is a real repo
		// (see the ".git exec-surface protection" block) — assert membership of the
		// root grant rather than an exact set so this stays checkout-layout-agnostic.
		expect(policy.filesystem.readonlyPaths).toContain("/");
	});

	it("puts cwd and tmpdir in the writable set", () => {
		const policy = buildPolicy(process.cwd(), enabled);
		// realpathSync may rewrite either path (e.g. macOS /tmp symlink), so
		// assert the resolved forms are present rather than the raw inputs.
		expect(policy.filesystem.readwritePaths.length).toBeGreaterThanOrEqual(2);
		const hasCwd = policy.filesystem.readwritePaths.some(
			(p) => process.cwd().startsWith(p) || p === process.cwd(),
		);
		expect(hasCwd).toBe(true);
	});

	it("adds operator-listed extra writable paths", () => {
		const extra = join(tmpdir(), `sandbox-policy-extra-${randomBytes(4).toString("hex")}`);
		mkdirSync(extra, { recursive: true });
		try {
			const policy = buildPolicy(process.cwd(), { ...enabled, writablePaths: [extra] });
			// buildPolicy resolves through symlinks, so the stored form is the
			// realpath (e.g. macOS /var -> /private/var), not the raw input.
			expect(policy.filesystem.readwritePaths).toContain(realpathSync(extra));
		} finally {
			rmSync(extra, { recursive: true, force: true });
		}
	});

	it("opens outbound network and allows local listeners when network is 'open'", () => {
		const policy = buildPolicy(process.cwd(), enabled);
		expect(policy.network).toEqual({ allowOutbound: true, allowLocalNetwork: true });
	});

	it("denies all network when network is 'blocked'", () => {
		const policy = buildPolicy(process.cwd(), { ...enabled, network: "blocked" });
		expect(policy.network).toEqual({});
	});

	it("stamps a single schema version on every platform (NOT a backend selector)", () => {
		// Regression guard against re-introducing a per-platform version pin. The
		// schema version does not select the mxc backend: an earlier revision pinned
		// win32 to 0.4.0-alpha believing it fell back to AppContainer, and it was
		// verified inert (the native wxc-exec probe picks base-container by API-symbol
		// presence regardless of version). The Windows sandbox is gated on
		// feature-velocity keys, not the schema version. If this needs to differ per
		// platform, the reason must NOT be "to change the backend".
		const policy = buildPolicy(process.cwd(), enabled);
		expect(policy.version).toBe("0.6.0-alpha");
	});
});

describe("computeWritableRoots (git worktree gitdir resolution)", () => {
	const cfg: ResolvedSandboxConfig = {
		enabled: true,
		writablePaths: [],
		network: "open",
		onUnavailable: "passthrough",
	};

	let root: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "wt-")));
	});

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("adds the worktree gitdir and shared commondir to the writable set", () => {
		// Mirror git's worktree layout: the main repo's .git holds a per-worktree
		// gitdir under .git/worktrees/<name>, the worktree's own .git is a FILE
		// pointing at it, and that gitdir's `commondir` file points back at the
		// shared .git (where objects/ and packed-refs live). Both are OUTSIDE cwd.
		const mainGit = join(root, "repo", ".git");
		const wtGitdir = join(mainGit, "worktrees", "wt1");
		const worktree = join(root, "repo", ".worktrees", "wt1");
		mkdirSync(wtGitdir, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitdir}\n`);
		writeFileSync(join(wtGitdir, "commondir"), "../..\n");

		const roots = computeWritableRoots(worktree, cfg);
		expect(roots).toContain(realpathSync(worktree));
		expect(roots).toContain(realpathSync(wtGitdir));
		expect(roots).toContain(realpathSync(mainGit));
	});

	it("resolves an absolute commondir as-is", () => {
		const mainGit = join(root, "repo", ".git");
		const wtGitdir = join(mainGit, "worktrees", "wt1");
		const worktree = join(root, "elsewhere", "wt1");
		mkdirSync(wtGitdir, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitdir}\n`);
		writeFileSync(join(wtGitdir, "commondir"), `${mainGit}\n`);

		const roots = computeWritableRoots(worktree, cfg);
		expect(roots).toContain(realpathSync(wtGitdir));
		expect(roots).toContain(realpathSync(mainGit));
	});

	it("falls back to the gitdir alone when no commondir file exists", () => {
		const wtGitdir = join(root, "bare-gitdir");
		const worktree = join(root, "wt");
		mkdirSync(wtGitdir, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitdir}\n`);

		const roots = computeWritableRoots(worktree, cfg);
		expect(roots).toContain(realpathSync(wtGitdir));
	});

	it("leaves a normal checkout unaffected (.git is a directory, already under cwd)", () => {
		const repo = join(root, "normal");
		mkdirSync(join(repo, ".git"), { recursive: true });

		const roots = computeWritableRoots(repo, cfg);
		expect(roots).toContain(realpathSync(repo));
		// The .git dir is nested under cwd, already writable via the cwd root — it
		// must NOT be added as a separate root.
		expect(roots).not.toContain(realpathSync(join(repo, ".git")));
	});

	it("no-ops when cwd has no .git at all", () => {
		const bare = join(root, "plain");
		mkdirSync(bare, { recursive: true });

		const roots = computeWritableRoots(bare, cfg);
		// cwd + tmpdir only.
		expect(roots).toContain(realpathSync(bare));
		expect(roots).toContain(realpathSync(tmpdir()));
		expect(roots.length).toBe(2);
	});
});

describe("decideSandboxSpawn (enabled/available/onUnavailable branching)", () => {
	const base: ResolvedSandboxConfig = {
		enabled: true,
		writablePaths: [],
		network: "open",
		onUnavailable: "passthrough",
	};

	it("runs unsandboxed when the sandbox is disabled, regardless of availability", () => {
		expect(decideSandboxSpawn({ ...base, enabled: false }, { supported: true })).toEqual({
			mode: "unsandboxed",
		});
	});

	it("sandboxes when enabled and the platform supports mxc", () => {
		expect(decideSandboxSpawn(base, { supported: true })).toEqual({ mode: "sandboxed" });
	});

	it("passes through with the reason when unavailable and onUnavailable='passthrough'", () => {
		expect(decideSandboxSpawn(base, { supported: false, reason: "no bubblewrap" })).toEqual({
			mode: "passthrough",
			reason: "no bubblewrap",
		});
	});

	it("errors with the reason when unavailable and onUnavailable='error'", () => {
		expect(
			decideSandboxSpawn(
				{ ...base, onUnavailable: "error" },
				{ supported: false, reason: "no bubblewrap" },
			),
		).toEqual({ mode: "error", reason: "no bubblewrap" });
	});

	it("supplies a fallback reason when availability omits one", () => {
		const decision = decideSandboxSpawn(base, { supported: false });
		expect(decision.mode).toBe("passthrough");
		if (decision.mode === "passthrough") expect(decision.reason).toBeTruthy();
	});
});

describe("checkWritePath (in-process write guard)", () => {
	const cfg: ResolvedSandboxConfig = {
		enabled: true,
		writablePaths: [],
		network: "open",
		onUnavailable: "passthrough",
	};

	// A real temp dir as the cwd stand-in: realpathSync resolves it (on macOS
	// /tmp -> /private/tmp), so the test mirrors what the guard actually does.
	let repo: string;

	beforeEach(() => {
		repo = realpathSync(
			(() => {
				const d = join(tmpdir(), `writeguard-${randomBytes(4).toString("hex")}`);
				mkdirSync(d, { recursive: true });
				return d;
			})(),
		);
	});

	afterEach(() => {
		if (repo) rmSync(repo, { recursive: true, force: true });
	});

	it("allows a write inside cwd", () => {
		const check = checkWritePath("src/file.ts", repo, cfg);
		expect(check.allowed).toBe(true);
		expect(check.resolvedTarget).toBe(join(repo, "src/file.ts"));
	});

	it("allows a write to cwd itself and to a not-yet-existing nested path", () => {
		expect(checkWritePath(".", repo, cfg).allowed).toBe(true);
		expect(checkWritePath("a/b/c/deep.txt", repo, cfg).allowed).toBe(true);
	});

	it("allows a write into tmpdir (always in the writable set)", () => {
		const target = join(tmpdir(), `scratch-${randomBytes(4).toString("hex")}.txt`);
		expect(checkWritePath(target, repo, cfg).allowed).toBe(true);
	});

	it("denies a write outside cwd and tmpdir (absolute escape)", () => {
		const check = checkWritePath("/etc/passwd", repo, cfg);
		expect(check.allowed).toBe(false);
		expect(check.writableRoots).toContain(repo);
	});

	it("denies a relative path that climbs out of cwd with ..", () => {
		const check = checkWritePath("../../../etc/hosts", repo, cfg);
		expect(check.allowed).toBe(false);
	});

	it("does NOT confuse a sibling dir with a writable-root prefix-match", () => {
		// `/srv/app` is a writable root; `/srv/application` string-prefixes it but
		// is not nested. Neither lives under tmpdir, so the only thing that could
		// allow it is a naive startsWith — which isWithin must reject. (Both paths
		// are non-existent; computeWritableRoots falls back to the raw path.)
		const widened = { ...cfg, writablePaths: ["/srv/app"] };
		expect(checkWritePath("/srv/app/ok.txt", repo, widened).allowed).toBe(true);
		expect(checkWritePath("/srv/application/evil.txt", repo, widened).allowed).toBe(false);
	});

	it("honors an explicit extra writablePath (and denies without it)", () => {
		// A path outside cwd AND tmpdir, so the ONLY thing that can allow it is the
		// explicit extra. Non-existent → exercises the raw-path fallback too.
		const extra = "/srv/custom-data";
		const target = `${extra}/ok.txt`;
		expect(checkWritePath(target, repo, { ...cfg, writablePaths: [extra] }).allowed).toBe(true);
		expect(checkWritePath(target, repo, cfg).allowed).toBe(false);
	});

	// POSIX-only: creating a directory symlink on Windows needs reparse-point
	// privilege (developer mode or admin), and the resolveThroughExisting logic
	// being exercised here is platform-agnostic path math already covered on the
	// Windows lane by the integration suite. Skip the fixture, not the property.
	it.skipIf(process.platform === "win32")("resists a symlinked-directory escape inside cwd", () => {
		// repo/escape -> /etc ; a write to repo/escape/x must resolve THROUGH the
		// symlink (out of cwd) and be denied, not allowed by its cwd-prefixed name.
		const link = join(repo, "escape");
		symlinkSync("/etc", link);
		const check = checkWritePath("escape/evil.conf", repo, cfg);
		expect(check.allowed).toBe(false);
		// The symlink was followed: the target no longer sits under repo. (On macOS
		// /etc itself is a symlink to /private/etc, so don't assert a literal /etc.)
		expect(check.resolvedTarget.startsWith(repo)).toBe(false);
		expect(check.resolvedTarget).toContain("etc");
	});
});

// The `.git` exec-surface carve-out: hooks + config are kept read-only even
// though they live inside the otherwise-writable cwd. Enforced on bubblewrap
// (via buildPolicy.readonlyPaths) and for the in-process file tools everywhere
// EXCEPT Windows, which has no mxc backend able to express "readable but not
// writable" for a subpath — so `.git` stays writable there (see
// computeGitProtectedPaths). These tests pass an explicit `platform` where the
// behavior is platform-dependent so they assert the same thing on every runner.
describe(".git exec-surface protection", () => {
	const cfg: ResolvedSandboxConfig = {
		enabled: true,
		writablePaths: [],
		network: "open",
		onUnavailable: "passthrough",
	};

	let repo: string;

	beforeEach(() => {
		repo = realpathSync(
			(() => {
				const d = join(tmpdir(), `gitguard-${randomBytes(4).toString("hex")}`);
				mkdirSync(join(d, ".git", "hooks"), { recursive: true });
				writeFileSync(join(d, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
				return d;
			})(),
		);
	});

	afterEach(() => {
		if (repo) rmSync(repo, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")(
		"denies a write to a hook script even though it is inside cwd (non-win32)",
		() => {
			const check = checkWritePath(".git/hooks/post-checkout", repo, cfg);
			expect(check.allowed).toBe(false);
			expect(check.gitProtected).toBe(true);
		},
	);

	it.skipIf(process.platform === "win32")("denies overwriting .git/config (non-win32)", () => {
		const check = checkWritePath(".git/config", repo, cfg);
		expect(check.allowed).toBe(false);
		expect(check.gitProtected).toBe(true);
	});

	it("still allows ordinary writes inside cwd and the rest of .git", () => {
		expect(checkWritePath("src/index.ts", repo, cfg).allowed).toBe(true);
		// index / refs / logs / objects must stay writable or git itself breaks.
		expect(checkWritePath(".git/index", repo, cfg).allowed).toBe(true);
		expect(checkWritePath(".git/refs/heads/main", repo, cfg).allowed).toBe(true);
	});

	it("does not over-block a sibling that string-prefixes a protected file", () => {
		// `.git/configuration` prefixes `.git/config` but is not it nor under it.
		expect(checkWritePath(".git/configuration", repo, cfg).allowed).toBe(true);
	});

	it("computeGitProtectedPaths resolves the existing hooks dir and config file", () => {
		const paths = computeGitProtectedPaths(repo, "linux");
		expect(paths).toContain(realpathSync(join(repo, ".git", "hooks")));
		expect(paths).toContain(realpathSync(join(repo, ".git", "config")));
	});

	it("returns [] on Windows — .git stays writable where mxc can't carve it out", () => {
		expect(computeGitProtectedPaths(repo, "win32")).toEqual([]);
		// And the in-process guard agrees: the same write the non-win32 lanes deny
		// is allowed once the platform gate trips. (checkWritePath uses the real
		// process.platform, so this asserts the gate via the helper directly.)
		const winProtected = computeGitProtectedPaths(repo, "win32");
		expect(winProtected.some((p) => p.includes(".git"))).toBe(false);
	});

	it("returns [] for a non-repo cwd — nothing to protect, no broken bind", () => {
		const bare = realpathSync(
			(() => {
				const d = join(tmpdir(), `norepo-${randomBytes(4).toString("hex")}`);
				mkdirSync(d, { recursive: true });
				return d;
			})(),
		);
		try {
			expect(computeGitProtectedPaths(bare, "linux")).toEqual([]);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")(
		"buildPolicy layers the protected paths into readonlyPaths after the cwd grant (non-win32)",
		() => {
			const policy = buildPolicy(repo, cfg);
			const ro = policy.filesystem.readonlyPaths;
			expect(ro[0]).toBe("/");
			expect(ro).toContain(realpathSync(join(repo, ".git", "hooks")));
			expect(ro).toContain(realpathSync(join(repo, ".git", "config")));
			// cwd stays in the writable set — the carve-out is a hole, not a lockout.
			expect(policy.filesystem.readwritePaths).toContain(repo);
		},
	);
});

describe("formatWriteDenied", () => {
	it("names the tool, the resolved target, the roots, and both escape hatches", () => {
		const msg = formatWriteDenied("boundless_write", "/etc/passwd", {
			allowed: false,
			resolvedTarget: "/etc/passwd",
			writableRoots: ["/repo", "/tmp"],
		});
		expect(msg).toContain("boundless_write refused");
		expect(msg).toContain("/etc/passwd");
		expect(msg).toContain("/repo");
		expect(msg).toContain("/tmp");
		expect(msg).toContain("sandbox.writablePaths");
		expect(msg).toContain('"sandbox": false');
	});

	it("explains the git exec-surface case distinctly and offers the right escape hatch", () => {
		const msg = formatWriteDenied("boundless_write", ".git/hooks/post-checkout", {
			allowed: false,
			resolvedTarget: "/repo/.git/hooks/post-checkout",
			writableRoots: ["/repo", "/tmp"],
			gitProtected: true,
		});
		expect(msg).toContain("boundless_write refused");
		expect(msg).toContain("Git exec-surface");
		expect(msg).toContain(".git/hooks");
		expect(msg).toContain(".git/config");
		// The writablePaths hatch does NOT apply here (the path IS inside cwd), so
		// only the disable-the-guard hatch is offered.
		expect(msg).toContain('"sandbox": false');
		expect(msg).not.toContain("sandbox.writablePaths");
	});
});
