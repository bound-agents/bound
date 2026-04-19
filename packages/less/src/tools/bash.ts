import { formatProvenance } from "./provenance";
import type { ToolHandler, ToolResult } from "./types";

const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes
const HALF_OUTPUT_BYTES = 50000; // 50KB per half

export interface BashToolWithStreamingOptions {
	onStdoutChunk?: (chunk: string) => void;
}

function truncateOutput(output: string, maxBytes: number): string {
	const bytes = Buffer.byteLength(output, "utf-8");

	if (bytes <= maxBytes) {
		return output;
	}

	// Truncate from the middle
	const truncatedBytes = bytes - maxBytes;
	const halfBytes = Math.floor(maxBytes / 2);

	// Get first half
	let first = output;
	let charIdx = 0;
	let byteCount = 0;

	while (byteCount < halfBytes && charIdx < output.length) {
		const charBytes = Buffer.byteLength(output[charIdx], "utf-8");
		if (byteCount + charBytes > halfBytes) {
			break;
		}
		byteCount += charBytes;
		charIdx++;
	}
	first = output.substring(0, charIdx);

	// Get last half
	let last = output;
	charIdx = output.length - 1;
	byteCount = 0;

	while (byteCount < halfBytes && charIdx >= 0) {
		const charBytes = Buffer.byteLength(output[charIdx], "utf-8");
		if (byteCount + charBytes > halfBytes) {
			break;
		}
		byteCount += charBytes;
		charIdx--;
	}
	last = output.substring(charIdx + 1);

	return `${first}\n... [truncated ${truncatedBytes} bytes from middle] ...\n${last}`;
}

export function createBashTool(hostname: string): ToolHandler {
	return (args, signal, cwd) => {
		return bashToolWithStreaming(args, signal, cwd, undefined, hostname);
	};
}

export async function bashToolWithStreaming(
	args: Record<string, unknown>,
	signal: AbortSignal,
	cwd: string,
	options?: BashToolWithStreamingOptions,
	hostname = "unknown",
): Promise<ToolResult> {
	const { command, timeout } = args as {
		command?: string;
		timeout?: number;
	};

	const provenance = formatProvenance(hostname, cwd, "boundless_bash");

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
			const proc = Bun.spawn(["sh", "-c", command], {
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

			// Collect stdout with a single TextDecoder
			let stdout = "";
			const decoder = new TextDecoder();
			if (proc.stdout) {
				const reader = proc.stdout.getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
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

			// Collect stderr
			let stderr = "";
			if (proc.stderr) {
				stderr = await Bun.readableStreamToText(proc.stderr);
			}

			// Wait for process to exit
			const exitCode = await proc.exited;

			// Cleanup
			clearTimeout(timeoutHandle);
			signal.removeEventListener("abort", onAbort);
			internalController.signal.removeEventListener("abort", abortHandler);

			// Truncate stdout and stderr independently, each with 50KB budget
			const stdoutBytes = Buffer.byteLength(stdout, "utf-8");
			const stderrBytes = Buffer.byteLength(stderr, "utf-8");

			const truncatedStdout =
				stdoutBytes > HALF_OUTPUT_BYTES ? truncateOutput(stdout, HALF_OUTPUT_BYTES) : stdout;
			const truncatedStderr =
				stderrBytes > HALF_OUTPUT_BYTES ? truncateOutput(stderr, HALF_OUTPUT_BYTES) : stderr;

			const formattedOutput = `Exit code: ${exitCode}\nstdout:\n${truncatedStdout}\nstderr:\n${truncatedStderr}`;

			const result: ToolResult = {
				content: [
					provenance,
					{
						type: "text",
						text: formattedOutput,
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
