<script lang="ts">
import { scaleLinear, scaleTime } from "d3-scale";

interface Props {
	data: Array<{
		date: string;
		cache_hit_rate: number;
	}>;
}

let { data }: Props = $props();

// Parse dates and sort by time
const parsedData = $derived.by(() => {
	return data
		.map((d) => ({
			...d,
			dateObj: new Date(d.date),
		}))
		.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
});

// Dimensions
const width = 600;
const height = 180;
const padding = { top: 16, right: 16, bottom: 32, left: 48 };
const innerWidth = width - padding.left - padding.right;
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
	return `${(value * 100).toFixed(0)}%`;
};

// Format date/time for labels (depends on data granularity)
const formatDate = (date: Date): string => {
	const hour = date.getHours().toString().padStart(2, "0");
	const month = (date.getMonth() + 1).toString().padStart(2, "0");
	const day = date.getDate();
	// If hour is 00, this is daily data; otherwise hourly
	if (hour === "00") {
		return `${month}/${day}`;
	}
	return `${hour}:00`;
};

// Generate path data for the line
const pathData = $derived.by(() => {
	return parsedData
		.map((d, i) => {
			const x = padding.left + xScale(d.dateObj);
			const y = padding.top + yScale(d.cache_hit_rate);
			return `${i === 0 ? "M" : "L"}${x},${y}`;
		})
		.join(" ");
});

// Generate area path (includes closing to baseline)
const areaData = $derived.by(() => {
	if (parsedData.length === 0) return "";

	let path = pathData;
	// Close the path: draw down to baseline at the last x position
	const lastData = parsedData[parsedData.length - 1];
	if (lastData) {
		const lastX = padding.left + xScale(lastData.dateObj);
		path += ` L${lastX},${padding.top + innerHeight}`;
	}
	// Draw back to start baseline
	const firstData = parsedData[0];
	if (firstData) {
		const firstX = padding.left + xScale(firstData.dateObj);
		path += ` L${firstX},${padding.top + innerHeight} Z`;
	}
	return path;
});

// Generate Y axis tick labels (0%, 25%, 50%, 75%, 100%)
const yTicks = [0, 0.25, 0.5, 0.75, 1];

// Generate X axis tick labels (sample every nth point to avoid crowding)
const xTicks = $derived.by(() => {
	if (parsedData.length <= 6) {
		return parsedData;
	}
	const step = Math.ceil(parsedData.length / 6);
	return parsedData.filter((_, i) => i % step === 0);
});

// Check if we should show "No cache data" message
const hasData = $derived(parsedData.length > 0 && parsedData.some((d) => d.cache_hit_rate > 0));
</script>

<div class="cache-hit-timeline">
	<svg {width} {height} viewBox="0 0 {width} {height}" class="chart-svg">
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
				{formatPercentage(tick)}
			</text>
		{/each}

		<!-- Area fill and line -->
		{#if parsedData.length > 0}
			<!-- Area fill -->
			<path d={areaData} fill="var(--line-5)" opacity="0.15" />

			<!-- Line on top -->
			<path
				d={pathData}
				fill="none"
				stroke="var(--line-5)"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>

			<!-- Data point circles -->
			{#each parsedData as d}
				<circle
					cx={padding.left + xScale(d.dateObj)}
					cy={padding.top + yScale(d.cache_hit_rate)}
					r="2.5"
					fill="var(--line-5)"
					class="data-point"
					title={`${formatDate(d.dateObj)}: ${formatPercentage(d.cache_hit_rate)}`}
				/>
			{/each}

			<!-- X-axis labels -->
			{#each xTicks as d}
				<text
					x={padding.left + xScale(d.dateObj)}
					y={height - padding.bottom + 16}
					text-anchor="middle"
					class="x-label"
				>
					{formatDate(d.dateObj)}
				</text>
			{/each}
		{:else}
			<!-- No data message -->
			<text x={width / 2} y={height / 2} text-anchor="middle" class="no-data-label">
				No cache data
			</text>
		{/if}

		<!-- Axes -->
		<line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} stroke="var(--ink)" stroke-width="1" />
		<line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} stroke="var(--ink)" stroke-width="1" />
	</svg>
</div>

<style>
	.cache-hit-timeline {
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
		r: 3.5;
	}

	.no-data-label {
		font-size: 14px;
		fill: var(--ink-3);
		font-family: inherit;
	}
</style>
