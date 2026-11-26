import { createOpenAI } from "@ai-sdk/openai";
import type { Logger } from "@bound/shared";
import { context } from "@opentelemetry/api";
import { streamText } from "ai";
import { PERMISSIVE_ENVELOPE, toModelMessages, toToolSet } from "../../bridge";
import type { DiscoveredModel, SupportsModelDiscovery } from "../../catalog/discovery";
import type { DriverFallbackSupport } from "../../fallback-policy";
import type {
	BackendCapabilities,
	BackendReadiness,
	ChatParams,
	LLMBackend,
	StreamChunk,
} from "../../types";
import { LLMError } from "../../types";
import {
	NamespaceLineupReadiness,
	type NamespaceModelOverride,
	lineupFromDiscovered,
} from "../namespace-readiness";
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
import { CODEX_MODELS_CLIENT_VERSION, parseCodexModels } from "./catalog";
import type { TokenManager } from "./token-store";
const PROVIDER_NAME = "chatgpt-oauth";

export interface ChatGptOAuthDriverConfig {
	tokenManager: TokenManager;
	/**
	 * Concrete Codex model slug. Omitted => self-configuring namespace: the driver
	 * owns `readiness`, fetches the Codex `/models` inventory, and expands into one
	 * concrete backend per listed model (catalog §2.1).
	 */
	model?: string;
	contextWindow?: number;
	logger?: Logger;
	fetch?: typeof fetch;
	connectTimeoutMs?: number;
	/**
	 * This host's site id. Combined with the provider name to form the deployment
	 * identity stamped onto / compared against encrypted reasoning. Omitted in
	 * tests that don't exercise the cross-provider path.
	 */
	siteId?: string;
	/** Namespace config id; expanded ids are `${namespaceId}-${providerModelId}`. */
	namespaceId?: string;
	/** Per-model overrides keyed by provider model id (namespace only). */
	modelOverrides?: Record<string, NamespaceModelOverride>;
	/** Lineup retry backoff base/cap (test seam). */
	lineupRetryBaseMs?: number;
	lineupRetryMaxMs?: number;
}

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
export class ChatGptOAuthDriver implements LLMBackend, SupportsModelDiscovery {
	readonly readiness?: BackendReadiness;
	private readonly isNamespace: boolean;
	private readonly provider: ReturnType<typeof createOpenAI>;
	private readonly tokenManager: TokenManager;
	private readonly authFetch: typeof fetch;
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

	constructor(config: ChatGptOAuthDriverConfig) {
		this.isNamespace = !config.model;
		this.model = config.model ?? "";
		this.contextWindow = config.contextWindow ?? 0;
		this.logger = config.logger;
		this.tokenManager = config.tokenManager;
		this.reasoningOrigin = buildReasoningOrigin({
			siteId: config.siteId,
			provider: PROVIDER_NAME,
		});
		this.authFetch = createChatGptOAuthFetch({
			tokenManager: config.tokenManager,
			baseFetch: resolveProviderFetch(PROVIDER_NAME, config),
		});
		this.provider = createOpenAI({
			name: PROVIDER_NAME,
			// The native provider adds the terminal /responses path itself.
			baseURL: CHATGPT_BACKEND_BASE_URL,
			apiKey: "oauth",
			fetch: this.authFetch,
		});

		if (this.isNamespace) {
			// The fetch is NOT started here — the wiring layer calls
			// `readiness.start(registrar)` once the registrar is bound. Expanded
			// backends share this namespace's TokenManager so a refresh-token
			// rotation is never raced across siblings.
			this.readiness = new NamespaceLineupReadiness({
				providerName: PROVIDER_NAME,
				namespaceId: config.namespaceId ?? PROVIDER_NAME,
				loadLineup: async (signal) => lineupFromDiscovered(await this.discoverModels(signal)),
				buildPerModelBackend: (entry, contextWindow) =>
					new ChatGptOAuthDriver({
						tokenManager: config.tokenManager,
						model: entry.id,
						contextWindow,
						...(config.logger !== undefined && { logger: config.logger }),
						...(config.fetch !== undefined && { fetch: config.fetch }),
						...(config.connectTimeoutMs !== undefined && {
							connectTimeoutMs: config.connectTimeoutMs,
						}),
						...(config.siteId !== undefined && { siteId: config.siteId }),
					}),
				// The Codex endpoint serves an automatic prefix cache keyed by
				// prompt_cache_key, same as a concrete chatgpt-oauth backend.
				defaultPromptCaching: true,
				...(config.modelOverrides !== undefined && { modelOverrides: config.modelOverrides }),
				...(config.logger !== undefined && { logger: config.logger }),
				...(config.lineupRetryBaseMs !== undefined && { retryBaseMs: config.lineupRetryBaseMs }),
				...(config.lineupRetryMaxMs !== undefined && { retryMaxMs: config.lineupRetryMaxMs }),
			});
		}
	}

	/**
	 * Live Codex inventory (catalog §4.1 / R-MC3): listed, API-callable models
	 * with their published context window, image input, and effort ladder.
	 * Throws on a non-OK response or transport failure.
	 */
	async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
		const url = `${CHATGPT_BACKEND_BASE_URL}/models?client_version=${CODEX_MODELS_CLIENT_VERSION}`;
		const res = await this.authFetch(url, {
			headers: { Accept: "application/json" },
			...(signal && { signal }),
		});
		if (!res.ok) {
			throw new LLMError(
				`${PROVIDER_NAME} model discovery failed: HTTP ${res.status}`,
				PROVIDER_NAME,
				res.status,
			);
		}
		return parseCodexModels(await res.json());
	}

	chat(params: ChatParams): AsyncIterable<StreamChunk> {
		return bindAsyncIterable(context.active(), this.chatStream(params));
	}

	/**
	 * Provider-neutral auth-refresh hook (#285, R-RT13). A live `401` means the
	 * provider rejected the current access token; force a token rotation through
	 * the shared TokenManager. `true` on a successful rotation lets the loop retry
	 * without backing off; `false` (expired/revoked refresh token) makes the loop
	 * back off and raise a re-login advisory.
	 */
	async refreshAuth(): Promise<boolean> {
		return this.tokenManager.forceRefresh();
	}

	private async *chatStream(params: ChatParams): AsyncIterable<StreamChunk> {
		// Namespace guard: the placeholder owns no concrete model and must never
		// serve inference, even if a caller bypasses the readiness gate.
		if (this.isNamespace) {
			throw new LLMError(
				`${PROVIDER_NAME} namespace backend is not directly invokable — lineup not yet resolved / backend not ready`,
				PROVIDER_NAME,
			);
		}
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
					logger: this.logger,
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

	fallbackSupport(): DriverFallbackSupport {
		// ChatGPT OAuth (Codex): no refusal-fallback protocol surfaced to Bound
		// (catalog §4.2). A refusal walks the loop-host router.
		return {
			server_side_auto: false,
			publishes_allowed_targets: false,
			supports_fallback_credit: false,
		};
	}
}
