<script lang="ts">
import { onMount } from "svelte";
import { modelStore } from "../lib/modelStore";
import { Cpu } from "lucide-svelte";

interface ClusterModelInfo {
	id: string;
	provider: string;
	host: string;
	via: "local" | "relay";
	status: "local" | "online" | "offline?";
}

let selectedModel = $state("");
let models = $state<ClusterModelInfo[]>([]);

onMount(async () => {
	try {
		const res = await fetch("/api/status/models");
		if (res.ok) {
			const data = (await res.json()) as { models: ClusterModelInfo[]; default: string };
			models = data.models;
			// Match default model to the full option value (id@host)
			const defaultMatch = data.models.find((m) => m.id === data.default);
			selectedModel = defaultMatch ? `${defaultMatch.id}@${defaultMatch.host}` : data.default;
			modelStore.setModel(data.default);
		}
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

	option.relay {
		color: var(--text-muted);
	}

	option.stale {
		color: var(--text-muted);
		font-style: italic;
	}
</style>
