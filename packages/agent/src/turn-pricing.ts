import type { FieldSource, PricingTier, ResolvedPricing } from "@bound/llm";
import { createLogger } from "@bound/shared";
import { calculateDynamicPrice, hasDynamicPrice } from "./dynamic-pricing";

const logger = createLogger("@bound/agent", "turn-pricing");
const warnedDynamicPricingFallbacks = new Set<string>();

interface UsageTokens {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	/**
	 * The 1h-TTL subset of `cacheWriteTokens`. `null`/absent means the split is
	 * unknown, in which case every cache-write token is billed at the 5m rate
	 * (today's behavior). Never a guess — a driver that can't see the split
	 * reports null.
	 */
	cacheWrite1hTokens?: number | null;
	/**
	 * Per-lifetime cache-write split keyed by the provider's own TTL vocabulary.
	 * Absent/empty when no provider reported one. Used by R-MC15 per-lifetime
	 * pricing; the total stays on `cacheWriteTokens`.
	 */
	cacheWriteSplit?: Array<{ ttl: string; tokens: number }>;
	/**
	 * The TTL the route's wire protocol treats as its DEFAULT cache lifetime,
	 * stamped by the driver from the protocol it speaks (5m for Anthropic
	 * Messages/Converse, 30m for OpenAI Responses). A split entry at this lifetime
	 * is priced by the `cacheWrite` (default-lifetime) rate as a lifetime-MATCHED
	 * price, not a fallback. Absent means "treat any non-1h lifetime as the
	 * default" — the conservative legacy behavior for drivers that don't stamp it.
	 * Never a guess — it names the protocol, not a measured value.
	 */
	cacheWriteDefaultLifetime?: string;
}

interface BackendPricing {
	id: string;
	// Per-M overrides. PRESENCE (not `> 0`) is the "operator set this" signal:
	// the schema keeps these optional so a deliberate 0 (free local model) is
	// distinguishable from an unset gap. An absent field falls through to
	// catalog (provider/models.dev) pricing (2026-11-21-model-catalog.md §3).
	price_per_m_input?: number;
	price_per_m_output?: number;
	price_per_m_cache_read?: number;
	price_per_m_cache_write?: number;
	/** Per-M price for the 1h cache-write subset; falls back to price_per_m_cache_write. */
	price_per_m_cache_write_1h?: number;
}

/** The four per-component cost parts of a turn, in USD. 1h cache-write folds
 * into `cacheWrite`. */
export interface TurnCostBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Which layer priced a turn (requirement 4, carried in `cost_breakdown`).
 *   - `config_callback`: a `price(turn)` callback (plain number, no split)
 *   - `config`: an explicitly-set `price_per_m_*` override
 *   - `provider`: provider-published catalog pricing
 *   - `models_dev`: `models.dev` registry pricing
 *   - `provider_reported`: a realized cost stamped on the done chunk
 *   - `unknown`: no layer supplied any price
 */
export type PricingSource =
	| "config_callback"
	| "config"
	| "provider"
	| "models_dev"
	| "provider_reported"
	| "estimate"
	| "unknown";

/** Resolved per-component per-M prices plus which layer supplied them. */
interface EffectivePricesPerM {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
	/**
	 * Per-lifetime cache-write prices beyond the default and 1h rates, keyed by
	 * the provider's TTL vocabulary. Present only when config overrides supply a
	 * named lifetime the base/1h fields don't cover; empty/absent otherwise.
	 */
	lifetimePricesPerM?: Record<string, number>;
	/**
	 * The TTL lifetime the `cacheWrite` rate prices (the protocol default: `5m`
	 * for Anthropic Messages/Converse, `30m` for Responses). A split entry at this
	 * lifetime is lifetime-matched (not an estimate). Absent means "treat any
	 * non-1h lifetime as the default" — the conservative legacy behavior.
	 */
	defaultLifetime?: string;
	/** `config` when any component came from an explicit config override, else the catalog source. */
	source: "config" | "provider" | "models_dev";
}

