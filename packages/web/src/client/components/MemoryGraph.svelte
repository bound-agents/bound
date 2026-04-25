<script lang="ts">
import type { MemoryGraphNode, MemoryGraphResponse, ThreadListEntry } from "@bound/client";
import { onMount } from "svelte";
import { client } from "../lib/bound";
import { getLineCssVar } from "../lib/metro-lines";

interface Props {
	/** When set, dim nodes that don't belong to this thread id. */
	selectedThreadId?: string | null;
	/** When set, show a small "Memories from ..." chip with the thread title. */
	hoveredThreadTitle?: string | null;
	hoveredThreadColor?: number | null;
	/** Threads, used to resolve `source` -> line color for a node. */
	threads?: ThreadListEntry[];
	/** Navigate helper (clicking a source-thread chip). */
	onNavigate?: (route: string) => void;
}

let {
	selectedThreadId,
	hoveredThreadTitle,
	hoveredThreadColor,
	threads = [],
	onNavigate,
}: Props = $props();

type Tier = "pinned" | "summary" | "default" | "detail";

const TIER_ORDER: Tier[] = ["pinned", "summary", "default", "detail"];
const TIER_LABEL: Record<Tier, string> = {
	pinned: "PINNED",
	summary: "SUMMARY",
	default: "DEFAULT",
	detail: "DETAIL",
};
const TIER_RADIUS: Record<Tier, number> = {
	pinned: 9.5,
	summary: 7,
	default: 5.5,
	detail: 4.5,
};
const TIER_STROKE: Record<Tier, { color: string; width: number }> = {
	pinned: { color: "var(--accent)", width: 1.6 },
	summary: { color: "var(--ink)", width: 1.2 },
	default: { color: "var(--paper-2)", width: 0.6 },
	detail: { color: "var(--rule-soft)", width: 0.4 },
};
const TIER_TEXT: Record<Tier, string> = {
	pinned: "var(--accent)",
	summary: "var(--ink)",
	default: "var(--ink-2)",
	detail: "var(--ink-4)",
};

// Layout constants — mirrors web/src/client/lib/graph-layout.ts for arc geometry.
const VB_W = 1100;
const VB_H = 640;
const CX = VB_W / 2;
const TIER_Y: Record<Tier, number> = {
	pinned: VB_H * 0.16,
	summary: VB_H * 0.39,
	default: VB_H * 0.62,
	detail: VB_H * 0.84,
};
const TIER_SPAN: Record<Tier, number> = {
	pinned: Math.PI * 0.3,
	summary: Math.PI * 0.46,
	default: Math.PI * 0.62,
	detail: Math.PI * 0.72,
};
const TIER_RAD: Record<Tier, number> = {
	pinned: 230,
	summary: 330,
	default: 430,
	detail: 510,
};

interface PlacedNode extends MemoryGraphNode {
	id: string;
	x: number;
	y: number;
	radius: number;
	lineColor: string;
}

let graph = $state<MemoryGraphResponse | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);

let tierFilter = $state<Tier | null>(null);
let selectedNodeId = $state<string | null>(null);

let zoom = $state(1);
let pan = $state({ x: 0, y: 0 });
let svgEl = $state<SVGSVGElement | null>(null);
let dragState = $state<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

// Thread id -> color index lookup (for source coloring).
const threadColorMap = $derived(new Map(threads.map((t) => [t.id, t.color] as const)));

async function load(): Promise<void> {
	try {
		loading = true;
		error = null;
		graph = await client.getMemoryGraph();
	} catch (e) {
		error = e instanceof Error ? e.message : "Failed to load memory graph";
		graph = null;
	} finally {
		loading = false;
	}
}

onMount(() => {
	load();
});

