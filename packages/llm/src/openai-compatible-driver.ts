/**
 * OpenAI-compatible driver — thin shim onto `@ai-sdk/openai-compatible`.
 *
 * Replaced the hand-rolled /v1/chat/completions client (openai-driver.ts,
 * ~500 lines) on 2026-04-25. The AI SDK handles:
 *   - SSE streaming + `[DONE]` sentinel
 *   - Tool call assembly from delta fragments (no more `tooluse_` / `call_`
 *     prefix parse mismatches — tool IDs are opaque at the V2 boundary)
 *   - Developer-role passthrough where upstream supports it
 *   - Retry and error shape normalization
 *
 * Used for: qwen-3.6 (primary post-rip-and-replace), cerebras, z.ai, any
 * other OpenAI-compatible endpoint. The provider name is included in the
 * `createOpenAICompatible` call so headers and telemetry carry the right tag.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Logger } from "@bound/shared";
import { streamText } from "ai";
import {
	PERMISSIVE_ENVELOPE,
	mapChunks,
	mapError,
	toModelMessages,
	toToolSet,
} from "./ai-sdk-bridge";
import { createLoggingFetch } from "./fetch-logger";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "./types";

export class OpenAICompatibleDriver implements LLMBackend {
	private provider: ReturnType<typeof createOpenAICompatible>;
	private model: string;
	private contextWindow: number;
	private providerName: string;

	constructor(config: {
		baseUrl: string;
		apiKey: string;
		model: string;
		contextWindow: number;
		/** Optional provider tag used in error messages and telemetry. */
		providerName?: string;
		/**
		 * Optional logger for debug-level interception of outgoing AI SDK
		 * request bodies. When provided, raw request payloads are routed
		 * through pino at `LOG_LEVEL=debug`; otherwise the SDK's default
		 * fetch is used with zero overhead.
		 */
		logger?: Logger;
		/**
		 * Custom fetch for wire-body interception (harness/test only). When
		 * set, takes precedence over the logger-backed fetch. Production
		 * callers leave this unset and use `logger` instead. Mirrors the same
		 * field on `BedrockDriver` so `createBackendFromConfig` can thread a
		 * single fetch override through whichever provider the config picks.
		 */
		fetch?: typeof fetch;
		/**
		 * Per-backend connect / time-to-first-byte deadline (ms), forwarded to
		 * the logging fetch. When set, response headers must arrive within this
		 * window or the request is aborted with a self-identifying error. Only
		 * applies to the logger-backed fetch; an explicit `fetch` override
		 * (harness/test) is used verbatim. See `createLoggingFetch`.
		 */
		connectTimeoutMs?: number;
	}) {
		this.model = config.model;
		this.contextWindow = config.contextWindow;
		this.providerName = config.providerName ?? "openai-compatible";
		const customFetch =
			config.fetch ??
			(config.logger
				? createLoggingFetch(config.logger, this.providerName, config.connectTimeoutMs)
				: undefined);
		this.provider = createOpenAICompatible({
			name: this.providerName,
			baseURL: config.baseUrl,
			apiKey: config.apiKey,
			...(customFetch && { fetch: customFetch }),
		});
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		// Use `||` not `??` — callers sometimes pass `model: ""` as a "use default"
		// sentinel (the old hand-rolled driver treated empty string as missing).
		// Without this, empty string flows through and the upstream server rejects
		// with 400 "Unknown model:".
		const modelId = params.model || this.model;
		// OpenAI-compatible endpoints don't have a cache-breakpoint marker —
		// drop cache-role messages silently via null cacheProvider. They also
		// don't advertise a tool_call.id charset constraint, so use the
		// permissive envelope: ids/names round-trip raw, only the length cap
		// fires as a backstop against runaway upstream leaks (Kimi/Moonshot
		// template-token leakage in particular).
		const messages = toModelMessages(params.messages, {
			cacheProvider: null,
			resolveFileRef: params.resolveFileRef,
			targetEnvelope: PERMISSIVE_ENVELOPE,
			// This driver speaks /chat/completions (`.chatModel()` below), which
			// does not accept replayed assistant reasoning as input. Without a
			// providerKey, buildReasoningPart replays every prior thinking block as
			// bare text, so a long session — especially one that ran a reasoning
			// model like Kimi K2.7, or inherited thinking blocks from a prior
			// Anthropic/Bedrock turn — accumulates hundreds of thousands of tokens
			// of stale chain-of-thought. "openai" drops reasoning that lacks
			// encrypted continuation state, matching the mantle and opencode-go
			// openai-compatible legs.
			reasoningProviderOptions: "openai",
		});
		const tools = toToolSet(params.tools);

		yield { type: "heartbeat" };

		const result = streamText({
			model: this.provider.chatModel(modelId),
			messages,
			...(params.system && { system: params.system }),
			...(tools && { tools }),
			...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
			...(params.temperature !== undefined && { temperature: params.temperature }),
			abortSignal: params.signal,
		});

		try {
			yield* mapChunks(result.fullStream, {
				estimateInputFromMessages: params.messages,
				providerName: this.providerName,
			});
		} catch (err) {
			throw mapError(err, this.providerName);
		}
	}

	capabilities(): BackendCapabilities {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			// Most OpenAI-compatible providers don't expose prompt caching via
			// standard API surface. Override at the ModelRouter config layer if
			// a specific backend does (e.g. DeepSeek context-hash caching).
			prompt_caching: false,
			vision: true,
			extended_thinking: false,
			max_context: this.contextWindow,
		};
	}
}
