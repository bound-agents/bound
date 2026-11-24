import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Logger } from "@bound/shared";
import { streamText } from "ai";
import {
	ANTHROPIC_ENVELOPE,
	OPENAI_RESPONSES_ENVELOPE,
	PERMISSIVE_ENVELOPE,
	toModelMessages,
	toToolSet,
} from "../bridge";
import type { DiscoveredModel, SupportsModelDiscovery } from "../catalog/discovery";
import type { DriverFallbackSupport } from "../fallback-policy";
import type {
	BackendCapabilities,
	BackendConfig,
	BackendReadiness,
	ChatParams,
	LLMBackend,
	ModelDescriptor,
	ModelRegistrar,
	StreamChunk,
} from "../types";
import { LLMError } from "../types";
import {
	type OpenCodeGoCatalogEntry,
	type OpenCodeGoProtocol,
	parseOpenCodeGoModels,
} from "./opencode-go-catalog";
import {
	EMPTY_COMPLETION_MAX_RETRIES,
	buildReasoningOrigin,
	mapProviderStream,
	resolveProviderFetch,
	withEmptyRetry,
	withEncryptedReasoningRetry,
} from "./shared";

export type { OpenCodeGoCatalogEntry, OpenCodeGoProtocol } from "./opencode-go-catalog";
export { parseOpenCodeGoModels } from "./opencode-go-catalog";

const DEFAULT_OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const PROVIDER_NAME = "opencode-go";
const BOUND_USER_AGENT = "bound";
export const MAX_OPENCODE_SESSION_ID_LENGTH = 256;

/** Retry/backoff caps for the background namespace lineup fetch (mirrors Copilot). */
const LINEUP_RETRY_BASE_MS = 1000;
const LINEUP_RETRY_MAX_MS = 60_000;

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

/** Per-model override entry (camelCase, from `toRouterConfig`). */
type ModelOverride = NonNullable<BackendConfig["modelOverrides"]>[string];

export interface OpenCodeGoDriverConfig {
	apiKey: string;
	/**
	 * Concrete provider model id. Omitted => self-configuring namespace: the
	 * driver owns `readiness`, fetches `/models`, and expands into one concrete
	 * backend per routable chat model (2026-11-21-model-catalog.md §2.1).
	 */
	model?: string;
	contextWindow?: number;
	/** Override the zen/go root (`/models`, and the default inference base URL). */
	baseUrl?: string;
	/**
	 * Wire protocol for this model, as published by the `/models` `api` block.
	 * Omitted => chosen per call from the model family (static configs).
	 */
	protocol?: OpenCodeGoProtocol;
	/** Protocol-specific base URL published by `/models`; defaults to `baseUrl`. */
	apiBaseUrl?: string;
	/** This host's site id; forms the encrypted-reasoning origin on Responses. */
	siteId?: string;
	logger?: Logger;
	fetch?: typeof fetch;
	connectTimeoutMs?: number;
	/** Namespace config id; expanded ids are `${namespaceId}-${providerModelId}`. */
	namespaceId?: string;
	/** Per-model overrides keyed by provider model id (namespace only). */
	modelOverrides?: Record<string, ModelOverride>;
	/** Lineup retry backoff base/cap (test seam). */
	lineupRetryBaseMs?: number;
	lineupRetryMaxMs?: number;
}

/**
 * Readiness handle for the self-configuring OpenCode Go namespace. Fetches
 * `/models`, keeps routable chat models, and registers one concrete backend per
 * model. A failed or empty fetch retries with capped exponential backoff;
 * `dispose()` aborts the in-flight fetch and turns any later result into a no-op.
 */
class OpenCodeGoLineupReadiness implements BackendReadiness {
	private ready = false;
	private disposed = false;
	private pendingRetry?: ReturnType<typeof setTimeout>;
	private readonly controller = new AbortController();
	private readonly retryBaseMs: number;
	private readonly retryMaxMs: number;

	constructor(
		private readonly deps: {
			loadCatalog: (signal: AbortSignal) => Promise<OpenCodeGoCatalogEntry[]>;
			buildPerModelDriver: (entry: OpenCodeGoCatalogEntry, contextWindow: number) => LLMBackend;
			namespaceId: string;
			modelOverrides?: Record<string, ModelOverride>;
			logger?: Logger;
			retryBaseMs?: number;
			retryMaxMs?: number;
		},
	) {
		this.retryBaseMs = deps.retryBaseMs ?? LINEUP_RETRY_BASE_MS;
		this.retryMaxMs = deps.retryMaxMs ?? LINEUP_RETRY_MAX_MS;
	}

