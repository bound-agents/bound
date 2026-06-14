import type { Logger } from "@bound/shared";
import { BedrockDriver } from "./bedrock-driver";
import { BedrockMantleDriver } from "./bedrock-mantle-driver";
import { OpenAICompatibleDriver } from "./openai-compatible-driver";
import { OpenCodeGoDriver } from "./opencode-go-driver";
import type {
	BackendCapabilities,
	BackendConfig,
	CapabilityRequirements,
	LLMBackend,
	ModelBackendsConfig,
} from "./types";
import type { ChatParams, StreamChunk } from "./types";
import { LLMError } from "./types";

export interface BackendInfo {
	id: string;
	capabilities: BackendCapabilities;
}

export interface PoolEntry {
	backend: LLMBackend;
	tier: number;
	pricePerMInput: number;
}

// Exponential backoff constants for pooled backend cooldowns
const BACKOFF_BASE_MS = 30_000; // 30s initial cooldown
const BACKOFF_MAX_MS = 4 * 3600_000; // 4h cap — prevents runaway backoff from degraded networks
const BACKOFF_MULTIPLIER = 2;
const BACKOFF_RESET_MS = 10 * 60_000; // 10min of success resets consecutive failure count

/**
 * Wraps multiple backends under the same logical ID.
 * Sorted by tier (ascending, best first), then by input price (ascending, cheapest first).
 * On rate-limit (429), payment required (402), or server errors (5xx), marks the sub-backend with exponential backoff
 * and falls through to the next. Cooldown caps at BACKOFF_MAX_MS.
 * Consecutive failure count resets after BACKOFF_RESET_MS of successful use.
 */
export class PooledBackend implements LLMBackend {
	private entries: PoolEntry[];
	private rateLimited: Map<number, number>; // index → expiry timestamp (ms)
	private consecutiveFailures: Map<number, number>; // index → failure count
	private lastSuccess: Map<number, number>; // index → last success timestamp (ms)
	private mergedCaps: BackendCapabilities;

	constructor(entries: PoolEntry[]) {
		if (entries.length === 0) throw new Error("PooledBackend requires at least one backend");
		this.entries = [...entries].sort(
			(a, b) => a.tier - b.tier || a.pricePerMInput - b.pricePerMInput,
		);
		this.rateLimited = new Map();
		this.consecutiveFailures = new Map();
		this.lastSuccess = new Map();
		this.mergedCaps = this.mergeCaps();
	}

	private mergeCaps(): BackendCapabilities {
		const caps = this.entries.map((e) => e.backend.capabilities());
		return {
			streaming: caps.some((c) => c.streaming),
			tool_use: caps.some((c) => c.tool_use),
			system_prompt: caps.some((c) => c.system_prompt),
			prompt_caching: caps.some((c) => c.prompt_caching),
			vision: caps.some((c) => c.vision),
			extended_thinking: caps.some((c) => c.extended_thinking),
			max_context: Math.max(...caps.map((c) => c.max_context)),
		};
	}

	private computeBackoff(idx: number): number {
		const failures = this.consecutiveFailures.get(idx) ?? 0;
		return Math.min(BACKOFF_BASE_MS * BACKOFF_MULTIPLIER ** failures, BACKOFF_MAX_MS);
	}

