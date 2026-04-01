<script lang="ts">
import type { Snippet } from "svelte";
import type { Writable } from "svelte/store";
import type { WebSocketMessage } from "../lib/websocket";
import ContextDebugPanel from "./ContextDebugPanel.svelte";

interface Props {
	threadId: string | null;
	wsEvents: Writable<WebSocketMessage[]>;
	children: Snippet<[{ debugOpen: boolean; toggleDebug: () => void }]>;
}

const { threadId, wsEvents, children }: Props = $props();

let debugOpen = $state(false);
let debugMounted = $state(false);

function toggleDebug(): void {
	debugOpen = !debugOpen;
	if (debugOpen && !debugMounted) {
		debugMounted = true;
	}
}
</script>

<div class="debug-wrapper" class:panel-open={debugOpen}>
	<div class="main-content">
		{@render children({ debugOpen, toggleDebug })}
	</div>
	{#if debugMounted && threadId}
		<div class="debug-panel-container" class:hidden={!debugOpen}>
			<ContextDebugPanel threadId={threadId} {wsEvents} />
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
