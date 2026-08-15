/**
 * Message conversion: Bound's LLMMessage shape → AI SDK ModelMessage.
 *
 * Includes cache-marker flattening, tool_call/tool_result wrapping, the
 * wire-format envelope definitions, and the rewrite-only-on-violation
 * sanitizers for tool_use.id / tool_use.name. Provider-specific behavior
 * (cache control, reasoning replay) is injected by the caller via
 * ToModelMessagesOptions — see the individual drivers.
 */

import type { ModelMessage } from "ai";
import type { ContentBlock, LLMMessage } from "../types";

export interface ToModelMessagesOptions {
	/**
	 * Provider key used on the cache-marker passthrough. Bedrock expects
	 * `providerOptions.bedrock.cachePoint`, Anthropic expects
	 * `providerOptions.anthropic.cacheControl`. OpenAI Responses models that
	 * accept explicit breakpoints (GPT-5.6 family on Mantle) use "openai":
	 * the marker becomes `providerOptions.openai.promptCacheBreakpoint`,
	 * attached at the nearest position the Responses wire can express — see
	 * attachOpenAIPromptCacheBreakpoint. Null (or omit) drops marker roles
	 * harmlessly for providers with no breakpoint mechanism.
	 */
	cacheProvider?: "bedrock" | "anthropic" | "openai" | null;
	/**
	 * Cache TTL hint forwarded to the cache breakpoint. "5m" or "1h".
	 * Omit (or undefined) to use the provider's default (5m). 1h is only
	 * supported on certain newer Claude models — see ChatParams.cache_ttl.
	 * Ignored for the "openai" provider: OpenAI cache retention is a
	 * request-level option (promptCacheRetention), not per-breakpoint.
	 */
	cacheTtl?: "5m" | "1h";
	/**
	 * Resolves a `file_ref` source to inline base64 data. See
	 * ChatParams.resolveFileRef for the full contract — this is the same
	 * callback, threaded through driver → bridge.
	 */
	resolveFileRef?: (fileId: string) => string | null;
	/**
	 * Provider key gating how reasoning/thinking blocks replay on the wire.
	 *
	 * - "bedrock" / "anthropic": attach `signature` and `redacted_data` via
	 *   providerOptions.{key}. Only Anthropic models (direct or on Bedrock)
	 *   accept these; non-Anthropic Bedrock models (Kimi, MiniMax, GLM, Nova, …)
	 *   reject `reasoningContent.reasoningText.signature` outright.
	 * - "openai": attach OpenAI encrypted reasoning state via
	 *   providerOptions.openai.reasoningEncryptedContent so GPT-5.x on Mantle can
	 *   reconstruct its prior chain-of-thought (store:false continuity). A
	 *   thinking block WITHOUT that encrypted state is non-replayable for an
	 *   OpenAI target and is dropped at the read boundary — equivalent to
	 *   @ai-sdk/openai's own skip-with-warning behavior, minus the log flood.
	 * - null (or omit): non-Anthropic Bedrock / local targets; reasoning text
	 *   replays without provider-specific replay metadata.
	 */
	reasoningProviderOptions?: "bedrock" | "anthropic" | "openai" | null;
	/**
	 * Wire-format envelope for the (provider, model) pair this assembly is
	 * targeting. Drives rewrite-only-on-violation sanitization of tool_use.id
	 * and tool_use.name. See WireEnvelope above.
	 *
	 * Omit (or undefined) to default to ANTHROPIC_ENVELOPE — the strictest
	 * envelope and the historical universal-rewrite behavior. Drivers should
	 * always set this explicitly so model-specific quirks (Kimi's native
	 * functions.foo:0 fallback id shape on the bedrock-converse envelope) are
	 * preserved instead of rewritten into model-foreign forms.
	 */
	targetEnvelope?: WireEnvelope;
	/**
	 * When true, `developer`-role messages are emitted as native
	 * `{ role: "system" }` ModelMessages only when that placement is legal for
	 * directive-style system messages: immediately before an assistant message,
	 * or at the end of the message array. Other developer messages are folded
	 * into adjacent user messages wrapped in `<system-context>` tags.
	 *
	 * Requires `allowSystemInMessages: true` on the `streamText` call so the
	 * AI SDK v7 accepts mid-array system messages (it defaults to reject).
	 *
	 * Support: Anthropic/Mantle-style message APIs that accept system directives
	 * in the message array. NOT supported on Bedrock Converse — omit on that
	 * driver to keep the legacy merge path.
	 */
	midConversationSystem?: boolean;
}

/**
 * Ceiling on message-level `prompt_cache_breakpoint`s emitted per request.
 *
 * The GPT-5.6 family accepts at most FOUR breakpoints per request. The
 * mantle driver spends one on the system/instructions message (the
 * stable-prefix anchor, attached in bedrock-mantle.ts — invisible to this
 * module), so the bridge caps message-level markers at three. The agent
 * loop's stable placer emits 1–2 markers per turn today; the cap is a
 * backstop so a future placer emitting more degrades to "marker dropped"
 * instead of a 400 on every request.
 */
export const MAX_OPENAI_MESSAGE_BREAKPOINTS = 3;

/**
 * Attach an OpenAI `prompt_cache_breakpoint` for one `{role:"cache"}` marker.
 *
 * Anthropic/Bedrock accept a cache boundary on ANY message via
 * message-level providerOptions, so the generic handler marks
 * `result[length-1]` unconditionally. The OpenAI Responses converter
 * (@ai-sdk/openai `convertToOpenAIResponsesInput`) only reads
 * `providerOptions.openai.promptCacheBreakpoint` from specific positions:
 *
 *   - system/developer messages — MESSAGE-level providerOptions;
 *   - user messages — PART-level providerOptions on input_text/file parts
 *     (message-level is ignored);
 *   - tool function_call_output — ITEM-level providerOptions on content
 *     items, and only when the output uses the `{type:"content"}` shape
 *     (the `{type:"text"}` shape serializes to a bare string with nowhere
 *     to hang the marker);
 *   - assistant messages — not representable at all (output_text items
 *     carry no breakpoint field).
 *
 * So: walk backwards from the marker to the nearest message that CAN carry
 * a breakpoint and mark it there. Moving the boundary earlier only shrinks
 * the cached prefix by the skipped messages — semantically safe. A user
 * message with string content is lifted to parts form so the marker can
 * ride part-level (the SDK's own string→parts lift keeps providerOptions
 * at the message level, which the Responses converter ignores for user
 * messages). Empty text parts are skipped — `convertToLanguageModelPrompt`
 * filters them out of user content, taking any marker with them. A
 * text-shape tool output is converted to the equivalent single-item
 * content shape to gain an item to mark.
 *
 * If the walk finds a position that already carries a breakpoint (two
 * markers collapsing onto one boundary), the marker is a no-op rather than
 * a double-count against MAX_OPENAI_MESSAGE_BREAKPOINTS.
 */
