/**
 * Tool result offloading: when a tool result exceeds the size threshold,
 * write the full content to a file in the VFS and replace the result with
 * a short message instructing the agent to read the offloaded file.
 */

/** Results larger than this (in characters) are offloaded to a file. */
export const TOOL_RESULT_OFFLOAD_THRESHOLD = 50_000;

/** Generate the VFS path for an offloaded tool result. */
export function offloadToolResultPath(toolCallId: string): string {
	return `/home/user/.tool-results/${toolCallId}.txt`;
}

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
