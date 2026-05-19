<script lang="ts">
interface Props {
	visible: boolean;
	x: number;
	y: number;
	lines: string[];
}

let { visible, x, y, lines }: Props = $props();

// Offset the tooltip slightly from cursor to avoid flicker
const offsetX = 12;
const offsetY = -8;
</script>

{#if visible && lines.length > 0}
	<div
		class="chart-tooltip"
		style="left: {x + offsetX}px; top: {y + offsetY}px;"
	>
		{#each lines as line}
			<span class="tooltip-line">{line}</span>
		{/each}
	</div>
{/if}

<style>
	.chart-tooltip {
		position: absolute;
		pointer-events: none;
		z-index: 100;
		background: var(--bg-secondary);
		border: 1px solid var(--rule-soft);
		border-radius: 4px;
		padding: 6px 10px;
		font-size: 12px;
		color: var(--ink);
		white-space: nowrap;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
		transform: translateY(-100%);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.tooltip-line {
		display: block;
		font-family: var(--font-mono, monospace);
		font-size: 11px;
	}
</style>
