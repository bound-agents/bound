<script lang="ts">
import { onDestroy, onMount } from "svelte";
import type { MetricsResponse } from "../../server/routes/metrics";
import CacheHitTimeline from "../components/CacheHitTimeline.svelte";
import CostTimeline from "../components/CostTimeline.svelte";
import DataTable from "../components/DataTable.svelte";
import DateRangeBar from "../components/DateRangeBar.svelte";
import LatencyBarChart from "../components/LatencyBarChart.svelte";
import MetroCard from "../components/MetroCard.svelte";
import MiniMetricChart from "../components/MiniMetricChart.svelte";
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";
import TokenBarChart from "../components/TokenBarChart.svelte";
import { formatRelativeTime } from "../lib/format-time";
import { MetricsStore } from "../lib/metrics-store";

const store = new MetricsStore();

let from = $state(new Date(Date.now() - 24 * 3600_000).toISOString());
let to = $state(new Date().toISOString());

let pollInterval: ReturnType<typeof setInterval> | null = null;

// Svelte $state bindings synced after each load()
let data: MetricsResponse | null = $state(null);
let initialLoading = $state(false);
let refreshing = $state(false);
let error: string | null = $state(null);

function syncState(): void {
	data = store.state.data;
	initialLoading = store.state.initialLoading;
	refreshing = store.state.refreshing;
	error = store.state.error;
}

// Computed properties — totals are now sourced directly from
// `data.tokens.totals` (the metrics route aggregates all four token classes
// server-side). The headline number sums the four token classes so cache
// traffic is not hidden from the operator on cache-heavy workloads.
const tokensIn = $derived(data?.tokens.totals.tokens_in ?? 0);
const tokensOut = $derived(data?.tokens.totals.tokens_out ?? 0);
const totalCacheRead = $derived(data?.tokens.totals.cache_read ?? 0);
const totalCacheWrite = $derived(data?.tokens.totals.cache_write ?? 0);
const totalTokens = $derived(tokensIn + tokensOut + totalCacheRead + totalCacheWrite);

async function loadMetrics(): Promise<void> {
	// store.load() synchronously sets refreshing/initialLoading before awaiting fetch.
	// We start it, sync the in-flight flags, then await completion and sync the result.
	const promise = store.load(from, to);
	syncState();
	await promise;
	syncState();
}

function handleRangeChange(newFrom: string, newTo: string): void {
	from = newFrom;
	to = newTo;
	loadMetrics();
}

function dateRangeIncludesNow(): boolean {
	const now = new Date();
	const toTime = new Date(to).getTime();
	// Consider "now" included if the range ends within 1 minute of now
	return toTime > now.getTime() - 60000;
}

onMount(() => {
	loadMetrics();

	// Only poll when range includes "now"
	pollInterval = setInterval(() => {
		if (dateRangeIncludesNow()) {
			// Refresh 'to' to current time before fetching
			to = new Date().toISOString();
			loadMetrics();
		}
	}, 30000);
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
});

// Column definitions for relay cycles table
const relayCycleColumns = [
	{ key: "peer_site_id", label: "Peer", width: "1fr", mono: true, sortable: true },
	{ key: "direction", label: "Direction", width: "100px", sortable: true },
	{ key: "kind", label: "Kind", width: "100px", sortable: true },
	{ key: "latency_ms", label: "Latency", width: "100px", mono: true, sortable: true },
	{ key: "success", label: "Status", width: "80px", sortable: true },
	{ key: "created_at", label: "Time", width: "140px", sortable: true },
];

// Transform recent cycles for display
const relayCycleRows = $derived(
	data?.relay.recentCycles.map((cycle) => ({
		...cycle,
		latency_ms: cycle.latency_ms !== null ? `${cycle.latency_ms}ms` : "—",
		success: cycle.success ? "OK" : "FAIL",
		created_at: formatRelativeTime(cycle.created_at),
	})) ?? [],
);

// Row accent function for relay cycles
function relayRowAccent(row: Record<string, unknown>): string | null {
	if (row.success === "FAIL") return "var(--err)";
	if (row.expired === true) return "var(--warn)";
	return null;
}

// Format helpers for mini-chart axis/tooltip labels
const formatPctAxis = (v: number): string => `${(v * 100).toFixed(0)}%`;
const formatPctTooltip = (v: number): string => `${(v * 100).toFixed(1)}%`;
</script>

