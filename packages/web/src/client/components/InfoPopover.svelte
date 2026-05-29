<script lang="ts">
import type { Snippet } from "svelte";

/**
 * Instant hover/focus info popover. Replaces native `title=` tooltips, whose
 * ~1s show delay makes hover-to-explain UX feel broken. Pure-CSS visibility
 * (`:hover` / `:focus-within`) means zero delay and no JS timers.
 *
 * Accessibility: the trigger is a focusable `<button>` so keyboard users can
 * Tab to it and read the popover; `aria-label` carries the plain-text summary
 * for screen readers that don't surface the visual popover.
 *
 * Anchoring is CSS-only (absolute, positioned relative to the inline-block
 * wrapper). `placement` picks the side; the popover is width-capped and wraps.
 */
interface Props {
	/** Plain-text fallback / screen-reader label. */
	label: string;
	/** Popover side relative to the trigger. */
	placement?: "top" | "bottom";
	/** The trigger content (the thing the user hovers). */
	trigger: Snippet;
	/** The popover body. Falls back to `label` text when omitted. */
	children?: Snippet;
}

const { label, placement = "top", trigger, children }: Props = $props();
</script>

<span class="info-popover">
	<button type="button" class="info-trigger" aria-label={label}>
		{@render trigger()}
	</button>
	<span class="info-bubble info-bubble-{placement}" role="tooltip">
		{#if children}
			{@render children()}
		{:else}
			{label}
		{/if}
	</span>
</span>

<style>
	.info-popover {
		position: relative;
		display: inline-flex;
		align-items: baseline;
	}

	.info-trigger {
		all: unset;
		cursor: help;
		display: inline-flex;
		align-items: baseline;
		/* Dotted underline cue that this is explainable, matching editorial style. */
		text-decoration: underline dotted var(--ink-4);
		text-underline-offset: 3px;
	}

	.info-trigger:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.info-bubble {
		position: absolute;
		left: 0;
		z-index: 200;
		min-width: 180px;
		max-width: 300px;
		padding: 8px 10px;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
		font-family: var(--font-display);
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--ink-2);
		white-space: normal;
		/* Hidden by default; shown instantly on hover/focus — no delay. */
		opacity: 0;
		visibility: hidden;
		transition: opacity 80ms ease;
		pointer-events: none;
	}

	.info-bubble-top {
		bottom: 100%;
		margin-bottom: 6px;
	}

	.info-bubble-bottom {
		top: 100%;
		margin-top: 6px;
	}

	.info-popover:hover .info-bubble,
	.info-popover:focus-within .info-bubble {
		opacity: 1;
		visibility: visible;
	}
</style>
