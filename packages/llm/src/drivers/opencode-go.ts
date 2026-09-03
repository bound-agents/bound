import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Logger } from "@bound/shared";
import { streamText } from "ai";
import { ANTHROPIC_ENVELOPE, PERMISSIVE_ENVELOPE, toModelMessages, toToolSet } from "../bridge";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "../types";
import {
	EMPTY_COMPLETION_MAX_RETRIES,
	mapProviderStream,
	resolveProviderFetch,
	withEmptyRetry,
} from "./shared";

const DEFAULT_OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const PROVIDER_NAME = "opencode-go";
const BOUND_USER_AGENT = "bound";
export const MAX_OPENCODE_SESSION_ID_LENGTH = 256;

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
		const customFetch = resolveProviderFetch(PROVIDER_NAME, config);
		const providerFetch = (async (input, init) => {
			const headers = new Headers(init?.headers);
			headers.set("User-Agent", BOUND_USER_AGENT);
			return (customFetch ?? globalThis.fetch)(input, { ...init, headers });
		}) as typeof fetch;

		this.openaiProvider = createOpenAICompatible({
			name: PROVIDER_NAME,
			baseURL: baseUrl,
			apiKey: config.apiKey,
			fetch: providerFetch,
		});
		this.anthropicProvider = createAnthropic({
			name: PROVIDER_NAME,
			baseURL: baseUrl,
			apiKey: config.apiKey,
			fetch: providerFetch,
		});
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		if (!params.threadId || params.threadId.length > MAX_OPENCODE_SESSION_ID_LENGTH) {
			throw new Error(
				`OpenCode Go requests require a non-empty Bound threadId of at most ${MAX_OPENCODE_SESSION_ID_LENGTH} characters`,
			);
		}
		const modelId = stripOpenCodeGoModelPrefix(params.model || this.model);
		const protocol = classifyOpenCodeGoProtocol(modelId);
		const tools = toToolSet(params.tools);

		yield { type: "heartbeat" };

		if (protocol === "anthropic") {
			const messages = toModelMessages(params.messages, {
				cacheProvider: null,
				resolveFileRef: params.resolveFileRef,
				targetEnvelope: ANTHROPIC_ENVELOPE,
				// The /messages surface is Anthropic-protocol: prior-turn thinking
				// blocks are only legal on the wire with their signature. MiniMax/Qwen
				// emit signature-less reasoning, so without this they replay as bare
				// text and accumulate unboundedly across the thread (see the
				// `thinking`-signature gotcha in CONTRIBUTING). "anthropic" drops them.
				reasoningProviderOptions: "anthropic",
				midConversationSystem: true,
			});
			yield* withEmptyRetry(
				() =>
					mapProviderStream({
						providerName: PROVIDER_NAME,
						stream: () =>
							streamText({
								model: this.anthropicProvider.messages(modelId),
								messages,
								allowSystemInMessages: true,
								...(params.system && { system: params.system }),
								...(tools && { tools }),
								...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
								...(params.temperature !== undefined && { temperature: params.temperature }),
								headers: {
									"User-Agent": BOUND_USER_AGENT,
									"x-opencode-session": params.threadId,
								},
								abortSignal: params.signal,
							}).fullStream,
						map: { estimateInputFromMessages: params.messages },
					}),
				{
					maxRetries: EMPTY_COMPLETION_MAX_RETRIES,
					isAborted: () => params.signal?.aborted ?? false,
					providerName: PROVIDER_NAME,
					modelId,
				},
			);
			return;
		}

		const messages = toModelMessages(params.messages, {
			cacheProvider: null,
			resolveFileRef: params.resolveFileRef,
			targetEnvelope: PERMISSIVE_ENVELOPE,
			// /chat/completions does not accept replayed assistant reasoning as
			// input. Without a providerKey, buildReasoningPart replays every prior
			// thinking block as bare text, so a long session accumulates hundreds of
			// thousands of tokens of stale chain-of-thought. "openai" drops reasoning
			// that lacks encrypted continuation state, matching the mantle driver.
			reasoningProviderOptions: "openai",
			midConversationSystem: true,
		});
		yield* withEmptyRetry(
			() =>
				mapProviderStream({
					providerName: PROVIDER_NAME,
					stream: () =>
						streamText({
							model: this.openaiProvider.chatModel(modelId),
							messages,
							allowSystemInMessages: true,
							...(params.system && { system: params.system }),
							...(tools && { tools }),
							...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
							...(params.temperature !== undefined && { temperature: params.temperature }),
							headers: {
								"User-Agent": BOUND_USER_AGENT,
								"x-opencode-session": params.threadId,
							},
							abortSignal: params.signal,
						}).fullStream,
					map: { estimateInputFromMessages: params.messages },
				}),
			{
				maxRetries: EMPTY_COMPLETION_MAX_RETRIES,
				isAborted: () => params.signal?.aborted ?? false,
				providerName: PROVIDER_NAME,
				modelId,
			},
		);
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
