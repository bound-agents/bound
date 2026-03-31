<script lang="ts">
import { SECTION_COLORS } from "../lib/context-colors";

interface Props {
	sections: Array<{ name: string; tokens: number; children?: Array<{ name: string; tokens: number }> }>;
	contextWindow: number;
}

const { sections, contextWindow } = $props<Props>();

// biome-ignore lint/correctness/noUnusedVariables: let required for $state
let expandedSections = $state(new Set<string>());

function toggleSection(name: string): void {
	const next = new Set(expandedSections);
	if (next.has(name)) next.delete(name);
	else next.add(name);
	expandedSections = next;
}

const usedTokens = $derived(sections.reduce((s, sec) => s + sec.tokens, 0));
const freeTokens = $derived(contextWindow - usedTokens);
const freePct = $derived(contextWindow > 0 ? (freeTokens / contextWindow) * 100 : 0);
</script>

<div class="section-list">
	{#each sections as section}
		{@const pct = contextWindow > 0 ? (section.tokens / contextWindow) * 100 : 0}
		<div class="section-row" class:expandable={section.children && section.children.length > 0}>
			<button
				class="section-toggle"
				onclick={() => (section.children ? toggleSection(section.name) : null)}
				disabled={!section.children || section.children.length === 0}
			>
				{#if section.children && section.children.length > 0}
					<span class="chevron" class:expanded={expandedSections.has(section.name)}>&#9656;</span>
				{/if}
				<span class="dot" style="background: {SECTION_COLORS[section.name] ?? 'var(--text-muted)'}"></span>
				<span class="name">{section.name}</span>
			</button>
			<span class="tokens">{section.tokens.toLocaleString()}</span>
			<span class="pct">{pct.toFixed(1)}%</span>
		</div>
		{#if section.children && expandedSections.has(section.name)}
			{#each section.children as child}
				{@const childPct = contextWindow > 0 ? (child.tokens / contextWindow) * 100 : 0}
				<div class="section-row child">
					<span class="indent"></span>
					<span class="dot small" style="background: {SECTION_COLORS[section.name] ?? 'var(--text-muted)'}; opacity: 0.6;"></span>
					<span class="name">{child.name}</span>
					<span class="tokens">{child.tokens.toLocaleString()}</span>
					<span class="pct">{childPct.toFixed(1)}%</span>
				</div>
			{/each}
		{/if}
	{/each}

	{#if freeTokens > 0}
		<div class="section-row">
			<button class="section-toggle" disabled>
				<span class="dot" style="background: var(--text-muted); opacity: 0.3;"></span>
				<span class="name">free space</span>
			</button>
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
		padding: 3px 0;
		font-size: 12px;
	}

	.section-row.child {
		padding-left: 20px;
	}

	.section-toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: default;
		padding: 0;
		flex: 1;
		min-width: 0;
		font-size: 12px;
		font-family: var(--font-body);
	}

	.section-toggle:not(:disabled) {
		cursor: pointer;
	}

	.section-toggle:not(:disabled):hover .name {
		color: var(--text-primary);
	}

	.chevron {
		font-size: 10px;
		transition: transform 0.15s;
		display: inline-block;
		width: 10px;
	}

	.chevron.expanded {
		transform: rotate(90deg);
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.dot.small {
		width: 6px;
		height: 6px;
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
		font-size: 11px;
		color: var(--text-primary);
		text-align: right;
		min-width: 48px;
	}

	.pct {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-muted);
		text-align: right;
		min-width: 40px;
	}

	.indent {
		width: 10px;
	}
</style>
