import type { ContentBlock } from "@bound/llm";

/** Leading marker of every boundless tool-result provenance block. */
export const BOUNDLESS_PROVENANCE_PREFIX = "[boundless]";

export function formatProvenance(hostname: string, cwd: string, toolName: string): ContentBlock {
	return {
		type: "text",
		text: `${BOUNDLESS_PROVENANCE_PREFIX} host=${hostname} cwd=${cwd} tool=${toolName}`,
	};
}

export function formatMcpProvenance(
	hostname: string,
	serverName: string,
	toolName: string,
): ContentBlock {
	return {
		type: "text",
		text: `[boundless:mcp] host=${hostname} server=${serverName} tool=${toolName}`,
	};
}
