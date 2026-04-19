import { formatProvenance } from "./provenance";
import type { ToolHandler } from "./types";

const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes
const OUTPUT_LIMIT_BYTES = 102400; // 100KB
const HALF_OUTPUT_BYTES = 50000; // 50KB per half

export interface BashToolWithStreamingOptions {
	onStdoutChunk?: (chunk: string) => void;
}

async function truncateOutput(output: string): Promise<string> {
	const bytes = Buffer.byteLength(output, "utf-8");

	if (bytes <= OUTPUT_LIMIT_BYTES) {
		return output;
	}

	// Truncate from the middle
	const truncatedBytes = bytes - OUTPUT_LIMIT_BYTES;
	let first = output;
	let last = output;

	// Rough approach: truncate by character count first, then refine
	const charCount = output.length;
	const targetFirst = Math.floor((charCount * HALF_OUTPUT_BYTES) / bytes);
	const targetLast = Math.floor((charCount * HALF_OUTPUT_BYTES) / bytes);

	// Get first 50KB
	first = output.substring(0, targetFirst);
	while (Buffer.byteLength(first, "utf-8") > HALF_OUTPUT_BYTES) {
		first = first.substring(0, first.length - 1);
	}

	// Get last 50KB
	last = output.substring(output.length - targetLast);
	while (Buffer.byteLength(last, "utf-8") > HALF_OUTPUT_BYTES) {
		last = last.substring(1);
	}

	return `${first}\n... [truncated ${truncatedBytes} bytes from middle] ...\n${last}`;
}

export async function bashToolWithStreaming(
	args: Record<string, unknown>,
	signal: AbortSignal,
	cwd: string,
	options?: BashToolWithStreamingOptions,
): Promise<import("@bound/llm").ContentBlock[]> {
	const { command, timeout } = args as {
		command?: string;
		timeout?: number;
	};

	if (!command || typeof command !== "string") {
		return [
			formatProvenance("unknown", cwd, "boundless_bash"),
			{
				type: "text",
				text: "Error: command is required and must be a string",
			},
		];
	}

	const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;
	const provenance = formatProvenance("unknown", cwd, "boundless_bash");

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

			// Collect stdout
			let stdout = "";
			if (proc.stdout) {
				const reader = proc.stdout.getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;

						const chunk = new TextDecoder().decode(value);
						stdout += chunk;

						// Call streaming callback if provided
						if (options?.onStdoutChunk) {
							options.onStdoutChunk(chunk);
						}
					}
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

			// Truncate output if needed
			const allOutput = stdout + stderr;
			const truncated =
				Buffer.byteLength(allOutput, "utf-8") > OUTPUT_LIMIT_BYTES
					? await truncateOutput(stdout + stderr)
					: stdout + stderr;

			const formattedOutput = `Exit code: ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
			const formattedTruncated =
				Buffer.byteLength(formattedOutput, "utf-8") > OUTPUT_LIMIT_BYTES
					? `Exit code: ${exitCode}\nstdout:\n${truncated}`
					: formattedOutput;

			return [
				provenance,
				{
					type: "text",
					text: formattedTruncated,
				},
			];
		} finally {
			clearTimeout(timeoutHandle);
			signal.removeEventListener("abort", onAbort);
		}
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		return [
			provenance,
			{
				type: "text",
				text: `Error: ${error?.message || String(err)}`,
			},
		];
	}
}

export const bashTool: ToolHandler = (args, signal, cwd) => {
	return bashToolWithStreaming(args, signal, cwd);
};
