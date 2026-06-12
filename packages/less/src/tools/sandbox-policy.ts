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

/**
 * mxc SandboxPolicy schema version. The SDK validates this against its own
 * [MIN_VERSION, SUPPORTED_VERSION] window — 0.4.0-alpha .. 0.7.0-alpha as of
 * `@microsoft/mxc-sdk@0.6.1`. A missing or out-of-window version throws at
 * spawn. Bump this in lockstep with the dependency.
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

	return {
		version: POLICY_VERSION,
		filesystem: {
			readwritePaths: [...writable],
			// Deny-writes-only: the entire filesystem is readable; only the
			// writable set above can be written. Anything not under a
			// readwritePath inherits read-only from this root grant.
			readonlyPaths: ["/"],
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
