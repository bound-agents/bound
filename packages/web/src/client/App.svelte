<script lang="ts">
import { onMount } from "svelte";
import TopBar from "./components/TopBar.svelte";
import AdvisoryView from "./views/AdvisoryView.svelte";
import FilesView from "./views/FilesView.svelte";
import LineView from "./views/LineView.svelte";
import NetworkStatus from "./views/NetworkStatus.svelte";
import SystemMap from "./views/SystemMap.svelte";
import Timetable from "./views/Timetable.svelte";

let route = $state(window.location.hash.slice(1) || "/");

onMount(() => {
	window.addEventListener("hashchange", () => {
		route = window.location.hash.slice(1) || "/";
	});
});

function screenLabel(r: string): string {
	if (r === "/" || r === "") return "01 System Map";
	if (r.startsWith("/line/")) return "02 Line";
	if (r === "/timetable") return "03 Timetable";
	if (r === "/network") return "04 Network";
	if (r === "/advisories") return "05 Advisories";
	if (r === "/files") return "06 Files";
	return "00 Unknown";
}
</script>

<div class="container" data-screen-label={screenLabel(route)}>
	<TopBar />
	<main>
		<div class="view-transition">
			{#if route === "/" || route === ""}
				<SystemMap />
			{:else if route.startsWith("/line/")}
				<LineView threadId={route.split("/")[2]} />
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
		/* Signage paper — warm, matte, not quite white */
		--paper:       #EFEAE0;
		--paper-2:     #E8E2D5;
		--paper-3:     #DFD8C7;
		--rule:        #1A1814;
		--rule-soft:   rgba(26,24,20,0.18);
		--rule-faint:  rgba(26,24,20,0.08);
		--ink:         #1A1814;
		--ink-2:       #3A342B;
		--ink-3:       #6B6558;
		--ink-4:       #9A937F;

		/* One signal accent — vermilion */
		--accent:      #C8331C;
		--accent-2:    #9B2613;
		--accent-wash: rgba(200, 51, 28, 0.08);

		/* Line identity palette — muted to sit on paper. Indexes 0..9 mirror the
		   canonical Tokyo Metro order (G, M, H, T, C, Y, Z, N, F, E). */
		--line-0: #D9861A;   /* Ginza      — amber   */
		--line-1: #C8331C;   /* Marunouchi — red     */
		--line-2: #7D8B93;   /* Hibiya     — silver  */
		--line-3: #1E7FA8;   /* Tozai      — blue    */
		--line-4: #2E7D47;   /* Chiyoda    — green   */
		--line-5: #A8885A;   /* Yurakucho  — gold    */
		--line-6: #6B5BB3;   /* Hanzomon   — violet  */
		--line-7: #0E8E83;   /* Namboku    — teal    */
		--line-8: #8B5E34;   /* Fukutoshin — brown   */
		--line-9: #9B2A6E;   /* Oedo       — ruby    */

		/* Mirror the line-N vars under single-letter aliases for code that
		   prefers --line-M / --line-T / etc. */
		--line-G: var(--line-0);
		--line-M: var(--line-1);
		--line-H: var(--line-2);
		--line-T: var(--line-3);
		--line-C: var(--line-4);
		--line-Y: var(--line-5);
		--line-Z: var(--line-6);
		--line-N: var(--line-7);
		--line-F: var(--line-8);
		--line-E: var(--line-9);

		/* Semantic (back-compat + new names) */
		--ok:        #2E7D47;
		--warn:      #C37A0F;
		--err:       #B82817;
		--idle:      #9A937F;
		--status-active:    var(--ok);
		--status-idle:      var(--idle);
		--alert-warning:    var(--warn);
		--alert-disruption: var(--err);

		/* Back-compat — maps old bg / text vars to signage tones so any
		   uncorrected component still reads as paper. */
		--bg-primary:   var(--paper);
		--bg-secondary: var(--paper-2);
		--bg-surface:   var(--paper-3);
		--text-primary:   var(--ink);
		--text-secondary: var(--ink-2);
		--text-muted:     var(--ink-3);

		/* Dimensions */
		--line-weight: 4px;
		--line-weight-active: 6px;
		--station-radius: 6px;
		--station-radius-hover: 9px;

		/* Typography */
		--font-display: "Space Grotesk", "Helvetica Neue", Helvetica, Arial, sans-serif;
		--font-body:    "Space Grotesk", "Helvetica Neue", Helvetica, Arial, sans-serif;
		--font-header:  "Helvetica Neue", Helvetica, "Arial Black", Arial, sans-serif;
		--font-mono:    "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
		--font-serif:   "Fraunces", Georgia, serif;

		--text-xs: 0.75rem;
		--text-sm: 0.875rem;
		--text-base: 1rem;
		--text-lg: 1.125rem;
		--text-xl: 1.5rem;

		--r-sm: 3px;
		--r-md: 4px;

		color-scheme: light;
	}

	:global(*), :global(*::before), :global(*::after) { box-sizing: border-box; }
	:global(html), :global(body), :global(#app) { height: 100%; }

	:global(body) {
		margin: 0;
		padding: 0;
		background: var(--paper);
		color: var(--ink);
		font-family: var(--font-body);
		font-size: 14px;
		line-height: 1.45;
		-webkit-font-smoothing: antialiased;
		-moz-osx-font-smoothing: grayscale;
		font-feature-settings: "ss01", "cv11";
	}

	/* Paper texture — a very subtle printed-paper feel */
	:global(body::before) {
		content: "";
		position: fixed;
		inset: 0;
		pointer-events: none;
		z-index: 1;
		background-image:
			radial-gradient(rgba(26,24,20,0.035) 1px, transparent 1px),
			radial-gradient(rgba(26,24,20,0.02) 1px, transparent 1px);
		background-size: 3px 3px, 7px 7px;
		background-position: 0 0, 1px 2px;
		mix-blend-mode: multiply;
		opacity: 0.6;
	}

	:global(button) { font-family: inherit; color: inherit; }
	:global(input), :global(textarea), :global(select) { font-family: inherit; }

	/* Scrollbars */
	:global(::-webkit-scrollbar) { width: 10px; height: 10px; }
	:global(::-webkit-scrollbar-track) { background: transparent; }
	:global(::-webkit-scrollbar-thumb) {
		background: rgba(26,24,20,0.18);
		border-radius: 10px;
		border: 2px solid var(--paper);
	}
	:global(::-webkit-scrollbar-thumb:hover) { background: rgba(26,24,20,0.3); }
	:global(*) {
		scrollbar-width: thin;
		scrollbar-color: rgba(26,24,20,0.18) transparent;
	}

	/* Reusable helpers */
	:global(.mono) {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
	}
	:global(.tnum) { font-variant-numeric: tabular-nums; }
	:global(.kicker) {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-3);
	}
	:global(.rule) {
		height: 1px;
		background: var(--ink);
	}
	:global(.rule-faint) {
		height: 1px;
		background: var(--rule-soft);
	}

	/* Global keyframes — placed inside :global {} so Svelte doesn't scope them. */
	:global {
		@keyframes pulse {
			0%, 100% { opacity: 1; }
			50% { opacity: 0.25; }
		}
		@keyframes marquee {
			from { transform: translateX(0); }
			to { transform: translateX(-50%); }
		}
		@keyframes fadeIn {
			from { opacity: 0; transform: translateY(4px); }
			to { opacity: 1; transform: translateY(0); }
		}
	}

	/* Loading splash that appears before the app mounts */
	:global(.loading-splash) {
		position: fixed;
		inset: 0;
		display: grid;
		place-items: center;
		background: var(--paper);
		z-index: 1000;
		color: var(--ink-3);
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: 0.2em;
		text-transform: uppercase;
	}

	.container {
		display: flex;
		flex-direction: column;
		height: 100vh;
		width: 100vw;
		position: relative;
		z-index: 2;
	}

	main {
		flex: 1;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.view-transition {
		animation: viewFadeIn 0.22s ease-out;
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
		.view-transition { animation: none; }
	}
</style>
