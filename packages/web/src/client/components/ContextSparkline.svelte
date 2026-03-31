<script lang="ts">
interface Props {
	turns: Array<{ context_debug: { totalEstimated: number; contextWindow: number } }>;
	selectedIdx: number;
	onSelectTurn?: (idx: number) => void;
}

const { turns, selectedIdx, onSelectTurn } = $props<Props>();

const WIDTH = 288;  // 320px panel - 32px padding
const HEIGHT = 48;

const points = $derived.by(() => {
	if (turns.length === 0) return [];
	const maxTokens = Math.max(...turns.map((t) => t.context_debug.contextWindow));
	return turns.map((turn, i) => ({
		x: turns.length === 1 ? WIDTH / 2 : (i / (turns.length - 1)) * WIDTH,
		y: HEIGHT - (turn.context_debug.totalEstimated / maxTokens) * (HEIGHT - 4),
	}));
});

const pathD = $derived.by(() => {
	if (points.length === 0) return "";
	const line = points
		.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
		.join(" ");
	return `${line} L ${points[points.length - 1].x} ${HEIGHT} L ${points[0].x} ${HEIGHT} Z`;
});

const selectedPoint = $derived.by(() => {
	const idx = selectedIdx >= 0 ? selectedIdx : points.length - 1;
	return points[idx] ?? null;
});
</script>

<div class="sparkline-container">
	<svg
		viewBox="0 0 {WIDTH} {HEIGHT}"
		width="100%"
		height={HEIGHT}
		preserveAspectRatio="none"
	>
		<!-- Area fill -->
		{#if pathD}
			<path d={pathD} fill="var(--line-7)" opacity="0.15" />
		{/if}

		<!-- Line -->
		{#if points.length > 1}
			<polyline
				points={points.map((p) => `${p.x},${p.y}`).join(" ")}
				fill="none"
				stroke="var(--line-7)"
				stroke-width="1.5"
			/>
		{/if}

		<!-- Clickable hit areas for each turn -->
		{#each points as point, idx}
			<rect
				x={point.x - 8}
				y={0}
				width={16}
				height={HEIGHT}
				fill="transparent"
				style="cursor: pointer;"
				role="button"
				tabindex="0"
				onclick={() => onSelectTurn?.(idx)}
				onkeydown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onSelectTurn?.(idx);
					}
				}}
				aria-label="Turn {idx + 1}"
			/>
		{/each}

		<!-- Selected turn highlight -->
		{#if selectedPoint}
			<circle
				cx={selectedPoint.x}
				cy={selectedPoint.y}
				r="3"
				fill="var(--line-7)"
				stroke="var(--bg-primary)"
				stroke-width="1.5"
			/>
		{/if}
	</svg>
</div>

<style>
	.sparkline-container {
		margin-bottom: 16px;
		padding: 4px 0;
	}

	svg {
		display: block;
	}
</style>
