<script lang="ts">
import { onMount } from "svelte";

interface ModelInfo {
	id: string;
	provider: string;
}

let selectedModel = $state("");
let models = $state<ModelInfo[]>([]);

onMount(async () => {
	try {
		const res = await fetch("/api/status/models");
		if (res.ok) {
			const data = (await res.json()) as { models: ModelInfo[]; default: string };
			models = data.models;
			selectedModel = data.default;
		}
	} catch (error) {
		console.error("Failed to load models:", error);
	}
});

function handleChange(): void {
	// Model change handler
}
</script>

<div class="model-selector">
	<label for="model">Model:</label>
	<select id="model" bind:value={selectedModel} onchange={handleChange}>
		{#each models as model}
			<option value={model.id}>{model.id}</option>
		{/each}
	</select>
</div>

<style>
	.model-selector {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	label {
		font-size: 14px;
	}

	select {
		padding: 6px 12px;
		border-radius: 4px;
		border: 1px solid #0f3460;
		background: #16213e;
		color: #e0e0e0;
	}
</style>
