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
	title: string;
	color: string;
	yMin?: number;
	yMax?: number;
	formatValue: (v: number) => string;
	formatAxis?: (v: number) => string;
	data: Array<{ date: string; value: number }>;
}

let { title, color, yMin = 0, yMax, formatValue, formatAxis, data }: Props = $props();

let tooltipVisible = $state(false);
let tooltipX = $state(0);
let tooltipY = $state(0);
let tooltipLines = $state<string[]>([]);
let containerEl: HTMLDivElement | undefined = $state(undefined);

let measuredWidth = $state(360);

const parsedData = $derived.by(() => {
	return data
		.map((d) => {
			const bucket = parseBucket(d.date);
			return { value: d.value, bucket, dateObj: bucket.dateObj };
		})
		.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
});

const hasData = $derived(parsedData.length > 0);

const width = $derived(Math.max(measuredWidth, 200));
const height = 120;
const padding = { top: 10, right: 8, bottom: 22, left: 44 };
const innerWidth = $derived(width - padding.left - padding.right);
const innerHeight = height - padding.top - padding.bottom;

const xScale = $derived.by(() => {
	if (!hasData) return scaleTime().domain([new Date(), new Date()]).range([0, innerWidth]);
	const t0 = parsedData[0]?.dateObj ?? new Date();
	const tN = parsedData[parsedData.length - 1]?.dateObj ?? new Date();
	return scaleTime().domain([t0, tN]).range([0, innerWidth]);
});

const computedMax = $derived.by(() => {
	if (yMax !== undefined) return yMax;
	const m = Math.max(...parsedData.map((d) => d.value), 0);
	return m === 0 ? 1 : m;
});

const yScale = $derived.by(() => {
	return scaleLinear().domain([yMin, computedMax]).range([innerHeight, 0]).nice();
});

const yTicks = $derived.by(() => {
	const [lo, hi] = yScale.domain();
	return [lo, lo + (hi - lo) / 2, hi];
});

const formatTickLabel = (v: number): string => (formatAxis ?? formatValue)(v);

const pathData = $derived.by(() => {
	return parsedData
		.map((p, i) => {
			const x = padding.left + xScale(p.dateObj);
			const y = padding.top + yScale(p.value);
			return `${i === 0 ? "M" : "L"}${x},${y}`;
		})
		.join(" ");
});

const areaData = $derived.by(() => {
	if (!hasData) return "";
	let path = pathData;
	const last = parsedData[parsedData.length - 1];
	const first = parsedData[0];
	if (last) {
		path += ` L${padding.left + xScale(last.dateObj)},${padding.top + innerHeight}`;
	}
	if (first) {
		path += ` L${padding.left + xScale(first.dateObj)},${padding.top + innerHeight} Z`;
	}
	return path;
});

const xTicks = $derived.by(() => {
	if (parsedData.length <= 4) return parsedData;
	const step = Math.ceil(parsedData.length / 4);
	return parsedData.filter((_, i) => i % step === 0);
});

function showTooltip(event: MouseEvent, p: { bucket: BucketPoint; value: number }): void {
	if (!containerEl) return;
	const rect = containerEl.getBoundingClientRect();
	tooltipX = event.clientX - rect.left;
	tooltipY = event.clientY - rect.top;
	tooltipLines = [formatBucketTooltipLabel(p.bucket), `${title}: ${formatValue(p.value)}`];
	tooltipVisible = true;
}

function hideTooltip(): void {
	tooltipVisible = false;
}
</script>

<div
	class="mini-chart"
	bind:this={containerEl}
	use:observeWidth={(w) => {
		measuredWidth = w - 16;
	}}
>
	<div class="title">{title}</div>
	<svg
		{width}
		{height}
		viewBox="0 0 {width} {height}"
		class="chart-svg"
		preserveAspectRatio="xMinYMin meet"
	>
		{#each yTicks as tick}
			<line
				x1={padding.left}
				y1={padding.top + yScale(tick)}
				x2={width - padding.right}
				y2={padding.top + yScale(tick)}
				stroke="var(--rule-faint)"
				stroke-width="0.5"
				stroke-dasharray="2,2"
			/>
			<text
				x={padding.left - 6}
				y={padding.top + yScale(tick)}
				text-anchor="end"
				dominant-baseline="middle"
				class="axis-label"
			>
				{formatTickLabel(tick)}
			</text>
		{/each}

		{#if hasData}
			<path d={areaData} fill={color} opacity="0.15" />
			<path
				d={pathData}
				fill="none"
				stroke={color}
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>

			{#each parsedData as p}
				<circle
					cx={padding.left + xScale(p.dateObj)}
					cy={padding.top + yScale(p.value)}
					r="2"
					fill={color}
					class="data-point"
					role="img"
					aria-label="Metric data point"
					onmouseenter={(e) => showTooltip(e, p)}
					onmousemove={(e) => showTooltip(e, p)}
					onmouseleave={hideTooltip}
				/>
			{/each}

			{#each xTicks as p}
				<text
					x={padding.left + xScale(p.dateObj)}
					y={height - padding.bottom + 14}
					text-anchor="middle"
					class="axis-label"
				>
					{formatBucketAxisLabel(p.bucket)}
				</text>
			{/each}
		{:else}
			<text x={width / 2} y={height / 2} text-anchor="middle" class="no-data-label">
				No data
			</text>
		{/if}

		<line
			x1={padding.left}
			y1={padding.top}
			x2={padding.left}
			y2={height - padding.bottom}
			stroke="var(--ink)"
			stroke-width="1"
		/>
		<line
			x1={padding.left}
			y1={height - padding.bottom}
			x2={width - padding.right}
			y2={height - padding.bottom}
			stroke="var(--ink)"
			stroke-width="1"
		/>
	</svg>

	<ChartTooltip visible={tooltipVisible} x={tooltipX} y={tooltipY} lines={tooltipLines} />
</div>

<style>
	.mini-chart {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px;
	}

	.title {
		font-size: 11px;
		color: var(--ink-3);
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.chart-svg {
		display: block;
		max-width: 100%;
	}

	.axis-label {
		font-size: 10px;
		fill: var(--ink-3);
		font-family: inherit;
	}

	.no-data-label {
		font-size: 12px;
		fill: var(--ink-3);
		font-family: inherit;
	}

	.data-point {
		cursor: pointer;
		transition: r 0.15s ease;
	}

	.data-point:hover {
		r: 3.5;
	}
</style>
