// Grouping logic for the chat transcript: consecutive tool_call messages are
// collapsed into a single display item (a "toolGroup") so a long run of tool
// activity renders as one card instead of N rows.
//
// Each assistant turn that calls tools is persisted as a `tool_call`-role
// message whose `content` is a JSON-stringified ContentBlock[] of the shape
// [thinking?, text?, ...tool_use] (see packages/llm/src/types.ts). The inline
// `text` block is the agent's *normal, user-facing* output for that turn.
//
// ToolCallCard renders the FIRST group member's inline text up front (outside
// the collapsible); 2nd-and-later members' inline text only appears when the
// group is expanded. So a tool group must BREAK before any 2nd-or-later
// tool_call that carries user-facing text — otherwise that text is hidden
// inside the collapsed group and the agent feels unresponsive (issue #66).

export interface GroupableMessage {
	role: string;
	content: string;
	tool_name?: string | null;
	model_id?: string | null;
	created_at?: string;
	id?: string;
	exit_code?: number | null;
}

export type DisplayItem<M extends GroupableMessage = GroupableMessage> =
	| { kind: "message"; msg: M; key: string; earliest: string | undefined }
	| {
			kind: "toolGroup";
			messages: M[];
			key: string;
			earliest: string | undefined;
			timestamps: string[];
	  };

interface MaybeTextBlock {
	type?: string;
	text?: unknown;
}

/**
 * True when a persisted message's content carries a non-empty `text`
 * ContentBlock — i.e. the agent emitted normal, user-facing output on this
 * turn (as distinct from `thinking`/reasoning, which is fine to keep collapsed).
 *
 * Cheap pre-check (`includes('"text"')`) avoids JSON.parse on the common
 * tool-only turn; malformed JSON is treated as "no user-facing text".
 */
export function messageHasUserFacingText(content: string | null | undefined): boolean {
	if (!content || !content.includes('"text"')) return false;
	let blocks: unknown;
	try {
		blocks = JSON.parse(content);
	} catch {
		return false;
	}
	if (!Array.isArray(blocks)) return false;
	for (const block of blocks as MaybeTextBlock[]) {
		if (block && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
			return true;
		}
	}
	return false;
}

/**
 * Plain-text projection of a persisted message's content for one-line
 * previews. User messages with attachments (and any future block-bearing
 * roles) persist as a JSON-stringified ContentBlock[]; rendering that string
 * raw shows JSON to the user. Concatenates the `text` blocks; non-text blocks
 * are summarized as a bracketed tag (e.g. `[image]`) so an attachment-only
 * message still previews as something human-readable.
 */
export function contentPreviewText(content: string | null | undefined): string {
	if (!content) return "";
	if (!content.startsWith("[")) return content;
	let blocks: unknown;
	try {
		blocks = JSON.parse(content);
	} catch {
		return content;
	}
	if (!Array.isArray(blocks) || blocks.length === 0) return content;
	const parts: string[] = [];
	for (const block of blocks as Array<{ type?: unknown; text?: unknown }>) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") {
			if (block.text.trim()) parts.push(block.text);
		} else if (typeof block.type === "string") {
			parts.push(`[${block.type}]`);
		}
	}
	// A parseable array that yields no recognizable blocks (e.g. the user
	// literally typed `[1,2,3]`) is plain text, not a ContentBlock[] payload.
	if (parts.length === 0) return content;
	return parts.join(" ");
}

/**
 * Extract the `id`s of `tool_use` ContentBlocks in a persisted `tool_call`
 * message's content. The agent loop sets the dispatched
 * `ToolCallRequest.call_id` from `tool_use.id` (agent-loop.ts: `call_id:
 * toolCall.id`), and that same id persists in the message's ContentBlock JSON —
 * so these ids are the join key between a persisted message row and a live
 * `McpAppInstance` (keyed by `callId`). MessageList uses this to render each app
 * panel inline beneath the tool call that spawned it.
 *
 * Cheap pre-check (`includes('"tool_use"')`) avoids JSON.parse on the common
 * tool-result / plain-message rows; malformed JSON yields no ids.
 */
export function toolUseIdsInContent(content: string | null | undefined): string[] {
	if (!content || !content.includes('"tool_use"')) return [];
	let blocks: unknown;
	try {
		blocks = JSON.parse(content);
	} catch {
		return [];
	}
	if (!Array.isArray(blocks)) return [];
	const ids: string[] = [];
	for (const block of blocks as Array<{ type?: string; id?: unknown }>) {
		if (block && block.type === "tool_use" && typeof block.id === "string") {
			ids.push(block.id);
		}
	}
	return ids;
}

/** All `tool_use` ids carried by a display item (a message or a tool group). */
export function toolUseIdsInItem<M extends GroupableMessage>(item: DisplayItem<M>): string[] {
	if (item.kind === "toolGroup") {
		return item.messages.flatMap((m) => toolUseIdsInContent(m.content));
	}
	return toolUseIdsInContent(item.msg.content);
}

/**
 * Partition a flat message list into display items, collapsing consecutive
 * tool_call/tool_result runs into toolGroups.
 *
 * tool_result messages never produce their own item — they are surfaced inline
 * beneath their originating tool_use row by ToolCallCard.
 */
export function groupMessages<M extends GroupableMessage>(messages: M[]): DisplayItem<M>[] {
	const items: DisplayItem<M>[] = [];
	let i = 0;
	while (i < messages.length) {
		const m = messages[i];
		if (m.role === "tool_result") {
			i++;
			continue;
		}
		if (m.role === "tool_call") {
			const group: M[] = [m];
			let j = i + 1;
			while (j < messages.length) {
				const next = messages[j];
				if (next.role === "tool_call") {
					// Issue #66: a 2nd-or-later tool_call carrying user-facing text
					// must START a fresh group so ToolCallCard renders that text up
					// front (it only renders the FIRST member's inline text outside
					// the collapsible). Breaking here leaves `next` for the next outer
					// iteration, where it becomes the new group's leading member.
					if (messageHasUserFacingText(next.content)) break;
					group.push(next);
					j++;
				} else if (next.role === "tool_result") {
					j++;
				} else {
					break;
				}
			}
			// Key on the group's first message id so appending a new
			// tool_call to the in-progress run doesn't mutate the key and
			// remount the ToolCallCard. A remount would reset the group's
			// expanded state, every per-tool expandedTools entry, and every
			// child ReasoningBlock's open disclosure — producing the "my
			// collapsible snaps shut when a new message arrives" bug.
			const anchor = group[0];
			const key = anchor.id ?? anchor.created_at ?? `tg-${i}`;
			items.push({
				kind: "toolGroup",
				messages: group,
				key,
				earliest: group[0].created_at,
				timestamps: group.map((g) => g.created_at ?? "").filter(Boolean),
			});
			i = j;
		} else {
			items.push({
				kind: "message",
				msg: m,
				key: m.id ?? m.created_at ?? `m-${i}`,
				earliest: m.created_at,
			});
			i++;
		}
	}
	return items;
}
