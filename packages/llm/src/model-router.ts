import type { Logger } from "@bound/shared";
import { AnthropicDriver } from "./drivers/anthropic";
import { BedrockDriver } from "./drivers/bedrock";
import { BedrockMantleDriver } from "./drivers/bedrock-mantle";
import { ChatGptOAuthDriver } from "./drivers/chatgpt-oauth/driver";
import { FileTokenStore, TokenManager } from "./drivers/chatgpt-oauth/token-store";
import { fetchAccountInfo } from "./drivers/github-copilot/auth-core";
import { GitHubCopilotDriver } from "./drivers/github-copilot/driver";
import { CopilotTokenManager, FileCopilotTokenStore } from "./drivers/github-copilot/token-store";
import { OpenAICompatibleDriver } from "./drivers/openai-compatible";
import { OpenCodeGoDriver } from "./drivers/opencode-go";
import { UmansDriver, createUmansAccount } from "./drivers/umans";
import { type RouteErrorKind, RouteHealth } from "./route-health";
import type {
	BackendCapabilities,
	BackendConfig,
	CapabilityRequirements,
	LLMBackend,
	ModelBackendsConfig,
} from "./types";
import type { ChatParams } from "./types";
import { LLMError } from "./types";
export interface BackendInfo {
	id: string;
	capabilities: BackendCapabilities;
}
import type { FieldSource, ResolvedPricing, ResolvedReasoning } from "./catalog/resolve-metadata";
/**
 * Narrow structural view of a resolved catalog entry for `applyResolvedCatalog`
 * (slice 6 follow-up). Declared locally so the router — which must not depend on
 * the catalog orchestrator — reads only the fields that drive routing budget.
 * The production `ResolvedBackend` from `catalog/resolve-catalog.ts` is
 * structurally assignable to this.
 */
export interface ResolvedCatalogEntry {
	ready: boolean;
	metadata: {
		capabilities: { max_context?: number; reasoning?: ResolvedReasoning };
		max_output_tokens?: number;
		pricing?: ResolvedPricing;
		field_sources: Record<string, string>;
	};
}
/**
 * A concrete serving endpoint identity (`2026-11-21-model-routing.md` §3.1,
 * R-RT1): `RouteId = ${siteId}:${provider}:${backendId}`. This is the routing,
 * health, pinning, and per-turn provenance identity. It is DISTINCT from
 * `reasoning_origin` (`${siteId}:${provider}[:${detail}]`), the provider
 * mint-provenance stamp carried on encrypted reasoning blocks (44206fda),
 * where `detail` disambiguates provider deployments (e.g. Bedrock Mantle
 * `region:mode`) rather than `backendId`. The two are never conflated.
 */
export type RouteId = `${string}:${string}:${string}`;

/** Build a {@link RouteId} from its three components. */
export function makeRouteId(siteId: string, provider: string, backendId: string): RouteId {
	return `${siteId}:${provider}:${backendId}`;
}

/**
 * Sentinel context window handed to a driver constructed WITHOUT a resolved
 * `max_context` in local config (slice 6, R-MC4). The catalog layer resolves a
 * backend's real window from config / provider discovery / `models.dev`; a
 * driver is only built here from static config, before resolution runs, so when
 * `config.contextWindow` is absent we pass `0` rather than a hardcoded guess.
 * `capabilities().max_context === 0` means "advertises no max_context", which
 * `2026-11-21-model-routing.md` R-RT2 (§5 candidate pool) already treats as
 * ineligible, and which the catalog readiness gate (`gateUnreadyBackends`)
 * surfaces as a configuration gap — so a turn is never dispatched on a guessed
 * window. A backend that sets `context_window` in config keeps its real number.
 */
const UNRESOLVED_CONTEXT_WINDOW = 0;

/**
 * Upper bound on a provider- or registry-reported `max_output_tokens`, as a
 * fraction of the resolved context window. Operator decision (2026-11-23):
 * context management assumes the output reservation is much smaller than the
 * window, and some providers report output equal to the whole window. 25%
 * leaves today's 128k output limits on 512k+ windows untouched. A
 * `max_output_tokens` set in local config is never capped.
 */
export const MAX_OUTPUT_CONTEXT_FRACTION = 0.25;

/**
 * Reasoning-effort levels in ascending strength, used to clamp a configured or
 * default effort to the nearest value a model actually lists (requirement 3,
 * `2026-11-21-model-catalog.md` §3.1). This is a protocol-level strength ordering,
 * not a per-model capability list — the per-model ladder is the resolved
 * `effort_values`, which this only walks to pick the nearest listed neighbour.
 */
const EFFORT_STRENGTH_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Clamp `effort` to the nearest value in the model's resolved `ladder`
 * (requirement 3). When the model lists the exact value, it passes through. When
 * it does not, the nearest listed level by strength rank wins (ties resolve to
 * the stronger side). A value or ladder entry outside the known strength order,
 * or an absent/empty ladder, means there is nothing to clamp against, so the
 * value passes through unchanged and the driver's own protocol gate decides.
 */
