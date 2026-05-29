<script lang="ts">
import type { ContextDebugTurn, CrossThreadSource } from "@bound/client";
import { onDestroy } from "svelte";
import { type WebSocketMessage, client, wsEvents } from "../lib/bound";
import { getLineColor, getLineName } from "../lib/metro-lines";
import { navigateTo } from "../lib/router";
import ContextBar from "./ContextBar.svelte";
import ContextSectionList from "./ContextSectionList.svelte";
import ContextSparkline from "./ContextSparkline.svelte";
import InfoPopover from "./InfoPopover.svelte";
import LineBadge from "./LineBadge.svelte";

/** Human-readable explanation for each cache-path reason code. */
const CACHE_REASON_LABEL: Record<string, string> = {
	"no-stored-state": "first turn on this thread, or the warm cache was evicted",
	"cache-expired": "the prompt-cache TTL elapsed since the last turn",
	"tool-change": "the available tool set changed, invalidating the cached prefix",
	"orphaned-tool-call": "an unanswered tool call forced a structural rebuild",
	"budget-exceeded": "the estimate exceeded the budget even after in-place compaction",
	"no-history": "no-history task threads always cold-assemble",
	"warm-eligible": "the warm path completed within budget — cached prefix reused",
};

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

/**
 * Silently re-fetch turns on a live update (WS event). Does not show the
 * loading spinner and preserves the user's current turn selection: if they
 * were already on the latest turn, advance to the new latest; if they had
 * navigated to an older turn, leave selectedTurnIdx unchanged so it still
 * points at the same entry (turns are only appended, never removed).
 */
