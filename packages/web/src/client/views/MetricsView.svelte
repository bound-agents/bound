<script lang="ts">
import { onDestroy, onMount } from "svelte";
import type { MetricsResponse } from "../../server/routes/metrics";
import CacheHitTimeline from "../components/CacheHitTimeline.svelte";
import CostTimeline from "../components/CostTimeline.svelte";
import DataTable from "../components/DataTable.svelte";
import DateRangeBar from "../components/DateRangeBar.svelte";
import LatencyBarChart from "../components/LatencyBarChart.svelte";
import MetroCard from "../components/MetroCard.svelte";
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

// Computed properties
const totalTokens = $derived(
	data ? data.tokens.totals.tokens_in + data.tokens.totals.tokens_out : 0,
);

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

// Sparkline helper - generates normalized points and paths for inline SVGs
const SPARKLINE_WIDTH = 288;
const SPARKLINE_HEIGHT = 48;

interface SparklineData {
	points: Array<{ x: number; y: number }>;
	pathD: string;
	areaD: string;
}

function generateSparklineData(values: number[]): SparklineData {
	if (values.length === 0) {
		return { points: [], pathD: "", areaD: "" };
	}

	// Normalize values to [0, 1]
	const maxVal = Math.max(...values, 1); // Avoid division by zero
	const normalizedValues = values.map((v) => Math.max(0, Math.min(1, v / maxVal)));

	// Generate points
	const points = normalizedValues.map((v, i) => ({
		x: values.length === 1 ? SPARKLINE_WIDTH / 2 : (i / (values.length - 1)) * SPARKLINE_WIDTH,
		y: SPARKLINE_HEIGHT - v * (SPARKLINE_HEIGHT - 4),
	}));

	// Generate polyline path
	const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

	// Generate area path (polyline + close)
	const areaD =
		points.length > 0
			? `${pathD} L ${points[points.length - 1].x} ${SPARKLINE_HEIGHT} L ${points[0].x} ${SPARKLINE_HEIGHT} Z`
			: "";

	return { points, pathD, areaD };
}

// Extract sparkline data from context timeline
function getBudgetPressureSparkline(
	timeline: Array<{ budget_pressure_pct: number }>,
): SparklineData {
	const values = timeline.map((d) => d.budget_pressure_pct);
	return generateSparklineData(values);
}

function getContextUtilizationSparkline(
	timeline: Array<{ avg_context_utilization: number }>,
): SparklineData {
	const values = timeline.map((d) => d.avg_context_utilization);
	return generateSparklineData(values);
}
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
					<CostTimeline data={data.tokens.timeline} />
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
					</div>

					<CacheHitTimeline data={data.context.timeline} />

					<div class="sparkline-row">
						<div class="sparkline-item">
							<span class="sparkline-label">Budget Pressure Frequency</span>
							{#if data.context.timeline.length > 0}
								{@const sparkline = getBudgetPressureSparkline(data.context.timeline)}
								<svg
									viewBox="0 0 {SPARKLINE_WIDTH} {SPARKLINE_HEIGHT}"
									width="100%"
									height={SPARKLINE_HEIGHT}
									preserveAspectRatio="none"
									class="sparkline-svg"
								>
									{#if sparkline.areaD}
										<path d={sparkline.areaD} fill="var(--warn)" opacity="0.15" />
									{/if}
									{#if sparkline.pathD}
										<polyline points={sparkline.points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="var(--warn)" stroke-width="1.5" />
									{/if}
								</svg>
							{/if}
						</div>

						<div class="sparkline-item">
							<span class="sparkline-label">Context Utilization</span>
							{#if data.context.timeline.length > 0}
								{@const sparkline = getContextUtilizationSparkline(data.context.timeline)}
								<svg
									viewBox="0 0 {SPARKLINE_WIDTH} {SPARKLINE_HEIGHT}"
									width="100%"
									height={SPARKLINE_HEIGHT}
									preserveAspectRatio="none"
									class="sparkline-svg"
								>
									{#if sparkline.areaD}
										<path d={sparkline.areaD} fill="var(--line-3)" opacity="0.15" />
									{/if}
									{#if sparkline.pathD}
										<polyline points={sparkline.points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="var(--line-3)" stroke-width="1.5" />
									{/if}
								</svg>
							{/if}
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

	.sparkline-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
		margin: 16px 0;
		padding: 16px;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		border-radius: 8px;
	}

	.sparkline-item {
		display: flex;
		flex-direction: column;
	}

	.sparkline-label {
		font-size: 12px;
		color: var(--ink-3);
		margin-bottom: 8px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		text-align: center;
	}

	.sparkline-svg {
		display: block;
		height: auto;
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
