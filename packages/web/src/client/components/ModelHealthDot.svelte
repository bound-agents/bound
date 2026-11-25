<script lang="ts">
	import { HEALTH_STATE_LABELS, type ModelHealthState } from "../lib/model-health";

	// Route-health dot for the model picker and Settings route list
	// (2026-11-21-model-routing.md §9.1): green when a route is healthy, amber
	// ("degraded") when only backing-off/retrying routes can serve, grey when
	// every route is disabled or health is unknown.

	type State = ModelHealthState;

	const {
		state = "unknown",
		title = undefined,
		showTitle = true,
	} = $props<{
		state?: State;
		title?: string;
		/** Off when a custom popover explains the dot, so `title` never double-renders. */
		showTitle?: boolean;
	}>();

	const COLORS: Record<State, string> = {
		healthy: "var(--ok)",
		degraded: "var(--warn)",
		none: "var(--idle)",
		unknown: "var(--idle)",
	};

	const LABELS = HEALTH_STATE_LABELS;
</script>

<span
	class="health-dot"
	class:degraded={state === "degraded"}
	style="--dot: {COLORS[state as State]}"
	title={showTitle ? (title ?? LABELS[state as State]) : undefined}
	role="img"
	aria-label={LABELS[state as State]}
></span>

<style>
	.health-dot {
		display: inline-block;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--dot);
		flex: none;
	}
	/* Amber "degraded" pulses so a struggling model stands out. */
	.degraded {
		animation: health-pulse 2s ease-in-out infinite;
	}
	@keyframes health-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.degraded {
			animation: none;
		}
	}
</style>