	isReady(): boolean {
		return this.ready;
	}

	dispose(): void {
		this.disposed = true;
		if (this.pendingRetry !== undefined) clearTimeout(this.pendingRetry);
		this.pendingRetry = undefined;
		this.controller.abort();
	}

	start(registrar: ModelRegistrar): void {
		void this.runFetchLoop(registrar);
	}

	private async runFetchLoop(registrar: ModelRegistrar): Promise<void> {
		let attempt = 0;
		while (!this.disposed) {
			let entries: OpenCodeGoCatalogEntry[] = [];
			try {
				entries = await this.deps.loadCatalog(this.controller.signal);
			} catch (error) {
				if (this.disposed) return;
				this.deps.logger?.warn?.("opencode-go lineup fetch failed; retrying", {
					error: error instanceof Error ? error.message : String(error),
				});
				entries = [];
			}
			if (this.disposed) return;

			if (entries.length > 0) {
				const models = this.buildEntries(entries);
				if (this.disposed) return; // re-check just before the live-router write
				this.ready = true;
				registrar.register(this.deps.namespaceId, models);
				this.deps.logger?.info?.("opencode-go lineup ready", { models: models.length });
				return;
			}

			attempt++;
			const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (attempt - 1));
			this.deps.logger?.warn?.("opencode-go lineup empty; retrying", {
				attempt,
				delayMs: delay,
			});
			await new Promise<void>((resolve) => {
				this.pendingRetry = setTimeout(resolve, delay);
			});
			this.pendingRetry = undefined;
		}
	}

	private buildEntries(
		entries: OpenCodeGoCatalogEntry[],
	): Array<{ descriptor: ModelDescriptor; backend: LLMBackend }> {
		return entries.map((entry) => {
			const override = this.deps.modelOverrides?.[entry.id];
			const discovered = entry.discovered;
			const caps = discovered.capabilities;
			const maxContext = override?.contextWindow ?? caps?.max_context;
			const capabilities: BackendCapabilities = {
				streaming: true,
				tool_use: caps?.tool_use ?? true,
				system_prompt: true,
				prompt_caching: override?.promptCaching ?? false,
				vision: caps?.vision ?? false,
				extended_thinking: caps?.reasoning?.supported ?? false,
				...(maxContext !== undefined && { max_context: maxContext }),
			};
			const maxOutputTokens = override?.maxOutputTokens ?? discovered.maxOutputTokens;
			const descriptor: ModelDescriptor = {
				id: `${this.deps.namespaceId}-${entry.id}`,
				providerModelId: entry.id,
				discovered,
				capabilities,
				...(override?.logicalModel !== undefined && { logicalModel: override.logicalModel }),
				...(maxOutputTokens !== undefined && { maxOutputTokens }),
			};
			return { descriptor, backend: this.deps.buildPerModelDriver(entry, maxContext ?? 0) };
		});
	}
}

/**
 * OpenCode Go driver.
 *
 * OpenCode Go exposes three protocol surfaces behind a single subscription key:
 * - `/chat/completions` (OpenAI-compatible) for GLM / Kimi / DeepSeek / MiMo
 * - `/messages` (Anthropic) for Qwen / MiniMax
 * - `/responses` (OpenAI Responses) for models whose `/models` row recommends it
 *
 * A concrete backend either carries the protocol + base URL `/models`
 * published for it (namespace expansion) or, for a static config, picks the
 * protocol per call from the model family so an explicit `params.model`
 * override keeps working. A backend constructed without `model` is a
 * self-configuring namespace (catalog §2.1): it owns `readiness`, fetches
 * `/models`, and expands into one concrete backend per routable chat model.
 */
