<script lang="ts">
import { ChevronRight } from "lucide-svelte";
import { SECTION_COLORS } from "../lib/context-colors";
import InfoPopover from "./InfoPopover.svelte";

interface Props {
	sections: Array<{
		name: string;
		tokens: number;
		children?: Array<{ name: string; tokens: number }>;
	}>;
	contextWindow: number;
	/** Actual LLM-reported total; when present, drives the drift row + real free space. */
	actualTotalTokens?: number;
}

const { sections, contextWindow, actualTotalTokens }: Props = $props();

/** Terse, declarative explanations keyed by section name. */
const SECTION_INFO: Record<string, string> = {
	system:
		"Stable system prefix: persona, orientation, DB schema, skill body. Cached across threads.",
	"volatile-prefix":
		"Stable volatile half: Working Knowledge, Discoverable Archive titles, skill index. Rides the system cache breakpoint.",
	"ancient-marker": "Oldest history, shed to a fixed-size summary marker plus drop count.",
	"middle-digest":
		"Older tool cycles folded to a one-line action log. Recall preserved; no LLM summary.",
	history: "Recent messages at full resolution — the working set this turn.",
	"volatile-tail":
		"Varying volatile half: Live State, memory deltas, per-turn injectables. Developer-role tail.",
	tools: "Tool-definition JSON schemas, sent at the request level.",
	"free space": "Unused budget below the context window.",
	user: "User-role messages in the recent window.",
	assistant: "Assistant and tool-call messages in the recent window.",
	tool_result: "Tool-result messages in the recent window.",
	memory: "Semantic-memory entries in the volatile tail.",
	"volatile-other": "Live State, digests, per-turn injectables in the volatile tail.",
	"task-digest": "Cross-thread task digest lines.",
};

let expandedSections = $state(new Set<string>());

function toggleSection(name: string): void {
	const next = new Set(expandedSections);
	if (next.has(name)) next.delete(name);
	else next.add(name);
	expandedSections = next;
}

const estimatedTokens = $derived(sections.reduce((s: number, sec) => s + sec.tokens, 0));
// Drift = real wire total − summed section estimates. Shown as its own row so
// the list's free-space figure agrees with the headline's actual percentage;
// we have no per-section actuals, so attributing drift to a single row is the
// honest representation rather than scaling each section by a guessed ratio.
const driftTokens = $derived(
	actualTotalTokens != null ? Math.max(0, actualTotalTokens - estimatedTokens) : 0,
);
const driftPct = $derived(contextWindow > 0 ? (driftTokens / contextWindow) * 100 : 0);
const usedTokens = $derived(actualTotalTokens != null ? actualTotalTokens : estimatedTokens);
const freeTokens = $derived(Math.max(0, contextWindow - usedTokens));
const freePct = $derived(contextWindow > 0 ? (freeTokens / contextWindow) * 100 : 0);
</script>

