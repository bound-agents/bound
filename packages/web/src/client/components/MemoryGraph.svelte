<script lang="ts">
import { onMount, untrack } from "svelte";
import { api } from "../lib/api";
import type { MemoryGraphResponse } from "../lib/api";
import { computeInitialLayout, simulationStep, updateOpacity } from "../lib/graph-layout";
import type { PositionedNode, PositionedEdge, GraphLayoutResult } from "../lib/graph-layout";

interface Props {
	selectedThreadId?: string | null;
	onNodeClick?: (key: string) => void;
}

let { selectedThreadId, onNodeClick }: Props = $props();

let graphData = $state<MemoryGraphResponse | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let hoveredNode = $state<string | null>(null);
let tooltipPos = $state<{ x: number; y: number } | null>(null);
let activePopoverNode = $state<string | null>(null);

// Simulation state
let simNodes = $state<PositionedNode[]>([]);
let simEdges = $state<PositionedEdge[]>([]);
let simNodeMap = $state<Map<string, PositionedNode>>(new Map());
let simRunning = $state(false);
let animFrame: number | null = null;
let btnTooltip = $state<{ text: string; x: number; y: number } | null>(null);

let containerEl = $state<HTMLDivElement | null>(null);
let containerWidth = $state(600);
let containerHeight = $state(400);

// Pan/zoom
let viewX = $state(0);
let viewY = $state(0);
let zoom = $state(1);
let isPanning = $state(false);
let panStartX = 0;
let panStartY = 0;
let panStartViewX = 0;
let panStartViewY = 0;

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;

// Observe container size
let resizeObserver: ResizeObserver | null = null;

onMount(() => {
	if (containerEl) {
		const rect = containerEl.getBoundingClientRect();
		containerWidth = rect.width;
		containerHeight = rect.height;

		resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				containerWidth = entry.contentRect.width;
				containerHeight = entry.contentRect.height;
			}
		});
		resizeObserver.observe(containerEl);
	}

	return () => {
		resizeObserver?.disconnect();
		if (animFrame !== null) cancelAnimationFrame(animFrame);
	};
});

async function fetchMemoryGraph() {
	try {
		loading = true;
		error = null;
		const data = await api.getMemoryGraph();
		graphData = data;
	} catch (err) {
		error = err instanceof Error ? err.message : "Failed to load memory graph";
		graphData = null;
	} finally {
		loading = false;
	}
}

// Fetch on mount only (hover changes are handled client-side via opacity)
onMount(() => {
	fetchMemoryGraph();
});

// Run simulation when graphData or container size changes
$effect(() => {
	if (!graphData || containerWidth < 10 || containerHeight < 10) return;

	const layout = computeInitialLayout(
		graphData.nodes,
		graphData.edges,
		containerWidth,
		containerHeight,
		null, // Don't pass selectedThreadId — opacity handled separately
	);

	simNodes = layout.nodes;
	simEdges = layout.edges;
	simNodeMap = layout.nodeMap;

	// Reset view
	viewX = 0;
	viewY = 0;
	zoom = 1;

	// Start simulation
	startSimulation();
});

// Update opacity on hover without restarting simulation
// Uses untrack to avoid dependency cycle (reads+writes simNodes)
$effect(() => {
	const threadId = selectedThreadId; // track only this prop
	untrack(() => {
		if (simNodes.length === 0) return;
		updateOpacity(simNodes, simEdges, simNodeMap, threadId ?? null);
		simNodes = [...simNodes]; // trigger re-render
		simEdges = [...simEdges];
	});
});

function startSimulation() {
	if (animFrame !== null) cancelAnimationFrame(animFrame);
	simRunning = true;
	let frame = 0;
	const maxFrames = 200;

	function tick() {
		if (frame >= maxFrames || !simRunning) {
			simRunning = false;
			return;
		}

		// Alpha decays from 1 to 0 over the simulation
		const alpha = 1 - frame / maxFrames;
		const energy = simulationStep(simNodes, simEdges, simNodeMap, containerWidth, containerHeight, alpha);

		// Force reactivity by reassigning both nodes and nodeMap
		simNodes = [...simNodes];
		simNodeMap = new Map(simNodes.map((n) => [n.key, n]));

		frame++;

		// Stop early if settled
		if (energy < 0.1 && frame > 30) {
			simRunning = false;
			return;
		}

		animFrame = requestAnimationFrame(tick);
	}

	animFrame = requestAnimationFrame(tick);
}

