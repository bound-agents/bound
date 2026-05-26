/**
 * Stage 5 ANNOTATION. See `index.ts` for architectural rationale.
 */

import type { ContentBlock, LLMMessage } from "@bound/llm";
import type { Message } from "@bound/shared";
import { formatTimestamp } from "../context-assembly";

/** Hard cap on the number of injected `Model switched` developer messages. */
export const MODEL_SWITCH_CAP = 3;

const LLM_COMPATIBLE_ROLES = new Set([
	"user",
	"assistant",
	"system",
	"developer",
	"tool_call",
	"tool_result",
]);

export interface AnnotateMessagesParams {
	/** Post-Stage-3 sanitized messages. */
	messages: ReadonlyArray<Message>;
	/**
	 * @deprecated Unused under the byte-stable annotation rule (N7).
	 * Kept in the input shape for backward compatibility with callers
	 * that still pass a value. The annotator no longer consults
	 * wall-clock time when deciding whether to prefix a user message.
	 */
	nowMs?: number;
}

export function annotateMessages(params: AnnotateMessagesParams): LLMMessage[] {
	const { messages } = params;

	// Build a map from tool_call message ID to its first tool_use_id,
	// plus a set of all known tool_use_ids for tool_result resolution.
	const toolCallIdToToolUseId = new Map<string, string>();
	const knownToolUseIds = new Set<string>();
	for (const m of messages) {
		if (m.role !== "tool_call") continue;
		try {
			const blocks = JSON.parse(m.content);
			if (Array.isArray(blocks)) {
				for (const block of blocks) {
					if (block.id) knownToolUseIds.add(block.id);
				}
				if (blocks.length > 0 && blocks[0].id) {
					toolCallIdToToolUseId.set(m.id, blocks[0].id);
				}
			}
		} catch {
			// Synthetic tool_call content may not be JSON — skip.
		}
	}

	const annotated: LLMMessage[] = [];
	let lastAssistantModel: string | null = null;
	let lastToolCallMsgId: string | null = null;
	let modelSwitchCount = 0;

	for (const m of messages) {
		// Skip non-LLM roles defense-in-depth — Stage 2.5 should have
		// already filtered these.
		if (!LLM_COMPATIBLE_ROLES.has(m.role)) continue;

		if (m.role === "tool_call") lastToolCallMsgId = m.id;

		// Model-switch detection (capped).
		if (m.role === "assistant" && m.model_id) {
			if (lastAssistantModel && lastAssistantModel !== m.model_id) {
				if (modelSwitchCount < MODEL_SWITCH_CAP) {
					annotated.push({
						role: "developer",
						content: `Model switched from ${lastAssistantModel} to ${m.model_id}`,
					});
					modelSwitchCount++;
				}
			}
			lastAssistantModel = m.model_id;
		}

		// Parse JSON ContentBlock[] strings back into arrays.
		let annotatedContent: string | ContentBlock[] = m.content;
		if (
			typeof m.content === "string" &&
			(m.role === "user" || m.role === "assistant" || m.role === "tool_result")
		) {
			try {
				const parsed = JSON.parse(m.content);
				if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type) {
					annotatedContent = parsed as ContentBlock[];
				}
			} catch {
				// Not JSON — keep as plain text.
			}
		}

		// Timestamp-annotate user messages. Always — independent of nowMs —
		// so the wire bytes are byte-stable across the agent loop's lifetime.
		//
		// History: the rule was previously age-gated (≥60s only), to avoid
		// prefixing the user's just-sent message. But that introduced a
		// one-time byte transition exactly 60s into the conversation:
		// before 60s the wire showed `<user content>`, after 60s it showed
		// `[May 26, 15:53] <user content>`. For autonomous tasks (single
		// user_1 followed by long inner loops), the 60s cliff routinely
		// fired mid-conversation, breaking the message-level cachePoint
		// that anchored on user_1. Live regression on thread `6fff1513-...`
		// 2026-05-26: cumulative cache stuck at the system-anchor floor
		// because user_1's wire bytes shifted by +16 chars at the cliff.
		//
		// Annotating always is byte-stable: the prefix is a pure function
		// of `created_at`, which is immutable per Invariant #1. The model
		// already sees the timestamp via the volatile-tail context; adding
		// it to the user message is redundant-but-stable, which is
		// strictly better than redundant-and-time-varying.
		if (m.role === "user" && m.created_at && typeof annotatedContent === "string") {
			const ts = formatTimestamp(m.created_at);
			annotatedContent = `${ts} ${annotatedContent}`;
		}

		const msg: LLMMessage = {
			role: m.role as LLMMessage["role"],
			content: annotatedContent,
			model_id: m.model_id || undefined,
			host_origin: m.host_origin,
		};

		// tool_use_id resolution for tool_result rows.
		if (m.role === "tool_result") {
			const toolUseId =
				(m.tool_name && knownToolUseIds.has(m.tool_name) ? m.tool_name : null) ||
				(lastToolCallMsgId ? toolCallIdToToolUseId.get(lastToolCallMsgId) : null) ||
				`synthetic-${m.id}`;
			msg.tool_use_id = toolUseId;
		}

		annotated.push(msg);
	}

	return annotated;
}
