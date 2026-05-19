/**
 * Shared utility for stripping thinking/redacted_thinking blocks from tool_call
 * message content. Used by both:
 * - The cold path (context-assembly.ts Stage 1.7) for full reassembly
 * - The warm path (agent-loop.ts) for incremental compaction
 *
 * Keeping the logic in one place ensures warm and cold paths produce identical
 * compacted content, eliminating the "cliff" where cold reassembly produces a
 * context the model doesn't recognize as continuous with its warm-path state.
 */

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
