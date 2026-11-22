<script lang="ts">
	// Test-only harness: mounts DebugPanelWrapper and renders a button inside its
	// control-bag snippet so tests can drive `toggleDebug` through a real click and
	// observe the reactive `debugOpen` / `turnRange` the wrapper passes back.
	import type { Writable } from "svelte/store";
	import DebugPanelWrapper from "../../../components/DebugPanelWrapper.svelte";
	import type { WebSocketMessage } from "../../../lib/bound";

	const {
		threadId,
		wsEvents,
	}: { threadId: string | null; wsEvents: Writable<WebSocketMessage[]> } = $props();
</script>

<DebugPanelWrapper {threadId} {wsEvents}>
	{#snippet children({ debugOpen, toggleDebug, turnRange })}
		<button class="dbg-toggle" onclick={toggleDebug}>{debugOpen ? "open" : "closed"}</button>
		<span class="dbg-range">{turnRange ? `${turnRange.from}..${turnRange.to}` : "none"}</span>
	{/snippet}
</DebugPanelWrapper>
