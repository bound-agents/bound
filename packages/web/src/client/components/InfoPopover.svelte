<script lang="ts">
import { type Snippet, untrack } from "svelte";

/**
 * Instant hover/focus info popover. Replaces native `title=` tooltips, whose
 * ~1s show delay makes hover-to-explain UX feel broken.
 *
 * Positioning is FIXED, computed from the trigger's bounding rect on show, so
 * the bubble escapes any `overflow: auto` ancestor (the debug panel scrolls;
 * an absolutely-positioned bubble would clip against its top/edges). Shown
 * with no delay — the only timing is a CSS opacity fade.
 *
 * Accessibility: the trigger is a focusable `<button>` carrying `aria-label`;
 * keyboard focus shows the bubble the same as hover.
 */
interface Props {
	/** Plain-text screen-reader label / fallback body. */
	label: string;
	/** Preferred side; flips automatically if there isn't room. */
	placement?: "top" | "bottom";
	/** The hovered trigger content. */
	trigger: Snippet;
	/** Popover body. Falls back to `label` when omitted. */
	children?: Snippet;
	/** Extra class on the trigger button (e.g. to position it absolutely). */
	triggerClass?: string;
	/** Inline style on the trigger button (e.g. absolute left/color). */
	triggerStyle?: string;
}

const {
	label,
	placement = "top",
	trigger,
	children,
	triggerClass = "",
	triggerStyle = "",
}: Props = $props();

let visible = $state(false);
let left = $state(0);
let top = $state(0);
let resolvedPlacement = $state<"top" | "bottom">(untrack(() => placement));
let triggerEl: HTMLButtonElement | undefined;

const BUBBLE_MAX_WIDTH = 300;
const GAP = 6;

function show(): void {
	if (!triggerEl) return;
	const r = triggerEl.getBoundingClientRect();
	// Flip to bottom when there isn't room above (e.g. rows near the panel top).
	const wantTop = placement === "top";
	resolvedPlacement = wantTop && r.top < 160 ? "bottom" : placement;
	// Clamp horizontally so a wide bubble never runs off the viewport edge.
	left = Math.min(Math.max(8, r.left), window.innerWidth - BUBBLE_MAX_WIDTH - 8);
	top = resolvedPlacement === "top" ? r.top - GAP : r.bottom + GAP;
	visible = true;
}

function hide(): void {
	visible = false;
}
</script>

<button
	bind:this={triggerEl}
	type="button"
	class="info-trigger {triggerClass}"
	style={triggerStyle}
	aria-label={label}
	onmouseenter={show}
	onmouseleave={hide}
	onfocus={show}
	onblur={hide}
>
	{@render trigger()}
</button>
{#if visible}
	<span
		class="info-bubble"
		class:info-bubble-up={resolvedPlacement === "top"}
		role="tooltip"
		style="left: {left}px; top: {top}px;"
	>
		{#if children}
			{@render children()}
		{:else}
			{label}
		{/if}
	</span>
{/if}

<style>
	.info-trigger {
		all: unset;
		cursor: help;
		/* Inherit the surrounding type so the trigger never changes the label's
		   font; only adds the dotted "explainable" affordance. */
		font: inherit;
		color: inherit;
		text-decoration: underline dotted var(--ink-4);
		text-underline-offset: 3px;
	}

	/* Callers that pass a triggerClass for non-text triggers (e.g. an
	   absolutely-positioned gauge tick) opt out of the dotted underline. */
	.info-trigger.bare {
		text-decoration: none;
	}

	.info-trigger:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.info-bubble {
		position: fixed;
		z-index: 1000;
		max-width: 300px;
		padding: 7px 9px;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
		font-family: var(--font-display);
		font-size: 11px;
		line-height: 1.45;
		color: var(--ink-2);
		white-space: normal;
		pointer-events: none;
	}

	/* When placed above, pull the bubble up by its own height. */
	.info-bubble-up {
		transform: translateY(-100%);
	}
</style>
