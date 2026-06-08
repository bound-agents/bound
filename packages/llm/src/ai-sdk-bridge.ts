/**
 * Shared conversion helpers between Bound's LLM shapes and the Vercel AI SDK.
 *
 * The driver layer used to be ~2400 lines of hand-rolled message assembly,
 * streaming parsers, and provider-specific quirk handling. It now lives here
 * plus two thin driver shims (bedrock-driver.ts, openai-compatible-driver.ts).
 *
 * Responsibilities:
 *   - toModelMessages: LLMMessage[] → ModelMessage[] (AI SDK input shape),
 *     including cache-marker flattening and tool_call/tool_result wrapping.
 *   - toToolSet: ToolDefinition[] → ToolSet (AI SDK tool shape) via
 *     jsonSchema() so we don't force a zod round-trip.
 *   - mapChunks: AI SDK fullStream → StreamChunk (our downstream shape).
 *   - mapError: unknown → LLMError with best-effort HTTP status extraction.
 *
 * Provider-specific behavior (cache control, reasoning config, etc.) is
 * injected by the caller via providerOptions — see the individual drivers.
 */

import { createLogger, formatError } from "@bound/shared";
import { tool as aiTool, jsonSchema } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import type { ContentBlock, LLMMessage, StreamChunk, ToolDefinition } from "./types";
import { LLMError } from "./types";

const logger = createLogger("llm", "ai-sdk-bridge");

// ─────────────────────────────────────────────────────────────────────────────
// Message conversion
// ─────────────────────────────────────────────────────────────────────────────