function attachOpenAIPromptCacheBreakpoint(
	result: ModelMessage[],
	state: { attached: number },
): void {
	if (state.attached >= MAX_OPENAI_MESSAGE_BREAKPOINTS) return;
	for (let i = result.length - 1; i >= 0; i--) {
		const msg = result[i];
		if (msg.role === "system") {
			if (!msg.providerOptions) msg.providerOptions = {};
			const provOpts = msg.providerOptions as Record<string, Record<string, unknown>>;
			if (!provOpts.openai) provOpts.openai = {};
			if (provOpts.openai.promptCacheBreakpoint) return; // boundary already marked
			provOpts.openai.promptCacheBreakpoint = { mode: "explicit" };
			state.attached += 1;
			return;
		}
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content === "") continue; // would be filtered on the wire
				msg.content = [{ type: "text", text: msg.content }] as never;
			}
			const parts = msg.content as unknown as Array<Record<string, unknown>>;
			for (let j = parts.length - 1; j >= 0; j--) {
				const part = parts[j];
				if (part.type !== "text" || part.text === "") continue;
				if (!part.providerOptions) part.providerOptions = {};
				const provOpts = part.providerOptions as Record<string, Record<string, unknown>>;
				if (!provOpts.openai) provOpts.openai = {};
				if (provOpts.openai.promptCacheBreakpoint) return; // boundary already marked
				provOpts.openai.promptCacheBreakpoint = { mode: "explicit" };
				state.attached += 1;
				return;
			}
			continue; // no markable text part (image-only user turn) — walk on
		}
		if (msg.role === "tool" && Array.isArray(msg.content)) {
			const parts = msg.content as unknown as Array<Record<string, unknown>>;
			for (let j = parts.length - 1; j >= 0; j--) {
				const part = parts[j];
				if (part.type !== "tool-result") continue;
				const output = part.output as
					| { type: "text"; value: string }
					| { type: "content"; value: Array<Record<string, unknown>> }
					| undefined;
				if (!output) continue;
				if (output.type === "text") {
					// Convert to the content shape — the only tool-output form
					// with an item slot for the breakpoint. The Responses
					// converter serializes both shapes; content-shape text
					// becomes [{type:"input_text", text}] instead of a bare
					// string, which the API accepts equivalently.
					part.output = {
						type: "content",
						value: [
							{
								type: "text",
								text: output.value,
								providerOptions: { openai: { promptCacheBreakpoint: { mode: "explicit" } } },
							},
						],
					};
					state.attached += 1;
					return;
				}
				if (output.type === "content") {
					for (let k = output.value.length - 1; k >= 0; k--) {
						const item = output.value[k];
						if (item.type !== "text") continue;
						if (!item.providerOptions) item.providerOptions = {};
						const provOpts = item.providerOptions as Record<string, Record<string, unknown>>;
						if (!provOpts.openai) provOpts.openai = {};
						if (provOpts.openai.promptCacheBreakpoint) return; // already marked
						provOpts.openai.promptCacheBreakpoint = { mode: "explicit" };
						state.attached += 1;
						return;
					}
				}
				// media-only tool output — no text item to mark; try the
				// previous tool-result part or an earlier message.
			}
		}
		// assistant (and anything else): the Responses wire has no breakpoint
		// slot on assistant items — walk further back.
	}
}

/** Maximum length accepted by Bedrock Converse for toolUseId and toolUse.name.
 * Anthropic does not advertise a documented length cap on tool_use.id but
 * accepts arbitrary lengths; the 64-char bound is the strict subset across
 * supported providers and the default idMaxLength for every non-permissive
 * WireEnvelope. */
export const MAX_TOOL_USE_ID_LENGTH = 64;

// Wire-format envelope describing a target model's accepted tool_use.id and
// tool_use.name shapes. Consumed by toModelMessages to rewrite an id ONLY
// when it would otherwise violate the target's validation. This replaces the
// earlier "rewrite-to-strictest-subset universally" approach, which was
// lossless on the wire but model-lossy: rewriting an id like
// functions.foo:0 (Kimi's native AI-SDK fallback shape) to functions_foo_0
// puts Kimi out of distribution against its own training data and corrupts
// its next tool call.
//
// Envelope is a function of (provider, model), NOT just provider:
// Claude-on-Bedrock has the same strict charset validation as
// Claude-on-Anthropic-API, while Kimi/MiniMax/Nova/etc.-on-Bedrock get the
// looser Bedrock-Converse envelope. Driver call sites pick the envelope with
// the model id in hand and pass it through ToModelMessagesOptions.
export interface WireEnvelope {
	/** Stable tag for log/debug surfaces. */
	name: string;
	/** Regex matching characters NOT permitted in tool_use.id. Matched chars
	 * are replaced with "_" iff any are present. */
	idIllegalChars: RegExp;
	/** Regex matching characters NOT permitted in tool_use.name. Same
	 * rewrite-only-on-violation contract as idIllegalChars. */
	nameIllegalChars: RegExp;
	/** Hard cap on tool_use.id length. */
	idMaxLength: number;
	/** Hard cap on tool_use.name length. */
	nameMaxLength: number;
}

// Anthropic API + Claude-on-Bedrock: strict charset on both id and name.
export const ANTHROPIC_ENVELOPE: WireEnvelope = {
	name: "anthropic-strict",
	idIllegalChars: /[^a-zA-Z0-9_-]/g,
	nameIllegalChars: /[^a-zA-Z0-9_-]/g,
	idMaxLength: MAX_TOOL_USE_ID_LENGTH,
	nameMaxLength: MAX_TOOL_USE_ID_LENGTH,
};

