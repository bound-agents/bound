<script module lang="ts">
// Module-level selected model so message-sending code can reference it
export const activeModel = "";
</script>

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
			activeModel = data.default;
		}
	} catch (error) {
		console.error("Failed to load models:", error);
	}
});

function handleChange(): void {
	activeModel = selectedModel;
}
</script>

<div class="model-selector">
	<label for="model">
		<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
			<rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5" fill="none" />
			<circle cx="7" cy="7" r="2.5" stroke="currentColor" stroke-width="1.5" fill="none" />
		</svg>
	</label>
	<select id="model" aria-label="Model" bind:value={selectedModel} onchange={handleChange}>
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
		display: flex;
		align-items: center;
		color: var(--text-muted);
	}

	select {
		padding: 6px 12px;
		border-radius: 6px;
		border: 1px solid var(--bg-surface);
		background: var(--bg-primary);
		color: var(--text-secondary);
		font-family: var(--font-mono);
		font-size: 12px;
		cursor: pointer;
		transition: border-color 0.2s ease;
		appearance: auto;
	}

	select:hover {
		border-color: var(--line-3);
	}

	select:focus {
		outline: none;
		border-color: var(--line-3);
	}
</style>
