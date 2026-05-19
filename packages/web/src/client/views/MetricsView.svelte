<script lang="ts">
import { onDestroy, onMount } from "svelte";
import type { MetricsResponse } from "../../server/routes/metrics";
import CostTimeline from "../components/CostTimeline.svelte";
import DataTable from "../components/DataTable.svelte";
import DateRangeBar from "../components/DateRangeBar.svelte";
import LatencyBarChart from "../components/LatencyBarChart.svelte";
import MetroCard from "../components/MetroCard.svelte";
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";
import TokenBarChart from "../components/TokenBarChart.svelte";
import { formatRelativeTime } from "../lib/format-time";

let data: MetricsResponse | null = $state(null);
let loading = $state(true);
let error: string | null = $state(null);
let from = $state(new Date(Date.now() - 24 * 3600_000).toISOString());
let to = $state(new Date().toISOString());

let pollInterval: ReturnType<typeof setInterval> | null = null;

// Computed properties
const totalTokens = $derived(
	data ? data.tokens.totals.tokens_in + data.tokens.totals.tokens_out : 0,
);

async function loadMetrics(): Promise<void> {
	try {
		const params = new URLSearchParams();
		params.append("from", from);
		params.append("to", to);

		const response = await fetch(`/api/metrics?${params}`);
		if (!response.ok) {
			error = `Failed to load metrics: ${response.statusText}`;
			data = null;
		} else {
			data = (await response.json()) as MetricsResponse;
			error = null;
		}
	} catch (err) {
		console.error("Failed to load metrics:", err);
		error = "Network request failed";
		data = null;
	}
	loading = false;
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
</script>

<Page>
	{#snippet children()}
		<SectionHeader number={1} subtitle="Performance Analytics" title="Metrics" />

		<DateRangeBar {from} {to} onRangeChange={handleRangeChange} disabled={loading} />

		{#if loading}
			<div class="state">
				<p>Loading metrics…</p>
			</div>
		{:else if error}
			<div class="state err">
				<p>{error}</p>
			</div>
		{:else if data}
			<SectionHeader number={1} subtitle="Performance Analytics" title="Tokens" />

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

			<SectionHeader number={2} subtitle="Local-only — reflects this node's observations" title="Relay Performance" />

			{#if data.relay.totals.total_cycles === 0}
				<div class="empty-state">
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

				<DataTable
					columns={relayCycleColumns}
					rows={relayCycleRows}
					sortable={true}
					rowAccent={relayRowAccent}
				/>
			{/if}

			<SectionHeader number={3} subtitle="Placeholder" title="Context">
				<p>Actual context charts will appear in Phase 5+</p>
			</SectionHeader>
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

	.empty-state {
		padding: 40px 16px;
		text-align: center;
		color: var(--ink-3);
		font-style: italic;
	}
</style>
