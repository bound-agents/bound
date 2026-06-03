/**
 * Shared tool-call/tool-result pairing for a persisted message transcript.
 *
 * Both session resume (ACP replay) and attach need to know which dispatched
 * tool calls ever received a result. The id lives in different places depending
 * on the row: `tool_use` blocks inside a `tool_call` row's LlmContentBlock[]
 * JSON carry the real id (the `tool_name` column on those rows is empty), while
 * `tool_result` rows carry the matching id in their `tool_name` column. A
 * tool_use id with no result row was dispatched but never completed — an
 * interrupted turn.
 */

import type { ContentBlock as LlmContentBlock } from "@bound/llm";
import type { Message } from "@bound/shared";

/**
 * Parse a persisted message's `content` as the LlmContentBlock[] JSON the agent
 * loop writes. Returns null when the content is empty, not JSON, not an array,
 * or contains a non-block element (so callers can fall back to legacy fields).
 */
export function parseContentBlocks(content: string): LlmContentBlock[] | null {
	if (!content) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	if (
		!parsed.every(
			(b) => b && typeof b === "object" && typeof (b as { type?: unknown }).type === "string",
		)
	) {
		return null;
	}
	return parsed as LlmContentBlock[];
}

export interface ToolCallPairing {
	/** tool_use ids that have a matching tool_result row in the transcript. */
	resolvedIds: Set<string>;
	/** tool_use ids dispatched but never completed (interrupted turns), in order. */
	unpairedIds: string[];
}

/**
 * Scan a message transcript and pair tool_use blocks to their tool_result rows.
 * Prefers the structured `tool_use` id inside content; falls back to the
 * `tool_name` column for legacy rows that stored the id there.
 */
export function collectToolCallPairing(messages: readonly Message[]): ToolCallPairing {
	const callIds: string[] = [];
	const resolvedIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === "tool_call") {
			const blocks = parseContentBlocks(msg.content);
			if (blocks) {
				for (const block of blocks) {
					if (block.type === "tool_use") callIds.push(block.id);
				}
			} else if (msg.tool_name) {
				// Legacy row: the id lived in tool_name rather than a tool_use block.
				callIds.push(msg.tool_name);
			}
		} else if (msg.role === "tool_result" && msg.tool_name) {
			resolvedIds.add(msg.tool_name);
		}
	}
	const unpairedIds = callIds.filter((id) => !resolvedIds.has(id));
	return { resolvedIds, unpairedIds };
}
