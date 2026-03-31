<script lang="ts">
import { tick } from "svelte";
import type { ContextDebugTurn, Message } from "../lib/api";
// biome-ignore lint/correctness/noUnusedImports: used in template
import { getLineCode, getLineColor } from "../lib/metro-lines";

interface CrossThreadSource {
	threadId: string;
	title: string;
	color: number;
	messageCount: number;
	lastMessageAt: string;
}

interface Branch {
	y: number;
	sources: CrossThreadSource[];
}

interface PopoverState {
	visible: boolean;
	x: number;
	y: number;
	source: CrossThreadSource | null;
}

interface Props {
	threadColor: number;
	messages: Message[];
	contextDebugTurns: ContextDebugTurn[];
	scrollContainer: HTMLElement | null;
}

const { threadColor, messages, contextDebugTurns, scrollContainer } = $props<Props>();

// biome-ignore lint/correctness/noUnusedVariables: used in template
// biome-ignore lint/style/useConst: Svelte 5 $state() requires let
let svgEl = $state<SVGSVGElement | null>(null);
// biome-ignore lint/correctness/noUnusedVariables: used in template
let svgHeight = $state(0);
// biome-ignore lint/correctness/noUnusedVariables: used in template
let branches = $state<Branch[]>([]);
// biome-ignore lint/correctness/noUnusedVariables: used in template
let popover = $state<PopoverState>({
	visible: false,
	x: 0,
	y: 0,
	source: null,
});

// biome-ignore lint/correctness/noUnusedVariables: used in template
const railColor = $derived(getLineColor(threadColor));

// Compute branches after DOM updates using $effect + tick
$effect(() => {
	const _turns = contextDebugTurns;
	const _msgs = messages;
	const _container = scrollContainer;

	tick().then(() => {
		if (!_container) {
			svgHeight = 0;
			branches = [];
			return;
		}

		svgHeight = _container.scrollHeight;

		const newBranches: Branch[] = [];
		for (const turn of _turns) {
			const sources = turn.context_debug?.crossThreadSources;
			if (!sources || sources.length === 0) continue;

			const msgEl = findAssistantMessageElement(turn.created_at, _container);
			if (!msgEl) continue;

			const y = msgEl.offsetTop + msgEl.offsetHeight / 2;
			newBranches.push({ y, sources });
		}

		branches = newBranches;
	});
});

