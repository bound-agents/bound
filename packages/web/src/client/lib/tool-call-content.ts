import { splitOnThinkingBlocks } from "./markdown";

export interface ToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
}

interface ThinkingContentBlock {
	type: "thinking";
	thinking: string;
	redacted_data?: string;
}

interface TextContentBlock {
	type: "text";
	text: string;
}

type Block =
	| ThinkingContentBlock
	| TextContentBlock
	| ToolUseBlock
	| { type: string; [k: string]: unknown };

export interface ParsedToolCallContent {
	thinkingText: string;
	redactedThinking: boolean;
	inlineText: string;
	toolUses: ToolUseBlock[];
	raw: string | null;
}

/**
 * Separates a persisted tool-call ContentBlock array into the regions rendered
 * by ToolCallCard. Some tool-capable models place `<thinking>` tags inside a
 * text block rather than emitting a native `thinking` block; normalize both
 * representations here so they use the same ReasoningBlock component.
 */
export function parseToolCallContent(raw: string): ParsedToolCallContent {
	try {
		const blocks = JSON.parse(raw) as Block[];
		if (!Array.isArray(blocks)) return emptyParsedContent(raw);

		let thinkingText = "";
		let redactedThinking = false;
		let inlineText = "";
		const toolUses: ToolUseBlock[] = [];
		for (const block of blocks) {
			if (block.type === "thinking") {
				const thinking = (block as ThinkingContentBlock).thinking;
				if (thinking) thinkingText += thinking;
				if ((block as ThinkingContentBlock).redacted_data) redactedThinking = true;
			} else if (block.type === "text") {
				const text = (block as TextContentBlock).text;
				if (!text) continue;
				for (const segment of splitOnThinkingBlocks(text)) {
					if (segment.kind === "thinking") {
						thinkingText += segment.text;
					} else if (segment.text) {
						inlineText += (inlineText ? "\n\n" : "") + segment.text;
					}
				}
			} else if (block.type === "tool_use") {
				toolUses.push(block as ToolUseBlock);
			}
		}
		return { thinkingText, redactedThinking, inlineText, toolUses, raw: null };
	} catch {
		return emptyParsedContent(raw);
	}
}

function emptyParsedContent(raw: string): ParsedToolCallContent {
	return { thinkingText: "", redactedThinking: false, inlineText: "", toolUses: [], raw };
}
