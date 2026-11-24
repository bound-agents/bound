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
import { ANTHROPIC_ENVELOPE, mapChunks, mapError, toModelMessages, toToolSet } from "../bridge";
import type { DiscoveredModel, SupportsModelDiscovery } from "../catalog/discovery";
import { parseAnthropicModelsList } from "../catalog/discovery-fetch";
import type { DriverFallbackSupport } from "../fallback-policy";
import { createLoggingFetch } from "../fetch-logger";
import type {
	BackendCapabilities,
	BackendReadiness,
	ChatParams,
	LLMBackend,
	StreamChunk,
} from "../types";
import { LLMError } from "../types";
import { quantizeCacheTtl } from "./bedrock";
import {
	type CacheFieldDecision,
	CacheFieldRecoveryState,
	withCacheFieldRecovery,
} from "./cache-field-recovery";
import { type CreditStep, redeemFallbackCredit } from "./credit-redemption";
import {
	resolveFallbackTargetFromParams,
	serverToolsRanInChunks,
} from "./credit-redemption-config";
import {
	NamespaceLineupReadiness,
	type NamespaceModelOverride,
	lineupFromDiscovered,
} from "./namespace-readiness";
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
	// `effort` is a free-form string (provider-validated); only forward it when
	// it is one of the values the Anthropic output_config.effort knob accepts.
	// Same gate as the Bedrock driver's BEDROCK_EFFORTS.
	const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
	if (params.effort && (ANTHROPIC_EFFORTS as readonly string[]).includes(params.effort)) {
		opts.effort = params.effort as (typeof ANTHROPIC_EFFORTS)[number];
	}
	return Object.keys(opts).length > 0 ? opts : undefined;
}

export class AnthropicDriver implements LLMBackend, SupportsModelDiscovery {
	readonly readiness?: BackendReadiness;
	private readonly isNamespace: boolean;
	private provider: AnthropicProvider;
	private model: string;
	private contextWindow: number;
	// Endpoint identity for the inline credit-redemption co-location check
	// (slice 5, R-RT18). Empty string when the host didn't configure a site id.
	private readonly reasoningOrigin: string;
	// Discovery (slice 6, R-MC3): the raw credentials/endpoint needed to query
	// `/v1/models` on demand. Stored so `discoverModels()` can hit the inventory
	// endpoint with this host's own key without reaching into the AI SDK provider.
	private readonly discoveryApiKey: string;
	private readonly discoveryBaseUrl: string;
	private readonly discoveryFetch: typeof fetch;
	// Per-route prompt-cache field recovery (R-MC14): remembers when a route
	// rejected the Anthropic Messages `cache_control` field, so later requests skip
	// the doomed field. In-memory, keyed by route; a fresh process re-learns.
	private readonly cacheRecovery = new CacheFieldRecoveryState();

	constructor(config: {
		apiKey: string;
		/**
		 * Concrete provider model id. Omitted => self-configuring namespace: the
		 * driver owns `readiness`, fetches `/v1/models`, and expands into one
		 * concrete backend per listed model (catalog §2.1).
		 */
		model?: string;
		contextWindow?: number;
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
		/**
		 * This host's site id, used to form the deployment identity (`reasoningOrigin`)
		 * for the inline credit-redemption co-location check (R-RT18). Omitted in tests
		 * that don't exercise the credited-retry path.
		 */
		siteId?: string;
		/** Namespace config id; expanded ids are `${namespaceId}-${providerModelId}`. */
		namespaceId?: string;
		/** Per-model overrides keyed by provider model id (namespace only). */
		modelOverrides?: Record<string, NamespaceModelOverride>;
		/** Lineup retry backoff base/cap (test seam). */
		lineupRetryBaseMs?: number;
		lineupRetryMaxMs?: number;
	}) {
		this.isNamespace = !config.model;
		this.model = config.model ?? "";
		this.contextWindow = config.contextWindow ?? 0;
		this.reasoningOrigin = config.siteId ? `${config.siteId}:anthropic` : "";
		const customFetch =
			config.fetch ??
			(config.logger
				? createLoggingFetch(config.logger, "anthropic", config.connectTimeoutMs)
				: undefined);
		this.discoveryApiKey = config.apiKey;
		this.discoveryBaseUrl = config.baseUrl ?? "https://api.anthropic.com/v1";
		this.discoveryFetch = customFetch ?? globalThis.fetch;
		this.provider = createAnthropic({
			apiKey: config.apiKey,
			...(config.baseUrl && { baseURL: config.baseUrl }),
			...(customFetch && { fetch: customFetch }),
		});

		if (this.isNamespace) {
			// The fetch is NOT started here — the wiring layer calls
			// `readiness.start(registrar)` once the registrar is bound.
			this.readiness = new NamespaceLineupReadiness({
				providerName: "anthropic",
				namespaceId: config.namespaceId ?? "anthropic",
				loadLineup: async (signal) => lineupFromDiscovered(await this.discoverModels(signal)),
				buildPerModelBackend: (entry, contextWindow) =>
					new AnthropicDriver({
						apiKey: config.apiKey,
						model: entry.id,
						contextWindow,
						...(config.baseUrl !== undefined && { baseUrl: config.baseUrl }),
						...(config.logger !== undefined && { logger: config.logger }),
						...(config.fetch !== undefined && { fetch: config.fetch }),
						...(config.connectTimeoutMs !== undefined && {
							connectTimeoutMs: config.connectTimeoutMs,
						}),
						...(config.siteId !== undefined && { siteId: config.siteId }),
					}),
				// Anthropic Messages honors cache_control breakpoints on every model.
				defaultPromptCaching: true,
				...(config.modelOverrides !== undefined && { modelOverrides: config.modelOverrides }),
				...(config.logger !== undefined && { logger: config.logger }),
				...(config.lineupRetryBaseMs !== undefined && { retryBaseMs: config.lineupRetryBaseMs }),
				...(config.lineupRetryMaxMs !== undefined && { retryMaxMs: config.lineupRetryMaxMs }),
			});
		}
	}

