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
	 * Wall-clock anchor for the user-message timestamp annotation
	 * cutoff. Defaults to `Date.now()` for production callers; tests
	 * inject a fixed value so property assertions can compare
	 * byte-equal output.
	 */
	nowMs?: number;
}

export function annotateMessages(params: AnnotateMessagesParams): LLMMessage[] {
	const { messages } = params;
	const nowMs = params.nowMs ?? Date.now();

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

		// Timestamp-annotate user messages older than 60s.
		if (m.role === "user" && m.created_at) {
			const ageMs = nowMs - new Date(m.created_at).getTime();
			if (ageMs >= 60_000 && typeof annotatedContent === "string") {
				const ts = formatTimestamp(m.created_at);
				annotatedContent = `${ts} ${annotatedContent}`;
			}
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
