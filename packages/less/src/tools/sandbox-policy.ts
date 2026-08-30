/**
 * SDK-free policy and config core for the boundless filesystem sandbox.
 *
 * This module deliberately imports NOTHING from `@microsoft/mxc-sdk`. The SDK's
 * entrypoint eagerly re-exports `sandbox.js`, whose top-level
 * `import pty from 'node-pty'` loads a native addon at module-eval. Keeping the
 * pure logic — config normalization, the deny-writes-only policy shape, the
 * spawn decision — in a separate module lets it (and its tests) load on every
 * platform regardless of whether node-pty's prebuilt is present or loadable.
 * The SDK-dependent spawn path lives in `./sandbox`, which lazy-loads the SDK so
 * node-pty is only touched when a command is actually sandboxed.
 *
 * The policy shape mirrors an empirically-verified probe: reads anywhere
 * succeed, writes outside the writable set are denied, network is open.
 */
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * mxc SandboxPolicy schema version. The SDK validates this against its own
 * [MIN_VERSION, SUPPORTED_VERSION] window — 0.4.0-alpha .. 0.7.0-alpha as of
 * `@microsoft/mxc-sdk@0.6.1`. A missing or out-of-window version throws at
 * spawn. Bump this in lockstep with the dependency.
 *
 * NOT a backend selector. This schema version applies only to the mxc-backed
 * POSIX path (seatbelt on macOS and bubblewrap on Linux). Windows dispatches
 * directly to Bound's native lowbox helper before this policy reaches mxc, so a
 * per-platform version pin cannot change the Windows backend.
 */
export const POLICY_VERSION = "0.6.0-alpha";

/**
 * opendirectoryd Mach services that back user/group identity resolution on
 * macOS. `getpwuid(3)`/`getgrgid(3)` (and everything layered on them —
 * `whoami`, `id`, `ssh`'s `~/.ssh/config` lookup, `sudo`, git's committer
 * fallback) resolve through libinfo → opendirectoryd over these Mach names.
 *
 * mxc's baseline seatbelt profile does NOT allow them, so inside the sandbox
 * `getpwuid(geteuid())` returns no record: `whoami` prints the bare uid and
 * `ssh` aborts with "No user exists for uid N" before it can read its config,
 * which breaks `git push` over SSH. Identity lookup is a READ with no write or
 * filesystem-escape capability — opendirectoryd enforces its own auth on the
 * privileged (write) APIs, and the libinfo/membership endpoints are read-only
 * name resolution — so allowing it is consistent with deny-writes-only. mxc's
 * `SeatbeltConfig.extraMachLookups` escape hatch is the supported way to add
 * them; applied unconditionally whenever the (seatbelt) sandbox is enabled.
 */
export const IDENTITY_MACH_LOOKUPS: readonly string[] = [
	"com.apple.system.opendirectoryd.libinfo",
	"com.apple.system.opendirectoryd.membership",
	"com.apple.system.DirectoryService.libinfo",
	"com.apple.system.DirectoryService.membership",
];

export type SandboxNetwork = "open" | "blocked";
export type SandboxOnUnavailable = "passthrough" | "error";

/**
 * Git worktree metadata captured while Boundless initializes the session, before
 * the model receives a filesystem-writing tool. It is deliberately not derived
 * from `.git` at tool-execution time: that file is workspace-controlled.
 */
export interface GitWorktreeMetadata {
	gitdir: string;
	commondir: string;
	/** Existing Git execution surfaces resolved by Git before tool exposure. */
	protectedPaths: string[];
}

/** Normalized sandbox settings, resolved from the `sandbox` config field. */
export interface ResolvedSandboxConfig {
	enabled: boolean;
	/** Absolute paths granted write access beyond cwd + tmpdir. */
	writablePaths: string[];
	network: SandboxNetwork;
	onUnavailable: SandboxOnUnavailable;
	/** Captured once at session startup; never recompute from a tool-mutated workspace. */
	gitWorktreeMetadata?: GitWorktreeMetadata;
}

/**
 * The raw `sandbox` config value as parsed by the Zod schema: `boolean` for the
 * shorthand, or the object form for finer control.
 */
export type SandboxSetting =
	| boolean
	| {
			enabled?: boolean;
			writablePaths?: string[];
			network?: SandboxNetwork;
			onUnavailable?: SandboxOnUnavailable;
	  };

/** A disabled sandbox — the explicit "run commands unsandboxed" posture. */
export const DISABLED_SANDBOX: ResolvedSandboxConfig = {
	enabled: false,
	writablePaths: [],
	network: "open",
	onUnavailable: "passthrough",
};