export interface ToModelMessagesOptions {
	/**
	 * Provider key used on the cache-marker passthrough. Bedrock expects
	 * `providerOptions.bedrock.cachePoint`, Anthropic expects
	 * `providerOptions.anthropic.cacheControl`. OpenAI-compatible providers
	 * generally don't support prompt caching via provider options, but the
	 * marker role is still dropped harmlessly here.
	 */
	cacheProvider?: "bedrock" | "anthropic" | null;
	/**
	 * Cache TTL hint forwarded to the cache breakpoint. "5m" or "1h".
	 * Omit (or undefined) to use the provider's default (5m). 1h is only
	 * supported on certain newer Claude models — see ChatParams.cache_ttl.
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
 * Sanitize a tool_use id / tool_use_id to the strictest charset and length
 * accepted by any supported provider. Anthropic enforces `^[a-zA-Z0-9_-]+$` on
 * tool_use.id and rejects the request when an id contains anything else
 * (notably `.` and `:`, which appear in OpenAI-compatible fallback ids of the
 * shape `functions.<name>:<index>` synthesized when the upstream server emits
 * no explicit id). Bedrock Converse caps toolUseId at 64 chars and validates
 * `[a-zA-Z0-9_.:-]+`. The strict subset accepted by every supported provider
 * is `[a-zA-Z0-9_-]{1,64}`, so rewriting to that envelope universally is
 * lossless on the wire and eliminates the need for per-provider branching.
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

// Envelope-aware sister of stream-utils.sanitizeToolName. Same
// rewrite-only-on-violation contract as sanitizeToolUseId. Falls back to
// "unknown" if the result is empty (matches legacy behavior).
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

export function toModelMessages(
	messages: LLMMessage[],
	opts: ToModelMessagesOptions = {},
): ModelMessage[] {
	const result: ModelMessage[] = [];
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
	// Whether the CURRENT pendingDev batch began accumulating while `result`
	// was still empty. This is the positional HEAD-vs-TAIL discriminator for
	// leftover dev content (see the leftover-pendingDev handler after the
	// loop). It is the genuine "this dev is the conversation kickoff" signal —
	// independent of whether a user message was ever emitted, which the old
	// `hasUser` check conflated and which truncation can strip from the window.
	let pendingDevStartedAtEmptyResult = false;

	for (const msg of messages) {
		if (msg.role === "developer") {
			const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
			if (text) {
				if (pendingDev.length === 0) pendingDevStartedAtEmptyResult = result.length === 0;
				pendingDev.push(text);
			}
			continue;
		}

		if (msg.role === "cache") {
			// Attach a cache breakpoint to the most recently emitted message.
			const prev = result[result.length - 1];
			if (!prev || !opts.cacheProvider) continue;
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
			// Live regression: thread `b4541575-...` 2026-05-26 had cw=0
			// across 50+ cold turns of an autonomous task with parallel
			// tool calls. System anchor floor held at 84,440 read; message-
			// level cachePoint never reached the wire. After this fix the
			// cachePoint rides on the merged tool message instead.
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
	// Bug fixed (2026-05-17, thread f096a101 / 98926e2d, introspect-into-
	// claude-opus): the old logic walked `result` from end to front looking
	// for ANY user message and merged pendingDev into it. That handled (1)
	// correctly but mishandled (2): tail dev content got buried into an
	// earlier user message, AND the conversation kept ending in the
	// assistant message — which Anthropic strict mode rejects with "This
	// model does not support assistant message prefill. The conversation
	// must end with a user message." Introspect injection was unusable on
	// those adapters until that fix.
	//
	// Bug fixed (2026-05-31, thread 60db514d, notify-into-truncated-opus-loop):
	// that 2026-05-17 fix discriminated HEAD vs TAIL by `result.some(user)`.
	// But a long autonomous loop can be truncated to a window of ONLY
	// assistant/tool turns — every user message scrolled out. A background-task
	// notification then lands as a tail developer message, `hasUser` is false,
	// and the old rule wrongly took the HEAD branch: it `unshift`ed the dev as
	// a head user, leaving the conversation STILL ending on the assistant
	// message → the same prefill rejection the 2026-05-17 fix was meant to
	// prevent, now firing on plain notify/introspect wakeups into any
	// sufficiently long thread.
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

	// Conversation-start invariant: most providers (Bedrock, Anthropic
	// direct, Mistral, …) reject requests whose first message isn't from the
	// user. Defense-in-depth for inputs that start with assistant/tool/system
	// even without developer content (e.g., post-restart retries where the
	// history begins mid-turn). The old hand-rolled toBedrockMessages carried
	// an equivalent guard; we preserve the "<system-notification />" shape
	// for continuity with any operator tooling that looks for it.
	if (result.length > 0 && result[0].role !== "user") {
		result.unshift({ role: "user", content: "<system-notification />" });
	}

	return result;
}

function wrapDev(lines: string[]): string {
	return `<system-context>\n${lines.join("\n\n")}\n</system-context>`;
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
		// fallthrough
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
 * Build an AI SDK FilePart from a document ContentBlock. Falls back to a
 * text part when only text_representation is available (non-vision/document
 * backends, or providers that don't support the document's media type).
 *
 * Bedrock accepts a wide file set via FilePart (application/pdf,
 * text/plain, text/csv, application/json, text/markdown, text/html, docx,
 * xlsx, etc.) — see @ai-sdk/amazon-bedrock's bedrockFilePartProviderOptions.
 * OpenAI-compatible providers vary; when in doubt, text_representation is
 * the safest wire format and the bridge caller (driver) can override.
 */
/**
 * Resolve a document block to a renderable part.
 *
 * Returns:
 *   - {kind: "file"} when the bytes are available (base64 inline OR file_ref
 *     successfully resolved). Bridges to AI SDK FilePart.
 *   - {kind: "text"} when no bytes are available but a `text_representation`
 *     was provided up-front (text-degraded path).
 *   - null when bytes are unavailable AND no text fallback exists; the
 *     caller emits a `[Document unavailable: …]` placeholder so the model
 *     is informed instead of silently dropping the block.
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

// ─────────────────────────────────────────────────────────────────────────────
// Tool conversion
// ─────────────────────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaIncludesType(schema: JsonObject, type: string): boolean {
	const schemaType = schema.type;
	if (schemaType === type) return true;
	return Array.isArray(schemaType) && schemaType.includes(type);
}

function hasObjectShape(schema: JsonObject): boolean {
	return schemaIncludesType(schema, "object") || isJsonObject(schema.properties);
}

function withNullableType(schema: JsonObject): JsonObject {
	const out = { ...schema };
	const schemaType = out.type;
	if (out.const !== undefined) {
		return { anyOf: [out, { type: "null" }] };
	}
	if (Array.isArray(out.enum)) {
		out.enum = out.enum.includes(null) ? [...out.enum] : [...out.enum, null];
	}
	if (Array.isArray(schemaType)) {
		out.type = schemaType.includes("null") ? [...schemaType] : [...schemaType, "null"];
	} else if (schemaType !== undefined && schemaType !== "null") {
		out.type = [schemaType, "null"];
	} else if (schemaType === undefined && !Array.isArray(out.enum)) {
		// Shape-only schemas (`anyOf`, `$ref`, etc.) can't be made nullable by
		// overwriting `type` without changing their meaning. Wrap instead.
		return { anyOf: [out, { type: "null" }] };
	}
	return out;
}

function hasDeliberatelyOpenObject(schema: unknown): boolean {
	if (!isJsonObject(schema)) return false;
	if (hasObjectShape(schema)) {
		// `additionalProperties: true` is used for intentional pass-through tools
		// (notably MCP server dispatch). A schema-valued additionalProperties is
		// also an open map; forcing it closed would change the tool contract.
		if (schema.additionalProperties === true || isJsonObject(schema.additionalProperties)) {
			return true;
		}
		if (isJsonObject(schema.patternProperties)) return true;
	}
	for (const value of Object.values(schema)) {
		if (Array.isArray(value)) {
			if (value.some((item) => hasDeliberatelyOpenObject(item))) return true;
		} else if (hasDeliberatelyOpenObject(value)) {
			return true;
		}
	}
	return false;
}

function strictifyJsonSchema(schema: unknown, optional = false): unknown {
	if (Array.isArray(schema)) return schema.map((item) => strictifyJsonSchema(item));
	if (!isJsonObject(schema)) return schema;

	let out: JsonObject = { ...schema };
	if (isJsonObject(out.properties) && hasObjectShape(out)) {
		const required = new Set(Array.isArray(out.required) ? out.required : []);
		const properties: JsonObject = {};
		for (const [key, value] of Object.entries(out.properties)) {
			properties[key] = strictifyJsonSchema(value, !required.has(key));
		}
		out.properties = properties;
		out.required = Object.keys(properties);
		out.additionalProperties = false;
	}
	if (Array.isArray(out.items)) {
		out.items = out.items.map((item) => strictifyJsonSchema(item));
	} else if (isJsonObject(out.items)) {
		out.items = strictifyJsonSchema(out.items);
	}
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		if (Array.isArray(out[key])) {
			out[key] = out[key].map((item) => strictifyJsonSchema(item));
		}
	}
	if (optional) out = withNullableType(out);
	return out;
}

function projectToolParameters(parameters: Record<string, unknown>): {
	schema: Record<string, unknown>;
	strict?: true;
} {
	if (hasDeliberatelyOpenObject(parameters)) return { schema: parameters };
	return { schema: strictifyJsonSchema(parameters) as Record<string, unknown>, strict: true };
}

export function toToolSet(tools?: ToolDefinition[]): ToolSet | undefined {
	if (!tools || tools.length === 0) return undefined;
	const result: ToolSet = {};
	for (const t of tools) {
		const { schema, strict } = projectToolParameters(t.function.parameters);
		result[t.function.name] = aiTool({
			description: t.function.description,
			inputSchema: jsonSchema(schema),
			...(strict && { strict }),
		});
	}
	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream chunk conversion
// ─────────────────────────────────────────────────────────────────────────────

export interface MapChunksOptions {
	/**
	 * Provider key for usage extraction. Bedrock puts cache-write tokens in
	 * providerMetadata.bedrock.usage.cacheWriteInputTokens; Anthropic puts
	 * them in providerMetadata.anthropic.cacheCreationInputTokens. The metadata
	 * arrives on `finish-step` events (NOT `finish`) — `finish` at the
	 * TextStreamPart layer only carries `finishReason + totalUsage`. We
	 * therefore track the last `finish-step`'s providerMetadata and apply it
	 * when `finish` fires.
	 */
	usageProvider?: "bedrock" | "anthropic" | null;
	/**
	 * Fallback char-based token estimator if the provider reports zero usage
	 * but we did observe output text. Preserves the legacy BedrockDriver
	 * zero-usage guard behavior.
	 */
	estimateInputFromMessages?: LLMMessage[];
	/**
	 * Provider tag attached to streaming-boundary warn logs. When the upstream
	 * emits a malformed tool_use (e.g. Kimi/Moonshot template-token leakage on
	 * the OpenAI-compatible path), the streaming-boundary sanitization warn log
	 * includes this tag so operators can identify which provider is leaking.
	 */
	providerName?: string;
	/**
	 * Coalesce prefix-extending message items down to the final item.
	 *
	 * Bedrock Mantle's GPT-5.x reasoning path (Responses API) streams the
	 * answer as a SEQUENCE of separate `message` output items — each its own
	 * text-start/text-end with a distinct id, interleaved with reasoning
	 * rounds — where each item RE-STATES the whole answer one (often multibyte)
	 * codepoint longer than the previous. The default `outputText += text`
	 * concatenates every draft, so a single reply lands in the DB duplicated
	 * N times (verified live 2026-06-07 against openai.gpt-5.5 at effort=high:
	 * a reply came back sixfold). The invariant the wire hands us: each item is
	 * a strict prefix-extension of the previous, monotonically growing, and the
	 * last item is the complete answer.
	 *
	 * With this flag, text-delta accumulates per item (reset on text-start) and
	 * yields only forward progress relative to what has already been emitted, so
	 * the streamed text converges to exactly the last (longest) item with no
	 * duplication — while STILL streaming incrementally for live display. A
	 * later item that is NOT a prefix-extension (divergence — not observed on
	 * Mantle, but defended against) degrades to append rather than dropping
	 * text. Other providers (single item, clean deltas) are a no-op: each delta
	 * extends the emitted text, so the suffix equals the delta. Scoped to the
	 * Mantle driver, which is the only caller that sets it.
	 */
	coalescePrefixItems?: boolean;
}

