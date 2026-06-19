/**
 * SDK-dependent IsolationSession manager for the boundless Windows sandbox.
 *
 * Background: mxc exposes two backends for the `process` intent on Windows.
 * BaseContainer (`processcontainer`) is a one-shot spawn — the same shape
 * macOS (seatbelt) and Linux (bubblewrap) use through {@link spawnSandboxed} —
 * but on current Windows builds its kernel entry point returns E_NOTIMPL.
 * IsolationSession succeeds there instead, at the cost of a different shape: a
 * stateful five-phase lifecycle (provision -> start -> exec -> stop ->
 * deprovision) that provisions a short-lived Windows agent user and runs each
 * command as that user, enforcing the same write-confinement policy.
 *
 * This manager drives that lifecycle per boundless SESSION rather than per
 * command: provision once on first use (memoized), exec each shell command
 * against the live session, deprovision on teardown. The mxc broker process
 * (IsolationProxy.exe) is a warm singleton shared across all sessions on the
 * host — provisioning does not spawn a second broker.
 *
 * Crash safety: the agent user has an Indefinite lifetime, so a boundless
 * process that dies between provision and deprovision orphans the account with
 * nothing to reap it. Every live session is persisted (see iso-session-state),
 * and {@link sweepIsoOrphans} reaps records whose owning pid is dead on the
 * next startup. A concurrent live boundless instance's session is never
 * reaped — its owner pid is alive.
 *
 * macOS and Linux never reach this module; only Windows takes the stateful
 * branch, because it is the only platform where the one-shot path is E_NOTIMPL.
 */
import { homedir } from "node:os";
import { join, parse } from "node:path";
import {
	type IsoSessionRecord,
	loadIsoSessions,
	recordIsoSession,
	removeIsoSession,
	selectOrphans,
} from "./iso-session-state";
import { createPtyOutputCleaner } from "./pty-output";
import {
	type ResolvedSandboxConfig,
	type SandboxSpawnResult,
	buildPolicy,
	nonInteractiveEnv,
} from "./sandbox-policy";
import type { ResolvedShell } from "./shell";

import type { SandboxId } from "@microsoft/mxc-sdk";

type MxcSdk = typeof import("@microsoft/mxc-sdk");
/**
 * mxc phantom-tags sandbox ids by containment so a BaseContainer id can't be
 * passed to an isolation_session call. The brand is erased at runtime (the id
 * is a string), so it survives provision -> exec untouched but must be
 * re-asserted on values that round-tripped through the plain-string state file.
 */
type IsoSandboxId = SandboxId<"isolation_session">;
let sdkPromise: Promise<MxcSdk> | undefined;
function loadMxcSdk(): Promise<MxcSdk> {
	if (!sdkPromise) sdkPromise = import("@microsoft/mxc-sdk");
	return sdkPromise;
}

/** node-pty handle returned by execInSandbox, derived from the SDK so this file carries no node-pty dep. */
type IsoPty = Awaited<ReturnType<MxcSdk["execInSandbox"]>>;

/**
 * mxc start configuration tier. Verified empirically this session — the reap
 * and exec probes both provisioned + started with "small" and succeeded.
 */
const START_CONFIGURATION_ID = "small";

/** Resolved location of the session state file, beside the boundless config. */
let statePathOverride: string | undefined;
function isoStatePath(): string {
	return statePathOverride ?? join(homedir(), ".bound", "less", "iso-sessions.json");
}

interface ActiveSession {
	sandboxId: IsoSandboxId;
	agentUser: string | undefined;
	cwd: string;
}

// Module-scoped singleton: one live session per boundless process. Memoized as
// a Promise so concurrent commands at startup share a single provision rather
// than racing two.
let activeSessionPromise: Promise<ActiveSession> | undefined;
let activeSessionCwd: string | undefined;

/**
 * Liveness probe for an owner pid. `process.kill(pid, 0)` sends no signal — it
 * only tests existence. ESRCH (no such process) throws and is NOT EPERM, so a
 * dead owner reads as not-alive and its session becomes reapable. EPERM means
 * the process exists under another user, so it reads alive. The pid-reuse edge
 * (a fresh unrelated process inheriting a dead boundless pid) fails SAFE: the
 * orphan is treated as live and left for a later sweep rather than reaped out
 * from under a possibly-live owner.
 */
function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Convert nonInteractiveEnv's `Record<string, string | undefined>` into the
 * `KEY=VALUE` string[] ProcessConfig.env wants. The agent user is a distinct
 * Windows account that does not inherit the operator's environment, so the
 * parent env is merged in first (PATH, SystemRoot, etc. are needed for commands
 * to resolve executables); the overrides win, and a key the overrides set to
 * undefined is dropped (the unset semantics nonInteractiveEnv relies on).
 */
function toEnvArray(overrides: Record<string, string | undefined>): string[] {
	const merged: Record<string, string | undefined> = { ...process.env, ...overrides };
	return Object.entries(merged)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([key, value]) => `${key}=${value}`);
}

