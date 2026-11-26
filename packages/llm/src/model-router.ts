import type { Logger } from "@bound/shared";
import { hintMatchesLogicalModel } from "@bound/shared";
import { createBackendFromConfig } from "./backend-factory";
import { normalizeModelKey } from "./catalog/normalize";
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
 * Declared locally so the router — which must not depend on
 * the catalog orchestrator — reads only the fields that drive routing budget.
 * The production `ResolvedBackend` from `catalog/resolve-catalog.ts` is
 * structurally assignable to this.
 */
export interface ResolvedCatalogEntry {
	ready: boolean;
	metadata: {
		capabilities: {
			max_context?: number;
			vision?: boolean;
			extended_thinking?: boolean;
			reasoning?: ResolvedReasoning;
		};
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
 * Upper bound on a provider- or registry-reported `max_output_tokens`, as a
 * fraction of the resolved context window. Operator decision:
 * context management assumes the output reservation is much smaller than the
 * window, and some providers report output equal to the whole window. 25%
 * leaves today's 128k output limits on 512k+ windows untouched. A
 * `max_output_tokens` set in local config is never capped.
 */
export const MAX_OUTPUT_CONTEXT_FRACTION = 0.25;

/**
 * Reasoning-effort levels in ascending strength, used to clamp a configured or
 * default effort to the nearest value a model actually lists
 * (`2026-11-21-model-catalog.md` §3.1). This is a protocol-level strength ordering,
 * not a per-model capability list — the per-model ladder is the resolved
 * `effort_values`, which this only walks to pick the nearest listed neighbour.
 */
const EFFORT_STRENGTH_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Clamp `effort` to the nearest value in the model's resolved `ladder`.
 * When the model lists the exact value, it passes through. When
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
 * Conservative capability descriptor for a backend whose real surface is not
 * known locally: nothing beyond the minimum is assumed, and `max_context: 0`
 * reads as "advertises no max_context" (R-RT2 ineligible).
 */
export const DEFAULT_BACKEND_CAPABILITIES: Readonly<BackendCapabilities> = Object.freeze({
	streaming: false,
	tool_use: false,
	system_prompt: false,
	prompt_caching: false,
	vision: false,
	extended_thinking: false,
	max_context: 0,
});

export class ModelRouter {
	private backends: Map<string, LLMBackend>;
	private defaultId: string;
	private effectiveCaps: Map<string, BackendCapabilities>;
	/**
	 * Per-host route health (#285, spec §6.1, R-RT11–R-RT13). Keyed by local
	 * `backendId` (1:1 with `RouteId`): a backend in `backoff` is unavailable, a
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
	 * Ids of backends whose `readiness` exists and `isReady() === false`. A
	 * not-ready backend is excluded from `listEligible`/`listBackends` and
	 * `resolveModel` defers to it as `transient-unavailable`. Seeded from any
	 * backend exposing `readiness`; cleared per concrete id by `clearNotReady`
	 * on expansion.
	 */
	private notReady: Set<string>;
	/**
	 * Catalog-resolved reasoning metadata per backendId plus the winning source
	 * (`2026-11-21-model-catalog.md` §3.1). Written by
	 * `applyResolvedCatalog`; read by `getThinkingConfig` / `getEffort` to DERIVE a
	 * reasoning request for a backend whose config sets no explicit `thinking`.
	 * Explicit per-backend config always wins, so this only fills
	 * the absence; a backend with no resolved reasoning stays underived.
	 */
	private resolvedReasoning: Map<string, { reasoning: ResolvedReasoning; source: FieldSource }>;
	private readonly logger?: Logger;
	private readonly fetchByBackendId?: Map<string, typeof globalThis.fetch>;
	private readonly siteId?: string;
	/**
	 * An expanded backend id named by `model_backends.default` that the lineup
	 * has not registered yet (see `buildRouterState`), plus the namespace entry
	 * whose expansion should produce it. While set, `defaultId` names the
	 * namespace placeholder; `addDynamicBackend` switches the default to `id`
	 * when it registers. Cleared when that namespace's placeholder is removed
	 * (its expansion is complete) and on reload.
	 */
	private pendingDefault: { id: string; namespaceId: string } | null;

	constructor(
		backends: Map<string, LLMBackend>,
		defaultId: string,
		effectiveCaps?: Map<string, BackendCapabilities>,
		backendConfigs?: Map<string, BackendConfig>,
		notReady?: Set<string>,
		clock: () => number = Date.now,
		routeIdentities?: Map<string, { routeId: RouteId; reasoningOrigin: string }>,
		reloadContext?: {
			logger?: Logger;
			fetchByBackendId?: Map<string, typeof globalThis.fetch>;
			siteId?: string;
		},
		pendingDefault: { id: string; namespaceId: string } | null = null,
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
		this.logger = reloadContext?.logger;
		this.fetchByBackendId = reloadContext?.fetchByBackendId;
		this.siteId = reloadContext?.siteId;
		this.pendingDefault = pendingDefault;
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
	 * Atomicity: if the new config is invalid (e.g. an unknown default,
	 * unsupported provider), the router is left in its prior state and the
	 * error propagates to the caller.
	 *
	 * Side effect: route health is reset — backends are reconstructed from
	 * scratch, so prior failure state is not meaningful against the new
	 * driver instances.
	 */
	reload(config: ModelBackendsConfig): void {
		const next = buildRouterState(config, this.logger, this.fetchByBackendId, this.siteId);
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
		this.pendingDefault = next.pendingDefault;
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
						backend?.capabilities() ?? { ...DEFAULT_BACKEND_CAPABILITIES },
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
	 * Returns the default backend ID. While a `default` naming a
	 * namespace-expanded id is still awaiting its lineup, this is the owning
	 * namespace's id (an omitted-model turn then reports it not-ready).
	 */
	getDefaultId(): string {
		return this.defaultId;
	}

	/** Returns the backend for modelId, or null if not found (non-throwing). */
	tryGetBackend(modelId: string): LLMBackend | null {
		return this.backends.get(modelId) ?? null;
	}

	/**
	 * Resolve a model HINT to a local backend id, matching THROUGH the logical
	 * model when no backend id matches literally (2026-11-21-model-catalog.md
	 * §2.1, #281). A self-configuring namespace expands a backend to an id like
	 * `bedrock-use1-openai.gpt-5.6-sol` that groups under the logical model
	 * `gpt-5-6-sol`; a thread/task/agent still carrying the old hand-written
	 * `gpt-5.6-sol` hint matches no backend id literally, but both normalize to
	 * the same key. Returns:
	 *   - the hint itself when it IS a registered backend id (literal precedence);
	 *   - else the single registered backend whose logical model (its config
	 *     `logical_model`, falling back to the normalized key of its
	 *     `(provider, providerModelId)`) matches the hint's normalized key;
	 *   - else null.
	 * An operator `logical_model` pin is matched as-is (literally or through its
	 * normalized key) instead of the structural key.
	 * Not-ready backends are skipped (they are excluded from resolution until
	 * warmup completes). A tie — two local backends under one logical model —
	 * resolves to the lexically-first id for determinism; cross-route pooling and
	 * ranking across the tie happen downstream in `resolveModel`/the relay finder.
	 */
	resolveLocalBackendIdForHint(hint: string): string | null {
		// Literal id match wins outright.
		if (this.backends.has(hint) && !this.isNotReady(hint)) return hint;

		// Logical-model fallback: scan ready backends for one whose logical model
		// normalizes to the hint's key. Deterministic lexical tie-break.
		const matches: string[] = [];
		for (const id of this.backends.keys()) {
			if (this.isNotReady(id)) continue;
			const config = this.backendConfigs.get(id);
			const providerModelId = config?.model ?? id;
			const provider = config?.provider ?? "";
			const logical = config?.logicalModel ?? normalizeModelKey(provider, providerModelId).key;
			if (hintMatchesLogicalModel(hint, logical, normalizeModelKey)) matches.push(id);
		}
		if (matches.length === 0) return null;
		// Deterministic lexical tie-break, but a route in backoff ranks behind every
		// available route for the same logical model, so a failed route hands the
		// model to its next local sibling instead of masking it (§5.1/§7.1, #265).
		// With every route healthy the order is the plain lexical one.
		matches.sort((a, b) => {
			const cooledA = this.isRateLimited(a) ? 1 : 0;
			const cooledB = this.isRateLimited(b) ? 1 : 0;
			return cooledA - cooledB || (a < b ? -1 : a > b ? 1 : 0);
		});
		return matches[0];
	}

	/**
	 * Every ready local backend serving the same logical model as `hint`: the
	 * literal backend (when `hint` is a registered id) plus each sibling whose
	 * logical model matches the hint or the literal backend's logical model.
	 * Lexically ordered. Lets resolution find a healthy sibling route when the
	 * backend `resolveLocalBackendIdForHint` picked is `half_open` (R-RT12).
	 */
	listLocalBackendIdsForHint(hint: string): string[] {
		const literalLogical =
			this.backends.has(hint) && !this.isNotReady(hint) ? this.logicalModelOf(hint) : null;
		const matches: string[] = [];
		for (const id of this.backends.keys()) {
			if (this.isNotReady(id)) continue;
			const logical = this.logicalModelOf(id);
			if (
				id === hint ||
				logical === literalLogical ||
				hintMatchesLogicalModel(hint, logical, normalizeModelKey)
			) {
				matches.push(id);
			}
		}
		return matches.sort();
	}

	private logicalModelOf(id: string): string {
		const config = this.backendConfigs.get(id);
		return (
			config?.logicalModel ?? normalizeModelKey(config?.provider ?? "", config?.model ?? id).key
		);
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
	 * Read-only snapshot of this host's route health, one entry per ready backend
	 * that has a `RouteId`. This is what the host reports to a peer asking over the
	 * `route_health` relay kind and what its own Settings › Models assembly reads.
	 * `next_trial_in_ms` is relative to `now` so a peer converts it against its own
	 * clock. Reading does not claim a half-open trial.
	 */
	getRouteHealthSnapshot(): Array<{
		route_id: RouteId;
		status: "healthy" | "backoff" | "half_open";
		next_trial_in_ms: number | null;
	}> {
		const now = this.clock();
		const out: Array<{
			route_id: RouteId;
			status: "healthy" | "backoff" | "half_open";
			next_trial_in_ms: number | null;
		}> = [];
		for (const backend of this.listBackends()) {
			const routeId = this.getRouteId(backend.id);
			if (!routeId) continue;
			const state = this.routeHealth.getState(backend.id);
			out.push({
				route_id: routeId,
				status: state.status,
				next_trial_in_ms:
					state.status === "backoff" ? Math.max(0, state.next_trial_at - now) : null,
			});
		}
		return out;
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

	// The router never writes appContext.config — the CLI-layer registrar owns
	// the shared-config pricing-row writes (package boundary).

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
		config?: BackendConfig,
	): void {
		// A `default` naming this expanded id was recorded at construction; the
		// lineup has now produced it, so the placeholder can stop standing in.
		if (this.pendingDefault?.id === id) {
			this.defaultId = id;
			this.pendingDefault = null;
		}
		this.backends.set(id, backend);
		this.effectiveCaps.set(id, caps);
		if (routeIdentity) this.routeIdentities.set(id, routeIdentity);
		// A full router config for the backend (the self-configuring registrar
		// derives it through `toRouterConfig` from the expanded shared row, so
		// request controls, defaults, the provider, the raw provider model id and
		// the logical-model pin all reach the getters). It REPLACES any prior
		// config: a re-registration after a reload must reflect the new config.
		if (config) {
			this.backendConfigs.set(id, {
				...config,
				id,
				maxOutputTokens: config.maxOutputTokens ?? maxOutputTokens,
			});
			this.notReady.delete(id);
			return;
		}
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
		// The owning namespace's expansion is complete once its placeholder is
		// removed; a requested expanded default that never registered is
		// abandoned. The CLI registrar redirects the default to the lineup's
		// preferred id and reconciles the live shared config.
		if (this.pendingDefault?.namespaceId === id) this.pendingDefault = null;
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
	 * Apply resolved catalog metadata (R-MC2/R-MC4,
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

			const resolvedCaps = resolved.metadata.capabilities;
			const resolvedMaxContext = resolvedCaps.max_context;
			const caps = this.effectiveCaps.get(backendId);
			if (caps) {
				const explicitCaps = this.backendConfigs.get(backendId)?.capabilities as
					Partial<BackendCapabilities> | undefined;
				let updated = caps;
				if (typeof resolvedMaxContext === "number") {
					updated = { ...updated, max_context: resolvedMaxContext };
				}
				if (typeof resolvedCaps.vision === "boolean" && explicitCaps?.vision === undefined) {
					updated = { ...updated, vision: resolvedCaps.vision };
				}
				if (
					typeof resolvedCaps.extended_thinking === "boolean" &&
					explicitCaps?.extended_thinking === undefined
				) {
					updated = { ...updated, extended_thinking: resolvedCaps.extended_thinking };
				}
				if (updated !== caps) {
					this.effectiveCaps.set(backendId, updated);
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
		// No explicit config thinking: derive from resolved catalog
		// reasoning metadata. Explicit config above always wins.
		return this.deriveThinkingFromMetadata(backendId);
	}

	/**
	 * Derive a `thinking` request from the catalog-resolved reasoning metadata when
	 * a backend sets no explicit `thinking` config (catalog §3.1).
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
		// When the catalog explicitly marks a model as non-reasoning and the
		// operator didn't explicitly enable thinking on this backend, suppress
		// effort (e.g. inherited from top-level `defaults.effort`) so drivers
		// don't send reasoning parameters to models that reject them.
		const resolved = this.resolvedReasoning.get(backendId)?.reasoning;
		if (resolved?.supported === false && config.thinking === undefined) return undefined;
		const effort = config.effort as ChatParams["effort"] | undefined;
		if (effort === undefined) return undefined;
		// Clamp an effort the model does not list to the nearest listed value.
		// The ladder comes from resolved catalog reasoning metadata;
		// without one the value passes through and the driver's own protocol gate
		// (`BEDROCK_EFFORTS` / `ANTHROPIC_EFFORTS` / Copilot `resolveReasoningEffort`)
		// decides. Never a model-ID test.
		return clampEffortToLadder(effort, resolved?.effort_values);
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
	 * `shouldEnableSystemCache` gate disabled the
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
interface RouterState {
	backends: Map<string, LLMBackend>;
	defaultId: string;
	effectiveCaps: Map<string, BackendCapabilities>;
	backendConfigs: Map<string, BackendConfig>;
	routeIdentities: Map<string, { routeId: RouteId; reasoningOrigin: string }>;
	/** An expanded-id default awaiting its namespace's lineup (see ModelRouter). */
	pendingDefault: { id: string; namespaceId: string } | null;
}

/**
 * The id of the self-configuring namespace entry (no concrete `model`) whose
 * expansion could produce `id`, or null. Expanded backend ids are
 * `<entry-id>-<provider-model-id>`. The longest matching entry id wins so a
 * namespace whose id is a prefix of another (`ns` vs `ns-2`) claims only its
 * own models.
 */
function findNamespacePrefixOwner(config: ModelBackendsConfig, id: string): string | null {
	let owner: string | null = null;
	for (const backend of config.backends) {
		if (backend.model) continue;
		if (id.length <= backend.id.length + 1) continue;
		if (!id.startsWith(`${backend.id}-`)) continue;
		if (owner === null || backend.id.length > owner.length) owner = backend.id;
	}
	return owner;
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
	// backoff by per-RouteId route health.
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

		// A later duplicate id overwrites the earlier one (last-wins). Two
		// providers for one logical model need distinct backend ids; the catalog's
		// logical_model grouping pools them for ranking.
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
		return {
			backends,
			defaultId: "",
			effectiveCaps,
			backendConfigs,
			routeIdentities,
			pendingDefault: null,
		};
	}

	// Verify the default backend exists. A self-configuring namespace entry
	// (no `model`) expands at runtime into `<entry-id>-<provider-model-id>`
	// backends, so a default naming one of those ids is legitimate before
	// discovery lands: keep the namespace placeholder as the working default
	// (so an omitted-model turn reports it not-ready rather than "unknown
	// backend") and switch to the requested id when it registers.
	let defaultId = config.default;
	let pendingDefault: RouterState["pendingDefault"] = null;
	if (!backends.has(config.default)) {
		const namespaceId = findNamespacePrefixOwner(config, config.default);
		if (namespaceId === null) {
			throw new LLMError(`Default backend "${config.default}" not found in backends`, "router");
		}
		defaultId = namespaceId;
		pendingDefault = { id: config.default, namespaceId };
	}

	return {
		backends,
		defaultId,
		effectiveCaps,
		backendConfigs,
		routeIdentities,
		pendingDefault,
	};
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
		{
			logger: options?.logger,
			fetchByBackendId: options?.fetchByBackendId,
			siteId: options?.siteId,
		},
		state.pendingDefault,
	);
}
