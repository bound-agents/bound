<script lang="ts">
	// Route-failover notice (2026-11-21-model-routing.md §9.2). Per-turn failover
	// stays silent in the timeline; only when a route fails repeatedly on one
	// thread does Bound surface a single thread-level notice naming the failing
	// route, the run of failures, and the route now serving.

	const { failedRoute, failedCount, windowSize, servingRoute } = $props<{
		/** `host / provider` label of the repeatedly-failing route. */
		failedRoute: string;
		/** How many of the last `windowSize` turns failed on it. */
		failedCount: number;
		windowSize: number;
		/** `host / provider` label of the route now serving the thread. */
		servingRoute: string;
	}>();
</script>

<div class="failover-notice" role="status">
	<span class="dot" aria-hidden="true"></span>
	<span class="text">
		{failedRoute} failed {failedCount} of the last {windowSize} turns; using {servingRoute}
	</span>
</div>

<style>
	.failover-notice {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		font-size: var(--text-xs);
		font-family: var(--font-mono);
		color: var(--ink-2);
		background: var(--paper-2);
		border-left: 3px solid var(--warn);
		border-radius: var(--r-sm);
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--warn);
		flex: none;
	}
</style>
