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

const {
	segments = [],
	turnRange = null,
} = $props<{
	segments?: ToolGroupSegment[];
	turnRange?: TurnRange | null;
}>();

// Flatten all tool entries for summary
const allEntries = $derived(
	segments.flatMap((s) => (s.kind === "tools" ? s.entries : [])),
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
	const names = [...new Set(allEntries.map((e) => e.name))];
	if (names.length <= 3) return names.join(", ");
	return `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
}

const doneCount = $derived(allEntries.filter((e) => e.result !== undefined).length);
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
		margin: 6px 0;
		padding: 8px 12px;
		border-radius: 8px;
		background: rgba(143, 118, 214, 0.06);
		border: 1px solid var(--bg-surface);
	}

	/* Hanzomon purple ticket stripe — 32px to match MetroCard siblings in chat */
	.tool-group::after {
		content: "";
		position: absolute;
		top: 0;
		left: 12px;
		width: 32px;
		height: 2px;
		background: var(--line-6);
		border-radius: 0 0 1px 1px;
	}

	.tool-group-header {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
		user-select: none;
		padding: 2px 0;
	}

	.tool-group-header:focus-visible {
		outline: 2px solid var(--line-6);
		outline-offset: 2px;
		border-radius: 4px;
	}

	.tg-icon {
		color: var(--line-6);
		display: flex;
		align-items: center;
	}

	.tg-summary {
		font-family: var(--font-mono);
		font-size: 13px;
		font-weight: 600;
		color: #c4b5f4;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tg-count {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-muted);
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.tg-toggle {
		color: var(--text-muted);
		display: flex;
		align-items: center;
	}

	/* Reasoning text — nested bubble between tool segments */
	.reasoning-bubble {
		margin: 6px 0;
		padding: 6px 10px;
		background: rgba(243, 151, 0, 0.06);
		border: 1px solid rgba(243, 151, 0, 0.12);
		border-radius: 6px;
	}

	.reasoning-text {
		margin: 0;
		font-family: var(--font-body);
		font-size: var(--text-sm);
		color: var(--text-secondary);
		line-height: 1.5;
	}

	/* Level 1: tool list */
	.tool-list {
		margin-top: 4px;
	}

	.tool-row {
		border-radius: 5px;
		margin-top: 4px;
		background: rgba(10, 10, 20, 0.3);
		border: 1px solid rgba(143, 118, 214, 0.08);
		overflow: hidden;
	}

	.tool-row-expanded {
		border-color: rgba(143, 118, 214, 0.2);
	}

	.tool-row-dimmed {
		opacity: 0.3;
		transition: opacity 0.3s ease;
	}

	.tool-row-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		cursor: pointer;
		user-select: none;
	}

	.tool-row-header:focus-visible {
		outline: 2px solid var(--line-6);
		outline-offset: -2px;
		border-radius: 4px;
	}

	.tr-icon {
		color: var(--line-6);
		display: flex;
		align-items: center;
		opacity: 0.6;
	}

	.tr-name {
		font-family: var(--font-mono);
		font-weight: 600;
		font-size: 12px;
		color: #c4b5f4;
		flex: 1;
	}

	.tr-done {
		color: var(--line-4);
		display: flex;
		align-items: center;
	}

	.tr-error {
		color: var(--alert-disruption);
	}

	.tr-toggle {
		color: var(--text-muted);
		display: flex;
		align-items: center;
	}

	/* Level 2: request/response detail */
	.tr-input {
		margin: 0;
		padding: 8px 10px;
		background: rgba(10, 10, 20, 0.5);
		font-family: var(--font-mono);
		font-size: 11px;
		color: #c4b5f4;
		white-space: pre-wrap;
		word-break: break-all;
		overflow-x: auto;
		line-height: 1.45;
	}

	.tr-divider {
		height: 1px;
		background: rgba(255, 255, 255, 0.06);
	}

	.tr-output {
		margin: 0;
		padding: 8px 10px;
		background: rgba(0, 153, 68, 0.04);
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--status-active);
		white-space: pre-wrap;
		word-break: break-all;
		overflow-x: auto;
		line-height: 1.45;
	}

	.tr-output-error {
		background: rgba(255, 23, 68, 0.06);
		color: var(--alert-disruption);
	}
</style>
