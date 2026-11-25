<script lang="ts">
	// Three-state route-health dot for the model picker and Settings route list
	// (2026-11-21-model-routing.md §9.1): green when the preferred route is
	// healthy, amber when the model is serving via a fallback route, grey when it
	// has no eligible route. A route whose health this host cannot observe
	// (remote-only) renders grey with an "unknown" tooltip rather than implying a
	// verdict the host did not make.

	type State = "healthy" | "fallback" | "none" | "unknown";

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
		fallback: "var(--warn)",
		none: "var(--idle)",
		unknown: "var(--idle)",
	};

	const LABELS: Record<State, string> = {
		healthy: "Healthy",
		fallback: "Using fallback route",
		none: "No route available",
		unknown: "Health not reported",
	};
</script>

<span
	class="health-dot"
	class:fallback={state === "fallback"}
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
	/* Amber "fallback" pulses so a forgotten non-preferred route stands out. */
	.fallback {
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
		.fallback {
			animation: none;
		}
	}
</style>
