import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_RESULT_OFFLOAD_THRESHOLD, buildOffloadMessage } from "@bound/shared";
import { formatProvenance } from "./provenance";
import type { ResolvedShell } from "./shell";
import type { ToolHandler, ToolResult } from "./types";

const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes

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
): ToolHandler {
	return (args, signal, cwd) => {
		return bashToolWithStreaming(args, signal, cwd, undefined, hostname, shell);
	};
}

export async function bashToolWithStreaming(
	args: Record<string, unknown>,
	signal: AbortSignal,
	cwd: string,
	options?: BashToolWithStreamingOptions,
	hostname = "unknown",
	shell: ResolvedShell = POSIX_DEFAULT_SHELL,
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
			// Spawn the subprocess
			const proc = Bun.spawn([shell.command, shell.execFlag, command], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
			});

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

			// Wait for process to exit (race against abort for orphan child scenarios)
			let exitCode: number;
			const exitResult = await raceAbort(proc.exited);
			if (exitResult === "aborted") {
				// Process didn't exit cleanly — use a sentinel exit code
				exitCode = 137; // SIGKILL convention
			} else {
				exitCode = exitResult;
			}

			// Cleanup
			clearTimeout(timeoutHandle);
			signal.removeEventListener("abort", onAbort);
			internalController.signal.removeEventListener("abort", abortHandler);

			// Assemble the full result, then offload to a local file if it's too
			// large for the context window (mirrors the agent VFS offload path).
			const formattedOutput = `Exit code: ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
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

export const bashTool: ToolHandler = createBashTool("unknown");
