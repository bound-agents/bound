/**
 * Amazon Bedrock driver — thin shim onto `@ai-sdk/amazon-bedrock`.
 *
 * Replaced the hand-rolled Converse-API wrapper (~2000 lines).
 * The AI SDK handles:
 *   - Converse API envelope + event-stream decoding
 *   - SigV4 signing / AWS_BEARER_TOKEN_BEDROCK fallback
 *   - Retry and error shape normalization
 *   - Opus 4.7 reasoning-behavior quirks (patched in @ai-sdk/amazon-bedrock@3.0.97)
 *
 * We keep ownership of:
 *   - Message shape → ModelMessage conversion (../bridge)
 *   - Cache breakpoint placement policy (cache-stable-prefix is still ours;
 *     the driver just forwards the markers via providerOptions.bedrock.cachePoint)
 *   - Stream chunk shape translation back to our StreamChunk type
 *   - Reasoning config construction from ChatParams.thinking + ChatParams.effort
 */

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { AmazonBedrockProvider } from "@ai-sdk/amazon-bedrock";
import type { Logger } from "@bound/shared";
import { streamText } from "ai";
import type { ModelMessage } from "ai";
import {
	ANTHROPIC_ENVELOPE,
	BEDROCK_PERMISSIVE_ENVELOPE,
	toModelMessages,
	toToolSet,
} from "../bridge";
import type { DiscoveredModel } from "../catalog/discovery";
import {
	parseBedrockFoundationModels,
	parseBedrockInferenceProfiles,
} from "../catalog/discovery-fetch";
import type { CreditStep } from "../fallback-credit";
import type { DriverFallbackSupport } from "../fallback-policy";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "../types";
import { resolveAwsCredentials } from "./aws-credential-cache";
import {
	type CacheFieldDecision,
	CacheFieldRecoveryState,
	withCacheFieldRecovery,
} from "./cache-field-recovery";
import { redeemFallbackCredit } from "./credit-redemption";
import {
	creditTokenOf,
	resolveFallbackTargetFromParams,
	serverToolsRanInChunks,
} from "./credit-redemption-config";
import {
	buildReasoningOrigin,
	quantizeCacheTtl,
	resolveProviderFetch,
	runProviderStream,
} from "./shared";
import { createSigV4Fetch } from "./sigv4-fetch";
import { buildCachedSystemMessage, shouldEnableSystemCache } from "./system-cache";

interface BedrockReasoningConfig {
	type?: "enabled" | "disabled" | "adaptive";
	budgetTokens?: number;
	maxReasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
	display?: "omitted" | "summarized";
}
export class BedrockDriver implements LLMBackend {
	private provider: AmazonBedrockProvider;
	private model: string;
	private contextWindow: number;
	// Endpoint identity for the inline credit-redemption co-location check
	// (R-RT18). A fallback credit minted on this endpoint is only
	// redeemable here; `planCreditRedemption` compares the credit's minting
	// endpoint to this. Empty string when the host didn't configure a site id.
	private readonly reasoningOrigin: string;
	// Per-route prompt-cache field recovery (R-MC14): remembers when a route
	// rejected the Bedrock Converse `cachePoint` field, so later requests skip the
	// doomed field. In-memory, keyed by route; a fresh process re-learns.
	private readonly cacheRecovery = new CacheFieldRecoveryState();
	// Discovery (R-MC3): region + profile needed to sign a SigV4 control-
	// plane request to the Bedrock models-list endpoints. Stored so `discoverModels()`
	// can enumerate this host's own entitled lineup without reaching into the AI SDK.
	private readonly discoveryRegion: string;
	private readonly discoveryProfile: string | undefined;
	private readonly discoveryFetch: typeof fetch | undefined;