// Deterministic placement along each tier's arc. Nodes from the same source
// thread sort together, so same-color "bouquets" form along the arc.
const placed = $derived.by<PlacedNode[]>(() => {
	if (!graph || graph.nodes.length === 0) return [];

	const byTier: Record<Tier, MemoryGraphNode[]> = {
		pinned: [],
		summary: [],
		default: [],
		detail: [],
	};
	for (const n of graph.nodes) {
		const t = (TIER_ORDER.includes(n.tier as Tier) ? n.tier : "default") as Tier;
		byTier[t].push(n);
	}

	const out: PlacedNode[] = [];
	let i = 0;

	for (const tier of TIER_ORDER) {
		const nodes = byTier[tier];
		nodes.sort((a, b) => {
			const sa = a.source ?? "";
			const sb = b.source ?? "";
			if (sa !== sb) return sa.localeCompare(sb);
			return (a.lineIndex ?? 0) - (b.lineIndex ?? 0);
		});
		const span = TIER_SPAN[tier];
		const radius = TIER_RAD[tier];
		const baseY = TIER_Y[tier];
		nodes.forEach((n, idx) => {
			const t = nodes.length === 1 ? 0.5 : idx / (nodes.length - 1);
			const angle = Math.PI / 2 + span / 2 - t * span;
			// Jitter is seeded from the key so it remains stable across renders.
			let s = 0;
			for (let c = 0; c < n.key.length; c++) s = (s * 31 + n.key.charCodeAt(c)) >>> 0;
			const jx = ((s % 1000) / 1000 - 0.5) * 6;
			const jy = (((s >> 10) % 1000) / 1000 - 0.5) * 4;
			const x = CX + radius * Math.cos(angle) + jx;
			const y = baseY + radius * Math.sin(angle) - radius + jy;
			const color =
				n.source && threadColorMap.has(n.source)
					? getLineCssVar(threadColorMap.get(n.source) ?? 0)
					: "var(--ink-2)";
			out.push({
				...n,
				id: `n${i++}`,
				x,
				y,
				radius: TIER_RADIUS[tier],
				lineColor: color,
			});
		});
	}
	return out;
});

const placedById = $derived(new Map(placed.map((p) => [p.id, p] as const)));
const placedByKey = $derived(new Map(placed.map((p) => [p.key, p] as const)));

const selectedNode = $derived(selectedNodeId ? (placedById.get(selectedNodeId) ?? null) : null);

const neighbors = $derived.by(() => {
	if (!selectedNode || !graph) return [] as Array<PlacedNode & { _relation: string }>;
	const seen = new Map<string, PlacedNode & { _relation: string }>();
	for (const e of graph.edges) {
		let other: PlacedNode | undefined;
		if (e.sourceKey === selectedNode.key) other = placedByKey.get(e.targetKey);
		else if (e.targetKey === selectedNode.key) other = placedByKey.get(e.sourceKey);
		if (other && !seen.has(other.id)) {
			seen.set(other.id, { ...other, _relation: e.relation });
		}
	}
	return [...seen.values()].slice(0, 8);
});

// View computed from pan + zoom
const view = $derived.by(() => {
	const w = VB_W / zoom;
	const h = VB_H / zoom;
	const maxX = VB_W - w;
	const maxY = VB_H - h;
	const x = zoom === 1 ? 0 : Math.max(0, Math.min(pan.x, maxX));
	const y = zoom === 1 ? 0 : Math.max(0, Math.min(pan.y, maxY));
	return { x, y, w, h };
});

function resetView(): void {
	zoom = 1;
	pan = { x: 0, y: 0 };
}

function focusOn(node: PlacedNode, z?: number): void {
	const targetZoom = z ?? Math.max(zoom, 2);
	const viewW = VB_W / targetZoom;
	const viewH = VB_H / targetZoom;
	zoom = targetZoom;
	pan = { x: node.x - viewW / 2, y: node.y - viewH / 2 };
}

function handleMouseDown(e: MouseEvent): void {
	if (zoom <= 1) return;
	dragState = {
		startX: e.clientX,
		startY: e.clientY,
		panX: pan.x,
		panY: pan.y,
	};
}

function handleMouseMove(e: MouseEvent): void {
	if (!dragState || !svgEl) return;
	const rect = svgEl.getBoundingClientRect();
	const dx = ((e.clientX - dragState.startX) * (VB_W / zoom)) / rect.width;
	const dy = ((e.clientY - dragState.startY) * (VB_H / zoom)) / rect.height;
	pan = { x: dragState.panX - dx, y: dragState.panY - dy };
}