/**
 * Environment for spawned shell commands. The boundless shell tool attaches a
 * TTY but has NO interactive input channel, so any program that pages its
 * output (git, man, systemctl) or prompts for input (git credential helpers)
 * blocks forever waiting for a keypress that can never arrive. Force pagers to
 * passthrough and disable git's terminal prompt so those programs stream to
 * stdout and exit instead of hanging.
 *
 * These override inherited values (e.g. a host `PAGER=less`) on purpose: an
 * interactive pager cannot function in this context regardless of preference.
 *
 * `confineBunCache` (set by the SANDBOXED spawn paths only): bun stages
 * package installs in its global cache (`~/.bun/install/cache`) before
 * linking into node_modules, and that path sits outside the sandbox's
 * writable roots (cwd + tmpdir) — so every `bun add` / `bun install` under
 * confinement dies with the misleading "unable to write files to tempdir:
 * PermissionDenied" (TMPDIR is irrelevant; the write that fails is the cache
 * dir's). Pointing `BUN_INSTALL_CACHE_DIR` at a tmpdir-local cache keeps
 * installs working with zero caller ceremony. Installed packages are ordinary
 * files (hardlink count 1), so a cleared tmp cache never breaks an existing
 * node_modules. An operator-set `BUN_INSTALL_CACHE_DIR` is honored — they may
 * have deliberately pointed it somewhere writable. Unsandboxed spawns keep
 * the warm global cache.
 */
export function nonInteractiveEnv(
	opts: { confineBunCache?: boolean } = {},
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...process.env,
		GIT_PAGER: "cat",
		PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
	};
	if (opts.confineBunCache && !process.env.BUN_INSTALL_CACHE_DIR) {
		env.BUN_INSTALL_CACHE_DIR = join(tmpdir(), "bound-bun-install-cache");
	}
	return env;
}

/**
 * The subset of `Bun.Subprocess` the bash streaming loop consumes: a web
 * `ReadableStream` per pipe, an `exited` promise resolving to the exit code,
 * a pid for process-group signalling, and a `kill`. The mxc adapter produces
 * this shape from a Node `ChildProcess` so the two spawn paths are
 * interchangeable downstream.
 */
export interface SandboxSpawnResult {
	stdout: ReadableStream<Uint8Array> | null;
	stderr: ReadableStream<Uint8Array> | null;
	exited: Promise<number>;
	pid: number;
	kill(signal?: number | NodeJS.Signals): void;
}

/** Normalize the raw config `sandbox` value into {@link ResolvedSandboxConfig}. */
export function resolveSandboxConfig(
	setting: SandboxSetting | undefined,
	cwd: string = process.cwd(),
): ResolvedSandboxConfig {
	const base =
		setting === false
			? DISABLED_SANDBOX
			: {
					enabled: setting === true || setting === undefined ? true : (setting.enabled ?? true),
					writablePaths:
						setting === true || setting === undefined ? [] : (setting.writablePaths ?? []),
					network: setting === true || setting === undefined ? "open" : (setting.network ?? "open"),
					onUnavailable:
						setting === true || setting === undefined
							? "error"
							: (setting.onUnavailable ?? "error"),
				};
	// This runs while Boundless creates its tool session, before the model can
	// create or rewrite cwd/.git. Failure is intentionally fail-closed: linked
	// worktree git writes lose their external grants rather than widening them.
	const gitWorktreeMetadata = captureGitWorktreeMetadata(cwd);
	return gitWorktreeMetadata ? { ...base, gitWorktreeMetadata } : base;
}

/**
 * The spawn path chosen for a command given the resolved config and current
 * platform availability. `passthrough` and `error` only arise when the sandbox
 * is enabled but mxc can't contain on this platform — the common case on a CI
 * runner with no staged binary. `reason` carries the availability diagnostic
 * for the warning ("passthrough") or the thrown error ("error").
 */
export type SandboxSpawnDecision =
	| { mode: "unsandboxed" }
	| { mode: "sandboxed" }
	| { mode: "passthrough"; reason: string }
	| { mode: "error"; reason: string };

/**
 * Pure decision for how to spawn a command: the four-way branch on
 * enabled/available/onUnavailable, separated from the spawn I/O so it can be
 * exercised on every platform without a real sandbox binary. `spawnForBash`
 * dispatches on the result.
 */