// Interaction handlers
function handleNodeHover(nodeKey: string, event: MouseEvent) {
	hoveredNode = nodeKey;
	if (containerEl) {
		const rect = containerEl.getBoundingClientRect();
		tooltipPos = {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
		};
	}
}

function handleNodeLeave() {
	hoveredNode = null;
	tooltipPos = null;
}

function handleNodeClick(nodeKey: string) {
	activePopoverNode = activePopoverNode === nodeKey ? null : nodeKey;
	onNodeClick?.(nodeKey);
}

function closePopover() { activePopoverNode = null; }
function handlePopoverClick(e: Event) { e.stopPropagation(); }
function getNodeData(key: string) { return graphData?.nodes.find((n) => n.key === key); }

// Pan handlers
function handlePointerDown(e: PointerEvent) {
	if ((e.target as Element)?.closest(".node-group")) return;
	isPanning = true;
	panStartX = e.clientX;
	panStartY = e.clientY;
	panStartViewX = viewX;
	panStartViewY = viewY;
	(e.currentTarget as Element)?.setPointerCapture(e.pointerId);
}

function handlePointerMove(e: PointerEvent) {
	if (!isPanning) return;
	viewX = panStartViewX - (e.clientX - panStartX) / zoom;
	viewY = panStartViewY - (e.clientY - panStartY) / zoom;
}

function handlePointerUp(e: PointerEvent) {
	isPanning = false;
	(e.currentTarget as Element)?.releasePointerCapture(e.pointerId);
}

function handleWheel(e: WheelEvent) {
	e.preventDefault();
	const delta = e.deltaY > 0 ? -0.1 : 0.1;
	const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + delta));
	if (containerEl) {
		const rect = containerEl.getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const my = e.clientY - rect.top;
		const svgX = viewX + mx / zoom;
		const svgY = viewY + my / zoom;
		viewX = svgX - mx / newZoom;
		viewY = svgY - my / newZoom;
	}
	zoom = newZoom;
}

function resetView() {
	viewX = 0; viewY = 0; zoom = 1;
}

const viewBox = $derived.by(() => {
	const w = containerWidth / zoom;
	const h = containerHeight / zoom;
	return `${viewX} ${viewY} ${w} ${h}`;
});
</script>

