<script lang="ts">
import { highlightCode } from "../lib/markdown";

const { code, lang }: { code: string; lang: "javascript" | "json" } = $props();
let highlighted = $state<string | null>(null);

$effect(() => {
	let active = true;
	highlighted = null;
	void highlightCode(code, lang)
		.then((html) => {
			if (active) highlighted = html;
		})
		.catch(() => {
			if (active) highlighted = null;
		});
	return () => {
		active = false;
	};
});
</script>

<div class="yard-code-block" aria-label={`${lang} code`}>
	{#if highlighted}
		{@html highlighted}
	{:else}
		<pre>{code}</pre>
	{/if}
</div>

<style>
	.yard-code-block { max-height: min(420px, 50vh); overflow: auto; border: 1px solid var(--rule-soft); border-radius: 4px; background: color-mix(in srgb, var(--ink) 92%, var(--paper)); color: #c8d3f5; }
	.yard-code-block :global(pre) { max-height: none; margin: 0; padding: 10px 12px; overflow: visible; background: transparent !important; color: inherit; font: 11px/1.45 var(--font-mono); overflow-wrap: anywhere; white-space: pre-wrap; }
	.yard-code-block :global(code) { font: inherit; }
</style>
