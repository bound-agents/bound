/**
 * Anthropic direct driver — thin shim onto `@ai-sdk/anthropic`.
 *
 * Restores a first-class `anthropic` backend over the Vercel AI SDK Anthropic
 * provider, so a holder of an Anthropic API key can run Claude without standing
 * up AWS Bedrock (issue #176). The `anthropic` provider was dropped from the
 * router in the 2026-04-25 AI SDK migration on the assumption Anthropic traffic
 * would route through Bedrock; this brings the direct path back.
 *
 * The cross-provider portability machinery in `ai-sdk-bridge.ts` is already
 * provider-agnostic and explicitly handles the `"anthropic"` target:
 *   - `tool_use` id/name sanitization keys off the wire envelope — the
 *     ANTHROPIC_ENVELOPE (the strict `[a-zA-Z0-9_-]{1,64}` charset) is the
 *     bridge default and the same one Claude-on-Bedrock uses.
 *   - `thinking`-signature replay routes through `providerOptions.anthropic
 *     .signature` (reasoningProviderOptions: "anthropic"); a signature-less
 *     thinking block inherited from a non-Anthropic leg is dropped on replay
 *     so the turn doesn't 400 on `thinking.signature: Field required`.
 *   - cache breakpoints route through `providerOptions.anthropic.cacheControl`
 *     (cacheProvider: "anthropic"), and cache-write usage is read from
 *     `providerMetadata.anthropic.cacheCreationInputTokens`
 *     (usageProvider: "anthropic").
 *
 * We keep ownership of the same things the Bedrock driver owns:
 *   - Message shape → ModelMessage conversion (ai-sdk-bridge.ts)
 *   - System-block cache anchoring (mirrors `buildBedrockSystemMessage`; the
 *     AI SDK normalizes a top-level `system: string` WITHOUT providerOptions,
 *     so a `cache_control` would never reach the wire — see below)
 *   - Stream chunk translation back to our StreamChunk type
 *   - Extended-thinking / effort config construction from ChatParams
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { AnthropicProvider } from "@ai-sdk/anthropic";
import type { Logger } from "@bound/shared";
import { streamText } from "ai";
import type { ModelMessage } from "ai";
import {
	ANTHROPIC_ENVELOPE,
	mapChunks,
	mapError,
	toModelMessages,
	toToolSet,
} from "./ai-sdk-bridge";
import { createLoggingFetch } from "./fetch-logger";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "./types";

/**
 * The `providerOptions.anthropic` reasoning payload. Mirrors the subset of
 * `AnthropicLanguageModelOptions` (in `@ai-sdk/anthropic`) that controls
 * extended thinking. `thinking` is a discriminated union matching the two
 * Anthropic API generations; `effort` is the top-level `output_config.effort`
 * depth lever (low | medium | high | xhigh | max) that replaces
 * `budget_tokens` on Opus 4.7.
 */
