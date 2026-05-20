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

// PAGE_SIZE is large enough to cover most viewports without immediately
// triggering a "load more" on mount, small enough to keep the SQL bounded.
// Server caps at 200 — see packages/web/src/server/routes/threads.ts.
const PAGE_SIZE = 50;

// Source of truth is the id→entry map; the directory list is derived from it.
// Holding the map lets us merge poll results without throwing away threads
// loaded by paginated "load more" calls.
let threadsById: Map<string, ThreadListEntry> = $state(new Map());
let hasMoreThreads = $state(false);
let isLoadingMore = $state(false);
let threadStatuses: Map<string, ThreadStatus> = $state(new Map());
let hoveredThreadId: string | null = $state(null);
let searchQuery = $state("");
let creating = $state(false);
let subscribedIds = new Set<string>();

const threads = $derived.by(() => {
	const arr = [...threadsById.values()];
	arr.sort((a, b) => {
		if (a.last_message_at !== b.last_message_at) {
			return b.last_message_at.localeCompare(a.last_message_at);
		}
		return b.id.localeCompare(a.id);
	});
	return arr;
});

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

// Merge a freshly-fetched batch into the local map and seed status/subscriptions.
// `prunePage1Window` is true only for the polling fetch; it removes any cached
// thread that *should* have appeared in this page-1 result but didn't,
// catching deletions of threads currently in the newest-N window.
// `last_message_at` is monotonic (only bumps forward when a new message
// arrives), so a thread cannot fall off page 1 by being bumped — only by
// deletion.
function mergeBatch(batch: ThreadListEntry[], opts: { prunePage1Window?: boolean } = {}): void {
	const map = new Map(threadsById);
	const status = new Map(threadStatuses);

	if (opts.prunePage1Window) {
		const liveIds = new Set(batch.map((t) => t.id));
		if (batch.length === PAGE_SIZE) {
			const cursor = batch[batch.length - 1].last_message_at;
			for (const [id, t] of map) {
				if (t.last_message_at >= cursor && !liveIds.has(id)) {
					map.delete(id);
					status.delete(id);
				}
			}
		} else {
			// Fewer than PAGE_SIZE — that's the entire visible set.
			for (const id of [...map.keys()]) {
				if (!liveIds.has(id)) {
					map.delete(id);
					status.delete(id);
				}
			}
		}
	}

	for (const t of batch) {
		map.set(t.id, t);
		// Only seed from the list if WS hasn't already given us a fresher status.
		if (!status.has(t.id)) {
			status.set(t.id, { active: t.active });
		}
		if (!subscribedIds.has(t.id)) {
			subscribeToThread(t.id);
			subscribedIds.add(t.id);
		}
	}

	threadsById = map;
	threadStatuses = status;
}

// Refresh the visible head of the thread list. Polled every 15s plus run on
// mount; status updates between polls flow over the WS `thread:status`
// channel. Older paginated pages remain in the map — they don't get
// re-fetched per-poll, but their per-thread status updates flow over WS.
async function loadThreads(): Promise<void> {
	try {
		const next = await client.listThreads({ limit: PAGE_SIZE });
		mergeBatch(next, { prunePage1Window: true });
		// We only know "no more" definitively when the page came back short;
		// a full page tells us nothing about further pages without paginating.
		if (next.length < PAGE_SIZE) {
			hasMoreThreads = false;
		} else if (threadsById.size === next.length) {
			// First-ever load returned a full page — assume there might be more.
			hasMoreThreads = true;
		}
	} catch (error) {
		console.error("Failed to load threads:", error);
	}
}

async function loadMoreThreads(): Promise<void> {
	if (!hasMoreThreads || isLoadingMore) return;
	const list = threads;
	if (list.length === 0) return;
	const last = list[list.length - 1];
	isLoadingMore = true;
	try {
		const next = await client.listThreads({
			limit: PAGE_SIZE,
			before: { last_message_at: last.last_message_at, id: last.id },
		});
		mergeBatch(next);
		hasMoreThreads = next.length === PAGE_SIZE;
	} catch (error) {
		console.error("Failed to load more threads:", error);
	} finally {
		isLoadingMore = false;
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
	// Re-fetch the head of the list less aggressively; status updates come via WS.
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
				onLoadMore={loadMoreThreads}
				hasMore={hasMoreThreads && !searchQuery.trim()}
				isLoadingMore={isLoadingMore}
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
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		/* No overflow here — ThreadList owns its own scrolling so its
		   internal virtualization can hook the scroll container directly. */
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
