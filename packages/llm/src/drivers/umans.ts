/**
 * umans.ai driver — Anthropic Messages route (`POST /v1/messages`).
 *
 * Modeled on the Anthropic leg of OpenCodeGoDriver. The key differences:
 *  - `cacheProvider: "anthropic"` + `usageProvider: "anthropic"` so prompt-cache
 *    breakpoints are emitted and cached-token usage surfaces in the debugger
 *    (OpenCodeGo passes `null` for both); `prompt_caching: true`.
 *  - Self-configuring: a single config entry (`provider:"umans"` + `api_key`)
 *    registers a not-ready NAMESPACE placeholder; a background lineup fetch
 *    (`/v1/models/info` + `/v1/models` + `/v1/usage`) then materializes ONE
 *    router backend per umans model id via the generic `ModelRegistrar`.
 *  - An in-process concurrency semaphore (shared per account/api_key, sized
 *    from `/v1/usage`) throttles in-flight `chat()` streams.
 *  - Reasoning is driven by a top-level `reasoning_effort` body field (a umans
 *    extension on the Anthropic route), injected per call by a fetch wrapper
 *    since the AI SDK won't forward an unknown field.
 *
 * Two roles for `UmansDriver`:
 *  (i)  lineup/namespace driver — built from the config entry with NO modelId.
 *       Owns the `UmansAccount` (provider factory, semaphore, usage cache),
 *       exposes `readiness`, and drives expansion. Its `chat()` is a guard
 *       that throws.
 *  (ii) per-model drivers — created during expansion, each bound to a concrete
 *       modelId, sharing the lineup driver's `UmansAccount` (so all N drivers
 *       acquire the SAME semaphore — the concurrency limit is per-account).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { Logger } from "@bound/shared";
import { streamText } from "ai";
import { ANTHROPIC_ENVELOPE, toModelMessages, toToolSet } from "../bridge";
import type {
	BackendCapabilities,
	BackendReadiness,
	ChatParams,
	LLMBackend,
	ModelDescriptor,
	ModelRegistrar,
	StreamChunk,
} from "../types";
import { LLMError } from "../types";
import {
	UMANS_ANTHROPIC_BASE,
	type UmansModelMeta,
	type UmansUsage,
	deriveUmansTiers,
	fetchUmansModelMetadata,
	fetchUmansUsage,
} from "../umans-metadata";
import {
	EMPTY_COMPLETION_MAX_RETRIES,
	mapProviderStream,
	resolveProviderFetch,
	withEmptyRetry,
} from "./shared";

const PROVIDER_NAME = "umans";
/** Pro-safe default until the lineup fetch sets the real account limit. */
const DEFAULT_CONCURRENCY = 3;
/** Lazy usage-refresh TTL. */
const USAGE_TTL_MS = 30_000;
/** Retry/backoff caps for the background lineup fetch. */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60_000;

/**
 * Minimal async semaphore. `acquire()` resolves when a slot is free;
 * `release()` frees one. FIFO via a waiter queue. Capacity is fixed at
 * construction (the per-account `/v1/usage` concurrency limit) — not resized
 * mid-flight.
 */
export class Semaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];
	readonly capacity: number;

	constructor(capacity: number) {
		this.capacity = Math.max(1, capacity);
		this.available = this.capacity;
	}

	/** Currently free permits — for tests/observability. */
	get permits(): number {
		return this.available;
	}

	acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.waiters.push(() => {
				// Slot was handed directly to this waiter (available stays
				// decremented), so resolve without touching the counter.
				resolve();
			});
		});
	}

	release(): void {
		const next = this.waiters.shift();
		if (next) {
			// Hand the freed slot straight to the next waiter.
			next();
			return;
		}
		if (this.available < this.capacity) this.available++;
	}
}

/**
 * Shared per-account state. ONE instance per umans api_key. Created by the
 * lineup driver; referenced by every per-model driver so they all gate on the
 * same semaphore and share the usage cache.
 */
