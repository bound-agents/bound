<script lang="ts">
import type { ThreadListEntry } from "@bound/client";
import { onMount } from "svelte";
import { formatRelativeTime, isToday } from "../lib/format-time";
import { getLineColor, getLineName } from "../lib/metro-lines";
import { lineRoute } from "../lib/route-utils";
import LineBadge from "./LineBadge.svelte";

interface Props {
	threads: ThreadListEntry[];
	threadStatuses: Map<string, { active: boolean }>;
	selectedThreadId?: string | null;
	onSelectThread?: (threadId: string) => void;
	onNavigateThread?: (threadId: string) => void;
	onHoverThread?: (threadId: string | null) => void;
	/**
	 * Fired when the user scrolls within `LOAD_MORE_THRESHOLD_PX` of the
	 * bottom of the list AND `hasMore` is true. The parent is responsible
	 * for guarding double-fires by toggling `isLoadingMore` synchronously
	 * before awaiting the fetch.
	 */
	onLoadMore?: () => void;
	hasMore?: boolean;
	isLoadingMore?: boolean;
}

let {
	threads,
	threadStatuses,
	selectedThreadId,
	onSelectThread,
	onNavigateThread,
	onHoverThread,
	onLoadMore,
	hasMore = false,
	isLoadingMore = false,
}: Props = $props();