/** The request size that selects a context tier: input + cache-read + cache-write tokens. */
function tierRequestSize(usage: UsageTokens): number {
	return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

/**
 * Pick the context-tier prices that apply to a request (requirement 2). Tiers are
 * ascending by `threshold`; a tier applies when the request size STRICTLY EXCEEDS
 * its threshold. The highest such tier wins. Below/at the lowest threshold the
 * base prices apply (returns `undefined`). Confirmed against the models.dev
 * payload: `tier.size` is the context boundary, and Bedrock bills the long-context
 * tier above it (e.g. 272000 for GPT-5.6 / 6.x).
 */
function selectContextTier(
	tiers: PricingTier[] | undefined,
	requestSize: number,
): PricingTier | undefined {
	if (!tiers || tiers.length === 0) return undefined;
	let chosen: PricingTier | undefined;
	for (const tier of tiers) {
		if (requestSize > tier.threshold) chosen = tier;
	}
	return chosen;
}

/**
 * Resolve the effective per-M prices for a turn by merging operator config over
 * catalog pricing PER FIELD (2026-11-21-model-catalog.md §3 precedence):
 * explicit config override > catalog (provider/models.dev). A field set in config
 * (present, including a deliberate 0) overrides the catalog; an unset config field
 * falls through to the catalog's tier-selected value. Returns `null` when no layer
 * supplies any price (cost is then unknown, not $0 — requirement 3).
 */
function resolveEffectivePrices(
	cfg: BackendPricing | undefined,
	catalog: ResolvedPricing | undefined,
	catalogSource: FieldSource | undefined,
	usage: UsageTokens,
): EffectivePricesPerM | null {
	// Catalog layer, tier-selected by request size.
	const tier = selectContextTier(catalog?.tiers, tierRequestSize(usage));
	const catInput = tier?.input_per_m ?? catalog?.input_per_m;
	const catOutput = tier?.output_per_m ?? catalog?.output_per_m;
	const catCacheRead = tier?.cache_read_per_m ?? catalog?.cache_read_per_m;
	const catCacheWrite5m = tier?.cache_write_5m_per_m ?? catalog?.cache_write_5m_per_m;
	const catCacheWrite1h =
		tier?.cache_write_1h_per_m ?? catalog?.cache_write_1h_per_m ?? catCacheWrite5m;

	// Config layer: PRESENCE is the override signal (a 0 overrides the catalog).
	const cfgInput = cfg?.price_per_m_input;
	const cfgOutput = cfg?.price_per_m_output;
	const cfgCacheRead = cfg?.price_per_m_cache_read;
	const cfgCacheWrite = cfg?.price_per_m_cache_write;
	const cfgCacheWrite1h = cfg?.price_per_m_cache_write_1h;

	const anyConfig =
		cfgInput !== undefined ||
		cfgOutput !== undefined ||
		cfgCacheRead !== undefined ||
		cfgCacheWrite !== undefined ||
		cfgCacheWrite1h !== undefined;
	const anyCatalog =
		catInput !== undefined ||
		catOutput !== undefined ||
		catCacheRead !== undefined ||
		catCacheWrite5m !== undefined ||
		catCacheWrite1h !== undefined;
	if (!anyConfig && !anyCatalog) return null;

	const input = cfgInput ?? catInput ?? 0;
	const output = cfgOutput ?? catOutput ?? 0;
	const cacheRead = cfgCacheRead ?? catCacheRead ?? 0;
	const cacheWrite = cfgCacheWrite ?? catCacheWrite5m ?? 0;
	const cacheWrite1h = cfgCacheWrite1h ?? cfgCacheWrite ?? catCacheWrite1h ?? cacheWrite;

	// Source is `config` when any component was an operator override; otherwise it
	// is the catalog's reported source (provider or models.dev).
	const source: EffectivePricesPerM["source"] = anyConfig
		? "config"
		: catalogSource === "provider"
			? "provider"
			: "models_dev";
	// The `cacheWrite` rate prices the protocol's default cache lifetime. The
	// catalog field that feeds it (`cache_write_5m_per_m`) is the Anthropic
	// Messages / Converse default (5m); a Responses route's default (30m) is
	// carried in the same structural field by the catalog resolver, so "5m" here
	// names the default-lifetime SLOT, not a literal 5-minute guarantee on every
	// protocol. A split entry at this lifetime is lifetime-matched, not estimated.
	// map stays empty today (both protocols' default lifetime is priced by
	// `cacheWrite`). It is the extension point for a future named-lifetime config
	// override without changing the split-pricing call sites.
	return { input, output, cacheRead, cacheWrite, cacheWrite1h, lifetimePricesPerM: {}, source };
}

/**
 * Per-lifetime cache-write pricing (R-MC15). Prices the reported write split
 * from a map of ttl -> per-M price, and reports whether the turn is an
 * `estimate`: true when any write tokens were priced at a fallback rate rather
 * than a lifetime-matched one — unsplit tokens, or split tokens whose lifetime
 * carries no published price. The caller records `estimate` as the pricing
 * source in that case.
 *
 * The per-lifetime map is built from the resolved prices: the catalog/config
 * `cache_write_5m_per_m` is the DEFAULT-lifetime rate (the protocol's default:
 * 5m for Anthropic Messages/Converse, 30m for Responses — the registry's
 * `cache_write` describes whichever one the route's protocol uses), and
 * `cache_write_1h_per_m` prices the 1h lifetime. A lifetime with no explicit
 * price falls back to the default-lifetime rate and flags the estimate.
 */
function priceCacheWrites(
	usage: UsageTokens,
	prices: EffectivePricesPerM,
): { cost: number; estimated: boolean } {
	const totalCacheWrite = usage.cacheWriteTokens ?? 0;
	if (totalCacheWrite <= 0) return { cost: 0, estimated: false };

	// Per-lifetime prices known to this route. `cacheWrite` is the default
	// lifetime's rate; `cacheWrite1h` the 1h rate. Both always resolved (default
	// to the 5m/base rate upstream), so the only "unpriced lifetime" is one that
	// is neither the default nor 1h.
	const split = usage.cacheWriteSplit;
	if (split && split.length > 0) {
		let cost = 0;
		let estimated = false;
		let accountedFor = 0;
		// The route's protocol default lifetime, stamped by the driver onto the
		// done-chunk usage (5m for Anthropic Messages/Converse, 30m for OpenAI
		// Responses). A split entry at this lifetime is priced by `cacheWrite` as a
		// lifetime-MATCHED rate, not a fallback. The usage signal wins over the
		// price-layer default; absent on both, fall back to 5m (legacy behavior).
		const defaultLifetime = usage.cacheWriteDefaultLifetime ?? prices.defaultLifetime ?? "5m";
		for (const entry of split) {
			accountedFor += entry.tokens;
			if (entry.ttl === "1h") {
				cost += (entry.tokens * prices.cacheWrite1h) / 1_000_000;
			} else if (entry.ttl === defaultLifetime) {
				// The protocol's default lifetime is priced by `cacheWrite` — a matched
				// price, not a fallback, so it does not flag the estimate.
				cost += (entry.tokens * prices.cacheWrite) / 1_000_000;
			} else if (prices.lifetimePricesPerM?.[entry.ttl] !== undefined) {
				cost += (entry.tokens * (prices.lifetimePricesPerM[entry.ttl] as number)) / 1_000_000;
			} else {
				// Lifetime with no matched price — bill at the default rate, estimate.
				cost += (entry.tokens * prices.cacheWrite) / 1_000_000;
				estimated = true;
			}
		}
		// Any write tokens not covered by the split bill at the default rate (estimate).
		const remainder = totalCacheWrite - accountedFor;
		if (remainder > 0) {
			cost += (remainder * prices.cacheWrite) / 1_000_000;
			estimated = true;
		}
		return { cost, estimated };
	}

	// No reported split. When the driver stamped the route's protocol default
	// lifetime, the whole cache-write total is attributed to that one lifetime,
	// which the `cacheWrite` rate prices as a lifetime-MATCHED figure (R-MC15 step
	// 2) — not an estimate. This is what keeps a correctly-reported Responses write
	// (whose endpoint reports a total but no per-lifetime breakdown) off the
	// `estimate` path. The 1h subset, when the driver separately reported it, still
	// prices at the 1h rate. Without a stamped default the whole total bills at the
	// default rate as an estimate of the real per-lifetime cost (legacy behavior).
	const oneHTokens = Math.min(usage.cacheWrite1hTokens ?? 0, totalCacheWrite);
	const defaultTokens = totalCacheWrite - oneHTokens;
	const cost = (defaultTokens * prices.cacheWrite + oneHTokens * prices.cacheWrite1h) / 1_000_000;
	// A stamped default lifetime is a protocol-matched price for the default-rate
	// tokens; only the absence of a stamped lifetime leaves the attribution a guess.
	const estimated = usage.cacheWriteDefaultLifetime === undefined;
	return { cost, estimated };
}

/** Compute the four-component split from already-resolved per-M prices. */
function breakdownFromPrices(usage: UsageTokens, prices: EffectivePricesPerM): TurnCostBreakdown {
	return {
		input: (usage.inputTokens * prices.input) / 1_000_000,
		output: (usage.outputTokens * prices.output) / 1_000_000,
		cacheRead: ((usage.cacheReadTokens ?? 0) * prices.cacheRead) / 1_000_000,
		cacheWrite: priceCacheWrites(usage, prices).cost,
	};
}

/**
 * Compute the four per-component cost parts for a turn's token usage against
 * static backend pricing. Returns `null` when the model is absent from the
 * backends list, when it carries no static price at all, OR when a dynamic
 * `price(turn)` callback resolved the cost as a single number (no component
 * split available). A callback that returns a component object is handled by
 * the caller, not here. When non-null, the four parts sum to
 * `calculateTurnCost` for the same inputs.
 */
export function calculateTurnCostBreakdown(
	modelId: string,
	usage: UsageTokens,
	backends: BackendPricing[],
): TurnCostBreakdown | null {
	const cfg = backends.find((b) => b.id === modelId);
	if (!cfg) return null;

	const pricesPerM = {
		input: cfg.price_per_m_input ?? 0,
		output: cfg.price_per_m_output ?? 0,
		cacheRead: cfg.price_per_m_cache_read ?? 0,
		cacheWrite: cfg.price_per_m_cache_write ?? 0,
		cacheWrite1h: cfg.price_per_m_cache_write_1h ?? cfg.price_per_m_cache_write ?? 0,
	};
	const hasStatic =
		cfg.price_per_m_input !== undefined ||
		cfg.price_per_m_output !== undefined ||
		cfg.price_per_m_cache_read !== undefined ||
		cfg.price_per_m_cache_write !== undefined ||
		cfg.price_per_m_cache_write_1h !== undefined;
	if (!hasStatic) return null;

	// A winning price(turn) callback resolves the cost as a single number with no
	// component split, so the static split below would NOT sum to that cost. When
	// a callback is active and produces a value, there is no breakdown. (A model
	// may carry both a static price and a callback; the callback wins the cost,
	// so it must also win — to null — the breakdown.)
	if (hasDynamicPrice(modelId)) {
		const cacheWrite1h = usage.cacheWrite1hTokens ?? 0;
		const dynamic = calculateDynamicPrice(modelId, {
			modelId,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadTokens: usage.cacheReadTokens ?? 0,
			cacheWriteTokens: usage.cacheWriteTokens ?? 0,
			cacheWrite1hTokens: cacheWrite1h,
			pricesPerM,
		});
		// Callback produced a usable number → no component split.
		if (dynamic?.value !== null && dynamic !== null) return null;
		// Callback errored / unavailable → fall through to the static split, which
		// is exactly what calculateTurnCost falls back to for the cost number.
	}

	return breakdownFromPrices(usage, {
		...pricesPerM,
		source: "config",
	});
}

/** Compute cost in USD for a turn's token usage against backend pricing. */
export function calculateTurnCost(
	modelId: string,
	usage: UsageTokens,
	backends: BackendPricing[],
): number {
	const cfg = backends.find((b) => b.id === modelId);
	if (!cfg) return 0;

	const pricesPerM = {
		input: cfg.price_per_m_input ?? 0,
		output: cfg.price_per_m_output ?? 0,
		cacheRead: cfg.price_per_m_cache_read ?? 0,
		cacheWrite: cfg.price_per_m_cache_write ?? 0,
		cacheWrite1h: cfg.price_per_m_cache_write_1h ?? cfg.price_per_m_cache_write ?? 0,
	};
	// 1h subset is only known when explicitly reported; null/absent → 0, which
	// makes the whole cache-write total bill at the 5m rate (today's behavior).
	const cacheWrite1hTokens = usage.cacheWrite1hTokens ?? 0;
	const dynamic = calculateDynamicPrice(modelId, {
		modelId,
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0,
		cacheWrite1hTokens,
		pricesPerM,
	});
	if (dynamic?.value !== null && dynamic !== null) return dynamic.value;
	if (dynamic?.error && !warnedDynamicPricingFallbacks.has(modelId)) {
		warnedDynamicPricingFallbacks.add(modelId);
		logger.warn("Dynamic price callback failed; falling back to static pricing", {
			modelId,
			error: dynamic.error,
		});
	}

	// Static path: reuse the component computer so the number and the breakdown
	// can never drift. A model with no static price yields a null breakdown → 0.
	const breakdown = calculateTurnCostBreakdown(modelId, usage, backends);
	if (!breakdown) return 0;
	return breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
}

export interface ResolveTurnCostInput {
	modelId: string;
	usage: UsageTokens;
	backends: BackendPricing[];
	/** Provider-reported USD cost from the done chunk (e.g. Copilot catalog pricing). */
	providerCostUsd: number | null | undefined;
	/**
	 * Provider-reported component breakdown from the done chunk (Copilot catalog
	 * pricing stamps this alongside `providerCostUsd`; a hub relays it verbatim).
	 * Carried through only when the provider cost actually wins the precedence.
	 */
	providerBreakdown?: TurnCostBreakdown | null;
	/**
	 * The serving host's catalog-resolved pricing for this model (provider API or
	 * `models.dev`, tier-aware). Consulted when the backend carries no explicit
	 * config override and the provider stamped no realized cost. Absent/undefined
	 * means the catalog knows no price for this model.
	 */
	catalogPricing?: ResolvedPricing;
	/**
	 * Which catalog layer supplied `catalogPricing` (`provider` or `models_dev`),
	 * recorded as the turn's pricing source when catalog pricing wins.
	 */
	catalogPricingSource?: FieldSource;
}

/**
 * The resolved cost plus its component split and the layer that priced it.
 * `cost` is `null` when no layer supplied any price (requirement 3: unknown, not
 * $0) and `source` is then `"unknown"`. `breakdown` is null when no component
 * split is available (plain-number callback, provider cost with no breakdown, or
 * unknown).
 */
export interface ResolvedTurnCost {
	cost: number | null;
	breakdown: TurnCostBreakdown | null;
	source: PricingSource;
}

/**
 * Resolve a turn's USD cost under one precedence rule, shared by the local agent
 * loop and the relay-processor so neither blindly overwrites the other
 * (2026-11-21-model-catalog.md §3, requirements 1–4):
 *
 *   price(turn) callback  >  explicit config price_per_m_*  >  provider-reported
 *   realized cost  >  catalog pricing (provider / models.dev, tier-aware)  >  unknown
 *
 * An explicit config price (present, including a deliberate 0) is an operator
 * override and wins over catalog pricing. A field the operator did NOT set falls
 * through to the catalog's tier-selected value. When nothing supplies a price the
 * cost is recorded as unknown (`null`), never a misleading $0.
 *
 * `source` records which layer priced the turn (`cost_breakdown` provenance). The
 * returned `breakdown` is the four-component split when one is available:
 *   - config / catalog per-M pricing → `breakdownFromPrices` (sums to cost);
 *   - a price(turn) callback that resolved as a plain number → null (no split);
 *   - provider-reported cost → the passed `providerBreakdown` (or null);
 *   - unknown → null.
 */
export function resolveTurnCost(input: ResolveTurnCostInput): ResolvedTurnCost {
	const cfg = input.backends.find((b) => b.id === input.modelId);

	// 1. A price(turn) callback wins outright — it is the operator's authoritative
	//    pricing and yields a single number with no component split.
	if (hasDynamicPrice(input.modelId)) {
		const cost = calculateTurnCost(input.modelId, input.usage, input.backends);
		// If the callback actually produced a value, there is no breakdown. A
		// callback that errored falls back to the static split inside calculateTurnCost,
		// in which case calculateTurnCostBreakdown returns the matching split.
		const breakdown = calculateTurnCostBreakdown(input.modelId, input.usage, input.backends);
		return { cost, breakdown, source: breakdown ? "config" : "config_callback" };
	}

	// 2. Explicit config price_per_m_* overrides the catalog (presence is the
	//    signal; a deliberate 0 counts). 3. Else catalog pricing, tier-aware.
	const hasConfigOverride =
		cfg !== undefined &&
		(cfg.price_per_m_input !== undefined ||
			cfg.price_per_m_output !== undefined ||
			cfg.price_per_m_cache_read !== undefined ||
			cfg.price_per_m_cache_write !== undefined ||
			cfg.price_per_m_cache_write_1h !== undefined);

	if (hasConfigOverride) {
		const prices = resolveEffectivePrices(
			cfg,
			input.catalogPricing,
			input.catalogPricingSource,
			input.usage,
		);
		// A config override guarantees a non-null result.
		if (prices) {
			const breakdown = breakdownFromPrices(input.usage, prices);
			const cost = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
			return { cost, breakdown, source: "config" };
		}
	}

	// 3. A provider-reported realized cost from the done chunk outranks a catalog
	//    estimate — it is what was actually billed on the serving host.
	if (input.providerCostUsd !== null && input.providerCostUsd !== undefined) {
		return {
			cost: input.providerCostUsd,
			breakdown: input.providerBreakdown ?? null,
			source: "provider_reported",
		};
	}

	// 4. Catalog pricing (provider / models.dev, tier-selected).
	const prices = resolveEffectivePrices(
		cfg,
		input.catalogPricing,
		input.catalogPricingSource,
		input.usage,
	);
	if (prices) {
		const breakdown = breakdownFromPrices(input.usage, prices);
		const cost = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
		// R-MC15: when any cache-write tokens priced at a fallback rate (unsplit, or a
		// split lifetime with no published price), the turn's cost is an `estimate` of
		// the real per-lifetime charge rather than a lifetime-matched figure. Only the
		// catalog path can estimate; a config override is authoritative, and a
		// provider-reported charge already returned above.
		const { estimated } = priceCacheWrites(input.usage, prices);
		const source = estimated ? "estimate" : prices.source;
		return { cost, breakdown, source };
	}

	// 5. No layer supplied any price: cost is unknown (requirement 3), not $0.
	return { cost: null, breakdown: null, source: "unknown" };
}

/**
 * Fold a turn's pricing `source` into its recorded `cost_breakdown` for
 * persistence (requirement 3, catalog §3). The four numeric components are left
 * untouched (the metrics route's `json_extract('$.input')` … paths are
 * unchanged) and `source` rides as an extra key older readers ignore.
 *
 * When there is a numeric split, `source` is attached to it. When there is NO
 * split but the source is known — a plain-number `price(turn)` callback, or a
 * provider-reported cost with no breakdown — a SOURCE-ONLY object `{ source }`
 * is returned instead of null, so provenance survives. The metrics route reads a
 * source-only object as legacy (no `$.input` component) and keeps splitting its
 * `cost_usd` by token counts, so the aggregation stays correct. An `unknown`
 * source with no split stays null (there is nothing to persist).
 */
export function attachPricingSource(
	breakdown: TurnCostBreakdown | null,
	source: PricingSource,
): (TurnCostBreakdown & { source: PricingSource }) | { source: PricingSource } | null {
	if (breakdown) return { ...breakdown, source };
	if (source === "unknown") return null;
	return { source };
}

/**
 * Compute the worst-case turn cost ceiling for a backend in USD: full
 * context-window of input + max-output. Useful for budget forecasting
 * (e.g. by the agent-harness diagnostic) without running a turn.
 *
 * Defaults match `BackendConfig` schema defaults: 200k context window,
 * 8k max-output, zero pricing if unset. The result is a strict upper
 * bound — actual turn cost is almost always lower.
 */
export function estimateMaxTurnCost(backend: {
	context_window?: number;
	max_output_tokens?: number;
	price_per_m_input?: number;
	price_per_m_output?: number;
}): number {
	const ctxWindow = backend.context_window ?? 200_000;
	const maxOutput = backend.max_output_tokens ?? 8_000;
	const inputPrice = backend.price_per_m_input ?? 0;
	const outputPrice = backend.price_per_m_output ?? 0;
	return (ctxWindow * inputPrice + maxOutput * outputPrice) / 1_000_000;
}
