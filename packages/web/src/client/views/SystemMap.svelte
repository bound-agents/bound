<script lang="ts">
import { onDestroy, onMount, tick } from "svelte";
import { api } from "../lib/api";
import type { Thread } from "../lib/api";
// biome-ignore lint/correctness/noUnusedImports: used in template
import { LINE_CODES, LINE_COLORS, getLineColor } from "../lib/metro-lines";
// biome-ignore lint/correctness/noUnusedImports: used in template handlers
import { navigateTo } from "../lib/router";

interface ThreadStatus {
	active: boolean;
	state: string | null;
}

interface SplinePath {
	path: string;
	sourceColor: string;
	targetColor: string;
	gradientId: string;
}

let threads: Thread[] = $state([]);
// biome-ignore lint/correctness/noUnusedVariables: used in template
// biome-ignore lint/style/useConst: Svelte 5 $state() requires let
let creating = $state(false);
// biome-ignore lint/correctness/noUnusedVariables: used in template
// biome-ignore lint/style/useConst: Svelte 5 $state() requires let
let hoveredIdx = $state(-1);
let threadStatuses: Map<string, ThreadStatus> = $state(new Map());
let alertThreads: Set<string> = $state(new Set());
// biome-ignore lint/correctness/noUnusedVariables: used in template
let interchangeSplines = $state<SplinePath[]>([]);
// biome-ignore lint/correctness/noUnusedVariables: used in template
// biome-ignore lint/style/useConst: Svelte 5 $state() requires let
let threadListEl = $state<HTMLDivElement | null>(null);
// biome-ignore lint/correctness/noUnusedVariables: used in template
let svgHeight = $state(0);
let interchange: Record<string, Array<{ threadId: string; color: number }>> = {};

// biome-ignore lint/correctness/noUnusedVariables: used in template
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
		// Fetch status for each thread to detect active agent loops
		const statusMap = new Map<string, ThreadStatus>();
		const alerts = new Set<string>();
		await Promise.all(
			threads.map(async (t) => {
				try {
					const res = await fetch(`/api/threads/${t.id}/status`);
					if (res.ok) {
						const data = (await res.json()) as ThreadStatus;
						statusMap.set(t.id, data);
					}
				} catch {
					// Ignore individual status fetch failures
				}
				// Check for unread alerts in this thread
				try {
					const msgs = await api.listMessages(t.id);
					const hasAlert = msgs.some((m: { role: string }) => m.role === "alert");
					if (hasAlert) alerts.add(t.id);
				} catch {
					// Ignore
				}
			}),
		);
		threadStatuses = statusMap;
		alertThreads = alerts;
		// Fetch interchange data
		try {
			interchange = await api.getInterchange();
		} catch {
			interchange = {};
		}
	} catch (error) {
		console.error("Failed to load threads:", error);
	}

	// Recompute splines after DOM updates
	await tick();
	computeSplines();
}

