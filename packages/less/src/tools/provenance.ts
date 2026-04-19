import type { ContentBlock } from "@bound/llm";

export function formatProvenance(hostname: string, cwd: string, toolName: string): ContentBlock {
	return {
		type: "text",
		text: `[boundless] host=${hostname} cwd=${cwd} tool=${toolName}`,
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
