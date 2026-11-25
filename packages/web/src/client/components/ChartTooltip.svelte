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

	// Clamp inside the positioned container so right-edge and top-edge hovers
	// never clip; flip to the cursor's left when there is no room on the right.
	const pos = $derived.by(() => {
		const box = el?.offsetParent as HTMLElement | null | undefined;
		const maxW =
			box?.clientWidth ??
			(typeof window !== "undefined" ? window.innerWidth : Number.POSITIVE_INFINITY);
		let left = x + offsetX;
		if (left + width > maxW - 4) left = Math.max(4, x - offsetX - width);
		// translateY(-100%) lifts the box by its height; keep its top >= 4.
		const top = Math.max(y + offsetY, height + 4);
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