	private getAvailable(): PoolEntry[] {
		const now = Date.now();
		for (const [idx, expiry] of this.rateLimited) {
			if (now >= expiry) this.rateLimited.delete(idx);
		}
		return this.entries.filter((_, i) => !this.rateLimited.has(i));
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		const available = this.getAvailable();
		// If all rate-limited, try all anyway (they may have recovered)
		const candidates = available.length > 0 ? available : this.entries;
		let lastError: unknown;

		for (const entry of candidates) {
			const idx = this.entries.indexOf(entry);
			try {
				yield* entry.backend.chat(params);
				// Success — reset consecutive failures if enough time has passed,
				// or record the success timestamp for future resets
				const lastOk = this.lastSuccess.get(idx) ?? 0;
				const now = Date.now();
				if (now - lastOk >= BACKOFF_RESET_MS) {
					this.consecutiveFailures.delete(idx);
				}
				this.lastSuccess.set(idx, now);
				return;
			} catch (error) {
				lastError = error;
				if (error instanceof LLMError && error.statusCode !== undefined) {
					const isRateLimit = error.statusCode === 429;
					const isPaymentRequired = error.statusCode === 402;
					const isServerError = error.statusCode >= 500;
					const isBadRequest = error.statusCode === 400;
					if (isRateLimit || isPaymentRequired || isServerError || isBadRequest) {
						const failures = (this.consecutiveFailures.get(idx) ?? 0) + 1;
						this.consecutiveFailures.set(idx, failures);
						// Use provider's Retry-After if available, otherwise exponential backoff
						const cooldown = error.retryAfterMs || this.computeBackoff(idx);
						this.rateLimited.set(idx, Date.now() + cooldown);
						continue;
					}
				}
				// Network errors (TLS failures, DNS, etc.) should also fall through to
				// the next pool entry rather than killing the entire request
				if (!(error instanceof LLMError) && candidates.indexOf(entry) < candidates.length - 1) {
					continue;
				}
				throw error; // Other client errors (4xx except 400/402/429) propagate immediately
			}
		}

		throw lastError;
	}

	capabilities(): BackendCapabilities {
		return this.mergedCaps;
	}
}

export class ModelRouter {
	private backends: Map<string, LLMBackend>;
	private defaultId: string;
	private effectiveCaps: Map<string, BackendCapabilities>;
	private rateLimits: Map<string, number>; // backendId → expiry timestamp (ms)
	private tiers: Map<string, number>; // backendId → tier number
	private backendConfigs: Map<string, BackendConfig>; // backendId → raw config

	constructor(
		backends: Map<string, LLMBackend>,
		defaultId: string,
		effectiveCaps?: Map<string, BackendCapabilities>,
		tiers?: Map<string, number>,
		backendConfigs?: Map<string, BackendConfig>,
	) {
		this.backends = backends;
		this.defaultId = defaultId;
		this.effectiveCaps =
			effectiveCaps ??
			new Map(Array.from(backends.entries()).map(([id, b]) => [id, b.capabilities()]));
		this.rateLimits = new Map();
		this.tiers = tiers ?? new Map();
		this.backendConfigs = backendConfigs ?? new Map();
	}

	/**
	 * Rebuilds internal backend state from a new ModelBackendsConfig. Held
	 * references to this router see the updated state immediately — callers
	 * (agent-loop, scheduler, server, command context) do not need to swap
	 * the instance.
	 *
	 * Atomicity: if the new config is invalid (e.g. default not in backends,
	 * unsupported provider), the router is left in its prior state and the
	 * error propagates to the caller.
	 *
	 * Side effect: rate-limit counters are reset — backends are reconstructed
	 * from scratch, so any prior 429 state is no longer meaningful against
	 * the new driver instances.
	 */
	reload(config: ModelBackendsConfig): void {
		const next = buildRouterState(config);
		this.backends = next.backends;
		this.defaultId = next.defaultId;
		this.effectiveCaps = next.effectiveCaps;
		this.tiers = next.tiers;
		this.backendConfigs = next.backendConfigs;
		this.rateLimits = new Map();
	}

	getBackend(modelId?: string): LLMBackend {
		const id = modelId ?? this.defaultId;
		const backend = this.backends.get(id);
		if (!backend) {
			const available = Array.from(this.backends.keys()).join(", ");
			throw new Error(`Unknown backend ID: ${id}. Available backends: ${available}`);
		}
		return backend;
	}

	getDefault(): LLMBackend {
		const backend = this.backends.get(this.defaultId);
		if (!backend) {
			throw new Error(`Default backend not found: ${this.defaultId}`);
		}
		return backend;
	}

