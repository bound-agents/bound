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
 * Replace `tool_result` content longer than `COLD_COMPACTION_THRESHOLD`
 * with a retrieval-pointer stub for messages strictly before `boundary`,
 * but ONLY under budget pressure and only as much as needed.
 *
 * Budget gate (the fix for over-eager compaction): if the cold-assembly
 * token estimate is already at or below `budgetTokens`, nothing is
 * stubbed — stubbing a read result the model still needs, while the
 * context is far from full, forces it to re-read and prevents it from
 * accumulating enough to converge. Compaction is a budget-pressure
 * mechanism, not an always-on one (mirrors stripThinkingBeforeBoundary).
 *
 * When over budget, stubs greedily OLDEST-first (lowest index), stopping
 * as soon as the estimate falls back to budget. The most recent results
 * (closest to the boundary — the model's freshest findings) are the last
 * to be sacrificed.
 *
 * **Mutates messages in place.** Idempotent: a re-run stubs nothing more
 * once under budget, and an already-stubbed result (short, prefixed with
 * `[Tool result truncated for inline display`) is below threshold so it is
 * never re-stubbed.
 *
 * Returns the number of messages actually compacted.
 */
export function compactToolResultsBeforeBoundary(
	messages: Message[],
	boundary: number,
	budgetTokens: number,
): number {
	let estimate = 0;
	for (const m of messages) estimate += countContentTokens(m.content);
	if (estimate <= budgetTokens) return 0;

	let compacted = 0;
	const effectiveBoundary = Math.min(boundary, messages.length);
	for (let i = 0; i < effectiveBoundary; i++) {
		if (estimate <= budgetTokens) break;
		const msg = messages[i];
		if (msg.role === "tool_result" && msg.content.length > COLD_COMPACTION_THRESHOLD) {
			const before = countContentTokens(msg.content);
			const originalLength = msg.content.length;
			const preview = safeSlice(msg.content, 0, 200).trimEnd();
			msg.content = `[Tool result truncated for inline display — ${originalLength} chars stored. Full content: query SELECT content FROM messages WHERE id='${msg.id}']\n${preview}`;
			estimate -= before - countContentTokens(msg.content);
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
