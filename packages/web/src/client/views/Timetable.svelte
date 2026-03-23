<script lang="ts">
import { onDestroy, onMount } from "svelte";

// biome-ignore lint/correctness/noUnusedVariables: used in template
let tasks = [];
// biome-ignore lint/correctness/noUnusedVariables: used in template
let loading = true;

async function loadTasks(): Promise<void> {
	try {
		const response = await fetch("/api/tasks");
		tasks = await response.json();
	} catch (error) {
		console.error("Failed to load tasks:", error);
	}
	loading = false;
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

onMount(() => {
	loadTasks();
	pollInterval = setInterval(loadTasks, 5000);
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
});

// biome-ignore lint/correctness/noUnusedVariables: used in template
function getStatusBadgeClass(status: string): string {
	switch (status) {
		case "completed":
			return "status-completed";
		case "running":
			return "status-running";
		case "failed":
			return "status-failed";
		case "pending":
			return "status-pending";
		default:
			return "status-unknown";
	}
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function getStatusIcon(status: string): string {
	switch (status) {
		case "completed":
			return "OK";
		case "running":
			return ">>";
		case "failed":
			return "!!";
		case "pending":
			return "..";
		default:
			return "--";
	}
}
</script>

<div class="timetable">
	<div class="timetable-header">
		<h1>Timetable</h1>
		<span class="subtitle">Departures & Arrivals</span>
	</div>

	{#if loading}
		<div class="loading-state">
			<div class="loading-bar"></div>
			<p>Loading schedule...</p>
		</div>
	{:else if tasks.length === 0}
		<div class="empty-state">
			<p>No scheduled departures.</p>
		</div>
	{:else}
		<div class="board">
			<div class="board-header">
				<span class="col-status">Status</span>
				<span class="col-id">ID</span>
				<span class="col-type">Service</span>
				<span class="col-runs">Runs</span>
				<span class="col-time">Departure</span>
			</div>
			{#each tasks as task}
				<div class="board-row" class:row-running={task.status === "running"} class:row-failed={task.status === "failed"}>
					<span class="col-status">
						<span class="status-chip {getStatusBadgeClass(task.status)}">
							<span class="status-icon">{getStatusIcon(task.status)}</span>
							{task.status}
						</span>
					</span>
					<span class="col-id task-id">{task.id.substring(0, 8)}</span>
					<span class="col-type">{task.type}</span>
					<span class="col-runs">{task.run_count}</span>
					<span class="col-time">{new Date(task.created_at).toLocaleString()}</span>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.timetable {
		padding: 32px 40px;
		max-width: 960px;
		margin: 0 auto;
	}

	.timetable-header {
		display: flex;
		align-items: baseline;
		gap: 16px;
		margin-bottom: 32px;
	}

	h1 {
		margin: 0;
		color: var(--text-primary);
		font-family: var(--font-display);
		font-size: var(--text-xl);
		font-weight: 700;
	}

	.subtitle {
		font-family: var(--font-display);
		font-size: var(--text-sm);
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.loading-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		padding: 48px 0;
	}

	.loading-bar {
		width: 120px;
		height: 3px;
		background: var(--bg-surface);
		border-radius: 2px;
		position: relative;
		overflow: hidden;
	}

	.loading-bar::after {
		content: "";
		position: absolute;
		top: 0;
		left: -40%;
		width: 40%;
		height: 100%;
		background: var(--line-3);
		border-radius: 2px;
		animation: loadingSlide 1.2s ease-in-out infinite;
	}

	@keyframes loadingSlide {
		0% { left: -40%; }
		100% { left: 100%; }
	}

	.loading-state p,
	.empty-state p {
		color: var(--text-muted);
		font-size: var(--text-sm);
		margin: 0;
	}

	.empty-state {
		padding: 48px 0;
		text-align: center;
	}

	.board {
		background: rgba(10, 10, 20, 0.5);
		border: 1px solid var(--bg-surface);
		border-radius: 8px;
		overflow: hidden;
	}

	.board-header {
		display: grid;
		grid-template-columns: 140px 100px 1fr 80px 180px;
		padding: 14px 20px;
		background: var(--bg-secondary);
		border-bottom: 2px solid var(--bg-surface);
		font-family: var(--font-display);
		font-size: var(--text-xs);
		font-weight: 700;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.board-row {
		display: grid;
		grid-template-columns: 140px 100px 1fr 80px 180px;
		padding: 12px 20px;
		border-bottom: 1px solid rgba(15, 52, 96, 0.4);
		align-items: center;
		transition: background 0.15s ease;
	}

	.board-row:last-child {
		border-bottom: none;
	}

	.board-row:hover {
		background: rgba(15, 52, 96, 0.3);
	}

	.board-row.row-running {
		border-left: 3px solid var(--status-active);
		padding-left: 17px;
	}

	.board-row.row-failed {
		border-left: 3px solid var(--alert-disruption);
		padding-left: 17px;
	}

	.task-id {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--text-muted);
	}

	.col-type {
		font-family: var(--font-display);
		font-size: var(--text-sm);
		color: var(--text-primary);
		font-weight: 600;
	}

	.col-runs {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--text-secondary);
		text-align: center;
	}

	.col-time {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--text-secondary);
	}

	.status-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border-radius: 4px;
		font-family: var(--font-display);
		font-size: var(--text-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.status-icon {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 700;
	}

	.status-completed {
		color: var(--status-active);
		background: rgba(105, 240, 174, 0.08);
	}

	.status-running {
		color: var(--line-7);
		background: rgba(0, 172, 155, 0.1);
	}

	.status-running .status-icon {
		animation: blink 1s step-end infinite;
	}

	@keyframes blink {
		50% { opacity: 0; }
	}

	.status-failed {
		color: var(--alert-disruption);
		background: rgba(255, 23, 68, 0.08);
	}

	.status-pending {
		color: var(--alert-warning);
		background: rgba(255, 145, 0, 0.08);
	}

	.status-unknown {
		color: var(--text-muted);
		background: rgba(107, 107, 128, 0.08);
	}

	@media (prefers-reduced-motion: reduce) {
		.loading-bar::after,
		.status-running .status-icon {
			animation: none;
		}
	}
</style>
