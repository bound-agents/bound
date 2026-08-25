<script lang="ts">
import { Handle, type NodeProps, Position } from "@xyflow/svelte";

const { data }: NodeProps = $props();
const yard = $derived(
	data as {
		label: string;
		kind: "run" | "tool" | "inference" | "unknown";
		phase: "unknown" | "started" | "completed" | "failed" | "settled";
		summary?: string;
	},
);
const kindIcon = $derived({ run: "◇", tool: "⌘", inference: "✦", unknown: "?" }[yard.kind]);
const statusIcon = $derived(
	{ unknown: "○", started: "◌", completed: "✓", failed: "!", settled: "•" }[yard.phase],
);
const statusText = $derived(
	{
		unknown: "Pending",
		started: "Running",
		completed: "Complete",
		failed: "Failed",
		settled: "Settled",
	}[yard.phase],
);
</script>

<Handle type="target" position={Position.Left} aria-label="Input" />
<article class="yard-flow-node {yard.kind} {yard.phase}" aria-label={`${yard.label}, ${statusText}`}>
	<span class="rail" aria-hidden="true"></span>
	<div class="node-head">
		<span class="kind-icon" aria-hidden="true">{kindIcon}</span>
		<strong>{yard.label}</strong>
	</div>
	<div class="status"><span aria-hidden="true">{statusIcon}</span> {statusText}</div>
	{#if yard.summary}<p>{yard.summary}</p>{/if}
</article>
<Handle type="source" position={Position.Right} aria-label="Output" />

<style>
	.yard-flow-node {
		--state: var(--idle);
		position: relative;
		display: grid;
		gap: 4px;
		width: 184px;
		min-height: 68px;
		padding: 9px 10px 9px 14px;
		border: 1px solid var(--rule-soft);
		border-radius: 6px;
		background: var(--paper);
		box-shadow: 2px 2px 0 color-mix(in srgb, var(--ink) 8%, transparent);
		color: var(--ink);
		font: 12px var(--font-mono);
	}
	.rail { position: absolute; inset: -1px auto -1px -1px; width: 4px; border-radius: 6px 0 0 6px; background: var(--state); }
	.node-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
	.kind-icon { width: 13px; color: var(--ink-2); text-align: center; }
	strong { overflow: hidden; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
	.status { color: var(--state); font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
	p { display: -webkit-box; margin: 1px 0 0; overflow: hidden; color: var(--ink-2); font-size: 10px; line-height: 1.3; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
	.run { background: color-mix(in srgb, var(--paper) 88%, var(--ink)); }
	.inference .kind-icon { color: var(--accent); }
	.unknown { --state: var(--idle); }
	.started { --state: var(--warn); }
	.completed { --state: var(--ok); }
	.settled { --state: var(--ink-2); }
	.failed { --state: var(--err); }
	:global(.svelte-flow__handle) { width: 7px; height: 7px; border: 1px solid var(--paper); background: var(--ink-2); }
	@media (prefers-reduced-motion: reduce) { :global(.svelte-flow__handle) { transition: none; } }
</style>