function findAssistantMessageElement(
	turnCreatedAt: string,
	container: HTMLElement,
): HTMLElement | null {
	const turnTime = new Date(turnCreatedAt).getTime();
	const bubbles = container.querySelectorAll("[data-message-role]");
	let closestBubble: HTMLElement | null = null;
	let closestDiff = Number.POSITIVE_INFINITY;

	for (const bubble of bubbles) {
		if (bubble.getAttribute("data-message-role") !== "assistant") continue;
		const createdAtAttr = bubble.getAttribute("data-created-at");
		if (!createdAtAttr) continue;

		const bubbleTime = new Date(createdAtAttr).getTime();
		if (bubbleTime >= turnTime) {
			const diff = bubbleTime - turnTime;
			if (diff < closestDiff) {
				closestDiff = diff;
				closestBubble = bubble as HTMLElement;
			}
		}
	}

	return closestBubble;
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function handleStationClick(source: CrossThreadSource, event: MouseEvent): void {
	const target = event.currentTarget as SVGElement;
	const rect = target.getBoundingClientRect();
	const containerRect = scrollContainer?.getBoundingClientRect();
	if (!containerRect) return;

	const x = rect.right - containerRect.left + 8;
	const y =
		rect.top - containerRect.top + (scrollContainer?.scrollTop ?? 0) - 8;

	// Show popover immediately with snapshot data
	popover = { visible: true, x, y, source: { ...source } };

	// Fetch live thread data to update title and timestamps
	Promise.all([
		fetch(`/api/threads/${source.threadId}`).then((r) =>
			r.ok ? r.json() : null,
		),
		fetch(`/api/threads/${source.threadId}/messages`).then((r) =>
			r.ok ? r.json() : null,
		),
	])
		.then(([thread, msgs]) => {
			if (!popover.visible) return;
			popover = {
				...popover,
				source: {
					...source,
					title: thread?.title || source.title,
					messageCount: Array.isArray(msgs) ? msgs.length : source.messageCount,
					lastMessageAt: thread?.last_message_at ?? source.lastMessageAt,
				},
			};
		})
		.catch(() => {});
}

function closePopover(): void {
	popover = { visible: false, x: 0, y: 0, source: null };
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function formatTime(iso: string): string {
	const d = new Date(iso);
	const now = new Date();
	const diff = now.getTime() - d.getTime();
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return d.toLocaleDateString();
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function navigateToThread(threadId: string): void {
	closePopover();
	window.location.hash = `#/line/${threadId}`;
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function gradientId(branchIdx: number, sourceIdx: number): string {
	return `branch-grad-${branchIdx}-${sourceIdx}`;
}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="rail-container" onclick={closePopover}>
<svg
	bind:this={svgEl}
	class="interchange-rail"
	width="36"
	height={svgHeight}
	viewBox="0 0 36 {svgHeight}"
	preserveAspectRatio="none"
>
	<defs>
		{#each branches as branch, bi}
			{#each branch.sources as source, si}
				<linearGradient
					id={gradientId(bi, si)}
					x1="0" y1="0" x2="1" y2="0"
				>
					<stop offset="0%" stop-color={getLineColor(source.color)} />
					<stop offset="100%" stop-color={railColor} />
				</linearGradient>
			{/each}
		{/each}
	</defs>

	<!-- Vertical rail line in current thread's color -->
	<line
		x1="28"
		y1="0"
		x2="28"
		y2={svgHeight}
		stroke={railColor}
		stroke-width="4"
		stroke-linecap="round"
	/>

	<!-- Branch lines and stations for each cross-thread source -->
	{#each branches as branch, bi}
		{#each branch.sources as source, si}
			{@const branchY = branch.y + si * 24}
			{@const sourceColor = getLineColor(source.color)}
			{@const sourceCode = getLineCode(source.color)}

			<!-- Horizontal branch line with gradient -->
			{@const gradUrl = `url(#${gradientId(bi, si)})`}
			<line
				x1="12"
				y1={branchY}
				x2="28"
				y2={branchY}
				stroke={gradUrl}
				stroke-width="3"
				stroke-linecap="round"
			/>

			<!-- Clickable station marker group -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<g
				class="station-marker"
				onclick={(e) => { e.stopPropagation(); handleStationClick(source, e); }}
			>
				<!-- Hit area (invisible, larger) -->
				<circle cx="12" cy={branchY} r="14" fill="transparent" />
				<!-- Filled outer circle -->
				<circle cx="12" cy={branchY} r="10" fill={sourceColor} />
				<!-- White inner circle -->
				<circle cx="12" cy={branchY} r="7" fill="#fff" />
				<!-- Letter code -->
				<text
					x="12"
					y={branchY}
					text-anchor="middle"
					dominant-baseline="central"
					font-family="'Nunito Sans', system-ui, sans-serif"
					font-size="11"
					font-weight="700"
					fill="#000"
				>
					{sourceCode}
				</text>
			</g>
		{/each}
	{/each}
</svg>

{#if popover.visible && popover.source}
	{@const src = popover.source}
	{@const srcColor = getLineColor(src.color)}
	{@const srcCode = getLineCode(src.color)}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="popover"
		style="left: {popover.x}px; top: {popover.y}px"
		onclick={(e) => e.stopPropagation()}
	>
		<div class="popover-header">
			<span class="popover-badge" style="background: {srcColor}">
				<span class="popover-badge-inner"></span>
				<span class="popover-badge-code">{srcCode}</span>
			</span>
			<span class="popover-title">{src.title}</span>
		</div>
		<div class="popover-meta">
			{src.messageCount} messages &middot; {formatTime(src.lastMessageAt)}
		</div>
		<button class="popover-link" onclick={() => navigateToThread(src.threadId)}>
			Open thread &rarr;
		</button>
	</div>
{/if}
</div>

<style>
	.rail-container {
		position: absolute;
		left: 0;
		top: 0;
		width: 36px;
		height: 100%;
		z-index: 2;
	}

	.interchange-rail {
		position: absolute;
		left: 0;
		top: 0;
		pointer-events: none;
		overflow: visible;
	}

	.station-marker {
		pointer-events: all;
		cursor: pointer;
	}

	.station-marker:hover circle:nth-child(2) {
		filter: brightness(1.2);
	}

	.popover {
		position: absolute;
		z-index: 10;
		background: var(--bg-surface, #1a1a2e);
		border: 1px solid rgba(156, 174, 183, 0.3);
		border-radius: 8px;
		padding: 10px 12px;
		min-width: 180px;
		max-width: 260px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
	}

	.popover-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}

	.popover-badge {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		position: relative;
	}

	.popover-badge-inner {
		position: absolute;
		width: 15px;
		height: 15px;
		border-radius: 50%;
		background: #fff;
	}

	.popover-badge-code {
		color: #000;
		font-family: var(--font-display, "Nunito Sans", sans-serif);
		font-size: 10px;
		font-weight: 700;
		line-height: 1;
		position: relative;
		z-index: 1;
	}

	.popover-title {
		font-family: var(--font-display, "Nunito Sans", sans-serif);
		font-size: 13px;
		font-weight: 600;
		color: var(--text-primary, #e0e0e0);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.popover-meta {
		font-size: 11px;
		color: var(--text-secondary, #9caeb7);
		margin-bottom: 8px;
	}

	.popover-link {
		display: block;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		padding: 4px 0;
		font-family: var(--font-display, "Nunito Sans", sans-serif);
		font-size: 12px;
		font-weight: 600;
		color: var(--text-link, #69b4ff);
		cursor: pointer;
		transition: opacity 0.15s;
	}

	.popover-link:hover {
		opacity: 0.8;
	}
</style>