interface AnthropicReasoningOptions {
	thinking?:
		| { type: "enabled"; budgetTokens?: number }
		| { type: "adaptive"; display?: "omitted" | "summarized" };
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface BuildAnthropicSystemMessageParams {
	/** The system prompt text. When falsy/empty, no system block is produced. */
	system?: string;
	/**
	 * Whether to attach `providerOptions.anthropic.cacheControl` to the system
	 * block. Should mirror the agent-loop's caching decision for this turn.
	 */
	cacheEnabled: boolean;
	/** Optional TTL forwarded to `cacheControl.ttl`. */
	cacheTtl?: "5m" | "1h";
}

/**
 * Builds the Anthropic system message that opens the messages array.
 *
 * Returns `null` when `system` is empty/missing — the caller passes the
 * messages array unchanged in that case. Otherwise returns a `role: "system"`
 * `ModelMessage`; `providerOptions.anthropic.cacheControl` is present iff
 * `cacheEnabled` is true.
 *
 * Why a system MESSAGE and not `streamText({system: <string>})`: the AI SDK
 * normalizes the top-level `system` string into a system block WITHOUT
 * `providerOptions`, so a `cache_control` marker would never reach the wire and
 * the byte-stable system prefix would have no cache anchor — the exact failure
 * mode `buildBedrockSystemMessage` exists to avoid on the Bedrock path.
 * `@ai-sdk/anthropic`'s prompt converter reads `cacheControl` from a system
 * message's `providerOptions` (`convert-to-anthropic-prompt.ts`, the
 * `case "system"` branch), so routing the system block through the messages
 * array preserves the anchor.
 *
 * Pure: depends only on its arguments; byte-stable for the same inputs.
 */
export function buildAnthropicSystemMessage(
	params: BuildAnthropicSystemMessageParams,
): ModelMessage | null {
	if (!params.system) return null;
	const message: ModelMessage = {
		role: "system",
		content: params.system,
	};
	if (params.cacheEnabled) {
		const cacheControl: { type: "ephemeral"; ttl?: "5m" | "1h" } = { type: "ephemeral" };
		if (params.cacheTtl) cacheControl.ttl = params.cacheTtl;
		message.providerOptions = { anthropic: { cacheControl } };
	}
	return message;
}

/**
 * Detects whether any non-system message in the post-bridge `ModelMessage[]`
 * carries an Anthropic `cacheControl`. Used as a fallback caching-intent signal
 * for the system anchor when the caller didn't pass `cache_ttl`. Mirrors
 * `hasBedrockMessageCachePoint` for the `providerOptions.anthropic` bucket.
 *
 * Exported for unit-test use only.
 */
export function hasAnthropicMessageCacheControl(messages: ModelMessage[]): boolean {
	return messages.some((m) => {
		const opts = m.providerOptions as { anthropic?: { cacheControl?: unknown } } | undefined;
		return opts?.anthropic?.cacheControl !== undefined;
	});
}

export interface ShouldEnableAnthropicSystemCacheControlParams {
	/** From `ChatParams.cache_ttl`. Caller signals caching intent. */
	cacheTtl: "5m" | "1h" | undefined;
	/** Post-bridge messages — fallback signal for caching intent. */
	bridgeMessages: ModelMessage[];
}

/**
 * Decide whether the SYSTEM block should carry an Anthropic `cacheControl`.
 *
 * The SYSTEM anchor is INDEPENDENT of any message-level marker, matching the
 * contract `shouldEnableSystemCachePoint` established for Bedrock after the
 * cr=0 regression (a missing message-level marker silently disabled the system
 * anchor too, killing caching for the whole turn):
 *   - If the caller passed `cache_ttl`, they intend caching → enable.
 *   - Otherwise fall back to message-level marker presence (preserves behavior
 *     for callers that don't pass `cache_ttl`).
 *   - Otherwise disable.
 */
export function shouldEnableAnthropicSystemCacheControl(
	params: ShouldEnableAnthropicSystemCacheControlParams,
): boolean {
	if (params.cacheTtl !== undefined) return true;
	return hasAnthropicMessageCacheControl(params.bridgeMessages);
}

/**
 * Build the `providerOptions.anthropic` reasoning payload from ChatParams.
 *
 * Unlike Bedrock (which folds everything into `reasoningConfig`), the direct
 * Anthropic provider splits the controls: extended thinking goes under
 * `thinking` (a discriminated union), and depth goes under the top-level
 * `effort` knob. Returns undefined when neither `thinking` nor `effort` is set.
 *
 * Exported so the gating can be unit-tested without the AI SDK streaming stack.
 */
export function buildAnthropicReasoningOptions(
	params: ChatParams,
): AnthropicReasoningOptions | undefined {
	if (!params.thinking && !params.effort) return undefined;
	const opts: AnthropicReasoningOptions = {};
	if (params.thinking?.type === "enabled") {
		opts.thinking = { type: "enabled", budgetTokens: params.thinking.budget_tokens };
	} else if (params.thinking?.type === "adaptive") {
		opts.thinking = {
			type: "adaptive",
			...(params.thinking.display && { display: params.thinking.display }),
		};
	}
	if (params.effort) opts.effort = params.effort;
	return Object.keys(opts).length > 0 ? opts : undefined;
}

export class AnthropicDriver implements LLMBackend {
	private provider: AnthropicProvider;
	private model: string;
	private contextWindow: number;