export function decideSandboxSpawn(
	sandbox: ResolvedSandboxConfig,
	availability: { supported: boolean; reason?: string },
): SandboxSpawnDecision {
	if (!sandbox.enabled) return { mode: "unsandboxed" };
	if (availability.supported) return { mode: "sandboxed" };
	const reason = availability.reason ?? "platform not supported";
	if (sandbox.onUnavailable === "error") return { mode: "error", reason };
	return { mode: "passthrough", reason };
}

/**
 * Build the mxc policy from resolved config: every path in the writable set
 * (cwd + tmpdir + extras, resolved through symlinks) gets read-write, the
 * whole tree ("/") is read-only, so reads are unrestricted and writes are
 * confined. Network is open unless explicitly blocked.
 *
 * Exported for cross-platform policy-shape tests: the deny-writes-only contract
 * (cwd + tmpdir read-write, "/" read-only, network gated) is the security heart
 * of the feature and must hold regardless of whether the binary can run here.
 */
export function buildPolicy(cwd: string, cfg: ResolvedSandboxConfig) {
	return {
		version: POLICY_VERSION,
		filesystem: {
			readwritePaths: computeWritableRoots(cwd, cfg),
			// Deny-writes-only: the entire filesystem is readable; only the
			// writable set above can be written. Anything not under a
			// readwritePath inherits read-only from this root grant.
			//
			// The `.git` exec-surface paths (hooks + config) are layered on AFTER
			// "/" so they carve a read-only hole out of the otherwise-writable cwd.
			// This bites on bubblewrap, where the builder emits readonly binds after
			// readwrite ones and "later mounts win, overriding any rw parent"
			// [microsoft/mxc src/backends/bubblewrap/.../bwrap_command.rs]. On
			// seatbelt it is an inert allow-read (seatbelt readonly cannot subtract
			// an existing write grant), and on Windows it is empty — see
			// computeGitProtectedPaths for why. The in-process checkWritePath guard
			// enforces the same carve-out for the TS file tools on every platform
			// except Windows.
			readonlyPaths: ["/", ...computeGitProtectedPaths(cwd, undefined, cfg.gitWorktreeMetadata)],
		},
		// All network flags default to false (no access) when `network` is
		// omitted, so "blocked" is the empty object. "open" must be genuinely
		// open: allowOutbound covers egress, and allowLocalNetwork lets the
		// sandboxed process bind()+listen() on local IP listeners (per the mxc
		// NetworkConfig contract). Without the latter, `listen()` is EPERM'd —
		// which silently breaks running tests and dev servers (anything that
		// opens a localhost port) under the shell, contradicting "network open".
		network: cfg.network === "open" ? { allowOutbound: true, allowLocalNetwork: true } : {},
	};
}

/**
 * The realpath-resolved set of directories writable under the deny-writes-only
 * policy: cwd + tmpdir + any explicit extras. Shared by {@link buildPolicy}
 * (the mxc kernel guard) and {@link checkWritePath} (the in-process guard for
 * the TS file tools) so both enforce the identical writable set. Symlinks are
 * resolved so two names for the same directory compare equal.
 */
export function computeWritableRoots(cwd: string, cfg: ResolvedSandboxConfig): string[] {
	const writable = new Set<string>();
	const addPath = (p: string) => {
		try {
			writable.add(realpathSync(p));
		} catch {
			writable.add(p);
		}
	};
	addPath(cwd);
	addPath(tmpdir());
	// README contract: "writes are confined to the working directory and /tmp".
	// On Linux os.tmpdir() IS /tmp so the line above already covers it, but on
	// macOS os.tmpdir() is /var/folders/<user>/T — the literal /tmp (realpath
	// /private/tmp) was never in the set, so portable shell idioms like
	// `cat > /tmp/x` died with EPERM. Guarded by existence so Windows (no
	// /tmp) is unaffected.
	try {
		if (statSync("/tmp").isDirectory()) addPath("/tmp");
	} catch {
		// no /tmp on this platform — nothing to grant
	}
	for (const dir of cfg.gitWorktreeMetadata
		? [cfg.gitWorktreeMetadata.gitdir, cfg.gitWorktreeMetadata.commondir]
		: [])
		addPath(dir);
	for (const extra of cfg.writablePaths) addPath(extra);
	return [...writable];
}