function computeSplines(): void {
	if (!threadListEl || threads.length === 0) {
		interchangeSplines = [];
		svgHeight = 0;
		return;
	}

	const listRect = threadListEl.getBoundingClientRect();
	svgHeight = threadListEl.scrollHeight;

	// Build a map of threadId → { rowY, stationXPositions[] }
	const threadPositions = new Map<string, { y: number; stations: number[] }>();
	for (const thread of threads) {
		const rowEl = threadListEl.querySelector(`[data-thread-id="${thread.id}"]`);
		if (!rowEl) continue;

		const rowRect = rowEl.getBoundingClientRect();
		const y = rowRect.top - listRect.top + rowRect.height / 2;

		// Get station dot X positions
		const stationEls = rowEl.querySelectorAll(".track-station");
		const stations: number[] = [];
		for (const st of stationEls) {
			const stRect = st.getBoundingClientRect();
			stations.push(stRect.left - listRect.left + stRect.width / 2);
		}

		threadPositions.set(thread.id, { y, stations });
	}

	// Collect all connections, then assign each to a station column
	interface Connection {
		sourceId: string;
		targetId: string;
		sourceColor: number;
		targetColor: number;
	}
	const connections: Connection[] = [];
	for (const [targetId, sources] of Object.entries(interchange)) {
		if (!threadPositions.has(targetId)) continue;
		for (const source of sources) {
			if (!threadPositions.has(source.threadId)) continue;
			connections.push({
				sourceId: source.threadId,
				targetId,
				sourceColor: source.color,
				targetColor: threads.find((t) => t.id === targetId)?.color ?? 0,
			});
		}
	}

	if (connections.length === 0) {
		interchangeSplines = [];
		return;
	}

	// Find the minimum station count across involved threads
	const minStations = Math.min(
		...Array.from(threadPositions.values()).map((p) => p.stations.length),
	);
	if (minStations === 0) {
		interchangeSplines = [];
		return;
	}

	// Distribute connections across station columns to minimize overlap
	// Use different columns for different connections, wrapping if needed
	const splines: SplinePath[] = [];
	let gradIdx = 0;
	for (let ci = 0; ci < connections.length; ci++) {
		const conn = connections[ci];
		const sourcePos = threadPositions.get(conn.sourceId);
		const targetPos = threadPositions.get(conn.targetId);
		if (!sourcePos || !targetPos) continue;

		// Assign to a station column, spreading across available columns
		const colIdx = ci % minStations;
		const sourceX = sourcePos.stations[colIdx] ?? sourcePos.stations[0];
		const targetX = targetPos.stations[colIdx] ?? targetPos.stations[0];
		const sourceY = sourcePos.y;
		const targetY = targetPos.y;

		// Vertical distance determines curve amplitude
		const dist = Math.abs(targetY - sourceY);
		// Control points offset horizontally to create a smooth curve
		// Alternate left/right offset based on connection index to reduce overlap
		const direction = ci % 2 === 0 ? 1 : -1;
		const cpOffsetX = direction * (20 + (ci % 3) * 12);
		const cpOffsetY = dist * 0.3;

		// Use the midpoint X between source and target stations
		const midX = (sourceX + targetX) / 2 + cpOffsetX;

		const path = [
			`M ${sourceX} ${sourceY}`,
			`C ${midX} ${sourceY + cpOffsetY},`,
			`${midX} ${targetY - cpOffsetY},`,
			`${targetX} ${targetY}`,
		].join(" ");

		const sourceColor = getLineColor(conn.sourceColor);
		const targetColor = getLineColor(conn.targetColor);
		const gid = `interchange-${gradIdx++}`;

		splines.push({ path, sourceColor, targetColor, gradientId: gid });
	}

	interchangeSplines = splines;
}

onMount(async () => {
	await loadThreads();
	pollInterval = setInterval(loadThreads, 5000);
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
});

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

