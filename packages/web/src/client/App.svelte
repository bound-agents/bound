<script lang="ts">
import { onMount } from "svelte";
// biome-ignore lint/correctness/noUnusedImports: used in template
import TopBar from "./components/TopBar.svelte";
// biome-ignore lint/correctness/noUnusedImports: used in template
import LineView from "./views/LineView.svelte";
// biome-ignore lint/correctness/noUnusedImports: used in template
import NetworkStatus from "./views/NetworkStatus.svelte";
// biome-ignore lint/correctness/noUnusedImports: used in template
import SystemMap from "./views/SystemMap.svelte";
// biome-ignore lint/correctness/noUnusedImports: used in template
import Timetable from "./views/Timetable.svelte";

// biome-ignore lint/correctness/noUnusedVariables: used in template
let route = $state(window.location.hash.slice(1) || "/");

onMount(() => {
	window.addEventListener("hashchange", () => {
		route = window.location.hash.slice(1) || "/";
	});
});
</script>

<div class="container">
	<TopBar />
	<main>
		{#if route === "/" || route === ""}
			<SystemMap />
		{:else if route.startsWith("/line/")}
			<LineView threadId={route.split("/")[2]} />
		{:else if route === "/timetable"}
			<Timetable />
		{:else if route === "/network"}
			<NetworkStatus />
		{:else}
			<SystemMap />
		{/if}
	</main>
</div>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
		background: #1a1a2e;
		color: #e0e0e0;
	}

	.container {
		display: flex;
		flex-direction: column;
		height: 100vh;
		width: 100vw;
	}

	main {
		flex: 1;
		overflow-y: auto;
	}
</style>