	/** Returns BackendInfo list with EFFECTIVE capabilities (driver baseline merged with config overrides). */
	listBackends(): BackendInfo[] {
		return Array.from(this.backends.keys()).map((id) => {
			const effectiveCap = this.effectiveCaps.get(id);
			const backend = this.backends.get(id);
			return {
				id,
				capabilities: effectiveCap ??
					backend?.capabilities() ?? {
						streaming: true,
						tool_use: true,
						system_prompt: true,
						prompt_caching: false,
						vision: false,
						extended_thinking: false,
						max_context: 0,
					},
			};
		});
	}

	/** Returns the default backend ID. */
	getDefaultId(): string {
		return this.defaultId;
	}

	/** Returns the backend for modelId, or null if not found (non-throwing). */
	tryGetBackend(modelId: string): LLMBackend | null {
		return this.backends.get(modelId) ?? null;
	}

	/**
	 * Returns the effective capabilities for a backend (driver baseline merged with config override).
	 * Returns null if the backend ID is not registered.
	 */
	getEffectiveCapabilities(id: string): BackendCapabilities | null {
		return this.effectiveCaps.get(id) ?? null;
	}

	/**
	 * Returns all backends that are not rate-limited and satisfy the given capability requirements.
	 * Sorted by backend registration order (Map iteration order).
	 *
	 * @param requirements - Optional capability requirements to filter by. If omitted, only rate-limited
	 *   backends are excluded (text-only requests with no special requirements).
	 */
	listEligible(requirements?: CapabilityRequirements): BackendInfo[] {
		const result: BackendInfo[] = [];
		for (const id of this.backends.keys()) {
			if (this.isRateLimited(id)) continue;

			const caps = this.effectiveCaps.get(id);
			if (!caps) continue;

			if (requirements) {
				if (requirements.vision && !caps.vision) continue;
				if (requirements.tool_use && !caps.tool_use) continue;
				if (requirements.system_prompt && !caps.system_prompt) continue;
				if (requirements.prompt_caching && !caps.prompt_caching) continue;
			}

			result.push({ id, capabilities: caps });
		}
		return result;
	}

	/**
	 * Marks a backend as rate-limited for the given duration.
	 * The backend will be excluded from `listEligible()` for `retryAfterMs` milliseconds.
	 *
	 * @param id - Backend ID to mark rate-limited
	 * @param retryAfterMs - Duration in milliseconds (use 60_000 as default if Retry-After header is absent)
	 */
	markRateLimited(id: string, retryAfterMs: number): void {
		this.rateLimits.set(id, Date.now() + retryAfterMs);
	}

	/**
	 * Returns true if the backend is currently rate-limited.
	 * Automatically cleans up expired entries.
	 */
	isRateLimited(id: string): boolean {
		const expiry = this.rateLimits.get(id);
		if (expiry === undefined) return false;
		if (Date.now() >= expiry) {
			this.rateLimits.delete(id); // Clean up expired entry
			return false;
		}
		return true;
	}

	/**
	 * Returns the earliest expiry timestamp (ms) among rate-limited backends that
	 * satisfy the given capability requirements. Returns null if no such backend exists.
	 * Used by resolveModel() to populate `earliestRecovery` on transient-unavailable errors.
	 */
	getEarliestCapableRecovery(requirements?: CapabilityRequirements): number | null {
		let earliest: number | null = null;
		for (const [id, expiry] of this.rateLimits) {
			const caps = this.effectiveCaps.get(id);
			if (!caps) continue;
			if (requirements) {
				if (requirements.vision && !caps.vision) continue;
				if (requirements.tool_use && !caps.tool_use) continue;
				if (requirements.system_prompt && !caps.system_prompt) continue;
				if (requirements.prompt_caching && !caps.prompt_caching) continue;
			}
			if (earliest === null || expiry < earliest) {
				earliest = expiry;
			}
		}
		return earliest;
	}

	/** Returns the tier for a backend ID, or null if not registered. */
	getBackendTier(id: string): number | null {
		return this.tiers.get(id) ?? null;
	}

