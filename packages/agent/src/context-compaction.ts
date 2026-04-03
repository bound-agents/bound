import type { LLMMessage } from "@bound/llm";

/**
 * Minimum content length for a tool result to be eligible for compaction.
 * Short results (e.g., "Memory saved: key") aren't worth replacing with a pointer.
 */
const COMPACTION_SIZE_THRESHOLD = 500;

/** Maximum preview length included in the compaction marker. */
const PREVIEW_LENGTH = 200;

/**
 * Compacts context messages for cold-cache turns.
 *
 * - Messages in the recent window (last `recentWindowSize`) are kept verbatim.
 * - Older tool_result messages above the size threshold are replaced with
 *   DB retrieval pointers so the agent can re-fetch them if needed.
 * - If a thread summary is provided, it's injected as a system message
 *   before the compacted history to give the agent conversational context.
 *
 * Messages are expected to carry `_messageId` for tool_result pointer generation.
 * Messages without `_messageId` have their tool results truncated without a query hint.
 */
export function compactMessages(
	messages: Array<LLMMessage & { _messageId?: string }>,
	threadSummary: string | null,
	recentWindowSize: number,
): LLMMessage[] {
	// If everything fits in the recent window, no compaction needed
	if (messages.length <= recentWindowSize) {
		return messages;
	}

	const compactionBoundary = messages.length - recentWindowSize;
	const result: LLMMessage[] = [];

	// Inject summary as context anchor when available
	if (threadSummary) {
		result.push({
			role: "system",
			content:
				`[Conversation compacted — ${compactionBoundary} older messages summarized. ` +
				`Use "query" to retrieve specific messages if needed.]\n\n` +
				`Summary: ${threadSummary}`,
		});
	}

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (i < compactionBoundary && msg.role === "tool_result") {
			const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

			if (content.length > COMPACTION_SIZE_THRESHOLD) {
				const preview = content.slice(0, PREVIEW_LENGTH).trimEnd();
				const messageId = msg._messageId;
				const queryHint = messageId
					? `Retrieve with: query SELECT content FROM messages WHERE id='${messageId}'`
					: "Use query command to retrieve if needed";

				result.push({
					role: "tool_result",
					content:
						`[Result truncated from context — ${content.length} chars. ${queryHint}]\n${preview}`,
					tool_use_id: msg.tool_use_id,
				});
				continue;
			}
		}

		// Keep message as-is (recent window, non-tool_result, or small tool_result)
		result.push({
			role: msg.role,
			content: msg.content,
			tool_use_id: msg.tool_use_id,
			model_id: msg.model_id,
			host_origin: msg.host_origin,
		});
	}

	return result;
}
