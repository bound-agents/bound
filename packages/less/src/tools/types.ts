import type { ContentBlock } from "@bound/llm";

export type ToolHandler = (
	args: Record<string, unknown>,
	signal: AbortSignal,
	cwd: string,
) => Promise<ContentBlock[]>;

export interface ToolResult {
	content: ContentBlock[];
	isError?: boolean;
}