	/**
	 * Extracts thinking configuration from a backend's config.
	 * Returns undefined if no thinking config exists or the backend is not found.
	 *
	 * Supported config shapes:
	 * - `thinking: true` → `{type: "enabled", budget_tokens: 10000}` (legacy default)
	 * - `thinking: {type: "enabled", budget_tokens?}` → legacy; defaults budget to 10000
	 * - `thinking: {type: "adaptive", display?}` → model-controlled depth (required on Opus 4.7).
	 *   `display` defaults to `"summarized"` so callers get visible reasoning text by default
	 *   on 4.7 — the wire default there is `"omitted"`, which silently empties thinking chunks.
	 * - `thinking: {budget_tokens: N}` (no `type`) → treated as legacy enabled
	 */
	getThinkingConfig(backendId: string): ChatParams["thinking"] | undefined {
		const config = this.backendConfigs.get(backendId);
		if (!config) return undefined;
		if (config.thinking === true) {
			return { type: "enabled", budget_tokens: 10000 };
		}
		if (typeof config.thinking === "object" && config.thinking !== null) {
			const t = config.thinking as {
				type?: "enabled" | "adaptive";
				budget_tokens?: number;
				display?: "omitted" | "summarized";
			};
			if (t.type === "adaptive") {
				return { type: "adaptive", display: t.display ?? "summarized" };
			}
			return {
				type: "enabled",
				budget_tokens: t.budget_tokens ?? 10000,
			};
		}
		return undefined;
	}

	/**
	 * Returns the `effort` level configured for a backend, or undefined if
	 * unset. Effort is a top-level output_config knob on the Claude API
	 * (low | medium | high | xhigh | max) and replaces `budget_tokens` as
	 * the depth control on Opus 4.7.
	 */
	getEffort(backendId: string): ChatParams["effort"] | undefined {
		const config = this.backendConfigs.get(backendId);
		if (!config) return undefined;
		const effort = config.effort as ChatParams["effort"] | undefined;
		return effort ?? undefined;
	}

	/**
	 * Returns the per-backend `maxOutputTokens` cap, or undefined if unset.
	 * The agent-loop clamps its default (DEFAULT_MAX_OUTPUT_TOKENS) via
	 * `min(cap, default)` so Bedrock models with tight output limits (e.g.
	 * Nova Pro's 10_000 cap) don't 400 with "max_tokens exceeds model limit".
	 */
	getMaxOutputTokens(backendId: string): number | undefined {
		const config = this.backendConfigs.get(backendId);
		if (!config) return undefined;
		const cap = config.maxOutputTokens;
		return typeof cap === "number" ? cap : undefined;
	}

	/**
	 * Returns the per-backend prompt-cache TTL hint.
	 *
	 * Resolution priority:
	 *   1. Explicit `config.cacheTtl` ("5m" or "1h") — operator override
	 *      for backends that should use extended TTL or be opted out
	 *      from caching entirely.
	 *   2. Capability-based default — when `effectiveCaps.prompt_caching`
	 *      is `true`, default to "5m" (the Bedrock baseline TTL supported
	 *      by every caching-capable model). This is the load-bearing
	 *      fallback that prevents an entire class of config landmines:
	 *      operators no longer have to remember to set `cacheTtl` on each
	 *      caching-capable backend in `model_backends.json` to actually
	 *      get caching.
	 *   3. Otherwise undefined (caching not intended).
	 *
	 * Live regression that motivated this defaulting: thread
	 * `33212d49-…` 2026-05-25 ran with cr=0 across most of its turns
	 * because Sonnet's config didn't explicitly set `cacheTtl`. The
	 * bedrock-driver's `shouldEnableSystemCachePoint` gate disabled the
	 * system anchor when both `cache_ttl` was undefined AND the
	 * message-level marker wasn't placed — both layers failed silently,
	 * caching was completely off.
	 */
	getCacheTtl(backendId: string): "5m" | "1h" | undefined {
		const config = this.backendConfigs.get(backendId);
		const explicit = config?.cacheTtl;
		if (explicit === "5m" || explicit === "1h") return explicit;
		const caps = this.effectiveCaps.get(backendId);
		if (caps?.prompt_caching === true) return "5m";
		return undefined;
	}

