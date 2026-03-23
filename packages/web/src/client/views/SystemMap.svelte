<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { api } from "../lib/api";
import type { Thread } from "../lib/api";
// biome-ignore lint/correctness/noUnusedImports: used in template handlers
import { navigateTo } from "../lib/router";

// biome-ignore lint/correctness/noUnusedVariables: used in template
let threads: Thread[] = $state([]);
let creating = $state(false);
// biome-ignore lint/correctness/noUnusedVariables: used in template
const hoveredIdx = $state(-1);

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
		return t.length > 32 ? `${t.substring(0, 30)}…` : t;
	}
	return `Thread ${idx + 1}`;
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function relativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
</script>

<div class="system-map">
	<div class="map-header">
		<h1>System Map</h1>
		<button class="new-thread-btn" onclick={createThread} disabled={creating}>
			<span class="btn-icon">+</span>
			{creating ? "Creating…" : "New Line"}
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
		<div class="thread-list">
			{#each threads as thread, idx}
				{@const color = colors[thread.color % colors.length]}
				{@const code = lineCodes[thread.color % lineCodes.length]}
				<button
					class="thread-row"
					class:hovered={hoveredIdx === idx}
					onclick={() => navigateTo(`/line/${thread.id}`)}
					onmouseenter={() => hoveredIdx = idx}
					onmouseleave={() => hoveredIdx = -1}
				>
					<!-- Hover background glow — positioned behind everything -->
					<div class="row-bg" style="--line-color: {color}"></div>

					<!-- Line badge -->
					<div class="line-badge" style="background: {color}">
						<span class="badge-code">{code}</span>
					</div>

					<!-- Thread info -->
					<div class="thread-info">
						<span class="thread-name">{threadLabel(thread, idx)}</span>
						<span class="thread-meta">{relativeTime(thread.last_message_at)}</span>
					</div>

					<!-- Metro line decoration (pure CSS — no SVG stretching) -->
					<div class="line-track" style="--line-color: {color}">
						<div class="track-rail" class:thick={hoveredIdx === idx}></div>
						<div class="track-station"></div>
						<div class="track-station"></div>
						<div class="track-station"></div>
						<div class="track-station"></div>
						<div class="track-terminus"></div>
					</div>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.system-map {
		padding: 32px 40px;
		overflow: hidden;
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

	/* Thread list */
	.thread-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: calc(100vh - 180px);
		overflow-y: auto;
	}

	.thread-row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 14px 16px;
		border: none;
		border-radius: 8px;
		background: transparent;
		cursor: pointer;
		text-align: left;
		width: 100%;
		font-family: inherit;
		color: inherit;
		transition: transform 0.15s ease;
	}

	.thread-row:hover,
	.thread-row.hovered {
		transform: translateX(2px);
	}

	/* Hover background glow — sits behind all content */
	.row-bg {
		position: absolute;
		inset: 0;
		border-radius: 8px;
		opacity: 0;
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--line-color) 12%, transparent) 0%,
			color-mix(in srgb, var(--line-color) 6%, transparent) 60%,
			transparent 100%
		);
		border-left: 3px solid var(--line-color);
		transition: opacity 0.2s ease;
		pointer-events: none;
	}

	.thread-row:hover .row-bg,
	.thread-row.hovered .row-bg {
		opacity: 1;
	}

	.thread-row:focus-visible {
		outline: 2px solid var(--line-0);
		outline-offset: 2px;
	}

	/* Line badge (circle with letter) */
	.line-badge {
		flex-shrink: 0;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		position: relative;
		z-index: 1;
	}

	.badge-code {
		color: #fff;
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 700;
		line-height: 1;
	}

	/* Thread info column */
	.thread-info {
		flex-shrink: 0;
		min-width: 180px;
		max-width: 260px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		position: relative;
		z-index: 1;
	}

	.thread-name {
		font-family: var(--font-display);
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.thread-meta {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	/* Metro line track decoration */
	.line-track {
		flex: 1;
		min-width: 0;
		height: 20px;
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: space-evenly;
		padding: 0 8px;
	}

	/* The horizontal rail line — positioned behind stations */
	.track-rail {
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		height: 3.5px;
		transform: translateY(-50%);
		background: var(--line-color);
		border-radius: 2px;
		transition: height 0.2s ease;
	}

	.track-rail.thick {
		height: 5px;
	}

	/* Station dots — white fill with colored border (Beck style) */
	.track-station {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: #fff;
		border: 2.5px solid var(--line-color);
		position: relative;
		z-index: 1;
		flex-shrink: 0;
	}

	/* Terminus — filled circle with pulse */
	.track-terminus {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--line-color);
		position: relative;
		z-index: 1;
		flex-shrink: 0;
		animation: train-pulse 2.5s ease-in-out infinite;
	}

	@keyframes train-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.6; }
	}

	@media (prefers-reduced-motion: reduce) {
		.terminus {
			animation: none;
		}

		.thread-row {
			transition: none;
		}

		.row-bg {
			transition: none;
		}
	}
</style>