export interface UmansAccount {
	apiKey: string;
	baseUrl: string;
	/**
	 * Build an AI SDK Anthropic provider whose outgoing request body carries a
	 * top-level `reasoning_effort` (a umans extension on the Anthropic route —
	 * native Anthropic has no such field, and `@ai-sdk/anthropic` would drop it
	 * from `providerOptions`). Constructed per `chat()` call so each call's
	 * effort is injected race-free. When `reasoningEffort` is undefined the
	 * provider sends no such field (umans's own default applies).
	 */
	makeProvider(reasoningEffort?: string): ReturnType<typeof createAnthropic>;
	semaphore: Semaphore;
	/** Lazily-refreshed usage cache. */
	usageCache: { value?: UmansUsage; fetchedAt: number };
	logger?: Logger;
	/** Injectable for tests; default = the real fetchers. */
	metadataFetch: typeof fetchUmansModelMetadata;
	usageFetch: typeof fetchUmansUsage;
}

/**
 * Wrap a fetch so the outgoing JSON request body gains a top-level
 * `reasoning_effort` field. umans's Anthropic route reads this top-level param;
 * it is NOT a native Anthropic field, so it must be injected at the transport
 * layer (the AI SDK drops unknown `providerOptions.anthropic` keys). Bodies
 * that aren't JSON objects pass through untouched.
 */
function reasoningEffortFetch(
	base: typeof globalThis.fetch,
	reasoningEffort: string,
): typeof globalThis.fetch {
	// Only the call signature is implemented; the SDK never invokes
	// `preconnect`/`bind` on a custom fetch, so the cast is safe (mirrors
	// createLoggingFetch).
	const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (init?.body && typeof init.body === "string") {
			try {
				const parsed = JSON.parse(init.body) as Record<string, unknown>;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					parsed.reasoning_effort = reasoningEffort;
					return base(input, { ...init, body: JSON.stringify(parsed) });
				}
			} catch {
				// Non-JSON body — pass through unchanged.
			}
		}
		return base(input, init);
	};
	return wrapped as typeof fetch;
}

interface UmansDriverOptions {
	account: UmansAccount;
	/** Concrete model id for per-model drivers; undefined for the namespace. */
	modelId?: string;
	/** Capabilities for a per-model driver (from the fetched lineup). */
	capabilities?: BackendCapabilities;
	/**
	 * This model's advertised `reasoning.levels` (from `/v1/models/info`), used
	 * to validate a requested effort. Undefined/empty → accept any non-empty
	 * effort verbatim (umans validates server-side).
	 */
	reasoningLevels?: string[];
	/**
	 * This model's `reasoning.default_level`, sent as `reasoning_effort` when a
	 * turn supplies no explicit effort. Undefined → send nothing (umans's own
	 * server-side default applies).
	 */
	reasoningDefault?: string;
	logger?: Logger;
}

/**
 * Build a fresh `UmansAccount` from config. Used by the model-router's umans
 * factory case. `customFetch` (logging/test) is threaded into the AI SDK
 * provider; the metadata/usage fetchers take their own optional fetch.
 */
export function createUmansAccount(config: {
	apiKey: string;
	baseUrl?: string;
	logger?: Logger;
	fetch?: typeof globalThis.fetch;
	connectTimeoutMs?: number;
	metadataFetch?: typeof fetchUmansModelMetadata;
	usageFetch?: typeof fetchUmansUsage;
}): UmansAccount {
	const baseUrl = config.baseUrl ?? UMANS_ANTHROPIC_BASE;
	const customFetch = resolveProviderFetch(PROVIDER_NAME, config);
	const baseURL = `${baseUrl.replace(/\/$/, "")}/v1`;
	const makeProvider = (reasoningEffort?: string) => {
		// When an effort is set, layer the reasoning_effort-injecting wrapper
		// over the base (logging/test/global) fetch; otherwise use the base
		// fetch as-is so umans applies its own default.
		const base = customFetch ?? globalThis.fetch;
		const fetchImpl = reasoningEffort ? reasoningEffortFetch(base, reasoningEffort) : customFetch;
		return createAnthropic({
			name: PROVIDER_NAME,
			baseURL,
			apiKey: config.apiKey,
			...(fetchImpl && { fetch: fetchImpl }),
		});
	};
	return {
		apiKey: config.apiKey,
		baseUrl,
		makeProvider,
		semaphore: new Semaphore(DEFAULT_CONCURRENCY),
		usageCache: { fetchedAt: 0 },
		logger: config.logger,
		metadataFetch: config.metadataFetch ?? fetchUmansModelMetadata,
		usageFetch: config.usageFetch ?? fetchUmansUsage,
	};
}