// Bedrock Converse for non-Anthropic models (Kimi, MiniMax, Nova, GLM, ...).
// toolUseId allows dot/colon to round-trip Kimi's native fallback id shape;
// toolUse.name is still strict; both capped at 64 chars.
export const BEDROCK_PERMISSIVE_ENVELOPE: WireEnvelope = {
	name: "bedrock-converse",
	idIllegalChars: /[^a-zA-Z0-9_.:-]/g,
	nameIllegalChars: /[^a-zA-Z0-9_-]/g,
	idMaxLength: MAX_TOOL_USE_ID_LENGTH,
	nameMaxLength: MAX_TOOL_USE_ID_LENGTH,
};

// OpenAI-compatible providers (Moonshot direct, Cerebras, Z.AI, ...) don't
// advertise an id-charset constraint and accept arbitrary tool_call.id
// strings. The (?!) regex never matches, so the rewrite branch never fires;
// only the length cap survives as a defensive backstop against runaway
// upstream leaks.
export const PERMISSIVE_ENVELOPE: WireEnvelope = {
	name: "permissive",
	idIllegalChars: /(?!)/g,
	nameIllegalChars: /(?!)/g,
	idMaxLength: 256,
	nameMaxLength: 256,
};

/**
 * Sanitize a tool_use id to the charset and length accepted by the target
 * envelope. Anthropic enforces `^[a-zA-Z0-9_-]+$` on tool_use.id and rejects
 * the request when an id contains anything else (notably `.` and `:`, which
 * appear in OpenAI-compatible fallback ids of the shape
 * `functions.<name>:<index>` synthesized when the upstream server emits no
 * explicit id). Bedrock Converse caps toolUseId at 64 chars and validates
 * `[a-zA-Z0-9_.:-]+`.
 *
 * The transform must be deterministic so the same input id sanitizes to the
 * same output everywhere it appears (assistant tool_use, tool_result.tool_use_id,
 * the toolNameById index keys). Empty ids are left as the empty string — the
 * caller's existing fallback behavior handles them.
 *
 * Two distinct original ids could in principle collide after sanitization
 * (e.g. `a.b` and `a:b` both → `a_b`, or two ids that diverge only past char 64).
 * The OpenAI-compatible fallback shape uses a per-turn monotonic index, so a
 * charset collision would already have been a pre-existing duplicate-id bug in
 * the originating turn. Length-truncation collisions are only reachable when
 * upstream emits pathologically long ids (template-token leakage in the
 * Kimi/Moonshot OpenAI-compatible path is the documented case); we don't try
 * to defend against either here — the streaming-boundary warn log surfaces the
 * pathology so operators can spot it instead.
 */
export function sanitizeToolUseId(id: string, envelope: WireEnvelope = ANTHROPIC_ENVELOPE): string {
	if (!id) return id;
	let out = id;
	if (envelope.idIllegalChars.test(out)) {
		// `test` advances lastIndex on /g regexes; reset before replace.
		envelope.idIllegalChars.lastIndex = 0;
		out = out.replace(envelope.idIllegalChars, "_");
	}
	envelope.idIllegalChars.lastIndex = 0;
	if (out.length > envelope.idMaxLength) out = out.slice(0, envelope.idMaxLength);
	return out;
}

// Envelope-aware sister of sanitizeToolUseId for tool names. Same
// rewrite-only-on-violation contract. Falls back to "unknown" if the result
// is empty.
export function sanitizeToolNameForEnvelope(
	name: string,
	envelope: WireEnvelope = ANTHROPIC_ENVELOPE,
): string {
	let out = name;
	if (envelope.nameIllegalChars.test(out)) {
		envelope.nameIllegalChars.lastIndex = 0;
		out = out.replace(envelope.nameIllegalChars, "_");
	}
	envelope.nameIllegalChars.lastIndex = 0;
	if (out.length > envelope.nameMaxLength) out = out.slice(0, envelope.nameMaxLength);
	return out || "unknown";
}

/**
 * Convert Bound's LLMMessage shape to AI SDK ModelMessage.
 *
 * Role mapping:
 *   user       → user
 *   assistant  → assistant
 *   system     → system
 *   developer  → merged into an adjacent user message, wrapped in a
 *                `<system-context>` tag. Developer messages are emitted
 *                interleaved with history (the agent loop appends one at the
 *                tail every turn), so promoting them to AI SDK `system`
 *                messages produces the "Multiple system messages separated by
 *                user/assistant" failure on Bedrock. Merge into the next user
 *                message when one follows, or append to the most recent user
 *                message when none does. Orphan developer messages (no user
 *                anywhere) are dropped — the resulting request would be
 *                unsendable otherwise.
 *   tool_call  → assistant { parts: [tool-call...] }
 *   tool_result → tool { parts: [tool-result...] }
 *   cache      → marker only — attached to the previous message via
 *                providerOptions.{cacheProvider}.cachePoint / cacheControl
 */