	constructor(config: {
		region: string;
		model: string;
		contextWindow: number;
		profile?: string;
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
		 * callers leave this unset and use `logger` instead.
		 *
		 * The harness in `packages/agent/scripts/agent-harness/` injects a
		 * capturing fetch through `createModelRouter`'s `fetchByBackendId`
		 * option to record outgoing wire bodies per turn for diagnostic
		 * inspection (cache-marker counts, byte-diff vs prior cold turn,
		 * etc.).
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
		/**
		 * This host's site id. Combined with region to form the deployment identity
		 * (`reasoningOrigin`) used for the inline credit-redemption co-location check
		 * (R-RT18). Omitted in tests that don't exercise the credited-retry path.
		 */
		siteId?: string;
	}) {
		this.model = config.model;
		this.contextWindow = config.contextWindow;
		this.discoveryRegion = config.region;
		this.discoveryProfile = config.profile;
		this.discoveryFetch = config.fetch;
		this.reasoningOrigin =
			buildReasoningOrigin({ siteId: config.siteId, provider: "bedrock", detail: config.region }) ??
			"";
		// Auth precedence (matches @ai-sdk/amazon-bedrock@4 behavior):
		//   1. apiKey / AWS_BEARER_TOKEN_BEDROCK if set (handled by the SDK)
		//   2. explicit profile via fromIni (honors SSO, sts:AssumeRole, MFA)
		//   3. fall-through to the default AWS credential chain
		// The SDK only consults credentialProvider when no bearer token is
		// present, so wiring fromIni here is safe even when a user has a
		// bearer token configured.
		const credentialProvider = config.profile
			? () => resolveAwsCredentials(config.profile)
			: undefined;
		// Custom fetch takes precedence over logger-backed fetch. When both
		// are absent the SDK uses its default fetch with zero overhead.
		const customFetch = resolveProviderFetch("bedrock", config);
		this.provider = createAmazonBedrock({
			region: config.region,
			...(credentialProvider && { credentialProvider }),
			...(customFetch && { fetch: customFetch }),
		});
	}

	/**
	 * Live provider discovery (R-MC3, catalog §4.1): enumerate this
	 * host's own entitled Bedrock lineup via the control-plane
	 * `ListFoundationModels` + `ListInferenceProfiles` endpoints, signed with the
	 * host's ambient AWS credentials (SigV4, same credential chain as the data
	 * plane). Foundation models supply base ids + vendor + modality; inference
	 * profiles add the region-prefixed cross-region routing ids, which
	 * normalization folds back onto the bare family. Throws on a non-OK response
	 * or transport failure so the caller falls back to config + `models.dev`
	 * without blocking startup; a reachable-but-empty account returns `[]`.
	 *
	 * A `fetch` override (harness/test) is used verbatim and unsigned so tests
	 * can stub the two endpoint bodies without AWS credentials.
	 */
	async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
		const host = `bedrock.${this.discoveryRegion}.amazonaws.com`;
		const fetchImpl =
			this.discoveryFetch ??
			createSigV4Fetch({
				credentials: () => resolveAwsCredentials(this.discoveryProfile),
				service: "bedrock",
				region: this.discoveryRegion,
			});
		const get = async (path: string): Promise<unknown> => {
			const res = await fetchImpl(`https://${host}${path}`, {
				headers: { accept: "application/json" },
				...(signal && { signal }),
			});
			if (!res.ok) {
				throw new Error(`bedrock model discovery failed: HTTP ${res.status} (${path})`);
			}
			return res.json();
		};
		const [foundation, profiles] = await Promise.all([
			get("/foundation-models"),
			get("/inference-profiles"),
		]);
		return [
			...parseBedrockFoundationModels(foundation),
			...parseBedrockInferenceProfiles(profiles),
		];
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		// Use `||` not `??` — callers sometimes pass `model: ""` as a "use default"
		// sentinel (see openai-compatible-driver.ts for the same note).
		const modelId = params.model || this.model;
		// Reasoning-block signature/redactedData passthrough is Anthropic-only.
		// Non-Anthropic Bedrock models (Kimi, MiniMax, GLM, Nova, …) reject
		// `reasoningContent.reasoningText.signature` outright. Detection mirrors
		// buildReasoningConfig: substring match on "anthropic" in the model id.
		// The same flag selects the wire envelope: Claude-on-Bedrock has the same
		// strict tool_use.id charset as Claude-on-Anthropic-API, while everything
		// else on Bedrock-Converse can carry the looser `[a-zA-Z0-9_.:-]{1,64}`
		// shape — notably Kimi's native `functions.<name>:<index>` fallback ids.
		const isAnthropicModel = modelId.includes("anthropic");
		const tools = toToolSet(params.tools);
		const reasoningConfig = buildReasoningConfig(params, modelId);

