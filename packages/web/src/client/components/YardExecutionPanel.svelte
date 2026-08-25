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
import { tick } from "svelte";
import { type YardTreeSnapshot, yardProgress } from "../lib/yard-execution";
import { yardTreeToFlow } from "../lib/yard-graph";
import { formatYardInspectorValue, formatYardValue } from "../lib/yard-result";
import YardCodeBlock from "./YardCodeBlock.svelte";
import YardFlowNode from "./YardFlowNode.svelte";

const { tree }: { tree: YardTreeSnapshot } = $props();
const flow = $derived(yardTreeToFlow(tree));
const nodeTypes = { yard: YardFlowNode, yardGroup: YardFlowNode };
const heading = $derived(tree.phase === "started" ? "Yard execution" : `Yard ${tree.phase}`);
const counts = $derived(yardProgress(tree));
const result = $derived.by(() => {
	const raw = tree.resultPreview ?? tree.summary;
	return raw ? formatYardValue(raw) : null;
});
function formatDetail(key: string, value: unknown) {
	const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return formatYardInspectorValue(raw, key);
}
const statusText = $derived(
	tree.phase === "started" ? "Running" : tree.phase === "failed" ? "Failed" : "Complete",
);
const showMiniMap = $derived(flow.nodes.length > 8);
// Remount only when topology geometry changes so SvelteFlow's initial fitView observes
// the settled layout; phase-only lifecycle updates preserve a reader's pan and zoom.
const flowStructure = $derived(
	flow.nodes
		.map((node) =>
			[
				node.id,
				node.parentId ?? "",
				node.position.x,
				node.position.y,
				node.width ?? "",
				node.height ?? "",
			].join(":"),
		)
		.join("|"),
);
let selectedId = $state<string | null>(null);
let triggerId = $state<string | null>(null);
let panel = $state<HTMLElement | null>(null);
let announcedStatus = $state("");
const inspectorId = (nodeId: string) => `yard-inspector-${tree.traceId}-${nodeId}`;
const nodeTriggerId = (nodeId: string) => `yard-node-${tree.traceId}-${nodeId}`;
const nodes = $derived(
	flow.nodes.map((node) => ({
		...node,
		data: {
			...node.data,
			selected: node.id === selectedId,
			inspectorId: inspectorId(node.id),
			triggerId: nodeTriggerId(node.id),
		},
	})),
);
const progressStatus = $derived(
	`Yard execution${tree.phase === "started" ? "" : ` ${tree.phase}`}: ${counts.settled} of ${counts.total} nodes settled; ${counts.running} running; ${counts.failed} failed`,
);
$effect(() => {
	if (selectedId && !flow.nodes.some((node) => node.id === selectedId)) {
		selectedId = null;
		triggerId = null;
	}
});
$effect(() => {
	const timer = setTimeout(() => {
		announcedStatus = progressStatus;
	}, 200);
	return () => clearTimeout(timer);
});
$effect(() => {
	if (!selected) return;
	const id = inspectorId(selected.id);
	tick().then(() => {
		const element = document.getElementById(id);
		if (element && panel?.contains(element) && selectedId === selected.id) element.focus();
	});
});
const selected = $derived(flow.nodes.find((node) => node.id === selectedId) ?? null);
function closeInspector() {
	selectedId = null;
	const element = triggerId ? document.getElementById(triggerId) : null;
	if (element instanceof HTMLElement && panel?.contains(element)) element.focus();
	triggerId = null;
}
function selectNode(event: { node: { id: string }; event?: Event }) {
	triggerId = nodeTriggerId(event.node.id);
	selectedId = selectedId === event.node.id ? null : event.node.id;
}
const miniMapNodeColor = (node: Node) => {
	switch ((node.data as { kind?: string }).kind) {
		case "run":
			return "var(--line-6)";
		case "tool":
			return "var(--line-3)";
		case "inference":
			return "var(--line-9)";
		case "aux":
			return "var(--line-7)";
		case "group":
			return "var(--line-4)";
		default:
			return "var(--idle)";
	}
};
</script>