// biome-ignore lint/correctness/noUnusedVariables: used in template
function isAgentActive(threadId: string): boolean {
	const status = threadStatuses.get(threadId);
	return status?.active ?? false;
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function hasAlert(threadId: string): boolean {
	return alertThreads.has(threadId);
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
		<div class="thread-list" bind:this={threadListEl}>
			<!-- Interchange spline SVG overlay -->
			{#if interchangeSplines.length > 0}
				<svg class="interchange-overlay" width="100%" height={svgHeight}>
					<defs>
						{#each interchangeSplines as spline}
							<linearGradient id={spline.gradientId} gradientUnits="userSpaceOnUse">
								<stop offset="0%" stop-color={spline.sourceColor} />
								<stop offset="100%" stop-color={spline.targetColor} />
							</linearGradient>
						{/each}
					</defs>
					{#each interchangeSplines as spline}
						{@const gradRef = `url(#${spline.gradientId})`}
						<path
							d={spline.path}
							fill="none"
							stroke={gradRef}
							stroke-width="2"
							stroke-linecap="round"
							opacity="0.6"
						/>
					{/each}
				</svg>
			{/if}
			{#each threads as thread, idx}
				{@const color = LINE_COLORS[thread.color % LINE_COLORS.length]}
				{@const code = LINE_CODES[thread.color % LINE_CODES.length]}
				{@const active = isAgentActive(thread.id)}
				{@const alert = hasAlert(thread.id)}
				<button
					class="thread-row"
					data-thread-id={thread.id}
					class:hovered={hoveredIdx === idx}
					onclick={() => navigateTo(`/line/${thread.id}`)}
					onmouseenter={() => hoveredIdx = idx}
					onmouseleave={() => hoveredIdx = -1}
				>
					<!-- Hover background glow — positioned behind everything -->
					<div class="row-bg" style="--line-color: {color}"></div>

					<!-- Line badge -->
					<div class="line-badge" style="background: {color}">
						<span class="badge-inner"></span>
						<span class="badge-code">{code}</span>
					</div>

					<!-- Thread info -->
					<div class="thread-info">
						<div class="thread-name-row">
							<span class="thread-name">{threadLabel(thread, idx)}</span>
							{#if active}
								<span class="active-badge">LIVE</span>
							{/if}
							{#if alert}
								<span class="alert-badge-sm">!</span>
							{/if}
						</div>
						<span class="thread-meta">{relativeTime(thread.last_message_at)}</span>
					</div>

					<!-- Metro line decoration (pure CSS — no SVG stretching) -->
					<div class="line-track" style="--line-color: {color}">
						<div class="track-rail" class:thick={hoveredIdx === idx}></div>
						{#if alert}
							<div class="track-station alert-station"></div>
						{:else}
							<div class="track-station"></div>
						{/if}
						<div class="track-station"></div>
						<div class="track-station"></div>
						<div class="track-station"></div>
						{#if active}
							<div class="train-indicator" style="--line-color: {color}">
								<div class="train-body"></div>
							</div>
						{/if}
						<div class="track-terminus" class:terminus-active={active}></div>
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
		position: relative;
	}

	.interchange-overlay {
		position: absolute;
		top: 0;
		left: 0;
		pointer-events: none;
		z-index: 1;
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

	.badge-inner {
		position: absolute;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: #fff;
	}

	.badge-code {
		color: #000;
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 700;
		line-height: 1;
		position: relative;
		z-index: 1;
	}

	/* Thread info column */
	.thread-info {
		flex-shrink: 0;
		min-width: 180px;
		max-width: 280px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		position: relative;
		z-index: 1;
	}

	.thread-name-row {
		display: flex;
		align-items: center;
		gap: 8px;
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

	.active-badge {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 700;
		color: var(--status-active);
		background: rgba(105, 240, 174, 0.12);
		border: 1px solid rgba(105, 240, 174, 0.3);
		padding: 1px 6px;
		border-radius: 3px;
		letter-spacing: 0.06em;
		animation: badge-pulse 2s ease-in-out infinite;
	}

	@keyframes badge-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.6; }
	}

	.alert-badge-sm {
		flex-shrink: 0;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--alert-disruption);
		color: #fff;
		font-family: var(--font-display);
		font-size: 11px;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		animation: alert-pulse 1.5s ease-in-out infinite;
	}

	@keyframes alert-pulse {
		0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255, 23, 68, 0.4); }
		50% { transform: scale(1.1); box-shadow: 0 0 8px 2px rgba(255, 23, 68, 0.3); }
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

	/* Pulsing red alert station */
	.track-station.alert-station {
		background: var(--alert-disruption);
		border-color: var(--alert-disruption);
		box-shadow: 0 0 6px rgba(255, 23, 68, 0.5);
		animation: station-alert 1.5s ease-in-out infinite;
	}

	@keyframes station-alert {
		0%, 100% { box-shadow: 0 0 4px rgba(255, 23, 68, 0.4); transform: scale(1); }
		50% { box-shadow: 0 0 10px rgba(255, 23, 68, 0.7); transform: scale(1.2); }
	}

	/* Animated train indicator sliding along the track */
	.train-indicator {
		position: relative;
		z-index: 2;
		flex-shrink: 0;
		animation: train-slide 3s ease-in-out infinite;
	}

	.train-body {
		width: 20px;
		height: 8px;
		background: var(--line-color);
		border-radius: 4px;
		box-shadow: 0 0 8px color-mix(in srgb, var(--line-color) 60%, transparent);
		position: relative;
	}

	.train-body::before {
		content: "";
		position: absolute;
		right: -2px;
		top: 1px;
		width: 4px;
		height: 6px;
		background: #fff;
		border-radius: 0 2px 2px 0;
		opacity: 0.9;
	}

	@keyframes train-slide {
		0% { transform: translateX(-8px); }
		50% { transform: translateX(8px); }
		100% { transform: translateX(-8px); }
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

	.track-terminus.terminus-active {
		box-shadow: 0 0 10px color-mix(in srgb, var(--line-color) 50%, transparent);
		animation: terminus-active-pulse 1.5s ease-in-out infinite;
	}

	@keyframes train-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.6; }
	}

	@keyframes terminus-active-pulse {
		0%, 100% { transform: scale(1); box-shadow: 0 0 6px color-mix(in srgb, var(--line-color) 40%, transparent); }
		50% { transform: scale(1.3); box-shadow: 0 0 14px color-mix(in srgb, var(--line-color) 60%, transparent); }
	}

	@media (prefers-reduced-motion: reduce) {
		.track-terminus,
		.track-terminus.terminus-active,
		.train-indicator,
		.active-badge,
		.alert-badge-sm,
		.track-station.alert-station {
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