type ProviderMetadata = Record<string, Record<string, unknown>>;

interface FinishState {
	totalUsage?: {
		/**
		 * AI SDK v6's `inputTokens` is the SUMMED total prompt count
		 * (`noCache + cacheRead + cacheWrite`), NOT the non-cached portion.
		 * Verified live on `@ai-sdk/amazon-bedrock@4.0.96` + `ai@6.0.168`
		 * (2026-05-26 probe): a request with 11 noCache + 3506 cacheWrite
		 * tokens reports `inputTokens: 3517`. The actual non-cached scalar
		 * lives on `inputTokenDetails.noCacheTokens`. This bridge MUST read
		 * from `inputTokenDetails.noCacheTokens` (with `inputTokens` as a
		 * fallback when details are absent — covers older provider
		 * adapters that haven't migrated to the structured shape).
		 */
		inputTokens?: number;
		inputTokenDetails?: {
			noCacheTokens?: number;
			cacheReadTokens?: number;
			cacheWriteTokens?: number;
		};
		outputTokens?: number;
		cachedInputTokens?: number;
		reasoningTokens?: number;
		totalTokens?: number;
	};
	/**
	 * Sum of `cacheWriteInputTokens` (Bedrock) or `cacheCreationInputTokens`
	 * (Anthropic) across every finish-step in the turn. Null when no step
	 * reported a value. See readStepCacheWriteTokens.
	 */
	cacheWriteTokens?: number | null;
}

