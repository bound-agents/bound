<script lang="ts">
// biome-ignore lint/correctness/noUnusedVariables: used with bind:value
// biome-ignore lint/style/useConst: reactive variable
let selectedModel = "gpt-4";

// biome-ignore lint/correctness/noUnusedVariables: used in template
const models = ["gpt-4", "gpt-3.5-turbo", "claude-3-opus"];

// biome-ignore lint/correctness/noUnusedVariables: event handler
function handleChange(): void {
	// Model change handler
}
</script>

<div class="model-selector">
	<label for="model">Model:</label>
	<select id="model" bind:value={selectedModel} onchange={handleChange}>
		{#each models as model}
			<option value={model}>{model}</option>
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
