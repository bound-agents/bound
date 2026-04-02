<script lang="ts">
import type { Snippet } from "svelte";
import type { Writable } from "svelte/store";
import type { WebSocketMessage } from "../lib/websocket";
import ContextDebugPanel from "./ContextDebugPanel.svelte";

export interface TurnRange {
	from: string;
	to: string | null;
}

interface Props {
	threadId: string | null;
	wsEvents: Writable<WebSocketMessage[]>;
	children: Snippet<[{ debugOpen: boolean; toggleDebug: () => void; turnRange: TurnRange | null }]>;
}

const { threadId, wsEvents, children }: Props = $props();

let debugOpen = $state(false);
let debugMounted = $state(false);
let turnRange = $state<TurnRange | null>(null);

function toggleDebug(): void {
	debugOpen = !debugOpen;
	if (debugOpen && !debugMounted) {
		debugMounted = true;
	}
	if (!debugOpen) {
		turnRange = null;
	}
}

function handleTurnChange(range: TurnRange | null): void {
	turnRange = range;
}
</script>

<div class="debug-wrapper" class:panel-open={debugOpen}>
	<div class="main-content">
		{@render children({ debugOpen, toggleDebug, turnRange })}
	</div>
	{#if debugMounted && threadId}
		<div class="debug-panel-container" class:hidden={!debugOpen}>
			<ContextDebugPanel threadId={threadId} {wsEvents} onTurnChange={handleTurnChange} />
		</div>
	{/if}
</div>

<style>
	.debug-wrapper {
		display: flex;
		flex-direction: row;
		height: 100%;
		width: 100%;
		overflow: hidden;
	}

	.main-content {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.debug-wrapper.panel-open .main-content {
		/* Let content fill available space when panel is open */
	}

	.debug-panel-container {
		flex-shrink: 0;
	}

	.debug-panel-container.hidden {
		display: none;
	}
</style>
