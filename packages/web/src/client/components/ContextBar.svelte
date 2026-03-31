<script lang="ts">
import { SECTION_COLORS, FREE_SPACE_COLOR } from "../lib/context-colors";

interface Props {
	sections: Array<{ name: string; tokens: number; children?: Array<{ name: string; tokens: number }> }>;
	contextWindow: number;
}

const { sections, contextWindow } = $props<Props>();

const usedTokens = $derived(sections.reduce((s, sec) => s + sec.tokens, 0));
const usedPct = $derived((usedTokens / contextWindow) * 100);
const freePct = $derived(100 - usedPct);
</script>

<div class="context-bar">
	{#each sections as section}
		{@const pct = (section.tokens / contextWindow) * 100}
		{#if pct > 0}
			<div
				class="bar-segment"
				style="flex-basis: {pct}%; background: {SECTION_COLORS[section.name] ?? 'var(--text-muted)'};"
				title="{section.name}: {section.tokens.toLocaleString()} tokens ({pct.toFixed(1)}%)"
			></div>
		{/if}
	{/each}
	{#if freePct > 0}
		<div
			class="bar-segment free"
			style="flex-basis: {freePct}%; background: {FREE_SPACE_COLOR};"
			title="Free space: {Math.round(contextWindow - usedTokens).toLocaleString()} tokens ({freePct.toFixed(1)}%)"
		></div>
	{/if}
</div>

<style>
	.context-bar {
		display: flex;
		height: 12px;
		border-radius: 3px;
		overflow: hidden;
		margin-bottom: 12px;
		gap: 1px;
	}

	.bar-segment {
		min-width: 2px;
		transition: flex-basis 0.3s ease;
	}

	.bar-segment.free {
		opacity: 0.3;
	}
</style>
