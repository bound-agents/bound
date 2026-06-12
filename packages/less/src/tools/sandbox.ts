/**
 * Optional filesystem sandboxing for the boundless bash-family tool, backed by
 * Microsoft's mxc (`@microsoft/mxc-sdk`). When enabled (the default), shell
 * commands run inside a containment that keeps the whole filesystem READABLE
 * but confines WRITES to the working directory + system temp dir (plus any
 * operator-listed extra paths). The goal is to guard the filesystem OUTSIDE
 * the working directory — the repo the agent is working in stays read-write,
 * but it can't clobber `~/.ssh`, `/etc`, a sibling checkout, etc.
 *
 * Cross-platform by way of mxc's abstract "process" containment, which
 * resolves to seatbelt on macOS and bubblewrap on Linux (Windows uses its
 * native sandbox backends). On a platform where mxc can't sandbox, behavior
 * follows `onUnavailable`: "passthrough" (default) runs the command unsandboxed
 * with a warning rather than break the shell; "error" refuses to run it.
 *
 * The pure config/policy/decision logic lives in `./sandbox-policy` (SDK-free,
 * loads on every platform) and is re-exported here for back-compat. This module
 * holds only the SDK-dependent spawn path, and it LAZY-loads the SDK: the import
 * happens inside the async functions, not at module-eval. That matters because
 * the SDK's entrypoint eagerly re-exports `sandbox.js` whose top-level
 * `import pty from 'node-pty'` loads a native addon — so a static top-level
 * import would drag node-pty in just to import this module (e.g. at boundless
 * startup with `sandbox: false`, or in a unit test of the pure logic). Deferring
 * the import means node-pty is only touched when a command is actually
 * sandboxed, and a broken/missing prebuilt degrades to `onUnavailable` rather
 * than failing the import.
 */
import type { ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { ensureMxcRuntime } from "./mxc-runtime";
import { buildPolicy, IDENTITY_MACH_LOOKUPS, nonInteractiveEnv } from "./sandbox-policy";
import type { ResolvedSandboxConfig, SandboxSpawnResult } from "./sandbox-policy";

// Re-export the SDK-free surface so existing import sites (`./sandbox`) keep
// working unchanged.
export * from "./sandbox-policy";

/** Lazily-loaded `@microsoft/mxc-sdk`, memoized after the first import. */
type MxcSdk = typeof import("@microsoft/mxc-sdk");
let sdkPromise: Promise<MxcSdk> | undefined;

/**
 * Dynamically import the mxc SDK, memoizing the promise. Deferring the import
 * to call-time (rather than a static top-level import) keeps node-pty — which
 * the SDK loads transitively at module-eval — out of the import graph until a
 * command is actually sandboxed.
 */
function loadMxcSdk(): Promise<MxcSdk> {
	if (!sdkPromise) sdkPromise = import("@microsoft/mxc-sdk");
	return sdkPromise;
}

/**
 * Whether mxc can sandbox on this platform right now. Calls `ensureMxcRuntime`
 * first so the embedded binary (in a compiled boundless) is materialized and
 * `MXC_BIN_DIR` is set before the SDK probes for an executable. Returns a
 * reason string when unsupported, suitable for the `onUnavailable` warning.
 *
 * Async because the SDK is lazy-loaded — and the try/catch also absorbs a
 * failed SDK/node-pty load, reporting it as "unsupported" so an unloadable
 * native module degrades to `onUnavailable` instead of throwing at the caller.
 */
export async function checkSandboxAvailable(): Promise<{ supported: boolean; reason?: string }> {
	try {
		ensureMxcRuntime();
		const { getPlatformSupport } = await loadMxcSdk();
		const support = getPlatformSupport();
		if (!support.isSupported) {
			return { supported: false, reason: support.reason ?? "platform not supported by mxc" };
		}
		return { supported: true };
	} catch (err) {
		return { supported: false, reason: (err as Error).message };
	}
}

/** Adapt a Node `ChildProcess` to the {@link SandboxSpawnResult} contract. */
function adaptChildProcess(child: ChildProcess): SandboxSpawnResult {
	const toWeb = (stream: ChildProcess["stdout"]): ReadableStream<Uint8Array> | null =>
		stream ? (Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>) : null;

	return {
		stdout: toWeb(child.stdout),
		stderr: toWeb(child.stderr),
		exited: new Promise<number>((resolve) => {
			child.once("close", (code) => resolve(code ?? -1));
			child.once("error", () => resolve(-1));
		}),
		pid: child.pid ?? -1,
		kill: (signal) => {
			try {
				child.kill(signal as NodeJS.Signals);
			} catch {
				// Process may already be gone.
			}
		},
	};
}

/**
 * Run `command` inside an mxc sandbox in `cwd` under the given policy. The
 * command string is handed to mxc as the containment's shell script, so it is
 * interpreted the same way `sh -c "<command>"` would be on POSIX hosts.
 * Returns the normalized spawn handle the bash streaming loop consumes.
 *
 * Async because the SDK is lazy-loaded; callers must await before consuming the
 * handle.
 */
export async function spawnSandboxed(
	command: string,
	cwd: string,
	cfg: ResolvedSandboxConfig,
): Promise<SandboxSpawnResult> {
	const { buildSandboxPayload, spawnSandboxFromConfig } = await loadMxcSdk();
	const policy = buildPolicy(cwd, cfg);
	const config = buildSandboxPayload(command, policy, cwd, undefined, "process");
	// Restore user/group identity resolution under seatbelt. mxc's baseline
	// profile blocks the opendirectoryd Mach lookups that back getpwuid(3), so
	// `whoami` reports a bare uid and `ssh` (hence `git push`) fails to resolve
	// the user. These are read-only identity lookups — consistent with
	// deny-writes-only — re-allowed via the SDK's `extraMachLookups` escape
	// hatch. `experimental.seatbelt` is `{}` here on the seatbelt path and
	// absent on others (bubblewrap/Windows resolve identity via NSS/SAM, so
	// the guard is a no-op there).
	if (config.experimental?.seatbelt) {
		config.experimental.seatbelt.extraMachLookups = [
			...(config.experimental.seatbelt.extraMachLookups ?? []),
			...IDENTITY_MACH_LOOKUPS,
		];
	}
	// `usePty: false` returns a Node ChildProcess (vs a node-pty handle);
	// `experimental: true` is required by the SDK to opt into the non-pty path.
	// 3rd arg is workingDirectory, 4th is the child env — see the non-interactive
	// pager/prompt rationale on `nonInteractiveEnv`.
	const child = spawnSandboxFromConfig(
		config,
		{
			usePty: false,
			experimental: true,
		} as Parameters<typeof spawnSandboxFromConfig>[1],
		cwd,
		nonInteractiveEnv(),
	) as unknown as ChildProcess;
	return adaptChildProcess(child);
}
