import type { Message } from "@bound/shared";

/**
 * Message-content decoding and text extraction shared by ChatView,
 * MessageBlock and InspectorView. Lives in util/ because InspectorView already
 * imports from ChatView, so a second edge back would close an import cycle.
 */

export type ContentBlockLite = {
	type: string;
	text?: string;
	name?: string;
	input?: unknown;
};

/**
 * Decode a persisted `content` column: a JSON block array, or raw text. Only
 * text that starts with `[` is tried, so ordinary JSON text stays a string.
 */
export function parseMessageContent<T = ContentBlockLite>(content: string): T[] | string {
	if (!content.startsWith("[")) return content;
	try {
		const parsed: unknown = JSON.parse(content);
		return Array.isArray(parsed) ? (parsed as T[]) : content;
	} catch {
		return content;
	}
}

/**
 * Flatten a message to its complete text — no truncation, no provenance
 * filtering. The transcript renderer strips `[boundless]` blocks as noise;
 * the inspector keeps them, because provenance is exactly the kind of thing
 * you open an inspector to check.
 */
export function extractFullText(msg: Message): string {
	const parsed = parseMessageContent(msg.content);
	if (typeof parsed === "string") return parsed;
	const parts: string[] = [];
	for (const block of parsed) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (block.type === "tool_use") {
			const name = typeof block.name === "string" ? block.name : "(tool)";
			parts.push(`⏵ ${name}\n${JSON.stringify(block.input ?? {}, null, 2)}`);
		} else if (block.type === "image") {
			parts.push("[image]");
		}
	}
	return parts.join("\n");
}
