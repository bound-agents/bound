/**
 * Bedrock Mantle driver.
 *
 * AWS serves multiple protocol surfaces behind `bedrock-mantle.{region}.api.aws`:
 *   - OpenAI GPT-5.x on an OpenAI-compatible Responses API at `/openai/v1`
 *   - Anthropic Claude on an Anthropic Messages API at `/anthropic/v1`
 *
 * Both surfaces authenticate with AWS SigV4 rather than a bearer token / API
 * key. The OpenAI Responses combination rules out the `openai-compatible`
 * driver two ways:
 *   1. `@ai-sdk/openai-compatible` speaks only `/chat/completions`; mantle
 *      GPT-5.x is Responses-only.
 *   2. its auth is a static API key, not request signing.
 *
 * So this driver pairs the *native* `@ai-sdk/openai` provider — the only
 * AI-SDK surface with a `.responses()` model — with a SigV4-signing `fetch`
 * (see `createSigV4Fetch`). The OpenAI provider still wants an `apiKey`; we
 * hand it a sentinel because the SigV4 `Authorization` header produced by
 * the signing fetch overwrites the SDK's `Bearer` header on the wire.
 *
 * Credentials come from the same place as the Bedrock driver: an explicit
 * profile via `fromIni` (honors SSO / sts:AssumeRole) when configured, else
 * the ambient node provider chain. Signing happens per-request inside the
 * fetch, so a short-term/SSO credential's rotation is honored without the
 * driver holding a long-lived token — the constraint on hosts that forbid
 * long-lived credentials.
 *
 * Caching: two regimes by model generation.
 *   - GPT-5.4/5.5: automatic prefix caching only, no marker mechanism. The
 *     driver places no breakpoints (`cacheProvider: null`) yet reports
 *     `prompt_caching: true`. Mantle's automatic cache is exact-match (see
 *     buildMantleOpenAIOptions docstring), so agent traffic gets ~0 reads.
 *   - GPT-5.6 family: accepts up to FOUR explicit `prompt_cache_breakpoint`s
 *     per request (see `supportsPromptCacheBreakpoints`). The driver spends
 *     one on the system/instructions message (stable-prefix anchor) and
 *     passes `cacheProvider: "openai"` so the agent loop's `{role:"cache"}`
 *     markers become message/part-level breakpoints via the bridge (capped
 *     at MAX_OPENAI_MESSAGE_BREAKPOINTS = 3).
 * Both regimes MUST request `promptCacheRetention: "24h"` — GPT-5.x doesn't
 * support the `in_memory` default and caches nothing without it (see
 * `buildMantleOpenAIOptions`). Cached-token accounting rides the existing
 * bridge path — `extractUsage` reads `cachedInputTokens` into
 * `cache_read_tokens`, which the agent-loop folds into contextDebug.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { Logger } from "@bound/shared";
import { streamText } from "ai";
import { ANTHROPIC_ENVELOPE, PERMISSIVE_ENVELOPE, toModelMessages, toToolSet } from "../bridge";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "../types";
import { resolveAwsCredentials } from "./aws-credential-cache";
import {
	EMPTY_COMPLETION_MAX_RETRIES,
	mapProviderStream,
	resolveProviderFetch,
	withEmptyRetry,
} from "./shared";
import { type SigV4Credentials, createSigV4Fetch } from "./sigv4-fetch";

// Re-exported for the driver test suite; canonical definition lives in ./shared.
import { quantizeCacheTtl } from "./bedrock";
export { withEmptyRetry } from "./shared";

/**
 * Whether the model accepts explicit `prompt_cache_breakpoint` markers on
 * the Responses API. GPT-5.6 family only (sol/terra/luna and any dated
 * variants): up to four breakpoints per request. GPT-5.4/5.5 reject the
 * field — they only have the automatic (exact-match, see gotchas) cache.
 * Mantle ids carry an "openai." prefix ("openai.gpt-5.6-terra"), so match
 * on substring rather than prefix.
 */
export function supportsPromptCacheBreakpoints(modelId: string): boolean {
	return modelId.includes("gpt-5.6");
}

