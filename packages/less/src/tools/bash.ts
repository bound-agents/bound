import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_RESULT_OFFLOAD_THRESHOLD, buildOffloadMessage } from "@bound/shared";
import { execInSession } from "./iso-session";
import { formatProvenance } from "./provenance";
import {
	DISABLED_SANDBOX,
	type ResolvedSandboxConfig,
	type SandboxSpawnResult,
	checkSandboxAvailable,
	decideSandboxSpawn,
	nonInteractiveEnv,
	spawnSandboxed,
} from "./sandbox";
import { type ResolvedShell, resolveShell } from "./shell";
import type { ToolHandler, ToolResult } from "./types";

const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes

/**
 * Minimal structured-logging seam for the bash tool. Matches the shape of
 * {@link AppLogger} (`level(event, fields)`) without importing it, so the spawn
 * path stays decoupled from the concrete sink and trivially testable with a
 * spy. The ACP server and the attach flow both pass their live `AppLogger`,
 * which satisfies this interface; callers without a logger pass nothing and the
 * events are dropped.
 */
export interface BashEventLogger {
	info(event: string, fields?: Record<string, unknown>): void;
	warn(event: string, fields?: Record<string, unknown>): void;
}

/** Plain `Bun.spawn`, normalized to the {@link SandboxSpawnResult} shape. */
function spawnUnsandboxed(command: string, cwd: string, shell: ResolvedShell): SandboxSpawnResult {
	const proc = Bun.spawn([shell.command, shell.execFlag, command], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: nonInteractiveEnv(),
	});
	return {
		stdout: proc.stdout as ReadableStream<Uint8Array>,
		stderr: proc.stderr as ReadableStream<Uint8Array>,
		exited: proc.exited,
		pid: proc.pid,
		kill: (signal) => proc.kill(signal as number),
	};
}

/**
 * Windows fallback to the IsolationSession backend. The one-shot BaseContainer
 * spawn path (`spawnSandboxed`) returns E_NOTIMPL on Windows builds where the
 * kernel container API is a stub, so the abstract sandbox decision lands on
 * passthrough/error there. IsolationSession is a separate mxc backend that DOES
 * enforce the deny-writes-only boundary on those builds — via a process-memoized
 * provisioned session rather than a per-spawn container. Returns the normalized
 * handle on success, or null on any other platform / when IsolationSession is
 * itself unavailable (missing SDK, provision failure), so the caller can honor
 * the original passthrough/error posture. Network is left open: provisioning
 * forwards only the filesystem boundary, so `network: "none"` is not enforced on
 * this path — no regression, since passthrough enforced nothing at all.
 */
