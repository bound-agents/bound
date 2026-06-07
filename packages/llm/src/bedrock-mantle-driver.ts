/**
 * Bedrock Mantle driver — OpenAI GPT-5.x on the Bedrock "mantle" surface.
 *
 * AWS serves the OpenAI GPT-5.x models (issue #155) on an OpenAI-compatible
 * Responses API at `https://bedrock-mantle.{region}.api.aws/openai/v1`, but
 * authenticates with AWS SigV4 rather than a bearer token. That combination
 * rules out the `openai-compatible` driver two ways:
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
 * Caching: mantle GPT-5.x caches automatically on the input prefix with no
 * markers, so the driver places no cache breakpoints (`cacheProvider: null`)
 * yet reports `prompt_caching: true`. Cached-token accounting rides the
 * existing bridge path — `extractUsage` reads `cachedInputTokens` into
 * `cache_read_tokens`, which the agent-loop folds into contextDebug.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { fromIni, fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { Logger } from "@bound/shared";
import { streamText } from "ai";
import {
	PERMISSIVE_ENVELOPE,
	mapChunks,
	mapError,
	toModelMessages,
	toToolSet,
} from "./ai-sdk-bridge";
import { createLoggingFetch } from "./fetch-logger";
import { createSigV4Fetch } from "./sigv4-fetch";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "./types";

/** SigV4 service name for the Bedrock mantle endpoint. */
const MANTLE_SIGV4_SERVICE = "bedrock";

const PROVIDER_NAME = "bedrock-mantle";

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
 * Maps bound's `ChatParams.effort` onto the Responses API's `reasoningEffort`
 * enum. bound's scale has a `"max"` that the OpenAI surface doesn't; it folds
 * onto the strongest supported level (`"xhigh"`). Anything outside the
 * supported set is dropped (returns undefined → omit the option).
 */
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

export class BedrockMantleDriver implements LLMBackend {
	private provider: ReturnType<typeof createOpenAI>;
	private model: string;
	private contextWindow: number;

	constructor(config: {
		region: string;
		model: string;
		contextWindow: number;
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
		/** Per-backend connect / time-to-first-byte deadline (ms). */
		connectTimeoutMs?: number;
	}) {
		this.model = config.model;
		this.contextWindow = config.contextWindow;

		// Lazy credential provider — resolved per request inside the SigV4 fetch,
		// never at construction. fromIni honors SSO/AssumeRole for an explicit
		// profile; the node chain covers env / SSO cache / instance roles.
		const credentialProvider = config.profile
			? fromIni({ profile: config.profile })
			: fromNodeProviderChain();
		const credentials = async () => {
			const c = await credentialProvider();
			return {
				accessKeyId: c.accessKeyId,
				secretAccessKey: c.secretAccessKey,
				sessionToken: c.sessionToken,
			};
		};

		// Transport the signed request is handed to: explicit override (tests) →
		// logger-backed fetch → global fetch (inside createSigV4Fetch's default).
		const baseFetch =
			config.fetch ??
			(config.logger
				? createLoggingFetch(config.logger, PROVIDER_NAME, config.connectTimeoutMs)
				: undefined);

		const signedFetch = createSigV4Fetch({
			credentials,
			service: MANTLE_SIGV4_SERVICE,
			region: config.region,
			baseFetch,
		});

		this.provider = createOpenAI({
			baseURL: deriveMantleBaseUrl(config.region, config.baseUrl),
			// SigV4 supplies the real Authorization header; this sentinel only keeps
			// the SDK from throwing on a missing key. It is overwritten on the wire.
			apiKey: "sigv4",
			fetch: signedFetch,
		});
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		// `||` not `??`: callers pass `model: ""` as a "use default" sentinel.
		const modelId = params.model || this.model;
		// Responses API has no cache-breakpoint marker — drop cache-role messages
		// via null cacheProvider (caching is automatic, prefix-based). Permissive
		// envelope: ids/names round-trip raw with only the length cap as a backstop.
		const messages = toModelMessages(params.messages, {
			cacheProvider: null,
			resolveFileRef: params.resolveFileRef,
			targetEnvelope: PERMISSIVE_ENVELOPE,
		});
		const tools = toToolSet(params.tools);
		const reasoningEffort = toReasoningEffort(params.effort);

		yield { type: "heartbeat" };

		const result = streamText({
			model: this.provider.responses(modelId),
			messages,
			...(params.system && { system: params.system }),
			...(tools && { tools }),
			...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
			...(params.temperature !== undefined && { temperature: params.temperature }),
			abortSignal: params.signal,
			providerOptions: {
				openai: {
					// Stateless: never persist prompt/response on AWS's side. Caching
					// is prefix-based and needs no stored response (#155).
					store: false,
					...(reasoningEffort && { reasoningEffort }),
				},
			},
		});

		try {
			yield* mapChunks(result.fullStream, {
				estimateInputFromMessages: params.messages,
				providerName: PROVIDER_NAME,
			});
		} catch (err) {
			throw mapError(err, PROVIDER_NAME);
		}
	}

	capabilities(): BackendCapabilities {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			// Mantle GPT-5.x caches automatically (prefix-based, no markers). The
			// driver places no breakpoints but caching is real, so the honest
			// capability is true — cached tokens flow through extractUsage.
			prompt_caching: true,
			vision: true,
			// GPT-5.x reasoning is internal to the Responses API (steered by
			// reasoningEffort), not the Anthropic-style signed thinking-block path.
			extended_thinking: false,
			max_context: this.contextWindow,
		};
	}
}
