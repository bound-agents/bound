import type { ContentBlock } from "@bound/llm";

export interface ToolResult {
	content: ContentBlock[];
	isError?: boolean;
}

export type ToolHandler = (
	args: Record<string, unknown>,
	signal: AbortSignal,
	cwd: string,
) => Promise<ToolResult>;
