<script lang="ts">
import { onMount } from "svelte";
import TopBar from "./components/TopBar.svelte";
import AdvisoryView from "./views/AdvisoryView.svelte";
import FilesView from "./views/FilesView.svelte";
import LineView from "./views/LineView.svelte";
import NetworkStatus from "./views/NetworkStatus.svelte";
import SystemMap from "./views/SystemMap.svelte";
import TaskDetailView from "./views/TaskDetailView.svelte";
import Timetable from "./views/Timetable.svelte";

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
		<div class="view-transition">
			{#if route === "/" || route === ""}
				<SystemMap />
			{:else if route.startsWith("/line/")}
				<LineView threadId={route.split("/")[2]} />
			{:else if route.startsWith("/task/")}
				<TaskDetailView taskId={route.split("/")[2]} />
			{:else if route === "/timetable"}
				<Timetable />
			{:else if route === "/network"}
				<NetworkStatus />
			{:else if route === "/advisories"}
				<AdvisoryView />
			{:else if route === "/files"}
				<FilesView />
			{:else}
				<SystemMap />
			{/if}
		</div>
	</main>
</div>

<style>
	:global(:root) {
		/* Tokyo Metro line palette */
		--line-0: #F39700;   /* Ginza (G)        — orange   */
		--line-1: #E60012;   /* Marunouchi (M)   — red      */
		--line-2: #9CAEB7;   /* Hibiya (H)       — silver   */
		--line-3: #009BBF;   /* Tozai (T)        — sky blue */
		--line-4: #009944;   /* Chiyoda (C)      — green    */
		--line-5: #C1A470;   /* Yurakucho (Y)    — gold     */
		--line-6: #8F76D6;   /* Hanzomon (Z)     — purple   */
		--line-7: #00AC9B;   /* Namboku (N)      — emerald  */
		--line-8: #9C5E31;   /* Fukutoshin (F)   — brown    */
		--line-9: #B6007A;   /* Oedo (E)         — ruby     */

		/* Surface */
		--bg-primary: #1A1A2E;
		--bg-secondary: #16213E;
		--bg-surface: #0F3460;
		--text-primary: #E8E8E8;
		--text-secondary: #A0A0B0;
		--text-muted: #6B6B80;

		/* Semantic */
		--alert-disruption: #FF1744;
		--alert-warning: #FF9100;
		--status-active: #69F0AE;
		--status-idle: #A0A0B0;

		/* Dimensions */
		--line-weight: 4px;
		--line-weight-active: 6px;
		--station-radius: 6px;
		--station-radius-hover: 9px;

		/* Typography */
		--font-display: 'Nunito Sans', 'Overpass', 'Source Sans 3', sans-serif;
		--font-body: 'Nunito Sans', 'IBM Plex Sans', 'Noto Sans', sans-serif;
		--font-mono: 'IBM Plex Mono', 'JetBrains Mono', 'Fira Code', monospace;

		--text-xs: 0.75rem;
		--text-sm: 0.875rem;
		--text-base: 1rem;
		--text-lg: 1.25rem;
		--text-xl: 1.5rem;
	}

	:global(body) {
		margin: 0;
		padding: 0;
		font-family: var(--font-body);
		background: var(--bg-primary);
		color: var(--text-primary);
		-webkit-font-smoothing: antialiased;
		-moz-osx-font-smoothing: grayscale;
	}

	/* Scrollbar styling */
	:global(::-webkit-scrollbar) {
		width: 8px;
		height: 8px;
	}

	:global(::-webkit-scrollbar-track) {
		background: var(--bg-primary);
	}

	:global(::-webkit-scrollbar-thumb) {
		background: var(--bg-surface);
		border-radius: 4px;
	}

	:global(::-webkit-scrollbar-thumb:hover) {
		background: #1a4a8a;
	}

	:global(*) {
		scrollbar-width: thin;
		scrollbar-color: var(--bg-surface) var(--bg-primary);
	}

	.container {
		display: flex;
		flex-direction: column;
		height: 100vh;
		width: 100vw;
	}

	main {
		flex: 1;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.view-transition {
		animation: viewFadeIn 0.25s ease-out;
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	@keyframes viewFadeIn {
		from { opacity: 0; transform: translateY(4px); }
		to { opacity: 1; transform: translateY(0); }
	}

	@media (prefers-reduced-motion: reduce) {
		.view-transition {
			animation: none;
		}
	}
</style>