/** SigV4 service name for the Bedrock mantle endpoint. */
const MANTLE_SIGV4_SERVICE = "bedrock";

const PROVIDER_NAME = "bedrock-mantle";

export type BedrockMantleProviderMode = "anthropic" | "openai_responses";

// Empty-completion retry bound. Mantle GPT-5.x intermittently returns empty
// turns (~12% observed at the bare endpoint under store:false); store:true —
// the one lever that might reduce it — is forbidden by the zero-retention
// requirement, so the driver retries instead. At ~12% independent, 2 retries
// drives the user-visible empty rate to ~0.2%. The retry mechanism is shared
// across drivers; see withEmptyRetry.

/**
 * Derives the region-scoped mantle Responses base URL. The native OpenAI
 * provider appends `/responses` to this, so it stops at the `/openai/v1`
 * prefix. An explicit override wins verbatim — the one knob for adjusting
 * the path without a code change if AWS's routing differs by region.
 */
export function deriveMantleBaseUrl(region: string, override?: string): string {
	return override ?? `https://bedrock-mantle.${region}.api.aws/openai/v1`;
}

/**
 * Derives the region-scoped Mantle base URL for the selected protocol. The AI
 * SDK provider appends the terminal route (`/responses` or `/messages`), so
 * both defaults stop at the version prefix.
 */
export function deriveMantleBaseUrlForMode(
	region: string,
	mode: BedrockMantleProviderMode,
	override?: string,
): string {
	if (override) return override;
	switch (mode) {
		case "anthropic":
			return `https://bedrock-mantle.${region}.api.aws/anthropic/v1`;
		case "openai_responses":
			return deriveMantleBaseUrl(region);
	}
}

/**
 * The Anthropic SDK requires an apiKey and adds an `x-api-key` header. Mantle's
 * Anthropic Messages endpoint also accepts pure SigV4; strip the placeholder
 * key before signing so the wire request carries only AWS auth.
 */
function stripPlaceholderAnthropicApiKeyFetch(baseFetch: typeof fetch): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const request = new Request(input as RequestInfo | URL, init);
		request.headers.delete("x-api-key");
		return baseFetch(request);
	}) as typeof fetch;
}

/** Maps bound's `"max"` effort to OpenAI's strongest supported level; unsupported values omit the option. */
function toReasoningEffort(
	effort: ChatParams["effort"],
): "low" | "medium" | "high" | "xhigh" | undefined {
	switch (effort) {
		case "low":
		case "medium":
		case "high":
		case "xhigh":
			return effort;
		case "max":
			return "xhigh";
		default:
			return undefined;
	}
}

/**
 * Mantle's `openai.` model IDs bypass the SDK's reasoning-model detection, so `forceReasoning` preserves
 * `reasoningEffort`. `store: false` satisfies zero retention; GPT-5.x requires `promptCacheRetention: "24h"`.
 * See the Mantle cache gotcha for 5.4/5.5 exact-match behavior and 5.6 breakpoints.
 */
export function buildMantleOpenAIOptions(
	effort: ChatParams["effort"],
	reasoningDisabled = false,
): Record<string, string | boolean> {
	const reasoningEffort = reasoningDisabled ? "none" : toReasoningEffort(effort);
	return {
		store: false,
		promptCacheRetention: "24h",
		forceReasoning: true,
		...(reasoningEffort && { reasoningEffort }),
	};
}

export class BedrockMantleDriver implements LLMBackend {
	private openaiProvider?: ReturnType<typeof createOpenAI>;
	private anthropicProvider?: ReturnType<typeof createAnthropic>;
	private model: string;
	private contextWindow: number;
	private providerMode: BedrockMantleProviderMode;
	private logger?: Logger;

