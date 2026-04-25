<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	children: Snippet;
	pad?: string;
	/** Disable the max-width/center container (used by split-pane views that should fill the width) */
	flush?: boolean;
}

let { children, pad = "28px 36px", flush = false }: Props = $props();
</script>

<main class="page">
	{#if flush}
		{@render children()}
	{:else}
		<div class="page-inner" style="padding: {pad}">
			{@render children()}
		</div>
	{/if}
</main>

<style>
	.page {
		flex: 1;
		overflow-y: auto;
		min-height: 0;
		position: relative;
		z-index: 2;
	}

	.page-inner {
		max-width: 1280px;
		margin: 0 auto;
	}
</style>
