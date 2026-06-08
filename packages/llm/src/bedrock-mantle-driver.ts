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
 * How many times to re-issue a turn that came back empty (output_tokens=0,
 * no content). Mantle GPT-5.x intermittently returns such completions
 * (~12% observed at the bare endpoint under store:false); store:true — the
 * one lever that might reduce it — is forbidden by the zero-retention
 * requirement, so the driver retries instead. At ~12% independent, 2 retries
 * drives the user-visible empty rate to ~0.2%. An empty turn is a no-op
 * (yields only a `done` chunk), so retrying before yielding anything
 * substantive duplicates nothing.
 */
const EMPTY_COMPLETION_MAX_RETRIES = 2;

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

/**
 * Builds the `providerOptions.openai` payload for a mantle turn.
 *
 * `forceReasoning: true` is load-bearing, not cosmetic. The native
 * `@ai-sdk/openai` provider detects reasoning models by `modelId.startsWith
 * ("gpt-5")` — but mantle ids carry an `openai.` prefix (`openai.gpt-5.5`),
 * so the SDK misclassifies them as non-reasoning and silently strips
 * `reasoningEffort`: verified on the wire, the request body ends up with no
 * `reasoning` field at all and the configured effort never reaches the model.
 * Forcing the flag restores it (`reasoning: { effort }` on the wire) and
 * flips the system prompt to the `developer` role reasoning models expect.
 *
 * `store: false` keeps the turn stateless — nothing persists on AWS's side
 * (the zero-retention requirement). Caching is prefix-based and needs no
 * stored response (#155).
 */
export function buildMantleOpenAIOptions(
	effort: ChatParams["effort"],
): Record<string, string | boolean> {
	const reasoningEffort = toReasoningEffort(effort);
	return {
		store: false,
		forceReasoning: true,
		...(reasoningEffort && { reasoningEffort }),
	};
}

/**
 * Wraps a streaming attempt with a bounded retry for *empty* completions —
 * a turn that finishes with `output_tokens === 0` and emitted no content.
 * Mantle GPT-5.x returns these intermittently (~12% at the bare endpoint
 * under the required `store: false`; see `EMPTY_COMPLETION_MAX_RETRIES`).
 *
 * The retry is safe because an empty turn yields ONLY a terminal `done`
 * chunk (no `text` / `thinking` / `tool_use_*`), so discarding that `done`
 * and re-issuing duplicates nothing the consumer has seen. The moment any
 * substantive chunk is yielded, `sawContent` latches and the turn can no
 * longer be retried — content already on the wire cannot be un-yielded, so
 * a streamed turn whose usage happens to round to 0 is passed through as-is.
 * Errors are not retried: `mapChunks` throws on error events, which
 * propagates out to the driver's existing `mapError` path.
 */
export async function* withEmptyRetry(
	runAttempt: () => AsyncIterable<StreamChunk>,
	opts: {
		maxRetries: number;
		isAborted: () => boolean;
		onRetry?: (attempt: number) => void;
	},
): AsyncIterable<StreamChunk> {
	for (let attempt = 0; ; attempt++) {
		const isLastAttempt = attempt >= opts.maxRetries;
		let sawContent = false;
		let retrying = false;

		for await (const chunk of runAttempt()) {
			if (chunk.type === "done") {
				const isEmpty = !sawContent && chunk.usage.output_tokens === 0;
				if (isEmpty && !isLastAttempt && !opts.isAborted()) {
					// Swallow this empty `done` and re-issue. Nothing substantive
					// was yielded, so the consumer never sees the discarded turn.
					opts.onRetry?.(attempt + 1);
					retrying = true;
					break;
				}
				yield chunk;
				return;
			}
			if (
				chunk.type === "text" ||
				chunk.type === "thinking" ||
				chunk.type === "tool_use_start" ||
				chunk.type === "tool_use_args" ||
				chunk.type === "tool_use_end"
			) {
				sawContent = true;
			}
			yield chunk;
		}

		// Stream ended without a `done` and we are not retrying (e.g. aborted
		// mid-flight): nothing more to emit.
		if (!retrying) return;
	}
}

export class BedrockMantleDriver implements LLMBackend {
	private provider: ReturnType<typeof createOpenAI>;
	private model: string;
	private contextWindow: number;
	private logger?: Logger;

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
		this.logger = config.logger;

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

		yield { type: "heartbeat" };

		// One streaming attempt — built fresh per retry so a re-issue is a clean
		// new request (new SigV4 signature, new stream), not a replayed one.
		const runAttempt = (): AsyncIterable<StreamChunk> => {
			const result = streamText({
				model: this.provider.responses(modelId),
				messages,
				...(params.system && { system: params.system }),
				...(tools && { tools }),
				...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
				...(params.temperature !== undefined && { temperature: params.temperature }),
				abortSignal: params.signal,
				providerOptions: { openai: buildMantleOpenAIOptions(params.effort) },
			});
			return mapChunks(result.fullStream, {
				estimateInputFromMessages: params.messages,
				providerName: PROVIDER_NAME,
				// Mantle GPT-5.x streams the answer as a sequence of progressively
				// re-stated `message` items (each a prefix-extension of the prior,
				// interleaved with reasoning rounds). Without coalescing, the
				// default `outputText += text` concatenates every draft and a
				// single reply lands N-fold duplicated — verified live 2026-06-07
				// against gpt-5.5 (sixfold). Emit only forward progress so the
				// stream converges to exactly the final item.
				coalescePrefixItems: true,
			});
		};

		try {
			yield* withEmptyRetry(runAttempt, {
				maxRetries: EMPTY_COMPLETION_MAX_RETRIES,
				isAborted: () => params.signal?.aborted ?? false,
				onRetry: (attempt) =>
					this.logger?.warn?.(
						`[${PROVIDER_NAME}] empty completion (output_tokens=0), retrying (attempt ${attempt}/${EMPTY_COMPLETION_MAX_RETRIES})`,
						{ model: modelId },
					),
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