	constructor(config: {
		region: string;
		model: string;
		contextWindow: number;
		providerMode: BedrockMantleProviderMode;
		/** Explicit AWS profile (honors SSO/AssumeRole). Falls back to the node chain. */
		profile?: string;
		/** Override the derived mantle base URL (path differs by region, etc.). */
		baseUrl?: string;
		logger?: Logger;
		/**
		 * Custom fetch for wire-body interception (harness/test only). When set,
		 * it is the transport the SigV4 fetch delegates to, so a test can observe
		 * the signed request. Production leaves this unset and uses `logger`.
		 */
		fetch?: typeof fetch;
		/** Test seam for deterministic signing without touching the AWS chain. */
		credentials?: () => Promise<SigV4Credentials>;
		/** Per-backend connect / time-to-first-byte deadline (ms). */
		connectTimeoutMs?: number;
	}) {
		this.model = config.model;
		this.contextWindow = config.contextWindow;
		this.providerMode = config.providerMode;
		this.logger = config.logger;

		// Lazy credential provider — resolved per request inside the SigV4 fetch,
		// never at construction. fromIni honors SSO/AssumeRole for an explicit
		// profile; the node chain covers env / SSO cache / instance roles. The
		// shared resolver also honors a pending one-shot config-cache bust (SIGHUP),
		// re-reading ~/.aws/config once after a reload instead of per request.
		const credentials = config.credentials ?? (() => resolveAwsCredentials(config.profile));

		// Transport the signed request is handed to: explicit override (tests) →
		// logger-backed fetch → global fetch (inside createSigV4Fetch's default).
		const baseFetch = resolveProviderFetch(PROVIDER_NAME, config);

		const signedFetch = createSigV4Fetch({
			credentials,
			service: MANTLE_SIGV4_SERVICE,
			region: config.region,
			baseFetch,
		});

		if (config.providerMode === "anthropic") {
			this.anthropicProvider = createAnthropic({
				name: PROVIDER_NAME,
				baseURL: deriveMantleBaseUrlForMode(config.region, config.providerMode, config.baseUrl),
				// Placeholder only; stripPlaceholderAnthropicApiKeyFetch removes it
				// before SigV4 signing.
				apiKey: "sigv4",
				fetch: stripPlaceholderAnthropicApiKeyFetch(signedFetch),
			});
		} else {
			this.openaiProvider = createOpenAI({
				baseURL: deriveMantleBaseUrlForMode(config.region, config.providerMode, config.baseUrl),
				// SigV4 supplies the real Authorization header; this sentinel only keeps
				// the SDK from throwing on a missing key. It is overwritten on the wire.
				apiKey: "sigv4",
				fetch: signedFetch,
			});
		}
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		// `||` not `??`: callers pass `model: ""` as a "use default" sentinel.
		const modelId = params.model || this.model;
		const tools = toToolSet(params.tools);

		yield { type: "heartbeat" };

		if (this.providerMode === "anthropic") {
			const provider = this.anthropicProvider;
			if (!provider) throw new Error("Bedrock Mantle Anthropic provider was not initialized");
			const messages = toModelMessages(params.messages, {
				cacheProvider: "anthropic",
				cacheTtl: quantizeCacheTtl(params.cache_ttl),
				resolveFileRef: params.resolveFileRef,
				targetEnvelope: ANTHROPIC_ENVELOPE,
				reasoningProviderOptions: "anthropic",
				midConversationSystem: true,
			});
			const runAttempt = (): AsyncIterable<StreamChunk> =>
				mapProviderStream({
					providerName: PROVIDER_NAME,
					stream: () =>
						streamText({
							model: provider.messages(modelId),
							messages,
							allowSystemInMessages: true,
							...(params.system && { system: params.system }),
							...(tools && { tools }),
							...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
							...(params.temperature !== undefined && { temperature: params.temperature }),
							...(params.top_p !== undefined && { topP: params.top_p }),
							...(tools && params.tool_choice && { toolChoice: params.tool_choice }),
							abortSignal: params.signal,
							...(params.thinking?.type === "disabled" && {
								providerOptions: {
									anthropic: { thinking: { type: "disabled" } },
								},
							}),
						}).fullStream,
					map: { estimateInputFromMessages: params.messages, usageProvider: "anthropic" },
				});

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
			return;
		}

		const provider = this.openaiProvider;
		if (!provider) throw new Error("Bedrock Mantle OpenAI Responses provider was not initialized");
		// Cache-provider selection by model generation: the GPT-5.6 family
		// accepts explicit `prompt_cache_breakpoint` markers (up to four per
		// request), so `{role:"cache"}` markers from the agent loop become
		// `providerOptions.openai.promptCacheBreakpoint` via the bridge's
		// position-aware attacher. GPT-5.4/5.5 reject the field — markers are
		// dropped (null) and those models ride the automatic exact-match cache
		// (≈ zero reads at agent-loop depth; see docs/gotchas.md). Permissive
		// envelope: ids/names round-trip raw with only the length cap as a
		// backstop.
		const breakpointsSupported = supportsPromptCacheBreakpoints(modelId);
		const messages = toModelMessages(params.messages, {
			cacheProvider: breakpointsSupported ? "openai" : null,
			resolveFileRef: params.resolveFileRef,
			targetEnvelope: PERMISSIVE_ENVELOPE,
			// Replay native OpenAI reasoning state (store:false encrypted content)
			// so GPT-5.x reconstructs its prior chain-of-thought across turns —
			// tool-call-justification continuity. buildReasoningPart keeps thinking
			// blocks that carry reasoning_encrypted_content and drops those that
			// don't (prior opus/Anthropic blocks, signature-only): @ai-sdk/openai
			// would skip the latter under store:false with a per-block warning, so
			// dropping at the boundary is equivalent and silences the flood.
			reasoningProviderOptions: "openai",
			midConversationSystem: true,
		});

		// System-anchor breakpoint (GPT-5.6 family): spend one of the four
		// breakpoints on the system/instructions message so the big stable
		// prefix (persona + orientation + schema + volatile-stable) caches at
		// its boundary even when no message-level marker lands. Passing a
		// SystemModelMessage (not a bare string) lets providerOptions ride
		// through standardizePrompt → convertToLanguageModelPrompt → the
		// Responses converter's system/developer branch, which reads
		// MESSAGE-level promptCacheBreakpoint. Mirrors the Bedrock driver's
		// system cachePoint anchor (see bedrock.ts "Cache-anchor gating").
		const systemParam = params.system
			? breakpointsSupported
				? {
						role: "system" as const,
						content: params.system,
						providerOptions: {
							openai: { promptCacheBreakpoint: { mode: "explicit" as const } },
						},
					}
				: params.system
			: undefined;

		// One streaming attempt — built fresh per retry so a re-issue is a clean
		// new request (new SigV4 signature, new stream), not a replayed one.
		const runAttempt = (): AsyncIterable<StreamChunk> =>
			mapProviderStream({
				providerName: PROVIDER_NAME,
				stream: () =>
					streamText({
						model: provider.responses(modelId),
						messages,
						allowSystemInMessages: true,
						...(systemParam && { system: systemParam }),
						...(tools && { tools }),
						...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
						...(params.temperature !== undefined && { temperature: params.temperature }),
						...(params.top_p !== undefined && { topP: params.top_p }),
						...(tools && params.tool_choice && { toolChoice: params.tool_choice }),
						abortSignal: params.signal,
						providerOptions: {
							openai: buildMantleOpenAIOptions(params.effort, params.thinking?.type === "disabled"),
						},
					}).fullStream,
				map: {
					estimateInputFromMessages: params.messages,
					// Mantle GPT-5.x streams the answer as a sequence of progressively
					// re-stated `message` items (each a prefix-extension of the prior,
					// interleaved with reasoning rounds). Without coalescing, the
					// default `outputText += text` concatenates every draft and a
					// single reply lands N-fold duplicated — verified live
					// against gpt-5.5 (sixfold). Emit only forward progress so the
					// stream converges to exactly the final item.
					coalescePrefixItems: true,
				},
			});

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
			// OpenAI Responses mode caches automatically; Anthropic mode uses
			// explicit Anthropic cache_control breakpoints.
			prompt_caching: true,
			vision: true,
			extended_thinking: this.providerMode === "anthropic",
			max_context: this.contextWindow,
		};
	}
}
