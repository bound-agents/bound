<script lang="ts">
import type { ContextDebugTurn, CrossThreadSource } from "@bound/client";
import { onDestroy } from "svelte";
import { type WebSocketMessage, client, wsEvents } from "../lib/bound";
import { getLineColor, getLineName } from "../lib/metro-lines";
import { navigateTo } from "../lib/router";
import ContextBar from "./ContextBar.svelte";
import ContextSectionList from "./ContextSectionList.svelte";
import ContextSparkline from "./ContextSparkline.svelte";
import LineBadge from "./LineBadge.svelte";

interface Props {
	threadId: string;
	wsEvents: typeof wsEvents;
	onTurnChange?: (range: { from: string; to: string | null } | null) => void;
}

const { threadId, wsEvents: wsEventsStore, onTurnChange }: Props = $props();

let turns = $state<ContextDebugTurn[]>([]);
let selectedTurnIdx = $state(-1);
let loading = $state(false);

async function fetchData(): Promise<void> {
	loading = true;
	try {
		const data = await client.getContextDebug(threadId);
		turns = data;
		if (turns.length > 0) {
			selectedTurnIdx = turns.length - 1;
		}
	} catch (error) {
		console.error("Failed to fetch context debug data:", error);
	}
	loading = false;
}

$effect(() => {
	const _tid = threadId;
	turns = [];
	selectedTurnIdx = -1;
	loading = false;
	fetchData();
});

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
				const exists = turns.some((t: ContextDebugTurn) => t.turn_id === debugData.turn_id);
				if (!exists) {
					turns = [...turns, debugData];
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

const selectedTurn = $derived(
	turns.length > 0 ? turns[selectedTurnIdx >= 0 ? selectedTurnIdx : turns.length - 1] : null,
);

const effectiveIdx = $derived(selectedTurnIdx >= 0 ? selectedTurnIdx : turns.length - 1);

const isLatest = $derived(selectedTurnIdx < 0 || selectedTurnIdx === turns.length - 1);

function fmtHhmm(iso: string | undefined | null): string {
	if (!iso) return "";
	try {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return "";
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	} catch {
		return "";
	}
}

function midpointISO(a: string, b: string): string {
	const ta = new Date(a).getTime();
	const tb = new Date(b).getTime();
	return new Date(ta + (tb - ta) / 2).toISOString();
}

function emitTurnRange(idx: number): void {
	if (!onTurnChange || turns.length === 0) return;
	if (idx < 0 || idx >= turns.length) {
		onTurnChange(null);
		return;
	}
	const from = idx > 0 ? midpointISO(turns[idx - 1].created_at, turns[idx].created_at) : "";
	const to =
		idx + 1 < turns.length ? midpointISO(turns[idx].created_at, turns[idx + 1].created_at) : null;
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

function openCrossThread(src: CrossThreadSource): void {
	navigateTo(`/line/${src.threadId}`);
}
</script>

<div class="debug-panel">
	{#if loading}
		<div class="loading">Loading…</div>
	{:else if turns.length === 0}
		<div class="empty">No turn data yet</div>
	{:else}
		<div class="turn-nav">
			<button
				onclick={() => navigateTurn(-1)}
				disabled={selectedTurnIdx <= 0}
				title="Previous turn"
			>
				&lt;
			</button>
			<span class="turn-label">
				<span class="turn-label-main mono tnum">
					{effectiveIdx + 1} / {turns.length}
				</span>
				{#if selectedTurn}
					<span class="turn-label-time mono">
						· {fmtHhmm(selectedTurn.created_at)}
					</span>
				{/if}
			</span>
			<button
				onclick={() => navigateTurn(1)}
				disabled={isLatest}
				title="Next turn"
			>
				&gt;
			</button>
			{#if isLatest}
				<span class="latest-badge">Latest</span>
			{/if}
		</div>

		{#if selectedTurn}
			<div class="turn-summary">
				<div class="summary-row summary-row-total">
					<span class="total-num mono tnum" class:total-pressure={selectedTurn.context_debug.budgetPressure}>
						{selectedTurn.context_debug.totalEstimated.toLocaleString()}
					</span>
					<span class="total-den">
						/ {selectedTurn.context_debug.contextWindow.toLocaleString()} tokens
					</span>
					<span class="total-pct mono">
						{((selectedTurn.context_debug.totalEstimated / selectedTurn.context_debug.contextWindow) * 100).toFixed(1)}%
					</span>
				</div>
			</div>

			<ContextBar
				sections={selectedTurn.context_debug.sections}
				contextWindow={selectedTurn.context_debug.contextWindow}
			/>

			{#if selectedTurn.context_debug.budgetPressure || selectedTurn.context_debug.truncated > 0}
				<div class="pressure-banner">
					<div class="pressure-title">⚠ Budget pressure</div>
					<div class="pressure-body">
						{#if selectedTurn.context_debug.truncated > 0}
							{selectedTurn.context_debug.truncated} item{selectedTurn.context_debug.truncated === 1 ? "" : "s"} truncated ·
						{/if}
						recall is degraded. Consider summarizing earlier turns or pinning fewer memories.
					</div>
				</div>
			{/if}

			<ContextSectionList
				sections={selectedTurn.context_debug.sections}
				contextWindow={selectedTurn.context_debug.contextWindow}
			/>

			{#if selectedTurn.context_debug.crossThreadSources && selectedTurn.context_debug.crossThreadSources.length > 0}
				<div class="cross-section">
					<div class="section-kicker">
						Cross-thread sources · {selectedTurn.context_debug.crossThreadSources.length}
					</div>
					<div class="cross-list">
						{#each selectedTurn.context_debug.crossThreadSources as src (src.threadId)}
							<button
								type="button"
								class="cross-row"
								onclick={() => openCrossThread(src)}
								title="Open {getLineName(src.color)} Line"
							>
								<LineBadge lineIndex={src.color} size="compact" />
								<span class="cross-title">{src.title || "(untitled)"}</span>
								<span class="cross-msgs mono">{src.messageCount} msgs</span>
							</button>
						{/each}
					</div>
				</div>
			{/if}

			<ContextSparkline
				{turns}
				selectedIdx={effectiveIdx}
				onSelectTurn={(idx) => {
					selectedTurnIdx = idx;
					emitTurnRange(idx);
				}}
			/>

			<div class="footer-fields">
				<div class="field">
					<span class="kicker">Model</span>
					<span class="mono">{selectedTurn.model_id}</span>
				</div>
				<div class="field">
					<span class="kicker">In / Out</span>
					<span class="mono tnum">
						{selectedTurn.tokens_in.toLocaleString()} / {selectedTurn.tokens_out.toLocaleString()}
					</span>
				</div>
				{#if selectedTurn.tokens_in > 0}
					{@const diff = selectedTurn.tokens_in - selectedTurn.context_debug.totalEstimated}
					{@const diffPct = ((diff / selectedTurn.context_debug.totalEstimated) * 100).toFixed(1)}
					<div class="field">
						<span class="kicker">Variance</span>
						<span class="mono tnum variance-value">
							{diff > 0 ? "+" : ""}{diff.toLocaleString()} ({diffPct}%)
						</span>
					</div>
				{/if}
				<div class="field">
					<span class="kicker">Pressure</span>
					<span
						class="mono"
						style="color: {selectedTurn.context_debug.budgetPressure ? 'var(--err)' : 'var(--ink-2)'}"
					>
						{selectedTurn.context_debug.budgetPressure ? "YES" : "no"}
					</span>
				</div>
				<div class="field">
					<span class="kicker">Truncated</span>
					<span
						class="mono tnum"
						style="color: {selectedTurn.context_debug.truncated > 0 ? 'var(--err)' : 'var(--ink-2)'}"
					>
						{selectedTurn.context_debug.truncated}
					</span>
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.debug-panel {
		width: 100%;
		height: 100%;
		overflow-y: auto;
		padding: 0;
		font-family: var(--font-display);
		font-size: 13px;
		color: var(--ink-2);
	}

	.turn-nav {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 14px;
		padding: 8px 10px;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
	}

	.turn-nav button {
		background: transparent;
		border: 1px solid var(--rule-soft);
		color: var(--ink);
		padding: 3px 8px;
		cursor: pointer;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.12em;
		min-width: 26px;
	}

	.turn-nav button:disabled {
		opacity: 0.35;
		cursor: not-allowed;
		color: var(--ink-4);
	}

	.turn-nav button:not(:disabled):hover {
		background: var(--paper-2);
	}

	.turn-label {
		flex: 1;
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
	}

	.turn-label-main {
		font-size: 12px;
		color: var(--ink);
		letter-spacing: 0.04em;
	}

	.turn-label-time {
		font-size: 11px;
		color: var(--ink-3);
	}

	.latest-badge {
		font-family: var(--font-mono);
		font-size: 9.5px;
		padding: 2px 6px;
		background: var(--accent);
		color: #fff;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	.turn-summary {
		margin-bottom: 10px;
	}

	.summary-row-total {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.total-num {
		font-size: 24px;
		font-weight: 500;
		color: var(--ink);
	}

	.total-pressure {
		color: var(--err);
	}

	.total-den {
		font-size: 13px;
		color: var(--ink-3);
	}

	.total-pct {
		font-size: 12px;
		color: var(--ink-2);
		margin-left: auto;
		font-variant-numeric: tabular-nums;
	}

	.pressure-banner {
		padding: 8px 10px;
		margin-bottom: 14px;
		background: rgba(178, 34, 34, 0.08);
		border: 1px solid var(--err);
		font-size: 11.5px;
		line-height: 1.45;
	}

	.pressure-title {
		color: var(--err);
		font-weight: 600;
		letter-spacing: 0.06em;
		margin-bottom: 2px;
	}

	.pressure-body {
		color: var(--ink-2);
	}

	.cross-section {
		margin-bottom: 18px;
	}

	.section-kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-3);
		margin-bottom: 8px;
	}

	.cross-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.cross-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		background: var(--paper-2);
		border: 1px solid var(--rule-soft);
		font-size: 11.5px;
		cursor: pointer;
		text-align: left;
		color: inherit;
		font-family: inherit;
	}

	.cross-row:hover {
		background: var(--paper-3);
	}

	.cross-row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.cross-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ink);
	}

	.cross-msgs {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--ink-3);
	}

	.footer-fields {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 12px;
		background: var(--paper-2);
		border: 1px solid var(--rule-soft);
	}

	.field {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
	}

	.field .kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-4);
	}

	.field .mono {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--ink);
	}

	.field .tnum {
		font-variant-numeric: tabular-nums;
	}

	.variance-value {
		color: var(--ink-3) !important;
		font-size: 11.5px !important;
	}

	.loading,
	.empty {
		text-align: center;
		padding: 32px 12px;
		color: var(--ink-4);
		font-size: 13px;
		font-style: italic;
	}
</style>