export function toModelMessages(
	messages: LLMMessage[],
	opts: ToModelMessagesOptions = {},
): ModelMessage[] {
	let result: ModelMessage[] = [];
	// Default to the strictest envelope so callers that pre-date envelope
	// awareness keep their historical universal-rewrite behavior.
	const envelope = opts.targetEnvelope ?? ANTHROPIC_ENVELOPE;

	// First pass: build a tool-call id → name index. Tool-result messages
	// need the toolName to satisfy ToolResultPart (provider-utils). Bedrock's
	// Converse path ignores it, but Anthropic direct and other providers wire
	// it through, and the schema requires it. Index everything up front so
	// out-of-order or interleaved messages still resolve correctly. Keys are
	// sanitized so that tool_result lookups (which look up by sanitized id)
	// still resolve when the original id contained illegal characters.
	const toolNameById = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role !== "assistant" && msg.role !== "tool_call") continue;
		const blocks = Array.isArray(msg.content) ? msg.content : normalizeBlocks(msg.content);
		for (const b of blocks) {
			if (b.type === "tool_use")
				toolNameById.set(
					sanitizeToolUseId(b.id, envelope),
					sanitizeToolNameForEnvelope(b.name, envelope),
				);
		}
	}

	// Developer content accumulated since the last user message. Flushed by
	// prepending into the next user message; any remainder is appended onto
	// the last emitted user message after the loop.
	const pendingDev: string[] = [];
	// Per-call budget tracker for OpenAI message-level breakpoints — see
	// MAX_OPENAI_MESSAGE_BREAKPOINTS.
	const openaiBreakpoints = { attached: 0 };
	// Whether the CURRENT pendingDev batch began accumulating while `result`
	// was still empty. This is the positional HEAD-vs-TAIL discriminator for
	// leftover dev content (see the leftover-pendingDev handler after the
	// loop). It is the genuine "this dev is the conversation kickoff" signal —
	// independent of whether a user message was ever emitted, which the old
	// `hasUser` check conflated and which truncation can strip from the window.
	let pendingDevStartedAtEmptyResult = false;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "developer") {
			const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
			if (text) {
				const previousProjected = result[result.length - 1];
				const interruptsToolBatch =
					previousProjected?.role === "assistant" &&
					Array.isArray(previousProjected.content) &&
					(previousProjected.content as Array<Record<string, unknown>>).some(
						(part) => part.type === "tool-call",
					);
				if (interruptsToolBatch) {
					result.push({ role: "user", content: wrapDev([text]) });
				} else if (opts.midConversationSystem) {
					const prev = result[result.length - 1];
					const nextRole = nextEmittedRoleAfter(messages, i);
					// Native system messages here are provider directives, not normal
					// conversational turns. The live provider contract is stricter
					// than the old Anthropic beta note: a contentful system message
					// must immediately precede an assistant message or end the array
					// (directive-only system blocks are the exception, but we do not
					// emit those here). If a developer message is really enrichment
					// for a following user/tool turn, keep the legacy user-merge path.
					if (prev?.role === "system") {
						appendTextToSystem(prev, text);
					} else if ((!prev || prev.role === "user") && (!nextRole || nextRole === "assistant")) {
						result.push({ role: "system", content: text });
					} else {
						if (pendingDev.length === 0) pendingDevStartedAtEmptyResult = result.length === 0;
						pendingDev.push(text);
					}
				} else {
					if (pendingDev.length === 0) pendingDevStartedAtEmptyResult = result.length === 0;
					pendingDev.push(text);
				}
			}
			continue;
		}

		if (msg.role === "cache") {
			// Attach a cache breakpoint to the most recently emitted message.
			const prev = result[result.length - 1];
			if (!prev || !opts.cacheProvider) continue;
			if (opts.cacheProvider === "openai") {
				// The Responses wire can't take a breakpoint on arbitrary
				// messages — delegate to the position-aware attacher.
				attachOpenAIPromptCacheBreakpoint(result, openaiBreakpoints);
				continue;
			}
			if (!prev.providerOptions) prev.providerOptions = {};
			const provOpts = prev.providerOptions as Record<string, Record<string, unknown>>;
			if (!provOpts[opts.cacheProvider]) provOpts[opts.cacheProvider] = {};
			const bucket = provOpts[opts.cacheProvider];
			if (opts.cacheProvider === "bedrock") {
				const cachePoint: Record<string, unknown> = { type: "default" };
				if (opts.cacheTtl) cachePoint.ttl = opts.cacheTtl;
				bucket.cachePoint = cachePoint;
			} else if (opts.cacheProvider === "anthropic") {
				const cacheControl: Record<string, unknown> = { type: "ephemeral" };
				if (opts.cacheTtl) cacheControl.ttl = opts.cacheTtl;
				bucket.cacheControl = cacheControl;
			}
			continue;
		}

		// Eager head-flush. If we accumulated developer content while `result`
		// was still empty (genuine conversation-kickoff content, e.g. a scheduler
		// wakeup) and we are now about to emit a non-developer, non-user message,
		// that head content is settled — emit it as the head user message NOW and
		// drop the head-content latch. Reason: pendingDev is only ever flushed by
		// a following USER message, but a long autonomous/delegated loop can be
		// truncated to a window containing NO user message at all (every user turn
		// scrolled out). In that window the latch (pendingDevStartedAtEmptyResult)
		// would otherwise stay true for the entire iteration, so TAIL developer
		// notifications arriving after the assistant/tool turns get lumped into the
		// same batch and the post-loop handler routes the whole thing to the HEAD —
		// leaving the conversation ending on the assistant message, which
		// Anthropic-strict / Bedrock reject with "This model does not support
		// assistant message prefill. The conversation must end with a user message."
		// Flushing here splits head-dev from tail-dev: tail notifications then start
		// a fresh batch (latch false, result non-empty) and correctly become the
		// trailing user. User messages are excluded — they merge pendingDev into
		// themselves below, which is the correct head-merge and must not be preempted
		// (preempting it would emit two consecutive user messages).
		if (pendingDev.length > 0 && pendingDevStartedAtEmptyResult && msg.role !== "user") {
			result.push({ role: "user", content: wrapDev(pendingDev) });
			pendingDev.length = 0;
			pendingDevStartedAtEmptyResult = false;
		}

		if (msg.role === "tool_call") {
			const blocks = normalizeBlocks(msg.content);
			const parts: Array<Record<string, unknown>> = [];
			for (const b of blocks) {
				if (b.type === "text" && b.text) {
					parts.push({ type: "text", text: b.text });
				} else if (b.type === "thinking") {
					const reasoningPart = buildReasoningPart(b, opts.reasoningProviderOptions);
					if (reasoningPart) parts.push(reasoningPart);
				} else if (b.type === "tool_use") {
					parts.push({
						type: "tool-call",
						toolCallId: sanitizeToolUseId(b.id, envelope),
						toolName: sanitizeToolNameForEnvelope(b.name, envelope),
						input: b.input,
					});
				}
			}
			result.push({ role: "assistant", content: parts as never });
			continue;
		}

		if (msg.role === "tool_result") {
			const blocks = normalizeBlocks(msg.content);
			const toolCallId = sanitizeToolUseId(msg.tool_use_id ?? "", envelope);
			const toolResultPart = {
				type: "tool-result" as const,
				toolCallId,
				// Resolved from the prior tool-call index; fall back to ""
				// if the tool_result arrives without a matching call (which
				// would be a caller bug but we don't want to throw here).
				toolName: toolNameById.get(toolCallId) ?? "",
				output: buildToolResultOutput(blocks, opts.resolveFileRef),
			};
			// Combine consecutive tool_results into a single `role: "tool"`
			// ModelMessage. Background: the AI SDK's
			// `convertToLanguageModelPrompt` (ai@6.0.168 dist/index.mjs:1342-
			// 1354) combines consecutive tool messages by appending the
			// second's content onto the first's content array — and silently
			// drops the second's `providerOptions`. The bridge's
			// `{role:"cache"}` handler attaches the cachePoint to
			// `result[result.length - 1]`, which for parallel tool_results
			// is the LAST tool message; AI SDK then collapses them and the
			// cachePoint metadata is lost. By combining tool_results here at
			// emit time, the bridge produces ONE tool ModelMessage per
			// consecutive run; the cachePoint attaches to that single
			// surviving message and reaches the wire intact.
			//
			// Live regression: an autonomous task with parallel tool calls
			// had cw=0 across 50+ cold turns. System anchor floor held at
			// 84,440 read; message-level cachePoint never reached the wire.
			// After this fix the cachePoint rides on the merged tool
			// message instead.
			const lastEmitted = result[result.length - 1];
			if (lastEmitted && lastEmitted.role === "tool" && Array.isArray(lastEmitted.content)) {
				(lastEmitted.content as unknown[]).push(toolResultPart);
			} else {
				result.push({
					role: "tool",
					content: [toolResultPart] as never,
				});
			}
			continue;
		}

		// user / assistant / system with content blocks
		const isUser = msg.role === "user";
		if (typeof msg.content === "string") {
			if (isUser && pendingDev.length > 0) {
				result.push({
					role: "user",
					content: `${wrapDev(pendingDev)}\n\n${msg.content}`,
				});
				pendingDev.length = 0;
			} else {
				result.push({
					role: msg.role as "user" | "assistant" | "system",
					content: msg.content,
				} as ModelMessage);
			}
			continue;
		}

		const parts: Array<Record<string, unknown>> = [];
		const isAssistant = msg.role === "assistant";
		for (const b of msg.content) {
			if (b.type === "text") {
				if (b.text) parts.push({ type: "text", text: b.text });
			} else if (b.type === "thinking") {
				const reasoningPart = buildReasoningPart(b, opts.reasoningProviderOptions);
				if (reasoningPart) parts.push(reasoningPart);
			} else if (b.type === "tool_use") {
				parts.push({
					type: "tool-call",
					toolCallId: sanitizeToolUseId(b.id, envelope),
					toolName: sanitizeToolNameForEnvelope(b.name, envelope),
					input: b.input,
				});
			} else if (b.type === "image") {
				// AssistantContent in @ai-sdk/provider-utils is
				//   string | Array<TextPart | FilePart | ReasoningPart
				//                   | ToolCallPart | ToolResultPart>
				// — it does NOT include ImagePart. UserContent does.
				//
				// On assistant messages, route through FilePart (which IS allowed)
				// so we faithfully preserve assistant-generated images rather than
				// reducing them to a text description.
				const imgPart = buildImageOrFilePart(b, {
					asFile: isAssistant,
					resolveFileRef: opts.resolveFileRef,
				});
				if (imgPart) {
					parts.push(imgPart);
				} else {
					// file_ref couldn't be resolved (no resolver, or file
					// missing). Emit a clear placeholder so the model is
					// informed an image was attempted — never silently drop.
					parts.push({ type: "text", text: imageUnavailablePlaceholder(b) });
				}
			} else if (b.type === "document") {
				const docPart = buildDocumentPart(b, opts.resolveFileRef);
				if (docPart) {
					parts.push(docPart);
				} else {
					// file_ref couldn't be resolved AND no text_representation
					// — emit a clear placeholder so the model is informed a
					// document was attempted, rather than silently dropping.
					parts.push({ type: "text", text: documentUnavailablePlaceholder(b) });
				}
			}
		}

		if (isUser && pendingDev.length > 0) {
			parts.unshift({ type: "text", text: wrapDev(pendingDev) });
			pendingDev.length = 0;
		}

		if (parts.length === 0) {
			// Tool-call-only assistant messages with no parts would be dropped
			// by the SDK; synthesize an empty text part to keep ordering stable.
			parts.push({ type: "text", text: "" });
		}

		result.push({
			role: msg.role as "user" | "assistant" | "system",
			content: parts as never,
		});
	}

	// Any developer content still pending here was not consumed by a
	// following user message. Two possible shapes:
	//
	//   (1) HEAD content — pendingDev began accumulating while `result` was
	//       still empty. The canonical case is the scheduler wakeup shape:
	//       [developer(wakeup), tool_call(retrieve_task), tool_result(payload)].
	//       Result has [assistant, tool] but no user. The dev IS the
	//       conversation kickoff; it should become a head user message.
	//
	//   (2) TAIL content — content was already emitted before pendingDev
	//       began accumulating, and pendingDev arrived after a complete turn.
	//       The canonical case is notification injection (introspect, notify,
	//       advisory) into a thread with prior history:
	//       [..., assistant, developer]. The dev IS the latest event the model
	//       needs to respond to; it should become a tail user message.
	//
	// Two rejected approaches, kept here so they aren't reinvented:
	//
	//   - Walking `result` end-to-front for ANY user message and merging
	//     pendingDev into it handles (1) but mishandles (2): tail dev content
	//     gets buried into an earlier user message, and the conversation still
	//     ends on an assistant message — which Anthropic strict mode rejects
	//     ("This model does not support assistant message prefill. The
	//     conversation must end with a user message.").
	//   - Discriminating HEAD vs TAIL by `result.some(user)` breaks once a long
	//     autonomous loop is truncated to a window of ONLY assistant/tool turns
	//     (every user message scrolled out of the kept window). A background-
	//     task notification then lands as a tail developer message with no
	//     user message anywhere in `result`, `hasUser` is false, and this rule
	//     wrongly takes the HEAD branch — `unshift`ing the dev as a head user
	//     and leaving the conversation still ending on assistant, the exact
	//     prefill rejection above, now on any sufficiently long thread.
	//
	// Correct rule: discriminate POSITIONALLY — was `result` empty when this
	// pendingDev batch began accumulating? That is the true "dev is the
	// conversation kickoff" signal, independent of whether a user message
	// survived the truncation window.
	if (pendingDev.length > 0) {
		if (pendingDevStartedAtEmptyResult) {
			// Head content: prepend as synthetic head user. Conversation-start
			// invariant (below) would otherwise prepend a "<system-notification />"
			// placeholder and lose the wakeup payload; doing it here preserves
			// the dev content as the actual kickoff message.
			result.unshift({ role: "user", content: wrapDev(pendingDev) });
		} else {
			const last = result[result.length - 1];
			if (last && last.role === "user") {
				// Trailing user already exists — append onto it (preserves
				// single-user-turn semantics; avoids emitting consecutive
				// same-role messages, which some adapters disallow).
				appendDevToUser(last, pendingDev);
			} else {
				// Tail content after assistant/tool: push as new trailing user.
				// This places the dev positionally correct (after the turn it
				// followed in history) AND ends the conversation with a user
				// role, satisfying the prefill constraint enforced by
				// Anthropic strict and several GLM endpoints.
				result.push({ role: "user", content: wrapDev(pendingDev) });
			}
		}
		pendingDev.length = 0;
	}

	// Read-boundary backstop: guarantee tool-call / tool-result pairing on the
	// wire (see helper for rationale). Runs before the conversation-start
	// invariant so that dropping a leading orphan tool_result still lets the
	// user-prepend below fire.
	result = enforceToolPairCompleteness(result);

	// Conversation-start invariant: most providers (Bedrock, Anthropic
	// direct, Mistral, …) reject requests whose first message isn't from the
	// user. Defense-in-depth for inputs that start with assistant/tool/system
	// even without developer content (e.g., post-restart retries where the
	// history begins mid-turn). The old hand-rolled toBedrockMessages carried
	// an equivalent guard; we preserve the "<system-notification />" shape
	// for continuity with any operator tooling that looks for it.
	if (
		result.length > 0 &&
		result[0].role !== "user" &&
		!(opts.midConversationSystem && result[0].role === "system")
	) {
		result.unshift({ role: "user", content: "<system-notification />" });
	}

	return result;
}

