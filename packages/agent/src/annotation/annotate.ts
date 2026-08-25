/**
 * Stage 5 ANNOTATION. See `index.ts` for architectural rationale.
 */

import type { ContentBlock, LLMMessage } from "@bound/llm";
import type { Message } from "@bound/shared";
import { countContentTokens, countContentTokensById } from "@bound/shared";
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
function buildUserMessageAttributes(m: Message, nowMsRef?: number): string {
	const attrs: string[] = [];
	// `from` first so the envelope reads "<user-message from="Kara" sent="...">".
	// Stamped once into metadata at insert (like tz_offset), so it stays an
	// immutable input — old rows without a stamped name render no `from` and
	// keep their pre-feature bytes (no retroactive cachePoint invalidation).
	const from = readUserName(m.metadata);
	if (from) {
		attrs.push(`from="${escapeXmlAttr(from)}"`);
	}
	// `role` next, per the #201 sender-envelope schema `<message from role sent
	// [thread]>`: one identity-aware envelope for every conversational sender,
	// where `role` is the only variance (user→main, main→aux, main→main). Like
	// `from`/`tz_offset` it is stamped once at insert and never mutated. Absent —
	// every message written before this feature, and every plain user message the
	// intake site chooses not to stamp — renders no `role` and keeps its
	// pre-feature bytes, so the message-level cachePoint never thrashes. The
	// implicit default when omitted is user.
	const role = readSenderRole(m.metadata);
	if (role) {
		attrs.push(`role="${escapeXmlAttr(role)}"`);
	}
	if (m.created_at) {
		attrs.push(`sent="${formatInstant(m.created_at, readTzOffsetMinutes(m.metadata), nowMsRef)}"`);
	}
	return attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
}

/**
 * Reads the sender's display name from a user message's metadata bag, if the
 * intake site stamped one at send time (`user_name`). Returns undefined when
 * absent or not a non-empty string. Like `tz_offset`, written once at insert
 * and never mutated, so the rendered attribute stays a pure function of the row.
 */
function readUserName(metadata: string | null): string | undefined {
	if (!metadata) return undefined;
	try {
		const parsed = JSON.parse(metadata) as Record<string, unknown>;
		const v = parsed.user_name;
		return typeof v === "string" && v.length > 0 ? v : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Reads the sender-relationship role from a user message's metadata bag, if the
 * intake site stamped one at send time (`sender_role`). This is the #201
 * sender-envelope `role` axis: `"main"` for a main-agent message written into an
 * auxiliary conversation (or a notify/introspect message between main-agent
 * threads); `"user"` for an operator message. Returns undefined when absent or
 * not a non-empty string — every message written before this feature, and every
 * plain user message the intake site leaves unstamped, so those envelopes render
 * byte-identically as before (no retroactive cachePoint invalidation). Like
 * `user_name`/`tz_offset`, written once at insert and never mutated, so the
 * rendered attribute stays a pure function of the row.
 */
function readSenderRole(metadata: string | null): string | undefined {
	if (!metadata) return undefined;
	try {
		const parsed = JSON.parse(metadata) as Record<string, unknown>;
		const v = parsed.sender_role;
		return typeof v === "string" && v.length > 0 ? v : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Escapes a string for use inside a double-quoted XML attribute value. A
 * user-controlled display name can carry `&`, `<`, `>`, or `"`; left raw they
 * would break the `<user-message>` envelope the model parses.
 */
function escapeXmlAttr(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
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
	 * The AssemblyClock instant, used SOLELY as the reference year for the
	 * `<user-message sent="…">` envelope's `formatInstant` rendering (its only
	 * wall-clock dependency: same-year vs `'YY` suffix). Threading it makes the
	 * envelope a pure function of `(row, nowMs)` across hosts — two hosts in
	 * different calendar years would otherwise render the same `created_at`
	 * differently, breaking the cross-host byte-equivalence the single-delegation
	 * path needs (R-UD4 / AC.3). It does NOT gate whether to annotate (the
	 * byte-stable annotation rule N7 still annotates unconditionally). When
	 * omitted, `formatInstant` falls back to `Date.now()`.
	 */
	nowMs?: number;
}

/**
 * Result of {@link annotateMessagesWithTokens}: the annotated wire messages plus
 * an aligned per-message token count (same length and order as `messages`).
 *
 * The counts are computed here — the single place that still holds each row's
 * stable `(id, modified_at)` identity before it is dropped at the `LLMMessage`
 * boundary — so downstream stages (budget gate, tier allocation, history-section
 * sizing) reuse them instead of re-tokenizing the full history 2-3x per cold
 * rebuild. Real message rows go through `countContentTokensById` (identity-keyed,
 * survives cross-thread cache churn); injected messages with no source row
 * (e.g. "Model switched" developer markers) are tiny and counted live.
 */
export interface AnnotatedMessagesWithTokens {
	messages: LLMMessage[];
	perMessageTokens: number[];
}

export function annotateMessages(params: AnnotateMessagesParams): LLMMessage[] {
	return annotateMessagesWithTokens(params).messages;
}

export function annotateMessagesWithTokens(
	params: AnnotateMessagesParams,
): AnnotatedMessagesWithTokens {
	const { messages, nowMs } = params;
	const perMessageTokens: number[] = [];

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
					const switchContent = `Model switched from ${lastAssistantModel} to ${m.model_id}`;
					annotated.push({ role: "developer", content: switchContent });
					// Injected marker — no source row identity; tiny, count live.
					perMessageTokens.push(countContentTokens(switchContent));
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
		// user_1.
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
			const attrs = buildUserMessageAttributes(m, nowMs);
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
		// Identity-keyed count over the ANNOTATED content (what the wire/budget
		// sees). Keyed by the source row's (id, modified_at) so it survives
		// cross-thread content-cache churn and is computed once ever per message.
		perMessageTokens.push(countContentTokensById(m.id, m.modified_at ?? "", annotatedContent));
	}

	return { messages: annotated, perMessageTokens };
}