export class OpenCodeGoDriver implements LLMBackend, SupportsModelDiscovery {
	readonly readiness?: BackendReadiness;
	private readonly isNamespace: boolean;
	private readonly model: string;
	private readonly contextWindow: number;
	private readonly protocol?: OpenCodeGoProtocol;
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly providerFetch: typeof fetch;
	private readonly logger?: Logger;
	/**
	 * Identity of THIS deployment (`${siteId}:opencode-go`), stamped onto and
	 * compared against replayed encrypted reasoning on the Responses route so a
	 * blob minted by another provider/host is dropped before it 400s the turn.
	 */
	private readonly reasoningOrigin?: string;
	private openaiProvider: ReturnType<typeof createOpenAICompatible>;
	private anthropicProvider: ReturnType<typeof createAnthropic>;
	private responsesProvider: ReturnType<typeof createOpenAI>;

	constructor(config: OpenCodeGoDriverConfig) {
		this.isNamespace = !config.model;
		this.model = stripOpenCodeGoModelPrefix(config.model ?? "");
		this.contextWindow = config.contextWindow ?? 0;
		this.protocol = config.protocol;
		this.apiKey = config.apiKey;
		this.logger = config.logger;
		this.baseUrl = deriveOpenCodeGoBaseUrl(config.baseUrl);
		this.reasoningOrigin = buildReasoningOrigin({
			siteId: config.siteId,
			provider: PROVIDER_NAME,
		});
		const inferenceBaseUrl = config.apiBaseUrl ?? this.baseUrl;
		const customFetch = resolveProviderFetch(PROVIDER_NAME, config);
		this.providerFetch = (async (input, init) => {
			const headers = new Headers(init?.headers);
			headers.set("User-Agent", BOUND_USER_AGENT);
			return (customFetch ?? globalThis.fetch)(input, { ...init, headers });
		}) as typeof fetch;

		this.openaiProvider = createOpenAICompatible({
			name: PROVIDER_NAME,
			baseURL: inferenceBaseUrl,
			apiKey: config.apiKey,
			fetch: this.providerFetch,
		});
		this.anthropicProvider = createAnthropic({
			name: PROVIDER_NAME,
			baseURL: inferenceBaseUrl,
			apiKey: config.apiKey,
			fetch: this.providerFetch,
		});
		this.responsesProvider = createOpenAI({
			name: PROVIDER_NAME,
			baseURL: inferenceBaseUrl,
			apiKey: config.apiKey,
			fetch: this.providerFetch,
		});

		if (this.isNamespace) {
			// The fetch is NOT started here — the wiring layer calls
			// `readiness.start(registrar)` once the registrar is bound.
			this.readiness = new OpenCodeGoLineupReadiness({
				namespaceId: config.namespaceId ?? PROVIDER_NAME,
				loadCatalog: (signal) => this.fetchCatalog(signal),
				buildPerModelDriver: (entry, contextWindow) =>
					new OpenCodeGoDriver({
						apiKey: config.apiKey,
						model: entry.id,
						contextWindow,
						protocol: entry.protocol,
						...(config.baseUrl !== undefined && { baseUrl: config.baseUrl }),
						...(entry.apiBaseUrl !== undefined && { apiBaseUrl: entry.apiBaseUrl }),
						...(config.siteId !== undefined && { siteId: config.siteId }),
						...(config.logger !== undefined && { logger: config.logger }),
						...(config.fetch !== undefined && { fetch: config.fetch }),
						...(config.connectTimeoutMs !== undefined && {
							connectTimeoutMs: config.connectTimeoutMs,
						}),
					}),
				...(config.modelOverrides !== undefined && { modelOverrides: config.modelOverrides }),
				...(config.logger !== undefined && { logger: config.logger }),
				...(config.lineupRetryBaseMs !== undefined && { retryBaseMs: config.lineupRetryBaseMs }),
				...(config.lineupRetryMaxMs !== undefined && { retryMaxMs: config.lineupRetryMaxMs }),
			});
		}
	}

