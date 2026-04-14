<script lang="ts">
import { onDestroy, onMount } from "svelte";
import DepartureBoard from "../components/DepartureBoard.svelte";
import { LineBadge, SectionHeader, StatusChip } from "../components/shared";
import { navigateTo } from "../lib/router";
import { sortTasks } from "../lib/task-sort";

interface EnhancedTask {
	id: string;
	type: string;
	displayName: string;
	schedule: string;
	status: "running" | "failed" | "pending" | "claimed" | "cancelled" | "completed";
	next_run_at: string | null;
	last_run_at: string | null;
	hostName: string | null;
	lastDurationMs: number | null;
	payload: string | null;
	thread_id: string | null;
	error: string | null;
	run_count: number;
	consecutive_failures: number;
}

let allTasks: EnhancedTask[] = $state([]);
let loading = $state(true);
let activeFilters = $state<Set<string>>(new Set());
let expandedTaskId = $state<string | null>(null);

// Sorted tasks
const sortedTasks = $derived(sortTasks(allTasks));

// Filtered tasks based on active filter chips
const filteredTasks = $derived(
	sortedTasks.filter((t) => activeFilters.size === 0 || activeFilters.has(t.status)),
);

// Separate active and inactive tasks
const activeTasks = $derived(
	filteredTasks.filter(
		(t) =>
			t.status === "running" ||
			t.status === "claimed" ||
			t.status === "failed" ||
			t.status === "pending",
	),
);

const inactiveTasks = $derived(
	filteredTasks.filter((t) => t.status === "cancelled" || t.status === "completed"),
);

// Type to line index mapping
const TYPE_TO_LINE: Record<string, number> = {
	cron: 0, // Ginza (orange)
	heartbeat: 7, // Namboku (emerald)
	deferred: 3, // Tozai (sky blue)
	event: 6, // Hanzomon (purple)
};

function getLineIndex(type: string): number {
	return TYPE_TO_LINE[type] ?? 0;
}

function formatDuration(ms: number | null): string {
	if (!ms) return "--";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const secs = ms / 1000;
	if (secs < 60) return `${secs.toFixed(1)}s`;
	const mins = secs / 60;
	if (mins < 60) return `${mins.toFixed(1)}m`;
	const hours = mins / 60;
	return `${hours.toFixed(1)}h`;
}

