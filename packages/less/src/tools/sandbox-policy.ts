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
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * mxc SandboxPolicy schema version. The SDK validates this against its own
 * [MIN_VERSION, SUPPORTED_VERSION] window — 0.4.0-alpha .. 0.7.0-alpha as of
 * `@microsoft/mxc-sdk@0.6.1`. A missing or out-of-window version throws at
 * spawn. Bump this in lockstep with the dependency.
 *
 * NOT a backend selector. The schema version does NOT pick the platform backend:
 * `createConfigFromPolicy` maps the abstract "process" containment to a fixed
 * per-OS structure (seatbelt / bubblewrap / Windows BaseContainer) regardless of
 * version, and there is no `appcontainer` containment branch in the SDK at all.
 * An earlier revision pinned win32 to 0.4.0-alpha believing it would fall back to
 * AppContainer — verified inert: the wire payload carried 0.4.0-alpha and the
 * native `wxc-exec` still selected BaseContainer (the `wxc-exec --probe` detector
 * picks `base-container` whenever the BaseContainer API symbol resolves, which it
 * does on 24H2+). Do not re-introduce a per-platform version pin to change the
 * backend; it cannot. The Windows sandbox is gated on feature-velocity keys, not
 * the schema version — see `checkSandboxAvailable` in `./sandbox` and the
 * "boundless" sandbox section in README.md.
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

/** Normalized sandbox settings, resolved from the `sandbox` config field. */
export interface ResolvedSandboxConfig {
	enabled: boolean;
	/** Absolute paths granted write access beyond cwd + tmpdir. */
	writablePaths: string[];
	network: SandboxNetwork;
	onUnavailable: SandboxOnUnavailable;
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
 */
export function nonInteractiveEnv(): Record<string, string | undefined> {
	return {
		...process.env,
		GIT_PAGER: "cat",
		PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
	};
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
export function resolveSandboxConfig(setting: SandboxSetting | undefined): ResolvedSandboxConfig {
	// Absent → opt-out default is ON (a fresh install with no config still
	// gets the guard). `false` shorthand → disabled.
	if (setting === undefined || setting === true) {
		return { enabled: true, writablePaths: [], network: "open", onUnavailable: "passthrough" };
	}
	if (setting === false) {
		return DISABLED_SANDBOX;
	}
	return {
		enabled: setting.enabled ?? true,
		writablePaths: setting.writablePaths ?? [],
		network: setting.network ?? "open",
		onUnavailable: setting.onUnavailable ?? "passthrough",
	};
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
			readonlyPaths: ["/", ...computeGitProtectedPaths(cwd)],
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
 * WINDOWS CARVE-OUT (returns `[]` on win32): none of mxc's Windows backends can
 * express "readable but not writable" for a subpath of a writable parent. The
 * DACL and base-container tiers only have additive allow-ACLs plus a full-access
 * *deny* — and a full-access deny on `.git/config` would also block git's own
 * *reads* of config and break the repo. There is no write-only deny primitive,
 * so the only Windows options are "no protection" or "break git"; we choose no
 * protection and leave `.git` writable there until mxc grows the primitive
 * (tracked upstream — see CONTRIBUTING "Common Gotchas" and the bound issue).
 * Linux (bubblewrap) and the in-process file-tool guard still apply on every
 * other platform.
 */
const GIT_EXEC_SURFACE_RELPATHS = [".git/hooks", ".git/config"] as const;

export function computeGitProtectedPaths(
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (platform === "win32") return [];
	const protectedPaths: string[] = [];
	for (const rel of GIT_EXEC_SURFACE_RELPATHS) {
		try {
			protectedPaths.push(realpathSync(resolve(cwd, rel)));
		} catch {
			// Missing (non-repo cwd, or `.git` is a worktree/submodule file) — nothing to bind.
		}
	}
	return protectedPaths;
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
	const protectedRoots = computeGitProtectedPaths(cwd);
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