export function clampEffortToLadder(effort: string, ladder: string[] | undefined): string {
	if (!ladder || ladder.length === 0) return effort;
	if (ladder.includes(effort)) return effort;
	const target = EFFORT_STRENGTH_ORDER.indexOf(effort);
	if (target < 0) return effort; // unknown vocabulary — leave it to the driver.
	let best: string | undefined;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const level of ladder) {
		const rank = EFFORT_STRENGTH_ORDER.indexOf(level);
		if (rank < 0) continue;
		const dist = Math.abs(rank - target);
		// Strict `<` keeps the first-seen on a tie; walk highest-first so a tie
		// resolves to the stronger neighbour.
		if (dist < bestDist) {
			bestDist = dist;
			best = level;
		}
	}
	return best ?? effort;
}

/**
 * A local route entry in the flat {@link ModelRouter} registry. Each carries
 * its {@link RouteId} (addressing/ranking/health/stickiness) and, separately,
 * its provider `reasoningOrigin` (`${siteId}:${provider}[:${detail}]`, for
 * encrypted-reasoning keep/drop compatibility at the driver boundary). The two
 * properties are never conflated (R-RT1).
 */
export interface RouteEntry {
	routeId: RouteId;
	reasoningOrigin: string;
	backend: LLMBackend;
	capabilities: BackendCapabilities;
}

/** Copilot token managers keyed by token-store path; every backend over one file shares one. */
const copilotTokenManagers = new Map<string, CopilotTokenManager>();

export class ModelRouter {
	private backends: Map<string, LLMBackend>;
	private defaultId: string;
	private effectiveCaps: Map<string, BackendCapabilities>;
	/**
	 * Per-host route health (#285, spec §6.1, R-RT11–R-RT13). Keyed by local
	 * `backendId` (1:1 with `RouteId`). Replaces the former `rateLimits` map and
	 * the slice-2 interim cooldown: a backend in `backoff` is unavailable, a
	 * `half_open` backend accepts one real trial turn per host, and `healthy`
	 * routes route normally. Local-only, never synced (Invariant #3).
	 */
	private routeHealth: RouteHealth;
	private backendConfigs: Map<string, BackendConfig>; // backendId → raw config
	/**
	 * Catalog-resolved pricing per backendId (provider API or `models.dev`,
	 * tier-aware), with the winning pricing `field_sources` source. Written by
	 * `applyResolvedCatalog`; read by cost calculation at turn-record time on the
	 * local and relay paths so the serving host prices the turn from the catalog
	 * when the operator set no explicit `price_per_m_*` override. Narrowly a
	 * pricing holder — ranking/health never read it.
	 */
	private resolvedPricing: Map<
		string,
		{ pricing: ResolvedPricing; source: "provider" | "models_dev" }
	>;
	/**
	 * Per-backendId route identity: the `RouteId` (`${siteId}:${provider}:${backendId}`)
	 * and the provider `reasoningOrigin` (`${siteId}:${provider}[:${detail}]`). Kept
	 * distinct (R-RT1): `RouteId` governs addressing/ranking/health/stickiness while
	 * `reasoningOrigin` governs encrypted-reasoning keep/drop at the driver boundary.
	 */
	private routeIdentities: Map<string, { routeId: RouteId; reasoningOrigin: string }>;
	private clock: () => number;
	/**
	// (formerly parallel to rateLimits; now parallel to routeHealth): ids of
	 * `readiness` exists and `isReady() === false`. A not-ready backend is
	 * excluded from `listEligible`/`listBackends` and `resolveModel` defers to
	 * it as `transient-unavailable`. Seeded from any backend exposing
	 * `readiness`; cleared per concrete id by `clearNotReady` on expansion.
	 * Provider-agnostic — umans is merely the first `readiness` implementer.
	 */
	private notReady: Set<string>;
	/**
	 * Catalog-resolved reasoning metadata per backendId plus the winning source
	 * (requirement 2, `2026-11-21-model-catalog.md` §3.1). Written by
	 * `applyResolvedCatalog`; read by `getThinkingConfig` / `getEffort` to DERIVE a
	 * reasoning request for a backend whose config sets no explicit `thinking`.
	 * Explicit per-backend config always wins (requirement 4), so this only fills
	 * the absence; a backend with no resolved reasoning stays underived.
	 */
	private resolvedReasoning: Map<string, { reasoning: ResolvedReasoning; source: FieldSource }>;

