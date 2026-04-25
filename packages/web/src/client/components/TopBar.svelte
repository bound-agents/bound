<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { client } from "../lib/bound";

function navigate(hash: string): void {
	window.location.hash = hash;
}

let currentHash = $state(window.location.hash);

function isActive(hash: string): boolean {
	const current = currentHash.slice(1) || "/";
	if (hash === "#/") return current === "/" || current === "";
	return current.startsWith(hash.slice(1));
}

const NAV = [
	{ hash: "#/", route: "01", label: "System Map" },
	{ hash: "#/timetable", route: "02", label: "Timetable" },
	{ hash: "#/network", route: "03", label: "Network" },
	{ hash: "#/advisories", route: "04", label: "Advisories" },
	{ hash: "#/files", route: "05", label: "Files" },
];

let advisoryCount = $state(0);
let advisoryPollInterval: ReturnType<typeof setInterval> | null = null;

async function loadAdvisoryCount(): Promise<void> {
	try {
		const data = await client.countAdvisories();
		advisoryCount = data.count;
	} catch {
		// Ignore count fetch errors
	}
}

function onHashChange(): void {
	currentHash = window.location.hash;
}

// Local-time clock with the IANA TZ short name derived from Intl.
let clock = $state("");
let tz = $state("");
let clockInterval: ReturnType<typeof setInterval> | null = null;

function tick(): void {
	const d = new Date();
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	clock = `${hh}:${mm}:${ss}`;
}

onMount(() => {
	try {
		const name = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
		const short = name.split("/").pop()?.replace(/_/g, " ") ?? "";
		tz = short || "Local";
	} catch {
		tz = "Local";
	}

	tick();
	clockInterval = setInterval(tick, 1000);

	window.addEventListener("hashchange", onHashChange);
	loadAdvisoryCount();
	advisoryPollInterval = setInterval(loadAdvisoryCount, 10000);
});

onDestroy(() => {
	window.removeEventListener("hashchange", onHashChange);
	if (advisoryPollInterval !== null) clearInterval(advisoryPollInterval);
	if (clockInterval !== null) clearInterval(clockInterval);
});
</script>

<header class="top-bar">
	<!-- Brandmark block — black ink against paper -->
	<button
		class="brand"
		onclick={() => navigate("#/")}
		aria-label="Bound home"
	>
		<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
			<circle cx="9" cy="9" r="7.5" fill="none" stroke="currentColor" stroke-width="1.5" />
			<circle cx="9" cy="9" r="2.4" fill="currentColor" />
		</svg>
		BOUND
	</button>

	<nav class="nav-links">
		{#each NAV as item}
			{@const active = isActive(item.hash)}
			<button
				class="nav-btn"
				class:active
				onclick={() => navigate(item.hash)}
			>
				<span class="route">{item.route}</span>
				<span class="label">{item.label}</span>
				{#if item.hash === "#/advisories" && advisoryCount > 0}
					<span class="count"><span class="count-inner">{advisoryCount}</span></span>
				{/if}
				{#if active}
					<span class="active-rail"></span>
				{/if}
			</button>
		{/each}
	</nav>

	<div class="spacer"></div>

	<div class="clock">
		<div class="clock-kicker">Local time · {tz}</div>
		<div class="clock-time mono tnum">{clock}</div>
	</div>
</header>

<style>
	.top-bar {
		position: relative;
		z-index: 10;
		display: flex;
		align-items: center;
		border-bottom: 1px solid var(--ink);
		background: var(--paper);
		flex-shrink: 0;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 22px;
		background: var(--ink);
		color: var(--paper);
		border: none;
		cursor: pointer;
		font-family: var(--font-display);
		font-size: 18px;
		font-weight: 700;
		letter-spacing: 0.04em;
	}

	.brand:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -4px;
	}

	.nav-links {
		display: flex;
		align-items: stretch;
	}

	.nav-btn {
		position: relative;
		padding: 14px 16px;
		background: transparent;
		border: none;
		border-right: 1px solid var(--rule-faint);
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--ink-2);
		transition: background 0.12s ease;
	}

	.nav-btn:hover:not(.active) {
		background: rgba(26, 24, 20, 0.04);
	}

	.nav-btn.active {
		background: var(--paper-3);
		color: var(--ink);
	}

	.route {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.16em;
		color: var(--ink-4);
	}

	.nav-btn.active .route {
		color: var(--accent);
	}

	.label {
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 600;
		letter-spacing: -0.005em;
	}

	.count {
		display: inline-grid;
		grid-template-columns: 1fr;
		min-width: 20px;
		height: 20px;
		padding: 0 6px;
		background: var(--accent);
		color: #fff;
		font-family: var(--font-header);
		font-size: 12px;
		font-weight: 700;
		border-radius: 999px;
		font-variant-numeric: tabular-nums lining-nums;
		box-sizing: border-box;
	}

	.count-inner {
		line-height: 18px;
		text-align: center;
		display: block;
	}

	.active-rail {
		position: absolute;
		left: 0;
		right: 0;
		bottom: -1px;
		height: 3px;
		background: var(--accent);
	}

	.spacer {
		flex: 1;
	}

	.clock {
		display: flex;
		align-items: center;
		gap: 18px;
		padding: 0 22px;
		color: var(--ink-2);
	}

	.clock-kicker {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-4);
		text-align: right;
	}

	.clock-time {
		font-size: 16px;
		font-weight: 500;
		letter-spacing: 0.04em;
		color: var(--ink);
		text-align: right;
	}
</style>
