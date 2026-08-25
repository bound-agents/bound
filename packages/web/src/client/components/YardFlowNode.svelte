<script lang="ts">
import { Handle, type NodeProps, Position } from "@xyflow/svelte";

const { data }: NodeProps = $props();
const yard = $derived(
	data as {
		label: string;
		kind: "run" | "tool" | "inference" | "aux" | "unknown" | "result" | "group";
		construct?: "all" | "sequence";
		ordinal?: number;
		parallelCount?: number;
		phase: "unknown" | "started" | "completed" | "failed" | "settled";
		summary?: string;
		selected?: boolean;
		inspectorId?: string;
		triggerId?: string;
	},
);
const kindIcon = $derived(
	{ run: "◆", tool: "⚙", inference: "✦", aux: "⇄", unknown: "?", result: "⊣", group: "▧" }[
		yard.kind
	],
);
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

{#if yard.kind === "group"}
	<Handle type="target" position={Position.Left} aria-label="Input" />
	<button id={yard.triggerId} data-yard-node-id={yard.triggerId} class="yard-flow-group {yard.phase} {yard.selected ? "selected" : ""}" aria-label={`${yard.label}, ${statusText}. ${yard.selected ? "Close" : "Open"} details`} aria-expanded={yard.selected ?? false} aria-controls={yard.selected ? yard.inspectorId : undefined}>
		<span class="group-label">{yard.label}{#if yard.parallelCount !== undefined}<em>parallel ×{yard.parallelCount}</em>{/if}</span><small>{statusText}</small>
	</button>
	<Handle type="source" position={Position.Right} aria-label="Output" />
{:else}
<Handle type="target" position={Position.Left} aria-label="Input" />
<button id={yard.triggerId} data-yard-node-id={yard.triggerId} class="yard-flow-node {yard.kind} {yard.phase} {yard.selected ? "selected" : ""}" aria-label={`${yard.label}, ${statusText}. ${yard.selected ? "Close" : "Open"} details`} aria-expanded={yard.selected ?? false} aria-controls={yard.selected ? yard.inspectorId : undefined}>
	<span class="rail" aria-hidden="true"></span>
	<div class="node-row node-head">
		<span class="kind-icon" aria-hidden="true">{kindIcon}</span>
		<strong>{#if yard.ordinal !== undefined}<em class="ordinal">{yard.ordinal}</em>{/if}{yard.label}</strong>
	</div>
	<div class="node-row status"><span class="status-icon" aria-hidden="true">{statusIcon}</span><span>{statusText}</span></div>
	{#if yard.summary}<p>{yard.summary}</p>{/if}
</button>
<Handle type="source" position={Position.Right} aria-label="Output" />
{/if}

<style>
	.yard-flow-group { --state: var(--idle); box-sizing: border-box; display: flex; align-items: flex-start; justify-content: space-between; width: 100%; height: 100%; padding: 7px 9px; border: 1px dashed color-mix(in srgb, var(--state) 60%, var(--line-4)); border-radius: 8px; background: color-mix(in srgb, var(--line-4) 10%, transparent); color: var(--ink-2); font: 700 10px var(--font-mono); letter-spacing: .06em; text-transform: uppercase;  }
	.yard-flow-group { --kind: var(--line-4); }
	.yard-flow-group small { color: var(--state); font-size: 9px; }
	.group-label { display: inline-flex; align-items: center; gap: 6px; }
	.group-label em, .ordinal { font-style: normal; }
	.group-label em { padding: 1px 4px; border: 1px solid color-mix(in srgb, var(--kind) 60%, var(--line-4)); border-radius: 999px; background: color-mix(in srgb, var(--kind) 12%, transparent); color: var(--kind); font-size: 8px; letter-spacing: 0; text-transform: none; }
	.ordinal { display: inline-grid; width: 14px; height: 14px; place-items: center; margin-right: 5px; border-radius: 50%; background: color-mix(in srgb, var(--line-4) 18%, transparent); color: var(--ink-2); font-size: 9px; vertical-align: 1px; }
	.yard-flow-node {
		--kind: var(--idle);
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
		text-align: left;
		cursor: pointer;
	}
	.rail { position: absolute; inset: -1px auto -1px -1px; width: 4px; border-radius: 6px 0 0 6px; background: var(--kind); }
	.node-row { display: grid; grid-template-columns: 16px minmax(0, 1fr); column-gap: 6px; align-items: center; min-width: 0; }
	.kind-icon, .status-icon { width: 16px; color: var(--kind); text-align: center; }
	strong { overflow: hidden; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
	.status { color: var(--state); font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
	.status-icon { color: currentColor; }
	p { display: -webkit-box; margin: 1px 0 0 22px; overflow: hidden; color: var(--ink-2); font-size: 10px; line-height: 1.3; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
	.run { --kind: var(--line-6); background: color-mix(in srgb, var(--paper) 88%, var(--line-6)); }
	.tool { --kind: var(--line-3); }
	.inference { --kind: var(--line-9); }
	.aux { --kind: var(--line-7); }
	.unknown { --kind: var(--idle); }
	.result { --kind: var(--line-2); border-style: double; background: color-mix(in srgb, var(--paper) 86%, var(--line-2)); }
	.yard-flow-node:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	/* Selection follows the inspector state, rather than SvelteFlow's transient hover state. */
	.yard-flow-node.selected, .yard-flow-group.selected { outline: 2px solid var(--kind); outline-offset: 2px; box-shadow: 0 4px 0 color-mix(in srgb, var(--kind) 30%, transparent), 2px 3px 0 color-mix(in srgb, var(--ink) 14%, transparent); transform: scale(1.015); z-index: 2; }
	.yard-flow-node.selected::after, .yard-flow-group.selected::after { position: absolute; top: -5px; right: -5px; width: 8px; height: 8px; border: 2px solid var(--paper); border-radius: 50%; background: var(--kind); content: ""; }
	.yard-flow-group.selected { border-style: solid; }
	.started { --state: var(--warn); }
	.completed { --state: var(--ok); }
	.settled { --state: var(--idle); }
	.failed { --state: var(--err); }
	:global(.svelte-flow__handle) { width: 7px; height: 7px; border: 1px solid var(--paper); background: var(--kind); }
	@media (prefers-reduced-motion: reduce) { .yard-flow-node.selected, .yard-flow-group.selected { transform: none; } :global(.svelte-flow__handle) { transition: none; } }
</style>
