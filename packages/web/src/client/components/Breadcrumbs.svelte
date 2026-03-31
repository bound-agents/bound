<script lang="ts">
	interface Props {
		segments: Array<{ name: string; path: string }>;
		onNavigate: (path: string) => void;
	}

	// biome-ignore lint/correctness/noUnusedVariables: used in template
	const { segments, onNavigate }: Props = $props();
</script>

<nav class="breadcrumbs" aria-label="File path">
	{#each segments as segment, i}
		{#if i > 0}
			<span class="separator">/</span>
		{/if}
		{#if i === segments.length - 1}
			<span class="current">{segment.name}</span>
		{:else}
			<button class="segment" onclick={() => onNavigate(segment.path)}>
				{segment.name}
			</button>
		{/if}
	{/each}
</nav>

<style>
	.breadcrumbs {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 12px 20px;
		border-bottom: 1px solid rgba(0, 155, 191, 0.1);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		min-height: 44px;
	}

	.segment {
		background: none;
		border: none;
		color: var(--line-3);
		font-family: inherit;
		font-size: inherit;
		cursor: pointer;
		padding: 2px 4px;
		border-radius: 3px;
		transition: background 0.15s ease;
	}

	.segment:hover {
		background: rgba(0, 155, 191, 0.1);
	}

	.segment:focus {
		outline: 2px solid var(--line-3);
		outline-offset: 1px;
	}

	.separator {
		color: var(--text-muted);
		user-select: none;
	}

	.current {
		color: var(--text-primary);
		font-weight: 600;
		padding: 2px 4px;
	}
</style>
