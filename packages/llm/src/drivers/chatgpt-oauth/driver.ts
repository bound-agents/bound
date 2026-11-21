import { createOpenAI } from "@ai-sdk/openai";
import type { Logger } from "@bound/shared";
import { context } from "@opentelemetry/api";
import { streamText } from "ai";
import { PERMISSIVE_ENVELOPE, toModelMessages, toToolSet } from "../../bridge";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "../../types";
import {
	EMPTY_COMPLETION_MAX_RETRIES,
	bindAsyncIterable,
	buildReasoningOrigin,
	mapProviderStream,
	resolveProviderFetch,
	withEmptyRetry,
	withEncryptedReasoningRetry,
} from "../shared";
import { CHATGPT_BACKEND_BASE_URL } from "./auth-core";
import type { TokenManager } from "./token-store";

export const PROVIDER_NAME = "chatgpt-oauth";

/**
 * Decorates every Responses request with the current OAuth access token and
 * account identity. The token manager refreshes (and persists rotation) before
 * this wrapper sends an expired token.
 */
export function createChatGptOAuthFetch(config: {
	tokenManager: Pick<TokenManager, "getAccessToken">;
	baseFetch?: typeof fetch;
}): typeof fetch {
	const baseFetch = config.baseFetch ?? fetch;
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const { accessToken, accountId } = await config.tokenManager.getAccessToken();
		request.headers.set("Authorization", `Bearer ${accessToken}`);
		request.headers.set("chatgpt-account-id", accountId);
		request.headers.set("User-Agent", "bound");
		request.headers.set("originator", "bound");
		return baseFetch(request);
	}) as typeof fetch;
}

/** ChatGPT subscription OAuth driver over the native OpenAI Responses surface. */
export class ChatGptOAuthDriver implements LLMBackend {
	private readonly provider: ReturnType<typeof createOpenAI>;
	private readonly model: string;
	private readonly contextWindow: number;
	private readonly logger?: Logger;
	/**
	 * Identity of THIS ChatGPT/Codex deployment, `${siteId}:${PROVIDER_NAME}`, or
	 * undefined when no siteId was supplied (tests). Stamped onto minted OpenAI
	 * encrypted reasoning and compared against each replayed block's
	 * `reasoning_origin` so a blob minted by a DIFFERENT provider/host (e.g. the
	 * bedrock-mantle deployment of the same model id on another host) is dropped
	 * before it 400s the turn. Encrypted reasoning does not cross providers.
	 */
	private readonly reasoningOrigin?: string;

	constructor(config: {
		tokenManager: TokenManager;
		model: string;
		contextWindow: number;
		logger?: Logger;
		fetch?: typeof fetch;
		connectTimeoutMs?: number;
		/**
		 * This host's site id. Combined with the provider name to form the deployment
		 * identity stamped onto / compared against encrypted reasoning. Omitted in
		 * tests that don't exercise the cross-provider path.
		 */
		siteId?: string;
	}) {
		this.model = config.model;
		this.contextWindow = config.contextWindow;
		this.logger = config.logger;
		this.reasoningOrigin = buildReasoningOrigin({
			siteId: config.siteId,
			provider: PROVIDER_NAME,
		});
		this.provider = createOpenAI({
			name: PROVIDER_NAME,
			// The native provider adds the terminal /responses path itself.
			baseURL: CHATGPT_BACKEND_BASE_URL,
			apiKey: "oauth",
			fetch: createChatGptOAuthFetch({
				tokenManager: config.tokenManager,
				baseFetch: resolveProviderFetch(PROVIDER_NAME, config),
			}),
		});
	}

	chat(params: ChatParams): AsyncIterable<StreamChunk> {
		return bindAsyncIterable(context.active(), this.chatStream(params));
	}

