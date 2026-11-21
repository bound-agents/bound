/**
 * GitHub Copilot direct-API driver.
 *
 * Fronts the Copilot API (NOT the Copilot CLI/SDK) as a first-class bound
 * backend. A holder of a GitHub Copilot subscription runs Claude, GPT, Gemini,
 * grok, and the `auto` selector through bound's own GitHub App device-flow
 * token — no API key, no Copilot CLI.
 *
 * Per-model routing (verified live): each model is reached over the AI SDK
 * provider that matches its `supported_endpoints`:
 *   - "/v1/messages"   → @ai-sdk/anthropic Messages, baseURL `${api}/v1`
 *   - "/responses"     → @ai-sdk/openai .responses, baseURL `${api}`
 *   - "/chat/completions" (or legacy) → @ai-sdk/openai .chat, baseURL `${api}`
 * A model absent from the catalog falls back to a name heuristic.
 *
 * `model: "auto"` resolves a session (POST `${api}/auto`) picking a concrete
 * model, which is then called with a `Copilot-Session-Token` header over the
 * selected model's own route.
 *
 * Auth, catalog, auto-session, and header assembly live in sibling modules; this
 * driver owns message-shape conversion (via the bridge), provider construction,
 * and stream translation.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import type { Logger } from "@bound/shared";
import { context } from "@opentelemetry/api";
import { streamText } from "ai";
import type { ModelMessage } from "ai";
import {
	ANTHROPIC_ENVELOPE,
	OPENAI_RESPONSES_ENVELOPE,
	PERMISSIVE_ENVELOPE,
	toModelMessages,
	toToolSet,
} from "../../bridge";
import type {
	BackendCapabilities,
	ChatParams,
	ContentBlock,
	LLMBackend,
	LLMMessage,
	StreamChunk,
} from "../../types";
import { LLMError } from "../../types";
import {
	buildAnthropicReasoningOptions,
	buildAnthropicSystemMessage,
	shouldEnableAnthropicSystemCacheControl,
} from "../anthropic";
import {
	EMPTY_COMPLETION_MAX_RETRIES,
	bindAsyncIterable,
	buildReasoningOrigin,
	mapProviderStream,
	resolveProviderFetch,
	withEmptyRetry,
	withEncryptedReasoningRetry,
} from "../shared";
import type { CopilotAccountInfo } from "./auth-core";
import { type CopilotAutoSession, CopilotAutoSessionCache } from "./auto-session";
import {
	CopilotCatalog,
	type CopilotModelEntry,
	type CopilotRoute,
	computeCopilotCostBreakdown,
	resolveRoute,
	routeFromModelName,
} from "./catalog";
import {
	type CopilotRequestContext,
	createCopilotControlFetch,
	createCopilotFetch,
	resolveInitiator,
} from "./fetch-wrapper";
import type { CopilotTokenManager } from "./token-store";
export const PROVIDER_NAME = "github-copilot";

/** The literal that triggers auto-session routing. */
export const AUTO_MODEL = "auto";

/** True when any message content block is an image part (drives the vision header). */
export function messagesHaveImages(messages: LLMMessage[]): boolean {
	for (const message of messages) {
		if (typeof message.content === "string") continue;
		for (const block of message.content as ContentBlock[]) {
			if (block.type === "image") return true;
			// A document part may carry a file_ref source that resolves to an image
			// at assembly time; an image-media file_ref source is a vision request.
			if (block.type === "document") {
				const source = (block as { source?: { type?: string; media_type?: string } }).source;
				if (source?.type === "file_ref" && source.media_type?.startsWith("image/")) return true;
			}
		}
	}
	return false;
}

/** The role of the last message — drives the `x-initiator` header. */
function latestRole(messages: LLMMessage[]): string | undefined {
	return messages.at(-1)?.role;
}

/** Extract the last user text, for the auto selector's `{prompt}`. */
function lastUserText(messages: LLMMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		if (typeof m.content === "string") return m.content;
		const text = (m.content as ContentBlock[])
			.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		if (text) return text;
	}
	return "";
}

