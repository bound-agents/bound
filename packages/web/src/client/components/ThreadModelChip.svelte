<script lang="ts">
	import { Lock } from "lucide-svelte";

	// Thread header chip (2026-11-21-model-routing.md §9.1). Shows the logical
	// model name. When the thread is running off its preferred route, a quiet
	// `· via <host> / <provider>` suffix appears with an explanatory tooltip. A
	// hard route pin renders with a distinct lock indicator so a forgotten debug
	// pin stands out.

	const {
		model,
		viaHost = null,
		viaProvider = null,
		pinned = false,
		kind = null,
	} = $props<{
		model: string;
		/** Friendly host name of the serving route when off-preferred, else null. */
		viaHost?: string | null;
		/** Provider of the serving route when off-preferred, else null. */
		viaProvider?: string | null;
		/** True when the thread is hard-pinned to a specific RouteId. */
		pinned?: boolean;
		/** Why the turn ran off-preferred: a model swap or a same-model route failover. */
		kind?: "substitution" | "failover" | null;
	}>();

	const offPreferred = $derived(viaHost !== null || viaProvider !== null);
	const viaLabel = $derived(offPreferred ? `${viaHost ?? "?"} / ${viaProvider ?? "?"}` : "");
	const viaTitle = $derived(
		kind === "substitution"
			? "Model substituted after a refusal"
			: kind === "failover"
				? "Same model, served by a backup route after a route error"
				: "Served off the preferred route",
	);
</script>

<span class="chip" class:pinned title={pinned ? `Pinned route: ${viaLabel || model}` : undefined}>
	{#if pinned}
		<Lock size={11} aria-label="Pinned route" />
	{/if}
	<span class="name">{model}</span>
	{#if offPreferred}
		<span class="via" title={viaTitle}>
			· via {viaLabel}
		</span>
	{/if}
</span>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--ink-2);
		padding: 2px 8px;
		border: 1px solid var(--rule-soft);
		border-radius: var(--r-sm);
	}
	/* A hard pin gets accent lock styling so a stale debug pin is unmistakable. */
	.pinned {
		border-color: var(--accent);
		color: var(--accent);
	}
	.via {
		color: var(--warn);
	}
</style>
