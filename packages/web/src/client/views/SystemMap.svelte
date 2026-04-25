<script lang="ts">
import type { ThreadListEntry } from "@bound/client";
import { onDestroy, onMount } from "svelte";
import Btn from "../components/Btn.svelte";
import MemoryGraph from "../components/MemoryGraph.svelte";
import TextInput from "../components/TextInput.svelte";
import ThreadList from "../components/ThreadList.svelte";
import { client, connectWebSocket, subscribeToThread } from "../lib/bound";
import { navigateTo } from "../lib/router";

interface ThreadStatus {
	active: boolean;
}

let threads: ThreadListEntry[] = $state([]);
let threadStatuses: Map<string, ThreadStatus> = $state(new Map());
let hoveredThreadId: string | null = $state(null);
let searchQuery = $state("");
let creating = $state(false);
let subscribedIds = new Set<string>();

const filteredThreads = $derived(
	searchQuery.trim()
		? threads.filter((t) => {
				const q = searchQuery.toLowerCase();
				return (
					(t.title?.toLowerCase().includes(q) ?? false) ||
					(t.summary?.toLowerCase().includes(q) ?? false)
				);
			})
		: threads,
);

const hoveredThread = $derived(
	hoveredThreadId ? threads.find((t) => t.id === hoveredThreadId) : null,
);

// Refresh the thread list. Does NOT fan out per-thread status requests —
// the list response carries `active` per thread, and live changes arrive via
// the WebSocket `thread:status` channel.
async function loadThreads(): Promise<void> {
	try {
		const next = await client.listThreads();
		threads = next;
		const status = new Map(threadStatuses);
		for (const t of next) {
			// Only seed from the list if we haven't already received a fresher
			// status via WS (WS writes win on subsequent polls).
			if (!status.has(t.id)) {
				status.set(t.id, { active: t.active });
			}
			// Subscribe so the server starts emitting `thread:status` events.
			if (!subscribedIds.has(t.id)) {
				subscribeToThread(t.id);
				subscribedIds.add(t.id);
			}
		}
		threadStatuses = status;
	} catch (error) {
		console.error("Failed to load threads:", error);
	}
}

function handleThreadStatus(data: unknown): void {
	const s = data as {
		thread_id?: string;
		active?: boolean;
	};
	if (!s.thread_id) return;
	const next = new Map(threadStatuses);
	next.set(s.thread_id, { active: s.active ?? false });
	threadStatuses = next;
}

async function newThread(): Promise<void> {
	creating = true;
	try {
		const thread = await client.createThread();
		navigateTo(`/line/${thread.id}`);
	} catch (error) {
		console.error("Failed to create thread:", error);
		creating = false;
	}
}

function goToThread(id: string): void {
	navigateTo(`/line/${id}`);
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

onMount(async () => {
	connectWebSocket();
	client.on("thread:status", handleThreadStatus);
	await loadThreads();
	// Re-fetch the list less aggressively; status updates come via WS.
	pollInterval = setInterval(loadThreads, 15000);
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
	client.off("thread:status", handleThreadStatus);
});
</script>

<div class="system-map">
	<!-- Left — thread directory -->
	<div class="thread-panel">
		<div class="panel-header">
			<div class="header-top">
				<div>
					<div class="kicker">Active Lines · {threads.length}</div>
					<h2 class="panel-title">Directory</h2>
				</div>
				<Btn variant="accent" size="sm" onclick={newThread} disabled={creating} title="Start a new thread">
					{#snippet children()}
						+ New Line
					{/snippet}
				</Btn>
			</div>
			<TextInput
				value={searchQuery}
				onchange={(v) => (searchQuery = v)}
				placeholder="Search threads…"
				fullWidth={true}
			>
				{#snippet icon()}
					<svg
						width="12"
						height="12"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
					>
						<circle cx="7" cy="7" r="5" />
						<path d="M11 11l3.5 3.5" />
					</svg>
				{/snippet}
			</TextInput>
		</div>

		<div class="thread-scroll">
			<ThreadList
				threads={filteredThreads}
				{threadStatuses}
				selectedThreadId={hoveredThreadId}
				onSelectThread={(id) => goToThread(id)}
				onNavigateThread={goToThread}
				onHoverThread={(id) => (hoveredThreadId = id)}
			/>
		</div>
	</div>

	<!-- Right — memory graph -->
	<div class="map-panel">
		<MemoryGraph
			selectedThreadId={hoveredThreadId}
			hoveredThreadTitle={hoveredThread?.title ?? null}
			hoveredThreadColor={hoveredThread?.color ?? null}
			threads={filteredThreads}
			onNavigate={navigateTo}
		/>
	</div>
</div>

<style>
	.system-map {
		display: grid;
		grid-template-columns: 420px 1fr;
		flex: 1;
		min-height: 0;
		border-top: 1px solid var(--rule-soft);
	}

	.thread-panel {
		display: flex;
		flex-direction: column;
		background: var(--paper-2);
		border-right: 1px solid var(--rule-soft);
		overflow: hidden;
		min-height: 0;
	}

	.panel-header {
		padding: 20px 20px 14px;
		border-bottom: 1px solid var(--ink);
	}

	.header-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 10px;
		gap: 16px;
	}

	.kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.panel-title {
		margin: 2px 0 0;
		font-family: var(--font-header);
		font-size: 26px;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--ink);
	}

	.thread-scroll {
		overflow-y: auto;
		flex: 1;
		min-height: 0;
	}

	.map-panel {
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}

	@media (max-width: 960px) {
		.system-map {
			grid-template-columns: 1fr;
		}
		.thread-panel {
			border-right: none;
			border-bottom: 1px solid var(--rule-soft);
			max-height: 50vh;
		}
	}
</style>
