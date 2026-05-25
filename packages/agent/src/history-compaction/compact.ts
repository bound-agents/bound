/**
 * Stage 1.7 compaction primitives. See `index.ts` for the
 * cache-stability invariant rationale.
 */

import type { Message } from "@bound/shared";
import { countContentTokens, safeSlice } from "@bound/shared";
import {
	COLD_COMPACTION_THRESHOLD,
	hasStrippableThinking,
	stripThinkingFromToolCall,
} from "../warm-compaction";

/**
 * Compute the compaction boundary for a message sequence.
 *
 * Returns the index of the LAST user message when one exists, or
 * `max(0, messages.length - recentWindow)` when no user message
 * is present (scheduled task threads, system-only sequences).
 *
 * Anything strictly before this index is eligible for compaction;
 * anything at or after stays intact.
 *
 * **Cache stability** — see `index.ts` H2. Appending assistant +
 * tool_result rows after `lastUserIdx` MUST NOT shift the boundary.
 * That's the property fast-check pins for us.
 */
export function computeCompactionBoundary(
	messages: ReadonlyArray<Message>,
	recentWindow: number,
): number {
	let lastUserIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			lastUserIdx = i;
			break;
		}
	}
	return lastUserIdx >= 0 ? lastUserIdx : Math.max(0, messages.length - recentWindow);
}

/**
 * Replace `tool_result` content longer than
 * `COLD_COMPACTION_THRESHOLD` with a retrieval-pointer stub for
 * messages strictly before `boundary`.
 *
 * **Mutates messages in place** — the caller owns the array and
 * expects compaction to be cheap. Idempotent: a second call on
 * already-stubbed messages is a no-op (the stub format starts with
 * `[Tool result truncated for inline display`, which is preserved).
 *
 * Returns the number of messages that were actually compacted, for
 * logging / metrics purposes.
 */
export function compactToolResultsBeforeBoundary(messages: Message[], boundary: number): number {
	let compacted = 0;
	const effectiveBoundary = Math.min(boundary, messages.length);
	for (let i = 0; i < effectiveBoundary; i++) {
		const msg = messages[i];
		if (msg.role === "tool_result" && msg.content.length > COLD_COMPACTION_THRESHOLD) {
			const originalLength = msg.content.length;
			const preview = safeSlice(msg.content, 0, 200).trimEnd();
			msg.content = `[Tool result truncated for inline display — ${originalLength} chars stored. Full content: query SELECT content FROM messages WHERE id='${msg.id}']\n${preview}`;
			compacted++;
		}
	}
	return compacted;
}

/**
 * Strip thinking blocks from `tool_call` messages before
 * `boundary` when the cold-assembly token estimate exceeds the
 * supplied `thinkingThreshold`. Operates greedily — strips one
 * tool_call at a time, recomputes the estimate, and stops as
 * soon as the estimate falls back below threshold.
 *
 * Preserves the model's reasoning chain on cold assembly when
 * there's headroom; only fires under genuine pressure.
 *
 * **Mutates messages in place** when stripping. Returns the
 * number of tool_calls actually stripped.
 */
export function stripThinkingBeforeBoundary(
	messages: Message[],
	boundary: number,
	thinkingThreshold: number,
): number {
	let coldEstimate = 0;
	for (const msg of messages) {
		coldEstimate += countContentTokens(msg.content);
	}
	if (coldEstimate <= thinkingThreshold) return 0;

	let stripped = 0;
	const effectiveBoundary = Math.min(boundary, messages.length);
	for (let i = 0; i < effectiveBoundary; i++) {
		if (coldEstimate <= thinkingThreshold) break;
		const msg = messages[i];
		if (msg.role === "tool_call" && hasStrippableThinking(msg.content)) {
			const before = countContentTokens(msg.content);
			msg.content = stripThinkingFromToolCall(msg.content);
			const after = countContentTokens(msg.content);
			coldEstimate -= before - after;
			stripped++;
		}
	}
	return stripped;
}
