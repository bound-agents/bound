/**
 * Tool-result offloading: shared pieces.
 *
 * When a tool result exceeds the size threshold, the full content is written
 * to a file and the in-context result is replaced with a short pointer message
 * telling the agent where to read it. This keeps the context window bounded
 * WITHOUT losing any bytes — the full output stays grep-able on disk.
 *
 * The threshold and the pointer-message format live here so both surfaces that
 * offload (the agent VFS path and the host `boundless_bash` path) cannot drift
 * on either value. The destination PATH is surface-specific (VFS vs. real fs),
 * so each surface computes its own.
 */

/** Results larger than this (in characters) are offloaded to a file. */
export const TOOL_RESULT_OFFLOAD_THRESHOLD = 50_000;

/** Build the replacement message that tells the agent where the full output lives. */
export function buildOffloadMessage(
	filePath: string,
	originalLength: number,
	toolName: string,
): string {
	return `[Tool result offloaded: ${originalLength} characters from "${toolName}"]
The full output was too large for the context window and has been saved to: ${filePath}
Use bash to read or filter it, e.g.:
  cat ${filePath} | head -100
  cat ${filePath} | grep "pattern"
  wc -l ${filePath}`;
}
