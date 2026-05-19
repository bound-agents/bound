<script lang="ts">
import { onDestroy, onMount } from "svelte";
import type { MetricsResponse } from "../../server/routes/metrics";
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";

let data: MetricsResponse | null = $state(null);
let loading = $state(true);
let error: string | null = $state(null);
let from = $state("");
let to = $state("");

let pollInterval: ReturnType<typeof setInterval> | null = null;

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

function dateRangeIncludesNow(): boolean {
	const now = new Date();
	const toTime = new Date(to).getTime();
	// Consider "now" included if the range ends within 1 minute of now
	return toTime > now.getTime() - 60000;
}

onMount(() => {
	// Initialize to 24h preset
	const now = new Date();
	const oneDayAgo = new Date(now.getTime() - 24 * 3600 * 1000);

	to = now.toISOString();
	from = oneDayAgo.toISOString();

	loadMetrics();

	// Only poll when range includes "now"
	pollInterval = setInterval(() => {
		if (dateRangeIncludesNow()) {
			loadMetrics();
		}
	}, 30000);
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
});
</script>

<Page>
	{#snippet children()}
		<SectionHeader number={1} subtitle="Performance Analytics" title="Metrics" />

		{#if loading}
			<div class="state">
				<p>Loading metrics…</p>
			</div>
		{:else if error}
			<div class="state err">
				<p>{error}</p>
			</div>
		{:else if data}
			<SectionHeader number={1} subtitle="Placeholder" title="Tokens">
				<p>Actual token charts will appear in Phase 3+</p>
			</SectionHeader>

			<SectionHeader number={2} subtitle="Placeholder" title="Relay">
				<p>Actual relay charts will appear in Phase 4+</p>
			</SectionHeader>

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
</style>