/**
 * Pull a step's cache-write tokens out of providerMetadata. Returns null if
 * the field isn't present or the provider isn't recognized — distinguishes
 * "no cache write on this step" (return 0) from "metric not reported"
 * (return null) so the caller can decide whether to record null vs 0.
 */
function readStepCacheWriteTokens(
	meta: ProviderMetadata | undefined,
	usageProvider: "bedrock" | "anthropic" | null | undefined,
): number | null {
	if (!meta) return null;
	if (usageProvider === "bedrock") {
		const bedrockUsage = meta.bedrock?.usage as { cacheWriteInputTokens?: number } | undefined;
		return bedrockUsage?.cacheWriteInputTokens ?? null;
	}
	if (usageProvider === "anthropic") {
		return (meta.anthropic?.cacheCreationInputTokens as number | undefined) ?? null;
	}
	return null;
}

/**
 * Consume an AI SDK fullStream and yield StreamChunk events.
 *
 * This is the inverse of the old per-driver streaming parsers. The AI SDK
 * normalizes SSE + Bedrock event-stream into a single shape; we translate
 * that shape back into our downstream StreamChunk type.
 *
 * Event shape reference (ai@5.0.179 TextStreamPart, ai/dist/index.d.ts:2213):
 *   - text-delta: { id, text, providerMetadata? }
 *   - reasoning-delta: { id, text, providerMetadata? }
 *       Bedrock emits signatures AND redacted data on this event with
 *       text:"" + providerMetadata.bedrock.{signature|redactedData}. See
 *       @ai-sdk/amazon-bedrock/dist/index.mjs lines 1239-1275.
 *   - tool-input-delta: { id, delta, providerMetadata? }
 *       (NB: `delta` not `text` — different from the text/reasoning deltas)
 *   - finish-step: { response, usage, finishReason, providerMetadata }
 *       Cache-write tokens live here under providerMetadata.bedrock.usage.
 *   - finish: { finishReason, totalUsage }  ← NO providerMetadata
 */
