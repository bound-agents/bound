/**
 * Pure helpers for tool-pair sanitization. Property-testable in
 * isolation; the main `sanitizeToolPairs` function uses these as
 * building blocks.
 */

import type { Message } from "@bound/shared";

/**
 * Extract `tool_use` IDs from a `tool_call` message's content.
 * Returns an empty array when the content can't be parsed as a
 * `ContentBlock[]` JSON string — the caller falls back to legacy
 * single-tool behavior in that case.
 *
 * Pure in `content` alone.
 */
export function extractToolUseIds(content: string): string[] {
	try {
		const blocks = JSON.parse(content);
		if (Array.isArray(blocks)) {
			return blocks
				.filter((b: { type?: string; id?: string }) => b.type === "tool_use" && b.id)
				.map((b: { id: string }) => b.id);
		}
	} catch {
		// Non-parseable content (legacy single-tool / synthetic).
	}
	return [];
}

/**
 * Returns true iff the message stream contains a `tool_result`
 * whose `tool_use_id` (carried in `tool_name` per the DB schema)
 * has no preceding `tool_call` containing that id.
 *
 * Used by property tests to verify post-sanitize streams have no
 * orphan results. Pure.
 */
export function hasOrphanedToolResult(messages: ReadonlyArray<Message>): boolean {
	const knownIds = new Set<string>();
	for (const m of messages) {
		if (m.role === "tool_call") {
			for (const id of extractToolUseIds(m.content)) {
				knownIds.add(id);
			}
		} else if (m.role === "tool_result") {
			const id = m.tool_name;
			if (id !== null && id !== undefined && !knownIds.has(id)) return true;
		}
	}
	return false;
}

/**
 * Returns true iff the message stream contains a `tool_call` whose
 * `tool_use` IDs are not all matched by following `tool_result` rows
 * before the next non-tool message (or end of stream).
 *
 * The semantics match the AI SDK prompt validator's expectation that
 * each tool_use is answered before the conversation continues.
 *
 * Pure.
 */
export function hasUnclosedToolCall(messages: ReadonlyArray<Message>): boolean {
	let pending = new Set<string>();
	let inActiveCall = false;
	for (const m of messages) {
		if (m.role === "tool_call") {
			if (pending.size > 0 || inActiveCall) return true;
			pending = new Set(extractToolUseIds(m.content));
			inActiveCall = pending.size === 0; // legacy single-tool fallback
		} else if (m.role === "tool_result") {
			if (m.tool_name && pending.has(m.tool_name)) {
				pending.delete(m.tool_name);
			}
			if (pending.size === 0) inActiveCall = false;
		} else {
			// Non-tool message: any pending IDs are orphans.
			if (pending.size > 0 || inActiveCall) return true;
		}
	}
	return pending.size > 0 || inActiveCall;
}
