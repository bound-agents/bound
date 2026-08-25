/**
 * POSIX filesystem sandboxing for the boundless bash-family tool, backed by
 * Microsoft's mxc (`@microsoft/mxc-sdk`): seatbelt on macOS and bubblewrap on
 * Linux. Windows dispatches directly to Bound's native AppContainer lowbox in
 * `bash.ts` and never enters this module's probe or spawn path.
 *
 * When enabled (the default), shell commands keep the filesystem readable but
 * confine writes to the working directory, system temp directory, and any
 * operator-listed extras. If the backend is unavailable, `onUnavailable`
 * either refuses the command (`"error"`, the default) or explicitly runs it
 * unsandboxed with a warning (`"passthrough"`).
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
import { IDENTITY_MACH_LOOKUPS, buildPolicy, nonInteractiveEnv } from "./sandbox-policy";
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
export function checkSandboxAvailable(): Promise<{ supported: boolean; reason?: string }> {
	// Memoize across the process: the probe spawns a real subprocess, so it runs
	// at most once per boundless session (matching the lazy SDK import). If an
	// operator runs host prep mid-session, reconnecting re-probes.
	if (!availabilityPromise) availabilityPromise = probeSandboxAvailable();
	return availabilityPromise;
}

/** Memoized {@link checkSandboxAvailable} result; the probe runs at most once per process. */
let availabilityPromise: Promise<{ supported: boolean; reason?: string }> | undefined;

/** Wall-clock ceiling for the availability probe; a wedged spawn degrades to unsupported. */
const SANDBOX_PROBE_TIMEOUT_MS = 10_000;

async function probeSandboxAvailable(): Promise<{ supported: boolean; reason?: string }> {
	try {
		ensureMxcRuntime();
		const { getPlatformSupport } = await loadMxcSdk();
		const support = getPlatformSupport();
		if (!support.isSupported) {
			return { supported: false, reason: support.reason ?? "platform not supported by mxc" };
		}
		// getPlatformSupport() confirms the SDK build + native symbols are present,
		// not that seatbelt/bubblewrap can create a containment on this host. Probe
		// the real spawn path with a no-op so a missing or broken runtime reaches
		// the caller's onUnavailable posture instead of failing cryptically.
		return await runSandboxProbe();
	} catch (err) {
		return { supported: false, reason: (err as Error).message };
	}
}

/**
 * Spawn a side-effect-free no-op through the real {@link spawnSandboxed} path
 * and report whether mxc contained it. Uses the same policy as a real command.
 */
async function runSandboxProbe(): Promise<{ supported: boolean; reason?: string }> {
	const noop = "true";
	const probeCfg: ResolvedSandboxConfig = {
		enabled: true,
		writablePaths: [],
		network: "open",
		onUnavailable: "passthrough",
	};
	let proc: SandboxSpawnResult;
	try {
		proc = await spawnSandboxed(noop, process.cwd(), probeCfg);
	} catch (err) {
		// The SDK couldn't even launch the executor (missing binary, or a node-pty
		// load failure surfacing here rather than at import).
		return { supported: false, reason: (err as Error).message };
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const exit = await Promise.race([
		proc.exited,
		new Promise<number>((resolve) => {
			timer = setTimeout(() => resolve(SANDBOX_PROBE_TIMEOUT), SANDBOX_PROBE_TIMEOUT_MS);
		}),
	]);
	if (timer) clearTimeout(timer);
	if (exit === SANDBOX_PROBE_TIMEOUT) {
		proc.kill();
		return { supported: false, reason: "mxc sandbox probe timed out" };
	}
	if (exit !== 0) {
		return {
			supported: false,
			reason: `mxc could not start a sandboxed process here (probe exit ${exit}) — the platform backend is unavailable or requires host preparation`,
		};
	}
	return { supported: true };
}

/** Sentinel exit value the probe timeout resolves to (real exit codes are 0..255 or -1). */
const SANDBOX_PROBE_TIMEOUT = -2;

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
	policyCwd: string = cwd,
): Promise<SandboxSpawnResult> {
	const { buildSandboxPayload, spawnSandboxFromConfig } = await loadMxcSdk();
	const policy = buildPolicy(policyCwd, cfg);
	const config = buildSandboxPayload(command, policy, cwd, undefined, "process");
	// Restore user/group identity resolution under seatbelt. mxc's baseline
	// profile blocks the opendirectoryd Mach lookups that back getpwuid(3), so
	// `whoami` reports a bare uid and `ssh` (hence `git push`) fails to resolve
	// the user. These are read-only identity lookups — consistent with
	// deny-writes-only — re-allowed via the SDK's `extraMachLookups` escape
	// hatch. `experimental.seatbelt` is `{}` here on the seatbelt path and
	// absent on others (bubblewrap/Windows resolve identity via NSS/SAM, so
	// the guard is a no-op there).
	if (config.seatbelt) {
		config.seatbelt.extraMachLookups = [
			...(config.seatbelt.extraMachLookups ?? []),
			...IDENTITY_MACH_LOOKUPS,
		];
	}
	// `usePty: false` returns a Node ChildProcess (vs a node-pty handle);
	// `experimental: true` is required by the SDK to opt into the non-pty path.
	// 3rd arg is workingDirectory, 4th is the child env — see the non-interactive
	// pager/prompt rationale on `nonInteractiveEnv`. `confineBunCache` points
	// bun's install cache at a tmpdir-local path so `bun add`/`bun install`
	// work under write confinement (the global ~/.bun cache is outside the
	// writable roots and fails with a misleading tempdir error).
	const child = spawnSandboxFromConfig(
		config,
		{
			usePty: false,
			experimental: true,
		} as Parameters<typeof spawnSandboxFromConfig>[1],
		cwd,
		nonInteractiveEnv({ confineBunCache: true }),
	) as unknown as ChildProcess;
	return adaptChildProcess(child);
}
