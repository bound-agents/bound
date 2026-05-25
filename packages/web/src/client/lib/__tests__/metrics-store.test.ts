import { beforeEach, describe, expect, it } from "bun:test";
import type { MetricsResponse } from "../../../server/routes/metrics";
import { MetricsStore } from "../metrics-store";
import type { FetchFn } from "../metrics-store";

function makeMetricsResponse(overrides?: Partial<MetricsResponse>): MetricsResponse {
	return {
		tokens: {
			byModel: [
				{
					model_id: "claude-opus",
					tokens_in: 1000,
					tokens_out: 500,
					cache_read: 800,
					cache_write: 200,
					cost_usd: 0.05,
					turn_count: 3,
				},
			],
			timeline: [{ date: "2026-05-19", tokens_in: 1000, tokens_out: 500, cost_usd: 0.05 }],
			costByModelTimeline: [
				{
					date: "2026-05-19",
					model_id: "claude-opus",
					cost_usd: 0.05,
					cost_input_usd: 0.03,
					cost_output_usd: 0.0125,
					cost_cache_read_usd: 0.0072,
					cost_cache_write_usd: 0.0003,
					tokens_in: 1000,
					tokens_out: 500,
					cache_read: 800,
					cache_write: 200,
				},
			],
			totals: {
				tokens_in: 1000,
				tokens_out: 500,
				cache_read: 800,
				cache_write: 200,
				cost_usd: 0.05,
				turn_count: 3,
				error_count: 0,
			},
		},
		relay: {
			byHost: [],
			recentCycles: [],
			totals: { total_cycles: 0, success_rate: 0, avg_latency_ms: 0, expired_count: 0 },
		},
		context: {
			totals: {
				avg_cache_hit_rate: 0.85,
				budget_pressure_count: 1,
				avg_truncated_tokens: 2.5,
				total_turns_with_debug: 10,
			},
			timeline: [
				{
					date: "2026-05-19",
					cache_hit_rate: 0.85,
					budget_pressure_pct: 0.1,
					avg_context_utilization: 0.7,
				},
			],
		},
		...overrides,
	};
}

