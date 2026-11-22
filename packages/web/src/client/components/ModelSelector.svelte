<script lang="ts">
	import {
		type ClusterModelInfo,
		type ModelRoutingInfo,
		sortClusterModelsById,
	} from "@bound/client";
	import { Cpu } from "lucide-svelte";
	import { onMount } from "svelte";
	import { client } from "../lib/bound";
	import { resolveInitialModel } from "../lib/model-hint";
	import { modelStore } from "../lib/modelStore";
	import ModelHealthDot from "./ModelHealthDot.svelte";

	const { modelHint = undefined } = $props<{ modelHint?: string | null }>();

	let selectedModel = $state("");
	let models = $state<ClusterModelInfo[]>([]);
	// Per-logical-model health, keyed by logical model id, for the three-state dot.
	let routing = $state<ModelRoutingInfo[]>([]);
	// Advanced route-pin disclosure (hard pin to a specific RouteId; §9.1).
	let advancedOpen = $state(false);
	let pinnedRoute = $state("");
	// Tracks whether the hint has been applied so we don't override user's
	// subsequent manual selection if the thread data arrives after models load.
	let hintApplied = $state(false);

	onMount(async () => {
		try {
			const [data, routingData] = await Promise.all([
				client.listModels(),
				// Route health is best-effort: an older server without the routing API
				// just leaves every dot grey rather than failing the picker.
				client.getRoutingModels().catch(() => ({ models: [] })),
			]);
			models = sortClusterModelsById(data.models);
			routing = routingData.models;
			const resolved = resolveInitialModel(models, data.default, modelHint);
			selectedModel = resolved.selectedModel;
			modelStore.setModel(resolved.modelId);
			if (modelHint && resolved.modelId === modelHint) {
				hintApplied = true;
			}
		} catch (error) {
			console.error("Failed to load models:", error);
		}
	});

	// The three-state health of a logical model: green if any live route is
	// healthy, amber if only a fallback (backoff/half_open) can serve, grey if no
	// eligible route or the health is unobservable from this host (§9.1).
	function healthFor(modelId: string): "healthy" | "fallback" | "none" | "unknown" {
		const entry = routing.find((m) => m.logical_model === modelId);
		if (!entry) return "unknown";
		const live = entry.routes.filter((r) => !r.drained);
		if (live.length === 0) return "none";
		if (live.some((r) => r.health === "healthy")) return "healthy";
		if (live.some((r) => r.health === "backoff" || r.health === "half_open")) return "fallback";
		return "unknown";
	}

	// The currently-selected logical model (its id, @host suffix stripped).
	const selectedLogical = $derived(
		selectedModel.includes("@") ? selectedModel.split("@")[0] : selectedModel,
	);

	// Advertised routes for the selected model, for the Advanced pin dropdown.
	const selectedRoutes = $derived(
		routing.find((m) => m.logical_model === selectedLogical)?.routes ?? [],
	);

	// Handle the case where modelHint arrives after models have loaded.
	// Common path: LineView's onMount fetches the thread (which has model_hint)
	// asynchronously, so ModelSelector may already be mounted with no hint yet.
	$effect(() => {
		if (modelHint && models.length > 0 && !hintApplied) {
			const hintMatch = models.find((m) => m.id === modelHint);
			if (hintMatch) {
				selectedModel = `${hintMatch.id}@${hintMatch.host}`;
				modelStore.setModel(hintMatch.id);
				hintApplied = true;
			}
		}
	});

	function handleChange(): void {
		// Extract model ID (strip @host suffix if present)
		const modelId = selectedModel.includes("@") ? selectedModel.split("@")[0] : selectedModel;
		modelStore.setModel(modelId);
	}
</script>

<div class="model-selector">
	<label for="model">
		<Cpu size={14} />
	</label>
	<ModelHealthDot state={healthFor(selectedLogical)} />
	<select id="model" aria-label="Model" bind:value={selectedModel} onchange={handleChange}>
		{#each models as model}
			<option
				value={model.id + "@" + model.host}
				class:relay={model.via === "relay"}
				class:stale={model.status === "offline?"}
			>
				{model.id}
				{#if model.via === "relay"}
					({model.host}{model.status === "offline?" ? " · offline?" : " · via relay"})
				{/if}
			</option>
		{/each}
	</select>
	{#if selectedRoutes.length > 0}
		<details class="advanced" bind:open={advancedOpen}>
			<summary>Advanced</summary>
			<label class="pin">
				Pin route
				<select aria-label="Hard route pin" bind:value={pinnedRoute}>
					<option value="">Auto (no pin)</option>
					{#each selectedRoutes as r}
						<option value={r.route_id}>{r.host_name} / {r.provider ?? "?"}</option>
					{/each}
				</select>
			</label>
		</details>
	{/if}
</div>

<style>
	.model-selector {
		display: inline-flex;
		gap: 8px;
		align-items: center;
	}

	label {
		display: flex;
		align-items: center;
		color: var(--ok);
	}

	select {
		padding: 5px 10px;
		border: 1px solid var(--rule-soft);
		background: transparent;
		color: var(--ink-2);
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: border-color 0.2s ease;
		appearance: auto;
		border-radius: 0;
	}

	select:hover {
		border-color: var(--ink);
	}

	select:focus {
		outline: none;
		border-color: var(--ink);
	}

	option.relay {
		color: var(--ink-3);
	}

	option.stale {
		color: var(--ink-4);
		font-style: italic;
	}
</style>
