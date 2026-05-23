<script lang="ts">
import type { ClusterModelInfo } from "@bound/client";
import { Cpu } from "lucide-svelte";
import { onMount } from "svelte";
import { client } from "../lib/bound";
import { resolveInitialModel } from "../lib/model-hint";
import { modelStore } from "../lib/modelStore";

const { modelHint = undefined } = $props<{ modelHint?: string | null }>();

let selectedModel = $state("");
let models = $state<ClusterModelInfo[]>([]);
// Tracks whether the hint has been applied so we don't override user's
// subsequent manual selection if the thread data arrives after models load.
let hintApplied = $state(false);

onMount(async () => {
	try {
		const data = await client.listModels();
		models = data.models;
		const resolved = resolveInitialModel(data.models, data.default, modelHint);
		selectedModel = resolved.selectedModel;
		modelStore.setModel(resolved.modelId);
		if (modelHint && resolved.modelId === modelHint) {
			hintApplied = true;
		}
	} catch (error) {
		console.error("Failed to load models:", error);
	}
});

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
