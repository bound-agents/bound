<script lang="ts">
import type { CacheMarker } from "@bound/client";
import { CACHE_MARKER_COLORS, FREE_SPACE_COLOR, SECTION_COLORS } from "../lib/context-colors";
import InfoPopover from "./InfoPopover.svelte";

interface Props {
	sections: Array<{
		name: string;
		tokens: number;
		children?: Array<{ name: string; tokens: number }>;
	}>;
	contextWindow: number;
	/**
	 * Actual LLM-reported total input tokens for the turn. When present and
	 * larger than the summed section estimate, the gap is rendered as an
	 * "estimator drift" segment so the bar's fill matches the headline's actual
	 * percentage instead of the (smaller) estimate. Undefined on assembly-only
	 * snapshots that haven't been correlated with a response yet.
	 */
	actualTotalTokens?: number;
	/**
	 * Cache breakpoint descriptors recorded for the turn. Up to two entries
	 * (system + message). Absent for turns persisted before this field existed.
	 */
	cacheMarkers?: CacheMarker[];
	/**
	 * Cache-read tokens for this turn (sum across all breakpoints — AI SDK
	 * aggregates). Used to derive marker state and inline labels.
	 */
	cacheReadTokens?: number | null;
	/** Cache-write tokens for this turn. */
	cacheWriteTokens?: number | null;
}

const {
	sections,
	contextWindow,
	actualTotalTokens,
	cacheMarkers,
	cacheReadTokens,
	cacheWriteTokens,
}: Props = $props();

const estimatedTokens = $derived(sections.reduce((s: number, sec) => s + sec.tokens, 0));
// Drift = how much the real wire prompt exceeds the cl100k_base estimate. The
// estimate is non-uniformly low (thinking-heavy history inflates most), and we
// have no per-section actuals — so rather than fabricate scaled section widths,
// the drift is surfaced as a single explicit segment. `0` when no actual is
// known yet or the estimate ran high.
const driftTokens = $derived(
	actualTotalTokens != null ? Math.max(0, actualTotalTokens - estimatedTokens) : 0,
);
// Tokens that actually occupy the window: the real total when known, else the
// estimate. Drives the free-space figure so the bar agrees with the headline.
const usedTokens = $derived(actualTotalTokens != null ? actualTotalTokens : estimatedTokens);
const driftPct = $derived(Math.max(0, Math.min(100, (driftTokens / contextWindow) * 100)));
const freePct = $derived(Math.max(0, 100 - (usedTokens / contextWindow) * 100));

// Compact 1k/1M formatter for the inline tick label. Token counts on the bar
// are large (200k+ context windows), so `1.2M` / `230k` reads cleaner than
// `230,400` next to a 14px tick.
function formatTokensCompact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return String(n);
}

// Each marker resolves to one of four states, driving its color:
//
// - `hit`      — read dominated this turn. The cached prefix served bytes; the
//                 small write that may also have happened (e.g., the new user
//                 message extending the cache) is a footnote on top of that.
// - `write`    — write dominated. Either a cold reassembly seeded a fresh
//                 prefix, or an extension wrote more than it read.
// - `disabled` — backend `prompt_caching` capability is off; nothing was
//                 cached this turn.
// - `idle`     — capability on but no cache activity attributable to the turn.
//                 Renders as a faint tick with the TTL label so the position
//                 is still visible.
//
// Both the system and message markers SHARE the same state per turn — the AI
// SDK aggregates cache_read / cache_write at request level, so per-marker
// attribution would be a fabrication. Painting them with one shared "story"
// matches operational reality (e.g., on a cold turn that wrote 162k, BOTH
// breakpoints participated in seeding the write — painting only one as
// "write" misled operators into thinking the other did nothing).
//
// Inline numeric labels are placed only on the message marker to avoid
// rendering the same number twice underneath the bar. The system marker
// shows its TTL inline when present and otherwise relies on the tooltip.
type MarkerState = "hit" | "write" | "disabled" | "idle";

interface RenderedMarker {
	pct: number;
	state: MarkerState;
	color: string;
	label: string;
	tooltip: string;
}

