/**
 * GitHub Copilot model catalog + per-model endpoint routing.
 *
 * The Copilot API fronts several model families, each reachable over a
 * different wire surface. `GET {api}/models` returns a catalog whose entries
 * carry a `supported_endpoints` list; the driver routes each model to the AI
 * SDK provider that matches:
 *   - "/v1/messages" → Anthropic Messages (@ai-sdk/anthropic), baseURL {api}/v1
 *   - "/responses"   → OpenAI Responses  (@ai-sdk/openai .responses), baseURL {api}
 *   - otherwise      → Chat Completions  (openai-compatible / .chat), baseURL {api}
 *
 * When a model is absent from the catalog (or the catalog fetch failed), a
 * name-based fallback heuristic picks the route. The catalog is cached per
 * driver with a TTL so routing doesn't re-fetch on every turn.
 *
 * Pure over an injected `fetch` + `now()` so routing and caching are
 * unit-testable with no network.
 */

export type CopilotRoute = "messages" | "responses" | "chat";

/** Per-row price fields (default or long_context). All USD-per-token after the
 * batch_size/100 conversion is applied by computeCopilotCost. */
export interface CopilotPriceRow {
	inputPrice: number;
	outputPrice: number;
	cacheReadPrice: number;
	cacheWritePrice: number;
	/** Price for the 1h cache-write subset; falls back to cacheWritePrice when absent. */
	cacheWrite1hPrice?: number;
	/** Tokens threshold above which long_context pricing applies (default row only). */
	maxPromptTokens?: number;
}

/** Parsed `billing.token_prices` + discounts for one catalog entry. */
export interface CopilotPricing {
	batchSize: number;
	default: CopilotPriceRow;
	longContext?: CopilotPriceRow;
	/** Fractional discount (e.g. 0.1 = 10% off) applied only on `model: "auto"` turns. */
	autoDiscount?: number;
	promo?: { discountPercent: number; endsAt: string };
}

/** The subset of a catalog entry we read. */
export interface CopilotModelEntry {
	id: string;
	supportedEndpoints?: string[];
	maxPromptTokens?: number;
	maxOutputTokens?: number;
	maxContextWindowTokens?: number;
	supportsToolCalls?: boolean;
	supportsVision?: boolean;
	/** Reasoning-effort levels the model advertises (e.g. ["low","medium","high","max"]). */
	reasoningEfforts?: string[];
	/** True when every token price is 0 (Free-callable). */
	zeroPriced?: boolean;
	/** Parsed structured pricing from billing.token_prices; absent when billing has none. */
	pricing?: CopilotPricing;
	policyState?: string;
}

/** Raw per-row price shape under billing.token_prices.{default,long_context}. */
interface RawPriceRow {
	input_price?: number;
	output_price?: number;
	cache_read_price?: number;
	cache_write_price?: number;
	cache_write_1h_price?: number;
	max_prompt_tokens?: number;
}

/** Raw JSON shape of one `{api}/models` entry. */
interface RawModelEntry {
	id?: string;
	supported_endpoints?: string[];
	capabilities?: {
		type?: string;
		limits?: {
			max_prompt_tokens?: number;
			max_output_tokens?: number;
			max_context_window_tokens?: number;
		};
		supports?: { tool_calls?: boolean; vision?: boolean; reasoning_effort?: string[] };
	};
	policy?: { state?: string };
	model_picker_enabled?: boolean;
	billing?: {
		// Legacy flat map (batch_size + numeric prices keyed by name) OR the
		// structured {batch_size, default, long_context} shape. Both appear in
		// the wild; parseEntry handles each.
		token_prices?: Record<string, unknown> & {
			batch_size?: number;
			default?: RawPriceRow;
			long_context?: RawPriceRow;
		};
		auto_discount?: number;
		promo?: { discount_percent?: number; ends_at?: string };
	};
}

interface RawModelsResponse {
	data?: RawModelEntry[];
}

/** Default catalog cache lifetime (1 hour). */
export const CATALOG_TTL_MS = 60 * 60_000;

function parsePriceRow(raw: RawPriceRow | undefined): CopilotPriceRow | null {
	if (!raw) return null;
	return {
		inputPrice: raw.input_price ?? 0,
		outputPrice: raw.output_price ?? 0,
		cacheReadPrice: raw.cache_read_price ?? 0,
		cacheWritePrice: raw.cache_write_price ?? 0,
		...(raw.cache_write_1h_price !== undefined && {
			cacheWrite1hPrice: raw.cache_write_1h_price,
		}),
		...(raw.max_prompt_tokens !== undefined && { maxPromptTokens: raw.max_prompt_tokens }),
	};
}

/**
 * Parse the structured `billing.token_prices` shape + discounts into
 * `CopilotPricing`. Returns null when billing carries no structured `default`
 * row (legacy flat-map billing, or no billing at all).
 */