/**
 * Read-boundary backstop for tool-call / tool-result pairing.
 *
 * Bedrock-Anthropic and Anthropic-direct require tool results to follow the
 * assistant message that declared their calls immediately. Matching IDs later
 * in the conversation are still illegal. This projection repairs incomplete
 * batches without changing persisted history:
 *
 *   - results outside the declaring assistant's immediately following tool
 *     message are dropped;
 *   - missing results are replaced with interrupted-call stubs immediately
 *     after the declaring assistant;
 *   - well-formed assistant/tool pairs pass through unchanged.
 */
function enforceToolPairCompleteness(messages: ModelMessage[]): ModelMessage[] {
	const out: ModelMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!message) continue;

		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			if (message.role !== "tool") out.push(message);
			continue;
		}

		const calls = (message.content as Array<Record<string, unknown>>).filter(
			(part) => part.type === "tool-call",
		);
		out.push(message);
		if (calls.length === 0) continue;

		const callIds = new Set(calls.map((part) => part.toolCallId as string));
		const callNameById = new Map(
			calls.map((part) => [part.toolCallId as string, (part.toolName as string) ?? ""]),
		);
		const next = messages[index + 1];
		const legalResults =
			next?.role === "tool" && Array.isArray(next.content)
				? (next.content as Array<Record<string, unknown>>).filter(
						(part) => part.type === "tool-result" && callIds.has(part.toolCallId as string),
					)
				: [];
		const resultIds = new Set(legalResults.map((part) => part.toolCallId as string));
		const missingResults = calls
			.filter((part) => !resultIds.has(part.toolCallId as string))
			.map((part) => {
				const id = part.toolCallId as string;
				return {
					type: "tool-result" as const,
					toolCallId: id,
					toolName: callNameById.get(id) ?? "",
					output: {
						type: "text" as const,
						value: "[no tool result recorded: the call did not complete]",
					},
				};
			});

		out.push({
			...(next?.role === "tool" ? next : { role: "tool" as const }),
			content: [...legalResults, ...missingResults] as never,
		});
		if (next?.role === "tool") index++;
	}
	return out;
}

