<script lang="ts">
	import Btn from "./Btn.svelte";

	// Model-substitution notice (2026-11-21-model-routing.md §9.2). When a refusal
	// substitutes another model, an inline notice names the refusal category (when
	// available), the substitute, and offers a one-click "Try <original> again" to
	// clear the substitution pin. A non-substitutable refusal carries no substitute
	// and no retry action — only the category and explanation.

	const {
		original,
		substitute = null,
		category = null,
		explanation = null,
		onRetry = undefined,
	} = $props<{
		/** The originally-requested logical model. */
		original: string;
		/** The substitute model that answered, or null for a non-substitutable refusal. */
		substitute?: string | null;
		/** Provider refusal category when known. */
		category?: string | null;
		/** Prompt-level explanation for a non-substitutable refusal. */
		explanation?: string | null;
		/** Clears the substitution pin; absent disables the retry action. */
		onRetry?: () => void;
	}>();

	const substituted = $derived(substitute !== null);
</script>

<div class="subst-notice" role="status">
	<div class="body">
		{#if substituted}
			<span class="text">
				{#if category}<span class="cat">{category}</span> refusal on {original};{:else}{original}
					declined;{/if}
				answered with <span class="sub">{substitute}</span>
			</span>
			{#if onRetry}
				<Btn size="sm" variant="ghost" onclick={onRetry}>Try {original} again</Btn>
			{/if}
		{:else}
			<span class="text">
				{#if category}<span class="cat">{category}</span> refusal on {original}{:else}{original}
					declined this request{/if}
			</span>
			{#if explanation}
				<p class="explanation">{explanation}</p>
			{/if}
		{/if}
	</div>
</div>

<style>
	.subst-notice {
		padding: 6px 10px;
		font-size: var(--text-xs);
		font-family: var(--font-mono);
		color: var(--ink-2);
		background: var(--paper-2);
		border-left: 3px solid var(--accent);
		border-radius: var(--r-sm);
	}
	.body {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.cat {
		color: var(--accent);
		font-weight: 500;
	}
	.sub {
		color: var(--ink);
		font-weight: 500;
	}
	.explanation {
		margin: 4px 0 0;
		color: var(--ink-3);
		width: 100%;
	}
</style>