async function trySandboxedViaIsolationSession(
	command: string,
	cwd: string,
	shell: ResolvedShell,
	sandbox: ResolvedSandboxConfig,
	logger?: BashEventLogger,
): Promise<SandboxSpawnResult | null> {
	if (process.platform !== "win32") return null;
	try {
		const proc = await execInSession(command, cwd, sandbox, shell);
		logger?.info("sandbox_spawn", {
			cwd,
			pid: proc.pid,
			network: sandbox.network,
			writableExtras: sandbox.writablePaths.length,
			backend: "isolation_session",
		});
		return proc;
	} catch (err) {
		logger?.warn("iso_session_unavailable", {
			cwd,
			reason: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Spawn `command` either inside the mxc filesystem sandbox or unsandboxed,
 * per the resolved config. Returns the normalized process handle plus an
 * optional `note` to surface to the agent (e.g. a degraded-to-passthrough
 * warning). Throws when the sandbox is required (`onUnavailable: "error"`) but
 * unavailable — the caller's try/catch turns that into an error result.
 */
async function spawnForBash(
	command: string,
	cwd: string,
	shell: ResolvedShell,
	sandbox: ResolvedSandboxConfig,
	logger?: BashEventLogger,
): Promise<{ proc: SandboxSpawnResult; note?: string }> {
	const decision = decideSandboxSpawn(
		sandbox,
		sandbox.enabled ? await checkSandboxAvailable() : { supported: false },
	);
	switch (decision.mode) {
		case "sandboxed": {
			const proc = await spawnSandboxed(command, cwd, sandbox);
			// Normal enforcement: a command ran inside the write guard. INFO so the
			// happy path is recorded, not just the exceptions — without this, the
			// log can only ever tell you when the sandbox FAILED, never that it was
			// active. Network mode and writable extras are the policy facts worth
			// correlating an exit code against later.
			logger?.info("sandbox_spawn", {
				cwd,
				pid: proc.pid,
				network: sandbox.network,
				writableExtras: sandbox.writablePaths.length,
			});
			return { proc };
		}
		case "error":
			// Hard refusal: the one-shot sandbox is required but unavailable. On
			// Windows, try IsolationSession before refusing — it enforces the same
			// write boundary on builds where the one-shot path is a kernel stub.
			{
				const iso = await trySandboxedViaIsolationSession(command, cwd, shell, sandbox, logger);
				if (iso) return { proc: iso };
			}
			// WARN — this aborts the command, and the reason is the actionable bit
			// (missing binary, bad platform) the operator needs to fix the install.
			logger?.warn("sandbox_unavailable", {
				cwd,
				reason: decision.reason,
				onUnavailable: "error",
			});
			throw new Error(
				`Filesystem sandbox unavailable (${decision.reason}); refusing to run unsandboxed because sandbox.onUnavailable is "error".`,
			);
		case "passthrough":
			// The one-shot path fell through. On Windows, try IsolationSession before
			// degrading — a successful session IS a real sandbox spawn (write guard
			// active), so it short-circuits the unsandboxed path entirely.
			{
				const iso = await trySandboxedViaIsolationSession(command, cwd, shell, sandbox, logger);
				if (iso) return { proc: iso };
			}
			// Silent degradation — the one event you MUST be able to find after the
			// fact: a command ran with NO write guard because the sandbox fell
			// through. WARN, durable, with the reason, so "did anything run
			// unsandboxed today" is answerable from the log rather than from a note
			// that scrolled off the agent's context.
			logger?.warn("sandbox_passthrough", {
				cwd,
				reason: decision.reason,
				onUnavailable: "passthrough",
			});
			return {
				proc: spawnUnsandboxed(command, cwd, shell),
				note: `[sandbox] mxc unavailable (${decision.reason}); ran UNSANDBOXED — the filesystem write guard was NOT active for this command.`,
			};
		default:
			// sandbox.enabled === false: the operator opted out entirely. INFO, not
			// WARN — running unsandboxed is the configured intent here, not a
			// degradation, but still worth a record so "was the guard on" is never
			// ambiguous.
			logger?.info("sandbox_disabled", { cwd });
			return { proc: spawnUnsandboxed(command, cwd, shell) };
	}
}

/**
 * Offload oversized bash output to a local file and return a pointer message,
 * mirroring the agent VFS path. The host surface has real filesystem access,
 * so the full output is written to a temp file the agent can read back with a
 * follow-up `cat`/`grep` rather than middle-cutting it inline. Returns the
 * pointer text when offloaded, or `null` when the output fits in context (in
 * which case the universal 256 KiB `capToolResultContent` backstop still
 * applies downstream). A write failure falls back to inline output.
 */
function offloadIfOversized(output: string, toolName: string): string | null {
	if (output.length <= TOOL_RESULT_OFFLOAD_THRESHOLD) return null;
	try {
		const dir = join(tmpdir(), "bound-tool-results");
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, `${randomUUID()}.txt`);
		writeFileSync(filePath, output, "utf-8");
		return buildOffloadMessage(filePath, output.length, toolName);
	} catch {
		return null;
	}
}

/** POSIX `sh` fallback for callers that don't supply a resolved shell. */
const POSIX_DEFAULT_SHELL: ResolvedShell = {
	command: "sh",
	execFlag: "-c",
	toolName: "boundless_bash",
	label: "POSIX shell (sh)",
};

export interface BashToolWithStreamingOptions {
	onStdoutChunk?: (chunk: string) => void;
}

export function createBashTool(
	hostname: string,
	shell: ResolvedShell = POSIX_DEFAULT_SHELL,
	sandbox: ResolvedSandboxConfig = DISABLED_SANDBOX,
	logger?: BashEventLogger,
): ToolHandler {
	return (args, signal, cwd) => {
		return bashToolWithStreaming(args, signal, cwd, undefined, hostname, shell, sandbox, logger);
	};
}

export async function bashToolWithStreaming(
	args: Record<string, unknown>,
	signal: AbortSignal,
	cwd: string,
	options?: BashToolWithStreamingOptions,
	hostname = "unknown",
	shell: ResolvedShell = POSIX_DEFAULT_SHELL,
	sandbox: ResolvedSandboxConfig = DISABLED_SANDBOX,
	logger?: BashEventLogger,
): Promise<ToolResult> {
	const { command, timeout } = args as {
		command?: string;
		timeout?: number;
	};

	const provenance = formatProvenance(hostname, cwd, shell.toolName);

	if (!command || typeof command !== "string") {
		const result: ToolResult = {
			content: [
				provenance,
				{
					type: "text",
					text: "Error: command is required and must be a string",
				},
			],
			isError: true,
		};
		return result;
	}

	const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;

	try {
		// Create an AbortController that combines external signal + timeout
		const internalController = new AbortController();

		const timeoutHandle = setTimeout(() => {
			internalController.abort();
		}, timeoutMs);

		// Chain with external signal
		const onAbort = () => {
			internalController.abort();
		};
		signal.addEventListener("abort", onAbort);

		try {
			// Spawn the subprocess (inside the mxc filesystem sandbox or not,
			// per resolved config). `sandboxNote` carries any degraded-to-
			// passthrough warning to surface back to the agent.
			const { proc, note: sandboxNote } = await spawnForBash(command, cwd, shell, sandbox, logger);

			// Handle abort: SIGTERM -> 2s wait -> SIGKILL
			const abortHandler = () => {
				try {
					// Try to kill the process group (negative PID)
					process.kill(-proc.pid, "SIGTERM");
				} catch {
					// Fallback to regular kill
					try {
						proc.kill("SIGTERM");
					} catch {
						// Process might already be dead
					}
				}

				// Wait 2 seconds, then send SIGKILL
				setTimeout(() => {
					try {
						process.kill(-proc.pid, "SIGKILL");
					} catch {
						try {
							proc.kill("SIGKILL");
						} catch {
							// Process already dead
						}
					}
				}, 2000);
			};

			internalController.signal.addEventListener("abort", abortHandler);

			// Helper: race a promise against the internal abort signal
			function raceAbort<T>(promise: Promise<T>): Promise<T | "aborted"> {
				if (internalController.signal.aborted) return Promise.resolve("aborted" as const);
				return new Promise<T | "aborted">((resolve) => {
					const onAbort = () => resolve("aborted" as const);
					internalController.signal.addEventListener("abort", onAbort, { once: true });
					promise.then(
						(v) => {
							internalController.signal.removeEventListener("abort", onAbort);
							resolve(v);
						},
						() => {
							internalController.signal.removeEventListener("abort", onAbort);
							resolve("aborted" as const);
						},
					);
				});
			}

			// Collect stdout with a single TextDecoder
			let stdout = "";
			const decoder = new TextDecoder();
			if (proc.stdout) {
				const reader = proc.stdout.getReader();
				try {
					while (true) {
						const readResult = await raceAbort(reader.read());
						if (readResult === "aborted") {
							// Abort fired while waiting on read — cancel the reader to unblock
							await reader.cancel().catch(() => {});
							break;
						}
						const { done, value } = readResult;
						if (done) break;

						const chunk = decoder.decode(value, { stream: true });
						stdout += chunk;

						// Call streaming callback if provided
						if (options?.onStdoutChunk) {
							options.onStdoutChunk(chunk);
						}
					}
					// Flush any remaining bytes
					stdout += decoder.decode();
				} finally {
					reader.releaseLock();
				}
			}

			// Collect stderr — also race against abort to prevent hanging
			let stderr = "";
			if (proc.stderr) {
				const stderrResult = await raceAbort(Bun.readableStreamToText(proc.stderr));
				if (stderrResult !== "aborted") {
					stderr = stderrResult;
				}
			}

			// Wait for the process to exit. On abort, the handler above has already
			// issued SIGTERM (then SIGKILL after 2s); await the *real* exit with a
			// bounded grace window so the process is actually reaped — and its cwd
			// handle released — before we return. Returning the synthetic code while
			// the process is still dying orphans it: on Windows the child keeps the
			// cwd locked, so a caller cleaning up that directory races it and hits
			// EBUSY. The 3s window clears the 2s SIGKILL deadline; the 137 sentinel
			// only stands if the process somehow outlived even SIGKILL.
			let exitCode: number;
			const exitResult = await raceAbort(proc.exited);
			if (exitResult === "aborted") {
				const reaped = await Promise.race([
					proc.exited.then((code) => code),
					new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
				]);
				exitCode = reaped ?? 137; // SIGKILL convention if it truly never died
			} else {
				exitCode = exitResult;
			}

			// Cleanup
			clearTimeout(timeoutHandle);
			signal.removeEventListener("abort", onAbort);
			internalController.signal.removeEventListener("abort", abortHandler);

			// Assemble the full result, then offload to a local file if it's too
			// large for the context window (mirrors the agent VFS offload path).
			const formattedOutput = `${sandboxNote ? `${sandboxNote}\n` : ""}Exit code: ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
			const offloaded = offloadIfOversized(formattedOutput, shell.toolName);

			const result: ToolResult = {
				content: [
					provenance,
					{
						type: "text",
						text: offloaded ?? formattedOutput,
					},
				],
			};
			return result;
		} finally {
			clearTimeout(timeoutHandle);
			signal.removeEventListener("abort", onAbort);
		}
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		const result: ToolResult = {
			content: [
				provenance,
				{
					type: "text",
					text: `Error: ${error?.message || String(err)}`,
				},
			],
			isError: true,
		};
		return result;
	}
}

// Convenience export with no host identity and no override: resolve the host's
// shell the same way the live tool does (POSIX `sh` off-Windows; PowerShell, then
// cmd, on Windows). The hardcoded `POSIX_DEFAULT_SHELL` would spawn `sh`, which
// does not exist on a stock Windows host — so this export was unusable there.
export const bashTool: ToolHandler = createBashTool("unknown", resolveShell(undefined));