	/**
	 * Returns the per-backend cache-warming config — `{ enabled, maxPokes }` —
	 * or undefined when the backend declares no `cache_warming` block (the
	 * backend is never warmed). `enabled` gates whether the driver pokes this
	 * backend's threads at all; `maxPokes` caps pokes per thread per active
	 * period (0 = never warm, a clean opt-out even with `enabled: true`).
	 * Consumed only by the cache-warming driver; never read at inference time.
	 */
	getCacheWarmConfig(backendId: string): { enabled: boolean; maxPokes: number } | undefined {
		return this.backendConfigs.get(backendId)?.cacheWarming;
	}

	/**
	 * Returns all backends matching the given tier that are not rate-limited and
	 * satisfy the given capability requirements.
	 */
	listEligibleByTier(tier: number, requirements?: CapabilityRequirements): BackendInfo[] {
		return this.listEligible(requirements).filter((b) => this.tiers.get(b.id) === tier);
	}
}

function createBackendFromConfig(
	config: BackendConfig,
	logger?: Logger,
	fetch?: typeof globalThis.fetch,
): LLMBackend {
	const provider = config.provider.toLowerCase();

	switch (provider) {
		case "bedrock": {
			const region = config.region as string | undefined;
			if (!region) {
				throw new Error("Bedrock driver requires region in config");
			}
			const profile = config.profile as string | undefined;
			const contextWindow = config.contextWindow ?? 200000;
			return new BedrockDriver({
				region,
				model: config.model,
				contextWindow,
				profile,
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
			});
		}

		case "openai-compatible": {
			const baseUrl = config.baseUrl ?? "http://localhost:8000";
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error("OpenAI-compatible driver requires apiKey in config");
			}
			const contextWindow = config.contextWindow ?? 8192;
			return new OpenAICompatibleDriver({
				baseUrl,
				apiKey,
				model: config.model,
				contextWindow,
				providerName: "openai-compatible",
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
			});
		}

		case "cerebras": {
			const baseUrl = config.baseUrl ?? "https://api.cerebras.ai/v1";
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error("Cerebras driver requires apiKey in config");
			}
			const contextWindow = config.contextWindow ?? 128000;
			return new OpenAICompatibleDriver({
				baseUrl,
				apiKey,
				model: config.model,
				contextWindow,
				providerName: "cerebras",
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
			});
		}

		case "zai": {
			const baseUrl = config.baseUrl ?? "https://api.z.ai/api/coding/paas/v4";
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error("z.AI driver requires apiKey in config");
			}
			const contextWindow = config.contextWindow ?? 128000;
			return new OpenAICompatibleDriver({
				baseUrl,
				apiKey,
				model: config.model,
				contextWindow,
				providerName: "zai",
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
			});
		}

		case "opencode-go": {
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error("OpenCode Go driver requires apiKey in config");
			}
			const contextWindow = config.contextWindow ?? 128000;
			return new OpenCodeGoDriver({
				apiKey,
				model: config.model,
				contextWindow,
				baseUrl: config.baseUrl,
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
			});
		}

		case "bedrock-mantle": {
			const region = config.region as string | undefined;
			if (!region) {
				throw new Error("Bedrock Mantle driver requires region in config");
			}
			const profile = config.profile as string | undefined;
			const contextWindow = config.contextWindow ?? 272000;
			return new BedrockMantleDriver({
				region,
				model: config.model,
				contextWindow,
				profile,
				baseUrl: config.baseUrl,
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
			});
		}

		default:
			// anthropic, ollama, and other providers deliberately removed in the
			// 2026-04-25 AI SDK migration. If a config still references them, it
			// needs to be updated — anthropic backends should use bedrock, and
			// local inference should go through the relay to a spoke host that
			// runs bedrock or openai-compatible.
			throw new Error(`Provider not supported: ${config.provider}`);
	}
}

interface RouterState {
	backends: Map<string, LLMBackend>;
	defaultId: string;
	effectiveCaps: Map<string, BackendCapabilities>;
	tiers: Map<string, number>;
	backendConfigs: Map<string, BackendConfig>;
}

