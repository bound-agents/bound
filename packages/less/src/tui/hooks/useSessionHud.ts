import type { BoundClient, ContextDebugEvent, MetricsTokenTotals } from "@bound/client";
import { useEffect, useRef, useState } from "react";

/**
 * Session HUD state: live context-window pressure for the current thread plus
 * cluster-wide spend. Everything here is served by the spoke itself — the
 * context gauge rides the `context:debug` WS event the agent loop emits after
 * every turn (with `actualTotalTokens` already applied, so the number is the
 * provider-billed truth, not the local estimate), and the cost figures come
 * from `GET /api/metrics`, which aggregates the synced `turns` table locally.
 * No hub round-trip anywhere.
 */
export interface SessionHudState {
	/** Provider-reported tokens occupying the context window after the last turn. */
	contextTokens: number | null;
	/** The model's context window at last turn (from context assembly). */
	contextWindow: number | null;
	/** contextTokens / contextWindow, clamped to [0, 1]. Null until the first turn. */
	contextPct: number | null;
	/** Cluster-wide spend since local midnight (USD). */
	todayCostUsd: number | null;
	/** Cluster-wide spend since this TUI session started (USD). */
	sessionCostUsd: number | null;
}

const EMPTY: SessionHudState = {
	contextTokens: null,
	contextWindow: null,
	contextPct: null,
	todayCostUsd: null,
	sessionCostUsd: null,
};

/** Local midnight — "today" as the operator's calendar sees it, not UTC's. */
function localMidnight(): Date {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d;
}

/**
 * Subscribe to the session HUD signals.
 *
 * Context gauge: updated from each `context:debug` event for THIS thread.
 * Cost: fetched on mount and refreshed when a turn completes (`thread:status`
 * active:false for this thread), debounced to at most one fetch per
 * `costRefreshMinIntervalMs` so a burst of quick turns doesn't hammer the
 * metrics endpoint. Fetch failures are silent — the HUD is decoration, and a
 * momentarily unreachable server already surfaces through the connection
 * badge; the last-known numbers stay up rather than flapping to null.
 */
export function useSessionHud(
	client: BoundClient | null,
	threadId: string,
	costRefreshMinIntervalMs = 15_000,
): SessionHudState {
	const [state, setState] = useState<SessionHudState>(EMPTY);
	// Session start is fixed at first mount — switching threads mid-session
	// keeps the same "since you sat down" window.
	const sessionStartRef = useRef(new Date());
	const lastFetchRef = useRef(0);

	// The thread we're gauging switches with /attach; keep the ref fresh so
	// the stable event handler filters on the CURRENT thread.
	const threadIdRef = useRef(threadId);
	threadIdRef.current = threadId;

	useEffect(() => {
		if (!client) return;
		// Same degradation contract as getMetricsTotals below: a partial client
		// (older server build, minimal test mock) that can't carry event
		// subscriptions gets no HUD rather than a crashed view.
		if (typeof client.on !== "function" || typeof client.off !== "function") return;

		let disposed = false;

		const refreshCost = (force = false) => {
			// Older servers / partial test mocks may not carry getMetricsTotals.
			// The HUD is decoration — degrade to no cost segment rather than
			// throwing inside a mount effect and unmounting the whole view (the
			// .catch below only covers ASYNC rejections, not a synchronous
			// TypeError from calling a missing method).
			if (typeof client.getMetricsTotals !== "function") return;
			const now = Date.now();
			if (!force && now - lastFetchRef.current < costRefreshMinIntervalMs) return;
			lastFetchRef.current = now;
			const nowDate = new Date();
			void Promise.all([
				client.getMetricsTotals(localMidnight(), nowDate),
				client.getMetricsTotals(sessionStartRef.current, nowDate),
			])
				.then(([today, session]: [MetricsTokenTotals, MetricsTokenTotals]) => {
					if (disposed) return;
					setState((s) => ({
						...s,
						todayCostUsd: today.cost_usd,
						sessionCostUsd: session.cost_usd,
					}));
				})
				.catch(() => {
					// Silent: keep last-known numbers (see contract above).
				});
		};

		const onContextDebug = (data: ContextDebugEvent) => {
			if (data.thread_id !== threadIdRef.current) return;
			const debug = data.debug;
			const window = debug.contextWindow ?? null;
			const tokens = debug.actualTotalTokens ?? debug.totalEstimated ?? null;
			setState((s) => ({
				...s,
				contextTokens: tokens,
				contextWindow: window,
				contextPct:
					tokens != null && window != null && window > 0
						? Math.min(1, Math.max(0, tokens / window))
						: s.contextPct,
			}));
		};

		const onThreadStatus = (data: { thread_id: string; active: boolean }) => {
			if (data.thread_id !== threadIdRef.current) return;
			// Turn completed → new turns rows exist → refresh spend.
			if (!data.active) refreshCost();
		};

		client.on("context:debug", onContextDebug);
		client.on("thread:status", onThreadStatus);
		refreshCost(true);

		return () => {
			disposed = true;
			client.off("context:debug", onContextDebug);
			client.off("thread:status", onThreadStatus);
		};
	}, [client, costRefreshMinIntervalMs]);

	return state;
}

/** Format a USD amount for the one-line HUD: $0.42, $12.30, $1.2k. */
export function formatUsd(amount: number): string {
	if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}k`;
	if (amount >= 100) return `$${Math.round(amount)}`;
	return `$${amount.toFixed(2)}`;
}

/** Compact token count: 999, 1.2k, 87k, 1.1M. */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}