/**
 * Resolve the `reasoning_effort` to send for a umans turn:
 *  1. A per-call `params.effort` wins. If the model advertises `levels` and the
 *     requested effort isn't one of them, fall back to the model default
 *     (umans server-side validates too, but we avoid sending a known-bad level).
 *  2. Otherwise the model's `reasoning.default_level`.
 *  3. Otherwise undefined → send nothing (umans applies its own default).
 *
 * Returns undefined when nothing should be sent.
 */
function resolveReasoningEffort(
	params: ChatParams,
	reasoningLevels: string[] | undefined,
	reasoningDefault: string | undefined,
): string | undefined {
	const requested = params.effort;
	if (requested) {
		if (reasoningLevels && reasoningLevels.length > 0 && !reasoningLevels.includes(requested)) {
			// Requested level isn't one this model advertises → use its default.
			return reasoningDefault;
		}
		return requested;
	}
	return reasoningDefault;
}

/**
 * Readiness handle for the lineup/namespace driver. Owns the disposed flag +
 * AbortController so a fetch that resolves after `reload()`/`dispose()` is a
 * no-op (cannot register stale models into the live router).
 */
class UmansReadiness implements BackendReadiness {
	private ready = false;
	private disposed = false;
	private readonly controller = new AbortController();

	constructor(
		private readonly account: UmansAccount,
		private readonly namespaceId: string,
		private readonly logger?: Logger,
	) {}

	isReady(): boolean {
		return this.ready;
	}

	dispose(): void {
		this.disposed = true;
		this.controller.abort();
	}

	start(registrar: ModelRegistrar): void {
		// Fire-and-forget; bound start does not await this.
		void this.runFetchLoop(registrar);
	}