	constructor(config: {
		apiKey: string;
		model: string;
		contextWindow: number;
		/**
		 * Optional base URL override (e.g. a proxy or gateway). Defaults to the
		 * Anthropic API (`https://api.anthropic.com/v1`) inside the SDK.
		 */
		baseUrl?: string;
		/**
		 * Optional logger for debug-level interception of outgoing AI SDK
		 * request bodies. When provided, raw request payloads are routed through
		 * pino at `LOG_LEVEL=debug`; otherwise the SDK's default fetch is used
		 * with zero overhead.
		 */
		logger?: Logger;
		/**
		 * Custom fetch for wire-body interception (harness/test only). When set,
		 * takes precedence over the logger-backed fetch. Production callers leave
		 * this unset and use `logger` instead. Mirrors the same field on the
		 * other drivers so `createBackendFromConfig` can thread a single fetch
		 * override through whichever provider the config picks.
		 */
		fetch?: typeof fetch;
		/**
		 * Per-backend connect / time-to-first-byte deadline (ms), forwarded to
		 * the logging fetch. When set, response headers must arrive within this
		 * window or the request is aborted with a self-identifying error. Only
		 * applies to the logger-backed fetch; an explicit `fetch` override is
		 * used verbatim. See `createLoggingFetch`.
		 */
		connectTimeoutMs?: number;
	}) {
		this.model = config.model;
		this.contextWindow = config.contextWindow;
		const customFetch =
			config.fetch ??
			(config.logger
				? createLoggingFetch(config.logger, "anthropic", config.connectTimeoutMs)
				: undefined);
		this.provider = createAnthropic({
			apiKey: config.apiKey,
			...(config.baseUrl && { baseURL: config.baseUrl }),
			...(customFetch && { fetch: customFetch }),
		});
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		// Use `||` not `??` — callers sometimes pass `model: ""` as a "use default"
		// sentinel (see the other drivers for the same note).
		const modelId = params.model || this.model;
		// Direct Anthropic is the canonical strict target: tool_use ids/names use
		// the ANTHROPIC_ENVELOPE charset, reasoning replays its signature via
		// providerOptions.anthropic, and cache breakpoints route through
		// providerOptions.anthropic.cacheControl. All three are bridge defaults.
		const bridgeMessages = toModelMessages(params.messages, {
			cacheProvider: "anthropic",
			cacheTtl: params.cache_ttl,
			resolveFileRef: params.resolveFileRef,
			reasoningProviderOptions: "anthropic",
			targetEnvelope: ANTHROPIC_ENVELOPE,
		});
		// Inject the system prompt as a `role: "system"` ModelMessage at index 0
		// so its `cache_control` survives AI SDK normalization. The top-level
		// `system: string` parameter would strip providerOptions and orphan the
		// cache anchor. See `buildAnthropicSystemMessage`.
		const systemMessage = buildAnthropicSystemMessage({
			system: params.system,
			cacheEnabled: shouldEnableAnthropicSystemCacheControl({
				cacheTtl: params.cache_ttl,
				bridgeMessages,
			}),
			cacheTtl: params.cache_ttl,
		});
		const messages = systemMessage ? [systemMessage, ...bridgeMessages] : bridgeMessages;
		const tools = toToolSet(params.tools, { emitStrictFlag: false });
		const reasoning = buildAnthropicReasoningOptions(params);

		// Emit heartbeat immediately. Extended thinking can produce a 60s+ gap
		// before the first content event, which would trip the relay silence
		// timeout. Matches the Bedrock driver's messageStart behavior.
		yield { type: "heartbeat" };

		const result = streamText({
			model: this.provider.languageModel(modelId),
			messages,
			...(tools && { tools }),
			...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
			// Anthropic disallows temperature when extended thinking / effort is
			// active; only set it when we're not asking for reasoning.
			...(params.temperature !== undefined &&
				!reasoning && { temperature: params.temperature }),
			abortSignal: params.signal,
			...(reasoning && {
				providerOptions: {
					anthropic: reasoning as Record<string, unknown> as never,
				},
			}),
		});

		try {
			yield* mapChunks(result.fullStream, {
				usageProvider: "anthropic",
				estimateInputFromMessages: params.messages,
				providerName: "anthropic",
			});
		} catch (err) {
			throw mapError(err, "anthropic");
		}
	}

	capabilities(): BackendCapabilities {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: true,
			extended_thinking: true,
			max_context: this.contextWindow,
		};
	}
}