<section bind:this={panel} class="yard-execution-panel {tree.phase}" onkeydown={(event) => event.key === "Escape" && selectedId && closeInspector()} aria-labelledby={`yard-title-${tree.traceId}`} data-trace-id={tree.traceId}>
	<header>
		<div class="title-group">
			<span class="eyebrow" id={`yard-title-${tree.traceId}`}>{heading}</span>
			<span class="trace mono">trace {tree.traceId.slice(0, 8)}</span>
		</div>
		<span class="phase-chip" aria-label={`Execution status: ${statusText}`}><span aria-hidden="true"></span>{statusText}</span>
	</header>
	<div class="progress">
		<span>{counts.settled}/{counts.total} nodes settled</span>
		{#if counts.running}<span>{counts.running} running</span>{/if}
		{#if counts.failed}<span class="failure-count">{counts.failed} failed</span>{/if}
	</div>
	<p class="sr-only" aria-live="polite" aria-atomic="true">{announcedStatus}</p>
	<div class="flow-wrap">
		{#key flowStructure}
			<SvelteFlow id={`yard-${tree.traceId}`} nodeTypes={nodeTypes} nodes={nodes as Node[]} edges={flow.edges as Edge[]} fitView fitViewOptions={{ padding: 0.28 }} minZoom={0.2} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} elementsSelectable={true} onnodeclick={selectNode} onpaneclick={() => selectedId && closeInspector()}>
				<Background variant={BackgroundVariant.Dots} gap={16} size={1} />
				<Controls showInteractive={false} />
				{#if showMiniMap}<MiniMap pannable zoomable nodeColor={miniMapNodeColor} aria-label="Yard graph overview" />{/if}
			</SvelteFlow>
		{/key}
	</div>
	{#if selected}
		<aside id={inspectorId(selected.id)} class="yard-inspector" aria-labelledby={`${inspectorId(selected.id)}-heading`} tabindex="-1">
			<div class="inspector-heading"><strong id={`${inspectorId(selected.id)}-heading`}>{selected.data.label}</strong><button onclick={closeInspector} aria-label="Close details">×</button></div>
			<p>{selected.data.kind} · {selected.data.phase}</p>
			{#if selected.data.detail}
				{#each Object.entries(selected.data.detail) as [key, value]}
					{@const formatted = formatDetail(key, value)}
					<div class="detail-field">
						<div class="detail-heading"><strong>{key}</strong><span>{formatted.hint}</span></div>
						<YardCodeBlock code={formatted.display} lang={formatted.lang} />
						{#if formatted.tail}<p class="detail-tail">{formatted.tail}</p>{/if}
					</div>
				{/each}
			{:else if selected.data.summary}<p>{selected.data.summary}</p>{:else}<p>This region is dynamic or has no additional static detail.</p>{/if}
		</aside>
	{/if}
	{#if result}
		<footer>
			<details>
				<summary><span class="result-title"><span class="disclosure-caret" aria-hidden="true">▸</span>Result</span><span class="result-hint">{result.hint}</span></summary>
				<YardCodeBlock code={result.display} lang={result.isJson ? "json" : "text"} />
				{#if result.tail}<p class="result-tail">{result.tail}</p>{/if}
			</details>
		</footer>
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
	.phase-chip { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 5px; padding: 3px 6px; border: 1px solid color-mix(in srgb, var(--state) 55%, var(--rule-soft)); border-radius: 99px; background: color-mix(in srgb, var(--state) 10%, var(--paper)); color: var(--state); font: 700 10px var(--font-mono); letter-spacing: .04em; text-transform: uppercase; }
	.phase-chip span { width: 6px; height: 6px; border-radius: 50%; background: var(--state); }
	.progress { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 6px 12px; border-bottom: 1px solid var(--rule-soft); color: var(--ink-2); font: 10px var(--font-mono); }
	.failure-count { color: var(--err); }
	.flow-wrap { height: clamp(240px, 38vw, 440px); width: 100%; }
	footer { padding: 0; border-top: 1px solid var(--rule-soft); }
	.yard-inspector { margin: 0; padding: 10px 12px; border-top: 1px solid var(--rule-soft); background: var(--paper-2); color: var(--ink-2); font: 11px/1.4 var(--font-mono); }
	.inspector-heading { display: flex; justify-content: space-between; color: var(--ink); } .inspector-heading button { border: 1px solid var(--rule-soft); background: var(--paper); color: var(--ink); cursor: pointer; } .yard-inspector p { margin: 4px 0; } .detail-field { margin-top: 10px; } .detail-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 4px; color: var(--ink); font-size: 10px; letter-spacing: .07em; text-transform: uppercase; } .detail-heading span { overflow: hidden; color: var(--ink-2); font-weight: 400; letter-spacing: 0; text-overflow: ellipsis; text-transform: none; white-space: nowrap; } .detail-tail { margin: 0; padding: 8px 12px; border: 1px solid var(--rule-soft); border-top: 0; color: var(--ink-2); font: 10px var(--font-mono); }
	details { min-width: 0; }
	summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 12px; cursor: pointer; color: var(--ink-2); font: 700 10px var(--font-mono); letter-spacing: .07em; list-style: none; text-transform: uppercase; }
	summary::-webkit-details-marker { display: none; }
	.result-title { display: inline-flex; align-items: center; gap: 5px; }
	.disclosure-caret { color: var(--state); font-size: 12px; line-height: 1; transition: transform 120ms ease; }
	details[open] .disclosure-caret { transform: rotate(90deg); }
	summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
	.result-hint { overflow: hidden; font-weight: 400; letter-spacing: 0; text-overflow: ellipsis; text-transform: none; white-space: nowrap; }
	.result-tail { margin: 0; padding: 8px 12px; border-top: 1px solid var(--rule-soft); color: var(--ink-2); font: 10px var(--font-mono); }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
	:global(.yard-execution-panel .svelte-flow__node) { border: 0; border-radius: 6px; background: transparent; box-shadow: none; }
	:global(.yard-execution-panel .svelte-flow__edge-path) { stroke: var(--idle); stroke-width: 1.4; }
	:global(.yard-execution-panel .yard-edge-started .svelte-flow__edge-path) { stroke: var(--warn); }
	:global(.yard-execution-panel .yard-edge-completed .svelte-flow__edge-path) { stroke: var(--ok); }
	:global(.yard-execution-panel .yard-edge-failed .svelte-flow__edge-path) { stroke: var(--err); }
	:global(.yard-execution-panel .svelte-flow__controls), :global(.yard-execution-panel .svelte-flow__minimap) { border: 1px solid var(--rule-soft); border-radius: 4px; background: var(--paper); box-shadow: 1px 1px 0 color-mix(in srgb, var(--ink) 8%, transparent); }
	:global(.yard-execution-panel .svelte-flow__controls-button) { border-color: var(--rule-soft); fill: var(--ink-2); }
	@media (max-width: 640px) { .flow-wrap { height: clamp(220px, 70vw, 320px); } :global(.yard-execution-panel .svelte-flow__minimap) { display: none; } .trace { max-width: 86px; } }
	@media (prefers-reduced-motion: reduce) { .disclosure-caret { transition: none; } :global(.yard-execution-panel .svelte-flow__edge.animated path) { animation: none; } }
</style>
