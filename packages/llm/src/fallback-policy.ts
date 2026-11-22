/**
 * Refusal-fallback policy resolution (slice 5, R-RT17 / R-MC11,
 * 2026-11-21-model-routing.md §7.3 step 1, 2026-11-21-model-catalog.md §7.1).
 *
 * This module is the PURE decision layer: given a resolved fallback policy, the
 * active driver's static capability descriptor, the provider-published and
 * cluster-default candidate lists, and a capability filter, it decides what the
 * ordered fallback chain is for a `substitutable: true` refusal. It executes
 * nothing — the agent loop and the per-driver credit-redemption planner act on
 * the result. Branching is on `DriverFallbackSupport`, never provider names
 * (R-MC7).
 */

/**
 * Static, per-driver fallback protocol capabilities (catalog §4.2, R-MC7).
 * Declared once per driver; routing/refusal-fallback logic branches on these
 * flags rather than hardcoded provider-name conditionals or model tables.
 */
export type DriverFallbackSupport = {
	/**
	 * Provider accepts a server-side automatic fallback directive (e.g. the
	 * Anthropic API `fallbacks: "default"` + `server-side-fallback-2026-07-01`).
	 */
	server_side_auto: boolean;
	/** Provider publishes per-model `allowed_fallback_models` via its models API. */
	publishes_allowed_targets: boolean;
	/**
	 * Provider can mint and redeem prompt-cache fallback-credit tokens on refusal
	 * (Anthropic API, Bedrock Runtime, Bedrock Mantle).
	 */
	supports_fallback_credit: boolean;
};

/**
 * Per-model fallback policy (catalog §7.1). A missing `model_routing_rules`
 * row means `{ mode: "auto" }`; callers map the absent row before resolving.
 */
export type ModelFallbackPolicy =
	{ mode: "auto" } | { mode: "never" } | { mode: "custom"; models: string[] };

export interface ResolveFallbackChainArgs {
	/** The resolved per-model policy (absent row → `{ mode: "auto" }`). */
	policy: ModelFallbackPolicy;
	/** The active route's driver capability descriptor. */
	driver: DriverFallbackSupport;
	/** Logical model that refused — always excluded from the chain. */
	refusedModel: string;
	/**
	 * Provider-published `allowed_fallback_models` (catalog §4.1). Only consulted
	 * in `auto` mode when `driver.publishes_allowed_targets` is true.
	 */
	allowedFallbackModels: string[];
	/** Cluster `routing.default_fallback_models`, in declared order. */
	defaultFallbackModels: string[];
	/**
	 * Capability filter: returns true when the logical model can satisfy the
	 * turn's `CapabilityRequirements`. Models failing it are skipped (R-RT17).
	 */
	meetsRequirements: (logicalModel: string) => boolean;
	/**
	 * Defense-in-depth: when true, `allowedFallbackModels` is ignored unless the
	 * driver actually publishes them. Defaults to the same `publishes_allowed_targets`
	 * gate; the flag exists so a caller that pre-filtered can assert the gate.
	 */
	ignoreAllowedWhenUnpublished?: boolean;
}

/**
 * The resolved fallback chain for a refusal.
 *
 * - `serverSideAuto: true` → delegate to the provider's server-side default
 *   fallback; `targets` is empty (the provider picks).
 * - `serverSideAuto: false` → walk `targets` in order (already de-duplicated,
 *   refused-model-excluded, and capability-filtered). An empty `targets` with
 *   `serverSideAuto: false` means surface the refusal (no substitution).
 */
export interface ResolvedFallbackChain {
	serverSideAuto: boolean;
	targets: string[];
}

/**
 * Resolve the ordered fallback chain for a substitutable refusal.
 *
 * Callers must only invoke this for `substitutable: true` refusals on unpinned
 * requests; a `substitutable: false` refusal (e.g. `reasoning_extraction`) and
 * a hard pin halt fallback upstream and never reach here (R-RT17/R-RT18).
 */
export function resolveFallbackChain(args: ResolveFallbackChainArgs): ResolvedFallbackChain {
	const {
		policy,
		driver,
		refusedModel,
		allowedFallbackModels,
		defaultFallbackModels,
		meetsRequirements,
	} = args;

	if (policy.mode === "never") {
		return { serverSideAuto: false, targets: [] };
	}

	if (policy.mode === "custom") {
		return {
			serverSideAuto: false,
			targets: filterChain(policy.models, refusedModel, meetsRequirements),
		};
	}

	// policy.mode === "auto"
	if (driver.server_side_auto) {
		// The provider picks the fallback server-side; Bound walks no local list.
		return { serverSideAuto: true, targets: [] };
	}

	// Non-server-side driver: walk provider-published allowed targets (only when
	// the driver actually publishes them) then the cluster default list.
	const allowed = driver.publishes_allowed_targets ? allowedFallbackModels : [];
	return {
		serverSideAuto: false,
		targets: filterChain([...allowed, ...defaultFallbackModels], refusedModel, meetsRequirements),
	};
}

/** De-duplicate, drop the refused model, and drop capability failures — order-preserving. */
function filterChain(
	candidates: string[],
	refusedModel: string,
	meetsRequirements: (logicalModel: string) => boolean,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of candidates) {
		if (m === refusedModel || seen.has(m)) continue;
		if (!meetsRequirements(m)) continue;
		seen.add(m);
		out.push(m);
	}
	return out;
}
