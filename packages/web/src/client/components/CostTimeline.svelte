<script lang="ts">
import { scaleLinear, scaleTime } from "d3-scale";
import ChartTooltip from "./ChartTooltip.svelte";

interface Props {
	data: Array<{
		date: string;
		cost_usd: number;
	}>;
}

let { data }: Props = $props();

// Tooltip state
let tooltipVisible = $state(false);
let tooltipX = $state(0);
let tooltipY = $state(0);
let tooltipLines = $state<string[]>([]);
let containerEl: HTMLDivElement | undefined = $state(undefined);

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
const height = 200;
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
	const maxCost = Math.max(...parsedData.map((d) => d.cost_usd), 0);
	return scaleLinear().domain([0, maxCost]).range([innerHeight, 0]).nice();
});

// Format USD currency
const formatUSD = (value: number): string => {
	return `$${value.toFixed(4)}`;
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

// Format date for tooltip (more detailed)
const formatDateFull = (date: Date): string => {
	const month = (date.getMonth() + 1).toString().padStart(2, "0");
	const day = date.getDate().toString().padStart(2, "0");
	const hour = date.getHours().toString().padStart(2, "0");
	const minute = date.getMinutes().toString().padStart(2, "0");
	if (hour === "00" && minute === "00") {
		return `${date.getFullYear()}-${month}-${day}`;
	}
	return `${date.getFullYear()}-${month}-${day} ${hour}:${minute}`;
};

// Generate path data for the line and area
const pathData = $derived.by(() => {
	return parsedData
		.map((d, i) => {
			const x = padding.left + xScale(d.dateObj);
			const y = padding.top + yScale(d.cost_usd);
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

// Generate Y axis tick labels
const yTicks = $derived.by(() => {
	const ticks: number[] = [];
	const domain = yScale.domain();
	const step = (domain[1] - domain[0]) / 4; // 5 ticks total
	for (let i = 0; i <= 4; i++) {
		ticks.push(domain[0] + i * step);
	}
	return ticks;
});

// Generate X axis tick labels (sample every nth point to avoid crowding)
const xTicks = $derived.by(() => {
	if (parsedData.length <= 6) {
		return parsedData;
	}
	const step = Math.ceil(parsedData.length / 6);
	return parsedData.filter((_, i) => i % step === 0);
});

function showTooltip(event: MouseEvent, d: { dateObj: Date; cost_usd: number }): void {
	if (!containerEl) return;
	const rect = containerEl.getBoundingClientRect();
	tooltipX = event.clientX - rect.left;
	tooltipY = event.clientY - rect.top;
	tooltipLines = [formatDateFull(d.dateObj), `Cost: ${formatUSD(d.cost_usd)}`];
	tooltipVisible = true;
}

function hideTooltip(): void {
	tooltipVisible = false;
}
</script>

<div class="cost-timeline" bind:this={containerEl}>
	<svg {width} {height} viewBox="0 0 {width} {height}" class="chart-svg">
		<!-- Y-axis gridlines and labels -->
		{#each yTicks as tick}
			<line
				x1={padding.left}
				y1={padding.top + yScale(tick)}
				x2={width - padding.right}
				y2={padding.top + yScale(tick)}
				class="gridline"
				stroke="var(--rule-soft)"
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
				{formatUSD(tick)}
			</text>
		{/each}

		<!-- Area fill -->
		{#if parsedData.length > 0}
			<path d={areaData} fill="var(--line-0)" opacity="0.2" />

			<!-- Line on top -->
			<path
				d={pathData}
				fill="none"
				stroke="var(--line-0)"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>

			<!-- Interactive hit-area circles -->
			{#each parsedData as d}
				<circle
					cx={padding.left + xScale(d.dateObj)}
					cy={padding.top + yScale(d.cost_usd)}
					r="2.5"
					fill="var(--line-0)"
					class="data-point"
					onmouseenter={(e) => showTooltip(e, d)}
					onmousemove={(e) => showTooltip(e, d)}
					onmouseleave={hideTooltip}
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
		{/if}

		<!-- Axes -->
		<line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} stroke="var(--ink)" stroke-width="1" />
		<line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} stroke="var(--ink)" stroke-width="1" />
	</svg>

	<ChartTooltip visible={tooltipVisible} x={tooltipX} y={tooltipY} lines={tooltipLines} />
</div>

<style>
	.cost-timeline {
		position: relative;
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
		r: 4.5;
	}
</style>