function nextEmittedRoleAfter(
	messages: LLMMessage[],
	index: number,
): "user" | "assistant" | "system" | "tool_call" | "tool_result" | null {
	for (let i = index + 1; i < messages.length; i++) {
		const role = messages[i]?.role;
		if (role && role !== "developer" && role !== "cache") return role;
	}
	return null;
}

function wrapDev(lines: string[]): string {
	return `<system-context>\n${lines.join("\n\n")}\n</system-context>`;
}

function appendTextToSystem(systemMsg: ModelMessage, text: string): void {
	if (typeof systemMsg.content === "string") {
		systemMsg.content = `${systemMsg.content}\n\n${text}`;
		return;
	}
	(systemMsg.content as Array<Record<string, unknown>>).push({ type: "text", text });
}

function appendDevToUser(userMsg: ModelMessage, devLines: string[]): void {
	const wrapped = wrapDev(devLines);
	if (typeof userMsg.content === "string") {
		userMsg.content = `${userMsg.content}\n\n${wrapped}`;
		return;
	}
	// Content-block user message: push as a trailing text part so we don't
	// have to merge with any final block's internals (image/file parts, etc.).
	(userMsg.content as Array<Record<string, unknown>>).push({ type: "text", text: wrapped });
}

function normalizeBlocks(content: string | ContentBlock[]): ContentBlock[] {
	if (Array.isArray(content)) return content;
	// DB serializes tool_call/tool_result content as JSON strings of blocks;
	// fall back to treating the string as a single text block if parse fails
	// or if the parsed array isn't actually content-block-shaped.
	//
	// The shape gate matters because tools (especially the connector tool) are
	// free to return arbitrary JSON arrays as their result string. Without the
	// gate, normalizeBlocks would happily return those arrays, the downstream
	// `b.type === "text"` filter in the tool_result handler would drop every
	// item, and the model would see an empty tool result. Treating opaque
	// JSON-array payloads as a single text block keeps the data intact.
	try {
		const parsed = JSON.parse(content);
		if (
			Array.isArray(parsed) &&
			parsed.length > 0 &&
			parsed.every(
				(b) => b && typeof b === "object" && typeof (b as { type?: unknown }).type === "string",
			)
		) {
			return parsed as ContentBlock[];
		}
	} catch {
		// Not JSON — treat as a single text block below.
	}
	return [{ type: "text", text: content }];
}

function extractText(blocks: ContentBlock[]): string {
	return blocks
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("");
}

/**
 * Build an AI SDK ReasoningPart from a thinking ContentBlock.
 *
 * Both signature and redacted_data live under providerOptions.bedrock
 * (Anthropic direct uses providerOptions.anthropic.signature; redacted data
 * is Bedrock-only in practice). The bedrock provider options schema accepts
 * both keys simultaneously, so we route them through a single bucket.
 *
 * `providerKey` gates the providerOptions emission. Non-Anthropic Bedrock
 * models (Kimi, MiniMax, GLM, Nova, …) reject `reasoningContent.reasoningText
 * .signature` and have no analogue for redacted_data; pass `null` for those
 * targets so the reasoning text replays without the unsupported metadata.
 */
