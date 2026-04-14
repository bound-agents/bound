<script lang="ts">
import { onDestroy, onMount } from "svelte";
import MemoryGraph from "../components/MemoryGraph.svelte";
import SectionHeader from "../components/SectionHeader.svelte";
import ThreadList from "../components/ThreadList.svelte";
import { api } from "../lib/api";
import type { Thread } from "../lib/api";
import { navigateTo } from "../lib/router";

interface ThreadStatus {
	active: boolean;
}

let threads: Thread[] = $state([]);
let threadStatuses: Map<string, ThreadStatus> = $state(new Map());
let selectedThreadId: string | null = $state(null);
let mapCollapsed = $state(false);
let creating = $state(false);
let resizing = $state(false);
let panelRatio = $state(0.4);

let containerEl: HTMLDivElement | null = null;

async function loadThreads(): Promise<void> {
	try {
		threads = await api.listThreads();

		const statusMap = new Map<string, ThreadStatus>();
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
			}),
		);
		threadStatuses = statusMap;
	} catch (error) {
		console.error("Failed to load threads:", error);
	}
}

async function newThread(): Promise<void> {
	creating = true;
	try {
		const thread = await api.createThread();
		navigateTo(`/line/${thread.id}`);
	} catch (error) {
		console.error("Failed to create thread:", error);
		creating = false;
	}
}

function toggleMap(): void {
	mapCollapsed = !mapCollapsed;
}

function handlePointerDown(): void {
	resizing = true;
}

function handlePointerMove(event: PointerEvent): void {
	if (!resizing || !containerEl) return;

	const rect = containerEl.getBoundingClientRect();
	const newRatio = (event.clientX - rect.left) / rect.width;
	panelRatio = Math.max(0.2, Math.min(0.8, newRatio));
}

function handlePointerUp(): void {
	resizing = false;
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

onMount(async () => {
	await loadThreads();
	pollInterval = setInterval(loadThreads, 5000);

	window.addEventListener("pointermove", handlePointerMove);
	window.addEventListener("pointerup", handlePointerUp);

	return () => {
		window.removeEventListener("pointermove", handlePointerMove);
		window.removeEventListener("pointerup", handlePointerUp);
	};
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
	window.removeEventListener("pointermove", handlePointerMove);
	window.removeEventListener("pointerup", handlePointerUp);
});
</script>

<div class="system-map" bind:this={containerEl}>
	<SectionHeader title="System Map">
		{#snippet actions()}
			<button
				class="header-btn"
				onclick={toggleMap}
				title={mapCollapsed ? "Show map" : "Hide map"}
			>
				{mapCollapsed ? "Show Map" : "Hide Map"}
			</button>
			<button
				class="header-btn"
				onclick={newThread}
				disabled={creating}
				title="Create new thread"
			>
				+ New Line
			</button>
		{/snippet}
	</SectionHeader>

	<div class="split-view" class:map-collapsed={mapCollapsed} style={mapCollapsed ? '' : `grid-template-columns: ${(panelRatio * 100).toFixed(1)}% 4px 1fr`}>
		<div class="thread-panel">
			<ThreadList
				{threads}
				{threadStatuses}
				{selectedThreadId}
				onSelectThread={(id) => (selectedThreadId = id)}
				onNavigateThread={(id) => navigateTo(`/line/${id}`)}
			/>
		</div>

		{#if !mapCollapsed}
			<div
				class="resizer"
				onpointerdown={handlePointerDown}
				role="separator"
				aria-orientation="vertical"
				aria-valuenow={Math.round(panelRatio * 100)}
			>
				<!-- drag handle -->
			</div>
			<div class="map-panel">
				<MemoryGraph {selectedThreadId} />
			</div>
		{/if}
	</div>
</div>

<style>
	.system-map {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		padding: 32px 40px;
		gap: 16px;
	}

	.header-btn {
		padding: 8px 16px;
		background: var(--bg-surface);
		color: var(--text-primary);
		border: 1px solid var(--bg-surface);
		border-radius: 6px;
		cursor: pointer;
		font-family: var(--font-display);
		font-size: var(--text-sm);
		font-weight: 600;
		transition: all 0.2s ease;
	}

	.header-btn:hover:not(:disabled) {
		background: rgba(15, 52, 96, 0.3);
		border-color: var(--line-0);
	}

	.header-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.split-view {
		display: grid;
		grid-template-columns: 40% 4px 1fr;
		gap: 0;
		height: calc(100vh - 200px);
		overflow: hidden;
	}

	.split-view.map-collapsed {
		grid-template-columns: 1fr;
	}

	.thread-panel {
		overflow-y: auto;
		background: var(--bg-primary);
		border-right: 1px solid var(--bg-surface);
		padding-right: 12px;
	}

	.resizer {
		cursor: col-resize;
		background: var(--bg-surface);
		width: 4px;
		user-select: none;
		transition: background 0.2s ease;
	}

	.resizer:hover {
		background: var(--line-0);
	}

	.map-panel {
		overflow: hidden;
		background: var(--bg-primary);
		display: flex;
		flex-direction: column;
	}

	@media (max-width: 900px) {
		.system-map {
			padding: 16px 24px;
		}

		.split-view {
			grid-template-columns: 1fr;
			height: auto;
		}

		.thread-panel {
			border-right: none;
			border-bottom: 1px solid var(--bg-surface);
			padding-right: 0;
			padding-bottom: 12px;
			max-height: 60vh;
		}

		.resizer {
			display: none;
		}

		.map-panel {
			max-height: 50vh;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.header-btn,
		.resizer {
			transition: none;
		}
	}
</style>