function formatTime(iso: string | null): string {
	if (!iso) return "--";
	const d = new Date(iso);
	const now = Date.now();
	const diff = d.getTime() - now;

	// Future times
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

function toggleFilter(status: string): void {
	const next = new Set(activeFilters);
	if (next.has(status)) {
		next.delete(status);
	} else {
		next.add(status);
	}
	activeFilters = next;
}

function toggleTaskExpansion(taskId: string): void {
	expandedTaskId = expandedTaskId === taskId ? null : taskId;
}

async function loadTasks(): Promise<void> {
	try {
		const response = await fetch("/api/tasks");
		allTasks = await response.json();
	} catch (error) {
		console.error("Failed to load tasks:", error);
	}
	loading = false;
}

async function cancelTask(taskId: string): Promise<void> {
	try {
		await fetch(`/api/tasks/${taskId}/cancel`, { method: "POST" });
		await loadTasks();
	} catch (error) {
		console.error("Failed to cancel task:", error);
	}
}

function canCancel(status: string): boolean {
	return status === "pending" || status === "running" || status === "claimed";
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

onMount(() => {
	loadTasks();
	pollInterval = setInterval(loadTasks, 5000);
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
});
</script>

<div class="timetable">
	<SectionHeader
		title="Timetable"
		subtitle="DEPARTURES & ARRIVALS"
	>
		{#snippet actions()}
			<div class="filter-area">
				{#each ["pending", "running", "failed", "cancelled"] as status}
					<button
						class="filter-chip"
						class:active={activeFilters.has(status)}
						onclick={() => toggleFilter(status)}
					>
						{status.charAt(0).toUpperCase() + status.slice(1)}
					</button>
				{/each}
			</div>
		{/snippet}
	</SectionHeader>

	{#if loading}
		<div class="loading-state">
			<div class="loading-bar"></div>
			<p>Loading schedule...</p>
		</div>
	{:else if allTasks.length === 0}
		<div class="empty-state">
			<p>No scheduled tasks.</p>
		</div>
	{:else}
		<DepartureBoard tasks={allTasks} />

		<div class="task-list">
			<div class="task-list-header">
				<span class="col-expand"></span>
				<span class="col-status">Status</span>
				<span class="col-name">Name</span>
				<span class="col-type">Type</span>
				<span class="col-schedule">Schedule</span>
				<span class="col-next">Next Run</span>
				<span class="col-last">Last Run</span>
				<span class="col-duration">Duration</span>
				<span class="col-host">Host</span>
				<span class="col-actions">Actions</span>
			</div>

			{#if activeTasks.length > 0}
				{#each activeTasks as task (task.id)}
					<div
						class="task-row"
						class:expanded={expandedTaskId === task.id}
						class:running={task.status === "running" || task.status === "claimed"}
						class:failed={task.status === "failed"}
						onclick={() => toggleTaskExpansion(task.id)}
					>
						<span class="col-expand">
								<span class="chevron" class:open={expandedTaskId === task.id}>›</span>
							</span>
						<span class="col-status">
							<StatusChip
								status={task.status === "running" || task.status === "claimed"
									? "running"
									: task.status === "failed"
										? "failed"
										: task.status === "pending"
											? "pending"
											: "idle"}
							/>
						</span>
						<span class="col-name">{task.displayName}</span>
						<span class="col-type">
							<LineBadge lineIndex={getLineIndex(task.type)} size="compact" />
							<span>{task.type}</span>
						</span>
						<span class="col-schedule">{task.schedule}</span>
						<span class="col-next">{formatTime(task.next_run_at)}</span>
						<span class="col-last">{formatTime(task.last_run_at)}</span>
						<span class="col-duration">{formatDuration(task.lastDurationMs)}</span>
						<span class="col-host">{task.hostName ?? "--"}</span>
						<span class="col-actions">
							{#if canCancel(task.status)}
								<button
									class="action-btn"
									title="Cancel task"
									onclick={(e) => {
										e.stopPropagation();
										cancelTask(task.id);
									}}
								>
									Cancel
								</button>
							{:else if task.status === "failed" && task.error}
								<span class="error-badge" title={task.error}>ERR</span>
							{/if}
						</span>
					</div>

					{#if expandedTaskId === task.id}
						<div class="task-expanded">
							<div class="detail-section">
								<div class="detail-row">
									<span class="label">ID</span>
									<code>{task.id}</code>
								</div>
								<div class="detail-row">
									<span class="label">Status</span>
									<span>{task.status.toUpperCase()}</span>
								</div>
								<div class="detail-row">
									<span class="label">Run Count</span>
									<span>
										{task.run_count}
										{task.consecutive_failures > 0
											? `(${task.consecutive_failures} failures)`
											: ""}
									</span>
								</div>
								{#if task.error}
									<div class="detail-row">
										<span class="label">Error</span>
										<code class="error">{task.error}</code>
									</div>
								{/if}
								{#if task.payload}
									<div class="detail-row">
										<span class="label">Payload</span>
										<pre class="payload">{JSON.stringify(
											JSON.parse(task.payload),
											null,
											2
										)}</pre>
									</div>
								{/if}
								{#if task.thread_id}
									<div class="detail-row">
										<span class="label">Thread</span>
										<button
											class="thread-link"
											onclick={() => navigateTo(`/line/${task.thread_id}`)}
										>
											View thread
										</button>
									</div>
								{/if}
							</div>
						</div>
					{/if}
				{/each}
			{/if}

			{#if inactiveTasks.length > 0}
				<div class="separator-row">
					<span>INACTIVE</span>
				</div>
				{#each inactiveTasks as task (task.id)}
					<div
						class="task-row"
						class:expanded={expandedTaskId === task.id}
						onclick={() => toggleTaskExpansion(task.id)}
					>
						<span class="col-expand">
								<span class="chevron" class:open={expandedTaskId === task.id}>›</span>
							</span>
						<span class="col-status">
							<StatusChip status={task.status === "cancelled" ? "cancelled" : "idle"} />
						</span>
						<span class="col-name">{task.displayName}</span>
						<span class="col-type">
							<LineBadge lineIndex={getLineIndex(task.type)} size="compact" />
							<span>{task.type}</span>
						</span>
						<span class="col-schedule">{task.schedule}</span>
						<span class="col-next">{formatTime(task.next_run_at)}</span>
						<span class="col-last">{formatTime(task.last_run_at)}</span>
						<span class="col-duration">{formatDuration(task.lastDurationMs)}</span>
						<span class="col-host">{task.hostName ?? "--"}</span>
						<span class="col-actions"></span>
					</div>

					{#if expandedTaskId === task.id}
						<div class="task-expanded">
							<div class="detail-section">
								<div class="detail-row">
									<span class="label">ID</span>
									<code>{task.id}</code>
								</div>
								<div class="detail-row">
									<span class="label">Status</span>
									<span>{task.status.toUpperCase()}</span>
								</div>
								<div class="detail-row">
									<span class="label">Run Count</span>
									<span>
										{task.run_count}
										{task.consecutive_failures > 0
											? `(${task.consecutive_failures} failures)`
											: ""}
									</span>
								</div>
								{#if task.error}
									<div class="detail-row">
										<span class="label">Error</span>
										<code class="error">{task.error}</code>
									</div>
								{/if}
								{#if task.payload}
									<div class="detail-row">
										<span class="label">Payload</span>
										<pre class="payload">{JSON.stringify(
											JSON.parse(task.payload),
											null,
											2
										)}</pre>
									</div>
								{/if}
								{#if task.thread_id}
									<div class="detail-row">
										<span class="label">Thread</span>
										<button
											class="thread-link"
											onclick={() => navigateTo(`/line/${task.thread_id}`)}
										>
											View thread
										</button>
									</div>
								{/if}
							</div>
						</div>
					{/if}
				{/each}
			{/if}
		</div>

		<div class="board-footer">
			<span class="task-count"
				>{allTasks.length} task{allTasks.length !== 1 ? "s" : ""}</span
			>
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

	.filter-area {
		display: flex;
		gap: 8px;
	}

	.filter-chip {
		padding: 6px 12px;
		border-radius: 6px;
		border: 1px solid var(--bg-surface);
		background: var(--bg-primary);
		color: var(--text-secondary);
		font-family: var(--font-display);
		font-size: var(--text-xs);
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s ease;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.filter-chip:hover {
		border-color: var(--line-3);
	}

	.filter-chip.active {
		background: rgba(0, 155, 191, 0.2);
		border-color: var(--line-3);
		color: var(--line-3);
		box-shadow: 0 0 6px rgba(0, 155, 191, 0.15);
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
		0% {
			left: -40%;
		}
		100% {
			left: 100%;
		}
	}

	.empty-state {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 48px 0;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	.task-list {
		background: rgba(10, 10, 20, 0.5);
		border: 1px solid var(--bg-surface);
		border-radius: 8px;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
	}

	.task-list-header {
		display: grid;
		grid-template-columns: 24px 100px 1fr 100px 120px 100px 100px 80px 120px 70px;
		padding: 14px 20px;
		background: var(--bg-secondary);
		border-bottom: 2px solid var(--bg-surface);
		font-family: var(--font-display);
		font-size: var(--text-xs);
		font-weight: 700;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		gap: 12px;
		position: sticky;
		top: 0;
		z-index: 10;
	}

	.task-row {
		display: grid;
		grid-template-columns: 24px 100px 1fr 100px 120px 100px 100px 80px 120px 70px;
		padding: 12px 20px;
		border-bottom: 1px solid rgba(42, 48, 68, 0.4);
		gap: 12px;
		align-items: center;
		transition: background 0.15s ease;
		cursor: pointer;
	}

	.task-row:hover {
		background: rgba(42, 48, 68, 0.3);
	}

	.task-row.running {
		border-left: 3px solid var(--status-active);
		padding-left: 17px;
	}

	.task-row.failed {
		border-left: 3px solid var(--alert-disruption);
		padding-left: 17px;
	}

	.col-expand {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.chevron {
		font-size: 14px;
		color: var(--text-muted);
		transition: transform 0.15s ease;
		display: inline-block;
	}

	.chevron.open {
		transform: rotate(90deg);
		color: var(--text-secondary);
	}

	.col-type {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: var(--text-sm);
	}

	.col-schedule,
	.col-next,
	.col-last,
	.col-duration {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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

	.action-btn {
		padding: 4px 8px;
		border-radius: 4px;
		border: 1px solid rgba(255, 23, 68, 0.3);
		background: rgba(255, 23, 68, 0.08);
		color: var(--alert-disruption);
		font-size: var(--text-xs);
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s ease;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.action-btn:hover {
		background: rgba(255, 23, 68, 0.18);
		border-color: var(--alert-disruption);
	}

	.error-badge {
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

	.separator-row {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 12px 20px;
		background: rgba(107, 107, 128, 0.1);
		font-size: var(--text-xs);
		font-weight: 700;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		border-bottom: 1px solid rgba(42, 48, 68, 0.4);
	}

	.task-expanded {
		padding: 12px 20px 12px 32px;
		background: rgba(42, 48, 68, 0.2);
		border-bottom: 1px solid rgba(42, 48, 68, 0.4);
		grid-column: 1 / -1;
	}

	.detail-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.detail-row {
		display: flex;
		gap: 16px;
		align-items: flex-start;
		font-size: var(--text-sm);
	}

	.label {
		font-weight: 600;
		color: var(--text-secondary);
		min-width: 100px;
	}

	code {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-secondary);
		background: rgba(42, 48, 68, 0.5);
		padding: 2px 6px;
		border-radius: 3px;
		overflow-x: auto;
		max-width: 500px;
	}

	code.error {
		color: var(--alert-disruption);
		background: rgba(255, 23, 68, 0.08);
	}

	pre.payload {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-secondary);
		background: rgba(42, 48, 68, 0.5);
		padding: 8px;
		border-radius: 3px;
		overflow-x: auto;
		max-width: 500px;
		margin: 0;
	}

	.thread-link {
		padding: 4px 8px;
		border-radius: 4px;
		border: 1px solid var(--line-3);
		background: rgba(0, 155, 191, 0.08);
		color: var(--line-3);
		font-size: var(--text-xs);
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s ease;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.thread-link:hover {
		background: rgba(0, 155, 191, 0.18);
		border-color: var(--line-3);
	}

	.board-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 0;
		margin-top: 12px;
		border-top: 1px solid var(--bg-surface);
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
		.loading-bar::after {
			animation: none;
		}
	}
</style>
