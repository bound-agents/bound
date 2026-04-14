<script lang="ts">
import { api } from "../lib/api";
import type { MemoryGraphResponse } from "../lib/api";
import { computeGraphLayout } from "../lib/graph-layout";

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

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const CANVAS_WIDTH = 500;
const CANVAS_HEIGHT = 450;

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

// Initial fetch and re-fetch on selectedThreadId change
$effect(() => {
	if (debounceTimer) clearTimeout(debounceTimer);

	debounceTimer = setTimeout(
		() => {
			fetchMemoryGraph();
		},
		selectedThreadId ? 200 : 0,
	);

	return () => {
		if (debounceTimer) clearTimeout(debounceTimer);
	};
});

function handleNodeHover(nodeKey: string, event: MouseEvent) {
	hoveredNode = nodeKey;
	const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
	tooltipPos = {
		x: event.clientX - rect.left,
		y: event.clientY - rect.top,
	};
}

function handleNodeLeave() {
	hoveredNode = null;
	tooltipPos = null;
}

function handleNodeClick(nodeKey: string) {
	activePopoverNode = activePopoverNode === nodeKey ? null : nodeKey;
	onNodeClick?.(nodeKey);
}

function closePopover() {
	activePopoverNode = null;
}

function handlePopoverClick(e: Event) {
	e.stopPropagation();
}

// Get node data from graphData for popover
function getNodeData(key: string) {
	return graphData?.nodes.find((n) => n.key === key);
}

// Compute layout
const layout = $derived.by(() => {
	if (!graphData) {
		return null;
	}
	return computeGraphLayout(graphData.nodes, graphData.edges, CANVAS_WIDTH, selectedThreadId);
});
</script>