	private async runFetchLoop(registrar: ModelRegistrar): Promise<void> {
		let attempt = 0;
		while (!this.disposed) {
			const metaRes = await this.account.metadataFetch(
				`${this.account.baseUrl.replace(/\/$/, "")}/v1`,
				{
					apiKey: this.account.apiKey,
					signal: this.controller.signal,
				},
			);
			let usageRes: Awaited<ReturnType<typeof fetchUmansUsage>> | undefined;
			if (metaRes.ok) {
				usageRes = await this.account.usageFetch(this.account.baseUrl, this.account.apiKey, {
					signal: this.controller.signal,
				});
			}

			if (this.disposed) return;

			if (metaRes.ok && usageRes?.ok) {
				this.applyLineup(registrar, Array.from(metaRes.value.values()), usageRes.value);
				this.logger?.info?.("umans lineup ready", {
					models: metaRes.value.size,
					concurrency: this.account.semaphore.capacity,
				});
				return;
			}

			// AbortError is terminal (dispose path); any other failure retries.
			const err = (
				!metaRes.ok ? metaRes.error : usageRes && !usageRes.ok ? usageRes.error : undefined
			) as Error | undefined;
			if (err?.name === "AbortError" || this.controller.signal.aborted) return;

			attempt++;
			const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
			this.logger?.warn?.("umans lineup fetch failed; retrying", {
				attempt,
				delayMs: delay,
				error: err?.message,
			});
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	private applyLineup(
		registrar: ModelRegistrar,
		models: UmansModelMeta[],
		usage: UmansUsage,
	): void {
		if (this.disposed) return;

		// Size the shared semaphore from the fetched concurrency limit. The
		// capacity is fixed at construction; the account is reconstructed on
		// reload, so we replace the semaphore here rather than resizing.
		const limit = usage.concurrencyLimit ?? DEFAULT_CONCURRENCY;
		if (limit !== this.account.semaphore.capacity) {
			this.account.semaphore = new Semaphore(limit);
		}
		this.account.usageCache = { value: usage, fetchedAt: Date.now() };

		const tiers = deriveUmansTiers(models);
		const entries = models.map((m) => {
			const capabilities: BackendCapabilities = {
				streaming: true,
				tool_use: m.supportsTools,
				system_prompt: true,
				prompt_caching: true,
				vision: m.supportsVision,
				extended_thinking: m.reasoningSupported,
				max_context: m.contextWindow,
			};
			const descriptor: ModelDescriptor = {
				id: m.id,
				capabilities,
				tier: tiers.get(m.id),
				// Cache pricing omitted until umans exposes it (cost-0, not a bug).
				pricing: {
					inputPerM: m.pricePerMInput ?? 0,
					outputPerM: m.pricePerMOutput ?? 0,
				},
				maxOutputTokens: m.maxCompletionTokens,
			};
			const backend = new UmansDriver({
				account: this.account,
				modelId: m.id,
				capabilities,
				reasoningLevels: m.reasoningLevels,
				reasoningDefault: m.reasoningDefault,
				logger: this.logger,
			});
			return { descriptor, backend };
		});

		if (this.disposed) return; // re-check just before the live-router write
		this.ready = true;
		registrar.register(this.namespaceId, entries);
	}
}

export class UmansDriver implements LLMBackend {
	private readonly account: UmansAccount;
	private readonly modelId?: string;
	private readonly caps: BackendCapabilities;
	private readonly logger?: Logger;
	private readonly reasoningLevels?: string[];
	private readonly reasoningDefault?: string;
	/** Present ONLY on the lineup/namespace instance. */
	readonly readiness?: BackendReadiness;
	private readonly isNamespace: boolean;

	constructor(opts: UmansDriverOptions & { namespaceId?: string }) {
		this.account = opts.account;
		this.modelId = opts.modelId;
		this.logger = opts.logger ?? opts.account.logger;
		this.reasoningLevels = opts.reasoningLevels;
		this.reasoningDefault = opts.reasoningDefault;
		this.isNamespace = opts.modelId === undefined;
		this.caps = opts.capabilities ?? {
			// Conservative placeholders for the namespace instance — it is
			// excluded from selection until expansion, so these are never used
			// for routing decisions.
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: false,
			extended_thinking: false,
		};
		if (this.isNamespace) {
			this.readiness = new UmansReadiness(
				this.account,
				opts.namespaceId ?? PROVIDER_NAME,
				this.logger,
			);
		}
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		// Namespace guard (defense-in-depth). The lineup/namespace driver has no
		// modelId and must never serve inference. Some CLI-layer sites call
		// modelRouter.getDefault().chat(...) directly, bypassing the resolveModel
		// not-ready gate (crash-recovery summary, generateThreadTitle, onComplete
		// title). All are wrapped to tolerate failure, so a clear throw degrades
		// gracefully (work skipped) instead of an opaque provider.messages(undefined)
		// request during the warmup window. Throws on first iteration.
		if (this.isNamespace) {
			throw new LLMError(
				"umans namespace backend is not directly invokable — models not yet resolved / backend not ready",
				PROVIDER_NAME,
			);
		}

		const account = this.account;

		// --- Pre-acquire: lazy usage refresh + boxed_until 429 (never holds a slot). ---
		await this.maybeRefreshUsage();
		const boxedUntil = account.usageCache.value?.boxedUntil;
		if (boxedUntil !== undefined && boxedUntil > Date.now()) {
			const retryAfterMs = boxedUntil - Date.now();
			this.logger?.debug?.("umans account boxed; backing off", {
				retryAfterMs,
				remainingRequests: account.usageCache.value?.remainingRequests,
			});
			throw new LLMError(
				`umans account is priority-boxed for ${retryAfterMs}ms`,
				PROVIDER_NAME,
				429,
				undefined,
				retryAfterMs,
			);
		}

		const modelId = params.model || this.modelId;
		if (!modelId) {
			throw new LLMError("umans driver invoked without a model id", PROVIDER_NAME);
		}

		const tools = toToolSet(params.tools);
		const messages = toModelMessages(params.messages, {
			cacheProvider: "anthropic",
			resolveFileRef: params.resolveFileRef,
			targetEnvelope: ANTHROPIC_ENVELOPE,
			cacheTtl: params.cache_ttl,
			reasoningProviderOptions: "anthropic",
		});
		// Resolve the reasoning_effort to inject as a top-level body field via a
		// per-call provider whose fetch wrapper adds it (umans extension on the
		// Anthropic route). Per-call effort > model default_level > nothing.
		const reasoningEffort = resolveReasoningEffort(
			params,
			this.reasoningLevels,
			this.reasoningDefault,
		);
		const provider = account.makeProvider(reasoningEffort);

		// --- Semaphore: acquire immediately before the try; release exactly once. ---
		// The abort listener is registered AFTER acquire() and torn down in the
		// finally, so it can only ever release a slot we actually hold (a
		// listener registered before acquire() could fire while still queued and
		// release a slot we never took, over-counting the semaphore).
		let released = false;
		const releaseOnce = () => {
			if (released) return;
			released = true;
			account.semaphore.release();
		};

		await account.semaphore.acquire();
		const onAbort = () => releaseOnce();
		// Defense-in-depth: the signal-abort path is not covered by the
		// consumer-break finally, so release on abort too.
		params.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			// Heartbeat must be inside the try so a consumer break during it is
			// covered by the finally.
			yield { type: "heartbeat" };
			// One streaming attempt — built fresh per retry so a re-issue is a
			// clean new request, not a replayed stream. withEmptyRetry re-issues
			// when a turn ends with output_tokens=0 and no content: the relay
			// path can drop a stream before emitting any chunk, which otherwise
			// surfaces as a degenerate turn for the loop to recover from. Catching
			// it here is cheaper and transparent. The semaphore slot acquired
			// above is held across retries (one logical call, one slot).
			const runAttempt = (): AsyncIterable<StreamChunk> =>
				mapProviderStream({
					providerName: PROVIDER_NAME,
					stream: () =>
						streamText({
							model: provider.messages(modelId),
							messages,
							...(params.system && { system: params.system }),
							...(tools && { tools }),
							...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
							// Suppress temperature when a reasoning_effort is in play —
							// reasoning turns typically reject an explicit temperature.
							...(params.temperature !== undefined &&
								!reasoningEffort && {
									temperature: params.temperature,
								}),
							abortSignal: params.signal,
							providerOptions: {
								anthropic: {
									// reasoning_effort is injected on the wire by the
									// per-call provider's fetch wrapper, not here.
									sendReasoning: true,
								} as Record<string, unknown> as never,
							},
						}).fullStream,
					map: { estimateInputFromMessages: params.messages, usageProvider: "anthropic" },
				});

			yield* withEmptyRetry(runAttempt, {
				maxRetries: EMPTY_COMPLETION_MAX_RETRIES,
				isAborted: () => params.signal?.aborted ?? false,
				onRetry: (attempt) =>
					this.logger?.warn?.(
						`[${PROVIDER_NAME}] empty completion (output_tokens=0), retrying (attempt ${attempt}/${EMPTY_COMPLETION_MAX_RETRIES})`,
						{ model: modelId },
					),
			});
		} finally {
			params.signal?.removeEventListener("abort", onAbort);
			releaseOnce();
		}
	}

	/**
	 * Refresh the shared usage cache if a fetcher is wired and the cache is
	 * older than the TTL. Best-effort: a usage-fetch error never fails a call.
	 */
	private async maybeRefreshUsage(): Promise<void> {
		const account = this.account;
		const age = Date.now() - account.usageCache.fetchedAt;
		if (age < USAGE_TTL_MS) return;
		const res = await account.usageFetch(account.baseUrl, account.apiKey, {});
		if (res.ok) {
			account.usageCache = { value: res.value, fetchedAt: Date.now() };
		} else {
			// Bump the timestamp so we don't hammer a failing endpoint every call.
			account.usageCache.fetchedAt = Date.now();
		}
	}

	capabilities(): BackendCapabilities {
		return this.caps;
	}
}
