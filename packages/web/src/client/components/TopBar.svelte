<script lang="ts">
import { onDestroy, onMount } from "svelte";
// biome-ignore lint/correctness/noUnusedImports: used in template
import ModelSelector from "./ModelSelector.svelte";

// biome-ignore lint/correctness/noUnusedVariables: used in template
function navigate(hash: string): void {
	window.location.hash = hash;
}

let currentHash = $state(window.location.hash);

// biome-ignore lint/correctness/noUnusedVariables: used in template
function isActive(hash: string): boolean {
	const current = currentHash.slice(1) || "/";
	if (hash === "#/") return current === "/" || current === "";
	return current.startsWith(hash.slice(1));
}

// Navigation items with their metro line color associations
// biome-ignore lint/correctness/noUnusedVariables: used in template
const navItems = [
	{ hash: "#/", label: "System Map", color: "var(--line-0)" },
	{ hash: "#/timetable", label: "Timetable", color: "var(--line-3)" },
	{ hash: "#/network", label: "Network", color: "var(--line-4)" },
	{ hash: "#/files", label: "Files", color: "var(--line-3)" },
	{ hash: "#/advisories", label: "Advisories", color: "var(--line-5)" },
];

// biome-ignore lint/correctness/noUnusedVariables: used in template
let advisoryCount = $state(0);
let advisoryPollInterval: ReturnType<typeof setInterval> | null = null;

async function loadAdvisoryCount(): Promise<void> {
	try {
		const response = await fetch("/api/advisories/count");
		if (response.ok) {
			const data = (await response.json()) as { count: number };
			advisoryCount = data.count;
		}
	} catch {
		// Ignore fetch errors for count
	}
}

function onHashChange(): void {
	currentHash = window.location.hash;
}

onMount(() => {
	window.addEventListener("hashchange", onHashChange);
	loadAdvisoryCount();
	advisoryPollInterval = setInterval(loadAdvisoryCount, 10000);
});

onDestroy(() => {
	window.removeEventListener("hashchange", onHashChange);
	if (advisoryPollInterval !== null) clearInterval(advisoryPollInterval);
});
</script>

<div class="top-bar">
	<div class="app-name" onclick={() => navigate("#/")} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") navigate("#/"); }} role="button" tabindex={0}>
		<span class="app-logo">
			<svg width="20" height="20" viewBox="0 0 20 20">
				<circle cx="10" cy="10" r="9" fill="none" stroke="var(--line-0)" stroke-width="2" />
				<circle cx="10" cy="10" r="4" fill="var(--line-0)" />
			</svg>
		</span>
		<span class="app-title">Bound</span>
	</div>

	<nav class="nav-links">
		{#each navItems as item}
			<button
				class="nav-btn"
				class:active={isActive(item.hash)}
				onclick={() => navigate(item.hash)}
				style="--nav-color: {item.color}"
			>
				<span class="nav-dot" style="background: {item.color}"></span>
				{item.label}
				{#if item.hash === "#/advisories" && advisoryCount > 0}
					<span class="nav-count">{advisoryCount}</span>
				{/if}
			</button>
		{/each}
	</nav>

	<div class="spacer"></div>
	<ModelSelector />
	<button class="indicators" onclick={() => navigate("#/advisories")} class:has-advisories={advisoryCount > 0}>
		<span class="indicator-dot" class:indicator-alert={advisoryCount > 0}></span>
		<span class="indicator-label">{advisoryCount} advisor{advisoryCount !== 1 ? "ies" : "y"}</span>
	</button>
</div>

<style>
	.top-bar {
		display: flex;
		align-items: center;
		padding: 0 24px;
		height: 56px;
		background: var(--bg-secondary);
		border-bottom: 2px solid var(--bg-surface);
		gap: 24px;
		flex-shrink: 0;
	}

	.app-name {
		display: flex;
		align-items: center;
		gap: 10px;
		cursor: pointer;
		user-select: none;
		padding: 4px 0;
	}

	.app-name:focus-visible {
		outline: 2px solid var(--line-0);
		outline-offset: 4px;
		border-radius: 4px;
	}

	.app-logo {
		display: flex;
		align-items: center;
	}

	.app-title {
		font-family: var(--font-display);
		font-weight: 700;
		font-size: var(--text-lg);
		letter-spacing: 0.04em;
		color: var(--text-primary);
	}

	.nav-links {
		display: flex;
		gap: 4px;
	}

	.nav-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 16px;
		background: transparent;
		color: var(--text-secondary);
		border: 1px solid transparent;
		border-radius: 6px;
		cursor: pointer;
		font-family: var(--font-display);
		font-size: var(--text-sm);
		font-weight: 600;
		transition: all 0.2s ease;
		white-space: nowrap;
	}

	.nav-btn:hover {
		background: rgba(15, 52, 96, 0.5);
		color: var(--text-primary);
	}

	.nav-btn.active {
		background: var(--bg-surface);
		color: var(--text-primary);
		border-color: var(--nav-color);
	}

	.nav-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
		transition: transform 0.2s ease;
	}

	.nav-btn:hover .nav-dot {
		transform: scale(1.3);
	}

	.nav-btn.active .nav-dot {
		box-shadow: 0 0 6px var(--nav-color);
	}

	.spacer {
		flex: 1;
	}

	.nav-count {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 700;
		color: var(--alert-warning);
		background: rgba(255, 145, 0, 0.15);
		padding: 1px 6px;
		border-radius: 8px;
		min-width: 16px;
		text-align: center;
	}

	.indicators {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-display);
		font-size: var(--text-sm);
		color: var(--text-muted);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 6px;
		padding: 6px 12px;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.indicators:hover {
		background: rgba(15, 52, 96, 0.5);
		color: var(--text-primary);
	}

	.indicators.has-advisories {
		border-color: rgba(255, 145, 0, 0.3);
	}

	.indicator-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--status-active);
		transition: background 0.2s ease;
	}

	.indicator-dot.indicator-alert {
		background: var(--alert-warning);
		box-shadow: 0 0 6px rgba(255, 145, 0, 0.4);
		animation: indicator-pulse 2s ease-in-out infinite;
	}

	@keyframes indicator-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.5; }
	}

	.indicator-label {
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	@media (prefers-reduced-motion: reduce) {
		.indicator-dot.indicator-alert {
			animation: none;
		}
	}
</style>
