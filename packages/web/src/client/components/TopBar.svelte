<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: used in template
import ModelSelector from "./ModelSelector.svelte";

function navigate(hash: string): void {
	window.location.hash = hash;
}
</script>

<div class="top-bar">
	<div class="app-name">Bound</div>
	<nav class="nav-links">
		<button class="nav-btn" onclick={() => navigate("#/")}>System Map</button>
		<button class="nav-btn" onclick={() => navigate("#/timetable")}>Timetable</button>
		<button class="nav-btn" onclick={() => navigate("#/network")}>Network</button>
	</nav>
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

	.nav-links {
		display: flex;
		gap: 4px;
	}

	.nav-btn {
		padding: 6px 12px;
		background: transparent;
		color: #e0e0e0;
		border: 1px solid transparent;
		border-radius: 4px;
		cursor: pointer;
		font-size: 14px;
	}

	.nav-btn:hover {
		border-color: #0f3460;
		background: #0f3460;
	}

	.spacer {
		flex: 1;
	}

	.indicators {
		font-size: 14px;
	}
</style>
