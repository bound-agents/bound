<script lang="ts">
import type { ClusterModelInfo } from "@bound/client";
import { Cpu } from "lucide-svelte";
import { onMount } from "svelte";
import { client } from "../lib/bound";
import { modelStore } from "../lib/modelStore";

let selectedModel = $state("");
let models = $state<ClusterModelInfo[]>([]);

onMount(async () => {
	try {
		const data = await client.listModels();
		models = data.models;
		// Match default model to the full option value (id@host)
		const defaultMatch = data.models.find((m) => m.id === data.default);
		selectedModel = defaultMatch ? `${defaultMatch.id}@${defaultMatch.host}` : data.default;
		modelStore.setModel(data.default);
	} catch (error) {
		console.error("Failed to load models:", error);
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