	/** Fetch + parse `/models` into routable chat catalog entries, or throw. */
	private async fetchCatalog(signal?: AbortSignal): Promise<OpenCodeGoCatalogEntry[]> {
		const url = `${this.baseUrl.replace(/\/$/, "")}/models`;
		const res = await this.providerFetch(url, {
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"User-Agent": BOUND_USER_AGENT,
				accept: "application/json",
			},
			...(signal && { signal }),
		});
		if (!res.ok) {
			throw new Error(`opencode-go model discovery failed: HTTP ${res.status}`);
		}
		return parseOpenCodeGoModels(await res.json());
	}

	/** Live `/models` lineup (routable chat models only), catalog §4.1 / R-MC3. */
	async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
		const entries = await this.fetchCatalog(signal);
		return entries.map((entry) => entry.discovered);
	}

	private resolveProtocol(modelId: string): OpenCodeGoProtocol {
		if (this.protocol) return this.protocol;
		return classifyOpenCodeGoProtocol(modelId) === "anthropic" ? "messages" : "chat-completions";
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		// Namespace guard: the placeholder owns no concrete model and must never
		// serve inference, even if a caller bypasses the readiness gate.
		if (this.isNamespace) {
			throw new LLMError(
				"opencode-go namespace backend is not directly invokable — lineup not yet resolved / backend not ready",
				PROVIDER_NAME,
			);
		}
		if (!params.threadId || params.threadId.length > MAX_OPENCODE_SESSION_ID_LENGTH) {
			throw new Error(
				`OpenCode Go requests require a non-empty Bound threadId of at most ${MAX_OPENCODE_SESSION_ID_LENGTH} characters`,
			);
		}
		const threadId = params.threadId;
		const modelId = stripOpenCodeGoModelPrefix(params.model || this.model);
		const protocol = this.resolveProtocol(modelId);
		const tools = toToolSet(params.tools);
		const headers = {
			"User-Agent": BOUND_USER_AGENT,
			"x-opencode-session": threadId,
		};
		const retryOptions = {
			maxRetries: EMPTY_COMPLETION_MAX_RETRIES,
			isAborted: () => params.signal?.aborted ?? false,
			providerName: PROVIDER_NAME,
			modelId,
		};

		yield { type: "heartbeat" };

		if (protocol === "messages") {
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
								headers,
								abortSignal: params.signal,
							}).fullStream,
						map: { estimateInputFromMessages: params.messages },
					}),
				retryOptions,
			);
			return;
		}

		if (protocol === "responses") {
			const buildMessages = (stripEncryptedReasoning: boolean) =>
				toModelMessages(params.messages, {
					cacheProvider: null,
					resolveFileRef: params.resolveFileRef,
					targetEnvelope: OPENAI_RESPONSES_ENVELOPE,
					// Replay native encrypted reasoning (store:false) so the model keeps
					// its prior chain-of-thought; blocks without it are dropped.
					reasoningProviderOptions: "openai",
					...(this.reasoningOrigin && { reasoningOrigin: this.reasoningOrigin }),
					...(stripEncryptedReasoning && { stripEncryptedReasoning: true }),
					midConversationSystem: true,
				});
			yield* withEncryptedReasoningRetry({
				build: buildMessages,
				run: (attemptMessages) =>
					withEmptyRetry(
						() =>
							mapProviderStream({
								providerName: PROVIDER_NAME,
								stream: () =>
									streamText({
										model: this.responsesProvider.responses(modelId),
										messages: attemptMessages,
										allowSystemInMessages: true,
										...(params.system && { system: params.system }),
										...(tools && { tools }),
										...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
										...(params.temperature !== undefined && {
											temperature: params.temperature,
										}),
										headers,
										abortSignal: params.signal,
										providerOptions: {
											openai: {
												store: false,
												include: ["reasoning.encrypted_content"],
												// An explicit effort means the route reasons: forceReasoning keeps
												// @ai-sdk/openai from dropping `reasoning.effort` for a model id it
												// does not recognize as a reasoning model.
												...(params.effort && {
													reasoningEffort: params.effort,
													forceReasoning: true,
												}),
											},
										},
									}).fullStream,
								map: { estimateInputFromMessages: params.messages },
							}),
						retryOptions,
					),
				onStrip: () =>
					this.logger?.warn?.(
						`[${PROVIDER_NAME}] encrypted-reasoning rejected (cross-deployment replay); retrying once with encrypted reasoning stripped`,
						{ model: modelId },
					),
			});
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
							headers,
							abortSignal: params.signal,
						}).fullStream,
					map: { estimateInputFromMessages: params.messages },
				}),
			retryOptions,
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
			...(this.contextWindow > 0 && { max_context: this.contextWindow }),
		};
	}

	fallbackSupport(): DriverFallbackSupport {
		// OpenCode Go proxies OpenAI-compatible endpoints: no refusal-fallback
		// protocol (catalog §4.2). A refusal walks the loop-host router.
		return {
			server_side_auto: false,
			publishes_allowed_targets: false,
			supports_fallback_credit: false,
		};
	}
}