/**
 * Adapt an mxc IPty to the {@link SandboxSpawnResult} contract the bash
 * streaming loop consumes. The PTY decodes output to strings and merges stderr
 * into stdout, so onData strings are re-encoded into the stdout byte stream and
 * stderr is null. kill() omits the signal: node-pty's IPty.kill throws on
 * Windows when one is passed.
 */
function adaptPty(pty: IsoPty): SandboxSpawnResult {
	const encoder = new TextEncoder();
	// One cleaner per exec: it is stateful (buffers escapes split across chunk
	// boundaries, tracks whether real content has begun) so the ConPTY viewport
	// paint — screen-clear, OSC title, per-row erase-lines — never reaches the
	// captured stdout the model reads. See pty-output.ts.
	const clean = createPtyOutputCleaner();
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			pty.onData((data: string) => {
				const cleaned = clean(data);
				if (cleaned.length === 0) return;
				try {
					controller.enqueue(encoder.encode(cleaned));
				} catch {
					// Stream already closed (consumer cancelled); drop late data.
				}
			});
			pty.onExit(() => {
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			});
		},
	});

	return {
		stdout,
		stderr: null,
		exited: new Promise<number>((resolve) => {
			pty.onExit((e: { exitCode: number }) => resolve(e.exitCode ?? -1));
		}),
		pid: pty.pid ?? -1,
		kill: () => {
			try {
				pty.kill();
			} catch {
				// Process may already be gone.
			}
		},
	};
}

/**
 * Translate buildPolicy's readonly grants into the Windows folder paths
 * IsolationSession's ShareFolderBatchAsync accepts. buildPolicy emits "/" — the
 * POSIX "whole tree readable" root that seatbelt and bubblewrap understand — but
 * "/" is not a valid Windows folder (provision throws 0x80070057 / E_INVALIDARG
 * on it). There is no Windows path above the drive letters, so "/" expands to
 * the drive roots that actually matter: the system drive (where executables and
 * tooling live) plus every drive a writable root sits on. The result is a
 * TIGHTER read posture than POSIX "/" (only the system + working drives are
 * readable, not every mounted volume), which is fine — the deny-writes-only
 * security contract is about the WRITE boundary, and that is unchanged. Any
 * non-"/" readonly entry (e.g. a future .git carve-out) is already a real path
 * and passes through untouched. Verified empirically: drive roots, "C:", and
 * specific dirs all provision cleanly; only "/" fails.
 */
function toWindowsReadonlyRoots(readonlyPaths: string[], readwritePaths: string[]): string[] {
	const roots = new Set<string>();
	for (const ro of readonlyPaths) {
		if (ro !== "/") {
			roots.add(ro);
			continue;
		}
		const sysDrive = process.env.SystemDrive ?? "C:";
		roots.add(sysDrive.endsWith("\\") ? sysDrive : `${sysDrive}\\`);
		for (const rw of readwritePaths) {
			const root = parse(rw).root;
			if (root) roots.add(root);
		}
	}
	return [...roots];
}

async function provisionSession(cwd: string, cfg: ResolvedSandboxConfig): Promise<ActiveSession> {
	const sdk = await loadMxcSdk();
	// Reuse the exact write-confinement the one-shot path uses; buildPolicy's
	// readwritePaths are already real Windows paths, and its "/" readonly root is
	// translated to the drive roots IsolationSession's share model accepts.
	const policy = buildPolicy(cwd, cfg);
	const prov = await sdk.provisionSandbox("isolation_session", {
		filesystem: {
			readwritePaths: policy.filesystem.readwritePaths,
			readonlyPaths: toWindowsReadonlyRoots(
				policy.filesystem.readonlyPaths,
				policy.filesystem.readwritePaths,
			),
		},
	});
	await sdk.startSandbox(prov.sandboxId, { configurationId: START_CONFIGURATION_ID });

	const record: IsoSessionRecord = {
		sandboxId: prov.sandboxId,
		agentUser: prov.metadata?.agentUserName,
		ownerPid: process.pid,
		cwd,
		createdAt: new Date().toISOString(),
	};
	recordIsoSession(isoStatePath(), record);

	return { sandboxId: prov.sandboxId, agentUser: record.agentUser, cwd };
}

/**
 * Return the live session for `cwd`, provisioning one on first use. Memoized
 * per process: a second call for the same cwd reuses the session. boundless
 * attaches to a single working directory, so a cwd change is rare; when it does
 * happen the prior session is torn down before a new one is provisioned.
 */