		// Build the messages + system anchor for ONE attempt, applying any
		// cache-field recovery decision for this route: `drop` sends no cachePoint
		// (caching disabled this turn), `use-value` resends with the provider-listed
		// ttl. `undefined` sends the configured cache_ttl. The recoverable field is
		// the Bedrock Converse `cachePoint` (its optional `ttl`).
		const buildMessages = (decision: CacheFieldDecision | undefined): ModelMessage[] => {
			const effectiveTtl: "5m" | "1h" | undefined =
				decision?.kind === "drop"
					? undefined
					: decision?.kind === "use-value" && (decision.value === "5m" || decision.value === "1h")
						? decision.value
						: quantizeCacheTtl(params.cache_ttl);
			const cachingDropped = decision?.kind === "drop";
			const bridgeMessages = toModelMessages(params.messages, {
				cacheProvider: cachingDropped ? null : "bedrock",
				cacheTtl: effectiveTtl,
				resolveFileRef: params.resolveFileRef,
				// Anthropic-on-Bedrock replays its signed reasoning blocks via the
				// "bedrock" policy. Non-Anthropic Converse models can't carry a
				// reasoning signature, but `null` here means "replay signature-less
				// reasoning as bare text", which re-accumulates a reasoning-heavy
				// model's prior chain-of-thought every turn — the same context bloat
				// that degraded the OpenCode Go models. Use "openai" so signature-less
				// reasoning is dropped on replay (kept only if it carries replayable
				// encrypted content), matching every other non-signature leg.
				reasoningProviderOptions: isAnthropicModel ? "bedrock" : "openai",
				targetEnvelope: isAnthropicModel ? ANTHROPIC_ENVELOPE : BEDROCK_PERMISSIVE_ENVELOPE,
			});
			const systemMessage = buildCachedSystemMessage("bedrock", {
				system: params.system,
				cacheEnabled:
					!cachingDropped &&
					shouldEnableSystemCache("bedrock", {
						cacheTtl: effectiveTtl,
						bridgeMessages,
					}),
				cacheTtl: effectiveTtl,
			});
			return systemMessage ? [systemMessage, ...bridgeMessages] : bridgeMessages;
		};

		// Build one Bedrock streaming attempt for `effectiveModel`. `credit`, when
		// set, carries the fallback-credit redemption state for an inline credited
		// retry (R-RT18, §7.3): the `fallback-credit-2026-07-01` beta rides in
		// `anthropic_beta`, the `fallback_credit_token` is added, and earlier thinking
		// blocks are NOT stripped (the shared executor's CreditStep carries
		// stripThinking:false). The step kind decides whether the token is present.
		const buildStream = (
			effectiveModel: string,
			cacheDecision: CacheFieldDecision | undefined,
			credit?: { step: CreditStep; token: string },
		): AsyncIterable<StreamChunk> => {
			const messages = buildMessages(cacheDecision);
			const betaFlags = credit ? ["fallback-credit-2026-07-01"] : undefined;
			return runProviderStream({
				modelId: effectiveModel,
				providerName: "bedrock",
				signal: params.signal,
				stream: () =>
					streamText({
						model: this.provider.languageModel(effectiveModel),
						messages,
						allowSystemInMessages: true,
						...(tools && { tools }),
						...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
						// Reasoning requests disallow temperature on Anthropic; only set it
						// when we're not in thinking mode. Mirrors the old validator gate.
						...(params.temperature !== undefined &&
							!reasoningConfig && { temperature: params.temperature }),
						abortSignal: params.signal,
						providerOptions: {
							bedrock: {
								...(reasoningConfig && { reasoningConfig }),
								// Credited retry: send the fallback-credit beta in anthropic_beta
								// and the redemption token when the step carries it. A drop-token
								// step forfeits the credit and omits the token.
								...(betaFlags && { anthropic_beta: betaFlags }),
								...(credit?.step.includeToken && {
									additionalModelRequestFields: { fallback_credit_token: credit.token },
								}),
							} as Record<string, unknown> as never,
						},
					}).fullStream,
				map: {
					usageProvider: "bedrock",
					estimateInputFromMessages: params.messages,
					// Bedrock Converse's default cache lifetime is 5m; stamp it so the cost
					// layer prices a reported 5m split entry as a matched rate.
					cacheWriteDefaultLifetime: "5m",
				},
			});
		};