/**
 * Paths under the working repo's `.git` that hold code git later runs *as the
 * operator*, outside the sandbox: the hook scripts in the repo's `.git/hooks`
 * directory and the
 * `core.hooksPath` / `core.fsmonitor` / `core.sshCommand` / `core.pager` /
 * `alias.* = "!cmd"` directives in `.git/config`. The agent never legitimately
 * writes these — its own git runs through the shell and only ever *reads*
 * config — so confining them read-only closes the "plant a payload now, fire it
 * on the human's next `git` in the repo" vector without touching the writable
 * parts of `.git` (index, refs, logs, objects) that ordinary git operations
 * need. Carved out of the otherwise-writable cwd by {@link buildPolicy} (the mxc
 * kernel guard) and {@link checkWritePath} (the in-process file-tool guard).
 *
 * Returns realpath-resolved, *existing* paths only: a bubblewrap `--ro-bind` of
 * a missing source aborts the sandbox, and a non-repo cwd (or a worktree/submodule
 * whose `.git` is a file, not a dir) simply has nothing to bind.
 *
 * The protected path set is platform-independent. POSIX shell confinement
 * consumes it as read-only bind paths; the bound-owned Windows lowbox helper
 * enforces the same carve-out through scoped DACLs. Keeping it here also makes
 * the in-process file tools refuse writes consistently on every platform.
 */
export function computeGitProtectedPaths(
	cwd: string,
	_platform?: NodeJS.Platform,
	metadata?: GitWorktreeMetadata,
): string[] {
	if (metadata) return metadata.protectedPaths;
	const protectedPaths: string[] = [];
	for (const rel of ["hooks", "config", "config.worktree"] as const) {
		try {
			protectedPaths.push(realpathSync(join(cwd, ".git", rel)));
		} catch {
			// Missing paths are never bound: a missing readonly bind aborts mxc.
		}
	}
	return [...new Set(protectedPaths)];
}

/**
 * Extra writable directories a git WORKTREE needs that live OUTSIDE cwd. In a
 * normal checkout `cwd/.git` is a directory nested under cwd, already covered by
 * the cwd root. In a worktree it is instead a FILE — `gitdir: <abs path>` —
 * pointing at the main repo's `.git/worktrees/<name>`, and that gitdir's
 * `commondir` file points back at the shared `.git` (where `objects/`,
 * `packed-refs`, etc. live). Both sit outside cwd, so without granting them the
 * worktree's index.lock, loose-object writes, and ref updates all EPERM and
 * `git commit` dies at the first commit. We return BOTH the per-worktree gitdir
 * and the shared commondir.
 *
 * Resolved by reading files (the `.git` pointer and the `commondir` file) rather
 * than spawning `git rev-parse` — no subprocess, works even when git isn't on
 * PATH, and stays a pure fs read like the rest of this module. A normal checkout
 * (`.git` is a directory) and a cwd with no `.git` at all both return `[]`.
 */
export function captureGitWorktreeMetadata(cwd: string): GitWorktreeMetadata | undefined {
	try {
		const discovery = spawnSync("git", ["-C", cwd, "rev-parse", "--git-dir", "--git-common-dir"], {
			encoding: "utf8",
		});
		if (discovery.status !== 0) return undefined;
		const [rawGitdir, rawCommonDir] = discovery.stdout.trim().split(/\r?\n/);
		if (!rawGitdir || !rawCommonDir) return undefined;
		const gitdir = realpathSync(resolve(cwd, rawGitdir));
		const commondir = realpathSync(resolve(cwd, rawCommonDir));
		// Git itself creates linked-worktree administrative directories beneath
		// <commondir>/worktrees. A normal checkout uses the common directory itself.
		if (gitdir !== commondir && !isWithin(gitdir, join(commondir, "worktrees"))) return undefined;

		const protectedPaths: string[] = [];
		for (const base of new Set([gitdir, commondir])) {
			for (const rel of ["hooks", "config", "config.worktree"] as const) {
				try {
					protectedPaths.push(realpathSync(join(base, rel)));
				} catch {
					// A missing path cannot be a sandbox bind and remains absent.
				}
			}
		}
		// Let Git parse its effective config (includes, quotes, escape sequences, and
		// config.worktree overrides) and normalize the path before tools run.
		const hooksPath = spawnSync("git", ["-C", cwd, "config", "--path", "--get", "core.hooksPath"], {
			encoding: "utf8",
		});
		if (hooksPath.status === 0 && hooksPath.stdout.trim()) {
			try {
				const configuredHooksPath = hooksPath.stdout.trim();
				protectedPaths.push(
					realpathSync(
						isAbsolute(configuredHooksPath)
							? configuredHooksPath
							: resolve(cwd, configuredHooksPath),
					),
				);
			} catch {
				// A missing hooks path is harmless: no bind is possible yet.
			}
		}
		return { gitdir, commondir, protectedPaths: [...new Set(protectedPaths)] };
	} catch {
		return undefined;
	}
}

