<script lang="ts">
import {
	Background,
	BackgroundVariant,
	Controls,
	type Edge,
	MiniMap,
	type Node,
	SvelteFlow,
} from "@xyflow/svelte";
import "@xyflow/svelte/dist/style.css";
import type { YardTreeSnapshot } from "../lib/yard-execution";
import { yardTreeToFlow } from "../lib/yard-graph";
import YardFlowNode from "./YardFlowNode.svelte";

const { tree }: { tree: YardTreeSnapshot } = $props();
const flow = $derived(yardTreeToFlow(tree));
const nodeTypes = { yard: YardFlowNode };
const heading = $derived(tree.phase === "started" ? "Yard execution" : `Yard ${tree.phase}`);
</script>

<section class="yard-execution-panel" class:live={tree.phase === "started"} data-trace-id={tree.traceId}>
	<header>
		<div>
			<span class="eyebrow">{heading}</span>
			<span class="trace mono">{tree.traceId.slice(0, 8)}</span>
		</div>
		<span class:failed={tree.phase === "failed"} class="phase">{tree.phase}</span>
	</header>
	{#if tree.compact}
		<div class="compact-result">
			<strong>Completed execution</strong>
			<span>Detailed lifecycle data is unavailable for this older result.</span>
		</div>
	{:else}
		<div class="flow-wrap">
			<SvelteFlow
				id={`yard-${tree.traceId}`}
				nodeTypes={nodeTypes}
				nodes={flow.nodes as Node[]}
				edges={flow.edges as Edge[]}
				fitView
				fitViewOptions={{ padding: 0.25 }}
				minZoom={0.2}
				maxZoom={1.5}
				nodesDraggable={false}
				nodesConnectable={false}
				elementsSelectable={false}
			>
				<Background variant={BackgroundVariant.Dots} gap={16} size={1} />
				<Controls showInteractive={false} />
				<MiniMap pannable zoomable />
			</SvelteFlow>
		</div>
	{/if}
	{#if tree.summary}
		<p class="summary">{tree.summary}</p>
	{/if}
</section>

<style>
	.yard-execution-panel {
		margin: 8px 0 20px;
		border: 1px solid var(--rule-soft);
		background: var(--paper);
		box-shadow: 3px 3px 0 color-mix(in srgb, var(--ink) 10%, transparent);
	}

	.yard-execution-panel.live { border-color: var(--accent); }
	.yard-execution-panel header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 9px 12px;
		border-bottom: 1px solid var(--rule-soft);
	}
	.eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
	.trace { margin-left: 8px; color: var(--ink-2); font-size: 11px; }
	.phase { font: 600 11px var(--font-mono); color: var(--ink-2); text-transform: uppercase; }
	.phase.failed { color: var(--accent); }
	.flow-wrap { height: 300px; width: 100%; }
	.compact-result { display: grid; gap: 4px; padding: 14px 12px; font-size: 12px; color: var(--ink-2); }
	.compact-result strong { color: var(--ink); }
	.summary { margin: 0; padding: 9px 12px; border-top: 1px solid var(--rule-soft); color: var(--ink-2); font-size: 12px; white-space: pre-wrap; }
	:global(.yard-execution-panel .svelte-flow__node) {
		border: 1px solid var(--ink-2);
		border-radius: 2px;
		background: var(--paper);
		color: var(--ink);
		font: 12px var(--font-mono);
		box-shadow: 2px 2px 0 color-mix(in srgb, var(--ink) 10%, transparent);
	}
	:global(.yard-execution-panel .yard-node-started) { border-color: var(--accent); }
	:global(.yard-execution-panel .yard-node-completed) { border-color: #3b7d57; }
	:global(.yard-execution-panel .yard-node-failed) { border-color: #b23a48; color: #8a1f2a; }
	:global(.yard-execution-panel .yard-edge-failed .svelte-flow__edge-path) { stroke: #b23a48; }
	:global(.yard-execution-panel .svelte-flow__controls), :global(.yard-execution-panel .svelte-flow__minimap) { border: 1px solid var(--rule-soft); box-shadow: none; }
</style>
