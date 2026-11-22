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
import { Readable } from "node:stream";
import type { ContainerRequest, MxcProcess } from "@microsoft/mxc-sdk/v1";
import { ensureMxcRuntime } from "./mxc-runtime";
import { createTreeKiller } from "./process-tree";
import {
	DNS_MACH_LOOKUPS,
	IDENTITY_MACH_LOOKUPS,
	buildPolicy,
	nonInteractiveEnv,
} from "./sandbox-policy";
import type { ResolvedSandboxConfig, SandboxSpawnResult } from "./sandbox-policy";

// Re-export the SDK-free surface so existing import sites (`./sandbox`) keep
// working unchanged.
export * from "./sandbox-policy";

/** Lazily-loaded `@microsoft/mxc-sdk/v1`, memoized after the first import. */
type MxcSdk = typeof import("@microsoft/mxc-sdk/v1");
let sdkPromise: Promise<MxcSdk> | undefined;

/**
 * Dynamically import the mxc v1 SDK, memoizing the promise. Deferring the
 * import to call-time (rather than a static top-level import) keeps node-pty —
 * which the SDK can load transitively — and the koffi→libmxc_ffi FFI load out
 * of the import graph until a command is actually sandboxed.
 */
function loadMxcSdk(): Promise<MxcSdk> {
	if (!sdkPromise) sdkPromise = import("@microsoft/mxc-sdk/v1");
	return sdkPromise;
}

/**
 * Whether mxc can sandbox on this platform right now. Calls `ensureMxcRuntime`
 * first so the embedded binary (in a compiled boundless) is materialized and
 * `MXC_FFI_DIR` is set before the SDK loads its FFI library. Returns a
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

/**
 * Adapt a v1 {@link MxcProcess} to the {@link SandboxSpawnResult} contract.
 * `kill` signals the whole process tree, not just the mxc wrapper: the
 * sandboxed shell runs in its own session under the wrapper, and sandboxed
 * processes can only signal themselves, so killing the wrapper alone orphans
 * every descendant. Under mxc 1.1.0 the native `MxcProcess.kill()` reaps the
 * whole descendant tree (verified, including children that trap SIGTERM);
 * `process-tree.ts` still runs first as a host-side fallback. See
 * `process-tree.ts`.
 *
 * `MxcProcess.standardOutput`/`standardError` are Node `Readable`s; the bash
 * streaming loop consumes web `ReadableStream`s, so they are wrapped. They must
 * be taken BEFORE `wait()` (which drains any untaken output internally), so the
 * wrap happens eagerly here, before the `wait()` promise is created.
 */
function adaptChildProcess(proc: MxcProcess): SandboxSpawnResult {
	const toWeb = (stream: NodeJS.ReadableStream | null): ReadableStream<Uint8Array> | null =>
		stream ? (Readable.toWeb(stream as Readable) as unknown as ReadableStream<Uint8Array>) : null;
	// Take the streams up front: wait() drains untaken output and then getters throw.
	const stdout = toWeb(proc.standardOutput as NodeJS.ReadableStream | null);
	const stderr = toWeb(proc.standardError as NodeJS.ReadableStream | null);
	// MxcProcess.id is the OS pid for process backends (seatbelt/bubblewrap), 0 when none.
	const pid = proc.id > 0 ? proc.id : -1;
	const killTree = pid > 0 ? createTreeKiller(pid) : null;

	return {
		stdout,
		stderr,
		exited: proc.wait().then(
			(r) => r.exitCode,
			() => -1,
		),
		pid,
		kill: (signal) => {
			// Host-side tree reaper first (it honors the caller's SIGTERM→SIGKILL
			// escalation), then the native handle, which reaps the sandbox's tree.
			killTree?.(signal ?? "SIGTERM");
			try {
				proc.kill();
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
	const { spawn } = await loadMxcSdk();
	const policy = buildPolicy(policyCwd, cfg);
	// Restore user/group identity resolution under seatbelt. mxc's baseline
	// profile blocks the opendirectoryd Mach lookups that back getpwuid(3), so
	// `whoami` reports a bare uid and `ssh` (hence `git push`) fails to resolve
	// the user. These are read-only identity lookups — consistent with
	// deny-writes-only — re-allowed via the SDK's `extraMachLookups` escape
	// hatch, which lives only on SeatbeltConfig. On Linux we omit `containment`
	// so the abstract default resolves to bubblewrap (bubblewrap resolves
	// identity via NSS, so no Mach-lookup escape hatch is needed or available);
	// Windows never reaches this path (it dispatches to the lowbox in bash.ts).
	const request: ContainerRequest = {
		command,
		// 3rd-party `run`/`spawn` interpret `command` as a shell script, the same
		// way `sh -c "<command>"` would on POSIX hosts.
		workingDirectory: cwd,
		filesystem: policy.filesystem,
		network: policy.network,
		// `confineBunCache` points bun's install cache at a tmpdir-local path so
		// `bun add`/`bun install` work under write confinement (the global ~/.bun
		// cache is outside the writable roots and fails with a misleading tempdir
		// error). See the non-interactive pager/prompt rationale on `nonInteractiveEnv`.
		environment: nonInteractiveEnv({ confineBunCache: true }),
		// Seatbelt gets the identity Mach-lookup escape hatch; elsewhere the
		// abstract "process" intent resolves to the host's native backend
		// (bubblewrap on Linux).
		containment:
			process.platform === "darwin"
				? {
						type: "seatbelt",
						config: {
							extraMachLookups: [
								...IDENTITY_MACH_LOOKUPS,
								...(cfg.network === "open" ? DNS_MACH_LOOKUPS : []),
							],
						},
					}
				: { type: "process" },
	};
	const proc = await spawn(request);
	return adaptChildProcess(proc);
}
