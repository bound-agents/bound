/**
 * Tool-pair sanitizer — see `index.ts` for the architectural
 * rationale. This file is the implementation; it should be read in
 * tandem with the property tests that pin its contract.
 */

import type { Message } from "@bound/shared";
import { extractToolUseIds } from "./helpers";

export interface SanitizeToolPairsParams {
	messages: ReadonlyArray<Message>;
	/**
	 * Thread id used to populate the `thread_id` field on synthetic
	 * messages. Required because synthetic messages must be Message-
	 * shape compatible — they flow into downstream stages that may
	 * filter or join on `thread_id`.
	 */
	threadId: string;
	/**
	 * Wall-clock ISO string used as `created_at` / `modified_at` on
	 * synthetic messages. Defaults to `new Date().toISOString()` for
	 * production callers; tests inject a fixed value so property
	 * assertions can compare byte-equal output.
	 *
	 * Note: this only affects synthetic messages. Reordering of
	 * pre-existing messages preserves their original timestamps
	 * verbatim.
	 */
	nowIso?: string;
}

/**
 * Top-level entry point. Performs Pass 1 (reorder) followed by
 * Pass 2 (structural repair). Returns a new array; does not mutate
 * the input.
 *
 * **Determinism**: for fixed `(messages, threadId, nowIso)`, output
 * is byte-equal across calls.
 *
 * **Post-conditions** (pinned by property tests):
 *   - Every non-tool message present in the input remains in the
 *     output (preservation).
 *   - No `tool_result` in the output is orphaned: each `tool_use_id`
 *     is matched by a preceding `tool_call`'s `tool_use` block.
 *   - No `tool_call` in the output is unclosed: each `tool_use_id`
 *     in a `tool_call` has a following `tool_result` before the next
 *     non-tool message.
 *   - Idempotent: `sanitize(sanitize(x)) === sanitize(x)` byte-equal,
 *     given fixed `nowIso` and a deterministic synthetic-id seed
 *     (the second pass produces the same synthetic ids when its
 *     inputs are already wire-legal).
 */
export function sanitizeToolPairs(params: SanitizeToolPairsParams): Message[] {
	const reordered = reorderPass(params.messages);
	return repairPass(reordered, params.threadId, params.nowIso ?? new Date().toISOString());
}

/**
 * Pass 1 — reorder non-tool messages so each `tool_call` is
 * adjacent to its `tool_result`s.
 *
 * Multi-tool aware: a `tool_call` can carry N `tool_use` blocks; we
 * track which `tool_use_id`s are pending and only close the scan
 * when all are matched. We will scan past a subsequent `tool_call`
 * boundary to claim straggler results, but only those whose
 * `tool_use_id` is in OUR pending set.
 *
 * Assistant messages between a `tool_call` and its `tool_result` are
 * NOT reordered — they belong in their original position. Pass 2
 * handles the structural case where assistant text sits mid-pair.
 */
function reorderPass(messages: ReadonlyArray<Message>): Message[] {
	const reordered: Message[] = [];
	const consumed = new Set<number>();

	for (let i = 0; i < messages.length; i++) {
		if (consumed.has(i)) continue;

		const msg = messages[i];
		if (msg.role !== "tool_call") {
			reordered.push(msg);
			continue;
		}

		const matchIndices: number[] = [];
		const nonToolMessages: Message[] = [];
		const nonToolIndices: number[] = [];

		const pendingToolUseIds = new Set(extractToolUseIds(msg.content));

		// Tracks whether we've scanned past a subsequent `tool_call`.
		// Past that boundary we ONLY claim results whose tool_use_id
		// is in our pending set — never steal results that belong to
		// the next call.
		let crossedToolCallBoundary = false;
		for (let j = i + 1; j < messages.length; j++) {
			if (consumed.has(j)) continue;
			const jMsg = messages[j];
			if (jMsg.role === "tool_call") {
				if (pendingToolUseIds.size === 0) break;
				crossedToolCallBoundary = true;
				continue;
			}
			if (jMsg.role === "tool_result") {
				if (crossedToolCallBoundary) {
					if (!jMsg.tool_name || !pendingToolUseIds.has(jMsg.tool_name)) continue;
				}
				matchIndices.push(j);
				if (jMsg.tool_name) pendingToolUseIds.delete(jMsg.tool_name);
			} else {
				if (matchIndices.length > 0 && pendingToolUseIds.size === 0) break;
				if (crossedToolCallBoundary) continue;
				// Only reorder system-shaped messages, NOT assistants.
				if (jMsg.role !== "assistant") {
					nonToolMessages.push(jMsg);
					nonToolIndices.push(j);
				}
			}
		}

		if (matchIndices.length > 0) {
			for (const m of nonToolMessages) reordered.push(m);
			for (const idx of nonToolIndices) consumed.add(idx);
			for (const idx of matchIndices) consumed.add(idx);
			reordered.push(msg);
			for (const idx of matchIndices) reordered.push(messages[idx]);
		} else {
			for (const m of nonToolMessages) reordered.push(m);
			for (const idx of nonToolIndices) consumed.add(idx);
			reordered.push(msg);
		}
	}

	return reordered;
}