const renderedMarkers = $derived.by<RenderedMarker[]>(() => {
	if (!cacheMarkers || cacheMarkers.length === 0) return [];
	const cacheRead = cacheReadTokens ?? 0;
	const cacheWrite = cacheWriteTokens ?? 0;
	const anyDisabled = cacheMarkers.some((m) => !m.capabilityEnabled);

	let dominantState: MarkerState;
	if (anyDisabled) {
		dominantState = "disabled";
	} else if (cacheRead > cacheWrite) {
		dominantState = "hit";
	} else if (cacheWrite > 0) {
		dominantState = "write";
	} else {
		dominantState = "idle";
	}

	return cacheMarkers.map((m) => {
		const pct = Math.max(0, Math.min(100, (m.positionTokens / contextWindow) * 100));
		const state: MarkerState = m.capabilityEnabled ? dominantState : "disabled";
		const color = CACHE_MARKER_COLORS[state];

		let label = "";
		if (m.kind === "message") {
			if (state === "hit") label = `↑ ${formatTokensCompact(cacheRead)}`;
			else if (state === "write") label = `↓ ${formatTokensCompact(cacheWrite)}`;
			else if (state === "idle") label = m.ttl;
		}

		const variantLabel = m.kind === "system" ? "system" : `message · ${m.variant}`;
		const tooltipParts = [
			`${variantLabel} cache breakpoint`,
			`offset: ${m.positionTokens.toLocaleString()} tokens (${pct.toFixed(1)}%)`,
			`ttl: ${m.ttl}`,
		];
		if (state === "disabled") tooltipParts.push("backend prompt-caching disabled");
		else if (state === "hit") tooltipParts.push(`cache read: ${cacheRead.toLocaleString()} tokens`);
		else if (state === "write")
			tooltipParts.push(`cache write: ${cacheWrite.toLocaleString()} tokens`);
		const tooltip = tooltipParts.join(" · ");

		return { pct, state, color, label, tooltip };
	});
});
</script>

<div class="context-bar-wrap">
	<div class="context-bar">
		{#each sections as section}
			{@const pct = (section.tokens / contextWindow) * 100}
			{#if pct > 0}
				<div
					class="bar-segment"
					style="flex-basis: {pct}%; background: {SECTION_COLORS[section.name] ?? 'var(--text-muted)'};"
					title="{section.name}: {section.tokens.toLocaleString()} tokens ({pct.toFixed(1)}%)"
				></div>
			{/if}
		{/each}
		{#if driftPct > 0}
			<div
				class="bar-segment drift"
				style="flex-basis: {driftPct}%;"
				title="Estimator drift: {Math.round(driftTokens).toLocaleString()} tokens ({driftPct.toFixed(1)}%) — the real prompt exceeds the cl100k_base estimate (mostly thinking-heavy history)."
			></div>
		{/if}
		{#if freePct > 0}
			<div
				class="bar-segment free"
				style="flex-basis: {freePct}%; background: {FREE_SPACE_COLOR};"
				title="Free space: {Math.round(contextWindow - usedTokens).toLocaleString()} tokens ({freePct.toFixed(1)}%){actualTotalTokens != null
					? ' — vs. the actual wire total'
					: ''}"
			></div>
		{/if}
		{#each renderedMarkers as m}
			<InfoPopover
				label={m.tooltip}
				placement="bottom"
				triggerClass="bare"
				triggerStyle="position:absolute; top:-3px; bottom:-3px; width:2px; transform:translateX(-1px); z-index:2; cursor:help; left:{m.pct}%; {m.state ===
					'disabled'
					? `background:transparent; border-left:2px dashed ${m.color}; opacity:0.6;`
					: m.state === 'idle'
						? `background:${m.color}; opacity:0.55;`
						: `background:${m.color};`}"
			>
				{#snippet trigger()}{/snippet}
			</InfoPopover>
		{/each}
	</div>
	{#if renderedMarkers.length > 0}
		<div class="cache-tick-labels">
			{#each renderedMarkers as m}
				{#if m.label}
					<span
						class="cache-tick-label cache-tick-label-{m.state}"
						style="left: {m.pct}%; color: {m.color};"
					>
						{m.label}
					</span>
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	.context-bar-wrap {
		position: relative;
		margin-bottom: 10px;
	}

	.context-bar {
		position: relative;
		display: flex;
		height: 14px;
		border: 1px solid var(--rule-soft);
		background: var(--paper-3);
		overflow: visible; /* let cache ticks extend slightly above/below */
		margin-bottom: 0;
	}

	.bar-segment {
		min-width: 2px;
		transition: flex-basis 0.3s ease;
		border-right: 1px solid rgba(255, 255, 255, 0.15);
		opacity: 0.85;
	}

	.bar-segment:last-child {
		border-right: none;
	}

	.bar-segment.free {
		opacity: 1;
		background: var(--paper-3) !important;
	}

	/* Estimator drift: actual − estimate. Diagonal hatch in the warn hue marks
	   it as inferred headroom-loss, not a real section we can attribute. */
	.bar-segment.drift {
		opacity: 1;
		border-right: none;
		background-color: var(--paper-3);
		background-image: repeating-linear-gradient(
			-45deg,
			var(--warn) 0,
			var(--warn) 1px,
			transparent 1px,
			transparent 5px
		);
	}

	/* Cache ticks are now rendered as InfoPopover triggers with inline
	   geometry (position/color/state), since the trigger button lives in the
	   InfoPopover component scope where these scoped rules wouldn't match. */

	.cache-tick-labels {
		position: relative;
		height: 14px;
		margin-top: 2px;
		font-family: var(--font-mono);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		pointer-events: none;
	}

	.cache-tick-label {
		position: absolute;
		top: 0;
		transform: translateX(-50%);
		white-space: nowrap;
		padding: 0 3px;
		background: var(--paper);
		border: 1px solid var(--rule-faint);
		line-height: 12px;
	}

	.cache-tick-label-idle {
		opacity: 0.7;
	}
</style>
