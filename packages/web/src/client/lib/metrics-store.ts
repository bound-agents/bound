import type { MetricsResponse } from "../../server/routes/metrics";

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

export type FetchFn = (url: string) => Promise<Response>;

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

	constructor(fetchFn: FetchFn = (url) => fetch(url)) {
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
			const params = new URLSearchParams();
			params.append("from", from);
			params.append("to", to);

			const response = await this.fetchFn(`/api/metrics?${params}`);
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

			const data = (await response.json()) as MetricsResponse;
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
