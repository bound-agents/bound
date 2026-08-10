<script lang="ts">
import { ArrowRight } from "lucide-svelte";
import type { Snippet } from "svelte";
import { lineRoute } from "../lib/route-utils";
import { navigateTo } from "../lib/router";

// Shared shell for inline reference cards in the chat stream: a left icon,
// a caller-supplied body, and a right-side "Open line" action that appears
// once the referenced thread exists. Extracted from the scheduled-task card
// (#90) so aux-invocation cards (and future thread-linked cards) compose the
// same chrome instead of re-implementing it.
//
// The body renders via the children snippet, so body styling stays scoped to
// each composing component; this shell owns only the frame, the icon slot,
// and the action column.

interface Props {
	lineColor?: string;
	/** Link target. Null renders the pending note (when provided) instead of the action button. */
	threadId?: string | null;
	openLabel?: string;
	/** Shown in the action column while threadId is null. Omit for no note (e.g. load errors). */
	pendingLabel?: string | null;
	icon: Snippet;
	children: Snippet;
}

const {
	lineColor = "var(--rule-soft)",
	threadId = null,
	openLabel = "Open line",
	pendingLabel = null,
	icon,
	children,
}: Props = $props();

function openThread(): void {
	if (threadId) navigateTo(lineRoute(threadId));
}
</script>

<div class="tl-card" style="--line-color: {lineColor}">
	<span class="tl-icon">{@render icon()}</span>

	{@render children()}

	{#if threadId}
		<button type="button" class="tl-open" onclick={openThread}>
			{openLabel} <ArrowRight size={12} />
		</button>
	{:else if pendingLabel}
		<span class="tl-pending-note">{pendingLabel}</span>
	{/if}
</div>

<style>
	.tl-card {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 0.7rem;
		margin: 0.4rem 0;
		background: var(--paper-2);
		border: 1px solid var(--rule-faint);
		border-left: 3px solid var(--line-color);
		border-radius: 4px;
		font-size: 0.85rem;
	}

	.tl-icon {
		display: flex;
		align-items: center;
		color: var(--ink-3);
		flex-shrink: 0;
	}

	.tl-open {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.25rem 0.55rem;
		background: transparent;
		border: 1px solid var(--rule-soft);
		border-radius: 3px;
		color: var(--accent);
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
		flex-shrink: 0;
		transition: background 0.12s ease;
	}

	.tl-open:hover {
		background: var(--accent-wash);
	}

	.tl-pending-note {
		color: var(--ink-4);
		font-size: 0.75rem;
		font-style: italic;
		flex-shrink: 0;
	}
</style>
