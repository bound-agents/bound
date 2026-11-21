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

/** The subset of a catalog entry we read. */
export interface CopilotModelEntry {
	id: string;
	supportedEndpoints?: string[];
	maxPromptTokens?: number;
	maxOutputTokens?: number;
	maxContextWindowTokens?: number;
	supportsToolCalls?: boolean;
	supportsVision?: boolean;
	/** True when every token price is 0 (Free-callable). */
	zeroPriced?: boolean;
	policyState?: string;
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
		supports?: { tool_calls?: boolean; vision?: boolean };
	};
	policy?: { state?: string };
	model_picker_enabled?: boolean;
	billing?: { token_prices?: Record<string, number> & { batch_size?: number } };
}

interface RawModelsResponse {
	data?: RawModelEntry[];
}

/** Default catalog cache lifetime (1 hour). */
export const CATALOG_TTL_MS = 60 * 60_000;

function parseEntry(raw: RawModelEntry): CopilotModelEntry | null {
	if (!raw.id) return null;
	const prices = raw.billing?.token_prices;
	// Free-callable iff every numeric price is 0 (batch_size is metadata, not a
	// price — exclude it). Absent billing → treat as NOT known-zero-priced.
	let zeroPriced: boolean | undefined;
	if (prices) {
		zeroPriced = Object.entries(prices).every(
			([key, value]) => key === "batch_size" || value === 0,
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
		...(zeroPriced !== undefined && { zeroPriced }),
		policyState: raw.policy?.state,
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