export async function* mapChunks(
	stream: AsyncIterable<unknown>,
	opts: MapChunksOptions = {},
): AsyncIterable<StreamChunk> {
	let outputText = "";
	// Widened "something happened" signal for the zero-usage estimator.
	// Pre-2026-04-26, estimation only kicked in when outputText.length > 0,
	// so tool-only and thinking-only responses (haiku cron turns that just
	// called retrieve_task; qwen3.6 threads that emitted only thinking
	// + tool calls) were recorded with tokens_in=tokens_out=0. We now
	// accumulate reasoning text and tool-input-delta bytes here so those
	// responses get a reasonable char-based estimate.
	// bound_issue:turns-table:observability-gap sub-gap 2b.
	let reasoningText = "";
	let toolInputText = "";
	// Track tool-input-start names since tool-input-delta only carries the id.
	const toolNameById = new Map<string, string>();
	// coalescePrefixItems state (Mantle GPT-5.x multi-message-item replay; see
	// MapChunksOptions.coalescePrefixItems). `currentItemText` accumulates the
	// active text item's bytes (reset on text-start); `emittedText` is the
	// cumulative text already yielded downstream. The invariant the Mantle wire
	// hands us is that each new item is a prefix-extension of the prior, so the
	// authoritative text is whichever item is longest — i.e. the last one.
	const coalescePrefixItems = opts.coalescePrefixItems === true;
	let currentItemText = "";
	let emittedText = "";
	// Sum cache-write tokens across all finish-step events. Multi-step turns
	// (tool-use rounds) emit one finish-step per step, each with that step's
	// cacheWriteInputTokens. The cache write typically lands on the FIRST
	// step (prompt prefix) and subsequent steps may report null/zero. Holding
	// only the last step's metadata would drop the metric entirely. Thread
	// c879be2b on 2026-05-24 had 13/23 turns recording tokens_cache_write =
	// NULL because of this; summing recovers them.
	let cacheWriteAccum = 0;
	let cacheWriteSeen = false;

	for await (const raw of stream) {
		const part = raw as { type: string } & Record<string, unknown>;
		switch (part.type) {
			case "text-start": {
				// Mantle multi-message-item replay: a new item supersedes the
				// previous (each is a prefix-extension). Reset the per-item
				// accumulator so the prefix-diff below measures THIS item against
				// what's already been emitted. No-op for the default path.
				if (coalescePrefixItems) currentItemText = "";
				break;
			}
			case "text-delta": {
				const text = (part.text as string | undefined) ?? "";
				if (!text) break;
				if (coalescePrefixItems) {
					currentItemText += text;
					if (
						currentItemText.length <= emittedText.length &&
						emittedText.startsWith(currentItemText)
					) {
						// This item re-states a prefix of what we've already
						// emitted; nothing new to yield yet.
						break;
					}
					if (currentItemText.startsWith(emittedText)) {
						// Prefix-extension (the Mantle invariant): emit only the
						// forward progress beyond what's already gone out.
						const suffix = currentItemText.slice(emittedText.length);
						emittedText = currentItemText;
						outputText = emittedText;
						yield { type: "text", content: suffix };
					} else {
						// Divergence — not observed on Mantle, but defended
						// against: degrade to append rather than drop text.
						emittedText += text;
						outputText = emittedText;
						yield { type: "text", content: text };
					}
					break;
				}
				outputText += text;
				yield { type: "text", content: text };
				break;
			}
			case "reasoning-delta": {
				const text = (part.text as string | undefined) ?? "";
				const meta = part.providerMetadata as ProviderMetadata | undefined;
				if (text) {
					reasoningText += text;
					yield { type: "thinking", content: text };
				}
				// Signatures and redacted data arrive on reasoning-delta with
				// empty text. Bedrock puts signature under
				// providerMetadata.bedrock.signature and redacted reasoning
				// under providerMetadata.bedrock.redactedData. Anthropic direct
				// uses providerMetadata.anthropic.signature. Both are emitted as
				// dedicated fields on the thinking chunk — downstream stitches
				// them onto the assembled ContentBlock without string-prefix
				// demuxing.
				const sig =
					(meta?.bedrock?.signature as string | undefined) ??
					(meta?.anthropic?.signature as string | undefined);
				if (sig) yield { type: "thinking", content: "", signature: sig };
				const redacted = meta?.bedrock?.redactedData as string | undefined;
				if (redacted) {
					yield { type: "thinking", content: "", redacted_data: redacted };
				}
				break;
			}
			case "tool-input-start": {
				const id = (part.id as string | undefined) ?? "";
				const name = (part.toolName as string | undefined) ?? "";
				// Stream-boundary handling is pass-through: ids/names land in
				// the persistence layer raw. Envelope-aware rewriting happens
				// at the read boundary in toModelMessages, where the
				// (provider, model) envelope is known. This preserves Kimi's
				// native fallback id shape (functions.<name>:<index>) for
				// kimi-on-bedrock roundtrips, while still rewriting on
				// cross-provider switches that violate the target envelope.
				//
				// Length-anomaly warn = upstream pathology (the documented
				// case is Kimi/Moonshot leaking its tool_call_argument_begin
				// template token on the OpenAI-compatible path, producing
				// 200+ char ids/names). We warn but do not enforce here —
				// toModelMessages length-bounds at read time per the target
				// envelope. Charset diffs are expected steady state and not
				// logged.
				if (id.length > MAX_TOOL_USE_ID_LENGTH || name.length > MAX_TOOL_USE_ID_LENGTH) {
					logger.warn("oversized tool_use streamed; will be truncated at read boundary", {
						provider: opts.providerName,
						id,
						name,
						idLength: id.length,
						nameLength: name.length,
					});
				}
				toolNameById.set(id, name);
				// Count the tool name towards output size so a plain
				// tool call without args still gets estimated.
				toolInputText += name;
				yield { type: "tool_use_start", id, name };
				break;
			}
			case "tool-input-delta": {
				const id = (part.id as string | undefined) ?? "";
				const delta = (part.delta as string | undefined) ?? "";
				toolInputText += delta;
				yield { type: "tool_use_args", id, partial_json: delta };
				break;
			}
			case "tool-input-end": {
				const id = (part.id as string | undefined) ?? "";
				yield { type: "tool_use_end", id };
				toolNameById.delete(id);
				break;
			}
			case "finish-step": {
				// Per-step cache-write metadata. Sum across steps because the
				// terminal `finish` event carries no providerMetadata, and a
				// single step's value may be null/zero on prefix-cache hits.
				const meta = part.providerMetadata as ProviderMetadata | undefined;
				const stepCacheWrite = readStepCacheWriteTokens(meta, opts.usageProvider);
				if (stepCacheWrite !== null) {
					cacheWriteAccum += stepCacheWrite;
					cacheWriteSeen = true;
				}
				break;
			}
			case "finish": {
				const totalUsage = part.totalUsage as FinishState["totalUsage"];
				yield {
					type: "done",
					usage: extractUsage(
						{
							totalUsage,
							cacheWriteTokens: cacheWriteSeen ? cacheWriteAccum : null,
						},
						{ text: outputText, reasoning: reasoningText, toolInput: toolInputText },
						opts,
					),
				};
				break;
			}
			case "error": {
				// AI SDK converts initial request failures (e.g. Bedrock 403
				// AccessDeniedException on converse-stream, 400 invalid-model) into
				// `{ type: "error", error }` events on fullStream — the iterator
				// does NOT reject. Throwing here lets the driver's existing
				// try/catch wrap the thrown value via mapError and the agent-loop
				// catch then flows to the non-retryable alert path, so operators
				// see the failure in logs + as a role:"alert" DB message instead
				// of watching a task quietly complete with zero output tokens.
				const err = part.error;
				const message = err instanceof Error ? err.message : String(err);
				throw err instanceof LLMError
					? err
					: new LLMError(message, "ai-sdk", undefined, err instanceof Error ? err : undefined);
			}
			case "reasoning-end": {
				// OpenAI Responses (GPT-5.x on Mantle) surfaces encrypted reasoning
				// state here, NOT on reasoning-delta — and under high effort a turn
				// can stream zero reasoning-deltas (no visible summary text) while
				// still carrying the encrypted blob. Capturing it here, on the
				// terminal marker for the reasoning item, is the only place it
				// appears. Emitted as a dedicated empty-text thinking chunk so
				// downstream stitches it onto the assembled block (same pattern as
				// signature/redacted). Last reasoning item wins, matching the
				// single-merged-block assembly in agent-loop.
				const meta = part.providerMetadata as ProviderMetadata | undefined;
				const enc = meta?.openai?.reasoningEncryptedContent as string | undefined;
				if (enc) {
					yield { type: "thinking", content: "", reasoning_encrypted_content: enc };
				}
				break;
			}
			// start, text-start, text-end, reasoning-start, tool-call,
			// tool-call, tool-result, response-metadata, start-step, raw,
			// source, file, abort — intentionally ignored. Our downstream
			// StreamChunk doesn't model them. text-start/end and
			// reasoning-start/end are block-boundary markers we don't need
			// (deltas carry the id); tool-call is redundant after
			// tool-input-end; file/source are upstream surfaces we don't
			// currently consume.
			default:
				break;
		}
	}
}

