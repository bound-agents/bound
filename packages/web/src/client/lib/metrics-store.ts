import type { MetricsResponse, ProviderMetrics } from "../../server/routes/metrics";
import { createApi } from "./api";

export interface MetricsState {
	/** Non-null once the first successful load completes. */
	data: MetricsResponse | null;
	/** True only during the initial load (before any data is available). */
	initialLoading: boolean;
	/** True during any background refresh (data already shown). */
	refreshing: boolean;
	/** Error from the most recent fetch attempt. Cleared on success. */
	error: string | null;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Manages metrics data fetching with two-phase loading:
 * - Initial load: shows a loading indicator (no data yet).
 * - Refresh: fetches in the background without clearing existing data,
 *   so components update in-place via reactivity rather than remounting.
 */
export class MetricsStore {
	private _state: MetricsState = {
		data: null,
		initialLoading: false,
		refreshing: false,
		error: null,
	};

	private fetchFn: FetchFn;

	/**
	 * Monotonic id of the most recently STARTED load. A resolving fetch only
	 * writes state when its id still matches — otherwise a slow earlier
	 * request (e.g. the 30s poll) racing a user-triggered range change would
	 * resolve last and overwrite the newer data with stale results.
	 */
	private loadSeq = 0;

	constructor(fetchFn: FetchFn = (url, init) => fetch(url, init)) {
		this.fetchFn = fetchFn;
	}

	get state(): MetricsState {
		return this._state;
	}

	/**
	 * Load metrics for the given date range.
	 * If data already exists, marks as refreshing (no loading flash).
	 * On success, replaces data in-place. On error during refresh,
	 * preserves existing data and sets error.
	 */
	async load(from: string, to: string): Promise<void> {
		const seq = ++this.loadSeq;
		const hasExistingData = this._state.data !== null;

		if (hasExistingData) {
			this._state = { ...this._state, refreshing: true, error: null };
		} else {
			this._state = { ...this._state, initialLoading: true, error: null };
		}

		try {
			const api = createApi((input, init) => this.fetchFn(String(input), init));
			const response = await api.api.metrics.$get({ query: { from, to } });
			if (seq !== this.loadSeq) return; // superseded by a newer load
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				if (seq !== this.loadSeq) return;
				const errorMsg =
					(body as Record<string, string>).error || `Request failed (${response.status})`;
				this._state = {
					...this._state,
					// Keep existing data on refresh failure
					data: hasExistingData ? this._state.data : null,
					initialLoading: false,
					refreshing: false,
					error: errorMsg,
				};
				return;
			}

			const data: MetricsResponse = await response.json();
			if (seq !== this.loadSeq) return;
			this._state = {
				data,
				initialLoading: false,
				refreshing: false,
				error: null,
			};
		} catch (err) {
			if (seq !== this.loadSeq) return;
			const errorMsg = err instanceof Error ? err.message : "Failed to load metrics";
			this._state = {
				...this._state,
				// Keep existing data on refresh failure
				data: hasExistingData ? this._state.data : null,
				initialLoading: false,
				refreshing: false,
				error: errorMsg,
			};
		}
	}
}

export interface ProviderRow {
	/** Provider id, or `"unattributed"` for the server's `provider: null` bucket. */
	provider: string;
	turns: number;
	tokens: number;
	cost_usd: number;
	errors: number;
	/** Fraction of all turns in range (0 when there are none). */
	turn_share: number;
	/** Fraction of total cost in range (0 when nothing was spent). */
	cost_share: number;
}

/** Project `tokens.byProvider` into table rows with turn and cost shares. */
export function providerRows(byProvider: ProviderMetrics[]): ProviderRow[] {
	let totalTurns = 0;
	let totalCost = 0;
	for (const p of byProvider) {
		totalTurns += p.turn_count;
		totalCost += p.cost_usd;
	}
	return byProvider.map((p) => ({
		provider: p.provider ?? "unattributed",
		turns: p.turn_count,
		tokens: p.tokens_in + p.tokens_out + p.cache_read + p.cache_write,
		cost_usd: p.cost_usd,
		errors: p.error_count,
		turn_share: totalTurns > 0 ? p.turn_count / totalTurns : 0,
		cost_share: totalCost > 0 ? p.cost_usd / totalCost : 0,
	}));
}
