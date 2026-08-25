import type { Message } from "@bound/shared";

/**
 * Message-content text extraction, shared by the inspector (full-fidelity
 * detail pane) and the chat input's history recall. Lives in util/ because
 * ChatView and InspectorView both need it and InspectorView already imports
 * from ChatView — a second edge back would close an import cycle.
 */

export type ContentBlockLite = {
	type: string;
	text?: string;
	name?: string;
	input?: unknown;
};

/** Parse a message's content column: JSON block array or raw string. */
export function parseBlocks(content: string): ContentBlockLite[] | string {
	try {
		const parsed: unknown = JSON.parse(content);
		if (Array.isArray(parsed)) return parsed as ContentBlockLite[];
	} catch {
		// raw string content
	}
	return content;
}

/**
 * Flatten a message to its complete text — no truncation, no provenance
 * filtering. The transcript renderer strips `[boundless]` blocks as noise;
 * the inspector keeps them, because provenance is exactly the kind of thing
 * you open an inspector to check.
 */
export function extractFullText(msg: Message): string {
	const parsed = parseBlocks(msg.content);
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
