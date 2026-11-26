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

/** The image media types a ContentBlock image source can carry. */
const IMAGE_MEDIA_TYPES = new Set<string>(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export function isImageMediaType(mime: string): mime is ImageMediaType {
	return IMAGE_MEDIA_TYPES.has(mime);
}

/** Names of the fixed boundless file tools; the shell tool name comes from resolveShell. */
export const TOOL_NAMES = {
	read: "boundless_read",
	write: "boundless_write",
	edit: "boundless_edit",
	search: "boundless_search",
	readStructure: "boundless_read_structure",
	copy: "boundless_copy",
} as const;
