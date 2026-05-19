<script lang="ts">
import { scaleLinear } from "d3-scale";
import ChartTooltip from "./ChartTooltip.svelte";

interface Props {
	data: Array<{
		peer_site_id: string;
		avg_latency_ms: number;
		p95_latency_ms: number;
		success_count: number;
		failure_count: number;
	}>;
}

let { data }: Props = $props();

// Tooltip state
let tooltipVisible = $state(false);
let tooltipX = $state(0);
let tooltipY = $state(0);
let tooltipLines = $state<string[]>([]);
let containerEl: HTMLDivElement | undefined = $state(undefined);

// Sort data by avg latency descending
const sortedData = $derived.by(() => {
	return [...data].sort((a, b) => b.avg_latency_ms - a.avg_latency_ms);
});

// Get the maximum p95 latency across all hosts for x scale domain
const maxLatency = $derived.by(() => {
	return Math.max(...sortedData.map((d) => d.p95_latency_ms), 1);
});

// Color coding helper based on health thresholds
const getColorForLatency = (latency: number, opacity = 1): string => {
	if (latency < 500) {
		return `rgba(0, 200, 100, ${opacity})`;
	}
	if (latency < 2000) {
		return `rgba(255, 193, 7, ${opacity})`;
	}
	return `rgba(244, 67, 54, ${opacity})`;
};

// Calculate dimensions
const rowHeight = 60;
const padding = { top: 16, right: 16, bottom: 16, left: 200 };
const contentWidth = 700;
const containerHeight = $derived(sortedData.length * rowHeight + padding.top + padding.bottom);

// X scale: linear from 0 to maxLatency with nice ticks
const xScale = $derived.by(() => {
	return scaleLinear()
		.domain([0, maxLatency])
		.range([0, contentWidth - padding.left - padding.right])
		.nice();
});

// Format latency value with unit
const formatLatency = (ms: number): string => {
	return `${Math.round(ms)}ms`;
};

// Truncate site ID to last 8 chars for readability
const truncateSiteId = (id: string): string => {
	return id.length > 8 ? id.substring(id.length - 8) : id;
};

function showTooltip(
	event: MouseEvent,
	d: {
		peer_site_id: string;
		avg_latency_ms: number;
		p95_latency_ms: number;
		success_count: number;
		failure_count: number;
	},
	series: "avg" | "p95",
): void {
	if (!containerEl) return;
	const rect = containerEl.getBoundingClientRect();
	tooltipX = event.clientX - rect.left;
	tooltipY = event.clientY - rect.top;
	const total = d.success_count + d.failure_count;
	tooltipLines = [
		d.peer_site_id,
		series === "avg"
			? `Avg: ${formatLatency(d.avg_latency_ms)}`
			: `P95: ${formatLatency(d.p95_latency_ms)}`,
		`${d.success_count}/${total} successful`,
	];
	tooltipVisible = true;
}

function hideTooltip(): void {
	tooltipVisible = false;
}
</script>

<div class="latency-bar-chart" bind:this={containerEl}>
	<svg
		width={contentWidth}
		height={containerHeight}
		viewBox="0 0 {contentWidth} {containerHeight}"
		class="chart-svg"
	>
		<!-- Host labels and bars on the left -->
		{#each sortedData as d, i}
			<!-- Host label -->
			<text
				x={padding.left - 8}
				y={padding.top + i * rowHeight + rowHeight / 2}
				class="host-label"
				text-anchor="end"
				dominant-baseline="middle"
			>
				{truncateSiteId(d.peer_site_id)}
			</text>

			<!-- Average latency bar (solid color) -->
			<rect
				x={padding.left}
				y={padding.top + i * rowHeight + 8}
				width={xScale(d.avg_latency_ms)}
				height={rowHeight / 2 - 12}
				fill={getColorForLatency(d.avg_latency_ms, 1)}
				class="bar"
				onmouseenter={(e) => showTooltip(e, d, "avg")}
				onmousemove={(e) => showTooltip(e, d, "avg")}
				onmouseleave={hideTooltip}
			/>

			<!-- Average latency label -->
			<text
				x={padding.left + xScale(d.avg_latency_ms) + 4}
				y={padding.top + i * rowHeight + 14}
				class="bar-label"
				dominant-baseline="middle"
				fill="var(--ink)"
			>
				{formatLatency(d.avg_latency_ms)}
			</text>

			<!-- P95 latency bar (semi-transparent) -->
			<rect
				x={padding.left}
				y={padding.top + i * rowHeight + rowHeight / 2}
				width={xScale(d.p95_latency_ms)}
				height={rowHeight / 2 - 12}
				fill={getColorForLatency(d.p95_latency_ms, 0.5)}
				class="bar"
				onmouseenter={(e) => showTooltip(e, d, "p95")}
				onmousemove={(e) => showTooltip(e, d, "p95")}
				onmouseleave={hideTooltip}
			/>

			<!-- P95 latency label -->
			<text
				x={padding.left + xScale(d.p95_latency_ms) + 4}
				y={padding.top + i * rowHeight + rowHeight / 2 + 6}
				class="bar-label"
				dominant-baseline="middle"
				fill="var(--ink)"
			>
				{formatLatency(d.p95_latency_ms)}
			</text>
		{/each}
	</svg>

	<!-- Legend -->
	<div class="legend">
		<div class="legend-item">
			<div class="legend-color" style="background-color: rgba(0, 200, 100, 1); opacity: 1"></div>
			<span>Avg</span>
		</div>
		<div class="legend-item">
			<div class="legend-color" style="background-color: rgba(0, 200, 100, 1); opacity: 0.5"></div>
			<span>P95</span>
		</div>
	</div>

	<ChartTooltip visible={tooltipVisible} x={tooltipX} y={tooltipY} lines={tooltipLines} />
</div>

<style>
	.latency-bar-chart {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 16px;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		border-radius: 8px;
		margin: 16px 0;
	}

	.chart-svg {
		width: 100%;
		height: auto;
		display: block;
	}

	.host-label {
		font-size: 12px;
		fill: var(--ink);
		font-family: var(--font-mono);
		font-weight: 500;
	}

	.bar-label {
		font-size: 11px;
		font-family: var(--font-mono);
		font-weight: 500;
	}

	.bar {
		cursor: pointer;
		transition: opacity 0.15s ease;
	}

	.bar:hover {
		opacity: 1 !important;
	}

	.legend {
		display: flex;
		gap: 24px;
		padding-left: 200px;
		font-size: 12px;
		color: var(--ink-3);
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.legend-color {
		width: 12px;
		height: 12px;
		border-radius: 2px;
	}
</style>
