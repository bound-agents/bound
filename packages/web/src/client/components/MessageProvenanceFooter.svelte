<script lang="ts">
	import type { TurnProvenanceInfo } from "@bound/client";

	// Per-turn provenance footer (2026-11-21-model-routing.md §9.1). Collapsed, it
	// names the serving model and route for the turn. Expanded, it lists every
	// attempt with its cost, including discarded refusals and failed route trials
	// — the detail the router keeps internal elsewhere but surfaces here on demand.

	const { turn } = $props<{ turn: TurnProvenanceInfo }>();

	let expanded = $state(false);

	/** The route's `host / provider` label from its RouteId, or "—" when absent. */
	function routeLabel(routeId: string | null): string {
		if (!routeId) return "\u2014";
		const parts = routeId.split(":");
		if (parts.length < 3) return routeId;
		// `${siteId}:${provider}:${backendId}` — show provider and backend; the
		// host is the siteId, which the Settings page maps to a friendly name.
		return `${parts[1]} / ${parts[2]}`;
	}

	function fmtCost(cost: number | null | undefined): string {
		if (cost === null || cost === undefined) return "\u2014";
		return `$${cost.toFixed(4)}`;
	}

	const hasAttempts = $derived((turn.attempts?.length ?? 0) > 0);

	function outcomeLabel(outcome: string): string {
		if (outcome === "ok") return "served";
		if (outcome === "refusal") return "refused";
		return "route error";
	}
</script>

<div class="provenance">
	<button
		type="button"
		class="summary"
		class:clickable={hasAttempts}
		onclick={() => {
			if (hasAttempts) expanded = !expanded;
		}}
		aria-expanded={hasAttempts ? expanded : undefined}
	>
		<span class="model">{turn.model_id}</span>
		<span class="sep">via</span>
		<span class="route">{routeLabel(turn.route_id)}</span>
		{#if turn.substituted_from}
			<span class="subst" title="Substituted from {turn.substituted_from}">
				(was {turn.substituted_from})
			</span>
		{/if}
		{#if hasAttempts}
			<span class="caret" aria-hidden="true">{expanded ? "\u25be" : "\u25b8"}</span>
		{/if}
	</button>

	{#if expanded && turn.attempts}
		<ol class="attempts">
			{#each turn.attempts as attempt}
				<li class="attempt" class:refused={attempt.outcome === "refusal"}>
					<span class="a-model">{attempt.model_id}</span>
					<span class="a-route">{routeLabel(attempt.route_id)}</span>
					<span class="a-outcome">{outcomeLabel(attempt.outcome)}</span>
					{#if attempt.refusal_category}
						<span class="a-cat">{attempt.refusal_category}</span>
					{/if}
					{#if attempt.credit_redeemed}
						<span class="a-credit" title="Fallback credit redeemed">credited</span>
					{/if}
					<span class="a-cost">{fmtCost(attempt.cost_usd)}</span>
				</li>
			{/each}
		</ol>
	{/if}
</div>

<style>
	.provenance {
		font-size: var(--text-xs);
		color: var(--ink-3);
		font-family: var(--font-mono);
	}
	.summary {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: transparent;
		border: none;
		padding: 0;
		color: inherit;
		font: inherit;
		cursor: default;
		text-align: left;
	}
	.summary.clickable {
		cursor: pointer;
	}
	.model {
		color: var(--ink-2);
		font-weight: 500;
	}
	.sep {
		color: var(--ink-4);
	}
	.subst {
		color: var(--warn);
	}
	.caret {
		color: var(--ink-4);
	}
	.attempts {
		margin: 6px 0 0;
		padding: 0 0 0 14px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.attempt {
		display: flex;
		gap: 8px;
		align-items: baseline;
	}
	.attempt.refused .a-outcome {
		color: var(--warn);
	}
	.a-route {
		color: var(--ink-4);
	}
	.a-cat {
		color: var(--accent);
	}
	.a-credit {
		color: var(--ok);
	}
	.a-cost {
		margin-left: auto;
		color: var(--ink-3);
	}
</style>
