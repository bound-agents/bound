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

/** Shown in place of stored content that opens like a block array but does not parse (#340). */
export const UNREADABLE_CONTENT_PLACEHOLDER = "[unreadable message content]";

const BLOCK_ARRAY_PREFIX = /^\s*\[\s*\{\s*"type"\s*:/;

/**
 * True when `content` opens like a serialized `ContentBlock[]` (`[{"type":...`)
 * but fails to parse, e.g. a cut-off transcript imitation. Rendering it raw
 * dumps kilobytes of JSON into the transcript.
 */
function isUnreadableBlockArray(content: string): boolean {
	if (!BLOCK_ARRAY_PREFIX.test(content)) return false;
	try {
		JSON.parse(content);
		return false;
	} catch {
		return true;
	}
}

/**
 * Decode a user or assistant message for display: like `parseMessageContent`,
 * but a `[`-prefixed block array that fails to parse becomes a placeholder.
 * Tool results keep `parseMessageContent`, because the 256 KiB cap leaves a
 * readable, intentionally cut JSON string there.
 */
export function parseConversationContent<T = ContentBlockLite>(content: string): T[] | string {
	if (isUnreadableBlockArray(content)) return UNREADABLE_CONTENT_PLACEHOLDER;
	return parseMessageContent<T>(content);
}

/**
 * Flatten a message to its complete text — no truncation, no provenance
 * filtering. The transcript renderer strips `[boundless]` blocks as noise;
 * the inspector keeps them, because provenance is exactly the kind of thing
 * you open an inspector to check.
 */
export function extractFullText(msg: Message): string {
	const parsed =
		msg.role === "assistant" || msg.role === "user"
			? parseConversationContent(msg.content)
			: parseMessageContent(msg.content);
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