export async function getOrProvisionSession(
	cwd: string,
	cfg: ResolvedSandboxConfig,
): Promise<ActiveSession> {
	if (activeSessionPromise && activeSessionCwd === cwd) return activeSessionPromise;
	if (activeSessionPromise) await deprovisionActiveSession();
	activeSessionCwd = cwd;
	const pending = provisionSession(cwd, cfg);
	activeSessionPromise = pending;
	// A failed provision must NOT poison the memo for the rest of the process
	// lifetime. Without this, a transient first-provision failure — the mxc
	// broker not yet up in the post-boot race is the observed one — caches a
	// rejected promise that every later command re-awaits, stranding a
	// long-lived ACP host in passthrough until the process is killed. A
	// client/editor restart that keeps the same subprocess alive never clears
	// it. Clear the slot on rejection so the next command retries provisioning.
	pending.catch(() => {
		if (activeSessionPromise === pending) {
			activeSessionPromise = undefined;
			activeSessionCwd = undefined;
		}
	});
	return pending;
}

/**
 * Run `command` in the live IsolationSession and return the normalized spawn
 * handle. `shell` supplies the Windows shell invocation (cmd `/c`, pwsh
 * `-Command`); the command is appended raw after the flag, which is how those
 * shells parse the remainder of the line — no re-quoting, matching the verified
 * exec probe. Async because provision and the SDK load are async; callers await
 * before consuming the handle, exactly as with {@link spawnSandboxed}.
 */
export async function execInSession(
	command: string,
	cwd: string,
	cfg: ResolvedSandboxConfig,
	shell: ResolvedShell,
): Promise<SandboxSpawnResult> {
	try {
		return await execInSessionOnce(command, cwd, cfg, shell);
	} catch {
		// The memoized session may have gone stale — the broker (IsolationProxy)
		// restarted and reclaimed the sandbox out from under us, so exec against
		// the cached id fails. Tear it down and re-provision once before
		// surfacing the failure to the caller (which degrades to passthrough). A
		// spawn-time failure means the command never ran, so the single retry
		// cannot double-execute side effects; if the retry also fails it
		// propagates and the wrapper degrades as before.
		await deprovisionActiveSession();
		return await execInSessionOnce(command, cwd, cfg, shell);
	}
}

async function execInSessionOnce(
	command: string,
	cwd: string,
	cfg: ResolvedSandboxConfig,
	shell: ResolvedShell,
): Promise<SandboxSpawnResult> {
	const session = await getOrProvisionSession(cwd, cfg);
	const sdk = await loadMxcSdk();
	const pty = await sdk.execInSandbox(session.sandboxId, {
		process: {
			commandLine: `${shell.command} ${shell.execFlag} ${command}`,
			cwd,
			env: toEnvArray(nonInteractiveEnv()),
		},
	});
	return adaptPty(pty);
}

/** Stop + deprovision the live session and drop its state record. No-op if none. */
export async function deprovisionActiveSession(): Promise<void> {
	const pending = activeSessionPromise;
	activeSessionPromise = undefined;
	activeSessionCwd = undefined;
	if (!pending) return;
	const session = await pending.catch(() => undefined);
	if (!session) return;
	const sdk = await loadMxcSdk();
	try {
		await sdk.stopSandbox(session.sandboxId);
	} catch {
		// Already stopped or never started; deprovision still attempts cleanup.
	}
	try {
		await sdk.deprovisionSandbox(session.sandboxId);
	} catch {
		// Broker may have already reclaimed it; the state record is dropped regardless.
	}
	removeIsoSession(isoStatePath(), session.sandboxId);
}

/**
 * Reap IsolationSession agent users orphaned by a prior hard kill. Loads the
 * persisted records, selects those whose owner pid is dead, and deprovisions
 * each. A live concurrent instance's session is never selected. Call once at
 * boundless startup, before provisioning this session.
 */
export async function sweepIsoOrphans(): Promise<{ reaped: string[]; failed: string[] }> {
	const statePath = isoStatePath();
	const orphans = selectOrphans(loadIsoSessions(statePath), pidIsAlive);
	const reaped: string[] = [];
	const failed: string[] = [];
	if (orphans.length === 0) return { reaped, failed };

	const sdk = await loadMxcSdk();
	for (const orphan of orphans) {
		try {
			await sdk.deprovisionSandbox(orphan.sandboxId as IsoSandboxId);
			removeIsoSession(statePath, orphan.sandboxId);
			reaped.push(orphan.sandboxId);
		} catch {
			// Leave the record in place so a later sweep retries; a sandboxId the
			// broker no longer knows will keep failing here but harms nothing.
			failed.push(orphan.sandboxId);
		}
	}
	return { reaped, failed };
}

/**
 * Test-only seam — NOT part of the public API. Lets a unit test drive the
 * session-memo lifecycle ({@link getOrProvisionSession}, {@link execInSession})
 * with a fake mxc SDK and a scratch state path, so the provision-failure-recovery
 * and stale-session-retry paths are exercisable without a real IsolationSession
 * broker. Each field mutates the same module bindings the production code reads.
 */
export const __isoSessionTestSeam = {
	setSdk(sdk: MxcSdk | undefined): void {
		sdkPromise = sdk ? Promise.resolve(sdk) : undefined;
	},
	setStatePath(path: string | undefined): void {
		statePathOverride = path;
	},
	resetMemo(): void {
		activeSessionPromise = undefined;
		activeSessionCwd = undefined;
	},
};
