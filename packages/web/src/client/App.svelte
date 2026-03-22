<script lang="ts">
import { onMount } from "svelte";
import { currentRoute } from "./lib/router";

onMount(() => {
	window.addEventListener("hashchange", () => {
		const route = window.location.hash.slice(1) || "/";
		currentRoute.set(route);
	});

	const route = window.location.hash.slice(1) || "/";
	currentRoute.set(route);
});

let route = "/";
currentRoute.subscribe((value) => {
	route = value;
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
