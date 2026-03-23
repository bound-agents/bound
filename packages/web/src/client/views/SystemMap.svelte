<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { api } from "../lib/api";
import type { Thread } from "../lib/api";
// biome-ignore lint/correctness/noUnusedImports: used in template handlers
import { navigateTo } from "../lib/router";

// biome-ignore lint/correctness/noUnusedVariables: used in template
let threads: Thread[] = $state([]);
let creating = $state(false);

async function createThread(): Promise<void> {
	creating = true;
	try {
		const thread = await api.createThread();
		window.location.hash = `#/line/${thread.id}`;
	} catch (error) {
		console.error("Failed to create thread:", error);
		creating = false;
	}
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

async function loadThreads(): Promise<void> {
	try {
		threads = await api.listThreads();
	} catch (error) {
		console.error("Failed to load threads:", error);
	}
}

onMount(async () => {
	await loadThreads();
	pollInterval = setInterval(loadThreads, 5000);
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
});

// Authentic Tokyo Metro line palette
// biome-ignore lint/correctness/noUnusedVariables: used in template
const colors = [
	"#F39700", // Ginza (G)        — orange
	"#E60012", // Marunouchi (M)   — red
	"#9CAEB7", // Hibiya (H)       — silver
	"#009BBF", // Tozai (T)        — sky blue
	"#009944", // Chiyoda (C)      — green
	"#C1A470", // Yurakucho (Y)    — gold
	"#8F76D6", // Hanzomon (Z)     — purple
	"#00AC9B", // Namboku (N)      — emerald
	"#9C5E31", // Fukutoshin (F)   — brown
	"#B6007A", // Oedo (E)         — ruby
];

// Metro line letter codes matching Tokyo Metro's station numbering
// biome-ignore lint/correctness/noUnusedVariables: used in template
const lineCodes = ["G", "M", "H", "T", "C", "Y", "Z", "N", "F", "E"];

// biome-ignore lint/correctness/noUnusedVariables: used in template
function threadLabel(thread: Thread, idx: number): string {
	if (thread.title && thread.title.trim().length > 0) {
		const t = thread.title.trim();
		return t.length > 24 ? `${t.substring(0, 22)}…` : t;
	}
	return `Thread ${idx + 1}`;
}
</script>

<div class="system-map">
	<div class="map-header">
		<h1>System Map</h1>
		<button class="new-thread-btn" onclick={createThread} disabled={creating}>
			<span class="btn-icon">+</span>
			{creating ? "Creating..." : "New Line"}
		</button>
	</div>

	{#if threads.length === 0}
		<div class="empty-state">
			<svg width="120" height="80" viewBox="0 0 120 80">
				<line x1="10" y1="40" x2="110" y2="40" stroke="var(--text-muted)" stroke-width="4" stroke-linecap="round" stroke-dasharray="8 6" opacity="0.4" />
				<circle cx="30" cy="40" r="6" fill="none" stroke="var(--text-muted)" stroke-width="2" opacity="0.4" />
				<circle cx="60" cy="40" r="6" fill="none" stroke="var(--text-muted)" stroke-width="2" opacity="0.4" />
				<circle cx="90" cy="40" r="6" fill="none" stroke="var(--text-muted)" stroke-width="2" opacity="0.4" />
			</svg>
			<p>No active lines. Start a conversation to open a new line.</p>
		</div>
	{:else}
		{@const svgHeight = Math.max(100, threads.length * 56 + 48)}
		<div class="metro-container">
			<svg viewBox="0 0 1200 {svgHeight}" class="metro-diagram">
				<defs>
					{#each threads as thread, idx}
						{@const color = colors[thread.color % colors.length]}
						<filter id="glow-{idx}">
							<feGaussianBlur stdDeviation="2" result="blur" />
							<feComposite in="SourceGraphic" in2="blur" operator="over" />
						</filter>
					{/each}
				</defs>

				{#each threads as thread, idx}
					{@const color = colors[thread.color % colors.length]}
					{@const code = lineCodes[thread.color % lineCodes.length]}
					{@const yPos = 36 + idx * 56}

					<!-- Line code badge (circle + letter) -->
					<circle cx="40" cy={yPos} r="16" fill={color} />
					<text
						x="40"
						y={yPos}
						font-size="13"
						font-weight="700"
						fill="#fff"
						text-anchor="middle"
						dominant-baseline="central"
						font-family="'Nunito Sans', sans-serif"
					>{code}</text>

					<!-- Thread name -->
					<text
						x="66"
						y={yPos}
						font-size="12"
						fill="var(--text-secondary)"
						dominant-baseline="central"
						font-family="'Nunito Sans', sans-serif"
						font-weight="600"
					>{threadLabel(thread, idx)}</text>

					<!-- Main line -->
					<line
						x1="220"
						y1={yPos}
						x2="1160"
						y2={yPos}
						stroke={color}
						stroke-width="6"
						stroke-linecap="round"
						class="metro-line"
					/>

					<!-- Station dots: white fill with colored stroke (Beck style) -->
					<circle cx="280" cy={yPos} r="7" fill="#fff" stroke={color} stroke-width="3" class="station" />
					<circle cx="440" cy={yPos} r="7" fill="#fff" stroke={color} stroke-width="3" class="station" />
					<circle cx="600" cy={yPos} r="7" fill="#fff" stroke={color} stroke-width="3" class="station" />
					<circle cx="760" cy={yPos} r="7" fill="#fff" stroke={color} stroke-width="3" class="station" />
					<circle cx="920" cy={yPos} r="7" fill="#fff" stroke={color} stroke-width="3" class="station" />

					<!-- Terminus: filled station -->
					<circle cx="1080" cy={yPos} r="8" fill={color} class="station terminus" filter="url(#glow-{idx})" />

					<!-- Clickable area -->
					<rect
						x="30"
						y={yPos - 26}
						width="1140"
						height="52"
						fill="transparent"
						class="line-clickable"
						onclick={() => navigateTo(`/line/${thread.id}`)}
						onkeydown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								navigateTo(`/line/${thread.id}`);
							}
						}}
						role="button"
						tabindex={idx}
					/>
				{/each}
			</svg>
		</div>
	{/if}
</div>

<style>
	.system-map {
		padding: 32px 40px;
	}

	.map-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 32px;
	}

	h1 {
		margin: 0;
		color: var(--text-primary);
		font-family: var(--font-display);
		font-size: var(--text-xl);
		font-weight: 700;
		letter-spacing: 0.02em;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 64px 32px;
		gap: 24px;
	}

	.empty-state p {
		color: var(--text-muted);
		font-size: var(--text-sm);
		margin: 0;
	}

	.new-thread-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 20px;
		background: var(--bg-surface);
		color: var(--text-primary);
		border: 1px solid var(--line-0);
		border-radius: 6px;
		cursor: pointer;
		font-family: var(--font-display);
		font-size: var(--text-sm);
		font-weight: 600;
		transition: all 0.2s ease;
	}

	.new-thread-btn:hover:not(:disabled) {
		background: #1a4a8a;
		border-color: var(--line-0);
		box-shadow: 0 0 12px rgba(243, 151, 0, 0.15);
	}

	.new-thread-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-icon {
		font-size: 18px;
		font-weight: 700;
		line-height: 1;
	}

	.metro-container {
		display: block;
		max-width: 1200px;
		max-height: 420px;
		overflow-y: auto;
		overflow-x: hidden;
	}

	.metro-diagram {
		display: block;
		width: 100%;
		height: auto;
		background: rgba(10, 10, 20, 0.6);
		border: 1px solid var(--bg-surface);
		border-radius: 8px;
	}

	.metro-line {
		stroke-linecap: round;
		transition: stroke-width 0.2s ease;
	}

	.station {
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.station:hover {
		r: 9;
	}

	.terminus {
		animation: train-pulse 2.5s ease-in-out infinite;
	}

	@keyframes train-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.6; }
	}

	.line-clickable {
		cursor: pointer;
	}

	.line-clickable:hover ~ .metro-line {
		stroke-width: 8;
	}

	.line-clickable:hover {
		fill: rgba(255, 255, 255, 0.03);
	}

	.line-clickable:focus-visible {
		outline: none;
		fill: rgba(255, 255, 255, 0.05);
	}

	@media (prefers-reduced-motion: reduce) {
		.terminus {
			animation: none;
		}
	}
</style>
