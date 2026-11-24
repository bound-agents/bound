<script lang="ts">
	import type { ClusterModelInfo, ModelRoutingInfo } from "@bound/client";
	import { Cpu } from "lucide-svelte";
	import { onMount } from "svelte";
	import { client } from "../lib/bound";
	import {
		type ModelOption,
		buildModelOptions,
		logicalModelFor,
		resolveInitialModel,
	} from "../lib/model-hint";
	import { modelStore } from "../lib/modelStore";
	import ModelHealthDot from "./ModelHealthDot.svelte";

	const { modelHint = undefined } = $props<{ modelHint?: string | null }>();

	// Selected logical model id (spec §9.1: the picker chooses a logical model by
	// display name; concrete routes live only under Advanced › Pin route).
	let selectedModel = $state("");
	let models = $state<ClusterModelInfo[]>([]);
	let options = $state<ModelOption[]>([]);
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
			models = data.models;
			routing = routingData.models;
			options = buildModelOptions(models, routing);
			const resolved = resolveInitialModel(options, models, data.default, modelHint);
			selectedModel = resolved.selectedModel;
			modelStore.setModel(resolved.modelId);
			if (modelHint && logicalModelFor(modelHint, options, models)) {
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

	// Advertised routes for the selected logical model, for the Advanced pin dropdown.
	const selectedRoutes = $derived(
		routing.find((m) => m.logical_model === selectedModel)?.routes ?? [],
	);

	// Handle the case where modelHint arrives after models have loaded.
	// Common path: LineView's onMount fetches the thread (which has model_hint)
	// asynchronously, so ModelSelector may already be mounted with no hint yet.
	$effect(() => {
		if (modelHint && options.length > 0 && !hintApplied) {
			const logical = logicalModelFor(modelHint, options, models);
			if (logical) {
				selectedModel = logical;
				modelStore.setModel(logical);
				hintApplied = true;
			}
		}
	});

	function handleChange(): void {
		// Option values are logical model ids — the hint the server resolves.
		modelStore.setModel(selectedModel);
	}
</script>

<div class="model-selector">
	<label for="model">
		<Cpu size={14} />
	</label>
	<ModelHealthDot state={healthFor(selectedModel)} />
	<select id="model" aria-label="Model" bind:value={selectedModel} onchange={handleChange}>
		{#each options as option}
			<option value={option.id}>{option.label}</option>
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
</style>