/**
 * Pass 2 — structural repair. Synthesize stubs for unclosed
 * `tool_call`s and orphaned `tool_result`s.
 *
 * State machine:
 *   - `activePendingIds` — tool_use_ids from the current open
 *     tool_call still awaiting their tool_result.
 *   - `inActiveToolCall` — boolean fallback flag for tool_calls
 *     whose content can't be parsed (legacy / synthetic).
 *   - `lastSyntheticToolCall` — when consecutive orphaned
 *     tool_results land for the same multi-tool call, we extend
 *     the prior synthetic tool_call's content rather than emit a
 *     new synthetic for each.
 */
function repairPass(messages: ReadonlyArray<Message>, threadId: string, nowIso: string): Message[] {
	const sanitized: Message[] = [];

	const activePendingIds = new Set<string>();
	let inActiveToolCall = false;
	let lastToolId = "";
	let lastToolUseIds: string[] = [];
	let prevSanitizedRole: string | null = null;
	let lastSyntheticToolCall: Message | null = null;

	const makeSyntheticResults = (
		prefix: string,
		toolUseIds: string[],
		errContent: string,
	): Message[] => {
		if (toolUseIds.length === 0) {
			return [
				{
					id: `${prefix}-${lastToolId}`,
					thread_id: threadId,
					role: "tool_result",
					content: errContent,
					model_id: null,
					tool_name: null,
					created_at: nowIso,
					modified_at: nowIso,
					host_origin: "local",
					deleted: 0,
					exit_code: null,
					metadata: null,
				},
			];
		}
		return toolUseIds.map((tuId, idx) => ({
			id: `${prefix}-${lastToolId}-${idx}`,
			thread_id: threadId,
			role: "tool_result",
			content: errContent,
			model_id: null,
			tool_name: tuId,
			created_at: nowIso,
			modified_at: nowIso,
			host_origin: "local",
			deleted: 0,
			exit_code: null,
			metadata: null,
		}));
	};

	const flushPendingIds = (prefix: string, errContent: string): void => {
		if (activePendingIds.size > 0) {
			const remaining = [...activePendingIds];
			const results = makeSyntheticResults(prefix, remaining, errContent);
			for (const r of results) sanitized.push(r);
			activePendingIds.clear();
		}
	};

	for (const msg of messages) {
		if (msg.role === "tool_call") {
			flushPendingIds("synthetic", "Tool execution was interrupted");
			inActiveToolCall = true;
			lastToolId = msg.id;
			lastToolUseIds = extractToolUseIds(msg.content);
			activePendingIds.clear();
			for (const id of lastToolUseIds) activePendingIds.add(id);
			lastSyntheticToolCall = null;
			sanitized.push(msg);
			prevSanitizedRole = "tool_call";
			continue;
		}

		if (msg.role === "tool_result") {
			if (activePendingIds.size > 0 || inActiveToolCall) {
				if (msg.tool_name) activePendingIds.delete(msg.tool_name);
				inActiveToolCall = false;
				sanitized.push(msg);
				prevSanitizedRole = "tool_result";
			} else if (prevSanitizedRole === "tool_result") {
				if (lastSyntheticToolCall) {
					const toolUseId = msg.tool_name || `synthetic-tc-${msg.id}`;
					try {
						const blocks = JSON.parse(lastSyntheticToolCall.content);
						if (Array.isArray(blocks) && !blocks.some((b: { id?: string }) => b.id === toolUseId)) {
							blocks.push({ type: "tool_use", id: toolUseId, name: "unknown", input: {} });
							lastSyntheticToolCall.content = JSON.stringify(blocks);
						}
					} catch {
						// Non-parseable synthetic content — shouldn't happen.
					}
				}
				sanitized.push(msg);
				// prevSanitizedRole stays "tool_result"
			} else {
				const toolUseId = msg.tool_name || `synthetic-tc-${msg.id}`;
				const syntheticMsg: Message = {
					id: `synthetic-${msg.id}`,
					thread_id: threadId,
					role: "tool_call",
					content: JSON.stringify([
						{ type: "tool_use", id: toolUseId, name: "unknown", input: {} },
					]),
					model_id: null,
					tool_name: toolUseId,
					created_at: msg.created_at,
					modified_at: msg.modified_at,
					host_origin: msg.host_origin,
					deleted: 0,
					exit_code: null,
					metadata: null,
				};
				lastSyntheticToolCall = syntheticMsg;
				sanitized.push(syntheticMsg);
				sanitized.push(msg);
				prevSanitizedRole = "tool_result";
			}
			continue;
		}

		// Non-tool message — flush any remaining pending IDs first.
		if (inActiveToolCall) {
			const results = makeSyntheticResults(
				"synthetic",
				lastToolUseIds,
				"Tool execution was interrupted",
			);
			for (const r of results) sanitized.push(r);
			activePendingIds.clear();
			inActiveToolCall = false;
		} else {
			flushPendingIds("synthetic", "Tool execution was interrupted");
		}
		lastSyntheticToolCall = null;
		sanitized.push(msg);
		prevSanitizedRole = msg.role;
	}

	if (inActiveToolCall) {
		const results = makeSyntheticResults(
			"synthetic-close",
			lastToolUseIds,
			"Tool execution completed",
		);
		for (const r of results) sanitized.push(r);
	} else {
		flushPendingIds("synthetic-close", "Tool execution completed");
	}

	return sanitized;
}
