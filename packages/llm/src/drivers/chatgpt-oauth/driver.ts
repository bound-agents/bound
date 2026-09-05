import { createOpenAI } from "@ai-sdk/openai";
import type { Logger } from "@bound/shared";
import { context } from "@opentelemetry/api";
import { streamText } from "ai";
import { PERMISSIVE_ENVELOPE, toModelMessages, toToolSet } from "../../bridge";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "../../types";
import {
	EMPTY_COMPLETION_MAX_RETRIES,
	bindAsyncIterable,
	mapProviderStream,
	resolveProviderFetch,
	withEmptyRetry,
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

	constructor(config: {
		tokenManager: TokenManager;
		model: string;
		contextWindow: number;
		logger?: Logger;
		fetch?: typeof fetch;
		connectTimeoutMs?: number;
	}) {
		this.model = config.model;
		this.contextWindow = config.contextWindow;
		this.logger = config.logger;
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
		const messages = toModelMessages(params.messages, {
			cacheProvider: null,
			resolveFileRef: params.resolveFileRef,
			targetEnvelope: PERMISSIVE_ENVELOPE,
			reasoningProviderOptions: "openai",
			midConversationSystem: true,
		});
		const runAttempt = (): AsyncIterable<StreamChunk> =>
			mapProviderStream({
				providerName: PROVIDER_NAME,
				stream: () =>
					streamText({
						model: this.provider.responses(modelId),
						messages,
						allowSystemInMessages: true,
						...(params.system && { system: params.system }),
						...(tools && { tools }),
						// The ChatGPT-backend Responses endpoint
						// (chatgpt.com/backend-api/codex/responses) validates a STRICT
						// parameter allowlist — model, input, instructions, stream, store,
						// include, tools, tool_choice, reasoning, previous_response_id,
						// truncation — far narrower than api.openai.com/v1/responses. It
						// rejects temperature, top_p, and max_output_tokens with a 400
						// (`{"detail":"Unsupported parameter: …"}`), so none of those may
						// ride even when the caller sets them. tool_choice stays only when
						// tools are present (it is on the allowlist).
						...(tools && params.tool_choice && { toolChoice: params.tool_choice }),
						abortSignal: params.signal,
					}).fullStream,
				map: { estimateInputFromMessages: params.messages, coalescePrefixItems: true },
			});

		yield { type: "heartbeat" };
		yield* withEmptyRetry(runAttempt, {
			maxRetries: EMPTY_COMPLETION_MAX_RETRIES,
			isAborted: () => params.signal?.aborted ?? false,
			providerName: PROVIDER_NAME,
			modelId,
			onRetry: (attempt) =>
				this.logger?.warn?.(
					`[${PROVIDER_NAME}] empty completion (output_tokens=0), retrying (attempt ${attempt}/${EMPTY_COMPLETION_MAX_RETRIES})`,
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