	private async *chatStream(params: ChatParams): AsyncIterable<StreamChunk> {
		const modelId = params.model || this.model;
		const tools = toToolSet(params.tools);
		const buildMessages = (stripEncryptedReasoning: boolean) =>
			toModelMessages(params.messages, {
				cacheProvider: null,
				resolveFileRef: params.resolveFileRef,
				targetEnvelope: PERMISSIVE_ENVELOPE,
				reasoningProviderOptions: "openai",
				// Layer 1: drop replayed encrypted reasoning minted on a DIFFERENT
				// provider/host (e.g. the bedrock-mantle deployment of this same model
				// id on another host) — the Codex endpoint rejects a foreign blob.
				...(this.reasoningOrigin && { reasoningOrigin: this.reasoningOrigin }),
				// Layer 2: strip ALL encrypted reasoning on the one post-rejection retry.
				...(stripEncryptedReasoning && { stripEncryptedReasoning: true }),
				midConversationSystem: true,
			});
		const runAttempt = (
			attemptMessages: ReturnType<typeof buildMessages>,
		): AsyncIterable<StreamChunk> =>
			mapProviderStream({
				providerName: PROVIDER_NAME,
				stream: () =>
					streamText({
						model: this.provider.responses(modelId),
						messages: attemptMessages,
						allowSystemInMessages: true,
						...(params.system && { system: params.system }),
						...(tools && { tools }),
						// The ChatGPT-backend Responses endpoint
						// (chatgpt.com/backend-api/codex/responses) validates a STRICT
						// parameter allowlist — model, input, instructions, stream, store,
						// include, tools, tool_choice, reasoning, previous_response_id,
						// prompt_cache_key, truncation — far narrower than
						// api.openai.com/v1/responses. It rejects temperature, top_p, and
						// max_output_tokens with a 400 (`{"detail":"Unsupported parameter:
						// …"}`), so none of those may ride even when the caller sets them.
						// tool_choice stays only when tools are present (it is on the
						// allowlist).
						...(tools && params.tool_choice && { toolChoice: params.tool_choice }),
						// The Codex backend requires `store: false` (zero retention) and
						// rejects the request with 400 `{"detail":"Store must be set to
						// false"}` otherwise. The @ai-sdk/openai Responses provider maps
						// `providerOptions.openai.store` onto the body `store` field.
						// Prompt caching: the endpoint has NO prompt_cache_breakpoint field
						// (that knob is the Mantle/GPT-5.6 surface), so Bound's `{role:
						// "cache"}` markers cannot ride this driver. Cache reuse rides the
						// automatic prefix cache instead, keyed by a session-stable
						// `prompt_cache_key` — the same mechanism the Codex CLI reference
						// client uses (it sends the conversation session id). Without a
						// stable key, requests land on arbitrary cache partitions and
						// multi-turn agent loops measure ~0% cached tokens.
						providerOptions: {
							openai: {
								store: false,
								...(params.threadId && { promptCacheKey: params.threadId }),
							},
						},
						// Codex client parity (codex-rs/codex-api/src/requests/headers.rs
						// build_session_headers): the reference client pins `session-id` /
						// `thread-id` on every Responses request with the same conversation
						// identity as prompt_cache_key. Suspected cache-partition affinity
						// input on this endpoint — production gpt-6-astra traffic measured
						// ~0% cached tokens with the body key alone.
						...(params.threadId && {
							headers: {
								"session-id": params.threadId,
								"thread-id": params.threadId,
							},
						}),
						abortSignal: params.signal,
					}).fullStream,
				map: {
					estimateInputFromMessages: params.messages,
					coalescePrefixItems: true,
					// Stamp minted encrypted reasoning with this deployment's identity so a
					// later request-build on a DIFFERENT provider/host drops the un-replayable
					// blob instead of 400-ing the turn.
					...(this.reasoningOrigin && { reasoningOrigin: this.reasoningOrigin }),
				},
			});

		yield { type: "heartbeat" };
		// withEmptyRetry handles the empty-completion retry; withEncryptedReasoningRetry
		// (shared) adds the ONE strip-and-retry when the Codex endpoint rejects a
		// cross-provider encrypted-reasoning blob (minted by, e.g., the bedrock-mantle
		// deployment of this same model id on another host).
		yield* withEncryptedReasoningRetry({
			build: buildMessages,
			run: (attemptMessages) =>
				withEmptyRetry(() => runAttempt(attemptMessages), {
					maxRetries: EMPTY_COMPLETION_MAX_RETRIES,
					isAborted: () => params.signal?.aborted ?? false,
					providerName: PROVIDER_NAME,
					modelId,
					onRetry: (attempt) =>
						this.logger?.warn?.(
							`[${PROVIDER_NAME}] empty completion (output_tokens=0), retrying (attempt ${attempt}/${EMPTY_COMPLETION_MAX_RETRIES})`,
							{ model: modelId },
						),
				}),
			onStrip: () =>
				this.logger?.warn?.(
					`[${PROVIDER_NAME}] encrypted-reasoning rejected (cross-provider replay); retrying once with encrypted reasoning stripped`,
					{ model: modelId },
				),
		});
	}

	capabilities(): BackendCapabilities {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			vision: true,
			prompt_caching: true,
			extended_thinking: false,
			max_context: this.contextWindow,
		};
	}
}
