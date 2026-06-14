import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Logger } from "@bound/shared";
import { streamText } from "ai";
import {
	ANTHROPIC_ENVELOPE,
	PERMISSIVE_ENVELOPE,
	mapChunks,
	mapError,
	toModelMessages,
	toToolSet,
} from "./ai-sdk-bridge";
import { createLoggingFetch } from "./fetch-logger";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "./types";

const DEFAULT_OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

export function deriveOpenCodeGoBaseUrl(override?: string): string {
	return override ?? DEFAULT_OPENCODE_GO_BASE_URL;
}

export function stripOpenCodeGoModelPrefix(modelId: string): string {
	return modelId.startsWith("opencode-go/") ? modelId.slice("opencode-go/".length) : modelId;
}

export function classifyOpenCodeGoProtocol(modelId: string): "openai-compatible" | "anthropic" {
	const normalized = stripOpenCodeGoModelPrefix(modelId).toLowerCase();
	if (normalized.startsWith("minimax-") || normalized.startsWith("qwen")) {
		return "anthropic";
	}
	return "openai-compatible";
}

/**
 * OpenCode Go driver.
 *
 * OpenCode Go exposes two protocol surfaces behind a single subscription key:
 * - `/chat/completions` with bearer auth for GLM / Kimi / DeepSeek / MiMo
 * - `/messages` with `x-api-key` auth for Qwen / MiniMax
 *
 * Bound's backend config is one model per backend, so the protocol can be
 * chosen deterministically from the configured model id. We still resolve it
 * per call so an explicit `params.model` override keeps working.
 */
export class OpenCodeGoDriver implements LLMBackend {
	private openaiProvider: ReturnType<typeof createOpenAICompatible>;
	private anthropicProvider: ReturnType<typeof createAnthropic>;
	private model: string;
	private contextWindow: number;

	constructor(config: {
		apiKey: string;
		model: string;
		contextWindow: number;
		baseUrl?: string;
		logger?: Logger;
		fetch?: typeof fetch;
		connectTimeoutMs?: number;
	}) {
		this.model = stripOpenCodeGoModelPrefix(config.model);
		this.contextWindow = config.contextWindow;
		const baseUrl = deriveOpenCodeGoBaseUrl(config.baseUrl);
		const customFetch =
			config.fetch ??
			(config.logger
				? createLoggingFetch(config.logger, "opencode-go", config.connectTimeoutMs)
				: undefined);

		this.openaiProvider = createOpenAICompatible({
			name: "opencode-go",
			baseURL: baseUrl,
			apiKey: config.apiKey,
			...(customFetch && { fetch: customFetch }),
		});
		this.anthropicProvider = createAnthropic({
			name: "opencode-go",
			baseURL: baseUrl,
			apiKey: config.apiKey,
			...(customFetch && { fetch: customFetch }),
		});
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		const modelId = stripOpenCodeGoModelPrefix(params.model || this.model);
		const protocol = classifyOpenCodeGoProtocol(modelId);
		const tools = toToolSet(params.tools);

		yield { type: "heartbeat" };

		if (protocol === "anthropic") {
			const messages = toModelMessages(params.messages, {
				cacheProvider: null,
				resolveFileRef: params.resolveFileRef,
				targetEnvelope: ANTHROPIC_ENVELOPE,
			});
			const result = streamText({
				model: this.anthropicProvider.messages(modelId),
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
					providerName: "opencode-go",
				});
			} catch (err) {
				throw mapError(err, "opencode-go");
			}
			return;
		}

		const messages = toModelMessages(params.messages, {
			cacheProvider: null,
			resolveFileRef: params.resolveFileRef,
			targetEnvelope: PERMISSIVE_ENVELOPE,
		});
		const result = streamText({
			model: this.openaiProvider.chatModel(modelId),
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
				providerName: "opencode-go",
			});
		} catch (err) {
			throw mapError(err, "opencode-go");
		}
	}

	capabilities(): BackendCapabilities {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			extended_thinking: false,
			max_context: this.contextWindow,
		};
	}
}