function parsePricing(billing: RawModelEntry["billing"]): CopilotPricing | null {
	const tp = billing?.token_prices;
	const defaultRow = parsePriceRow(tp?.default);
	if (!tp || !defaultRow) return null;
	const longContext = parsePriceRow(tp.long_context);
	const pricing: CopilotPricing = {
		batchSize: tp.batch_size ?? 1_000_000,
		default: defaultRow,
		...(longContext && { longContext }),
	};
	if (typeof billing?.auto_discount === "number") {
		pricing.autoDiscount = billing.auto_discount;
	}
	if (
		typeof billing?.promo?.discount_percent === "number" &&
		typeof billing.promo.ends_at === "string"
	) {
		pricing.promo = {
			discountPercent: billing.promo.discount_percent,
			endsAt: billing.promo.ends_at,
		};
	}
	return pricing;
}

function parseEntry(raw: RawModelEntry): CopilotModelEntry | null {
	if (!raw.id) return null;
	const prices = raw.billing?.token_prices;
	const pricing = parsePricing(raw.billing);
	// Free-callable detection. For the structured shape, every default-row price
	// must be 0; for the legacy flat map, every numeric price must be 0
	// (batch_size is metadata, not a price). Absent billing → not known-zero.
	let zeroPriced: boolean | undefined;
	if (pricing) {
		const d = pricing.default;
		zeroPriced =
			d.inputPrice === 0 &&
			d.outputPrice === 0 &&
			d.cacheReadPrice === 0 &&
			d.cacheWritePrice === 0;
	} else if (prices) {
		zeroPriced = Object.entries(prices).every(
			([key, value]) =>
				key === "batch_size" || key === "default" || key === "long_context" || value === 0,
		);
	}
	return {
		id: raw.id,
		supportedEndpoints: raw.supported_endpoints,
		maxPromptTokens: raw.capabilities?.limits?.max_prompt_tokens,
		maxOutputTokens: raw.capabilities?.limits?.max_output_tokens,
		maxContextWindowTokens: raw.capabilities?.limits?.max_context_window_tokens,
		supportsToolCalls: raw.capabilities?.supports?.tool_calls,
		supportsVision: raw.capabilities?.supports?.vision,
		reasoningEfforts: raw.capabilities?.supports?.reasoning_effort,
		...(zeroPriced !== undefined && { zeroPriced }),
		...(pricing && { pricing }),
		policyState: raw.policy?.state,
	};
}

/** Token usage for one turn, fed to computeCopilotCost. */
export interface CopilotCostUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** 1h-TTL subset of cacheWriteTokens; 0/absent when unknown (all billed at 5m). */
	cacheWrite1hTokens?: number;
}

export interface ComputeCopilotCostInput {
	pricing: CopilotPricing;
	usage: CopilotCostUsage;
	/** Wall-clock for promo expiry; injected so the computation stays pure. */
	nowMs: number;
	/** True only when the turn was routed through `model: "auto"`. */
	routedThroughAuto?: boolean;
}

/**
 * Compute a turn's USD cost from a Copilot catalog pricing block and token
 * usage. Unit: USD = tokens * price / batchSize / 100 (verified against
 * Anthropic list prices — see catalog.test.ts). The long_context row applies
 * when (input + cache_read + cache_write) exceeds default.maxPromptTokens and a
 * long_context row exists. The auto discount applies only on `auto`-routed
 * turns; the promo discount only while now < promo.endsAt. Discounts stack
 * multiplicatively.
 */
export function computeCopilotCost(input: ComputeCopilotCostInput): number {
	const parts = computeCopilotCostBreakdown(input);
	return parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
}

/** USD per component for one turn; the four parts sum to the turn's cost. */
export interface CopilotCostBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * The same computation as {@link computeCopilotCost}, split by component. Both
 * discounts scale every part by the same factor, so the parts still sum to the
 * discounted total; 1h and 5m cache writes fold into `cacheWrite`.
 */
export function computeCopilotCostBreakdown(input: ComputeCopilotCostInput): CopilotCostBreakdown {
	const { pricing, usage, nowMs, routedThroughAuto } = input;
	const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	const maxPrompt = pricing.default.maxPromptTokens;
	const useLong =
		pricing.longContext !== undefined && maxPrompt !== undefined && promptTokens > maxPrompt;
	const row = useLong && pricing.longContext ? pricing.longContext : pricing.default;

	const cacheWrite1h = Math.min(usage.cacheWrite1hTokens ?? 0, usage.cacheWriteTokens);
	const cacheWrite5m = usage.cacheWriteTokens - cacheWrite1h;
	const cacheWrite1hPrice = row.cacheWrite1hPrice ?? row.cacheWritePrice;

	let factor = 1 / pricing.batchSize / 100;
	if (routedThroughAuto && typeof pricing.autoDiscount === "number") {
		factor *= 1 - pricing.autoDiscount;
	}
	if (pricing.promo && nowMs < Date.parse(pricing.promo.endsAt)) {
		factor *= 1 - pricing.promo.discountPercent / 100;
	}

	return {
		input: usage.inputTokens * row.inputPrice * factor,
		output: usage.outputTokens * row.outputPrice * factor,
		cacheRead: usage.cacheReadTokens * row.cacheReadPrice * factor,
		cacheWrite: (cacheWrite5m * row.cacheWritePrice + cacheWrite1h * cacheWrite1hPrice) * factor,
	};
}