function buildReasoningPart(
	b: Extract<ContentBlock, { type: "thinking" }>,
	providerKey: "bedrock" | "anthropic" | "openai" | null | undefined,
): Record<string, unknown> | null {
	// OpenAI Responses replays reasoning ONLY when it carries the provider's own
	// encrypted reasoning state (returned under store:false). A block with it
	// (native GPT-5.x on Mantle) replays the prior chain-of-thought, preserving
	// tool-call-justification continuity. A block without it — e.g. a prior
	// opus/Anthropic thinking block carrying only a signature, or a local model's
	// signature-less reasoning — is non-replayable: @ai-sdk/openai drops it under
	// store:false with "Non-OpenAI reasoning parts are not supported", one warning
	// per block (a flood in long cross-provider threads). Dropping it here is
	// equivalent to the provider's own behavior and silences the flood. The
	// inline text/tool_use in the same assistant message is unaffected.
	if (providerKey === "openai") {
		if (!b.reasoning_encrypted_content) return null;
		return {
			type: "reasoning" as const,
			text: b.thinking,
			providerOptions: {
				openai: { reasoningEncryptedContent: b.reasoning_encrypted_content },
			},
		};
	}
	// Cross-provider portability: a thinking block is only legal on the wire
	// for a signature-requiring target (Bedrock-Anthropic, Anthropic direct) if
	// it carries its cryptographic signature. A signature-less thinking block is
	// perfectly legal for the model that produced it — local, OpenAI-compatible,
	// and non-Anthropic Bedrock models (Kimi, MiniMax, GLM, Nova, …) emit
	// reasoning text with no signature. But when such a thread later routes to
	// opus / Bedrock-Anthropic, replaying that block triggers
	// `messages.N.content.M.thinking.signature: Field required` and the entire
	// turn fails. There is no signature to synthesize, so the only legal move is
	// to drop the block: Anthropic permits omitting thinking blocks from prior
	// assistant turns; it only rejects malformed ones. The inline text / tool_use
	// in the same assistant message is unaffected (the caller skips only the null
	// reasoning part). This mirrors the read-boundary `tool_use.id` sanitization
	// that lets a thread self-heal across a provider switch without DB surgery.
	//
	// A Bedrock redacted-reasoning block (redacted_data, no signature) IS legally
	// replayable via providerOptions.bedrock.redactedData, so it survives the drop.
	const requiresSignature = providerKey === "bedrock" || providerKey === "anthropic";
	if (requiresSignature && !b.signature) {
		const replayableRedacted = providerKey === "bedrock" && !!b.redacted_data;
		if (!replayableRedacted) return null;
	}
	const part: Record<string, unknown> = {
		type: "reasoning" as const,
		text: b.thinking,
	};
	if (!providerKey) return part;
	const bucket: Record<string, unknown> = {};
	if (b.signature) bucket.signature = b.signature;
	// redactedData is only meaningful under providerOptions.bedrock.
	if (b.redacted_data && providerKey === "bedrock") bucket.redactedData = b.redacted_data;
	if (Object.keys(bucket).length > 0) {
		part.providerOptions = { [providerKey]: bucket };
	}
	return part;
}

/**
 * Resolve an image block's source to {data, mediaType} when possible.
 *
 * Returns:
 *   - {data, mediaType} when the source is base64, OR when it's a file_ref
 *     and the resolver returns bytes.
 *   - null when the source is a file_ref the resolver couldn't fetch (or no
 *     resolver was provided) — caller emits a placeholder so the model is
 *     informed an image was attempted but unavailable.
 *
 * media_type fallback for file_refs: image blocks may carry a media_type
 * hint on the source itself (stamped at upload time, e.g. Discord
 * contentType). When absent we default to image/jpeg, mirroring
 * context-assembly.substituteUnsupportedBlocks's legacy fallback.
 */
function resolveImageSource(
	source: Extract<ContentBlock, { type: "image" }>["source"],
	resolveFileRef: ((fileId: string) => string | null) | undefined,
): { data: string; mediaType: string } | null {
	if (source.type === "base64") {
		return { data: source.data, mediaType: source.media_type };
	}
	if (source.type === "file_ref" && resolveFileRef) {
		const data = resolveFileRef(source.file_id);
		if (data) {
			return { data, mediaType: source.media_type ?? "image/jpeg" };
		}
	}
	return null;
}

function imageUnavailablePlaceholder(b: Extract<ContentBlock, { type: "image" }>): string {
	const fileId = b.source.type === "file_ref" ? b.source.file_id : "(inline)";
	const desc = b.description ? ` description=${JSON.stringify(b.description)}` : "";
	return `[Image unavailable: file_id=${fileId}${desc}]`;
}

/** Like {@link imageUnavailablePlaceholder} but for document blocks whose backing `file_ref` could not be resolved. */
function documentUnavailablePlaceholder(b: Extract<ContentBlock, { type: "document" }>): string {
	const fileId = b.source.type === "file_ref" ? b.source.file_id : "(inline)";
	const title = b.title ? ` title=${JSON.stringify(b.title)}` : "";
	const filename = b.filename ? ` filename=${JSON.stringify(b.filename)}` : "";
	return `[Document unavailable: file_id=${fileId}${title}${filename}]`;
}

/**
 * Build the AI SDK V2 ToolResultOutput for a tool_result message.
 *
 * The `LanguageModelV2ToolResultOutput` discriminated union supports two
 * shapes we care about here:
 *   - `{ type: "text", value: string }` — single text payload, the common
 *     case for shell/connector/database tools that return strings.
 *   - `{ type: "content", value: Array<{type:"text"} | {type:"media"}> }`
 *     — required to preserve images, which MCP tools (vision-enabled
 *     servers, Discord image fetches, etc.) routinely return alongside
 *     text. Without this shape, the model never sees the image.
 *
 * Strategy:
 *   - If every block is text → keep the simple `{type:"text"}` shape for
 *     back-compat with providers that may treat the two shapes differently.
 *   - If any block is non-text → emit `{type:"content"}` so images and
 *     other media survive the trip to the model.
 *
 * file_ref images and documents route through `resolveFileRef`
 * (defense-in-depth — by the time we reach here, context-assembly's
 * substituteUnsupportedBlocks has typically already resolved them, but we
 * re-resolve so test paths and any future bypass don't cause silent
 * drops). Unresolvable file_refs degrade to `text_representation` when
 * available (documents) or a clear `[… unavailable: …]` placeholder
 * rather than vanishing.
 *
 * Other non-text blocks (thinking, tool_use, nested tool_result) shouldn't
 * appear inside a tool_result by construction, so we serialize them as
 * JSON text to preserve the data without inventing a wire shape.
 */
