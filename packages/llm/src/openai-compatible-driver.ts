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
import { mapChunks, mapError, toModelMessages, toToolSet } from "./ai-sdk-bridge";
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
	}) {
		this.model = config.model;
		this.contextWindow = config.contextWindow;
		this.providerName = config.providerName ?? "openai-compatible";
		this.provider = createOpenAICompatible({
			name: this.providerName,
			baseURL: config.baseUrl,
			apiKey: config.apiKey,
			...(config.logger && { fetch: createLoggingFetch(config.logger, this.providerName) }),
		});
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		// Use `||` not `??` — callers sometimes pass `model: ""` as a "use default"
		// sentinel (the old hand-rolled driver treated empty string as missing).
		// Without this, empty string flows through and the upstream server rejects
		// with 400 "Unknown model:".
		const modelId = params.model || this.model;
		// OpenAI-compatible endpoints don't have a cache-breakpoint marker —
		// drop cache-role messages silently via null cacheProvider.
		const messages = toModelMessages(params.messages, { cacheProvider: null });
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
