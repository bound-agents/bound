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
const counts = $derived({
	total: flow.nodes.length,
	completed: flow.nodes.filter((node) => node.data.phase === "completed").length,
	failed: flow.nodes.filter((node) => node.data.phase === "failed").length,
	running: flow.nodes.filter((node) => node.data.phase === "started").length,
});
const statusText = $derived(
	tree.phase === "started" ? "Running" : tree.phase === "failed" ? "Failed" : "Complete",
);
const showMiniMap = $derived(flow.nodes.length > 8);
</script>

<section class="yard-execution-panel {tree.phase}" aria-labelledby={`yard-title-${tree.traceId}`} data-trace-id={tree.traceId}>
	<header>
		<div class="title-group">
			<span class="eyebrow" id={`yard-title-${tree.traceId}`}>{heading}</span>
			<span class="trace mono">trace {tree.traceId.slice(0, 8)}</span>
		</div>
		<span class="phase-chip" aria-label={`Execution status: ${statusText}`}><span aria-hidden="true"></span>{statusText}</span>
	</header>
	<div class="progress" aria-live="polite" aria-atomic="true">
		<span>{counts.completed + counts.failed}/{counts.total} nodes settled</span>
		{#if counts.running}<span>{counts.running} running</span>{/if}
		{#if counts.failed}<span class="failure-count">{counts.failed} failed</span>{/if}
	</div>
	<div class="flow-wrap">
		<SvelteFlow id={`yard-${tree.traceId}`} nodeTypes={nodeTypes} nodes={flow.nodes as Node[]} edges={flow.edges as Edge[]} fitView fitViewOptions={{ padding: 0.28 }} minZoom={0.2} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}>
			<Background variant={BackgroundVariant.Dots} gap={16} size={1} />
			<Controls showInteractive={false} />
			{#if showMiniMap}<MiniMap pannable zoomable aria-label="Yard graph overview" />{/if}
		</SvelteFlow>
	</div>
	<ul class="sr-only" aria-label="Yard execution nodes">
		{#each flow.nodes as node}<li>{node.data.label}: {node.data.phase}{node.data.summary ? ` — ${node.data.summary}` : ""}</li>{/each}
	</ul>
	{#if tree.summary || tree.resultPreview}
		<footer><span>Result</span><p>{tree.summary ?? tree.resultPreview}</p></footer>
	{/if}
</section>

<style>
	.yard-execution-panel { --state: var(--idle); margin: 8px 0 20px; border: 1px solid var(--rule-soft); background: var(--paper); box-shadow: 3px 3px 0 color-mix(in srgb, var(--ink) 9%, transparent); }
	.yard-execution-panel.started { --state: var(--warn); }
	.yard-execution-panel.completed { --state: var(--ok); }
	.yard-execution-panel.failed { --state: var(--err); }
	header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--rule-soft); background: var(--paper-2); }
	.title-group { display: flex; min-width: 0; align-items: baseline; gap: 8px; }
	.eyebrow { font-size: 11px; font-weight: 750; letter-spacing: .09em; text-transform: uppercase; }
	.trace { overflow: hidden; color: var(--ink-2); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
	.phase-chip { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 5px; padding: 3px 6px; border: 1px solid color-mix(in srgb, var(--state) 55%, var(--rule-soft)); border-radius: 99px; color: var(--state); font: 700 10px var(--font-mono); letter-spacing: .04em; text-transform: uppercase; }
	.phase-chip span { width: 6px; height: 6px; border-radius: 50%; background: var(--state); }
	.progress { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 6px 12px; border-bottom: 1px solid var(--rule-soft); color: var(--ink-2); font: 10px var(--font-mono); }
	.failure-count { color: var(--err); }
	.flow-wrap { height: clamp(240px, 38vw, 440px); width: 100%; }
	footer { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 8px; padding: 9px 12px; border-top: 1px solid var(--rule-soft); }
	footer span { color: var(--ink-2); font: 700 10px var(--font-mono); letter-spacing: .07em; text-transform: uppercase; }
	footer p { margin: 0; color: var(--ink-2); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
	:global(.yard-execution-panel .svelte-flow__node) { border: 0; border-radius: 6px; background: transparent; box-shadow: none; }
	:global(.yard-execution-panel .svelte-flow__edge-path) { stroke: var(--idle); stroke-width: 1.4; }
	:global(.yard-execution-panel .yard-edge-started .svelte-flow__edge-path) { stroke: var(--warn); }
	:global(.yard-execution-panel .yard-edge-completed .svelte-flow__edge-path) { stroke: var(--ok); }
	:global(.yard-execution-panel .yard-edge-failed .svelte-flow__edge-path) { stroke: var(--err); }
	:global(.yard-execution-panel .svelte-flow__controls), :global(.yard-execution-panel .svelte-flow__minimap) { border: 1px solid var(--rule-soft); border-radius: 4px; background: var(--paper); box-shadow: 1px 1px 0 color-mix(in srgb, var(--ink) 8%, transparent); }
	:global(.yard-execution-panel .svelte-flow__controls-button) { border-color: var(--rule-soft); fill: var(--ink-2); }
	@media (max-width: 640px) { .flow-wrap { height: clamp(220px, 70vw, 320px); } :global(.yard-execution-panel .svelte-flow__minimap) { display: none; } .trace { max-width: 86px; } }
	@media (prefers-reduced-motion: reduce) { :global(.yard-execution-panel .svelte-flow__edge.animated path) { animation: none; } }
</style>
