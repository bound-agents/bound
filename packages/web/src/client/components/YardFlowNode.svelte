<script lang="ts">
import { Handle, type NodeProps, Position } from "@xyflow/svelte";

const { data }: NodeProps = $props();
const yard = $derived(
	data as { label: string; phase: "started" | "completed" | "failed"; summary?: string },
);
</script>

<Handle type="target" position={Position.Left} />
<div class="yard-flow-node" class:failed={yard.phase === "failed"} class:running={yard.phase === "started"}>
	<strong>{yard.label}</strong>
	<span>{yard.phase}</span>
	{#if yard.summary}<small>{yard.summary}</small>{/if}
</div>
<Handle type="source" position={Position.Right} />

<style>
	.yard-flow-node { display: grid; gap: 3px; min-width: 130px; }
	strong { font-weight: 600; }
	span { color: var(--ink-2); font-size: 10px; text-transform: uppercase; }
	small { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
	.failed span { color: #b23a48; }
	.running span { color: var(--accent); }
</style>