<Page>
	{#snippet children()}
		<SectionHeader number={1} subtitle="Performance Analytics" title="Metrics" />

		<DateRangeBar {from} {to} onRangeChange={handleRangeChange} disabled={initialLoading} />

		{#if initialLoading}
			<div class="state">
				<p>Loading metrics…</p>
			</div>
		{:else if error && !data}
			<div class="state err">
				<p>{error}</p>
			</div>
		{:else if data}
			{#if error}
				<div class="refresh-error">
					<p>{error}</p>
				</div>
			{/if}
			{#if refreshing}
				<div class="refresh-indicator" aria-live="polite">
					<span class="refresh-dot"></span> Refreshing…
				</div>
			{/if}
			{#if data.tokens.totals.turn_count === 0 && data.relay.totals.total_cycles === 0}
				<div class="state">
					<p>No data recorded in the selected range. Try expanding the date range.</p>
				</div>
			{:else}
				<SectionHeader number={1} subtitle="Performance Analytics" title="Tokens" />

				{#if data.tokens.totals.turn_count === 0}
					<div class="state">
						<p>No turns recorded in the selected range.</p>
					</div>
				{:else}
					<div class="metrics-cards">
						<MetroCard accentColor="var(--line-3)">
							{#snippet children()}
								<span class="metric-label">Total Tokens</span>
								<span class="metric-value">{totalTokens.toLocaleString()}</span>
								<div class="token-breakdown">
									<div class="token-row">
										<span class="token-row-label token-row-input">↑ Input</span>
										<span class="token-row-value mono tnum">{tokensIn.toLocaleString()}</span>
									</div>
									<div class="token-row">
										<span class="token-row-label token-row-output">↓ Output</span>
										<span class="token-row-value mono tnum">{tokensOut.toLocaleString()}</span>
									</div>
									<div class="token-row">
										<span class="token-row-label token-row-cache-read">⟲ Cache read</span>
										<span class="token-row-value mono tnum">{totalCacheRead.toLocaleString()}</span>
									</div>
									<div class="token-row">
										<span class="token-row-label token-row-cache-write">⟳ Cache write</span>
										<span class="token-row-value mono tnum">{totalCacheWrite.toLocaleString()}</span>
									</div>
								</div>
							{/snippet}
						</MetroCard>

						<MetroCard accentColor="var(--line-0)">
							{#snippet children()}
								<span class="metric-label">Total Cost</span>
								<span class="metric-value">${data.tokens.totals.cost_usd.toFixed(4)}</span>
							{/snippet}
						</MetroCard>

						<MetroCard accentColor="var(--line-5)">
							{#snippet children()}
								<span class="metric-label">Turn Count</span>
								<span class="metric-value">{data.tokens.totals.turn_count.toLocaleString()}</span>
							{/snippet}
						</MetroCard>
					</div>

					<TokenBarChart data={data.tokens.byModel} />
					<CostTimeline data={data.tokens.costByModelTimeline} />
				{/if}

				<SectionHeader number={2} subtitle="Local-only — reflects this node's observations" title="Relay Performance" />

				{#if data.relay.totals.total_cycles === 0}
					<div class="state">
						<p>No relay cycles recorded in the selected range.</p>
					</div>
				{:else}
					<div class="metrics-cards">
						<MetroCard accentColor={data.relay.totals.success_rate >= 0.95 ? "var(--ok)" : data.relay.totals.success_rate >= 0.8 ? "var(--warn)" : "var(--err)"}>
							{#snippet children()}
								<span class="metric-label">Success Rate</span>
								<span class="metric-value">{(data.relay.totals.success_rate * 100).toFixed(1)}%</span>
							{/snippet}
						</MetroCard>

						<MetroCard accentColor="var(--line-3)">
							{#snippet children()}
								<span class="metric-label">Avg Latency</span>
								<span class="metric-value">{Math.round(data.relay.totals.avg_latency_ms)}ms</span>
							{/snippet}
						</MetroCard>

						<MetroCard accentColor={data.relay.totals.expired_count > 0 ? "var(--warn)" : "var(--ok)"}>
							{#snippet children()}
								<span class="metric-label">Expired Count</span>
								<span class="metric-value">{data.relay.totals.expired_count}</span>
							{/snippet}
						</MetroCard>
					</div>

					<LatencyBarChart data={data.relay.byHost} />

					<div class="relay-table-scroll">
						<DataTable
							columns={relayCycleColumns}
							rows={relayCycleRows}
							sortable={true}
							rowAccent={relayRowAccent}
						/>
					</div>
				{/if}

				<SectionHeader number={3} subtitle="Context Pipeline Performance" title="Context Assembly" />

				{#if data.context.totals.total_turns_with_debug === 0}
					<div class="state">
						<p>No context debug data in the selected range.</p>
					</div>
				{:else}
					<div class="metrics-cards">
						<MetroCard
							accentColor={data.context.totals.avg_cache_hit_rate >= 0.8
								? "var(--ok)"
								: data.context.totals.avg_cache_hit_rate >= 0.5
									? "var(--warn)"
									: "var(--err)"}
						>
							{#snippet children()}
								<span class="metric-label">Cache Hit Rate</span>
								<span class="metric-value">{(data.context.totals.avg_cache_hit_rate * 100).toFixed(1)}%</span>
							{/snippet}
						</MetroCard>

						<MetroCard accentColor={data.context.totals.budget_pressure_count === 0 ? "var(--ok)" : "var(--warn)"}>
							{#snippet children()}
								<span class="metric-label">Budget Pressure</span>
								<span class="metric-value">{data.context.totals.budget_pressure_count}</span>
								<span class="metric-unit">turns</span>
							{/snippet}
						</MetroCard>

						<MetroCard accentColor="var(--line-3)">
							{#snippet children()}
								<span class="metric-label">Avg Truncation</span>
								<span class="metric-value">{data.context.totals.avg_truncated_tokens.toFixed(1)}</span>
								<span class="metric-unit">msgs</span>
							{/snippet}
						</MetroCard>

						<MetroCard accentColor={totalCacheRead > 0 ? "var(--ok)" : "var(--idle)"}>
							{#snippet children()}
								<span class="metric-label">Cache Tokens</span>
								<span class="metric-value cache-card-value">
									<span class="cache-card-read mono tnum">↑ {totalCacheRead.toLocaleString()}</span>
									<span class="cache-card-sep">/</span>
									<span class="cache-card-write mono tnum">↓ {totalCacheWrite.toLocaleString()}</span>
								</span>
								<span class="metric-unit">read / write</span>
							{/snippet}
						</MetroCard>
					</div>

					<CacheHitTimeline data={data.context.timeline} />

					<div class="sparkline-row">
						<div class="sparkline-item">
							<MiniMetricChart
								title="Budget Pressure Frequency (% of turns)"
								color="var(--line-1)"
								yMin={0}
								yMax={1}
								formatValue={formatPctTooltip}
								formatAxis={formatPctAxis}
								data={data.context.timeline.map((d) => ({
									date: d.date,
									value: d.budget_pressure_pct,
								}))}
							/>
						</div>

						<div class="sparkline-item">
							<MiniMetricChart
								title="Context Utilization (avg estimated / window)"
								color="var(--line-3)"
								yMin={0}
								yMax={1}
								formatValue={formatPctTooltip}
								formatAxis={formatPctAxis}
								data={data.context.timeline.map((d) => ({
									date: d.date,
									value: d.avg_context_utilization,
								}))}
							/>
						</div>
					</div>
				{/if}
			{/if}
		{/if}
	{/snippet}
</Page>

<style>
	.state {
		padding: 40px 16px;
		text-align: center;
		color: var(--ink-3);
		font-style: italic;
	}

	.state.err {
		color: var(--err);
	}

	.metrics-cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 16px;
		margin: 16px 0;
	}

	.metric-label {
		display: block;
		font-size: 12px;
		color: var(--ink-3);
		margin-bottom: 8px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.metric-value {
		display: block;
		font-size: 24px;
		font-weight: 600;
		color: var(--ink);
	}


	.metric-unit {
		display: block;
		font-size: 11px;
		color: var(--ink-3);
		margin-top: 4px;
		text-transform: capitalize;
	}

	.token-breakdown {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-top: 8px;
		font-size: 12px;
	}

	.token-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 8px;
	}

	.token-row-label {
		color: var(--ink-3);
	}

	.token-row-input {
		color: var(--line-3);
	}

	.token-row-output {
		color: var(--line-0);
	}

	.token-row-cache-read {
		color: var(--ok);
	}

	.token-row-cache-write {
		color: var(--warn);
	}

	.token-row-value {
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}

	.cache-card-value {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		font-size: 18px;
		font-weight: 600;
	}

	.cache-card-read {
		color: var(--ok);
		font-variant-numeric: tabular-nums;
	}

	.cache-card-write {
		color: var(--warn);
		font-variant-numeric: tabular-nums;
	}

	.cache-card-sep {
		color: var(--ink-4);
		font-size: 14px;
	}

	.sparkline-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
		margin: 16px 0;
		padding: 8px;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		border-radius: 8px;
	}

	.sparkline-item {
		display: flex;
		flex-direction: column;
		min-width: 0; /* allow shrink within grid track */
	}

	.relay-table-scroll {
		max-height: 400px;
		overflow-y: auto;
		border: 1px solid var(--rule-soft);
		border-radius: 8px;
	}

	.refresh-indicator {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--ink-3);
		padding: 4px 12px;
		margin-bottom: 8px;
	}

	.refresh-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--line-3);
		animation: pulse 1.2s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 0.4; }
		50% { opacity: 1; }
	}

	.refresh-error {
		padding: 8px 12px;
		margin-bottom: 8px;
		font-size: 12px;
		color: var(--err);
		background: color-mix(in srgb, var(--err) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--err) 20%, transparent);
		border-radius: 4px;
	}

	@media (max-width: 960px) {
		.metrics-cards {
			grid-template-columns: 1fr;
		}

		.sparkline-row {
			grid-template-columns: 1fr;
		}
	}
</style>
