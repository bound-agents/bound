<script lang="ts">
interface Props {
	turnCount: number;
	lineColor: string;
	isActive: boolean;
	turnBoundaryOffsets?: number[];
}

let { turnCount, lineColor, isActive, turnBoundaryOffsets = [] }: Props = $props();
</script>

<div class="turn-indicator">
	<!-- Vertical line -->
	<div
		class="indicator-line"
		style="border-left-color: {lineColor};"
	/>

	<!-- Station dots -->
	{#each turnBoundaryOffsets as offset, idx}
		<div
			class="station-dot"
			class:latest={idx === turnBoundaryOffsets.length - 1}
			style="
				top: {offset}px;
				background: {lineColor};
				border-color: var(--bg-secondary);
			"
		/>
	{/each}

	<!-- Active thinking line (extends below last dot) -->
	{#if isActive && turnBoundaryOffsets.length > 0}
		<div
			class="active-thinking"
			style="
				top: {turnBoundaryOffsets[turnBoundaryOffsets.length - 1]}px;
				border-left-color: {lineColor};
			"
		/>
	{/if}
</div>

<style>
	.turn-indicator {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 24px;
	}

	.indicator-line {
		position: absolute;
		left: 11px;
		top: 0;
		bottom: 0;
		width: 2px;
		border-left: 2px solid;
		opacity: 0.4;
	}

	.station-dot {
		position: absolute;
		left: 9px;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		border: 2px solid;
		transform: translate(-50%, -50%);
	}

	.station-dot.latest {
		animation: badge-pulse 2s ease-in-out infinite;
	}

	.active-thinking {
		position: absolute;
		left: 11px;
		width: 2px;
		height: 60px;
		border-left: 2px dashed;
		opacity: 0.3;
		animation: extend-line 1s ease-in-out infinite;
	}

	@keyframes badge-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.6;
		}
	}

	@keyframes extend-line {
		0%,
		100% {
			height: 40px;
		}
		50% {
			height: 80px;
		}
	}
</style>