	/**
	 * Live provider discovery (slice 6, R-MC3, catalog §4.1): query Anthropic
	 * `/v1/models` with this host's own key. Sends the fallback beta header so
	 * each row may carry `allowed_fallback_models`. Total: a non-OK response or
	 * transport failure throws so the caller falls back to config + `models.dev`
	 * without blocking startup; a reachable-but-empty lineup returns `[]`.
	 */
	async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
		const url = `${this.discoveryBaseUrl.replace(/\/$/, "")}/models`;
		const res = await this.discoveryFetch(url, {
			headers: {
				accept: "application/json",
				"x-api-key": this.discoveryApiKey,
				"anthropic-version": "2023-06-01",
				"anthropic-beta": "server-side-fallback-2026-07-01",
			},
			...(signal && { signal }),
		});
		if (!res.ok) {
			throw new LLMError(
				`anthropic model discovery failed: HTTP ${res.status}`,
				"anthropic",
				res.status,
			);
		}
		return parseAnthropicModelsList(await res.json());
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		// Namespace guard: the placeholder owns no concrete model and must never
		// serve inference, even if a caller bypasses the readiness gate.
		if (this.isNamespace) {
			throw new LLMError(
				"anthropic namespace backend is not directly invokable — lineup not yet resolved / backend not ready",
				"anthropic",
			);
		}
		// Use `||` not `??` — callers sometimes pass `model: ""` as a "use default"
		// sentinel (see the other drivers for the same note).
		const modelId = params.model || this.model;
		// Direct Anthropic is the canonical strict target: tool_use ids/names use
		// the ANTHROPIC_ENVELOPE charset, reasoning replays its signature via
		// providerOptions.anthropic, and cache breakpoints route through
		// providerOptions.anthropic.cacheControl. All three are bridge defaults.
		const tools = toToolSet(params.tools);
		const reasoning = buildAnthropicReasoningOptions(params);

		// Build the messages + system anchor for ONE attempt, applying any
		// cache-field recovery decision for this route: `drop` sends no cache_control
		// (caching disabled this turn), `use-value` resends with the provider-listed
		// ttl. `undefined` sends the configured cache_ttl. The recoverable field is
		// the Anthropic Messages `cache_control` (its optional `ttl`).
		const buildMessages = (decision: CacheFieldDecision | undefined) => {
			const effectiveTtl: "5m" | "1h" | undefined =
				decision?.kind === "drop"
					? undefined
					: decision?.kind === "use-value" && (decision.value === "5m" || decision.value === "1h")
						? decision.value
						: quantizeCacheTtl(params.cache_ttl);
			const cachingDropped = decision?.kind === "drop";
			const bridgeMessages = toModelMessages(params.messages, {
				cacheProvider: cachingDropped ? null : "anthropic",
				cacheTtl: effectiveTtl,
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
				cacheEnabled:
					!cachingDropped &&
					shouldEnableAnthropicSystemCacheControl({
						cacheTtl: effectiveTtl,
						bridgeMessages,
					}),
				cacheTtl: effectiveTtl,
			});
			return systemMessage ? [systemMessage, ...bridgeMessages] : bridgeMessages;
		};