function createMockFetch(response: MetricsResponse): FetchFn {
	return async (_url: string) => {
		return new Response(JSON.stringify(response), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
}

function createFailingFetch(status: number, body: Record<string, string>): FetchFn {
	return async (_url: string) => {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	};
}

function createNetworkErrorFetch(): FetchFn {
	return async (_url: string) => {
		throw new Error("Network error");
	};
}

describe("MetricsStore", () => {
	const from = "2026-05-18T00:00:00.000Z";
	const to = "2026-05-19T00:00:00.000Z";

	describe("initial load", () => {
		it("starts in idle state", () => {
			const store = new MetricsStore(createMockFetch(makeMetricsResponse()));
			expect(store.state.data).toBeNull();
			expect(store.state.initialLoading).toBe(false);
			expect(store.state.refreshing).toBe(false);
			expect(store.state.error).toBeNull();
		});

		it("sets initialLoading=true when no data exists yet", async () => {
			let capturedState: { initialLoading: boolean; refreshing: boolean } | null = null;

			const fetchFn: FetchFn = async (_url: string) => {
				// Capture state mid-flight
				capturedState = {
					initialLoading: store.state.initialLoading,
					refreshing: store.state.refreshing,
				};
				return new Response(JSON.stringify(makeMetricsResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			};

			const store = new MetricsStore(fetchFn);
			await store.load(from, to);

			// During the fetch, initialLoading should have been true
			expect(capturedState).not.toBeNull();
			expect(capturedState?.initialLoading).toBe(true);
			expect(capturedState?.refreshing).toBe(false);
		});

		it("populates data on successful initial load", async () => {
			const metricsData = makeMetricsResponse();
			const store = new MetricsStore(createMockFetch(metricsData));

			await store.load(from, to);

			expect(store.state.data).toEqual(metricsData);
			expect(store.state.initialLoading).toBe(false);
			expect(store.state.refreshing).toBe(false);
			expect(store.state.error).toBeNull();
		});

		it("sets error and null data on initial load failure", async () => {
			const store = new MetricsStore(createFailingFetch(500, { error: "Database timeout" }));

			await store.load(from, to);

			expect(store.state.data).toBeNull();
			expect(store.state.initialLoading).toBe(false);
			expect(store.state.error).toBe("Database timeout");
		});

		it("sets error on network failure during initial load", async () => {
			const store = new MetricsStore(createNetworkErrorFetch());

			await store.load(from, to);

			expect(store.state.data).toBeNull();
			expect(store.state.initialLoading).toBe(false);
			expect(store.state.error).toBe("Network error");
		});
	});

	describe("refresh (data already present)", () => {
		let store: MetricsStore;
		const initialData = makeMetricsResponse();

		beforeEach(async () => {
			store = new MetricsStore(createMockFetch(initialData));
			await store.load(from, to);
		});

		it("sets refreshing=true (NOT initialLoading) when data exists", async () => {
			let capturedState: {
				initialLoading: boolean;
				refreshing: boolean;
				data: MetricsResponse | null;
			} | null = null;

			const updatedData = makeMetricsResponse({
				tokens: {
					...initialData.tokens,
					totals: { ...initialData.tokens.totals, turn_count: 99 },
				},
			});

			// Replace the fetch function for the refresh
			const refreshStore = new MetricsStore(async (_url: string) => {
				capturedState = {
					initialLoading: refreshStore.state.initialLoading,
					refreshing: refreshStore.state.refreshing,
					data: refreshStore.state.data,
				};
				return new Response(JSON.stringify(updatedData), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			// Prime with initial data
			await refreshStore.load(from, to);

			// Now the second load should be a refresh
			// Override fetch to capture and return new data
			(refreshStore as any).fetchFn = async (_url: string) => {
				capturedState = {
					initialLoading: refreshStore.state.initialLoading,
					refreshing: refreshStore.state.refreshing,
					data: refreshStore.state.data,
				};
				return new Response(JSON.stringify(updatedData), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			};

			await refreshStore.load(from, to);

			expect(capturedState).not.toBeNull();
			// Key assertion: initialLoading is false, refreshing is true
			expect(capturedState?.initialLoading).toBe(false);
			expect(capturedState?.refreshing).toBe(true);
			// Data remains accessible during the refresh
			expect(capturedState?.data).not.toBeNull();
		});

		it("preserves existing data during a refresh", async () => {
			let dataSeenDuringFetch: MetricsResponse | null = null;

			(store as any).fetchFn = async (_url: string) => {
				dataSeenDuringFetch = store.state.data;
				return new Response(
					JSON.stringify(
						makeMetricsResponse({
							tokens: {
								...initialData.tokens,
								totals: { ...initialData.tokens.totals, turn_count: 42 },
							},
						}),
					),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			};

			await store.load(from, to);

			// Data was present during the fetch
			expect(dataSeenDuringFetch).toEqual(initialData);
		});

		it("replaces data with new data on successful refresh", async () => {
			const updatedData = makeMetricsResponse({
				tokens: {
					...initialData.tokens,
					totals: { ...initialData.tokens.totals, turn_count: 42 },
				},
			});

			(store as any).fetchFn = createMockFetch(updatedData);
			await store.load(from, to);

			expect(store.state.data).toEqual(updatedData);
			expect(store.state.refreshing).toBe(false);
			expect(store.state.error).toBeNull();
		});

		it("preserves existing data on refresh failure (HTTP error)", async () => {
			(store as any).fetchFn = createFailingFetch(500, {
				error: "Temporary outage",
			});
			await store.load(from, to);

			// Data is preserved!
			expect(store.state.data).toEqual(initialData);
			expect(store.state.refreshing).toBe(false);
			expect(store.state.error).toBe("Temporary outage");
		});

		it("preserves existing data on refresh failure (network error)", async () => {
			(store as any).fetchFn = createNetworkErrorFetch();
			await store.load(from, to);

			// Data is preserved!
			expect(store.state.data).toEqual(initialData);
			expect(store.state.refreshing).toBe(false);
			expect(store.state.error).toBe("Network error");
		});

		it("clears error on next successful refresh", async () => {
			// First, trigger a failure
			(store as any).fetchFn = createFailingFetch(500, { error: "oops" });
			await store.load(from, to);
			expect(store.state.error).toBe("oops");

			// Now succeed
			const newData = makeMetricsResponse();
			(store as any).fetchFn = createMockFetch(newData);
			await store.load(from, to);

			expect(store.state.error).toBeNull();
			expect(store.state.data).toEqual(newData);
		});
	});

	describe("URL construction", () => {
		it("passes from and to as query parameters", async () => {
			let capturedUrl = "";
			const store = new MetricsStore(async (url: string) => {
				capturedUrl = url;
				return new Response(JSON.stringify(makeMetricsResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			await store.load(from, to);

			expect(capturedUrl).toContain("from=2026-05-18T00%3A00%3A00.000Z");
			expect(capturedUrl).toContain("to=2026-05-19T00%3A00%3A00.000Z");
		});
	});
});
