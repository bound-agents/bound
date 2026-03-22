<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: used in template
import ModelSelector from "./ModelSelector.svelte";
</script>

<div class="top-bar">
	<div class="app-name">Bound</div>
	<div class="spacer"></div>
	<ModelSelector />
	<div class="indicators">Advisory Count: 0</div>
</div>

<style>
	.top-bar {
		display: flex;
		align-items: center;
		padding: 12px 20px;
		background: #16213e;
		border-bottom: 1px solid #0f3460;
		gap: 20px;
	}

	.app-name {
		font-weight: bold;
		font-size: 18px;
	}

	.spacer {
		flex: 1;
	}

	.indicators {
		font-size: 14px;
	}
</style>
