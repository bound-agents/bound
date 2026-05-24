/**
 * Shared utility for stripping thinking/redacted_thinking blocks from tool_call
 * message content, and the warm-path equivalent of cold-path Stage 1.7
 * history compaction.
 *
 * The cold path (context-assembly.ts Stage 1.7) operates on the DB Message[]
 * shape (with .id) and rewrites the entire context from scratch on each
 * cold rebuild. The warm path (agent-loop.ts) operates on the cached
 * LLMMessage[] (no .id) and is incremental: each warm turn appends a few
 * delta messages on top of the previous turn's stored array.
 *
 * Keeping the compaction logic in one place ensures warm and cold paths
 * produce byte-identical compacted content for the same input, eliminating
 * the cliff where cold reassembly invalidates the provider's prefix cache
 * after the warm path has been running for a while.
 */

import type { LLMMessage } from "@bound/llm";
import { countContentTokens } from "@bound/shared";

/**
 * Strip thinking/redacted_thinking blocks from a tool_call message's content.
 * Returns the original content unchanged if:
 * - Content is not valid JSON
 * - Content is not an array
 * - No thinking blocks are present
 * - Stripping would remove ALL blocks (preserves at least one non-thinking block)
 *
 * Idempotent: calling on already-stripped content is a no-op (fast path via
 * substring check before JSON.parse).
 */
export function stripThinkingFromToolCall(content: string): string {
	if (!hasStrippableThinking(content)) return content;

	try {
		const parsed = JSON.parse(content);
		if (!Array.isArray(parsed) || parsed.length === 0) return content;

		const kept = parsed.filter(
			(b: { type?: string }) => b && b.type !== "thinking" && b.type !== "redacted_thinking",
		);

		// Only rewrite if we actually dropped something AND at least one block remains.
		// If ALL blocks were thinking (shouldn't happen in practice — tool_calls always
		// have a tool_use block), preserve the original to avoid sending empty content.
		if (kept.length > 0 && kept.length < parsed.length) {
			return JSON.stringify(kept);
		}
	} catch {
		// Not valid JSON — leave as-is. Old rows may store plain strings.
	}

	return content;
}

/**
 * Returns true if the content likely contains thinking blocks that can be
 * stripped. Uses cheap substring checks to avoid unnecessary JSON.parse
 * on already-compact messages. False positives are harmless (just trigger
 * a parse that finds nothing to strip); false negatives are impossible
 * since any JSON array containing a thinking or redacted_thinking block
 * must include one of these literal type-value substrings.
 */
export function hasStrippableThinking(content: string): boolean {
	return content.includes('"thinking"') || content.includes('"redacted_thinking"');
}

/**
 * Threshold above which a tool_result message is replaced by a stub. Below
 * this size the tool_result is kept intact — the savings would not justify
 * losing the model's direct view of the result. Used by both cold-path
 * Stage 1.7 in context-assembly.ts and warm-path compactStoredMessagesInPlace.
 */
export const COLD_COMPACTION_THRESHOLD = 500;

/**
 * Default recent-window size for compaction, scaled to the backend's context
 * window. Roughly one preserved message per 2.5K tokens of window, clamped to
 * [4, 20]. Examples: 16K → 6, 32K → 12, 49K → 19, 200K → 20.
 *
 * Used by both cold-path Stage 1.7 and warm-path compactStoredMessagesInPlace
 * — the formula is part of the warm/cold parity contract, so keep it in one
 * place to prevent silent divergence.
 */
export function computeRecentWindow(contextWindow: number): number {
	return Math.max(4, Math.min(20, Math.floor(contextWindow / 2500)));
}

export interface CompactStoredMessagesOptions {
	/**
	 * Number of trailing messages to preserve intact (the "recent window").
	 * Older messages are eligible for tool_result truncation and (when over
	 * budget) thinking-block stripping.
	 */
	recentWindow: number;
	/**
	 * Backend context window (tokens). Used together with effectiveTruncationRatio
	 * to derive the thinking-strip threshold — thinking is preserved as long
	 * as post-tool_result-compaction estimate stays under the threshold, the
	 * same gating as cold-path Stage 1.7.
	 */
	contextWindow: number;
	/**
	 * The per-thread adaptive truncation ratio resolved by the agent loop.
	 * `contextWindow * effectiveTruncationRatio` is the thinking-strip
	 * threshold.
	 */
	effectiveTruncationRatio: number;
	/**
	 * Optional pre-computed sum of `countContentTokens(msg.content)` over
	 * `messages` BEFORE compaction. The agent loop's warm-path budget gate
	 * computes this immediately before calling us, so passing it here
	 * skips the redundant full-array tokenization pass we'd otherwise need
	 * to gate Step 2 (thinking-strip).
	 */
	precomputedEstimate?: number;
}