function buildToolResultOutput(
	blocks: ContentBlock[],
	resolveFileRef?: (fileId: string) => string | null,
):
	| { type: "text"; value: string }
	| {
			type: "content";
			value: Array<
				{ type: "text"; text: string } | { type: "media"; data: string; mediaType: string }
			>;
	  } {
	const hasNonText = blocks.some((b) => b.type !== "text");
	if (!hasNonText) {
		return {
			type: "text",
			value: blocks
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join(""),
		};
	}

	const items: Array<
		{ type: "text"; text: string } | { type: "media"; data: string; mediaType: string }
	> = [];
	for (const b of blocks) {
		if (b.type === "text") {
			items.push({ type: "text", text: b.text });
		} else if (b.type === "image") {
			const resolved = resolveImageSource(b.source, resolveFileRef);
			if (resolved) {
				items.push({
					type: "media",
					data: resolved.data,
					mediaType: resolved.mediaType,
				});
			} else {
				items.push({ type: "text", text: imageUnavailablePlaceholder(b) });
			}
		} else if (b.type === "document") {
			// Documents in tool_result content (e.g. the MCP `resource` path
			// when the tool returns a binary blob persisted as a file_ref)
			// degrade through the same three-tier ladder as user-content
			// documents: base64 → media item, file_ref → resolve+media,
			// otherwise text_representation, otherwise placeholder.
			if (b.source.type === "base64") {
				items.push({
					type: "media",
					data: b.source.data,
					mediaType: b.source.media_type,
				});
			} else if (b.source.type === "file_ref" && resolveFileRef) {
				const data = resolveFileRef(b.source.file_id);
				if (data) {
					items.push({
						type: "media",
						data,
						mediaType: b.source.media_type ?? "application/octet-stream",
					});
				} else if (b.text_representation) {
					items.push({ type: "text", text: b.text_representation });
				} else {
					items.push({ type: "text", text: documentUnavailablePlaceholder(b) });
				}
			} else if (b.text_representation) {
				items.push({ type: "text", text: b.text_representation });
			} else {
				items.push({ type: "text", text: documentUnavailablePlaceholder(b) });
			}
		} else {
			// Defensive: anything else (thinking, tool_use, …) gets
			// JSON-serialized so the data isn't lost. These shouldn't appear
			// inside tool_result content by construction.
			items.push({ type: "text", text: JSON.stringify(b) });
		}
	}
	return { type: "content", value: items };
}

/**
 * Build either an ImagePart (UserContent) or a FilePart (AssistantContent)
 * from an image ContentBlock. AssistantContent in @ai-sdk/provider-utils
 * does not include ImagePart — if an assistant turn carries a generated
 * image, we must route it as FilePart with the image media type, which the
 * SDK accepts.
 *
 * file_ref sources resolve through `resolveFileRef`. When the resolver
 * isn't supplied (e.g., direct unit tests of the bridge) or returns null
 * (file deleted), the function returns null and the caller substitutes a
 * `[Image unavailable: …]` text part so the model is informed — never a
 * silent drop.
 */
function buildImageOrFilePart(
	b: Extract<ContentBlock, { type: "image" }>,
	opts: {
		asFile: boolean;
		resolveFileRef?: (fileId: string) => string | null;
	},
): Record<string, unknown> | null {
	const resolved = resolveImageSource(b.source, opts.resolveFileRef);
	if (!resolved) return null;
	const buf = Uint8Array.from(Buffer.from(resolved.data, "base64"));
	if (opts.asFile) {
		return {
			type: "file",
			data: buf,
			mediaType: resolved.mediaType,
			...(b.description && { filename: b.description }),
		};
	}
	return {
		type: "image",
		image: buf,
		mediaType: resolved.mediaType,
	};
}

/**
 * Resolve a document block to a renderable part.
 *
 * Returns:
 *   - a FilePart when the bytes are available (base64 inline OR file_ref
 *     successfully resolved). Bedrock accepts a wide file set via FilePart
 *     (application/pdf, text/plain, text/csv, application/json, text/markdown,
 *     text/html, docx, xlsx, etc.) — see @ai-sdk/amazon-bedrock's
 *     bedrockFilePartProviderOptions.
 *   - a text part when no bytes are available but a `text_representation` was
 *     provided up-front (text-degraded path, safest for non-document backends).
 *   - null when bytes are unavailable AND no text fallback exists; the caller
 *     emits a `[Document unavailable: …]` placeholder so the model is informed
 *     instead of silently dropping the block.
 *
 * media_type fallback for file_refs: documents may carry a `media_type`
 * hint on the source itself (set when the row was inserted by the MCP
 * resource path or by user upload). When absent we default to
 * application/octet-stream — providers may reject it but that's better
 * than guessing the wrong concrete type.
 */
function buildDocumentPart(
	b: Extract<ContentBlock, { type: "document" }>,
	resolveFileRef: ((fileId: string) => string | null) | undefined,
): Record<string, unknown> | null {
	if (b.source.type === "base64") {
		const buf = Uint8Array.from(Buffer.from(b.source.data, "base64"));
		return {
			type: "file",
			data: buf,
			mediaType: b.source.media_type,
			...(b.filename && { filename: b.filename }),
		};
	}
	if (b.source.type === "file_ref" && resolveFileRef) {
		const data = resolveFileRef(b.source.file_id);
		if (data) {
			const buf = Uint8Array.from(Buffer.from(data, "base64"));
			return {
				type: "file",
				data: buf,
				mediaType: b.source.media_type ?? "application/octet-stream",
				...(b.filename && { filename: b.filename }),
			};
		}
	}
	// file_ref couldn't be resolved (no resolver, or file missing). Prefer
	// the pre-extracted text representation when available — that's the
	// entire point of the field and keeps the path useful for backends
	// without native document support.
	if (b.text_representation) {
		return { type: "text", text: b.text_representation };
	}
	return null;
}
