/**
 * Stage 5 ANNOTATION. See `index.ts` for architectural rationale.
 */

import type { ContentBlock, LLMMessage } from "@bound/llm";
import type { Message } from "@bound/shared";
import { formatInstant } from "../context-assembly";

/** Hard cap on the number of injected `Model switched` developer messages. */
export const MODEL_SWITCH_CAP = 3;

/** Tag name for the per-user-message metadata envelope (kebab-case, matching
 * the R-VC31 volatile-context envelope convention). */
const USER_MESSAGE_TAG = "user-message";

/**
 * Builds the attribute string for a user message's `<user-message>` envelope
 * (leading space included, or "" when no attributes apply).
 *
 * Every attribute MUST derive only from immutable message columns so the
 * rendered envelope stays a pure function of the row — preserving the
 * byte-stable annotation rule (N7) that anchors the message-level cachePoint.
 * Today that's the send time (`created_at` + the once-written `tz_offset`);
 * additional immutable fields slot in here as new attributes.
 */
function buildUserMessageAttributes(m: Message): string {
	const attrs: string[] = [];
	if (m.created_at) {
		attrs.push(`sent="${formatInstant(m.created_at, readTzOffsetMinutes(m.metadata))}"`);
	}
	return attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
}

/**
 * Reads the sender's UTC offset (minutes, east-of-UTC positive) from a user
 * message's metadata property bag, if the client stamped one at send time
 * (`tz_offset`). Returns undefined when absent or malformed — callers then
 * fall back to plain UTC rendering.
 *
 * This is the single, deliberate read of `messages.metadata` from context
 * assembly (Invariant #19 otherwise keeps that bag invisible to the agent
 * loop): one controlled field that drives the byte-stable timestamp prefix,
 * not platform delivery state. `tz_offset` is written once at insert and never
 * mutated, so the rendered prefix stays a pure function of immutable inputs.
 */
function readTzOffsetMinutes(metadata: string | null): number | undefined {
	if (!metadata) return undefined;
	try {
		const parsed = JSON.parse(metadata) as Record<string, unknown>;
		const v = parsed.tz_offset;
		return typeof v === "number" && Number.isFinite(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

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

		// Wrap user messages in an XML metadata envelope. Always — independent
		// of nowMs — so the wire bytes are byte-stable across the agent loop's
		// lifetime.
		//
		// History: the predecessor was a bare timestamp prefix (`[May 26,
		// 15:53] <content>`), itself once age-gated (≥60s only). The age gate
		// introduced a one-time byte transition exactly 60s into the
		// conversation that thrashed the message-level cachePoint anchored on
		// user_1 (live regression on thread `6fff1513-...` 2026-05-26).
		// Annotating always — and deriving every envelope attribute purely
		// from immutable columns (`created_at` + the once-written `tz_offset`)
		// — keeps the wire bytes a pure function of the row, so the cachePoint
		// holds. The model already sees the time via the volatile tail;
		// carrying it on the message is redundant-but-stable, strictly better
		// than redundant-and-time-varying.
		//
		// The envelope wraps BOTH content forms (Invariant #10): a plain
		// string is wrapped in open/close tags; a ContentBlock[] (e.g. an image
		// message) is bracketed by leading + trailing text blocks so non-text
		// blocks survive intact between the tags — which also gives vision
		// messages a send time they previously lacked.
		if (m.role === "user" && m.created_at) {
			const attrs = buildUserMessageAttributes(m);
			if (typeof annotatedContent === "string") {
				annotatedContent = `<${USER_MESSAGE_TAG}${attrs}>\n${annotatedContent}\n</${USER_MESSAGE_TAG}>`;
			} else if (Array.isArray(annotatedContent)) {
				annotatedContent = [
					{ type: "text", text: `<${USER_MESSAGE_TAG}${attrs}>` },
					...annotatedContent,
					{ type: "text", text: `</${USER_MESSAGE_TAG}>` },
				] as ContentBlock[];
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
