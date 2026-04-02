<script lang="ts">
import { onDestroy } from "svelte";
import { type ContextDebugTurn, api } from "../lib/api";
import { wsEvents } from "../lib/websocket";
import type { WebSocketMessage } from "../lib/websocket";
import ContextBar from "./ContextBar.svelte";
import ContextSectionList from "./ContextSectionList.svelte";
import ContextSparkline from "./ContextSparkline.svelte";

interface Props {
	threadId: string;
	wsEvents: typeof wsEvents;
	onTurnChange?: (range: { from: string; to: string | null } | null) => void;
}

const { threadId, wsEvents: wsEventsStore, onTurnChange } = $props<Props>();

let turns = $state<ContextDebugTurn[]>([]);
let selectedTurnIdx = $state(-1);
let loading = $state(false);

async function fetchData(): Promise<void> {
	loading = true;
	try {
		const data = await api.getContextDebug(threadId);
		turns = data;
		if (turns.length > 0) {
			selectedTurnIdx = turns.length - 1; // start at latest
		}
	} catch (error) {
		console.error("Failed to fetch context debug data:", error);
	}
	loading = false;
}

// Re-fetch when threadId changes (thread navigation)
$effect(() => {
	const _tid = threadId; // track dependency
	turns = [];
	selectedTurnIdx = -1;
	loading = false;
	fetchData();
});

// Subscribe to WebSocket events and append new turns
let unsubscribeWs: (() => void) | null = null;

$effect(() => {
	unsubscribeWs = wsEventsStore.subscribe((events: WebSocketMessage[]) => {
		if (events.length === 0) return;
		const last = events[events.length - 1];
		if (
			last &&
			last.type === "context:debug" &&
			typeof last.data === "object" &&
			last.data !== null
		) {
			const debugData = last.data as ContextDebugTurn & { thread_id?: string };
			if (debugData.thread_id === threadId) {
				// Avoid duplicates by turn_id
				const exists = turns.some((t: ContextDebugTurn) => t.turn_id === debugData.turn_id);
				if (!exists) {
					turns = [...turns, debugData];
					// Auto-advance to latest if viewing latest
					if (selectedTurnIdx < 0 || selectedTurnIdx === turns.length - 2) {
						selectedTurnIdx = turns.length - 1;
					}
				}
			}
		}
	});
});

onDestroy(() => {
	if (unsubscribeWs) {
		unsubscribeWs();
	}
});

// Derived state
const selectedTurn = $derived(
	turns.length > 0 ? turns[selectedTurnIdx >= 0 ? selectedTurnIdx : turns.length - 1] : null,
);

const turnLabel = $derived(
	turns.length > 0
		? `Turn ${(selectedTurnIdx >= 0 ? selectedTurnIdx : turns.length - 1) + 1} of ${turns.length}`
		: "No turns",
);

const isLatest = $derived(selectedTurnIdx < 0 || selectedTurnIdx === turns.length - 1);

const effectiveIdx = $derived(selectedTurnIdx >= 0 ? selectedTurnIdx : turns.length - 1);

function emitTurnRange(idx: number): void {
	if (!onTurnChange || turns.length === 0) return;
	if (idx < 0 || idx >= turns.length) {
		onTurnChange(null);
		return;
	}
	const from = turns[idx].created_at;
	const to = idx + 1 < turns.length ? turns[idx + 1].created_at : null;
	onTurnChange({ from, to });
}

function navigateTurn(direction: number): void {
	if (direction < 0) {
		if (selectedTurnIdx > 0) {
			selectedTurnIdx--;
			emitTurnRange(selectedTurnIdx);
		}
	} else {
		if (selectedTurnIdx < turns.length - 1) {
			selectedTurnIdx++;
			emitTurnRange(selectedTurnIdx);
		}
	}
}
</script>

