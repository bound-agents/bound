<script lang="ts">
	// biome-ignore lint/correctness/noUnusedImports: used in template
	import { getLineCode, getLineColor } from "../lib/metro-lines";
	import type { ContextDebugTurn, Message } from "../lib/api";

	interface Props {
		threadColor: number;
		messages: Message[];
		contextDebugTurns: ContextDebugTurn[];
		scrollContainer: HTMLElement | null;
	}

	// biome-ignore lint/correctness/noUnusedVariables: messages prop used for reactive dependency
	const { threadColor, messages, contextDebugTurns, scrollContainer } = $props<Props>();

	// biome-ignore lint/style/useConst: Svelte 5 $state() requires let
	let svgEl = $state<SVGSVGElement | null>(null);
	// biome-ignore lint/correctness/noUnusedVariables: used in template and $effect
	let svgHeight = $state(0);

	// Reactive effect to update SVG height when container changes
	$effect(() => {
		if (scrollContainer && svgEl) {
			svgHeight = scrollContainer.scrollHeight;
		}
	});

	// Function to find assistant message element by timestamp proximity
	function findAssistantMessageElement(
		turnCreatedAt: string,
	): HTMLElement | null {
		const turnTime = new Date(turnCreatedAt).getTime();
		const messagesContainer = scrollContainer;
		if (!messagesContainer) return null;

		// Find all message bubble elements
		const bubbles = messagesContainer.querySelectorAll(
			"[data-message-role]",
		);
		let closestBubble: HTMLElement | null = null;
		let closestDiff = Number.POSITIVE_INFINITY;

		for (const bubble of bubbles) {
			const roleAttr = bubble.getAttribute("data-message-role");
			if (roleAttr !== "assistant") continue;

			const createdAtAttr = bubble.getAttribute("data-created-at");
			if (!createdAtAttr) continue;

			const bubbleTime = new Date(createdAtAttr).getTime();
			// Find message with same or later timestamp (within 5 seconds)
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

	// Compute branches with positions
	// biome-ignore lint/correctness/noUnusedVariables: used in template
	const branches = $derived(
		contextDebugTurns
			.map((turn) => {
				const sources = turn.context_debug.crossThreadSources;
				if (!sources || sources.length === 0) return null;

				const msgEl = findAssistantMessageElement(turn.created_at);
				if (!msgEl) return null;

				// Get Y position relative to scroll container
				const rect = msgEl.getBoundingClientRect();
				const containerRect = scrollContainer?.getBoundingClientRect();
				if (!containerRect) return null;

				const relativeY = rect.top - containerRect.top + (scrollContainer?.scrollTop ?? 0);

				return {
					y: relativeY,
					sources,
				};
			})
			.filter((b) => b !== null),
	);

	// biome-ignore lint/correctness/noUnusedVariables: used in template
	const railColor = getLineColor(threadColor);
</script>

<!-- SVG overlay for metro rail visualization -->
<!-- Positioned absolutely inside .messages container to scroll naturally -->
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