	constructor(
		backends: Map<string, LLMBackend>,
		defaultId: string,
		effectiveCaps?: Map<string, BackendCapabilities>,
		backendConfigs?: Map<string, BackendConfig>,
		notReady?: Set<string>,
		clock: () => number = Date.now,
		routeIdentities?: Map<string, { routeId: RouteId; reasoningOrigin: string }>,
	) {
		this.backends = backends;
		this.defaultId = defaultId;
		this.effectiveCaps =
			effectiveCaps ??
			new Map(Array.from(backends.entries()).map(([id, b]) => [id, b.capabilities()]));
		this.routeHealth = new RouteHealth(clock);
		this.backendConfigs = backendConfigs ?? new Map();
		this.resolvedPricing = new Map();
		this.resolvedReasoning = new Map();
		this.clock = clock;
		this.routeIdentities = routeIdentities ?? new Map();
		this.notReady =
			notReady ??
			new Set(
				Array.from(backends.entries())
					.filter(([, b]) => b.readiness && !b.readiness.isReady())
					.map(([id]) => id),
			);
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
		// Dispose readiness on superseded backends BEFORE reassigning so an
		// in-flight lineup fetch holding the OLD registrar (bound to the same
		// live router) cannot register stale models / clobber the re-seeded
		// not-ready set after reload. Capture the prior backends first.
		const prior = this.backends;
		for (const backend of prior.values()) {
			backend.readiness?.dispose();
		}
		this.backends = next.backends;
		this.defaultId = next.defaultId;
		this.effectiveCaps = next.effectiveCaps;
		this.routeIdentities = next.routeIdentities;
		this.backendConfigs = next.backendConfigs;
		this.routeHealth.reset();
		// Re-seed not-ready from the freshly-constructed readiness backends.
		this.notReady = new Set(
			Array.from(next.backends.entries())
				.filter(([, b]) => b.readiness && !b.readiness.isReady())
				.map(([id]) => id),
		);
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

	/**
	 * Returns BackendInfo list with EFFECTIVE capabilities (driver baseline
	 * merged with config overrides). Not-ready backends (readiness present and
	 * not yet ready) are EXCLUDED so `advertiseLocalModels` doesn't publish a
	 * placeholder/namespace id, and so capability resolution never sees the
	 * conservative placeholder caps.
	 */
	listBackends(): BackendInfo[] {
		return Array.from(this.backends.keys())
			.filter((id) => !this.isNotReady(id))
			.map((id) => {
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
							max_context: UNRESOLVED_CONTEXT_WINDOW,
						},
				};
			});
	}

	/**
	 * All registered backend ids, INCLUDING not-ready ones (R-MC4-gated static
	 * backends and readiness-bearing namespace placeholders alike). Catalog
	 * resolution (`resolveLocalCatalog`) iterates this so a backend gated
	 * not-ready at first boot (no window resolved yet) is still re-examined on a
	 * later `models.dev` refresh and can flip ready — `listBackends` excludes
	 * not-ready ids and would strand it. The caller skips readiness-bearing
	 * placeholders itself.
	 */
	listAllBackendIds(): string[] {
		return Array.from(this.backends.keys());
	}

	/**
	 * ORIGINAL listBackends doc retained below; the method is defined above.
	listBackends(): BackendInfo[] {
		return Array.from(this.backends.keys())
			.filter((id) => !this.isNotReady(id))
			.map((id) => {
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
			if (this.isNotReady(id)) continue;

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
	 * Compatibility shim over {@link RouteHealth} (#285): records a route failure
	 * and places the backend in `backoff`. Historically this took a verbatim
	 * cooldown duration; it now feeds the health machine. When `retryAfterMs` is
	 * supplied (a `429` with a `Retry-After`), the exact duration is honored; when
	 * it is the legacy 60s default sentinel, the exponential schedule applies
	 * instead so repeated failures grow the backoff per R-RT11.
	 *
	 * Prefer {@link recordRouteFailure} for new call sites — it carries the error
	 * kind needed for R-RT13 advisory handling.
	 *
	 * @param id - Backend ID (1:1 with its `RouteId`) to mark unhealthy
	 * @param retryAfterMs - Exact `Retry-After` duration in ms, or the legacy
	 *   60_000 default when the header was absent
	 */
	markRateLimited(id: string, retryAfterMs: number): void {
		// The legacy call site passes `getLlmRetryAfterMs(error) || 60_000`. A real
		// Retry-After is an exact rate-limit wait; the 60s fallback is a placeholder
		// that must defer to the exponential schedule so backoff actually grows.
		const hasExplicitRetryAfter = retryAfterMs !== 60_000;
		this.routeHealth.recordFailure(id, {
			errorKind: "rate_limit",
			retryAfterMs: hasExplicitRetryAfter ? retryAfterMs : undefined,
		});
	}

	/**
	 * Record a classified route failure against a route's health (#285, R-RT11/
	 * R-RT13). Moves the backend to `backoff` with the exponential schedule, or
	 * the exact `retryAfterMs` for a `429`. The `errorKind` drives the error-
	 * specific handling in §6.1 (auth refresh, driver-bug advisories).
	 */
	recordRouteFailure(id: string, opts: { errorKind: RouteErrorKind; retryAfterMs?: number }): void {
		this.routeHealth.recordFailure(id, opts);
	}

	/**
	 * Record a successful turn against a route's health (#285, R-RT12). A success
	 * on a `half_open` trial route restores it to `healthy`.
	 */
	recordRouteSuccess(id: string): void {
		this.routeHealth.recordSuccess(id);
	}

	/**
	 * Whether a `half_open` route may accept a trial turn from this candidate
	 * thread right now (#285, R-RT12): at most one concurrent trial per host, and
	 * only from a new or cold-cache thread — never a warm sticky thread. Claims
	 * the single per-host trial slot when `claim` is set and the slot is free.
	 */
	canTrialRoute(id: string, opts: { coldOrNewThread: boolean; claim?: boolean }): boolean {
		if (opts.claim) {
			if (!this.routeHealth.canTrial(id, opts)) return false;
			return this.routeHealth.beginTrial(id);
		}
		return this.routeHealth.canTrial(id, opts);
	}

	/** Returns the local route-health state for a backend (#285). */
	getRouteHealthState(id: string): ReturnType<RouteHealth["getState"]> {
		return this.routeHealth.getState(id);
	}

	/**
	 * Returns true if the backend is NOT currently selectable for routing — i.e.
	 * its route is in `backoff` (#285). A `half_open` route returns false here
	 * because it accepts one real trial turn per host; `healthy` returns false.
	 * Named `isRateLimited` for call-site compatibility; the predicate is now
	 * "unavailable due to route health", which subsumes rate limits.
	 */
	isRateLimited(id: string): boolean {
		return !this.routeHealth.isAvailable(id);
	}

	/**
	 * Whether a route is reusable by a WARM sticky thread (#285, R-RT12). Only
	 * `healthy` routes qualify: a `half_open` route must be trialled by a NEW or
	 * cold-cache thread, never pulled back under a warm thread that is already
	 * working elsewhere. The sticky pool uses this instead of `!isRateLimited`,
	 * which would (incorrectly) re-admit a `half_open` route to a warm thread.
	 */
	isHealthyForSticky(id: string): boolean {
		return this.routeHealth.getState(id).status === "healthy";
	}

	/**
	 * Returns true if the backend exists in the router but is not yet ready
	 * (a `readiness`-bearing backend whose lineup fetch hasn't landed). Such a
	 * backend is excluded from selection and `resolveModel` defers to it as
	 * `transient-unavailable`. Provider-agnostic.
	 */
	isNotReady(id: string): boolean {
		return this.notReady.has(id);
	}

	// --- Provider-agnostic dynamic-backend primitives (used by the CLI-layer
	// registrar in inference.ts). The router never writes appContext.config —
	// the registrar owns the shared-config pricing-row writes (package boundary).

	/**
	 * Add (or replace) a concrete model backend at runtime — e.g. when a
	 * dynamic provider's lineup fetch resolves and materializes one backend per
	 * model id. Sets the backend, its effective caps, and (optionally) its route
	 * not-ready flag for the id.
	 */
	addDynamicBackend(
		id: string,
		backend: LLMBackend,
		caps: BackendCapabilities,
		maxOutputTokens?: number,
		routeIdentity?: { routeId: RouteId; reasoningOrigin: string },
	): void {
		this.backends.set(id, backend);
		this.effectiveCaps.set(id, caps);
		if (routeIdentity) this.routeIdentities.set(id, routeIdentity);
		// Record the per-model output budget so getMaxOutputTokens resolves it.
		// Dynamic backends (e.g. umans models fetched at warmup) have no static
		// config row in backendConfigs; without this the loop sends no max_tokens
		// and the provider applies a low default (~4096), truncating heavy
		// reasoners mid-thinking. Merge onto any existing config to avoid
		// clobbering fields a prior registration set.
		if (typeof maxOutputTokens === "number") {
			const existing = this.backendConfigs.get(id);
			this.backendConfigs.set(id, {
				...(existing ?? { id, provider: "", model: id }),
				maxOutputTokens,
			} as BackendConfig);
		}
		this.notReady.delete(id);
	}

	/** Remove a backend (e.g. the namespace placeholder after expansion). */
	removeBackend(id: string): void {
		this.backends.delete(id);
		this.effectiveCaps.delete(id);
		this.routeIdentities.delete(id);
		this.notReady.delete(id);
		this.routeHealth.clear(id);
	}

	/** Clear the not-ready flag for an id (it has become selectable). */
	clearNotReady(id: string): void {
		this.notReady.delete(id);
	}

	/**
	 * Mark a backend not-ready so it is excluded from `listBackends`/
	 * `listEligible`/`resolveModel` (deferred as `transient-unavailable`) and
	 * from advertisement. Symmetric with {@link clearNotReady}. The catalog
	 * readiness gate (R-MC4) uses this to exclude a resolved static backend
	 * whose `max_context` is unresolved across all metadata layers, reusing the
	 * same not-ready mechanism readiness-bearing backends rely on rather than a
	 * parallel gate. No-op if the id is unknown to the router.
	 */
	markNotReady(id: string): void {
		if (this.backends.has(id)) this.notReady.add(id);
	}

	/**
	 * Apply resolved catalog metadata (slice 6 follow-up, R-MC2/R-MC4,
	 * `2026-11-21-model-catalog.md` §3) to the LOCAL routing path. The pure
	 * `resolveCatalog` has already merged config > provider > `models.dev`
	 * per field; this is the production consumer that writes the resolved
	 * `max_context` onto each ready backend's effective capabilities and the
	 * resolved `max_output_tokens` onto its backend config, so that local turns
	 * (model-resolution's local branch → agent-loop `contextWindow` / truncation
	 * target / `max_tokens`) use the resolved values rather than only the
	 * constructor `contextWindow` from static config.
	 *
	 * Narrow by design: it touches ONLY `max_context` and `max_output_tokens`,
	 * the two fields that drive routing budget. It does not overwrite
	 * capability flags (those already merge config over driver baseline at
	 * construction) or pricing (owned by the shared-config pricing rows).
	 *
	 * Idempotent and reversible-safe: re-running after a `models.dev` refresh
	 * re-applies the latest resolution. Only READY backends present in the
	 * router are touched — an unready backend (R-MC4 gate) and an id unknown to
	 * the router are both skipped.
	 *
	 * Output-limit cap: a `max_output_tokens` that did NOT come from local config
	 * is capped at {@link MAX_OUTPUT_CONTEXT_FRACTION} of the resolved
	 * `max_context`. Context management assumes the output reservation is small
	 * relative to the window (`computeBaseTruncationTarget = max_context -
	 * max_output`); a provider that reports output equal to the whole window
	 * would otherwise leave no room for the prompt. A config-sourced value is
	 * always respected — the operator's explicit cap is authoritative.
	 */
	applyResolvedCatalog(
		catalog: ReadonlyMap<string, ResolvedCatalogEntry>,
		logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
	): void {
		for (const [backendId, resolved] of catalog) {
			if (!resolved.ready) continue;
			if (!this.backends.has(backendId)) continue;

			const resolvedMaxContext = resolved.metadata.capabilities.max_context;
			if (typeof resolvedMaxContext === "number") {
				const caps = this.effectiveCaps.get(backendId);
				if (caps) {
					this.effectiveCaps.set(backendId, { ...caps, max_context: resolvedMaxContext });
				}
			}

			const resolvedMaxOutput = resolved.metadata.max_output_tokens;
			const outputSource = resolved.metadata.field_sources.max_output_tokens;
			if (typeof resolvedMaxOutput === "number") {
				let maxOutput = resolvedMaxOutput;
				// A config value is authoritative even if it exceeds the cap.
				if (outputSource !== "config") {
					const window = resolvedMaxContext ?? this.effectiveCaps.get(backendId)?.max_context;
					if (typeof window === "number" && window > 0) {
						const cap = Math.floor(window * MAX_OUTPUT_CONTEXT_FRACTION);
						if (maxOutput > cap) {
							logger?.warn(
								"[llm] Capping reported max_output_tokens to a fraction of max_context",
								{
									backend: backendId,
									reportedMaxOutputTokens: maxOutput,
									maxContext: window,
									cappedTo: cap,
								},
							);
							maxOutput = cap;
						}
					}
				}
				const existing = this.backendConfigs.get(backendId);
				this.backendConfigs.set(backendId, {
					...(existing ?? { id: backendId, provider: "", model: backendId }),
					maxOutputTokens: maxOutput,
				} as BackendConfig);
			}

			// Store the catalog-resolved pricing (tier-aware) for cost calculation at
			// turn-record time. The pricing block already merged provider over
			// models.dev per field; the winning source for the pricing block is taken
			// from `field_sources` (any pricing component's source — they share one
			// precedence pass). A config-sourced price is NOT stored here: the cost
			// layer reads operator overrides from the shared-config rows directly, and
			// this map carries only the catalog (provider/models.dev) fallback.
			const pricing = resolved.metadata.pricing;
			if (pricing) {
				const sources = resolved.metadata.field_sources;
				const pricingSource =
					sources["pricing.input_per_m"] ??
					sources["pricing.output_per_m"] ??
					sources["pricing.cache_read_per_m"] ??
					sources["pricing.cache_write_5m_per_m"] ??
					sources["pricing.cache_write_1h_per_m"];
				if (pricingSource === "provider" || pricingSource === "models_dev") {
					this.resolvedPricing.set(backendId, { pricing, source: pricingSource });
				}
			}

			// Store the catalog-resolved reasoning metadata (provider over models.dev)
			// for driver-default derivation at getThinkingConfig / getEffort. A
			// config-sourced reasoning capability is not meaningful here (config carries
			// explicit thinking/effort directly, which always wins), so only the
			// provider/models.dev fallback is stored.
			const reasoning = resolved.metadata.capabilities.reasoning;
			const reasoningSource = resolved.metadata.field_sources.reasoning;
			if (reasoning && (reasoningSource === "provider" || reasoningSource === "models_dev")) {
				this.resolvedReasoning.set(backendId, { reasoning, source: reasoningSource });
			}
		}
	}

	/**
	 * The catalog-resolved pricing for a backend (provider API or `models.dev`,
	 * tier-aware) plus which layer supplied it, or `undefined` when the catalog
	 * knows no price. Read by cost calculation (`resolveTurnCost`) on the local and
	 * relay paths so the serving host prices a turn from the catalog when the
	 * operator set no explicit `price_per_m_*` override.
	 */
	getResolvedPricing(
		backendId: string,
	): { pricing: ResolvedPricing; source: "provider" | "models_dev" } | undefined {
		return this.resolvedPricing.get(backendId);
	}

	/**
	 * Redirect the default backend id if it currently points at `fromId` (e.g.
	 * the namespace placeholder) — repoint it at a concrete expanded id. No-op
	 * if the default isn't `fromId`.
	 */
	redirectDefault(fromId: string, toId: string): void {
		if (this.defaultId === fromId) this.defaultId = toId;
	}

	/**
	 * Returns the readiness-bearing backends currently registered (id + backend),
	 * for the wiring helper to call `readiness.start(registrar)`. Provider-
	 * agnostic — no `instanceof` checks. Pooled backends never expose
	 * `readiness`, so they are naturally skipped.
	 */
	getReadinessBackends(): Array<{ id: string; backend: LLMBackend }> {
		const out: Array<{ id: string; backend: LLMBackend }> = [];
		for (const [id, backend] of this.backends) {
			if (backend.readiness) out.push({ id, backend });
		}
		return out;
	}

	/**
	 * Returns the earliest trial timestamp (ms) among backing-off backends that
	 * satisfy the given capability requirements. Returns null if no such backend exists.
	 * Used by resolveModel() to populate `earliestRecovery` on transient-unavailable errors.
	 */
	getEarliestCapableRecovery(requirements?: CapabilityRequirements): number | null {
		return this.routeHealth.earliestRecovery((id) => {
			const caps = this.effectiveCaps.get(id);
			if (!caps) return false;
			if (requirements) {
				if (requirements.vision && !caps.vision) return false;
				if (requirements.tool_use && !caps.tool_use) return false;
				if (requirements.system_prompt && !caps.system_prompt) return false;
				if (requirements.prompt_caching && !caps.prompt_caching) return false;
			}
			return true;
		});
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
				type?: "enabled" | "adaptive" | "tool";
				budget_tokens?: number;
				display?: "omitted" | "summarized";
			};
			if (t.type === "tool") return { type: "disabled" };
			if (t.type === "adaptive") {
				return { type: "adaptive", display: t.display ?? "summarized" };
			}
			return { type: "enabled", budget_tokens: t.budget_tokens ?? 10000 };
		}
		// No explicit config thinking (requirement 2): derive from resolved catalog
		// reasoning metadata. Explicit config above always wins (requirement 4).
		return this.deriveThinkingFromMetadata(backendId);
	}

	/**
	 * Derive a `thinking` request from the catalog-resolved reasoning metadata when
	 * a backend sets no explicit `thinking` config (requirement 2, catalog §3.1).
	 * The decision uses only published facts — never a model-ID test:
	 *
	 * - no resolved reasoning at all → `undefined` (no source; invent nothing).
	 * - `supported === false` → `{type:"disabled"}` (the source says this model does
	 *   no reasoning, so actively request none).
	 * - the source advertises `adaptive` → `{type:"adaptive"}` (model-controlled depth;
	 *   today only GitHub Copilot's catalog publishes this).
	 * - otherwise (a toggle and/or an effort ladder, i.e. reasoning is on) →
	 *   `{type:"enabled"}`. Driver protocol rules filter this further: a non-Anthropic
	 *   Bedrock model drops `budgetTokens`, and an effort-only model forwards effort
	 *   through its own mechanism.
	 */
	private deriveThinkingFromMetadata(backendId: string): ChatParams["thinking"] | undefined {
		const entry = this.resolvedReasoning.get(backendId);
		if (!entry) return undefined;
		const r = entry.reasoning;
		if (r.supported === false) return { type: "disabled" };
		if (r.adaptive) return { type: "adaptive", display: "summarized" };
		return { type: "enabled", budget_tokens: 10000 };
	}

	/** Returns whether this backend replaces native reasoning with Bound's think tool. */
	usesThinkingTool(backendId: string): boolean {
		const config = this.backendConfigs.get(backendId);
		return (
			typeof config?.thinking === "object" &&
			config.thinking !== null &&
			(config.thinking as { type?: string }).type === "tool"
		);
	}

	/**
	 * Returns the `effort` level configured for a backend, or undefined if
	 * unset. Tool-thinking mode deliberately suppresses it: absence is not a
	 * disable request on several providers, but the explicit disabled thinking
	 * config from getThinkingConfig() is.
	 */
	getEffort(backendId: string): ChatParams["effort"] | undefined {
		if (this.usesThinkingTool(backendId)) return undefined;
		const config = this.backendConfigs.get(backendId);
		if (!config) return undefined;
		const effort = config.effort as ChatParams["effort"] | undefined;
		if (effort === undefined) return undefined;
		// Clamp an effort the model does not list to the nearest listed value
		// (requirement 3). The ladder comes from resolved catalog reasoning metadata;
		// without one the value passes through and the driver's own protocol gate
		// (`BEDROCK_EFFORTS` / `ANTHROPIC_EFFORTS` / Copilot `resolveReasoningEffort`)
		// decides. Never a model-ID test.
		return clampEffortToLadder(
			effort,
			this.resolvedReasoning.get(backendId)?.reasoning.effort_values,
		);
	}

	/**
	 * Returns the per-backend `maxOutputTokens` cap, or undefined if unset.
	 * When set, the agent-loop clamps via `min(cap, configuredMax)` so
	 * Bedrock models with tight output limits (e.g. Nova Pro's 10_000 cap)
	 * don't 400 with "max_tokens exceeds model limit".
	 */
	getMaxOutputTokens(backendId: string): number | undefined {
		const config = this.backendConfigs.get(backendId);
		if (!config) return undefined;
		const cap = config.maxOutputTokens;
		return typeof cap === "number" ? cap : undefined;
	}

	/** Returns the per-backend system prompt suffix, if configured. */
	getSystemPromptSuffix(backendId: string): string | undefined {
		return this.backendConfigs.get(backendId)?.systemPromptSuffix;
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
	 * Live regression that motivated this defaulting: a thread ran with
	 * cr=0 across most of its turns because Sonnet's config didn't
	 * explicitly set `cacheTtl`. The
	 * Bedrock driver's `shouldEnableSystemCachePoint` gate disabled the
	 * system anchor when both `cache_ttl` was undefined AND the
	 * message-level marker wasn't placed — both layers failed silently,
	 * caching was completely off.
	 */
	getCacheTtl(backendId: string): string | undefined {
		const config = this.backendConfigs.get(backendId);
		const explicit = config?.cacheTtl;
		if (explicit !== undefined) return explicit;
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
	 * Returns the `RouteId` (`${siteId}:${provider}:${backendId}`) for a
	 * registered backend, or null if the backend has no recorded route identity
	 * (e.g. a dynamic backend registered without a site id). R-RT1.
	 */
	getRouteId(backendId: string): RouteId | null {
		return this.routeIdentities.get(backendId)?.routeId ?? null;
	}

	/**
	 * Returns the provider `reasoningOrigin` (`${siteId}:${provider}[:${detail}]`)
	 * recorded for a backend, or null if none. DISTINCT from {@link getRouteId}:
	 * this is the encrypted-reasoning mint-provenance stamp (44206fda), never the
	 * routing identity (R-RT1).
	 */
	getReasoningOrigin(backendId: string): string | null {
		return this.routeIdentities.get(backendId)?.reasoningOrigin ?? null;
	}
}

function createBackendFromConfig(
	config: BackendConfig,
	logger?: Logger,
	fetch?: typeof globalThis.fetch,
	siteId?: string,
): LLMBackend {
	const provider = config.provider.toLowerCase();

	switch (provider) {
		case "bedrock": {
			const region = config.region as string | undefined;
			if (!region) {
				throw new Error("Bedrock driver requires region in config");
			}
			const profile = config.profile as string | undefined;
			const contextWindow = config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW;
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

		case "anthropic": {
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error("Anthropic driver requires apiKey in config");
			}
			const contextWindow = config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW;
			return new AnthropicDriver({
				apiKey,
				model: config.model,
				contextWindow,
				baseUrl: config.baseUrl,
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
			const contextWindow = config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW;
			return new OpenAICompatibleDriver({
				baseUrl,
				apiKey,
				model: config.model,
				contextWindow,
				providerName: "openai-compatible",
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
				additionalHeaders: config.additionalHeaders,
			});
		}

		case "cerebras": {
			const baseUrl = config.baseUrl ?? "https://api.cerebras.ai/v1";
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error("Cerebras driver requires apiKey in config");
			}
			const contextWindow = config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW;
			return new OpenAICompatibleDriver({
				baseUrl,
				apiKey,
				model: config.model,
				contextWindow,
				providerName: "cerebras",
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
				additionalHeaders: config.additionalHeaders,
			});
		}

		case "zai": {
			const baseUrl = config.baseUrl ?? "https://api.z.ai/api/coding/paas/v4";
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error("z.AI driver requires apiKey in config");
			}
			const contextWindow = config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW;
			return new OpenAICompatibleDriver({
				baseUrl,
				apiKey,
				model: config.model,
				contextWindow,
				providerName: "zai",
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
				additionalHeaders: config.additionalHeaders,
			});
		}

		case "chatgpt-oauth": {
			const contextWindow = config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW;
			const store = new FileTokenStore(config.tokenStorePath ?? "config/chatgpt-auth.json");
			const tokens = store.load();
			if (!tokens) {
				throw new Error("ChatGPT OAuth is not logged in — run `bound login --chatgpt`");
			}
			return new ChatGptOAuthDriver({
				tokenManager: new TokenManager(tokens, { fetch: fetch ?? globalThis.fetch }, store),
				model: config.model,
				contextWindow,
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
				siteId,
			});
		}

		case "github-copilot": {
			const contextWindow = config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW;
			const storePath = config.tokenStorePath ?? "config/copilot-auth.json";
			const deps = { fetch: fetch ?? globalThis.fetch };
			// One token manager per store file. Refresh rotates the ghr_ token (the
			// old one dies), so N backends holding N managers over one file would
			// race the same refresh token when they expire together.
			let tokenManager = copilotTokenManagers.get(storePath);
			if (!tokenManager) {
				const store = new FileCopilotTokenStore(storePath);
				const tokens = store.load();
				if (!tokens) {
					throw new Error("GitHub Copilot is not logged in — run `bound login --copilot`");
				}
				tokenManager = new CopilotTokenManager(tokens, deps, store);
				copilotTokenManagers.set(storePath, tokenManager);
			}
			const manager = tokenManager;
			const resolveAccount = () =>
				manager.getAccessToken().then((accessToken) => fetchAccountInfo(deps, accessToken));
			// No `model` => self-configuring namespace: it owns `readiness`, fetches the
			// account's Copilot catalog, and expands into one per-model backend per
			// chat-routable model (catalog §4.1). `model` present => a single concrete
			// backend, unchanged. `model: undefined` is passed through so the driver's
			// namespace detection (`config.model === undefined`) fires.
			return new GitHubCopilotDriver({
				tokenManager: manager,
				// `model` present => a single concrete backend. `model: undefined`
				// is passed through so the driver's namespace detection
				// (`config.model === undefined`) fires and it self-configures.
				model: config.model,
				// No `model` => namespace instance also gets its per-model override map so
				// expansion can apply each model's request controls (requirement 2). Expanded
				// per-model backend ids are `${config.id}-${providerModelId}`.
				...(config.model || !config.copilotModelOverrides
					? {}
					: { copilotModelOverrides: config.copilotModelOverrides }),
				contextWindow,
				// The validated Copilot API endpoint is plan-specific and comes from
				// the account lookup — resolved once, lazily, on first chat.
				resolveAccount,
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
				siteId,
			});
		}

		case "opencode-go": {
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error("OpenCode Go driver requires apiKey in config");
			}
			const contextWindow = config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW;
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

		case "umans": {
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error("umans driver requires apiKey in config");
			}
			// Build the shared per-account state (provider, semaphore, usage
			// cache, injectable fetchers) and the not-ready NAMESPACE/lineup
			// driver registered under the config id. The fetch is NOT started
			// here — wireBackendReadiness calls readiness.start(registrar)
			// after construction so the registrar is bound first.
			const account = createUmansAccount({
				apiKey,
				baseUrl: config.baseUrl,
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
				// Optional test-injectable fetchers, threaded via the BackendConfig
				// index signature. Production config never sets these.
				metadataFetch: config.metadataFetch as
					Parameters<typeof createUmansAccount>[0]["metadataFetch"] | undefined,
				usageFetch: config.usageFetch as
					Parameters<typeof createUmansAccount>[0]["usageFetch"] | undefined,
			});
			return new UmansDriver({ account, namespaceId: config.id, logger });
		}

		case "bedrock-mantle": {
			const region = config.region as string | undefined;
			if (!region) {
				throw new Error("Bedrock Mantle driver requires region in config");
			}
			const providerMode = config.providerMode as "anthropic" | "openai_responses" | undefined;
			if (!providerMode) {
				throw new Error("Bedrock Mantle driver requires providerMode in config");
			}
			const profile = config.profile as string | undefined;
			const contextWindow = config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW;
			return new BedrockMantleDriver({
				region,
				model: config.model,
				contextWindow,
				providerMode,
				profile,
				baseUrl: config.baseUrl,
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
				siteId,
			});
		}

		default:
			// `ollama` and other providers were removed in the 2026-04-25 AI SDK
			// migration — local inference now goes through `openai-compatible`
			// (Ollama serves an OpenAI-compatible API at /v1). `anthropic` was
			// restored as a first-class direct backend in issue #176 (see the
			// case above). A config naming any other provider needs updating.
			throw new Error(`Provider not supported: ${config.provider}`);
	}
}