function handleMouseUp(): void {
	dragState = null;
}

function handleWheel(e: WheelEvent): void {
	e.preventDefault();
	if (!svgEl) return;
	const rect = svgEl.getBoundingClientRect();
	const mx = (e.clientX - rect.left) / rect.width;
	const my = (e.clientY - rect.top) / rect.height;
	const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
	const newZoom = Math.max(1, Math.min(5, zoom * factor));
	const w0 = VB_W / zoom;
	const h0 = VB_H / zoom;
	const w1 = VB_W / newZoom;
	const h1 = VB_H / newZoom;
	const cx = view.x + mx * w0;
	const cy = view.y + my * h0;
	pan = { x: cx - mx * w1, y: cy - my * h1 };
	zoom = newZoom;
}

function zoomIn(): void {
	const nz = Math.min(5, zoom * 1.3);
	const cx = view.x + view.w / 2;
	const cy = view.y + view.h / 2;
	const w1 = VB_W / nz;
	const h1 = VB_H / nz;
	pan = { x: cx - w1 / 2, y: cy - h1 / 2 };
	zoom = nz;
}

function zoomOut(): void {
	const nz = Math.max(1, zoom / 1.3);
	const cx = view.x + view.w / 2;
	const cy = view.y + view.h / 2;
	const w1 = VB_W / nz;
	const h1 = VB_H / nz;
	pan = { x: cx - w1 / 2, y: cy - h1 / 2 };
	zoom = nz;
}

function nodeOpacity(n: PlacedNode): number {
	if (tierFilter && n.tier !== tierFilter) return 0.1;
	if (selectedThreadId && n.source !== selectedThreadId) return 0.18;
	return 1;
}

function onNodeClick(n: PlacedNode, e: MouseEvent): void {
	e.stopPropagation();
	if (selectedNodeId === n.id) {
		selectedNodeId = null;
	} else {
		selectedNodeId = n.id;
		focusOn(n, Math.max(zoom, 1.8));
	}
}

function sqrtZ(): number {
	return Math.sqrt(zoom);
}

function relTime(iso: string): string {
	const d = new Date(iso).getTime();
	const sec = Math.round((Date.now() - d) / 1000);
	if (sec < 60) return `${sec}s ago`;
	if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
	if (sec < 30 * 86400) return `${Math.round(sec / 86400)}d ago`;
	return new Date(iso).toISOString().slice(0, 10);
}

function tierCount(t: Tier): number {
	if (!graph) return 0;
	return graph.nodes.filter((n) => n.tier === t).length;
}

const tierBands: Array<{ tier: Tier; y: number; label: string }> = [
	{ tier: "pinned", y: VB_H * 0.16, label: TIER_LABEL.pinned },
	{ tier: "summary", y: VB_H * 0.39, label: TIER_LABEL.summary },
	{ tier: "default", y: VB_H * 0.62, label: TIER_LABEL.default },
	{ tier: "detail", y: VB_H * 0.84, label: TIER_LABEL.detail },
];

const hoveredThreadColorCss = $derived(
	hoveredThreadColor != null ? getLineCssVar(hoveredThreadColor) : null,
);
const hoveredCount = $derived(
	selectedThreadId && graph ? graph.nodes.filter((n) => n.source === selectedThreadId).length : 0,
);
</script>