export interface CompactStoredMessagesResult {
	/** True if any message content was mutated. */
	compacted: boolean;
	/**
	 * Approximate tokens removed by this compaction pass. Caller can
	 * subtract from its pre-compaction estimate to re-check the warm-path
	 * budget without re-summing the whole array.
	 */
	tokensSaved: number;
}

/**
 * Mutate `messages` in place to apply warm-path equivalent of cold-path
 * Stage 1.7 history compaction. Returns whether any content changed and an
 * approximate token-savings estimate for the caller's budget re-check.
 *
 * Two operations, in fixed order:
 *  1. Replace `tool_result` content older than the recent window and longer
 *     than COLD_COMPACTION_THRESHOLD with a fixed-format stub. Stub references
 *     `tool_use_id` so the agent can recover full content via `query` against
 *     the messages table. tool_results without a tool_use_id are left alone
 *     (no recovery path → stub would be a dead end).
 *  2. If the post-step-1 token estimate still exceeds
 *     `floor(contextWindow * effectiveTruncationRatio)`, walk older
 *     `tool_call` messages and strip thinking blocks. Stops as soon as the
 *     estimate falls below the threshold.
 *
 * Idempotent: a second call on already-compacted content produces no further
 * changes. This is critical — the warm path may compact the same array
 * across multiple turns, and any byte drift would invalidate the provider's
 * cached prefix.
 */
export function compactStoredMessagesInPlace(
	messages: LLMMessage[],
	opts: CompactStoredMessagesOptions,
): CompactStoredMessagesResult {
	let compacted = false;
	let tokensSaved = 0;

	const compactionBoundary = Math.max(0, messages.length - opts.recentWindow);

	// Step 1: tool_result truncation.
	for (let i = 0; i < compactionBoundary; i++) {
		const msg = messages[i];
		if (msg.role !== "tool_result") continue;
		if (typeof msg.content !== "string") continue;
		if (msg.content.length <= COLD_COMPACTION_THRESHOLD) continue;
		// Recovery requires tool_use_id. Without it the stub is a dead end.
		if (!msg.tool_use_id) continue;

		const beforeTokens = countContentTokens(msg.content);
		const originalLength = msg.content.length;
		msg.content = warmToolResultStub(msg.tool_use_id, originalLength, msg.content);
		tokensSaved += beforeTokens - countContentTokens(msg.content);
		compacted = true;
	}

	// Step 2: thinking strip if still over threshold.
	const thinkingThreshold = Math.floor(opts.contextWindow * opts.effectiveTruncationRatio);
	// Reuse caller's pre-computed sum when available (warm-path budget gate
	// already tokenized the array). Apply Step 1 savings to get the
	// post-step-1 estimate without re-summing.
	let estimate: number;
	if (opts.precomputedEstimate !== undefined) {
		estimate = opts.precomputedEstimate - tokensSaved;
	} else {
		estimate = 0;
		for (const msg of messages) {
			estimate += countContentTokens(msg.content);
		}
	}
	if (estimate > thinkingThreshold) {
		for (let i = 0; i < compactionBoundary; i++) {
			if (estimate <= thinkingThreshold) break;
			const msg = messages[i];
			if (msg.role !== "tool_call") continue;
			if (typeof msg.content !== "string") continue;
			if (!hasStrippableThinking(msg.content)) continue;

			const before = countContentTokens(msg.content);
			const stripped = stripThinkingFromToolCall(msg.content);
			if (stripped === msg.content) continue;
			msg.content = stripped;
			const after = countContentTokens(msg.content);
			estimate -= before - after;
			tokensSaved += before - after;
			compacted = true;
		}
	}

	return { compacted, tokensSaved };
}

/**
 * Stub format for compacted tool_results on the warm path. Mirrors the
 * cold-path stub but references `tool_use_id` instead of `messages.id`
 * because warm-path storage is `LLMMessage[]` which has no DB id. The agent
 * can recover full content with:
 *
 *   query SELECT content FROM messages WHERE tool_name = '<tool_use_id>'
 *
 * (`tool_name` is the column where tool_use_id is persisted for tool_result
 * rows — see context-assembly.ts comments around tool_use_id propagation.)
 *
 * Format is stable: same `(toolUseId, originalLength)` always produces the
 * same string. Includes a short preview of the original content to give
 * the model an at-a-glance reminder without paying for the full payload.
 */
function warmToolResultStub(toolUseId: string, originalLength: number, original: string): string {
	const preview = original.slice(0, 200).trimEnd();
	return `[Tool result truncated for inline display — ${originalLength} chars stored. Full content: query SELECT content FROM messages WHERE tool_name='${toolUseId}']\n${preview}`;
}
