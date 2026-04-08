import type { ContentBlock } from "./types";
import { LLMError } from "./types";

export async function* parseStreamLines(
	response: Response,
	providerName: string,
): AsyncGenerator<string> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new LLMError("Response body not available", providerName);
	}
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (line.trim()) yield line;
			}
		}
		if (buffer.trim()) yield buffer;
	} finally {
		reader.releaseLock();
	}
}

export const SSE_DATA_PREFIX = "data: ";
export const SSE_DONE_SENTINEL = "[DONE]";

export function extractTextFromBlocks(content: ContentBlock[]): string {
	return content
		.filter((b) => b.type === "text")
		.map((b) => b.text || "")
		.join("\n");
}

/**
 * Sanitize a tool name for LLM APIs (Anthropic, Bedrock).
 * Both validate against /^[a-zA-Z0-9_-]{1,64}$/.
 * Replaces invalid chars with `_`, truncates to 64, falls back to "unknown".
 */
export function sanitizeToolName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "unknown";
}