		// Emit heartbeat immediately. Extended thinking can produce a 60s+ gap
		// before the first content event, which would trip the relay silence
		// timeout. Matches the Bedrock driver's messageStart behavior.
		yield { type: "heartbeat" };

		// Build one Anthropic streaming attempt. `serverSideFallback`, when true,
		// expresses the provider's server-side automatic fallback (R-RT18, §7.3):
		// `fallbacks: "default"` + the `server-side-fallback-2026-07-01` beta, so the
		// API picks a substitute itself rather than Bound replaying a different model.
		// Earlier thinking blocks are NEVER stripped on the credited retry.
		const buildStream = (
			serverSideFallback: boolean,
			cacheDecision: CacheFieldDecision | undefined,
		): AsyncIterable<StreamChunk> => {
			const messages = buildMessages(cacheDecision);
			const result = streamText({
				model: this.provider.languageModel(modelId),
				messages,
				// The system prompt rides as a role:"system" ModelMessage at index 0 (see
				// buildAnthropicSystemMessage); ai@7 streamText rejects it unless we opt in.
				allowSystemInMessages: true,
				...(tools && { tools }),
				...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
				// Anthropic disallows temperature when extended thinking / effort is
				// active; only set it when we're not asking for reasoning.
				...(params.temperature !== undefined && !reasoning && { temperature: params.temperature }),
				abortSignal: params.signal,
				...((reasoning || serverSideFallback) && {
					providerOptions: {
						anthropic: {
							...(reasoning ?? {}),
							// Server-side automatic fallback: the API selects a substitute
							// model and redeems the prompt-cache credit inline.
							...(serverSideFallback && {
								fallbacks: "default",
								anthropicBeta: ["server-side-fallback-2026-07-01"],
							}),
						} as Record<string, unknown> as never,
					},
				}),
			});
			return (async function* () {
				try {
					yield* mapChunks(result.fullStream, {
						usageProvider: "anthropic",
						estimateInputFromMessages: params.messages,
						providerName: "anthropic",
						// Anthropic Messages' default cache lifetime is 5m; stamp it so the
						// cost layer prices a reported 5m split entry as a matched rate.
						cacheWriteDefaultLifetime: "5m",
					});
				} catch (err) {
					throw mapError(err, "anthropic");
				}
			})();
		};

		// Prompt-cache request recovery (R-MC14) wraps the credit-redemption executor:
		// on an Anthropic Messages `cache_control` rejection, record the per-route
		// decision and reissue ONCE with the field dropped (or resent with a listed
		// ttl). The rejection is handled here, inside the driver, before the stream
		// reaches route-health — it is never a route failure and never a refusal.
		//
		// Wrap the primary attempt with the inline credit-redemption executor. On a
		// co-located credit-bearing refusal the planner (server_side_auto) returns a
		// single server-side-fallback step, so the replay re-issues with the
		// server-side fallback directive; a non-co-located / token-less refusal flows
		// through to the loop-host router.
		yield* withCacheFieldRecovery({
			routeId: modelId,
			state: this.cacheRecovery,
			fields: ["cache_control"],
			// Anthropic Messages `cache_control.ttl` accepts only "5m"/"1h"; a listed
			// value outside that set is unusable, so the field is dropped.
			validValuesFor: () => ["5m", "1h"],
			run: (cacheDecision) =>
				redeemFallbackCredit(buildStream(false, cacheDecision), {
					driver: this.fallbackSupport(),
					executingEndpoint: this.reasoningOrigin,
					resolveTarget: () => resolveFallbackTargetFromParams(params, this.reasoningOrigin),
					serverToolsRan: serverToolsRanInChunks,
					runStep: (step: CreditStep) =>
						buildStream(step.kind === "server-side-fallback", cacheDecision),
				}),
		});
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

	fallbackSupport(): DriverFallbackSupport {
		// Anthropic direct API: server-side automatic fallback, publishes per-model
		// allowed_fallback_models, and mints/redeems fallback-credit tokens (catalog §4.2).
		return {
			server_side_auto: true,
			publishes_allowed_targets: true,
			supports_fallback_credit: true,
		};
	}
}