<div class="section-list">
	{#each sections as section}
		{@const pct = contextWindow > 0 ? (section.tokens / contextWindow) * 100 : 0}
		{@const expandable = !!(section.children && section.children.length > 0)}
		<div class="section-row" class:expandable>
			<div
				class="section-lead"
				class:clickable={expandable}
				role={expandable ? "button" : undefined}
				tabindex={expandable ? 0 : undefined}
				onclick={() => (expandable ? toggleSection(section.name) : undefined)}
				onkeydown={(e) => {
					if (expandable && (e.key === "Enter" || e.key === " ")) {
						e.preventDefault();
						toggleSection(section.name);
					}
				}}
			>
				{#if expandable}
					<span class="chevron" class:expanded={expandedSections.has(section.name)}>
						<ChevronRight size={12} />
					</span>
				{/if}
				<span class="dot" style="background: {SECTION_COLORS[section.name] ?? 'var(--text-muted)'}"></span>
				{#if SECTION_INFO[section.name]}
					<InfoPopover placement="bottom" label={SECTION_INFO[section.name]}>
						{#snippet trigger()}<span class="name">{section.name}</span>{/snippet}
					</InfoPopover>
				{:else}
					<span class="name">{section.name}</span>
				{/if}
			</div>
			<span class="tokens">{section.tokens.toLocaleString()}</span>
			<span class="pct">{pct.toFixed(1)}%</span>
		</div>
		{#if section.children && expandedSections.has(section.name)}
			{#each section.children as child}
				{@const childPct = contextWindow > 0 ? (child.tokens / contextWindow) * 100 : 0}
				<div class="section-row child">
					<span class="indent"></span>
					<span class="dot small" style="background: {SECTION_COLORS[section.name] ?? 'var(--text-muted)'}; opacity: 0.6;"></span>
					{#if SECTION_INFO[child.name]}
						<InfoPopover placement="bottom" label={SECTION_INFO[child.name]}>
							{#snippet trigger()}<span class="name">{child.name}</span>{/snippet}
						</InfoPopover>
					{:else}
						<span class="name">{child.name}</span>
					{/if}
					<span class="tokens">{child.tokens.toLocaleString()}</span>
					<span class="pct">{childPct.toFixed(1)}%</span>
				</div>
			{/each}
		{/if}
	{/each}

	{#if driftTokens > 0}
		<div class="section-row">
			<div class="section-lead">
				<span class="dot drift-dot"></span>
				<InfoPopover
					placement="top"
					label="Actual wire total minus the summed section estimates. The cl100k_base estimator under-counts non-uniformly (thinking-heavy history most), so this gap can't be attributed to one section."
				>
					{#snippet trigger()}<span class="name">estimator drift</span>{/snippet}
				</InfoPopover>
			</div>
			<span class="tokens">{driftTokens.toLocaleString()}</span>
			<span class="pct">{driftPct.toFixed(1)}%</span>
		</div>
	{/if}

	{#if freeTokens > 0}
		<div class="section-row">
			<div class="section-lead">
				<span class="dot" style="background: var(--text-muted); opacity: 0.3;"></span>
				<InfoPopover placement="top" label={SECTION_INFO["free space"]}>
					{#snippet trigger()}<span class="name">free space</span>{/snippet}
				</InfoPopover>
			</div>
			<span class="tokens">{freeTokens.toLocaleString()}</span>
			<span class="pct">{freePct.toFixed(1)}%</span>
		</div>
	{/if}
</div>

<style>
	.section-list {
		margin-bottom: 16px;
	}

	.section-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		font-size: 11.5px;
		border-bottom: 1px solid var(--rule-faint);
	}

	.section-row.child {
		padding-left: 20px;
	}

	.section-lead {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--ink);
		flex: 1;
		min-width: 0;
		font-size: 11.5px;
		font-family: var(--font-display);
	}

	.section-lead.clickable {
		cursor: pointer;
	}

	.section-lead.clickable:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.chevron {
		font-size: 10px;
		transition: transform 0.15s;
		display: inline-block;
		width: 10px;
		color: var(--ink-3);
	}

	.chevron.expanded {
		transform: rotate(90deg);
	}

	.dot {
		width: 6px;
		height: 12px;
		border-radius: 0;
		flex-shrink: 0;
	}

	.dot.small {
		width: 5px;
		height: 9px;
	}

	/* Hatched marker for the estimator-drift row — matches the bar segment. */
	.drift-dot {
		background-image: repeating-linear-gradient(
			-45deg,
			var(--warn) 0,
			var(--warn) 1px,
			transparent 1px,
			transparent 4px
		);
		background-color: var(--paper-3);
	}

	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tokens {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: 11px;
		color: var(--ink-2);
		text-align: right;
		min-width: 56px;
	}

	.pct {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--ink-4);
		text-align: right;
		min-width: 40px;
	}

	.indent {
		width: 10px;
	}
</style>