/** Effort levels in ascending strength; used to resolve `max` to the top advertised tier. */
const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Resolve the effective `reasoning_effort` for a turn against the model's
 * advertised levels (from the catalog's `capabilities.supports.reasoning_effort`).
 *
 *  - `thinking.type === "disabled"` maps to `"none"` when the model lists it.
 *  - an explicit `params.effort` passes through iff the model advertises it.
 *  - `"max"` maps to the highest of the advertised tiers (xhigh/high/…) when
 *    `"max"` itself is absent but a weaker ceiling is listed.
 *  - when the model advertises no list at all, pass only the canonical
 *    low/medium/high values through; drop anything else.
 *  - anything unresolved returns `undefined` (the field is omitted on the wire).
 */
export function resolveReasoningEffort(
	params: Pick<ChatParams, "effort" | "thinking">,
	efforts: string[] | undefined,
): string | undefined {
	const disabled = params.thinking?.type === "disabled";
	if (disabled && efforts?.includes("none")) return "none";

	const requested = params.effort;
	if (!requested) return undefined;

	// No advertised list: accept only the canonical trio, drop the rest.
	if (!efforts || efforts.length === 0) {
		return requested === "low" || requested === "medium" || requested === "high"
			? requested
			: undefined;
	}

	if (efforts.includes(requested)) return requested;

	// `max` with no explicit `max` tier collapses to the strongest listed level.
	if (requested === "max") {
		for (let i = EFFORT_RANK.length - 1; i >= 0; i--) {
			const level = EFFORT_RANK[i];
			if (level !== "max" && efforts.includes(level)) return level;
		}
	}
	return undefined;
}

/** A 4xx that names a model/session problem the user can act on. */
function isSessionError(err: unknown): boolean {
	if (!(err instanceof LLMError)) return false;
	const s = err.statusCode;
	return s !== undefined && s >= 400 && s < 500;
}

export class GitHubCopilotDriver implements LLMBackend {
	private readonly tokenManager: CopilotTokenManager;
	private readonly model: string;
	private readonly contextWindow: number;
	private readonly logger?: Logger;
	private readonly baseFetch?: typeof fetch;
	private readonly resolveAccount: () => Promise<CopilotAccountInfo>;
	private readonly now?: () => number;
	/**
	 * Identity of THIS Copilot deployment, `${siteId}:${PROVIDER_NAME}`, or
	 * undefined when no siteId was supplied (tests). Used only on the Responses
	 * route (the only Copilot route that mints OpenAI encrypted reasoning, via
	 * `include: ["reasoning.encrypted_content"]`): stamped onto minted encrypted
	 * reasoning and compared against each replayed block's `reasoning_origin` so a
	 * blob minted by a DIFFERENT provider/host (e.g. the bedrock-mantle or
	 * chatgpt-oauth deployment of the same model id) is dropped before it 400s the
	 * turn. Encrypted reasoning does not cross providers.
	 */
	private readonly reasoningOrigin?: string;
	/** Per-turn request context the fetch wrapper snapshots on each send. */
	private requestContext: CopilotRequestContext = { initiator: "user", hasImages: false };
	/**
	 * Lazily-resolved per-endpoint state. The account lookup (which yields the
	 * validated API endpoint) is async, but `createBackendFromConfig` is
	 * synchronous — so the catalog + auto-session machinery is built on first
	 * chat, once the endpoint is known, and cached for the driver's lifetime.
	 */
	private endpointState: Promise<{
		apiEndpoint: string;
		catalog: CopilotCatalog;
		autoSessions: CopilotAutoSessionCache;
	}> | null = null;

	constructor(config: {
		tokenManager: CopilotTokenManager;
		model: string;
		contextWindow: number;
		/**
		 * Either an already-resolved account (tests, the login path) or a resolver
		 * called once on first chat. The resolver yields the VALIDATED Copilot API
		 * endpoint — see `fetchAccountInfo` + `validateCopilotApiEndpoint`.
		 */
		account?: CopilotAccountInfo;
		resolveAccount?: () => Promise<CopilotAccountInfo>;
		logger?: Logger;
		fetch?: typeof fetch;
		connectTimeoutMs?: number;
		/** Test seam: inject a clock for catalog/session TTL gating. */
		now?: () => number;
		/**
		 * This host's site id. Combined with the provider name to form the deployment
		 * identity stamped onto / compared against encrypted reasoning on the Responses
		 * route. Omitted in tests that don't exercise the cross-provider path.
		 */
		siteId?: string;
	}) {
		this.tokenManager = config.tokenManager;
		this.model = config.model;
		this.contextWindow = config.contextWindow;
		this.logger = config.logger;
		this.baseFetch = resolveProviderFetch(PROVIDER_NAME, config);
		if (config.now) this.now = config.now;
		this.reasoningOrigin = buildReasoningOrigin({
			siteId: config.siteId,
			provider: PROVIDER_NAME,
		});
		const eager = config.account;
		this.resolveAccount =
			config.resolveAccount ??
			(eager
				? () => Promise.resolve(eager)
				: () => {
						throw new Error("GitHubCopilotDriver requires account or resolveAccount");
					});
	}

	/** Build (once) the endpoint-scoped catalog + auto-session machinery. */
	private endpoint(): Promise<{
		apiEndpoint: string;
		catalog: CopilotCatalog;
		autoSessions: CopilotAutoSessionCache;
	}> {
		if (!this.endpointState) {
			this.endpointState = (async () => {
				const account = await this.resolveAccount();
				const apiEndpoint = account.apiEndpoint;
				const controlFetch = createCopilotControlFetch({
					getAccessToken: () => this.tokenManager.getAccessToken(),
					baseFetch: this.baseFetch,
				});
				const catalog = new CopilotCatalog({
					fetch: controlFetch,
					apiEndpoint,
					...(this.now && { now: this.now }),
				});
				const autoSessions = new CopilotAutoSessionCache({
					fetch: controlFetch,
					apiEndpoint,
					...(this.now && { now: this.now }),
				});
				return { apiEndpoint, catalog, autoSessions };
			})().catch((err) => {
				// Reset so a transient account-lookup failure can be retried next turn.
				this.endpointState = null;
				throw err;
			});
		}
		return this.endpointState;
	}

	chat(params: ChatParams): AsyncIterable<StreamChunk> {
		return bindAsyncIterable(context.active(), this.chatStream(params));
	}

	private copilotFetch(): typeof fetch {
		return createCopilotFetch({
			getAccessToken: () => this.tokenManager.getAccessToken(),
			getRequestContext: () => this.requestContext,
			baseFetch: this.baseFetch,
		});
	}

	private async *chatStream(params: ChatParams): AsyncIterable<StreamChunk> {
		const configuredModel = params.model || this.model;
		const { apiEndpoint, catalog, autoSessions } = await this.endpoint();

		// Resolve auto → a concrete model + a session token scoped to it.
		let modelId = configuredModel;
		let session: CopilotAutoSession | undefined;
		if (configuredModel === AUTO_MODEL) {
			session = await autoSessions.get(params.threadId, lastUserText(params.messages));
			modelId = session.selectedModelId;
			this.logger?.info?.(
				`[${PROVIDER_NAME}] auto selected ${modelId}${session.selectionReason ? ` (${session.selectionReason})` : ""}`,
			);
		}

		const entry = await catalog.getEntry(modelId);
		const route = resolveRoute(modelId, entry);

		// Snapshot the per-turn header facts the fetch wrapper reads on send.
		this.requestContext = {
			initiator: resolveInitiator(latestRole(params.messages)),
			hasImages: messagesHaveImages(params.messages),
			...(session && { sessionToken: session.sessionToken }),
		};

		yield { type: "heartbeat" };

		const runAttempt = (stripEncryptedReasoning: boolean): AsyncIterable<StreamChunk> =>
			mapProviderStream({
				providerName: PROVIDER_NAME,
				modelId,
				stream: () =>
					this.streamForRoute(route, modelId, apiEndpoint, params, entry, stripEncryptedReasoning),
				// The messages route goes to @ai-sdk/anthropic, which surfaces the
				// cache-write total (and the 1h/5m split) under providerMetadata.anthropic.
				// Tag it so the bridge extracts both; the structured
				// inputTokenDetails.cacheWriteTokens path still takes precedence for the
				// total, so this only adds the split (and a metadata-shaped total
				// fallback), never changes today's cache_write_tokens for this route.
				map: {
					estimateInputFromMessages: params.messages,
					...(route === "messages" && { usageProvider: "anthropic" as const }),
					// Only the Responses route mints OpenAI encrypted reasoning; stamp it
					// with this deployment's origin so a later request-build on a DIFFERENT
					// provider/host drops the un-replayable blob instead of 400-ing.
					...(route === "responses" &&
						this.reasoningOrigin && { reasoningOrigin: this.reasoningOrigin }),
				},
			});

		const routedThroughAuto = configuredModel === AUTO_MODEL;
		try {
			// withEmptyRetry handles the empty-completion retry; withEncryptedReasoningRetry
			// (shared) adds the ONE strip-and-retry when the Responses endpoint rejects a
			// cross-provider encrypted-reasoning blob (minted by, e.g., the bedrock-mantle
			// or chatgpt-oauth deployment of this same model id on another host). Non-
			// Responses routes never mint or replay such blobs, so the wrapper is a no-op
			// there (the rejection classifier won't match a non-encrypted-reasoning error).
			yield* this.stampCost(
				withEncryptedReasoningRetry({
					build: (stripEncryptedReasoning) => stripEncryptedReasoning,
					run: (stripEncryptedReasoning) =>
						withEmptyRetry(() => runAttempt(stripEncryptedReasoning), {
							maxRetries: EMPTY_COMPLETION_MAX_RETRIES,
							isAborted: () => params.signal?.aborted ?? false,
							providerName: PROVIDER_NAME,
							modelId,
						}),
					onStrip: () =>
						this.logger?.warn?.(
							`[${PROVIDER_NAME}] encrypted-reasoning rejected (cross-provider replay); retrying once with encrypted reasoning stripped`,
							{ model: modelId },
						),
				}),
				entry,
				routedThroughAuto,
			);
		} catch (err) {
			// A 4xx session error invalidates the cached auto-session so the next
			// turn re-resolves; surface a catalog/plan 400 as actionable.
			if (session && isSessionError(err)) {
				autoSessions.invalidate(params.threadId);
			}
			throw this.mapCopilotError(err, modelId);
		}
	}

	/**
	 * Stamp `cost_usd` and its four-part `cost_breakdown` on the terminal `done`
	 * chunk from the resolved model's Copilot catalog pricing. Leaves both unset
	 * when the catalog carries no pricing for the model, so the precedence helper
	 * downstream can fall through to operator pricing or 0. The 1h cache-write
	 * split comes from `done.usage.cache_write_1h_tokens`, which the Messages
	 * route reads from Anthropic's `usage.cache_creation`.
	 */
	private async *stampCost(
		stream: AsyncIterable<StreamChunk>,
		entry: CopilotModelEntry | null,
		routedThroughAuto: boolean,
	): AsyncIterable<StreamChunk> {
		const pricing = entry?.pricing;
		for await (const chunk of stream) {
			if (chunk.type === "done" && pricing) {
				const cost_breakdown = computeCopilotCostBreakdown({
					pricing,
					usage: {
						inputTokens: chunk.usage.input_tokens,
						outputTokens: chunk.usage.output_tokens,
						cacheReadTokens: chunk.usage.cache_read_tokens ?? 0,
						cacheWriteTokens: chunk.usage.cache_write_tokens ?? 0,
						cacheWrite1hTokens: chunk.usage.cache_write_1h_tokens ?? 0,
					},
					nowMs: Date.now(),
					routedThroughAuto,
				});
				const cost_usd =
					cost_breakdown.input +
					cost_breakdown.output +
					cost_breakdown.cacheRead +
					cost_breakdown.cacheWrite;
				yield { ...chunk, cost_usd, cost_breakdown };
				continue;
			}
			yield chunk;
		}
	}

	/** Build the AI SDK stream for the resolved route. */
	private streamForRoute(
		route: CopilotRoute,
		modelId: string,
		apiEndpoint: string,
		params: ChatParams,
		entry: CopilotModelEntry | null,
		stripEncryptedReasoning: boolean,
	): AsyncIterable<unknown> {
		if (route === "messages") return this.streamMessages(modelId, apiEndpoint, params);
		if (route === "responses")
			return this.streamResponses(modelId, apiEndpoint, params, entry, stripEncryptedReasoning);
		return this.streamChat(modelId, apiEndpoint, params, entry);
	}

	/** Anthropic Messages route via @ai-sdk/anthropic, baseURL `${api}/v1`. */
	private streamMessages(
		modelId: string,
		apiEndpoint: string,
		params: ChatParams,
	): AsyncIterable<unknown> {
		const provider = createAnthropic({
			apiKey: "copilot", // placeholder — the fetch wrapper strips x-api-key and sets the Bearer
			baseURL: `${apiEndpoint}/v1`,
			fetch: this.copilotFetch(),
			headers: { "anthropic-version": "2023-06-01" },
		});
		const cacheTtl = params.cache_ttl === "1h" ? "1h" : "5m";
		const bridgeMessages = toModelMessages(params.messages, {
			cacheProvider: "anthropic",
			cacheTtl,
			resolveFileRef: params.resolveFileRef,
			reasoningProviderOptions: "anthropic",
			targetEnvelope: ANTHROPIC_ENVELOPE,
		});
		const systemMessage = buildAnthropicSystemMessage({
			system: params.system,
			cacheEnabled: shouldEnableAnthropicSystemCacheControl({
				cacheTtl:
					params.cache_ttl === "1h" || params.cache_ttl === "5m" ? params.cache_ttl : undefined,
				bridgeMessages,
			}),
			cacheTtl,
		});
		const messages: ModelMessage[] = systemMessage
			? [systemMessage, ...bridgeMessages]
			: bridgeMessages;
		const tools = toToolSet(params.tools);
		const reasoning = buildAnthropicReasoningOptions(params);
		return streamText({
			model: provider.languageModel(modelId),
			messages,
			// The system prompt rides as a role:"system" ModelMessage at index 0 (see
			// buildAnthropicSystemMessage); ai@7 streamText rejects it unless we opt in.
			allowSystemInMessages: true,
			...(tools && { tools }),
			...(tools && params.tool_choice && { toolChoice: params.tool_choice }),
			...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
			...(params.temperature !== undefined && !reasoning && { temperature: params.temperature }),
			abortSignal: params.signal,
			...(reasoning && {
				providerOptions: { anthropic: reasoning as Record<string, unknown> as never },
			}),
		}).fullStream;
	}

	/** OpenAI Responses route via @ai-sdk/openai .responses, baseURL `${api}`. */
	private streamResponses(
		modelId: string,
		apiEndpoint: string,
		params: ChatParams,
		entry: CopilotModelEntry | null,
		stripEncryptedReasoning: boolean,
	): AsyncIterable<unknown> {
		const provider = createOpenAI({
			name: PROVIDER_NAME,
			apiKey: "copilot",
			baseURL: apiEndpoint,
			fetch: this.copilotFetch(),
		});
		const messages = toModelMessages(params.messages, {
			cacheProvider: null,
			resolveFileRef: params.resolveFileRef,
			targetEnvelope: OPENAI_RESPONSES_ENVELOPE,
			reasoningProviderOptions: "openai",
			// Layer 1: drop replayed encrypted reasoning minted on a DIFFERENT
			// provider/host (e.g. the bedrock-mantle or chatgpt-oauth deployment of
			// this same model id) — the Copilot Responses endpoint rejects a foreign blob.
			...(this.reasoningOrigin && { reasoningOrigin: this.reasoningOrigin }),
			// Layer 2: strip ALL encrypted reasoning on the one post-rejection retry.
			...(stripEncryptedReasoning && { stripEncryptedReasoning: true }),
			midConversationSystem: true,
		});
		const tools = toToolSet(params.tools);
		const effort = resolveReasoningEffort(params, entry?.reasoningEfforts);
		// When reasoning is active, run under store:false + encrypted_content so the
		// model replays its reasoning inline rather than via item_reference ids that
		// Copilot may not retain (mirrors OpenCode and the chatgpt-oauth driver).
		// forceReasoning is required because the SDK only auto-detects gpt-5*; a
		// gpt-6.x / grok / mai-code turn would otherwise drop the reasoning fields.
		const openaiOptions: OpenAIResponsesProviderOptions = {
			...(params.threadId && { promptCacheKey: params.threadId }),
			...(effort && {
				forceReasoning: true,
				reasoningEffort: effort,
				reasoningSummary: "auto",
				store: false,
				include: ["reasoning.encrypted_content"],
			}),
		};
		return streamText({
			model: provider.responses(modelId),
			messages,
			allowSystemInMessages: true,
			...(params.system && { system: params.system }),
			...(tools && { tools }),
			...(tools && params.tool_choice && { toolChoice: params.tool_choice }),
			// Gemini and other reasoners burn the whole budget on reasoning when
			// the output budget is tiny; only forward a sane cap.
			...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
			abortSignal: params.signal,
			...(Object.keys(openaiOptions).length > 0 && {
				providerOptions: { openai: openaiOptions },
			}),
		}).fullStream;
	}

	/** Chat Completions route via @ai-sdk/openai .chat, baseURL `${api}`. */
	private streamChat(
		modelId: string,
		apiEndpoint: string,
		params: ChatParams,
		entry: CopilotModelEntry | null,
	): AsyncIterable<unknown> {
		const provider = createOpenAI({
			name: PROVIDER_NAME,
			apiKey: "copilot",
			baseURL: apiEndpoint,
			fetch: this.copilotFetch(),
		});
		const messages = toModelMessages(params.messages, {
			cacheProvider: null,
			resolveFileRef: params.resolveFileRef,
			targetEnvelope: PERMISSIVE_ENVELOPE,
			midConversationSystem: true,
		});
		const tools = toToolSet(params.tools);
		const effort = resolveReasoningEffort(params, entry?.reasoningEfforts);
		return streamText({
			model: provider.chat(modelId),
			messages,
			allowSystemInMessages: true,
			...(params.system && { system: params.system }),
			...(tools && { tools }),
			...(tools && params.tool_choice && { toolChoice: params.tool_choice }),
			...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
			...(params.temperature !== undefined && { temperature: params.temperature }),
			abortSignal: params.signal,
			...(effort && { providerOptions: { openai: { reasoningEffort: effort } } }),
		}).fullStream;
	}

	/**
	 * Map a Copilot API error into an actionable LLMError. `model_not_supported`
	 * and `no_available_model_endpoints` mean the account/plan can't call this
	 * model — surface a non-retryable, actionable message.
	 */
	private mapCopilotError(err: unknown, modelId: string): unknown {
		if (!(err instanceof LLMError)) return err;
		const msg = err.message.toLowerCase();
		if (msg.includes("model_not_supported") || msg.includes("no_available_model_endpoints")) {
			return new LLMError(
				`Copilot model "${modelId}" is unavailable for this plan. Try \`auto\` or a zero-priced model (e.g. gpt-4.1, gpt-4o, gpt-5.4-nano). Underlying error: ${err.message}`,
				PROVIDER_NAME,
				err.statusCode,
			);
		}
		return err;
	}

	capabilities(): BackendCapabilities {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			vision: true,
			prompt_caching: true,
			// Extended thinking is the Claude (Messages) route's capability; the
			// catalog isn't available synchronously, so route from the model name.
			extended_thinking: routeFromModelName(this.model) === "messages",
			max_context: this.contextWindow,
		};
	}
}
