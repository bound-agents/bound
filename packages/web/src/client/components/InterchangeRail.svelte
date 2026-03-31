<script lang="ts">
import { tick } from "svelte";
import type { ContextDebugTurn, Message } from "../lib/api";
// biome-ignore lint/correctness/noUnusedImports: used in template
import { getLineCode, getLineColor } from "../lib/metro-lines";

interface Branch {
	y: number;
	sources: Array<{
		threadId: string;
		title: string;
		color: number;
		messageCount: number;
		lastMessageAt: string;
	}>;
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
const railColor = $derived(getLineColor(threadColor));

// Compute branches after DOM updates using $effect + tick
$effect(() => {
	// Track reactive dependencies explicitly
	const _turns = contextDebugTurns;
	const _msgs = messages;
	const _container = scrollContainer;

	// Wait for DOM to update after reactive changes
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
</script>

<svg
	bind:this={svgEl}
	class="interchange-rail"
	width="20"
	height={svgHeight}
	viewBox="0 0 20 {svgHeight}"
	preserveAspectRatio="none"
>
	<!-- Vertical rail line in current thread's color -->
	<line
		x1="10"
		y1="0"
		x2="10"
		y2={svgHeight}
		stroke={railColor}
		stroke-width="3"
		stroke-linecap="round"
	/>

	<!-- Branch lines and stations for each cross-thread source -->
	{#each branches as branch}
		{#each branch.sources as source, idx}
			{@const branchY = branch.y + idx * 16}
			{@const sourceColor = getLineColor(source.color)}
			{@const sourceCode = getLineCode(source.color)}

			<!-- Horizontal branch line from rail to station marker -->
			<line
				x1="0"
				y1={branchY}
				x2="10"
				y2={branchY}
				stroke={sourceColor}
				stroke-width="2"
				stroke-linecap="round"
			/>

			<!-- Station marker circle (outer colored ring) -->
			<circle
				cx="0"
				cy={branchY}
				r="6"
				fill="none"
				stroke={sourceColor}
				stroke-width="2"
			/>

			<!-- Station marker inner white circle -->
			<circle cx="0" cy={branchY} r="4" fill="#fff" />

			<!-- Station letter code -->
			<text
				x="0"
				y={branchY}
				text-anchor="middle"
				dominant-baseline="middle"
				font-family="system-ui, -apple-system, sans-serif"
				font-size="9"
				font-weight="700"
				fill="#000"
			>
				{sourceCode}
			</text>
		{/each}
	{/each}
</svg>

<style>
	.interchange-rail {
		position: absolute;
		left: 0;
		top: 0;
		pointer-events: none;
		overflow: visible;
	}
</style>
