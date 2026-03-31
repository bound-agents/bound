<script lang="ts">
import { onDestroy, onMount } from "svelte";
// biome-ignore lint/correctness/noUnusedImports: used in Svelte template onclick
import { navigateTo } from "../lib/router";

interface Task {
	id: string;
	type: string;
	status: string;
	trigger_spec: string;
	payload: string | null;
	thread_id: string | null;
	claimed_by: string | null;
	next_run_at: string | null;
	last_run_at: string | null;
	run_count: number;
	max_runs: number | null;
	created_at: string;
	created_by: string | null;
	error: string | null;
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
let tasks: Task[] = $state([]);
// biome-ignore lint/correctness/noUnusedVariables: used in template
let loading = $state(true);
// biome-ignore lint/correctness/noUnusedVariables: used in template
// biome-ignore lint/style/useConst: Svelte 5 $state() requires let
let filterStatus = $state("");

async function loadTasks(): Promise<void> {
	try {
		const url = filterStatus ? `/api/tasks?status=${filterStatus}` : "/api/tasks";
		const response = await fetch(url);
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
function handleFilterChange(): void {
	loading = true;
	loadTasks();
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function getStatusBadgeClass(status: string): string {
	switch (status) {
		case "completed":
			return "status-completed";
		case "running":
		case "claimed":
			return "status-running";
		case "failed":
			return "status-failed";
		case "pending":
			return "status-pending";
		case "cancelled":
			return "status-cancelled";
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
		case "claimed":
			return ">>";
		case "failed":
			return "!!";
		case "pending":
			return "..";
		case "cancelled":
			return "XX";
		default:
			return "--";
	}
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function formatTrigger(spec: string): string {
	if (!spec) return "--";
	if (spec.length > 24) return `${spec.substring(0, 22)}...`;
	return spec;
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function formatTime(iso: string | null): string {
	if (!iso) return "--";
	const d = new Date(iso);
	const now = Date.now();
	const diff = d.getTime() - now;
	// For future times, show relative
	if (diff > 0) {
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return "< 1m";
		if (mins < 60) return `in ${mins}m`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `in ${hours}h`;
		return d.toLocaleDateString();
	}
	// Past times
	const elapsed = Math.abs(diff);
	const mins = Math.floor(elapsed / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return d.toLocaleDateString();
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function formatHost(claimedBy: string | null): string {
	if (!claimedBy) return "--";
	if (claimedBy.length > 12) return `${claimedBy.substring(0, 10)}...`;
	return claimedBy;
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
async function cancelTask(taskId: string): Promise<void> {
	try {
		await fetch(`/api/tasks/${taskId}/cancel`, { method: "POST" });
		await loadTasks();
	} catch (error) {
		console.error("Failed to cancel task:", error);
	}
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function canCancel(status: string): boolean {
	return status === "pending" || status === "running" || status === "claimed";
}
</script>

<div class="timetable">
	<div class="timetable-header">
		<h1>Timetable</h1>
		<span class="subtitle">Departures & Arrivals</span>
		<div class="filter-area">
			<select bind:value={filterStatus} onchange={handleFilterChange} class="filter-select" aria-label="Filter by status">
				<option value="">All Services</option>
				<option value="pending">Pending</option>
				<option value="running">Running</option>
				<option value="completed">Completed</option>
				<option value="failed">Failed</option>
				<option value="cancelled">Cancelled</option>
			</select>
		</div>
	</div>

	{#if loading}
		<div class="loading-state">
			<div class="loading-bar"></div>
			<p>Loading schedule...</p>
		</div>
	{:else if tasks.length === 0}
		<div class="empty-state">
			<svg width="80" height="48" viewBox="0 0 80 48">
				<rect x="4" y="20" width="72" height="8" rx="4" fill="none" stroke="var(--text-muted)" stroke-width="1.5" opacity="0.3" stroke-dasharray="4 3" />
			</svg>
			<p>No scheduled departures.</p>
		</div>
	{:else}
		<div class="board">
			<div class="board-header">
				<span class="col-status">Status</span>
				<span class="col-id">ID</span>
				<span class="col-type">Service</span>
				<span class="col-trigger">Trigger</span>
				<span class="col-next">Next Run</span>
				<span class="col-last">Last Run</span>
				<span class="col-host">Host</span>
				<span class="col-actions">Actions</span>
			</div>
			{#each tasks as task}
				<div class="board-row" class:row-running={task.status === "running" || task.status === "claimed"} class:row-failed={task.status === "failed"} role="button" tabindex={0} onclick={() => navigateTo(`/task/${task.id}`)} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigateTo(`/task/${task.id}`); } }}>
					<span class="col-status">
						<span class="status-chip {getStatusBadgeClass(task.status)}">
							<span class="status-icon">{getStatusIcon(task.status)}</span>
							{task.status}
						</span>
					</span>
					<span class="col-id task-id" title={task.id}>{task.id.substring(0, 8)}</span>
					<span class="col-type">
						<span class="type-label">{task.type}</span>
						{#if task.run_count > 0}
							<span class="run-count">x{task.run_count}{task.max_runs ? `/${task.max_runs}` : ""}</span>
						{/if}
					</span>
					<span class="col-trigger" title={task.trigger_spec}>{formatTrigger(task.trigger_spec)}</span>
					<span class="col-next">{formatTime(task.next_run_at)}</span>
					<span class="col-last">{formatTime(task.last_run_at)}</span>
					<span class="col-host" title={task.claimed_by ?? ""}>{formatHost(task.claimed_by)}</span>
					<span class="col-actions">
						{#if canCancel(task.status)}
							<button class="cancel-btn" onclick={(e) => { e.stopPropagation(); cancelTask(task.id); }} title="Cancel task">
								<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
									<path d="M2 2L10 10M10 2L2 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
								</svg>
							</button>
						{:else if task.status === "failed" && task.error}
							<span class="error-hint" title={task.error}>err</span>
						{/if}
					</span>
				</div>
			{/each}
		</div>
		<div class="board-footer">
			<span class="task-count">{tasks.length} task{tasks.length !== 1 ? "s" : ""}</span>
			<span class="auto-refresh">Auto-refresh: 5s</span>
		</div>
	{/if}
</div>

<style>
	.timetable {
		padding: 32px 40px;
		max-width: 1120px;
		margin: 0 auto;
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
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

	.filter-area {
		margin-left: auto;
	}

	.filter-select {
		padding: 6px 12px;
		border-radius: 6px;
		border: 1px solid var(--bg-surface);
		background: var(--bg-primary);
		color: var(--text-secondary);
		font-family: var(--font-mono);
		font-size: 12px;
		cursor: pointer;
		transition: border-color 0.2s ease;
		appearance: auto;
	}

	.filter-select:hover {
		border-color: var(--line-3);
	}

	.filter-select:focus {
		outline: none;
		border-color: var(--line-3);
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
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		padding: 48px 0;
		text-align: center;
	}

	.board {
		background: rgba(10, 10, 20, 0.5);
		border: 1px solid var(--bg-surface);
		border-radius: 8px;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
	}

	.board-header {
		display: grid;
		grid-template-columns: 120px 80px 130px 140px 100px 100px 100px 70px;
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
		grid-template-columns: 120px 80px 130px 140px 100px 100px 100px 70px;
		padding: 12px 20px;
		border-bottom: 1px solid rgba(15, 52, 96, 0.4);
		align-items: center;
		transition: background 0.15s ease;
		cursor: pointer;
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
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.type-label {
		font-family: var(--font-display);
		font-size: var(--text-sm);
		color: var(--text-primary);
		font-weight: 600;
	}

	.run-count {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-muted);
	}

	.col-trigger {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.col-next,
	.col-last {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--text-secondary);
	}

	.col-host {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.col-actions {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.cancel-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		background: rgba(255, 23, 68, 0.08);
		border: 1px solid rgba(255, 23, 68, 0.3);
		border-radius: 4px;
		color: var(--alert-disruption);
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.cancel-btn:hover {
		background: rgba(255, 23, 68, 0.18);
		border-color: var(--alert-disruption);
	}

	.error-hint {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 700;
		color: var(--alert-disruption);
		background: rgba(255, 23, 68, 0.08);
		padding: 2px 6px;
		border-radius: 3px;
		cursor: help;
		text-transform: uppercase;
		letter-spacing: 0.05em;
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

	.status-cancelled {
		color: var(--text-muted);
		background: rgba(107, 107, 128, 0.08);
	}

	.status-unknown {
		color: var(--text-muted);
		background: rgba(107, 107, 128, 0.08);
	}

	.board-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 4px;
	}

	.task-count {
		font-family: var(--font-display);
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	.auto-refresh {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-muted);
		opacity: 0.6;
	}

	@media (prefers-reduced-motion: reduce) {
		.loading-bar::after,
		.status-running .status-icon {
			animation: none;
		}
	}
</style>