function buildRouterState(
	config: ModelBackendsConfig,
	logger?: Logger,
	fetchByBackendId?: Map<string, typeof globalThis.fetch>,
): RouterState {
	// Group backend configs by ID to support pooling (multiple providers for the same logical model)
	const groups = new Map<string, { entries: PoolEntry[]; caps: BackendCapabilities[] }>();

	for (const backendConfig of config.backends) {
		const fetchOverride = fetchByBackendId?.get(backendConfig.id);
		const backend = createBackendFromConfig(backendConfig, logger, fetchOverride);
		const baseline = backend.capabilities();
		const capOverride =
			(backendConfig.capabilities as Partial<BackendCapabilities> | undefined) ?? {};
		const effectiveCap = { ...baseline, ...capOverride };

		const entry: PoolEntry = {
			backend,
			tier: (backendConfig.tier as number | undefined) ?? 3,
			pricePerMInput: (backendConfig.pricePerMInput as number | undefined) ?? 0,
		};

		const existing = groups.get(backendConfig.id);
		if (existing) {
			existing.entries.push(entry);
			existing.caps.push(effectiveCap);
		} else {
			groups.set(backendConfig.id, { entries: [entry], caps: [effectiveCap] });
		}
	}

	// Build final maps — pool backends with shared IDs
	const backends = new Map<string, LLMBackend>();
	const effectiveCaps = new Map<string, BackendCapabilities>();
	const tiers = new Map<string, number>();
	const backendConfigs = new Map<string, BackendConfig>();

	for (const [id, group] of groups) {
		// Use the best (lowest) tier among pooled entries
		const bestTier = Math.min(...group.entries.map((e) => e.tier));
		tiers.set(id, bestTier);
		// Store the first backend config for thinking config extraction
		if (!backendConfigs.has(id)) {
			const firstConfig = config.backends.find((b) => b.id === id);
			if (firstConfig) backendConfigs.set(id, firstConfig);
		}

		if (group.entries.length === 1) {
			backends.set(id, group.entries[0].backend);
			effectiveCaps.set(id, group.caps[0]);
		} else {
			// Multiple backends share this ID — wrap in a PooledBackend
			const pooled = new PooledBackend(group.entries);
			backends.set(id, pooled);
			// Merge effective caps: best of all sub-backends
			effectiveCaps.set(id, pooled.capabilities());
		}
	}

	// Hub-only mode: empty backends array is valid (inference proxied to spokes).
	// In this case the default is "" and no local backends are available.
	if (config.backends.length === 0) {
		return { backends, defaultId: "", effectiveCaps, tiers, backendConfigs };
	}

	// Verify default backend exists
	const defaultExists = backends.has(config.default);
	if (!defaultExists) {
		throw new LLMError(`Default backend "${config.default}" not found in backends`, "router");
	}

	return { backends, defaultId: config.default, effectiveCaps, tiers, backendConfigs };
}

export interface CreateModelRouterOptions {
	/**
	 * Optional logger forwarded to each constructed driver for debug-level
	 * AI SDK request-body interception. Drivers will wire this into their
	 * provider factory's `fetch` option (see `createLoggingFetch`).
	 */
	logger?: Logger;
	/**
	 * Optional per-backend fetch override, keyed by `BackendConfig.id`. When
	 * present for a given backend ID, the driver constructor receives the
	 * fetch directly (taking precedence over the logger-backed fetch). Used
	 * by the diagnostic harness in `packages/agent/scripts/agent-harness/`
	 * to capture wire bodies for inspection. Production callers leave this
	 * unset.
	 */
	fetchByBackendId?: Map<string, typeof globalThis.fetch>;
}

export function createModelRouter(
	config: ModelBackendsConfig,
	options?: CreateModelRouterOptions,
): ModelRouter {
	const state = buildRouterState(config, options?.logger, options?.fetchByBackendId);
	return new ModelRouter(
		state.backends,
		state.defaultId,
		state.effectiveCaps,
		state.tiers,
		state.backendConfigs,
	);
}