interface RouterState {
	backends: Map<string, LLMBackend>;
	defaultId: string;
	effectiveCaps: Map<string, BackendCapabilities>;
	backendConfigs: Map<string, BackendConfig>;
	routeIdentities: Map<string, { routeId: RouteId; reasoningOrigin: string }>;
}

function buildRouterState(
	config: ModelBackendsConfig,
	logger?: Logger,
	fetchByBackendId?: Map<string, typeof globalThis.fetch>,
	siteId?: string,
): RouterState {
	// ModelRouter is a flat local route registry (R-RT1): one route per backend
	// id, no same-id pooling. Same-model pooling across providers/hosts is
	// subsumed by unified candidate ranking in resolveModel (§5.1), and per-entry
	// backoff by the per-RouteId cooldown (markRateLimited / #285 route health).
	const backends = new Map<string, LLMBackend>();
	const effectiveCaps = new Map<string, BackendCapabilities>();
	const backendConfigs = new Map<string, BackendConfig>();
	const routeIdentities = new Map<string, { routeId: RouteId; reasoningOrigin: string }>();

	for (const backendConfig of config.backends) {
		const fetchOverride = fetchByBackendId?.get(backendConfig.id);
		const backend = createBackendFromConfig(backendConfig, logger, fetchOverride, siteId);
		const baseline = backend.capabilities();
		const capOverride =
			(backendConfig.capabilities as Partial<BackendCapabilities> | undefined) ?? {};
		const effectiveCap = { ...baseline, ...capOverride };

		// A later duplicate id overwrites the earlier one (last-wins). Pooling of
		// multiple providers under one id is gone; an operator who wants two
		// providers for one logical model gives them distinct backend ids and the
		// catalog's logical_model grouping (slice 6) pools them for ranking.
		backends.set(backendConfig.id, backend);
		effectiveCaps.set(backendConfig.id, effectiveCap);
		backendConfigs.set(backendConfig.id, backendConfig);
		if (siteId !== undefined) {
			const provider = backendConfig.provider;
			routeIdentities.set(backendConfig.id, {
				routeId: makeRouteId(siteId, provider, backendConfig.id),
				// `reasoningOrigin` detail (region:mode) is driver-owned and stamped
				// at mint time; the router records only the provider-level stem here.
				reasoningOrigin: `${siteId}:${provider}`,
			});
		}
	}

	// Hub-only mode: empty backends array is valid (inference proxied to spokes).
	// In this case the default is "" and no local backends are available.
	if (config.backends.length === 0) {
		return { backends, defaultId: "", effectiveCaps, backendConfigs, routeIdentities };
	}

	// Verify default backend exists
	const defaultExists = backends.has(config.default);
	if (!defaultExists) {
		throw new LLMError(`Default backend "${config.default}" not found in backends`, "router");
	}

	return { backends, defaultId: config.default, effectiveCaps, backendConfigs, routeIdentities };
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
	/** Optional clock override for deterministic rate-limit handling. */
	clock?: () => number;
	/**
	 * This host's site id, forwarded to deployment-bound drivers (bedrock-mantle)
	 * so they can stamp minted encrypted reasoning with their own deployment
	 * identity (`${siteId}:${region}:${providerMode}`) and drop foreign encrypted
	 * reasoning at request-build time. Unset in tests that don't exercise the
	 * cross-host encrypted-reasoning path.
	 */
	siteId?: string;
}

export function createModelRouter(
	config: ModelBackendsConfig,
	options?: CreateModelRouterOptions,
): ModelRouter {
	const state = buildRouterState(
		config,
		options?.logger,
		options?.fetchByBackendId,
		options?.siteId,
	);
	return new ModelRouter(
		state.backends,
		state.defaultId,
		state.effectiveCaps,
		state.backendConfigs,
		undefined,
		options?.clock,
		state.routeIdentities,
	);
}