/**
 * Resolve symlinks along the deepest *existing* ancestor of a path that may not
 * exist yet (a write creates it). Walks up until a component resolves, realpaths
 * that, then re-appends the not-yet-existing tail — so a symlinked directory in
 * the chain (e.g. `repo/escape -> /etc`) can't smuggle a write outside the set.
 */
function resolveThroughExisting(absPath: string): string {
	let existing = absPath;
	const tail: string[] = [];
	for (;;) {
		try {
			let out = realpathSync(existing);
			for (let i = tail.length - 1; i >= 0; i--) out = resolve(out, tail[i]);
			return out;
		} catch {
			const parent = dirname(existing);
			if (parent === existing) return absPath; // hit filesystem root, nothing resolvable
			tail.push(basename(existing));
			existing = parent;
		}
	}
}

/** True when `target` is `root` itself or nested beneath it. */
function isWithin(target: string, root: string): boolean {
	if (target === root) return true;
	const rel = relative(root, target);
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Result of a {@link checkWritePath} validation against the writable set. */
export interface WritePathCheck {
	allowed: boolean;
	/** The target after cwd-resolution and symlink-through-existing-ancestor. */
	resolvedTarget: string;
	/** The writable roots the target was checked against. */
	writableRoots: string[];
	/**
	 * True when the target sits inside a writable root but was denied because it
	 * falls under a `.git` exec-surface carve-out (see
	 * {@link computeGitProtectedPaths}). Distinguishes the "git-protected" denial
	 * (a deliberate read-only hole in the writable cwd) from the ordinary
	 * "outside the writable set" denial, so {@link formatWriteDenied} can explain it.
	 */
	gitProtected?: boolean;
}

/**
 * In-process mirror of the sandbox's deny-writes-only filesystem policy, for the
 * TS file tools (write/edit/copy) that call `fs` directly and never pass through
 * mxc's kernel guard. Pure path math — no mxc, no native binary, no platform
 * dependency — so it holds even where the sandbox can't run (the `passthrough`
 * case), and it only ever gates *write targets*: reads stay unrestricted, exactly
 * like the kernel policy. Callers enforce only when `cfg.enabled`.
 */
export function checkWritePath(
	targetPath: string,
	cwd: string,
	cfg: ResolvedSandboxConfig,
): WritePathCheck {
	const writableRoots = computeWritableRoots(cwd, cfg);
	const protectedRoots = computeGitProtectedPaths(cwd, undefined, cfg.gitWorktreeMetadata);
	const absTarget = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);
	const resolvedTarget = resolveThroughExisting(absTarget);
	const withinWritable = writableRoots.some((root) => isWithin(resolvedTarget, root));
	// A `.git` exec-surface path sits inside the writable cwd but is carved out
	// read-only (see computeGitProtectedPaths), so the protected check must win
	// over the writable check.
	const gitProtected = protectedRoots.some((root) => isWithin(resolvedTarget, root));
	return { allowed: withinWritable && !gitProtected, resolvedTarget, writableRoots, gitProtected };
}

/**
 * Rich, actionable denial message for a write blocked by {@link checkWritePath}.
 * Names the resolved target, lists the writable roots, and points at both
 * escape hatches (widen `sandbox.writablePaths`, or disable the sandbox).
 */
export function formatWriteDenied(
	toolName: string,
	targetPath: string,
	check: WritePathCheck,
): string {
	if (check.gitProtected) {
		return [
			`Error: ${toolName} refused — "${targetPath}" resolves to ${check.resolvedTarget}, a Git exec-surface path (.git/hooks or .git/config) the sandbox keeps read-only.`,
			"",
			"These hold code Git later runs as the operator outside the sandbox (hook scripts; config directives like core.hooksPath, core.fsmonitor, core.sshCommand, aliases), so they stay read-only even though the rest of the working tree is writable. Git's normal operations only ever read them.",
			"",
			'To allow this write, set "sandbox": false in your boundless config to disable the guard entirely.',
		].join("\n");
	}
	const roots = check.writableRoots.map((r) => `  - ${r}`).join("\n");
	return [
		`Error: ${toolName} refused — "${targetPath}" resolves to ${check.resolvedTarget}, which is outside the sandbox writable set.`,
		"",
		"The filesystem sandbox is enabled (deny-writes-only); writes are confined to:",
		roots,
		"",
		'To allow this write, add the path to "sandbox.writablePaths" in your boundless config, or set "sandbox": false to disable the guard entirely.',
	].join("\n");
}