		// Prompt-cache request recovery (R-MC14) wraps the credit-redemption executor:
		// on a Bedrock Converse `cachePoint` rejection, record the per-route decision
		// and reissue ONCE with the field dropped (or resent with a listed ttl). The
		// rejection is handled here, inside the driver, before the stream reaches
		// route-health — it is never a route failure and never a refusal.
		//
		// Wrap the primary attempt with the inline credit-redemption executor
		// (R-RT18, §7.3). On a co-located credit-bearing refusal it walks the planned
		// step-down, replaying the refused prompt against the fallback target; a
		// non-co-located / token-less refusal flows through for the loop-host router.
		yield* withCacheFieldRecovery({
			routeId: modelId,
			state: this.cacheRecovery,
			fields: ["cachepoint"],
			// Bedrock Converse `cachePoint.ttl` accepts only "5m"/"1h"; a listed value
			// outside that set is unusable, so the field is dropped.
			validValuesFor: () => ["5m", "1h"],
			run: (cacheDecision) =>
				redeemFallbackCredit(buildStream(modelId, cacheDecision), {
					driver: this.fallbackSupport(),
					executingEndpoint: this.reasoningOrigin,
					resolveTarget: () => resolveFallbackTargetFromParams(params, this.reasoningOrigin),
					serverToolsRan: serverToolsRanInChunks,
					runStep: (step, target, refusedChunks) => {
						const token = creditTokenOf(refusedChunks);
						return buildStream(
							target.targetModel,
							cacheDecision,
							step.includeToken ? { step, token } : { step, token: "" },
						);
					},
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
		// Bedrock Runtime: no server-side auto fallback and no published allowed
		// targets, but mints/redeems fallback-credit tokens (catalog §4.2).
		return {
			server_side_auto: false,
			publishes_allowed_targets: false,
			supports_fallback_credit: true,
		};
	}
}

/**
 * Build the `providerOptions.bedrock.reasoningConfig` payload, filtered by
 * model family so we don't send features the target model doesn't support.
 *
 * The @ai-sdk/amazon-bedrock SDK emits warnings when non-Anthropic models
 * receive `budgetTokens` or `type: "adaptive"` — those features are routed
 * through Anthropic-specific `additionalModelRequestFields.thinking`. For
 * OpenAI-on-Bedrock (`openai.*`), only `maxReasoningEffort` is forwarded (the
 * SDK maps it to `reasoning_effort`). For other non-Anthropic Converse models
 * (Amazon Nova 2, Moonshot, MiniMax, DeepSeek, GLM, …), `maxReasoningEffort`
 * travels inside `additionalModelRequestFields.reasoningConfig`, where models
 * like Nova 2 reject `maxReasoningEffort` unless `type: "enabled"` is also
 * present; `budgetTokens` and `type: "adaptive"` are still dropped.
 *
 * When `params.thinking?.type === "disabled"`, `maxReasoningEffort` is never
 * forwarded: Anthropic receives `{ type: "disabled" }`, and non-Anthropic
 * models omit `reasoningConfig` entirely so non-reasoning models (e.g. Nova
 * Pro) don't reject a stray effort from top-level `defaults.effort`.
 *
 * Detection mirrors the SDK: substring match on `"anthropic"` / `"openai"` in
 * the model id, which covers both plain ids (`anthropic.claude-opus-4-7`) and
 * inference-profile ARNs (`.../us.anthropic.claude-opus-4-7`).
 *
 * Exported so the gating behavior can be unit-tested without stubbing the
 * full AI SDK streaming stack.
 */
export function buildReasoningConfig(
	params: ChatParams,
	modelId: string,
): BedrockReasoningConfig | undefined {
	if (!params.thinking && !params.effort) return undefined;
	const isAnthropicModel = modelId.includes("anthropic");
	const isOpenAIModel = modelId.includes("openai");
	if (params.thinking?.type === "disabled") {
		return isAnthropicModel ? { type: "disabled" } : undefined;
	}
	const config: BedrockReasoningConfig = {};
	if (isAnthropicModel) {
		if (params.thinking?.type === "enabled") {
			config.type = "enabled";
			config.budgetTokens = params.thinking.budget_tokens;
		} else if (params.thinking?.type === "adaptive") {
			config.type = "adaptive";
			if (params.thinking.display) config.display = params.thinking.display;
		}
	}
	// Non-Anthropic thinking-related fields (`budgetTokens`, `type: "adaptive"`)
	// are dropped intentionally — sending them triggers AI SDK "unsupported
	// feature" warnings.
	// `effort` is a free-form string (provider-validated), so only forward it to
	// Bedrock's Converse `maxReasoningEffort` when it is one of the values that
	// field actually accepts — a foreign level (e.g. a umans-only one) must not
	// reach Bedrock.
	const BEDROCK_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
	if (params.effort && (BEDROCK_EFFORTS as readonly string[]).includes(params.effort)) {
		config.maxReasoningEffort = params.effort as (typeof BEDROCK_EFFORTS)[number];
		// Non-Anthropic, non-OpenAI Converse models (e.g. Amazon Nova 2) reject
		// `reasoningConfig.maxReasoningEffort` unless `type: "enabled"` is present.
		if (!isAnthropicModel && !isOpenAIModel) {
			config.type = "enabled";
		}
	}
	return Object.keys(config).length > 0 ? config : undefined;
}
