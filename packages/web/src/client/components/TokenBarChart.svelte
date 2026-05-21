<script lang="ts">
import { scaleLinear } from "d3-scale";
import { observeWidth } from "../lib/responsive-svg";
import ChartTooltip from "./ChartTooltip.svelte";

interface Props {
	data: Array<{
		model_id: string;
		tokens_in: number;
		tokens_out: number;
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

// Filter out models with zero total tokens (AC2.5)
const filteredData = $derived.by(() => {
	return data.filter((d) => d.tokens_in + d.tokens_out > 0);
});

// Sort defensively by total tokens descending
const sortedData = $derived.by(() => {
	return [...filteredData].sort(
		(a, b) => b.tokens_in + b.tokens_out - (a.tokens_in + a.tokens_out),
	);
});

// Calculate dimensions — viewBox tracks the actual rendered pixel width,
// so absolute font-sizes in CSS render at their true sizes.
const rowHeight = 32;
const padding = { top: 12, right: 16, bottom: 12, left: 140 };
const contentWidth = $derived(Math.max(measuredWidth, 320));
const containerHeight = $derived(sortedData.length * rowHeight + padding.top + padding.bottom);

// Compute max total tokens for x scale domain
const maxTokens = $derived.by(() => {
	return Math.max(...sortedData.map((d) => d.tokens_in + d.tokens_out), 1);
});

// Create x scale
const xScale = $derived.by(() => {
	return scaleLinear()
		.domain([0, maxTokens])
		.range([0, contentWidth - padding.left - padding.right]);
});

function showTooltip(
	event: MouseEvent,
	d: { model_id: string; tokens_in: number; tokens_out: number },
	series: "input" | "output",
): void {
	if (!containerEl) return;
	const rect = containerEl.getBoundingClientRect();
	tooltipX = event.clientX - rect.left;
	tooltipY = event.clientY - rect.top;
	const total = d.tokens_in + d.tokens_out;
	tooltipLines = [
		d.model_id,
		series === "input"
			? `Input: ${d.tokens_in.toLocaleString()} tokens`
			: `Output: ${d.tokens_out.toLocaleString()} tokens`,
		`Total: ${total.toLocaleString()} tokens`,
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
		<!-- Model labels on the left -->
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

			<!-- Input tokens (tokens_in) - blue -->
			<rect
				x={padding.left}
				y={padding.top + i * rowHeight + 4}
				width={xScale(d.tokens_in)}
				height={rowHeight - 8}
				fill="var(--line-3)"
				opacity="0.8"
				class="bar"
				onmouseenter={(e) => showTooltip(e, d, "input")}
				onmousemove={(e) => showTooltip(e, d, "input")}
				onmouseleave={hideTooltip}
			/>

			<!-- Output tokens (tokens_out) - amber, positioned after input -->
			<rect
				x={padding.left + xScale(d.tokens_in)}
				y={padding.top + i * rowHeight + 4}
				width={xScale(d.tokens_out)}
				height={rowHeight - 8}
				fill="var(--line-0)"
				opacity="0.8"
				class="bar"
				onmouseenter={(e) => showTooltip(e, d, "output")}
				onmousemove={(e) => showTooltip(e, d, "output")}
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
