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

	let el: HTMLDivElement | undefined = $state(undefined);
	let width = $state(0);
	let height = $state(0);

	// Viewport-anchored (position: fixed) and clamped on every side, so right-,
	// top-, and bottom-edge hovers and narrow phone screens never clip. `x`/`y`
	// are relative to the chart container, which is the tooltip's parent.
	const pos = $derived.by(() => {
		const parent = el?.parentElement?.getBoundingClientRect();
		const vw = typeof window !== "undefined" ? window.innerWidth : Number.POSITIVE_INFINITY;
		const vh = typeof window !== "undefined" ? window.innerHeight : Number.POSITIVE_INFINITY;
		const cx = x + (parent?.left ?? 0);
		const cy = y + (parent?.top ?? 0);
		let left = cx + offsetX;
		if (left + width > vw - 4) left = Math.max(4, cx - offsetX - width);
		left = Math.max(4, Math.min(left, vw - width - 4));
		// Prefer above the cursor; drop below when there's no room on top.
		let top = cy + offsetY - height;
		if (top < 4) top = cy + 16;
		top = Math.max(4, Math.min(top, vh - height - 4));
		return { left, top };
	});
</script>

{#if visible && lines.length > 0}
	<div
		class="chart-tooltip"
		bind:this={el}
		bind:offsetWidth={width}
		bind:offsetHeight={height}
		style="left: {pos.left}px; top: {pos.top}px;"
	>
		{#each lines as line}
			<span class="tooltip-line">{line}</span>
		{/each}
	</div>
{/if}

<style>
	.chart-tooltip {
		position: fixed;
		max-width: calc(100vw - 8px);
		pointer-events: none;
		z-index: 100;
		background: var(--bg-secondary);
		border: 1px solid var(--rule-soft);
		border-radius: 4px;
		padding: 6px 10px;
		font-size: 12px;
		color: var(--ink);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
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