<div class="debug-panel">
	<div class="panel-header">
		<span class="panel-title">Context Debug</span>
	</div>

	{#if loading}
		<div class="loading">Loading...</div>
	{:else if turns.length === 0}
		<div class="empty">No turn data yet</div>
	{:else}
		<div class="turn-nav">
			<button
				onclick={() => navigateTurn(-1)}
				disabled={selectedTurnIdx <= 0}
			>
				&lt;
			</button>
			<span class="turn-label">{turnLabel}</span>
			<button
				onclick={() => navigateTurn(1)}
				disabled={isLatest}
			>
				&gt;
			</button>
			{#if isLatest}
				<span class="latest-badge">Latest</span>
			{/if}
		</div>

		<div class="turn-summary">
			<div class="summary-row">
				<span>Estimated:</span>
				<span class="mono">{selectedTurn?.context_debug.totalEstimated.toLocaleString()} tokens</span>
			</div>
			{#if selectedTurn?.tokens_in}
				<div class="summary-row">
					<span>Actual (API):</span>
					<span class="mono">{selectedTurn.tokens_in.toLocaleString()} tokens</span>
				</div>
				{@const diff = selectedTurn.tokens_in - selectedTurn.context_debug.totalEstimated}
				{@const diffPct = ((diff / selectedTurn.context_debug.totalEstimated) * 100).toFixed(1)}
				<div class="summary-row variance">
					<span>Variance:</span>
					<span class="mono">{diff > 0 ? "+" : ""}{diff.toLocaleString()} ({diffPct}%)</span>
				</div>
			{/if}
			<div class="summary-row">
				<span>Context window:</span>
				<span class="mono">{selectedTurn?.context_debug.contextWindow.toLocaleString()}</span>
			</div>
			{#if selectedTurn?.context_debug.budgetPressure}
				<div class="budget-warning">Budget pressure active</div>
			{/if}
		</div>

		{#if selectedTurn}
			<ContextBar
				sections={selectedTurn.context_debug.sections}
				contextWindow={selectedTurn.context_debug.contextWindow}
			/>

			<ContextSectionList
				sections={selectedTurn.context_debug.sections}
				contextWindow={selectedTurn.context_debug.contextWindow}
			/>

			<ContextSparkline
				{turns}
				selectedIdx={effectiveIdx}
				onSelectTurn={(idx) => {
					selectedTurnIdx = idx;
					emitTurnRange(idx);
				}}
			/>
		{/if}
	{/if}
</div>

<style>
	.debug-panel {
		width: 320px;
		min-width: 320px;
		height: 100%;
		overflow-y: auto;
		border-left: 1px solid var(--bg-surface);
		background: var(--bg-secondary);
		padding: 16px;
		font-family: var(--font-body);
		font-size: 13px;
		color: var(--text-secondary);
	}

	.panel-header {
		display: flex;
		align-items: center;
		margin-bottom: 16px;
	}

	.panel-title {
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 600;
		color: var(--text-primary);
	}

	.turn-nav {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 12px;
	}

	.turn-nav button {
		background: var(--bg-surface);
		border: none;
		color: var(--text-primary);
		padding: 4px 8px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
	}

	.turn-nav button:disabled {
		opacity: 0.3;
		cursor: default;
	}

	.turn-label {
		flex: 1;
		text-align: center;
		font-size: 12px;
	}

	.latest-badge {
		font-size: 10px;
		padding: 2px 6px;
		border-radius: 3px;
		background: var(--line-7);
		color: var(--bg-primary);
		font-weight: 600;
	}

	.turn-summary {
		margin-bottom: 16px;
	}

	.summary-row {
		display: flex;
		justify-content: space-between;
		padding: 4px 0;
		font-size: 12px;
	}

	.mono {
		font-family: var(--font-mono);
	}

	.variance {
		font-size: 11px;
		color: var(--text-muted);
	}

	.budget-warning {
		margin-top: 8px;
		padding: 4px 8px;
		border-radius: 4px;
		background: rgba(255, 145, 0, 0.15);
		color: var(--alert-warning);
		font-size: 11px;
		font-weight: 500;
	}

	.loading,
	.empty {
		text-align: center;
		padding: 32px 0;
		color: var(--text-muted);
		font-size: 12px;
	}
</style>
