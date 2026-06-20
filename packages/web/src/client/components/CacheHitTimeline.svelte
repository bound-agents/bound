<script lang="ts">
import { scaleLinear, scaleTime } from "d3-scale";
import {
	type BucketPoint,
	formatBucketAxisLabel,
	formatBucketTooltipLabel,
	parseBucket,
} from "../lib/chart-time";
import { observeWidth } from "../lib/responsive-svg";
import ChartTooltip from "./ChartTooltip.svelte";

interface Props {
	data: Array<{
		date: string;
		cache_hit_rate: number;
	}>;
}

let { data }: Props = $props();

// Tooltip state
let tooltipVisible = $state(false);
let tooltipX = $state(0);
let tooltipY = $state(0);
let tooltipLines = $state<string[]>([]);
let containerEl: HTMLDivElement | undefined = $state(undefined);

// Track rendered width — keeps text at literal pixel sizes regardless of
// container width (see responsive-svg.ts for rationale).
let measuredWidth = $state(600);

// Parse bucket strings (UTC-aware — see chart-time.ts) and sort by time
const parsedData = $derived.by(() => {
	return data
		.map((d) => {
			const bucket = parseBucket(d.date);
			return { ...d, bucket, dateObj: bucket.dateObj };
		})
		.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
});

// Dimensions
const width = $derived(Math.max(measuredWidth, 320));
const height = 200;
const padding = { top: 16, right: 16, bottom: 32, left: 48 };
const innerWidth = $derived(width - padding.left - padding.right);
const innerHeight = height - padding.top - padding.bottom;

// Scales
const xScale = $derived.by(() => {
	const extent = [
		parsedData[0]?.dateObj ?? new Date(),
		parsedData[parsedData.length - 1]?.dateObj ?? new Date(),
	];
	return scaleTime().domain(extent).range([0, innerWidth]);
});

const yScale = $derived.by(() => {
	return scaleLinear().domain([0, 1]).range([innerHeight, 0]);
});

// Format percentage
const formatPercentage = (value: number): string => {
	return `${(value * 100).toFixed(1)}%`;
};

// Format percentage for axis (no decimal)
const formatPercentageAxis = (value: number): string => {
	return `${(value * 100).toFixed(0)}%`;
};

const pathData = $derived.by(() => {
	return parsedData
		.map((d, i) => {
			const x = padding.left + xScale(d.dateObj);
			const y = padding.top + yScale(d.cache_hit_rate);
			return `${i === 0 ? "M" : "L"}${x},${y}`;
		})
		.join(" ");
});

const areaData = $derived.by(() => {
	if (parsedData.length === 0) return "";

	let path = pathData;
	const lastData = parsedData[parsedData.length - 1];
	if (lastData) {
		const lastX = padding.left + xScale(lastData.dateObj);
		path += ` L${lastX},${padding.top + innerHeight}`;
	}
	const firstData = parsedData[0];
	if (firstData) {
		const firstX = padding.left + xScale(firstData.dateObj);
		path += ` L${firstX},${padding.top + innerHeight} Z`;
	}
	return path;
});

const yTicks = [0, 0.25, 0.5, 0.75, 1];

const xTicks = $derived.by(() => {
	if (parsedData.length <= 6) {
		return parsedData;
	}
	const step = Math.ceil(parsedData.length / 6);
	return parsedData.filter((_, i) => i % step === 0);
});

// A timeline of all-zero hit rates is still data — an operator whose caching
// just broke needs to SEE the flat 0% line, not a "No cache data" placeholder.
// Only an empty timeline is genuinely no data.
const hasData = $derived(parsedData.length > 0);

function showTooltip(event: MouseEvent, d: { bucket: BucketPoint; cache_hit_rate: number }): void {
	if (!containerEl) return;
	const rect = containerEl.getBoundingClientRect();
	tooltipX = event.clientX - rect.left;
	tooltipY = event.clientY - rect.top;
	tooltipLines = [
		formatBucketTooltipLabel(d.bucket),
		`Cache hit: ${formatPercentage(d.cache_hit_rate)}`,
	];
	tooltipVisible = true;
}

function hideTooltip(): void {
	tooltipVisible = false;
}
</script>

<div
	class="cache-hit-timeline"
	bind:this={containerEl}
	use:observeWidth={(w) => {
		measuredWidth = w - 32; /* subtract horizontal padding */
	}}
>
	<svg
		{width}
		{height}
		viewBox="0 0 {width} {height}"
		class="chart-svg"
		preserveAspectRatio="xMinYMin meet"
	>
		<!-- Y-axis gridlines and labels -->
		{#each yTicks as tick}
			<line
				x1={padding.left}
				y1={padding.top + yScale(tick)}
				x2={width - padding.right}
				y2={padding.top + yScale(tick)}
				class="gridline"
				stroke="var(--rule-faint)"
				stroke-width="0.5"
				stroke-dasharray="2,2"
			/>
			<text
				x={padding.left - 8}
				y={padding.top + yScale(tick)}
				text-anchor="end"
				dominant-baseline="middle"
				class="y-label"
			>
				{formatPercentageAxis(tick)}
			</text>
		{/each}

		{#if hasData}
			<path d={areaData} fill="var(--line-5)" opacity="0.15" />

			<path
				d={pathData}
				fill="none"
				stroke="var(--line-5)"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>

			{#each parsedData as d}
				<circle
					cx={padding.left + xScale(d.dateObj)}
					cy={padding.top + yScale(d.cache_hit_rate)}
					r="2.5"
					fill="var(--line-5)"
					class="data-point"
					role="img"
					aria-label="Cache hit rate data point"
					onmouseenter={(e) => showTooltip(e, d)}
					onmousemove={(e) => showTooltip(e, d)}
					onmouseleave={hideTooltip}
				/>
			{/each}

			{#each xTicks as d}
				<text
					x={padding.left + xScale(d.dateObj)}
					y={height - padding.bottom + 16}
					text-anchor="middle"
					class="x-label"
				>
					{formatBucketAxisLabel(d.bucket)}
				</text>
			{/each}
		{:else}
			<line
				x1={padding.left}
				y1={padding.top + innerHeight}
				x2={width - padding.right}
				y2={padding.top + innerHeight}
				stroke="var(--line-5)"
				stroke-width="1"
				stroke-dasharray="4,4"
				opacity="0.5"
			/>
			<text x={width / 2} y={height / 2} text-anchor="middle" class="no-data-label">
				No cache data
			</text>
		{/if}

		<!-- Axes -->
		<line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} stroke="var(--ink)" stroke-width="1" />
		<line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} stroke="var(--ink)" stroke-width="1" />
	</svg>

	<ChartTooltip visible={tooltipVisible} x={tooltipX} y={tooltipY} lines={tooltipLines} />
</div>

<style>
	.cache-hit-timeline {
		position: relative;
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

	.gridline {
		pointer-events: none;
	}

	.y-label,
	.x-label {
		font-size: 11px;
		fill: var(--ink-3);
		font-family: inherit;
	}

	.data-point {
		cursor: pointer;
		transition: r 0.15s ease;
	}

	.data-point:hover {
		r: 4.5;
	}

	.no-data-label {
		font-size: 14px;
		fill: var(--ink-3);
		font-family: inherit;
	}
</style>
