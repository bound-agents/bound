<script lang="ts">
import { scaleLinear, scaleTime } from "d3-scale";
import {
	type BucketPoint,
	formatBucketAxisLabel,
	formatBucketTooltipLabel,
	parseBucket,
} from "../lib/chart-time";
import { observeWidth } from "../lib/responsive-svg";
import ChartTooltip from "./ChartTooltip.svelte";

interface Props {
	data: Array<{
		date: string;
		model_id: string;
		cost_usd: number;
		cost_input_usd: number;
		cost_output_usd: number;
		cost_cache_read_usd: number;
		cost_cache_write_usd: number;
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

// Track rendered width — keeps text at literal pixel sizes.
let measuredWidth = $state(600);

// Tokyo Metro line colors — picked to be high-contrast against the paper
// background. Maps assign a stable color per model; the order is fixed so
// a model gets the same color across re-renders.
const MODEL_PALETTE: string[] = [
	"var(--line-3)", // blue
	"var(--line-0)", // amber
	"var(--line-4)", // green
	"var(--line-9)", // ruby
	"var(--line-6)", // violet
	"var(--line-7)", // teal
	"var(--line-1)", // red
	"var(--line-5)", // gold
	"var(--line-8)", // brown
	"var(--line-2)", // silver
];

// Group rows by model_id, parse dates, sort each series by time.
interface SeriesPoint {
	bucket: BucketPoint;
	dateObj: Date;
	cost_usd: number;
	cost_input_usd: number;
	cost_output_usd: number;
	cost_cache_read_usd: number;
	cost_cache_write_usd: number;
	tokens_in: number;
	tokens_out: number;
	cache_read: number;
	cache_write: number;
}

interface ModelSeries {
	model_id: string;
	color: string;
	points: Array<SeriesPoint>;
}

const seriesList = $derived.by<ModelSeries[]>(() => {
	const byModel = new Map<string, Array<SeriesPoint>>();
	for (const row of data) {
		const existing = byModel.get(row.model_id) ?? [];
		const bucket = parseBucket(row.date);
		existing.push({
			bucket,
			dateObj: bucket.dateObj,
			cost_usd: row.cost_usd,
			cost_input_usd: row.cost_input_usd,
			cost_output_usd: row.cost_output_usd,
			cost_cache_read_usd: row.cost_cache_read_usd,
			cost_cache_write_usd: row.cost_cache_write_usd,
			tokens_in: row.tokens_in,
			tokens_out: row.tokens_out,
			cache_read: row.cache_read,
			cache_write: row.cache_write,
		});
		byModel.set(row.model_id, existing);
	}
	// Stable color assignment: sort model ids alphabetically so the palette
	// index does not depend on Map insertion order.
	const ids = [...byModel.keys()].sort();
	return ids.map((id, idx) => {
		const points = (byModel.get(id) ?? []).sort(
			(a, b) => a.dateObj.getTime() - b.dateObj.getTime(),
		);
		return {
			model_id: id,
			color: MODEL_PALETTE[idx % MODEL_PALETTE.length] as string,
			points,
		};
	});
});

const allPoints = $derived(seriesList.flatMap((s) => s.points));
const hasData = $derived(allPoints.length > 0);

// Dimensions
const width = $derived(Math.max(measuredWidth, 320));
const height = 220;
const padding = { top: 16, right: 16, bottom: 32, left: 64 };
const innerWidth = $derived(width - padding.left - padding.right);
const innerHeight = height - padding.top - padding.bottom;

// Scales — domain spans every model's points so all lines share the axis.
const xScale = $derived.by(() => {
	if (!hasData) return scaleTime().domain([new Date(), new Date()]).range([0, innerWidth]);
	const times = allPoints.map((p) => p.dateObj.getTime());
	const min = Math.min(...times);
	const max = Math.max(...times);
	return scaleTime()
		.domain([new Date(min), new Date(max)])
		.range([0, innerWidth]);
});

const yScale = $derived.by(() => {
	const maxCost = Math.max(...allPoints.map((p) => p.cost_usd), 0);
	return scaleLinear().domain([0, maxCost]).range([innerHeight, 0]).nice();
});

const formatUSD = (value: number): string => `$${value.toFixed(4)}`;

function pathDataFor(points: ModelSeries["points"]): string {
	return points
		.map((p, i) => {
			const x = padding.left + xScale(p.dateObj);
			const y = padding.top + yScale(p.cost_usd);
			return `${i === 0 ? "M" : "L"}${x},${y}`;
		})
		.join(" ");
}

const yTicks = $derived.by(() => {
	const ticks: number[] = [];
	const domain = yScale.domain();
	const step = (domain[1] - domain[0]) / 4;
	for (let i = 0; i <= 4; i++) {
		ticks.push(domain[0] + i * step);
	}
	return ticks;
});

// X tick selection — use the union of all unique buckets, evenly sampled.
const xTickDates = $derived.by(() => {
	const seen = new Map<number, BucketPoint>();
	for (const p of allPoints) {
		seen.set(p.dateObj.getTime(), p.bucket);
	}
	const unique = [...seen.values()].sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
	if (unique.length <= 6) return unique;
	const step = Math.ceil(unique.length / 6);
	return unique.filter((_, i) => i % step === 0);
});

// Tooltip shows the headline `Cost` (the persisted, write-time `cost_usd`)
// followed by the four reconstructed components. The components are computed
// from current `model_backends.json` pricing in the metrics route, so they
// will not always sum exactly to `Cost` after a model price change — `Cost`
// remains authoritative. Rows with zero token counts are hidden so the
// tooltip stays compact.
function showTooltip(event: MouseEvent, series: ModelSeries, point: SeriesPoint): void {
	if (!containerEl) return;
	const rect = containerEl.getBoundingClientRect();
	tooltipX = event.clientX - rect.left;
	tooltipY = event.clientY - rect.top;

	const lines: string[] = [
		series.model_id,
		formatBucketTooltipLabel(point.bucket),
		`Cost: ${formatUSD(point.cost_usd)}`,
	];

	if (point.tokens_in > 0) {
		lines.push(
			`  Input:       ${formatUSD(point.cost_input_usd)}  (${point.tokens_in.toLocaleString()} tok)`,
		);
	}
	if (point.tokens_out > 0) {
		lines.push(
			`  Output:      ${formatUSD(point.cost_output_usd)}  (${point.tokens_out.toLocaleString()} tok)`,
		);
	}
	if (point.cache_read > 0) {
		lines.push(
			`  Cache read:  ${formatUSD(point.cost_cache_read_usd)}  (${point.cache_read.toLocaleString()} tok)`,
		);
	}
	if (point.cache_write > 0) {
		lines.push(
			`  Cache write: ${formatUSD(point.cost_cache_write_usd)}  (${point.cache_write.toLocaleString()} tok)`,
		);
	}

	tooltipLines = lines;
	tooltipVisible = true;
}

function hideTooltip(): void {
	tooltipVisible = false;
}
</script>

<div
	class="cost-timeline"
	bind:this={containerEl}
	use:observeWidth={(w) => {
		measuredWidth = w - 32;
	}}
>
	<svg
		{width}
		{height}
		viewBox="0 0 {width} {height}"
		class="chart-svg"
		preserveAspectRatio="xMinYMin meet"
	>
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

		{#if hasData}
			{#each seriesList as series}
				<!-- Line per model -->
				<path
					d={pathDataFor(series.points)}
					fill="none"
					stroke={series.color}
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>

				<!-- Hit-area circles per model -->
				{#each series.points as point}
					<circle
						cx={padding.left + xScale(point.dateObj)}
						cy={padding.top + yScale(point.cost_usd)}
						r="2.5"
						fill={series.color}
						class="data-point"
						onmouseenter={(e) => showTooltip(e, series, point)}
						onmousemove={(e) => showTooltip(e, series, point)}
						onmouseleave={hideTooltip}
					/>
				{/each}
			{/each}

			<!-- X-axis labels (one set, drawn from union of dates) -->
			{#each xTickDates as b}
				<text
					x={padding.left + xScale(b.dateObj)}
					y={height - padding.bottom + 16}
					text-anchor="middle"
					class="x-label"
				>
					{formatBucketAxisLabel(b)}
				</text>
			{/each}
		{:else}
			<text x={width / 2} y={height / 2} text-anchor="middle" class="no-data-label">
				No cost data
			</text>
		{/if}

		<!-- Axes -->
		<line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} stroke="var(--ink)" stroke-width="1" />
		<line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} stroke="var(--ink)" stroke-width="1" />
	</svg>

	<!-- Per-model legend -->
	{#if seriesList.length > 0}
		<div class="legend">
			{#each seriesList as series}
				<div class="legend-item">
					<div class="legend-color" style="background-color: {series.color}"></div>
					<span class="legend-label">{series.model_id}</span>
				</div>
			{/each}
		</div>
	{/if}

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
		display: block;
		max-width: 100%;
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

	.no-data-label {
		font-size: 14px;
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

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 12px 20px;
		margin-top: 12px;
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

	.legend-label {
		color: var(--ink);
	}
</style>
