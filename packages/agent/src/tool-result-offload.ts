/**
 * Tool result offloading (agent / VFS surface).
 *
 * The threshold and the pointer-message format are shared with the host
 * `boundless_bash` surface via `@bound/shared` so the two cannot drift. Only
 * the destination path differs: here it is a VFS path the sandbox writes to.
 */

import { TOOL_RESULT_OFFLOAD_THRESHOLD, buildOffloadMessage } from "@bound/shared";

export { TOOL_RESULT_OFFLOAD_THRESHOLD, buildOffloadMessage };

/** Generate the VFS path for an offloaded tool result. */
export function offloadToolResultPath(toolCallId: string): string {
	return `/home/user/.tool-results/${toolCallId}.txt`;
}
