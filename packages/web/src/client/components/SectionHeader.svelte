<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	title: string;
	subtitle?: string;
	actions?: Snippet;
}

let { title, subtitle, actions }: Props = $props();
</script>

<div class="section-header">
	<div class="header-content">
		<h1 class="title">{title}</h1>
		{#if subtitle}
			<span class="subtitle">{subtitle}</span>
		{/if}
	</div>
	{#if actions}
		<div class="actions">
			{@render actions()}
		</div>
	{/if}
</div>

<style>
	.section-header {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 16px;
	}

	.header-content {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.title {
		font-size: var(--text-xl);
		font-weight: 700;
		color: var(--text-primary);
		margin: 0;
	}

	.subtitle {
		font-size: var(--text-sm);
		text-transform: uppercase;
		color: var(--text-muted);
		letter-spacing: 0.06em;
	}

	.actions {
		margin-left: auto;
	}
</style>
