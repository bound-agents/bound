<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	title: string;
	subtitle?: string;
	number?: number;
	actions?: Snippet;
}

let { title, subtitle, number, actions }: Props = $props();

const paddedNumber = $derived(number != null ? String(number).padStart(2, "0") : null);
</script>

<div class="section-header">
	<div class="header-content">
		{#if paddedNumber || subtitle}
			<div class="kicker">
				{#if paddedNumber}
					<span class="number">Nº{paddedNumber}</span>
				{/if}
				{#if subtitle}
					<span class="subtitle">{subtitle}</span>
				{/if}
			</div>
		{/if}
		<h1 class="title">{title}</h1>
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
		align-items: flex-end;
		gap: 24px;
		margin-bottom: 20px;
	}

	.header-content {
		flex: 1;
		min-width: 0;
	}

	.kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-3);
		margin-bottom: 6px;
		display: inline-flex;
		align-items: baseline;
		gap: 10px;
	}

	.number {
		font-family: var(--font-mono);
		font-size: 10.5px;
	}

	.subtitle {
		font-size: 11px;
		letter-spacing: 0.16em;
		color: var(--ink-3);
	}

	.title {
		margin: 0;
		font-family: var(--font-header);
		font-size: 38px;
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.02;
		color: var(--ink);
	}

	.actions {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-shrink: 0;
	}
</style>