/**
 * Route a model from its catalog entry's `supported_endpoints`, in priority
 * order. A model whose entry lacks `supported_endpoints` (legacy models) falls
 * through to the name heuristic.
 */
export function routeFromEndpoints(endpoints: string[] | undefined): CopilotRoute | null {
	if (!endpoints || endpoints.length === 0) return null;
	if (endpoints.includes("/v1/messages")) return "messages";
	if (endpoints.includes("/responses")) return "responses";
	if (endpoints.includes("/chat/completions")) return "chat";
	return null;
}

/**
 * Name-based fallback route for a model not in the catalog (or when the catalog
 * fetch failed). Verified heuristic:
 *   - claude-* → messages
 *   - gpt-N with N >= 5, EXCEPT gpt-5-mini; grok-*; mai-code-* → responses
 *   - everything else → chat
 */
export function routeFromModelName(modelId: string): CopilotRoute {
	const id = modelId.toLowerCase();
	if (id.startsWith("claude-") || id.startsWith("claude.")) return "messages";
	if (id.startsWith("grok-") || id.startsWith("mai-code-")) return "responses";
	// gpt-<major>… with major >= 5, but gpt-5-mini stays on chat.
	if (id === "gpt-5-mini" || id.startsWith("gpt-5-mini")) return "chat";
	const gptMatch = id.match(/^gpt-(\d+)/);
	if (gptMatch) {
		const major = Number.parseInt(gptMatch[1], 10);
		if (major >= 5) return "responses";
	}
	return "chat";
}

/** Resolve the route for a model given a (possibly null) catalog entry. */
export function resolveRoute(
	modelId: string,
	entry: CopilotModelEntry | null | undefined,
): CopilotRoute {
	const fromCatalog = routeFromEndpoints(entry?.supportedEndpoints);
	return fromCatalog ?? routeFromModelName(modelId);
}

/**
 * Fetches and caches the Copilot model catalog for one driver. The injected
 * fetch is the Copilot-authenticated wrapper (it carries the Bearer + required
 * headers), so this module never touches auth itself.
 */
export class CopilotCatalog {
	private cache: Map<string, CopilotModelEntry> | null = null;
	private fetchedAt = 0;
	private inFlight: Promise<Map<string, CopilotModelEntry>> | null = null;

	constructor(
		private readonly deps: {
			fetch: typeof fetch;
			apiEndpoint: string;
			now?: () => number;
			ttlMs?: number;
		},
	) {}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private fresh(): boolean {
		return this.cache !== null && this.now() - this.fetchedAt < (this.deps.ttlMs ?? CATALOG_TTL_MS);
	}

	/**
	 * Returns the catalog entry for a model, or null when the model is absent or
	 * the catalog could not be fetched. Never throws on a fetch failure — routing
	 * degrades to the name heuristic rather than breaking the turn.
	 */
	async getEntry(modelId: string): Promise<CopilotModelEntry | null> {
		const catalog = await this.load();
		return catalog.get(modelId) ?? null;
	}

	/** Load (or return cached) catalog. Single-flight; swallow-and-empty on error. */
	async load(): Promise<Map<string, CopilotModelEntry>> {
		if (this.fresh() && this.cache) return this.cache;
		if (this.inFlight) return this.inFlight;
		this.inFlight = (async () => {
			try {
				const res = await this.deps.fetch(`${this.deps.apiEndpoint}/models`, {
					method: "GET",
					headers: { Accept: "application/json" },
				});
				if (!res.ok) {
					// Degrade: keep any prior cache, else an empty map (name heuristic).
					return this.cache ?? new Map();
				}
				const json = (await res.json()) as RawModelsResponse;
				const next = new Map<string, CopilotModelEntry>();
				for (const raw of json.data ?? []) {
					const entry = parseEntry(raw);
					if (entry) next.set(entry.id, entry);
				}
				this.cache = next;
				this.fetchedAt = this.now();
				return next;
			} catch {
				return this.cache ?? new Map();
			} finally {
				this.inFlight = null;
			}
		})();
		return this.inFlight;
	}
}