function sanitizeTitle(title: string | null): string {
	if (!title || title.trim() === "" || title === ".") return "Untitled";
	const clean = title
		.replace(/<tool_call>[\s\S]*/g, "")
		.replace(/<\/?[^>]+>/g, "")
		.replace(/#+\s+/g, " ")
		.replace(/\*\*/g, "")
		.replace(/\*([^*]*)\*/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	return clean || "Untitled";
}

// Seeded 24h activity sparkline — deterministic per thread id, weighted by
// messageCount and skewed toward the most recent hours so the sparkline feels
// "alive" for active threads and quiet for older ones.
function makeActivity(seed: string, messageCount: number): number[] {
	let s = 0;
	for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
	const rand = () => {
		s = (s * 9301 + 49297) >>> 0;
		return (s % 233280) / 233280;
	};
	const peak = Math.max(2, Math.min(10, Math.ceil(messageCount / 6)));
	const out: number[] = [];
	for (let i = 0; i < 24; i++) {
		const recencyWeight = 0.25 + (i / 23) * 0.75;
		out.push(Math.round(rand() * peak * recencyWeight));
	}
	return out;
}

// Virtualization: flatten group headers + thread cards into a single linear
// list of `Item`s, then only render the slice currently visible inside the
// scroll container. With ~325 threads this drops DOM node count from ~5000
// to ~50ish at any time, so scrolling stays smooth.
type Item =
	| { kind: "header"; key: string; label: string; height: number }
	| {
			kind: "thread";
			key: string;
			thread: ThreadListEntry;
			height: number;
	  };

// Estimated heights — these don't have to be exact, they just need to be
// stable so the scrollbar doesn't jump as cards come in/out of the window.
// `with-summary` cards are ~170px (sparkline + 2-line summary clamp + meta);
// `no-summary` cards are ~134px. Picking a single 162px estimate for cards
// minimizes drift in the common case (most threads have summaries).
const HEADER_HEIGHT = 36;
const CARD_HEIGHT = 162;
const OVERSCAN = 6;
// Prefetch the next page when within this many px of the bottom — about
// 5 cards ahead, so the fetch starts before the user sees the bottom edge.
const LOAD_MORE_THRESHOLD_PX = 800;

const items = $derived.by<Item[]>(() => {
	const sorted = [...threads].sort((a, b) => {
		const aTime = new Date(a.last_message_at).getTime();
		const bTime = new Date(b.last_message_at).getTime();
		return bTime - aTime;
	});

	const today: ThreadListEntry[] = [];
	const older: ThreadListEntry[] = [];
	for (const t of sorted) {
		(isToday(t.last_message_at) ? today : older).push(t);
	}

	const out: Item[] = [];
	if (today.length > 0) {
		out.push({ kind: "header", key: "h:Today", label: "Today", height: HEADER_HEIGHT });
		for (const t of today) {
			out.push({ kind: "thread", key: `t:${t.id}`, thread: t, height: CARD_HEIGHT });
		}
	}
	if (older.length > 0) {
		out.push({ kind: "header", key: "h:Earlier", label: "Earlier", height: HEADER_HEIGHT });
		for (const t of older) {
			out.push({ kind: "thread", key: `t:${t.id}`, thread: t, height: CARD_HEIGHT });
		}
	}
	return out;
});

// Cumulative top-offset table — offsets[i] is the y-offset of items[i],
// offsets[items.length] is the total content height. Recomputed when
// items change.
const offsets = $derived.by<number[]>(() => {
	const arr: number[] = new Array(items.length + 1);
	let total = 0;
	arr[0] = 0;
	for (let i = 0; i < items.length; i++) {
		total += items[i].height;
		arr[i + 1] = total;
	}
	return arr;
});

const totalHeight = $derived(offsets[offsets.length - 1] ?? 0);

let scrollEl = $state<HTMLDivElement | undefined>();
let scrollTop = $state(0);
let viewportHeight = $state(800);

function onScroll(): void {
	if (!scrollEl) return;
	scrollTop = scrollEl.scrollTop;
	// Fire `onLoadMore` when scrolling within LOAD_MORE_THRESHOLD_PX of the
	// bottom. The parent flips `isLoadingMore` synchronously inside its
	// handler, so subsequent scroll events bail until the fetch completes —
	// no local debounce needed.
	if (
		hasMore &&
		!isLoadingMore &&
		onLoadMore &&
		scrollTop + viewportHeight > totalHeight - LOAD_MORE_THRESHOLD_PX
	) {
		onLoadMore();
	}
}

// Binary search for the last index whose offset <= scroll. The visible
// window starts at that index (minus overscan).
function findStartIdx(scroll: number): number {
	if (offsets.length <= 1) return 0;
	let lo = 0;
	let hi = items.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (offsets[mid] <= scroll) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

const visibleRange = $derived.by(() => {
	if (items.length === 0) return { start: 0, end: 0 };
	const startRaw = findStartIdx(scrollTop);
	const start = Math.max(0, startRaw - OVERSCAN);
	const endTarget = scrollTop + viewportHeight;
	let end = startRaw;
	while (end < items.length && offsets[end] < endTarget) end++;
	end = Math.min(items.length, end + OVERSCAN);
	return { start, end };
});

onMount(() => {
	if (!scrollEl) return;
	viewportHeight = scrollEl.clientHeight;
	scrollTop = scrollEl.scrollTop;
	const ro = new ResizeObserver(() => {
		if (scrollEl) viewportHeight = scrollEl.clientHeight;
	});
	ro.observe(scrollEl);
	return () => ro.disconnect();
});
</script>

<div class="thread-list" bind:this={scrollEl} onscroll={onScroll}>
	{#if items.length === 0}
		<div class="empty-state">
			<p>No threads yet. Start a new line to begin.</p>
		</div>
	{:else}
		<div class="virtual-spacer" style="height: {totalHeight}px;">
			{#each items.slice(visibleRange.start, visibleRange.end) as item, i (item.key)}
				{@const top = offsets[visibleRange.start + i]}
				<div class="virtual-row" style="top: {top}px; height: {item.height}px;">
					{#if item.kind === "header"}
						<div class="group-label">
							<span class="kicker">{item.label}</span>
							<div class="rule-faint"></div>
						</div>
					{:else}
						{@const thread = item.thread}
						{@const color = getLineColor(thread.color)}
						{@const selected = selectedThreadId === thread.id}
						{@const activity = makeActivity(thread.id, thread.messageCount ?? 0)}
						{@const maxActivity = Math.max(1, ...activity)}
						{@const totalActivity = activity.reduce((a, b) => a + b, 0)}
						{@const isActive = threadStatuses.get(thread.id)?.active ?? false}
						<a
							class="thread-card"
							class:selected
							href={`#${lineRoute(thread.id)}`}
							onclick={(e) => {
								if (e.ctrlKey || e.metaKey) return;
								onSelectThread?.(thread.id);
								onNavigateThread?.(thread.id);
							}}
							onmouseenter={() => onHoverThread?.(thread.id)}
							onmouseleave={() => onHoverThread?.(null)}
						>
							<div class="rail" style="background: {color}"></div>

							<div class="top-row">
								<LineBadge lineIndex={thread.color} size="compact" />
								<span class="line-name">{getLineName(thread.color)}</span>
								<span class="thread-id mono">{thread.id.slice(0, 8)}</span>
								<div class="spacer"></div>
								<span class="relative-time tnum">
									{formatRelativeTime(thread.last_message_at)}
								</span>
								{#if isActive}
									<span class="live">
										<span class="live-dot"></span>
										Live
									</span>
								{/if}
							</div>

							<h3 class="title" title={sanitizeTitle(thread.title)}>
								{sanitizeTitle(thread.title)}
							</h3>

							{#if thread.summary}
								<p class="summary">{thread.summary}</p>
							{/if}

							<div class="sparkline" title="{activity.length}h activity · {totalActivity} turns">
								{#each activity as v, j}
									{@const isRecent = j >= activity.length - 3}
									{@const h = v === 0 ? 1 : Math.max(2, Math.round((v / maxActivity) * 26))}
									<span
										class="spark-bar"
										style="
											height: {h}px;
											background: {v === 0 ? 'var(--rule-soft)' : isRecent ? color : 'var(--ink-3)'};
											opacity: {v === 0 ? 0.4 : isRecent ? 0.95 : 0.55};
										"
									></span>
								{/each}
							</div>

							<div class="meta">
								<span>{thread.messageCount ?? 0} messages</span>
								{#if thread.lastModel}
									<span class="sep">·</span>
									<span class="model mono">{thread.lastModel}</span>
								{/if}
								<div class="spacer"></div>
								<span class="turn-count mono">{totalActivity} turns / 24h</span>
							</div>
						</a>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.thread-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		/* `position: relative` is required so absolute children of
		   .virtual-spacer position relative to the scroll content. */
	}

	.virtual-spacer {
		position: relative;
		width: 100%;
	}

	.virtual-row {
		position: absolute;
		left: 0;
		right: 0;
	}

	.group-label {
		padding: 16px 20px 6px;
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.rule-faint {
		flex: 1;
		height: 1px;
		background: var(--rule-soft);
	}

	.thread-card {
		position: relative;
		padding: 18px 20px;
		border-bottom: 1px solid var(--rule-faint);
		cursor: pointer;
		transition: background 0.12s ease;
		outline: none;
		height: 100%;
		box-sizing: border-box;
		overflow: hidden;
		display: block;
		text-decoration: none;
		color: inherit;
	}

	.thread-card:hover {
		background: rgba(26, 24, 20, 0.035);
	}

	.thread-card.selected {
		background: var(--paper-3);
	}

	.thread-card:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.rail {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 3px;
	}

	.top-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 6px;
	}

	.line-name {
		font-size: 12px;
		color: var(--ink-2);
		font-family: var(--font-display);
		font-weight: 500;
	}

	.thread-id {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--ink-4);
		letter-spacing: 0.04em;
	}

	.spacer {
		flex: 1;
	}

	.relative-time {
		font-size: 11px;
		color: var(--ink-3);
	}

	.live {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 10.5px;
		color: var(--ok);
		font-weight: 600;
	}

	.live-dot {
		width: 6px;
		height: 6px;
		background: var(--ok);
		border-radius: 50%;
		animation: card-live-pulse 1.4s ease-in-out infinite;
	}

	@keyframes card-live-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.25; }
	}

	.title {
		margin: 0 0 4px 0;
		font-family: var(--font-display);
		font-size: 15.5px;
		font-weight: 600;
		color: var(--ink);
		line-height: 1.3;
		letter-spacing: -0.005em;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		word-break: break-word;
	}

	.summary {
		margin: 0 0 10px 0;
		font-size: 12.5px;
		color: var(--ink-3);
		line-height: 1.45;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.sparkline {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 28px;
		margin-top: 10px;
		margin-left: 4px;
		margin-right: 4px;
		border-bottom: 1px solid var(--rule-faint);
		padding-bottom: 1px;
	}

	.spark-bar {
		flex: 1;
		display: block;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 8px;
		font-size: 11.5px;
		color: var(--ink-3);
	}

	.sep {
		color: var(--ink-4);
	}

	.model {
		font-family: var(--font-mono);
		font-size: 11px;
	}

	.turn-count {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--ink-4);
	}

	.empty-state {
		padding: 32px 16px;
		text-align: center;
		color: var(--ink-4);
	}

	.empty-state p {
		margin: 0;
		font-size: 13px;
		font-style: italic;
	}

	@media (prefers-reduced-motion: reduce) {
		.live-dot { animation: none; }
	}
</style>