interface DoneUsage {
	input_tokens: number;
	output_tokens: number;
	cache_write_tokens: number | null;
	cache_read_tokens: number | null;
	estimated: boolean;
}

interface OutputWitness {
	text: string;
	reasoning: string;
	toolInput: string;
}

function extractUsage(
	finish: FinishState,
	output: OutputWitness,
	opts: MapChunksOptions,
): DoneUsage {
	const u = finish.totalUsage ?? {};
	// `inputTokens` in AI SDK v6 is the SUMMED total (`noCache + cacheRead +
	// cacheWrite`), not the non-cached portion. Use `inputTokenDetails.
	// noCacheTokens` when present so the recorded `input_tokens` matches the
	// non-cached scalar Bedrock and Anthropic actually charge at the full
	// input rate. Fall back to the summed `inputTokens` only when the
	// provider adapter doesn't expose the structured details (older or
	// non-cache-aware providers — they don't report cache_read/cache_write
	// either, so the fallback degrades gracefully).
	//
	// Live evidence (agent-harness production-shape, 2026-05-26): inf 13
	// reported `ti=86,734 cr=86,261 cw=44`. With the old read,
	// `calculateTurnCost` charged `86,734 × $3/M` for input — but only ~373
	// tokens were actually non-cached this turn. The cost was overstated by
	// ~$0.26/inf, and the diagnostic hit-rate denominator was poisoned with
	// the cached-portion bytes. Switching to `noCacheTokens` aligns the
	// recorded `input_tokens` with the wire reality (≈ 429 tokens for inf 13)
	// and makes downstream cost/hit-rate metrics honest.
	let inputTokens = u.inputTokenDetails?.noCacheTokens ?? u.inputTokens ?? 0;
	let outputTokens = u.outputTokens ?? 0;
	const cacheReadTokens = u.cachedInputTokens ?? null;
	// Cache-write tokens are summed by the caller across all finish-step
	// events because the terminal `finish` carries no providerMetadata and
	// each step reports its own value (null on prefix-cache hits).
	const cacheWriteTokens = finish.cacheWriteTokens ?? null;

	// Zero-usage guard — widened to cover any observable output, not just
	// text. Responses that only emitted tool calls (haiku cron turns that
	// called retrieve_task) or only thinking (qwen3.6 threads where the
	// model reasoned extensively but produced no text before a tool call)
	// were silently recorded as tokens_in=tokens_out=0, breaking cost/
	// usage accounting per-host. bound_issue:turns-table:observability-gap
	// sub-gap 2b.
	let estimated = false;
	const observableOutput = output.text + output.reasoning + output.toolInput;
	if (
		inputTokens === 0 &&
		outputTokens === 0 &&
		observableOutput.length > 0 &&
		opts.estimateInputFromMessages
	) {
		inputTokens = Math.ceil(
			opts.estimateInputFromMessages.reduce(
				(sum, m) =>
					sum +
					(typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length),
				0,
			) / 4,
		);
		outputTokens = Math.ceil(observableOutput.length / 4);
		estimated = true;
	}

	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		cache_write_tokens: cacheWriteTokens,
		cache_read_tokens: cacheReadTokens,
		estimated,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Error mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap an unknown error from the AI SDK into an LLMError with a best-effort
 * HTTP status code. The ModelRouter relies on statusCode to drive pool
 * backoff (402 / 429 / 5xx). AI SDK errors are tagged classes (APICallError,
 * etc.) — duck-type on .statusCode / .status since we don't want to import
 * every error class.
 */
export function mapError(err: unknown, provider: string): LLMError {
	if (err instanceof LLMError) return err;
	const e = err as
		| {
				statusCode?: number;
				status?: number;
				name?: string;
				message?: string;
				$metadata?: { httpStatusCode?: number };
				responseHeaders?: Record<string, string>;
		  }
		| null
		| undefined;
	const statusCode = e?.statusCode ?? e?.status ?? e?.$metadata?.httpStatusCode;
	const retryAfterHeader =
		e?.responseHeaders?.["retry-after"] ?? e?.responseHeaders?.["Retry-After"];
	const retryAfterMs = retryAfterHeader ? parseRetryAfter(retryAfterHeader) : undefined;
	return new LLMError(
		`${provider} request failed: ${formatError(err)}`,
		provider,
		statusCode,
		err instanceof Error ? err : new Error(String(err)),
		retryAfterMs,
	);
}

function parseRetryAfter(header: string): number | undefined {
	const n = Number(header);
	if (!Number.isNaN(n)) return n * 1000;
	const ts = Date.parse(header);
	if (!Number.isNaN(ts)) return Math.max(0, ts - Date.now());
	return undefined;
}
