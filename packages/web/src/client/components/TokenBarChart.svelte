<script lang="ts">
import { scaleLinear } from "d3-scale";
import { observeWidth } from "../lib/responsive-svg";
import ChartTooltip from "./ChartTooltip.svelte";

interface Props {
	data: Array<{
		model_id: string;
		tokens_in: number;
		tokens_out: number;
		cache_read: number;
		cache_write: number;
	}>;
}

let { data }: Props = $props();

// Tooltip state
let tooltipVisible = $state(false);
let tooltipX = $state(0);
let tooltipY = $state(0);
let tooltipLines = $state<string[]>([]);
let containerEl: HTMLDivElement | undefined = $state(undefined);

// Track the chart's rendered width so we can size the SVG 1:1 with pixels.
// Without this, width="100%" on a fixed viewBox stretches the entire SVG
// (text included) — model labels balloon on wide screens.
let measuredWidth = $state(600);

// Total per row spans all four token classes so cache traffic is visible.
function rowTotal(d: {
	tokens_in: number;
	tokens_out: number;
	cache_read: number;
	cache_write: number;
}): number {
	return d.tokens_in + d.tokens_out + d.cache_read + d.cache_write;
}

// Filter out models with zero total tokens (AC2.5)
const filteredData = $derived.by(() => {
	return data.filter((d) => rowTotal(d) > 0);
});

// Sort defensively by total tokens descending
const sortedData = $derived.by(() => {
	return [...filteredData].sort((a, b) => rowTotal(b) - rowTotal(a));
});

// Calculate dimensions — viewBox tracks the actual rendered pixel width,
// so absolute font-sizes in CSS render at their true sizes.
const rowHeight = 32;
const padding = { top: 12, right: 16, bottom: 12, left: 140 };
const contentWidth = $derived(Math.max(measuredWidth, 320));
const containerHeight = $derived(sortedData.length * rowHeight + padding.top + padding.bottom);

// Compute max total tokens for x scale domain
const maxTokens = $derived.by(() => {
	return Math.max(...sortedData.map(rowTotal), 1);
});

// Create x scale
const xScale = $derived.by(() => {
	return scaleLinear()
		.domain([0, maxTokens])
		.range([0, contentWidth - padding.left - padding.right]);
});

// Tooltip lists every token class regardless of which segment is hovered, so
// the operator always sees the full breakdown — picking which class drove the
// row matters less than seeing all four side-by-side.
function showTooltip(
	event: MouseEvent,
	d: {
		model_id: string;
		tokens_in: number;
		tokens_out: number;
		cache_read: number;
		cache_write: number;
	},
): void {
	if (!containerEl) return;
	const rect = containerEl.getBoundingClientRect();
	tooltipX = event.clientX - rect.left;
	tooltipY = event.clientY - rect.top;
	const total = rowTotal(d);
	tooltipLines = [
		d.model_id,
		`Input:       ${d.tokens_in.toLocaleString()}`,
		`Output:      ${d.tokens_out.toLocaleString()}`,
		`Cache read:  ${d.cache_read.toLocaleString()}`,
		`Cache write: ${d.cache_write.toLocaleString()}`,
		`Total:       ${total.toLocaleString()}`,
	];
	tooltipVisible = true;
}

function hideTooltip(): void {
	tooltipVisible = false;
}
</script>

<div
	class="token-bar-chart"
	bind:this={containerEl}
	use:observeWidth={(w) => {
		measuredWidth = w;
	}}
>
	<svg
		width={contentWidth}
		height={containerHeight}
		viewBox="0 0 {contentWidth} {containerHeight}"
		class="chart-svg"
		preserveAspectRatio="xMinYMin meet"
	>
		<!-- Model labels + 4-segment stacked bars -->
		{#each sortedData as d, i}
			<text
				x={padding.left - 8}
				y={padding.top + i * rowHeight + rowHeight / 2}
				class="model-label"
				text-anchor="end"
				dominant-baseline="middle"
			>
				{d.model_id}
			</text>

			<!-- Input - blue -->
			<rect
				x={padding.left}
				y={padding.top + i * rowHeight + 4}
				width={xScale(d.tokens_in)}
				height={rowHeight - 8}
				fill="var(--line-3)"
				opacity="0.8"
				class="bar"
				role="img"
				aria-label="Input tokens bar"
				onmouseenter={(e) => showTooltip(e, d)}
				onmousemove={(e) => showTooltip(e, d)}
				onmouseleave={hideTooltip}
			/>

			<!-- Output - amber -->
			<rect
				x={padding.left + xScale(d.tokens_in)}
				y={padding.top + i * rowHeight + 4}
				width={xScale(d.tokens_out)}
				height={rowHeight - 8}
				fill="var(--line-0)"
				opacity="0.8"
				class="bar"
				role="img"
				aria-label="Output tokens bar"
				onmouseenter={(e) => showTooltip(e, d)}
				onmousemove={(e) => showTooltip(e, d)}
				onmouseleave={hideTooltip}
			/>

			<!-- Cache read - green -->
			<rect
				x={padding.left + xScale(d.tokens_in + d.tokens_out)}
				y={padding.top + i * rowHeight + 4}
				width={xScale(d.cache_read)}
				height={rowHeight - 8}
				fill="var(--line-4)"
				opacity="0.8"
				class="bar"
				role="img"
				aria-label="Cache read tokens bar"
				onmouseenter={(e) => showTooltip(e, d)}
				onmousemove={(e) => showTooltip(e, d)}
				onmouseleave={hideTooltip}
			/>

			<!-- Cache write - violet -->
			<rect
				x={padding.left + xScale(d.tokens_in + d.tokens_out + d.cache_read)}
				y={padding.top + i * rowHeight + 4}
				width={xScale(d.cache_write)}
				height={rowHeight - 8}
				fill="var(--line-6)"
				opacity="0.8"
				class="bar"
				role="img"
				aria-label="Cache write tokens bar"
				onmouseenter={(e) => showTooltip(e, d)}
				onmousemove={(e) => showTooltip(e, d)}
				onmouseleave={hideTooltip}
			/>
		{/each}
	</svg>

	<!-- Color legend -->
	<div class="legend">
		<div class="legend-item">
			<div class="legend-color" style="background-color: var(--line-3)"></div>
			<span>Input</span>
		</div>
		<div class="legend-item">
			<div class="legend-color" style="background-color: var(--line-0)"></div>
			<span>Output</span>
		</div>
		<div class="legend-item">
			<div class="legend-color" style="background-color: var(--line-4)"></div>
			<span>Cache read</span>
		</div>
		<div class="legend-item">
			<div class="legend-color" style="background-color: var(--line-6)"></div>
			<span>Cache write</span>
		</div>
	</div>

	<ChartTooltip visible={tooltipVisible} x={tooltipX} y={tooltipY} lines={tooltipLines} />
</div>

<style>
	.token-bar-chart {
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

	.model-label {
		font-size: 12px;
		fill: var(--ink);
		font-family: inherit;
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
		padding-left: 140px;
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

	@media (max-width: 600px) {
		.legend {
			padding-left: 0;
		}
	}
</style>
