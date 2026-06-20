<script lang="ts">
import { scaleLinear } from "d3-scale";
import { observeWidth } from "../lib/responsive-svg";
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

// Track rendered width so SVG renders 1:1 with pixels (avoids text scaling).
let measuredWidth = $state(700);

// Sort data by avg latency descending
const sortedData = $derived.by(() => {
	return [...data].sort((a, b) => b.avg_latency_ms - a.avg_latency_ms);
});

// Get the maximum p95 latency across all hosts for x scale domain
const maxLatency = $derived.by(() => {
	return Math.max(...sortedData.map((d) => d.p95_latency_ms), 1);
});

// Latency-tier color (green / amber / red). The legend below shows these
// tiers separately so viewers can decode bar color independently of the
// avg/p95 distinction.
const LATENCY_OK = "rgb(0, 200, 100)";
const LATENCY_WARN = "rgb(255, 193, 7)";
const LATENCY_BAD = "rgb(244, 67, 54)";

const getColorForLatency = (latency: number, opacity = 1): string => {
	if (latency < 500) return `rgba(0, 200, 100, ${opacity})`;
	if (latency < 2000) return `rgba(255, 193, 7, ${opacity})`;
	return `rgba(244, 67, 54, ${opacity})`;
};

// Calculate dimensions
const rowHeight = 56;
const padding = { top: 12, right: 16, bottom: 12, left: 180 };
const contentWidth = $derived(Math.max(measuredWidth, 360));
const containerHeight = $derived(sortedData.length * rowHeight + padding.top + padding.bottom);

// X scale: linear from 0 to maxLatency with nice ticks
const xScale = $derived.by(() => {
	return scaleLinear()
		.domain([0, maxLatency])
		.range([0, contentWidth - padding.left - padding.right])
		.nice();
});

const formatLatency = (ms: number): string => `${Math.round(ms)}ms`;

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

<div
	class="latency-bar-chart"
	bind:this={containerEl}
	use:observeWidth={(w) => {
		measuredWidth = w - 32;
	}}
>
	<svg
		width={contentWidth}
		height={containerHeight}
		viewBox="0 0 {contentWidth} {containerHeight}"
		class="chart-svg"
		preserveAspectRatio="xMinYMin meet"
	>
		{#each sortedData as d, i}
			<text
				x={padding.left - 8}
				y={padding.top + i * rowHeight + rowHeight / 2}
				class="host-label"
				text-anchor="end"
				dominant-baseline="middle"
			>
				{truncateSiteId(d.peer_site_id)}
			</text>

			<!-- Average latency bar (solid) -->
			<rect
				x={padding.left}
				y={padding.top + i * rowHeight + 6}
				width={xScale(d.avg_latency_ms)}
				height={rowHeight / 2 - 8}
				fill={getColorForLatency(d.avg_latency_ms, 1)}
				class="bar"
				role="img"
				aria-label="Average latency bar"
				onmouseenter={(e) => showTooltip(e, d, "avg")}
				onmousemove={(e) => showTooltip(e, d, "avg")}
				onmouseleave={hideTooltip}
			/>

			<text
				x={padding.left + xScale(d.avg_latency_ms) + 4}
				y={padding.top + i * rowHeight + 6 + (rowHeight / 2 - 8) / 2}
				class="bar-label"
				dominant-baseline="middle"
				fill="var(--ink)"
			>
				{formatLatency(d.avg_latency_ms)}
			</text>

			<!-- P95 latency bar (semi-transparent) -->
			<rect
				x={padding.left}
				y={padding.top + i * rowHeight + rowHeight / 2 + 2}
				width={xScale(d.p95_latency_ms)}
				height={rowHeight / 2 - 8}
				fill={getColorForLatency(d.p95_latency_ms, 0.5)}
				class="bar"
				role="img"
				aria-label="P95 latency bar"
				onmouseenter={(e) => showTooltip(e, d, "p95")}
				onmousemove={(e) => showTooltip(e, d, "p95")}
				onmouseleave={hideTooltip}
			/>

			<text
				x={padding.left + xScale(d.p95_latency_ms) + 4}
				y={padding.top + i * rowHeight + rowHeight / 2 + 2 + (rowHeight / 2 - 8) / 2}
				class="bar-label"
				dominant-baseline="middle"
				fill="var(--ink)"
			>
				{formatLatency(d.p95_latency_ms)}
			</text>
		{/each}
	</svg>

	<!-- Legend: avg vs p95 (opacity-distinguished) plus health tiers -->
	<div class="legend">
		<div class="legend-group">
			<div class="legend-item">
				<div class="legend-bar" style="background-color: var(--ink); opacity: 0.85"></div>
				<span>Avg (solid)</span>
			</div>
			<div class="legend-item">
				<div class="legend-bar" style="background-color: var(--ink); opacity: 0.4"></div>
				<span>P95 (faded)</span>
			</div>
		</div>
		<div class="legend-divider" aria-hidden="true"></div>
		<div class="legend-group">
			<div class="legend-item">
				<div class="legend-color" style="background-color: {LATENCY_OK}"></div>
				<span>&lt; 500ms</span>
			</div>
			<div class="legend-item">
				<div class="legend-color" style="background-color: {LATENCY_WARN}"></div>
				<span>500–2000ms</span>
			</div>
			<div class="legend-item">
				<div class="legend-color" style="background-color: {LATENCY_BAD}"></div>
				<span>≥ 2000ms</span>
			</div>
		</div>
	</div>

	<ChartTooltip visible={tooltipVisible} x={tooltipX} y={tooltipY} lines={tooltipLines} />
</div>

<style>
	.latency-bar-chart {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		border-radius: 8px;
		margin: 16px 0;
	}

	.chart-svg {
		display: block;
		max-width: 100%;
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
		flex-wrap: wrap;
		align-items: center;
		gap: 16px;
		font-size: 11px;
		color: var(--ink-3);
	}

	.legend-group {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
	}

	.legend-divider {
		width: 1px;
		height: 16px;
		background: var(--rule-soft);
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

	.legend-bar {
		width: 16px;
		height: 8px;
		border-radius: 1px;
	}
</style>
