<script lang="ts">
import { scaleLinear } from "d3-scale";

interface Props {
	data: Array<{
		model_id: string;
		tokens_in: number;
		tokens_out: number;
	}>;
}

let { data }: Props = $props();

// Filter out models with zero total tokens (AC2.5)
const filteredData = $derived(() => {
	return data.filter((d) => d.tokens_in + d.tokens_out > 0);
})();

// Sort defensively by total tokens descending
const sortedData = $derived(() => {
	return [...filteredData].sort(
		(a, b) => b.tokens_in + b.tokens_out - (a.tokens_in + a.tokens_out),
	);
})();

// Calculate dimensions
const rowHeight = 40;
const padding = { top: 16, right: 16, bottom: 16, left: 120 };
const contentWidth = 600;
const containerHeight = sortedData.length * rowHeight + padding.top + padding.bottom;

// Compute max total tokens for x scale domain
const maxTokens = $derived(() => {
	return Math.max(...sortedData.map((d) => d.tokens_in + d.tokens_out), 1);
})();

// Create x scale
const xScale = $derived.by(() => {
	return scaleLinear()
		.domain([0, maxTokens])
		.range([0, contentWidth - padding.left - padding.right]);
});
</script>

<div class="token-bar-chart">
	<svg
		width={contentWidth}
		height={containerHeight}
		viewBox="0 0 {contentWidth} {containerHeight}"
		class="chart-svg"
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
				y={padding.top + i * rowHeight + 8}
				width={xScale(d.tokens_in)}
				height={rowHeight - 16}
				fill="var(--line-3)"
				opacity="0.8"
				title={`Input: ${d.tokens_in.toLocaleString()}`}
			/>

			<!-- Output tokens (tokens_out) - amber, positioned after input -->
			<rect
				x={padding.left + xScale(d.tokens_in)}
				y={padding.top + i * rowHeight + 8}
				width={xScale(d.tokens_out)}
				height={rowHeight - 16}
				fill="var(--line-0)"
				opacity="0.8"
				title={`Output: ${d.tokens_out.toLocaleString()}`}
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
</div>

<style>
	.token-bar-chart {
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

	.model-label {
		font-size: 12px;
		fill: var(--ink);
		font-family: inherit;
		font-weight: 500;
	}

	rect {
		cursor: pointer;
		transition: opacity 0.15s ease;
	}

	rect:hover {
		opacity: 1 !important;
	}

	.legend {
		display: flex;
		gap: 24px;
		padding-left: 120px;
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
