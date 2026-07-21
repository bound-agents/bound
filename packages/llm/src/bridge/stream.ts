/**
 * Stream chunk conversion: AI SDK fullStream → Bound's StreamChunk shape.
 *
 * This is the inverse of the old per-driver streaming parsers. The AI SDK
 * normalizes SSE + Bedrock event-stream into a single shape; mapChunks
 * translates that shape back into our downstream StreamChunk type, and
 * extractUsage folds provider usage metadata into the terminal `done` chunk.
 */

import { createLogger } from "@bound/shared";
import type { LLMFinishReason, LLMMessage, StreamChunk } from "../types";
import { LLMError } from "../types";
import { MAX_TOOL_USE_ID_LENGTH } from "./messages";

const logger = createLogger("llm", "ai-sdk-bridge");

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
		 * adapters that haven't migrated to the structured shape). Verified
		 * live on `@ai-sdk/amazon-bedrock@4.0.96` + `ai@6.0.168`: a request
		 * with 11 noCache + 3506 cacheWrite tokens reports
		 * `inputTokens: 3517`.
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
	// Previously, estimation only kicked in when outputText.length > 0,
	// so tool-only and thinking-only responses (a cron turn that just
	// called retrieve_task with no text; a model that emitted only
	// thinking + tool calls) were recorded with tokens_in=tokens_out=0,
	// silently breaking per-host cost/usage accounting. We now
	// accumulate reasoning text and tool-input-delta bytes here so those
	// responses get a reasonable char-based estimate.
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
	// only the last step's metadata would drop the metric entirely.
	// Observed in production: a thread had 13/23 turns recording
	// tokens_cache_write = NULL because of this; summing recovers them.
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
				// AI SDK v7 surfaces per-step cache-write on the structured
				// `usage.inputTokenDetails.cacheWriteTokens` (provider-agnostic);
				// fall back to the v6 providerMetadata shape for adapters that
				// don't populate the structured field.
				const stepUsage = part.usage as FinishState["totalUsage"] | undefined;
				const meta = part.providerMetadata as ProviderMetadata | undefined;
				const stepCacheWrite =
					stepUsage?.inputTokenDetails?.cacheWriteTokens ??
					readStepCacheWriteTokens(meta, opts.usageProvider);
				if (stepCacheWrite != null) {
					cacheWriteAccum += stepCacheWrite;
					cacheWriteSeen = true;
				}
				break;
			}
			case "finish": {
				// A `finish` with finishReason "error" is a swallowed server
				// fault, not a clean completion. Mantle/OpenAI Responses emits a
				// mid-stream `response.failed` (e.g. 500 server_error) which the
				// @ai-sdk/openai adapter does NOT enqueue as an `error` part — it
				// sets finishReason="error" and ends the stream as a normal
				// `finish` with null usage. Without this guard mapChunks would
				// estimate usage and emit a clean `done`, hiding the crash: a
				// late fault looks like a short answer, and an early fault (large
				// context) estimates output_tokens=0, which withEmptyRetry then
				// mistakes for the store:false empty-completion case and hammers
				// the identical request with no backoff. Throw a 5xx so mapError
				// → ModelRouter 5xx backoff/failover handles it instead. Verified
				// live 2026-06-08 against gpt-5.5 (response.failed server_error).
				if (part.finishReason === "error") {
					throw new LLMError(
						`${opts.providerName ?? "ai-sdk"} response failed (finishReason=error): server fault mid-stream`,
						opts.providerName ?? "ai-sdk",
						500,
					);
				}
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
					// Surface the terminal stopReason so the agent loop can
					// distinguish a clean stop from a safety stop. Bedrock has no
					// `refusal` stopReason: safety stops arrive as `content_filtered`,
					// which the AI SDK maps to `content-filter`. The "error" case is
					// already thrown above, so it never reaches here.
					finish_reason: part.finishReason as LLMFinishReason,
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
			// start, text-end, reasoning-start, tool-call, tool-result,
			// response-metadata, start-step, raw, source, file, abort —
			// intentionally ignored. Our downstream StreamChunk doesn't model
			// them. text-start/end and reasoning-start/end are block-boundary
			// markers we don't need (deltas carry the id); tool-call is redundant
			// after tool-input-end; file/source are upstream surfaces we don't
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
	// AI SDK v7 moved cache-read onto the structured `inputTokenDetails.
	// cacheReadTokens`; the flat `cachedInputTokens` is the v6 fallback.
	const cacheReadTokens = u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? null;
	// Cache-write tokens are summed by the caller across all finish-step
	// events because the terminal `finish` carries no providerMetadata and
	// each step reports its own value (null on prefix-cache hits).
	const cacheWriteTokens = finish.cacheWriteTokens ?? null;

	// Zero-usage guard — widened to cover any observable output, not just
	// text. Responses that only emitted tool calls (a cron turn calling
	// retrieve_task with no text) or only thinking (a model that reasoned
	// extensively but produced no text before a tool call) were silently
	// recorded as tokens_in=tokens_out=0, breaking cost/usage accounting
	// per-host.
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