<div class="memory-graph-container">
	<div class="graph-header">
		<h3>Memory Station</h3>
		<button
			class="refresh-btn"
			title="Refresh memory graph"
			onclick={() => fetchMemoryGraph()}
			disabled={loading}
		>
			↻
		</button>
	</div>

	<div class="graph-content">
		{#if loading}
			<div class="loading-state">
				<div class="placeholder-dots">
					<div class="dot pulse"></div>
					<div class="dot pulse" style="animation-delay: 0.2s"></div>
					<div class="dot pulse" style="animation-delay: 0.4s"></div>
				</div>
				<p>Loading memory graph...</p>
			</div>
		{:else if error}
			<div class="error-state">
				<p>{error}</p>
				<button onclick={() => fetchMemoryGraph()}>Retry</button>
			</div>
		{:else if !graphData || graphData.nodes.length === 0}
			<div class="empty-state">
				<p>🗂️ No memories yet — they'll appear here as the agent learns.</p>
			</div>
		{:else if layout && layout.positionedNodes.length === 0}
			<div class="empty-state">
				<p>No memories linked to this thread.</p>
			</div>
		{:else if layout}
			<svg
				width={CANVAS_WIDTH}
				height={CANVAS_HEIGHT}
				class="graph-svg"
				viewBox="0 0 {CANVAS_WIDTH} {CANVAS_HEIGHT}"
			>
				<!-- Edges -->
				{#each layout.positionedEdges as edge}
					<line
						x1={edge.x1}
						y1={edge.y1}
						x2={edge.x2}
						y2={edge.y2}
						stroke={edge.color}
						stroke-width={1}
						stroke-dasharray={edge.dashed ? "6,3" : "0"}
						opacity={edge.opacity}
						class="edge"
					/>
				{/each}

				<!-- Nodes -->
				{#each layout.positionedNodes as node}
					<circle
						cx={node.x}
						cy={node.y}
						r={node.radius}
						fill={node.color}
						opacity={node.opacity}
						class="node {node.tier}"
						onmouseenter={(e) => handleNodeHover(node.key, e)}
						onmouseleave={handleNodeLeave}
						onclick={() => handleNodeClick(node.key)}
					/>
				{/each}
			</svg>

			<!-- Tooltip -->
			{#if hoveredNode && tooltipPos && graphData}
				{@const nodeData = getNodeData(hoveredNode)}
				{#if nodeData}
					<div
						class="tooltip"
						style="left: {tooltipPos.x}px; top: {tooltipPos.y}px"
					>
						<div class="tooltip-key">{nodeData.key}</div>
						{#if nodeData.value}
							<div class="tooltip-value">
								{nodeData.value.substring(0, 100)}
								{nodeData.value.length > 100 ? "..." : ""}
							</div>
						{/if}
						<div class="tooltip-tier">
							<span class="tier-badge">{nodeData.tier}</span>
						</div>
						{#if nodeData.sourceThreadTitle}
							<div class="tooltip-source">
								{nodeData.sourceThreadTitle}
							</div>
						{/if}
						<div class="tooltip-date">
							{new Date(nodeData.modifiedAt).toLocaleDateString()}
						</div>
					</div>
				{/if}
			{/if}

			<!-- Popover -->
			{#if activePopoverNode && graphData}
				{@const nodeData = getNodeData(activePopoverNode)}
				{#if nodeData}
					<div
						class="popover-overlay"
						onclick={closePopover}
					>
						<div
							class="popover"
							onclick={handlePopoverClick}
						>
							<div class="popover-header">
								<h4>{nodeData.key}</h4>
								<button
									class="close-btn"
									onclick={closePopover}
								>
									×
								</button>
							</div>

							{#if nodeData.value}
								<div class="popover-value">
									{nodeData.value}
								</div>
							{/if}

							<div class="popover-metadata">
								<div class="meta-item">
									<span class="label">Tier:</span>
									<span class="tier-badge">{nodeData.tier}</span>
								</div>
								{#if nodeData.sourceThreadTitle}
									<div class="meta-item">
										<span class="label">Source:</span>
										<a
											href="#{nodeData.source}"
											class="source-link"
										>
											{nodeData.sourceThreadTitle}
										</a>
									</div>
								{/if}
								<div class="meta-item">
									<span class="label">Modified:</span>
									<span class="date">
										{new Date(nodeData.modifiedAt).toLocaleString()}
									</span>
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
		padding: 12px 16px;
		border-bottom: 1px solid var(--bg-surface);
	}

	.graph-header h3 {
		margin: 0;
		font-size: var(--text-base);
		font-weight: 600;
		color: var(--text-primary);
	}

	.refresh-btn {
		width: 28px;
		height: 28px;
		border: 1px solid var(--bg-surface);
		background: var(--bg-secondary);
		border-radius: 4px;
		cursor: pointer;
		font-size: 14px;
		transition: all 0.2s ease;
	}

	.refresh-btn:hover:not(:disabled) {
		background: rgba(15, 52, 96, 0.3);
	}

	.refresh-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.graph-content {
		flex: 1;
		overflow: auto;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
	}

	.loading-state,
	.error-state,
	.empty-state {
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
		0%,
		100% {
			opacity: 0.4;
		}
		50% {
			opacity: 1;
		}
	}

	.loading-state p,
	.error-state p,
	.empty-state p {
		margin: 0;
		font-size: var(--text-sm);
	}

	.error-state button {
		margin-top: 12px;
		padding: 6px 12px;
		background: var(--bg-secondary);
		border: 1px solid var(--bg-surface);
		border-radius: 4px;
		cursor: pointer;
		font-size: var(--text-sm);
		transition: all 0.2s ease;
	}

	.error-state button:hover {
		background: rgba(15, 52, 96, 0.3);
	}

	.graph-svg {
		max-width: 100%;
		height: auto;
		background: var(--bg-secondary);
		border: 1px solid var(--bg-surface);
		border-radius: 8px;
	}

	.edge {
		stroke-linecap: round;
		opacity: 0.5;
		transition: opacity 0.2s ease;
	}

	.node {
		cursor: pointer;
		transition: all 0.2s ease;
		stroke: var(--bg-secondary);
		stroke-width: 1;
	}

	.node.pinned {
		stroke-width: 3;
	}

	.node.summary {
		stroke-width: 2;
	}

	.node.default {
		stroke-width: 1.5;
	}

	.node.detail {
		stroke-width: 1;
	}

	.node:hover {
		filter: brightness(1.2);
	}

	.tooltip {
		position: absolute;
		background: var(--bg-secondary);
		border: 1px solid var(--bg-surface);
		border-radius: 6px;
		padding: 8px 10px;
		font-size: var(--text-xs);
		max-width: 200px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
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

	.tooltip-tier {
		margin-bottom: 4px;
	}

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
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
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
		max-width: 320px;
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
		transition: color 0.2s ease;
	}

	.close-btn:hover {
		color: var(--text-primary);
	}

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
		color: #0066ff;
		text-decoration: none;
		cursor: pointer;
		transition: color 0.2s ease;
	}

	.source-link:hover {
		color: #004499;
	}

	.meta-item .date {
		color: var(--text-secondary);
	}
</style>