async function refreshTurns(): Promise<void> {
	try {
		const wasLatest = isLatest;
		const data = await client.getContextDebug(threadId);
		turns = data;
		if (wasLatest && turns.length > 0) {
			selectedTurnIdx = turns.length - 1;
		}
	} catch (error) {
		console.error("Failed to refresh context debug data:", error);
	}
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
			// The server includes thread_id in the payload so we can filter to
			// the current thread. The payload shape is { turn_id, debug, thread_id }
			// — not a full ContextDebugTurn — so we use it only as a trigger to
			// re-fetch the complete, properly-typed data from the REST endpoint.
			const debugData = last.data as { turn_id: string; thread_id?: string };
			if (debugData.thread_id === threadId) {
				const exists = turns.some((t: ContextDebugTurn) => t.turn_id === debugData.turn_id);
				if (!exists) {
					refreshTurns();
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
			{@const ctxDebug = selectedTurn.context_debug}
			{@const actualTokens = ctxDebug.actualTotalTokens ?? null}
			{@const estimatedTokens = ctxDebug.totalEstimated}
			{@const headlineTokens = actualTokens ?? estimatedTokens}
			{@const headlineSource = actualTokens !== null ? "actual" : "estimate"}
			{@const inflationRatio = actualTokens !== null && estimatedTokens > 0 ? actualTokens / estimatedTokens : null}
			<div class="turn-summary">
				<div class="summary-row summary-row-total">
					<InfoPopover
						placement="bottom"
						label={headlineSource === "actual"
							? "Driver-reported input tokens (raw + cache read + cache write). Provider tokenizer, not the local estimate."
							: "Pre-LLM cl100k_base estimate. Actual count arrives after the response."}
					>
						{#snippet trigger()}<span
								class="total-num mono tnum"
								class:total-pressure={ctxDebug.budgetPressure}>{headlineTokens.toLocaleString()}</span
							>{/snippet}
					</InfoPopover>
					<span class="total-den">
						/ {ctxDebug.contextWindow.toLocaleString()} tokens
					</span>
					<span class="total-pct mono">
						{((headlineTokens / ctxDebug.contextWindow) * 100).toFixed(1)}%
					</span>
				</div>
				{#if actualTokens !== null && actualTokens !== estimatedTokens}
					<div class="summary-row summary-row-estimate">
						<InfoPopover
							placement="bottom"
							label="Local estimate vs. driver actual. ×ratio is this turn's drift; the running mean drives the adaptive budget."
						>
							{#snippet trigger()}<span class="estimate-kicker">Pre-LLM est</span>{/snippet}
						</InfoPopover>
						<span class="estimate-num mono tnum">
							{estimatedTokens.toLocaleString()}
						</span>
						{#if inflationRatio !== null}
							<span class="estimate-ratio mono" class:estimate-ratio-high={inflationRatio > 1.5}>
								× {inflationRatio.toFixed(2)}
							</span>
						{/if}
					</div>
				{/if}
			</div>

			{#if selectedTurn.tokens_cache_read !== null && selectedTurn.tokens_cache_write !== null && (selectedTurn.context_debug.cacheMarkers || selectedTurn.tokens_cache_read > 0 || selectedTurn.tokens_cache_write > 0)}
				{@const cacheRead = selectedTurn.tokens_cache_read ?? 0}
				{@const cacheWrite = selectedTurn.tokens_cache_write ?? 0}
				{@const markers = selectedTurn.context_debug.cacheMarkers ?? []}
				{@const ttl = markers[0]?.ttl ?? null}
				{@const variant = markers.find((m) => m.kind === "message")?.variant ?? null}
				{@const capabilityOff = markers.length > 0 && markers.every((m) => !m.capabilityEnabled)}
				{@const cachePath = selectedTurn.context_debug.cachePath ?? null}
				{@const cacheReason = selectedTurn.context_debug.cachePathReason ?? null}
				<div class="cache-row">
					<InfoPopover
						label="Read/write totals are exact (driver-reported). Bar tick positions are heuristic — provider reports caching per request, not per breakpoint."
					>
						{#snippet trigger()}<span class="cache-kicker">Cache</span>{/snippet}
					</InfoPopover>
					{#if cachePath}
						<InfoPopover
							label={`${cachePath === "warm" ? "Warm: cached prefix reused, only the volatile tail rebuilt." : "Cold: full assembly ran, seeded a fresh prefix."}${cacheReason ? ` ${CACHE_REASON_LABEL[cacheReason] ?? cacheReason}.` : ""}`}
						>
							{#snippet trigger()}<span
									class="cache-path mono"
									class:cache-path-warm={cachePath === "warm"}
									class:cache-path-cold={cachePath === "cold"}>{cachePath}</span
								>{/snippet}
						</InfoPopover>
						<span class="cache-sep">·</span>
					{/if}
					{#if capabilityOff}
						<span class="cache-state cache-disabled mono">disabled</span>
						<span class="cache-detail">backend lacks prompt_caching</span>
					{:else}
						<span class="cache-num cache-read mono tnum" class:cache-zero={cacheRead === 0}>
							↑ {cacheRead.toLocaleString()}
						</span>
						<span class="cache-sep">·</span>
						<span class="cache-num cache-write mono tnum" class:cache-zero={cacheWrite === 0}>
							↓ {cacheWrite.toLocaleString()}
						</span>
						{#if ttl}
							<span class="cache-sep">·</span>
							<span class="cache-meta mono">{ttl} TTL</span>
						{/if}
						{#if variant}
							<span class="cache-sep">·</span>
							<span class="cache-meta mono">{variant}</span>
						{/if}
					{/if}
				</div>
			{/if}

			{#if selectedTurn.context_debug.effectiveTruncationRatio !== undefined}
				{@const ratio = selectedTurn.context_debug.effectiveTruncationRatio}
				{@const inflation = selectedTurn.context_debug.measuredInflation}
				{@const tightened = ratio < 0.84}
				<div class="adaptive-row">
					<InfoPopover
						label="Cold-assembly budget target = 0.85 ÷ inflation EMA. Lower telescopes sooner, compensating for estimator under-count."
					>
						{#snippet trigger()}<span class="cache-kicker">Adaptive</span>{/snippet}
					</InfoPopover>
					<span class="adaptive-num mono tnum" class:adaptive-tight={tightened}>
						ratio {ratio.toFixed(2)}
					</span>
					{#if inflation !== null && inflation !== undefined}
						<span class="cache-sep">·</span>
						<InfoPopover
							label="Running mean of actual ÷ estimated tokens. > 1.0 = estimator under-counts the real prompt."
						>
							{#snippet trigger()}<span
									class="adaptive-num mono tnum"
									class:adaptive-tight={inflation > 1.3}>inflation ×{inflation.toFixed(2)}</span
								>{/snippet}
						</InfoPopover>
					{:else}
						<span class="cache-sep">·</span>
						<span class="cache-meta mono">inflation: sampling</span>
					{/if}
				</div>
			{/if}

			<ContextBar
				sections={selectedTurn.context_debug.sections}
				contextWindow={selectedTurn.context_debug.contextWindow}
				cacheMarkers={selectedTurn.context_debug.cacheMarkers}
				cacheReadTokens={selectedTurn.tokens_cache_read}
				cacheWriteTokens={selectedTurn.tokens_cache_write}
			/>

			{@const pf = selectedTurn.context_debug.progressiveFidelity}
			{@const folded = pf?.middleFolded ?? 0}
			{@const dropped = pf?.ancientDropped ?? 0}
			{@const truncated = selectedTurn.context_debug.truncated}
			{#if pf}
				<!-- Telescope model active: distinguish FOLDED (compressed to the
				     action-log digest, recall preserved) from DROPPED (replaced by the
				     summary marker, full detail shed). Only a large dropped count is a
				     real recall concern — folding is normal, healthy operation. -->
				{@const heavyDrop = dropped > pf.recentKept}
				<div class="telescope-banner" class:telescope-warn={heavyDrop}>
					<div class="telescope-title">
						{heavyDrop ? "⚠ Deep telescoping" : "▤ Telescoped history"}
					</div>
					<div class="telescope-body">
						<InfoPopover
							placement="bottom"
							label="Compressed to the action-log digest, not summarized. Still readable; no content lost."
						>
							{#snippet trigger()}<span class="telescope-explain">{folded.toLocaleString()} folded</span>{/snippet}
						</InfoPopover>
						<span class="telescope-sep">·</span>
						<span class="telescope-dropped" class:telescope-dropped-hot={dropped > 0}>
							{dropped.toLocaleString()} dropped
						</span>
						<span class="telescope-sep">·</span>
						<span class="telescope-kept">{pf.recentKept.toLocaleString()} kept full-res</span>
					</div>
					{#if heavyDrop}
						<div class="telescope-note">
							A single turn's history exceeds the window: the oldest turns are shed to
							the summary marker. This is expected on very long autonomous runs.
						</div>
					{/if}
				</div>
			{:else if selectedTurn.context_debug.budgetPressure || truncated > 0}
				<!-- Pre-telescope / warm-path fallback: no tier breakdown available. -->
				<div class="telescope-banner">
					<div class="telescope-title">▤ Truncated history</div>
					<div class="telescope-body">
						{#if truncated > 0}
							{truncated.toLocaleString()} earlier message{truncated === 1 ? "" : "s"} dropped to fit the window.
						{:else}
							Context is near the budget gate.
						{/if}
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
				{#if selectedTurn.context_debug.progressiveFidelity}
					{@const fpf = selectedTurn.context_debug.progressiveFidelity}
					<div class="field">
						<span class="kicker">Folded / dropped</span>
						<span class="mono tnum">
							<span style="color: var(--ok)">{fpf.middleFolded.toLocaleString()}</span>
							<span style="color: var(--ink-4)"> / </span>
							<span style="color: {fpf.ancientDropped > 0 ? 'var(--warn)' : 'var(--ink-2)'}"
								>{fpf.ancientDropped.toLocaleString()}</span
							>
						</span>
					</div>
				{:else}
					<div class="field">
						<span class="kicker">Truncated</span>
						<span
							class="mono tnum"
							style="color: {selectedTurn.context_debug.truncated > 0 ? 'var(--warn)' : 'var(--ink-2)'}"
						>
							{selectedTurn.context_debug.truncated}
						</span>
					</div>
				{/if}
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

	.cache-row {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		row-gap: 2px;
		gap: 6px;
		padding: 4px 8px;
		margin-bottom: 8px;
		background: var(--paper-2);
		border: 1px solid var(--rule-faint);
		font-size: 11.5px;
		/* Mono on the container so every descendant — including the
		   snippet-rendered popover triggers (CACHE, COLD) — inherits it.
		   Scoped selectors like .cache-kicker get tree-shaken when they only
		   match snippet content passed to a child component, so relying on
		   per-element rules left those triggers in the display font. */
		font-family: var(--font-mono);
		cursor: help;
	}

	/* Keep each stat intact when the row wraps to a new line. */
	.cache-num,
	.cache-meta {
		white-space: nowrap;
	}

	.cache-kicker {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.cache-num {
		font-family: var(--font-mono);
		font-size: 11.5px;
		font-variant-numeric: tabular-nums;
	}

	.cache-read {
		color: var(--ok);
	}

	.cache-write {
		color: var(--warn);
	}

	.cache-zero {
		color: var(--ink-4);
	}

	.cache-sep {
		font-family: var(--font-mono);
		color: var(--ink-4);
	}

	.cache-meta {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-3);
	}

	.cache-state {
		font-family: var(--font-mono);
		font-size: 11.5px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.cache-disabled {
		color: var(--idle);
	}

	.cache-detail {
		color: var(--ink-3);
		font-style: italic;
		font-size: 11px;
	}

	.summary-row-total {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.summary-row-estimate {
		display: flex;
		align-items: baseline;
		gap: 6px;
		margin-top: 2px;
		font-size: 11px;
		color: var(--ink-3);
		cursor: help;
	}

	.estimate-kicker {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-4);
	}

	.estimate-num {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		color: var(--ink-3);
	}

	.estimate-ratio {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		color: var(--ink-4);
	}

	.estimate-ratio-high {
		color: var(--warn);
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

	/* Telescope banner: neutral by default (folding is normal), red only on a
	   genuinely deep drop where full-resolution recall is actually lost. */
	.telescope-banner {
		padding: 8px 10px;
		margin-bottom: 14px;
		background: var(--paper-2);
		border: 1px solid var(--rule-soft);
		font-size: 11.5px;
		line-height: 1.45;
	}

	.telescope-banner.telescope-warn {
		background: rgba(178, 34, 34, 0.08);
		border-color: var(--err);
	}

	.telescope-title {
		color: var(--ink-2);
		font-weight: 600;
		letter-spacing: 0.06em;
		margin-bottom: 3px;
	}

	.telescope-warn .telescope-title {
		color: var(--err);
	}

	.telescope-body {
		display: flex;
		align-items: baseline;
		gap: 6px;
		flex-wrap: wrap;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-2);
	}

	.telescope-explain {
		color: var(--ok);
	}

	.telescope-dropped {
		color: var(--ink-3);
	}

	.telescope-dropped-hot {
		color: var(--warn);
	}

	.telescope-kept {
		color: var(--ink-2);
	}

	.telescope-sep {
		color: var(--ink-4);
	}

	.telescope-note {
		margin-top: 5px;
		color: var(--ink-3);
		font-size: 11px;
		font-style: italic;
	}

	.cache-path {
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.cache-path-warm {
		color: var(--ok);
	}

	.cache-path-cold {
		color: var(--ink-3);
	}

	.adaptive-row {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		row-gap: 2px;
		gap: 6px;
		padding: 4px 8px;
		margin-bottom: 8px;
		background: var(--paper-2);
		border: 1px solid var(--rule-faint);
		font-size: 11.5px;
		/* Mono on the container — see .cache-row note (snippet triggers). */
		font-family: var(--font-mono);
	}

	.adaptive-num {
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 11.5px;
		font-variant-numeric: tabular-nums;
		color: var(--ink-2);
	}

	.adaptive-tight {
		color: var(--warn);
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