<div class="memory-graph">
	<div class="header">
		<div class="titles">
			<div class="kicker">Memory Graph</div>
			<h2 class="title">Memory</h2>
		</div>
		<div class="spacer"></div>
		<div class="filters">
			<button
				class="tier-pill"
				class:active={tierFilter === null}
				onclick={() => (tierFilter = null)}
			>
				All tiers
			</button>
			{#each TIER_ORDER as t}
				<button
					class="tier-pill tier-{t}"
					class:active={tierFilter === t}
					onclick={() => (tierFilter = tierFilter === t ? null : t)}
				>
					<span class="tier-glyph tier-{t}"></span>
					{TIER_LABEL[t]}
					{#if graph}
						<span class="tier-count mono tnum">{tierCount(t)}</span>
					{/if}
				</button>
			{/each}
		</div>
	</div>

	<div class="canvas" class:with-panel={selectedNode}>
		<div class="svg-wrap">
			{#if loading}
				<div class="center-state">
					<div class="splash-dots">
						<span></span><span></span><span></span>
					</div>
					<p>Loading memory graph…</p>
				</div>
			{:else if error}
				<div class="center-state">
					<p>{error}</p>
					<button onclick={load}>Retry</button>
				</div>
			{:else if !graph || graph.nodes.length === 0}
				<div class="center-state">
					<p>No memories yet — they will appear here as the agent learns.</p>
				</div>
			{:else}
				<svg
					bind:this={svgEl}
					viewBox="{view.x} {view.y} {view.w} {view.h}"
					preserveAspectRatio="xMidYMid meet"
					onmousedown={handleMouseDown}
					onmousemove={handleMouseMove}
					onmouseup={handleMouseUp}
					onmouseleave={handleMouseUp}
					onwheel={handleWheel}
					style="cursor: {zoom > 1 ? (dragState ? 'grabbing' : 'grab') : 'default'}"
					aria-label="Memory graph — stratified by tier"
				>
					<defs>
						<pattern id="gridpat" width="40" height="40" patternUnits="userSpaceOnUse">
							<path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(26,24,20,0.035)" stroke-width="1" />
						</pattern>
					</defs>
					<rect x={view.x} y={view.y} width={view.w} height={view.h} fill="url(#gridpat)" />

					<!-- Tier bands -->
					{#each tierBands as b}
						{@const dim = tierFilter && tierFilter !== b.tier}
						<g opacity={dim ? 0.04 : 0.1}>
							<line
								x1={20}
								y1={b.y}
								x2={VB_W - 20}
								y2={b.y}
								stroke="var(--ink)"
								stroke-width={0.5 / sqrtZ()}
								stroke-dasharray="{4 / sqrtZ()} {6 / sqrtZ()}"
							/>
						</g>
						<text
							x={28}
							y={b.y - 6}
							fill="var(--ink-3)"
							opacity={dim ? 0.25 : 0.6}
							font-family="var(--font-mono)"
							font-size={10 / sqrtZ()}
							letter-spacing="0.14em"
							font-weight="600"
						>
							{b.label}
						</text>
					{/each}

					<!-- Edges -->
					<g stroke="var(--ink)" stroke-width={0.5 / sqrtZ()} opacity="0.18">
						{#each graph.edges as e, i}
							{@const a = placedByKey.get(e.sourceKey)}
							{@const b = placedByKey.get(e.targetKey)}
							{#if a && b}
								{@const dimmed =
									(tierFilter && (a.tier !== tierFilter || b.tier !== tierFilter)) ||
									(selectedThreadId &&
										(a.source !== selectedThreadId || b.source !== selectedThreadId))}
								{@const touchesSel =
									selectedNodeId && (a.id === selectedNodeId || b.id === selectedNodeId)}
								<line
									x1={a.x}
									y1={a.y}
									x2={b.x}
									y2={b.y}
									opacity={touchesSel ? 1 : dimmed ? 0.12 : 1}
									stroke={touchesSel ? "var(--ink)" : undefined}
									stroke-width={touchesSel ? 1.2 / sqrtZ() : undefined}
									stroke-dasharray={e.relation === "summarizes"
										? `${3 / sqrtZ()} ${3 / sqrtZ()}`
										: undefined}
								/>
							{/if}
						{/each}
					</g>

					<!-- Nodes -->
					{#each placed as n (n.id)}
						{@const isSelected = n.id === selectedNodeId}
						{@const r = n.radius * (isSelected ? 1.5 : 1)}
						{@const stroke = TIER_STROKE[n.tier as Tier]}
						<g
							style="opacity: {nodeOpacity(n)}; transition: opacity 0.18s ease; cursor: pointer;"
							onclick={(e) => onNodeClick(n, e)}
							role="button"
							tabindex="-1"
						>
							{#if isSelected}
								<circle
									cx={n.x}
									cy={n.y}
									r={r + 6}
									fill="none"
									stroke="var(--ink)"
									stroke-width={1.6 / sqrtZ()}
								/>
							{/if}
							<circle
								cx={n.x}
								cy={n.y}
								r={r}
								fill={n.lineColor}
								stroke={isSelected ? "var(--ink)" : stroke?.color ?? "var(--paper-2)"}
								stroke-width={(isSelected ? 1.4 : stroke?.width ?? 0.5) / sqrtZ()}
							/>
							{#if n.tier === "summary"}
								<circle cx={n.x} cy={n.y} r={Math.max(1, r * 0.35)} fill="var(--paper-2)" />
							{/if}
							{#if n.tier === "pinned"}
								<circle
									cx={n.x}
									cy={n.y}
									r={r + 2.5 / sqrtZ()}
									fill="none"
									stroke="var(--accent)"
									stroke-width={0.8 / sqrtZ()}
									opacity="0.7"
								/>
							{/if}
							{#if isSelected || zoom >= 2.2}
								<text
									x={n.x}
									y={n.y - r - 3}
									text-anchor="middle"
									fill="var(--ink)"
									font-family="var(--font-mono)"
									font-size={(9 / sqrtZ()) * 1.4}
									font-weight={isSelected ? 600 : 400}
									paint-order="stroke"
									stroke="var(--paper-2)"
									stroke-width={3 / sqrtZ()}
									pointer-events="none"
								>
									{n.key.length > 28 ? n.key.slice(0, 27) + "…" : n.key}
								</text>
							{/if}
						</g>
					{/each}
				</svg>
			{/if}

			<!-- Zoom controls -->
			<div class="zoom-controls">
				<button class="zoom-btn" onclick={zoomIn} title="Zoom in">+</button>
				<button class="zoom-btn" onclick={zoomOut} title="Zoom out">−</button>
				<button class="zoom-btn" onclick={resetView} title="Fit">⤢</button>
			</div>

			<!-- Stats strip -->
			<div class="stats-strip">
				<div class="stat-bit">
					<span class="kicker">Nodes</span>
					<span class="mono tnum">{graph?.nodes.length ?? 0}</span>
				</div>
				<div class="stat-bit">
					<span class="kicker">Edges</span>
					<span class="mono tnum">{graph?.edges.length ?? 0}</span>
				</div>
				<div class="stat-bit">
					<span class="kicker">Zoom</span>
					<span class="mono tnum">{zoom.toFixed(1)}×</span>
				</div>
			</div>

			<!-- Hovered-thread callout -->
			{#if hoveredThreadTitle && selectedThreadId && hoveredThreadColorCss}
				<div class="hover-callout">
					<span class="hover-dot" style="background: {hoveredThreadColorCss}"></span>
					<span class="kicker">Memories from</span>
					<span class="hover-title">{hoveredThreadTitle}</span>
					<span class="mono tnum">{hoveredCount}</span>
				</div>
			{/if}
		</div>

		{#if selectedNode}
			<aside class="detail-panel">
				<div class="detail-head">
					<span class="detail-dot" style="background: {selectedNode.lineColor}"></span>
					<span class="kicker" style="color: {TIER_TEXT[selectedNode.tier as Tier]}">
						{TIER_LABEL[selectedNode.tier as Tier]} TIER
					</span>
					<div class="spacer"></div>
					<button class="detail-close" onclick={() => (selectedNodeId = null)} title="Close">✕</button>
				</div>

				<div>
					<div class="detail-key mono">{selectedNode.key}</div>
					<h3 class="detail-value">{selectedNode.value}</h3>
				</div>

				<div class="stats-grid">
					<div class="stat">
						<span class="kicker">Tier</span>
						<span class="mono tnum" style="color: {TIER_TEXT[selectedNode.tier as Tier]}">
							{selectedNode.tier}
						</span>
					</div>
					<div class="stat">
						<span class="kicker">Modified</span>
						<span class="mono tnum">{relTime(selectedNode.modifiedAt)}</span>
					</div>
					{#if selectedNode.lineIndex != null}
						<div class="stat">
							<span class="kicker">Line</span>
							<span class="mono tnum">{selectedNode.lineIndex}</span>
						</div>
					{/if}
				</div>

				{#if selectedNode.source}
					<button
						class="source-btn"
						onclick={() => onNavigate?.(`/line/${selectedNode?.source}`)}
					>
						<div class="kicker">Source ↗</div>
						<div class="source-title">{selectedNode.sourceThreadTitle ?? selectedNode.source}</div>
						<div class="source-meta mono">
							{selectedNode.source}{selectedNode.lineIndex != null
								? ` · line ${selectedNode.lineIndex}`
								: ""}
						</div>
					</button>
				{/if}

				{#if neighbors.length > 0}
					<div>
						<div class="kicker neighbors-label">Linked · {neighbors.length}</div>
						<div class="neighbors">
							{#each neighbors as nb}
								<button
									class="neighbor"
									onclick={() => {
										selectedNodeId = nb.id;
										focusOn(nb);
									}}
								>
									<span class="neighbor-dot" style="background: {nb.lineColor}"></span>
									<span class="neighbor-key mono">{nb.key}</span>
									<span class="neighbor-rel mono">{nb._relation}</span>
								</button>
							{/each}
						</div>
					</div>
				{/if}
			</aside>
		{/if}
	</div>

	<div class="footnote">
		<span>Scroll to zoom · drag to pan · click a node to inspect.</span>
		<span>Showing {placed.filter((n) => !tierFilter || n.tier === tierFilter).length} of {placed.length} nodes</span>
	</div>
</div>

<style>
	.memory-graph {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 18px 22px;
		background: var(--paper);
		overflow: hidden;
	}

	.header {
		display: flex;
		align-items: flex-end;
		gap: 14px;
		margin-bottom: 10px;
	}

	.titles .kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.title {
		margin: 2px 0 0;
		font-family: var(--font-header);
		font-size: 28px;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--ink);
	}

	.spacer {
		flex: 1;
	}

	.filters {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.tier-pill {
		padding: 5px 10px;
		background: transparent;
		color: var(--ink-2);
		border: 1px solid var(--rule-soft);
		cursor: pointer;
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 500;
		display: inline-flex;
		align-items: center;
		gap: 7px;
	}

	.tier-pill.active {
		background: var(--ink);
		color: var(--paper);
		border-color: var(--ink);
	}

	.tier-glyph {
		display: inline-block;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.tier-pill.tier-pinned .tier-glyph {
		border: 1.5px solid var(--ink-2);
		box-shadow: 0 0 0 1.5px var(--accent);
	}
	.tier-pill.tier-pinned.active .tier-glyph {
		border-color: var(--paper);
		box-shadow: 0 0 0 1.5px var(--paper);
	}
	.tier-pill.tier-summary .tier-glyph {
		background: var(--ink);
	}
	.tier-pill.tier-summary.active .tier-glyph {
		background: var(--paper);
	}
	.tier-pill.tier-default .tier-glyph {
		border: 1.5px solid var(--ink-2);
	}
	.tier-pill.tier-default.active .tier-glyph {
		border-color: var(--paper);
	}
	.tier-pill.tier-detail .tier-glyph {
		border: 1.5px solid var(--ink-2);
	}
	.tier-pill.tier-detail.active .tier-glyph {
		border-color: var(--paper);
	}

	.tier-count {
		font-size: 10.5px;
		color: var(--ink-3);
	}

	.tier-pill.active .tier-count {
		color: rgba(239, 234, 224, 0.6);
	}

	.canvas {
		flex: 1;
		min-height: 0;
		position: relative;
		border: 1px solid var(--rule-soft);
		background: var(--paper-2);
		display: grid;
		grid-template-columns: 1fr;
		overflow: hidden;
		transition: grid-template-columns 0.2s ease;
	}

	.canvas.with-panel {
		grid-template-columns: 1fr 300px;
	}

	.svg-wrap {
		position: relative;
		min-width: 0;
	}

	svg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		user-select: none;
	}

	.center-state {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: var(--ink-3);
		gap: 16px;
		text-align: center;
		padding: 24px;
	}

	.center-state p {
		font-size: 13px;
		font-style: italic;
	}

	.splash-dots {
		display: flex;
		gap: 8px;
	}

	.splash-dots span {
		width: 7px;
		height: 7px;
		background: var(--ink-4);
		border-radius: 50%;
		animation: pulse 1.4s ease-in-out infinite;
	}

	.splash-dots span:nth-child(2) {
		animation-delay: 0.2s;
	}
	.splash-dots span:nth-child(3) {
		animation-delay: 0.4s;
	}

	.zoom-controls {
		position: absolute;
		top: 12px;
		right: 12px;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--ink);
		background: var(--paper);
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
	}

	.zoom-btn {
		width: 30px;
		height: 30px;
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--rule-soft);
		cursor: pointer;
		font-family: var(--font-mono);
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		padding: 0;
	}

	.zoom-btn:last-child {
		border-bottom: none;
	}

	.zoom-btn:hover {
		background: var(--paper-2);
	}

	.stats-strip {
		position: absolute;
		left: 12px;
		bottom: 12px;
		display: flex;
		gap: 20px;
		padding: 6px 12px;
		background: rgba(239, 234, 224, 0.9);
		border: 1px solid var(--rule-soft);
		backdrop-filter: blur(4px);
	}

	.stat-bit {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.stat-bit .kicker {
		font-size: 9.5px;
	}

	.stat-bit .mono {
		font-size: 14px;
		font-weight: 500;
		color: var(--ink);
	}

	.hover-callout {
		position: absolute;
		right: 12px;
		bottom: 12px;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 12px;
		background: rgba(239, 234, 224, 0.92);
		border: 1px solid var(--ink);
		backdrop-filter: blur(4px);
	}

	.hover-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.hover-title {
		font-size: 12px;
		color: var(--ink);
		font-weight: 500;
	}

	.hover-callout .mono {
		font-size: 12px;
		color: var(--ink-3);
	}

	.detail-panel {
		border-left: 1px solid var(--rule-soft);
		background: var(--paper);
		padding: 16px 18px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.detail-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.detail-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
	}

	.detail-close {
		background: transparent;
		border: 1px solid var(--rule-soft);
		cursor: pointer;
		padding: 2px 7px;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--ink-2);
	}

	.detail-key {
		font-size: 11px;
		color: var(--ink-3);
		letter-spacing: 0.02em;
		margin-bottom: 6px;
		word-break: break-all;
	}

	.detail-value {
		margin: 0;
		font-family: var(--font-display);
		font-size: 15px;
		font-weight: 500;
		line-height: 1.4;
		color: var(--ink);
		letter-spacing: -0.005em;
	}

	.stats-grid {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.stat .kicker {
		font-size: 9.5px;
	}

	.stat .mono {
		font-size: 13px;
		font-weight: 500;
	}

	.source-btn {
		text-align: left;
		padding: 10px 12px;
		background: var(--paper-2);
		border: 1px solid var(--rule-soft);
		cursor: pointer;
		font: inherit;
		color: inherit;
		display: block;
		width: 100%;
	}

	.source-btn:hover {
		background: var(--paper-3);
	}

	.source-title {
		font-size: 12px;
		color: var(--ink);
		margin-bottom: 2px;
		margin-top: 4px;
	}

	.source-meta {
		font-size: 10.5px;
		color: var(--ink-3);
	}

	.neighbors-label {
		margin-bottom: 8px;
	}

	.neighbors {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.neighbor {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--rule-faint);
		cursor: pointer;
		text-align: left;
	}

	.neighbor:hover {
		background: var(--paper-2);
	}

	.neighbor-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.neighbor-key {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--ink);
	}

	.neighbor-rel {
		font-size: 9.5px;
		color: var(--ink-4);
		letter-spacing: 0.04em;
	}

	.footnote {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 10px;
		font-size: 12px;
		color: var(--ink-3);
	}

	.footnote span:first-child {
		font-style: italic;
	}

	@media (prefers-reduced-motion: reduce) {
		.splash-dots span {
			animation: none;
		}
	}
</style>