<div class="memory-graph-container">
	<div class="graph-header">
		<h3>Memory Station</h3>
		<div class="header-controls">
			{#if simRunning}
				<span class="sim-indicator">settling...</span>
			{/if}
			<button
				class="control-btn accent-btn"
				onclick={() => startSimulation()}
				onmouseenter={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); btnTooltip = { text: "Re-settle nodes with physics", x: r.left + r.width / 2, y: r.bottom + 6 }; }}
				onmouseleave={() => (btnTooltip = null)}
			>
				settle
			</button>
			<button
				class="control-btn"
				onclick={resetView}
				onmouseenter={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); btnTooltip = { text: "Reset zoom to 100%", x: r.left + r.width / 2, y: r.bottom + 6 }; }}
				onmouseleave={() => (btnTooltip = null)}
			>
				1:1
			</button>
			<button
				class="control-btn"
				onclick={() => fetchMemoryGraph()}
				disabled={loading}
				onmouseenter={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); btnTooltip = { text: "Reload memory data", x: r.left + r.width / 2, y: r.bottom + 6 }; }}
				onmouseleave={() => (btnTooltip = null)}
			>
				↻
			</button>
		</div>
	</div>

	{#if btnTooltip}
		<div class="btn-tooltip" style="left: {btnTooltip.x}px; top: {btnTooltip.y}px;">
			{btnTooltip.text}
		</div>
	{/if}

	<div class="graph-content" bind:this={containerEl}>
		{#if loading}
			<div class="center-state">
				<div class="placeholder-dots">
					<div class="dot pulse"></div>
					<div class="dot pulse" style="animation-delay: 0.2s"></div>
					<div class="dot pulse" style="animation-delay: 0.4s"></div>
				</div>
				<p>Loading memory graph...</p>
			</div>
		{:else if error}
			<div class="center-state">
				<p>{error}</p>
				<button onclick={() => fetchMemoryGraph()}>Retry</button>
			</div>
		{:else if !graphData || graphData.nodes.length === 0}
			<div class="center-state">
				<p>No memories yet — they'll appear here as the agent learns.</p>
			</div>
		{:else if simNodes.length === 0}
			<div class="center-state">
				<p>No memories linked to this thread.</p>
			</div>
		{:else}
			<svg
				class="graph-svg"
				class:panning={isPanning}
				viewBox={viewBox}
				onpointerdown={handlePointerDown}
				onpointermove={handlePointerMove}
				onpointerup={handlePointerUp}
				onwheel={handleWheel}
			>
				<!-- Edges -->
				{#each simEdges as edge}
					{@const source = simNodeMap.get(edge.sourceKey)}
					{@const target = simNodeMap.get(edge.targetKey)}
					{#if source && target}
						<line
							x1={source.x}
							y1={source.y}
							x2={target.x}
							y2={target.y}
							stroke={edge.color}
							stroke-width={1}
							stroke-dasharray={edge.dashed ? "6,3" : "0"}
							opacity={edge.opacity * 0.4}
							class="edge"
						/>
					{/if}
				{/each}

				<!-- Nodes -->
				{#each simNodes as node}
					<g
						class="node-group"
						onmouseenter={(e) => handleNodeHover(node.key, e)}
						onmouseleave={handleNodeLeave}
						onclick={() => handleNodeClick(node.key)}
					>
						<!-- Glow for pinned -->
						{#if node.tier === "pinned"}
							<circle
								cx={node.x}
								cy={node.y}
								r={node.radius + 4}
								fill="none"
								stroke={node.color}
								stroke-width={1}
								opacity={node.opacity * 0.2}
							/>
						{/if}

						<circle
							cx={node.x}
							cy={node.y}
							r={node.radius}
							fill={node.color}
							opacity={node.opacity}
							class="node {node.tier}"
						/>

						<!-- Label (only show when zoomed in enough or for pinned/summary) -->
						{#if node.tier === "pinned" || node.tier === "summary" || zoom > 0.8}
							<text
								x={node.x + node.radius + 4}
								y={node.y + 3}
								class="node-label"
								opacity={node.opacity * 0.8}
							>
								{node.key.length > 24 ? node.key.slice(0, 22) + "…" : node.key}
							</text>
						{/if}
					</g>
				{/each}

				<!-- Single subtle guide between pinned arc and the rest -->
				<line x1={containerWidth * 0.15} y1={containerHeight * 0.20} x2={containerWidth * 0.85} y2={containerHeight * 0.20} class="tier-guide" />
			</svg>

			<!-- Tier legend -->
			<div class="tier-legend">
				<span class="legend-item"><span class="legend-dot" style="background: #F39700; width: 10px; height: 10px;"></span>pinned</span>
				<span class="legend-item"><span class="legend-dot" style="background: #009BBF; width: 8px; height: 8px;"></span>summary</span>
				<span class="legend-item"><span class="legend-dot" style="background: #9CAEB7; width: 6px; height: 6px;"></span>default</span>
				<span class="legend-item"><span class="legend-dot" style="background: #706B66; width: 5px; height: 5px;"></span>detail</span>
			</div>

			<!-- Zoom indicator -->
			<div class="zoom-indicator">{Math.round(zoom * 100)}%</div>

			<!-- Tooltip -->
			{#if hoveredNode && tooltipPos && graphData}
				{@const nodeData = getNodeData(hoveredNode)}
				{#if nodeData}
					<div
						class="tooltip"
						style="left: {tooltipPos.x + 14}px; top: {tooltipPos.y - 10}px"
					>
						<div class="tooltip-key">{nodeData.key}</div>
						{#if nodeData.value}
							<div class="tooltip-value">
								{nodeData.value.substring(0, 140)}
								{nodeData.value.length > 140 ? "..." : ""}
							</div>
						{/if}
						<div class="tooltip-tier">
							<span class="tier-badge">{nodeData.tier}</span>
						</div>
						{#if nodeData.sourceThreadTitle}
							<div class="tooltip-source">{nodeData.sourceThreadTitle}</div>
						{/if}
						<div class="tooltip-date">{new Date(nodeData.modifiedAt).toLocaleDateString()}</div>
					</div>
				{/if}
			{/if}

			<!-- Popover -->
			{#if activePopoverNode && graphData}
				{@const nodeData = getNodeData(activePopoverNode)}
				{#if nodeData}
					<div class="popover-overlay" onclick={closePopover}>
						<div class="popover" onclick={handlePopoverClick}>
							<div class="popover-header">
								<h4>{nodeData.key}</h4>
								<button class="close-btn" onclick={closePopover}>×</button>
							</div>
							{#if nodeData.value}
								<div class="popover-value">{nodeData.value}</div>
							{/if}
							<div class="popover-metadata">
								<div class="meta-item">
									<span class="label">Tier:</span>
									<span class="tier-badge">{nodeData.tier}</span>
								</div>
								{#if nodeData.sourceThreadTitle}
									<div class="meta-item">
										<span class="label">Source:</span>
										<a href="#{nodeData.source}" class="source-link">{nodeData.sourceThreadTitle}</a>
									</div>
								{/if}
								<div class="meta-item">
									<span class="label">Modified:</span>
									<span class="date">{new Date(nodeData.modifiedAt).toLocaleString()}</span>
								</div>
							</div>
						</div>
					</div>
				{/if}
			{/if}
		{/if}
	</div>
</div>

<style>
	.memory-graph-container {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--bg-primary);
	}

	.graph-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 16px;
		border-bottom: 1px solid var(--bg-surface);
		flex-shrink: 0;
	}

	.graph-header h3 {
		margin: 0;
		font-size: var(--text-base);
		font-weight: 600;
		color: var(--text-primary);
	}

	.header-controls {
		display: flex;
		gap: 4px;
		align-items: center;
	}

	.sim-indicator {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--status-active);
		opacity: 0.7;
		animation: blink 1s ease-in-out infinite;
	}

	@keyframes blink {
		0%, 100% { opacity: 0.4; }
		50% { opacity: 1; }
	}

	.control-btn {
		height: 26px;
		padding: 0 8px;
		border: 1px solid var(--bg-surface);
		background: var(--bg-secondary);
		color: var(--text-secondary);
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
		font-family: var(--font-mono);
		transition: all 0.15s ease;
	}

	.control-btn:hover:not(:disabled) {
		background: rgba(42, 48, 68, 0.3);
		color: var(--text-primary);
	}

	.control-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.accent-btn {
		background: rgba(143, 118, 214, 0.15);
		border-color: rgba(143, 118, 214, 0.3);
		color: var(--line-6);
	}

	.accent-btn:hover:not(:disabled) {
		background: rgba(143, 118, 214, 0.25);
		color: #c4b5f4;
	}

	.btn-tooltip {
		position: fixed;
		transform: translateX(-50%);
		background: var(--bg-primary);
		border: 1px solid var(--bg-surface);
		border-radius: 6px;
		padding: 5px 10px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-secondary);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		z-index: 1000;
		pointer-events: none;
		white-space: nowrap;
	}

	.graph-content {
		flex: 1;
		overflow: hidden;
		min-height: 0;
		position: relative;
		background: var(--bg-secondary);
	}

	.center-state {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		color: var(--text-muted);
	}

	.placeholder-dots {
		display: flex;
		justify-content: center;
		gap: 8px;
		margin-bottom: 16px;
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-muted);
	}

	.dot.pulse {
		animation: pulse 1.5s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 0.4; }
		50% { opacity: 1; }
	}

	.center-state p { margin: 0; font-size: var(--text-sm); }

	.center-state button {
		margin-top: 12px;
		padding: 6px 12px;
		background: var(--bg-secondary);
		border: 1px solid var(--bg-surface);
		border-radius: 4px;
		cursor: pointer;
		font-size: var(--text-sm);
	}

	.graph-svg {
		width: 100%;
		height: 100%;
		cursor: grab;
		user-select: none;
		touch-action: none;
	}

	.graph-svg.panning { cursor: grabbing; }

	.edge {
		stroke-linecap: round;
	}

	.tier-guide {
		stroke: var(--bg-surface);
		stroke-width: 1;
		stroke-dasharray: 4,8;
		opacity: 0.25;
	}

	.node {
		stroke: var(--bg-secondary);
		stroke-width: 1.5;
	}

	.node.pinned { stroke-width: 2.5; }
	.node.summary { stroke-width: 2; }

	.node-group { cursor: pointer; }
	.node-group:hover .node { filter: brightness(1.3); }

	.node-label {
		font-size: 9px;
		font-family: var(--font-mono);
		fill: var(--text-secondary);
		pointer-events: none;
	}

	.tier-legend {
		position: absolute;
		bottom: 8px;
		left: 8px;
		display: flex;
		gap: 12px;
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		pointer-events: none;
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.legend-dot {
		display: inline-block;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.zoom-indicator {
		position: absolute;
		bottom: 8px;
		right: 8px;
		padding: 2px 6px;
		background: rgba(0, 0, 0, 0.5);
		border-radius: 3px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--text-muted);
		pointer-events: none;
	}

	.tooltip {
		position: absolute;
		background: var(--bg-primary);
		border: 1px solid var(--bg-surface);
		border-radius: 6px;
		padding: 8px 10px;
		font-size: var(--text-xs);
		max-width: 220px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		z-index: 1000;
		pointer-events: none;
	}

	.tooltip-key {
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 4px;
		word-break: break-word;
	}

	.tooltip-value {
		color: var(--text-secondary);
		margin-bottom: 4px;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.tooltip-tier { margin-bottom: 4px; }

	.tier-badge {
		display: inline-block;
		padding: 2px 6px;
		background: var(--bg-surface);
		border-radius: 3px;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		text-transform: uppercase;
		font-weight: 500;
	}

	.tooltip-source {
		color: var(--text-secondary);
		margin-bottom: 4px;
		font-size: var(--text-xs);
	}

	.tooltip-date {
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.popover-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 2000;
	}

	.popover {
		background: var(--bg-secondary);
		border: 1px solid var(--bg-surface);
		border-radius: 8px;
		width: 90%;
		max-width: 560px;
		max-height: 70vh;
		display: flex;
		flex-direction: column;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
	}

	.popover-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--bg-surface);
	}

	.popover-header h4 {
		margin: 0;
		font-size: var(--text-base);
		font-weight: 600;
		color: var(--text-primary);
		word-break: break-word;
	}

	.close-btn {
		width: 28px;
		height: 28px;
		border: none;
		background: transparent;
		cursor: pointer;
		font-size: 20px;
		color: var(--text-secondary);
		padding: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.close-btn:hover { color: var(--text-primary); }

	.popover-value {
		flex: 1;
		padding: 12px 16px;
		overflow-y: auto;
		color: var(--text-secondary);
		font-size: var(--text-sm);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.popover-metadata {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 16px;
		border-top: 1px solid var(--bg-surface);
		font-size: var(--text-xs);
	}

	.meta-item {
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}

	.meta-item .label {
		font-weight: 600;
		color: var(--text-primary);
		white-space: nowrap;
	}

	.source-link {
		color: var(--line-3);
		text-decoration: none;
		cursor: pointer;
	}

	.source-link:hover { color: var(--line-0); }
	.meta-item .date { color: var(--text-secondary); }
</style>
