<script lang="ts">
import { Check, ChevronDown, ChevronUp, Cog, Wrench } from "lucide-svelte";

interface ToolEntry {
	name: string;
	input: unknown;
	id: string;
	result?: string;
	exitCode?: number | null;
	timestamp?: string;
}

interface TurnRange {
	from: string;
	to: string | null;
}

type ToolGroupSegment =
	| { kind: "tools"; entries: ToolEntry[] }
	| { kind: "reasoning"; text: string };

interface Props {
	segments?: ToolGroupSegment[];
	turnRange?: TurnRange | null;
}

const { segments = [], turnRange = null }: Props = $props();

// Flatten all tool entries for summary
const allEntries = $derived(
	segments.flatMap((s: ToolGroupSegment) => (s.kind === "tools" ? s.entries : [])),
);

function entryInRange(entry: ToolEntry): boolean {
	if (!turnRange || !entry.timestamp) return true;
	if (entry.timestamp < turnRange.from) return false;
	if (turnRange.to !== null && entry.timestamp >= turnRange.to) return false;
	return true;
}

let groupExpanded = $state(false);
let expandedTools = $state(new Set<number>());

function toggleGroup(): void {
	groupExpanded = !groupExpanded;
}

function toggleTool(idx: number): void {
	const next = new Set(expandedTools);
	if (next.has(idx)) {
		next.delete(idx);
	} else {
		next.add(idx);
	}
	expandedTools = next;
}

function formatInput(input: unknown): string {
	if (input === null || input === undefined) return "";
	if (typeof input === "string") return input;
	return JSON.stringify(input, null, 2);
}

function summaryLabel(): string {
	const names = [...new Set(allEntries.map((e: ToolEntry) => e.name))];
	if (names.length <= 3) return names.join(", ");
	return `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
}

const doneCount = $derived(allEntries.filter((e: ToolEntry) => e.result !== undefined).length);
</script>

<div class="tool-group">
	<div
		class="tool-group-header"
		onclick={toggleGroup}
		onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") toggleGroup(); }}
		role="button"
		tabindex={0}
	>
		<span class="tg-icon"><Cog size={14} /></span>
		<span class="tg-summary">{summaryLabel()}</span>
		<span class="tg-count">
			{allEntries.length} call{allEntries.length > 1 ? "s" : ""}
			{#if doneCount === allEntries.length}<Check size={12} class="tg-check" />{/if}
		</span>
		<span class="tg-toggle">{#if groupExpanded}<ChevronUp size={12} />{:else}<ChevronDown size={12} />{/if}</span>
	</div>

	{#if groupExpanded}
		{@const globalIdx = { value: 0 }}
		{#each segments as segment}
			{#if segment.kind === "reasoning"}
				<div class="reasoning-bubble">
					<p class="reasoning-text">{segment.text}</p>
				</div>
			{:else}
				<div class="tool-list">
					{#each segment.entries as entry}
						{@const idx = globalIdx.value++}
						<div class="tool-row" class:tool-row-expanded={expandedTools.has(idx)} class:tool-row-dimmed={turnRange !== null && !entryInRange(entry)}>
							<div
								class="tool-row-header"
								onclick={() => toggleTool(idx)}
								onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") toggleTool(idx); }}
								role="button"
								tabindex={0}
							>
								<span class="tr-icon"><Wrench size={12} /></span>
								<span class="tr-name">{entry.name}</span>
								{#if entry.result !== undefined}
									<span class="tr-done" class:tr-error={entry.exitCode != null && entry.exitCode !== 0}><Check size={11} /></span>
								{/if}
								<span class="tr-toggle">{#if expandedTools.has(idx)}<ChevronUp size={11} />{:else}<ChevronDown size={11} />{/if}</span>
							</div>

							{#if expandedTools.has(idx)}
								<pre class="tr-input">{formatInput(entry.input)}</pre>
								{#if entry.result !== undefined}
									<div class="tr-divider"></div>
									<pre class="tr-output" class:tr-output-error={entry.exitCode != null && entry.exitCode !== 0}>{entry.result}</pre>
								{/if}
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		{/each}
	{/if}
</div>

<style>
	.tool-group {
		position: relative;
		margin: 10px 0;
		padding: 0;
		background: transparent;
		border: none;
	}

	.tool-group-header {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
		user-select: none;
		padding: 8px 12px;
		background: var(--paper-2);
		border: 1px solid var(--rule-soft);
		border-left: 3px solid var(--line-M);
	}

	.tool-group-header:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.tg-icon {
		color: var(--ink-3);
		display: flex;
		align-items: center;
	}

	.tg-summary {
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-2);
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tg-count {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-4);
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.tg-toggle {
		color: var(--ink-4);
		display: flex;
		align-items: center;
	}

	/* Reasoning text — serif italic to echo the "thinking" block aesthetic */
	.reasoning-bubble {
		margin: 8px 0;
		padding: 10px 14px;
		background: var(--paper-2);
		border-left: 3px solid var(--ink-4);
	}

	.reasoning-text {
		margin: 0;
		font-family: var(--font-serif);
		font-style: italic;
		font-size: 13px;
		color: var(--ink-2);
		line-height: 1.55;
	}

	.tool-list {
		margin-top: 6px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.tool-row {
		background: var(--paper-2);
		border: 1px solid var(--rule-faint);
		border-left: 3px solid var(--line-M);
		overflow: hidden;
	}

	.tool-row-expanded {
		border-color: var(--rule-soft);
	}

	.tool-row-dimmed {
		opacity: 0.35;
		transition: opacity 0.3s ease;
	}

	.tool-row-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 11px;
		cursor: pointer;
		user-select: none;
	}

	.tool-row-header:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.tr-icon {
		color: var(--accent);
		display: flex;
		align-items: center;
		opacity: 0.85;
	}

	.tr-name {
		font-family: var(--font-mono);
		font-weight: 600;
		font-size: 11.5px;
		color: var(--accent);
		flex: 1;
	}

	.tr-done {
		color: var(--ok);
		display: flex;
		align-items: center;
	}

	.tr-error {
		color: var(--err);
	}

	.tr-toggle {
		color: var(--ink-4);
		display: flex;
		align-items: center;
	}

	.tr-input {
		margin: 0;
		padding: 8px 11px;
		background: var(--paper);
		border-top: 1px solid var(--rule-faint);
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-2);
		white-space: pre-wrap;
		word-break: break-all;
		overflow-x: auto;
		line-height: 1.5;
	}

	.tr-divider {
		height: 1px;
		background: var(--rule-faint);
	}

	.tr-output {
		margin: 0;
		padding: 8px 11px;
		background: var(--paper);
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ok);
		white-space: pre-wrap;
		word-break: break-all;
		overflow-x: auto;
		line-height: 1.5;
	}

	.tr-output-error {
		background: rgba(178, 34, 34, 0.06);
		color: var(--err);
	}
</style>
