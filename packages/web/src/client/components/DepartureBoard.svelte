<script lang="ts">
import { LineBadge } from "./shared";

interface EnhancedTask {
	id: string;
	type: string;
	displayName: string;
	status: string;
	next_run_at: string | null;
	last_run_at: string | null;
}

interface Props {
	tasks: EnhancedTask[];
}

let { tasks }: Props = $props();

// Task type to line index mapping
const TYPE_TO_LINE: Record<string, number> = {
	cron: 0, // Ginza (orange)
	heartbeat: 7, // Namboku (emerald)
	deferred: 3, // Tozai (sky blue)
	event: 6, // Hanzomon (purple)
};

// Filter to pending tasks with next_run_at and sort by next_run_at ascending
const upcomingTasks = $derived(
	tasks
		.filter((t) => t.status === "pending" && t.next_run_at)
		.sort((a, b) => {
			const aTime = a.next_run_at ? new Date(a.next_run_at).getTime() : Number.POSITIVE_INFINITY;
			const bTime = b.next_run_at ? new Date(b.next_run_at).getTime() : Number.POSITIVE_INFINITY;
			return aTime - bTime;
		})
		.slice(0, 5),
);

function computeStatus(task: EnhancedTask): "ON TIME" | "DELAYED" | "OVERDUE" {
	const now = Date.now();
	const nextRun = task.next_run_at
		? new Date(task.next_run_at).getTime()
		: Number.POSITIVE_INFINITY;

	if (nextRun > now) {
		return "ON TIME";
	}

	if (task.status === "pending" && nextRun <= now) {
		return "DELAYED";
	}

	if (task.status === "failed") {
		return "OVERDUE";
	}

	return "ON TIME";
}

function formatCountdown(iso: string | null): string {
	if (!iso) return "--";
	const d = new Date(iso);
	const now = Date.now();
	const diff = d.getTime() - now;

	// Future times
	if (diff > 0) {
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return "< 1m";
		if (mins < 60) return `${mins}m`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.floor(hours / 24);
		return `${days}d`;
	}

	// Past times
	const elapsed = Math.abs(diff);
	const mins = Math.floor(elapsed / 60_000);
	if (mins < 1) return "now";
	if (mins < 60) return `-${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `-${hours}h`;
	const days = Math.floor(hours / 24);
	return `-${days}d`;
}

function getStatusColor(status: "ON TIME" | "DELAYED" | "OVERDUE"): string {
	switch (status) {
		case "ON TIME":
			return "var(--status-active)";
		case "DELAYED":
			return "var(--alert-warning)";
		case "OVERDUE":
			return "var(--alert-disruption)";
	}
}

function getLineIndex(type: string): number {
	return TYPE_TO_LINE[type] ?? 0;
}
</script>

<div class="departure-board">
	{#if upcomingTasks.length > 0}
		{#each upcomingTasks as task (task.id)}
			{@const status = computeStatus(task)}
			{@const statusColor = getStatusColor(status)}
			<div class="departure-row">
				<LineBadge lineIndex={getLineIndex(task.type)} size="compact" />
				<span class="task-name">{task.displayName}</span>
				<span class="countdown">{formatCountdown(task.next_run_at)}</span>
				<span class="status-label" style="color: {statusColor}">{status}</span>
			</div>
		{/each}
	{:else}
		<div class="empty">No departures scheduled</div>
	{/if}
</div>

<style>
	.departure-board {
		background: var(--bg-primary);
		border: 1px solid var(--bg-surface);
		border-radius: 8px;
		padding: 12px;
		max-height: 120px;
		overflow-y: auto;
		margin-bottom: 20px;
	}

	.departure-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 0;
		font-size: var(--text-xs);
	}

	.task-name {
		flex: 1;
		color: var(--text-primary);
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.countdown {
		font-family: var(--font-mono);
		color: var(--text-secondary);
		font-size: 11px;
		letter-spacing: 0.04em;
		width: 40px;
		text-align: right;
	}

	.status-label {
		font-family: var(--font-display);
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		width: 60px;
		text-align: right;
	}

	.empty {
		color: var(--text-muted);
		font-size: var(--text-xs);
		text-align: center;
		padding: 6px 0;
	}
</style>
