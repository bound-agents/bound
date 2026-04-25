<script lang="ts">
import type { TaskListEntry } from "@bound/client";
import { onDestroy, onMount } from "svelte";
import DepartureBoard from "../components/DepartureBoard.svelte";
import LineBadge from "../components/LineBadge.svelte";
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";
import StatusChip from "../components/StatusChip.svelte";
import TicketTab from "../components/TicketTab.svelte";
import { client } from "../lib/bound";
import { getLineColor } from "../lib/metro-lines";
import { navigateTo } from "../lib/router";
import { sortTasks } from "../lib/task-sort";

let allTasks: TaskListEntry[] = $state([]);
let loading = $state(true);
let activeFilters = $state<Set<string>>(new Set());
let expandedTaskId = $state<string | null>(null);

const sortedTasks = $derived(sortTasks(allTasks) as unknown as TaskListEntry[]);

const filteredTasks = $derived(
	sortedTasks.filter((t) => {
		if (activeFilters.size === 0) return true;
		if (activeFilters.has(t.status)) return true;
		if (activeFilters.has("running") && t.status === "claimed") return true;
		return false;
	}),
);

const TYPE_TO_LINE: Record<string, number> = {
	cron: 0,
	heartbeat: 7,
	deferred: 3,
	event: 6,
};

function getLineIndex(type: string): number {
	return TYPE_TO_LINE[type] ?? 0;
}

function formatDuration(ms: number | null): string {
	if (!ms) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const secs = ms / 1000;
	if (secs < 60) return `${secs.toFixed(1)}s`;
	const mins = secs / 60;
	if (mins < 60) return `${mins.toFixed(1)}m`;
	return `${(mins / 60).toFixed(1)}h`;
}

function formatTime(iso: string | null): string {
	if (!iso) return "—";
	const d = new Date(iso);
	const diff = d.getTime() - Date.now();
	if (diff > 0) {
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return "< 1m";
		if (mins < 60) return `in ${mins}m`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `in ${hours}h`;
		return d.toLocaleDateString();
	}
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
	if (next.has(status)) next.delete(status);
	else next.add(status);
	activeFilters = next;
}

function toggleTaskExpansion(taskId: string): void {
	expandedTaskId = expandedTaskId === taskId ? null : taskId;
}

async function loadTasks(): Promise<void> {
	try {
		allTasks = await client.listTasks();
	} catch (error) {
		console.error("Failed to load tasks:", error);
	}
	loading = false;
}

async function cancelTask(taskId: string): Promise<void> {
	try {
		await client.cancelTask(taskId);
		await loadTasks();
	} catch (error) {
		console.error("Failed to cancel task:", error);
	}
}

function canCancel(status: string): boolean {
	return status === "pending" || status === "running" || status === "claimed";
}

const statusCounts = $derived.by(() => {
	const out: Record<string, number> = {
		pending: 0,
		running: 0,
		failed: 0,
		cancelled: 0,
		completed: 0,
	};
	for (const t of allTasks) {
		if (t.status === "claimed") out.running++;
		else if (out[t.status] != null) out[t.status]++;
	}
	return out;
});

let pollInterval: ReturnType<typeof setInterval> | null = null;

onMount(() => {
	loadTasks();
	pollInterval = setInterval(loadTasks, 5000);
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
});

function departureBoardData(tasks: TaskListEntry[]) {
	return tasks.map((t) => ({
		id: t.id,
		type: t.type,
		displayName: t.displayName,
		status: t.status,
		schedule: t.schedule,
		hostName: t.hostName,
		next_run_at: t.next_run_at,
		last_run_at: t.last_run_at,
	}));
}

const statuses = ["pending", "running", "failed", "cancelled", "completed"];
</script>

<Page>
	{#snippet children()}
		<SectionHeader number={2} subtitle="Scheduled & Live Tasks" title="Timetable">
			{#snippet actions()}
				<div class="filter-area">
					{#each statuses as status}
						<button
							class="filter-chip"
							class:active={activeFilters.has(status)}
							onclick={() => toggleFilter(status)}
						>
							{status[0].toUpperCase() + status.slice(1)}
							<span class="chip-count">{statusCounts[status]}</span>
						</button>
					{/each}
				</div>
			{/snippet}
		</SectionHeader>

		{#if loading}
			<div class="state">
				<p>Loading schedule…</p>
			</div>
		{:else if allTasks.length === 0}
			<div class="state">
				<p>No scheduled tasks.</p>
			</div>
		{:else}
			<DepartureBoard tasks={departureBoardData(filteredTasks)} />

			<div class="task-list">
				<div class="task-list-header">
					<span></span>
					<span>Status</span>
					<span>Name</span>
					<span>Type</span>
					<span>Schedule</span>
					<span>Next</span>
					<span>Last</span>
					<span class="right">Duration</span>
					<span>Host</span>
					<span class="right">Action</span>
				</div>

				{#each filteredTasks as task (task.id)}
					{@const expanded = expandedTaskId === task.id}
					{@const lineIdx = getLineIndex(task.type)}
					<div
						class="task-row"
						class:expanded
						class:dim={task.status === "completed" || task.status === "cancelled"}
						onclick={() => toggleTaskExpansion(task.id)}
					>
						<div class="line-accent" style="background: {getLineColor(lineIdx)}"></div>
						<span class="chevron" class:open={expanded}>›</span>
						<span>
							<StatusChip
								status={task.status === "claimed" ? "running" : (task.status as never)}
							/>
						</span>
						<span class="task-name mono">{task.displayName}</span>
						<span class="task-type">
							<LineBadge lineIndex={lineIdx} size="compact" label={task.type[0]?.toUpperCase()} />
							<span class="type-label">{task.type}</span>
						</span>
						<span class="schedule mono">{task.schedule ?? "—"}</span>
						<span class="mono tnum">{formatTime(task.next_run_at)}</span>
						<span class="mono tnum dim-value">{formatTime(task.last_run_at)}</span>
						<span class="mono tnum dim-value right">{formatDuration(task.lastDurationMs)}</span>
						<span class="mono dim-value">{task.hostName ?? "—"}</span>
						<span class="right">
							{#if canCancel(task.status)}
								<button
									class="action-btn cancel"
									onclick={(e) => {
										e.stopPropagation();
										cancelTask(task.id);
									}}
								>
									Cancel
								</button>
							{:else if task.status === "failed" && task.error}
								<span class="err-badge" title={task.error}>ERR</span>
							{/if}
						</span>
					</div>

					{#if expanded}
						<div class="task-expanded" style="border-left-color: {getLineColor(lineIdx)}">
							<div class="expand-grid">
								<div class="detail-block">
									<div class="detail-row">
										<span class="detail-kicker kicker">Task ID</span>
										<span class="detail-value mono">{task.id}</span>
									</div>
									<div class="detail-row">
										<span class="detail-kicker kicker">Runs</span>
										<span class="detail-value mono">
											{task.run_count}{task.consecutive_failures > 0
												? ` (${task.consecutive_failures} failures)`
												: ""}
										</span>
									</div>
									<div class="detail-row">
										<span class="detail-kicker kicker">Schedule</span>
										<span class="detail-value mono">{task.schedule ?? "—"}</span>
									</div>
									<div class="detail-row">
										<span class="detail-kicker kicker">Host</span>
										<span class="detail-value mono">{task.hostName ?? "—"}</span>
									</div>
									{#if task.thread_id}
										{@const threadId = task.thread_id}
										<div class="detail-row">
											<span class="detail-kicker kicker">Thread</span>
											<button
												class="thread-link mono"
												onclick={() => navigateTo(`/line/${threadId}`)}
											>
												{threadId.slice(0, 10)}
												<span>→</span>
											</button>
										</div>
									{/if}
								</div>
								<div>
									{#if task.error}
										<div class="kicker err-label">Last Error</div>
										<pre class="err-box">{task.error}</pre>
									{:else}
										<div class="kicker">Recent History</div>
										<div class="history">
											{#each Array(24) as _, i}
												{@const h = 10 + ((i * 41) % 34)}
												{@const fail = (i * 7) % 23 === 0}
												<span
													class="history-bar"
													style="height: {h}px; background: {fail ? 'var(--err)' : getLineColor(lineIdx)}"
												></span>
											{/each}
										</div>
										<div class="history-legend mono">
											LAST 24 RUNS · HEIGHT = DURATION · RED = FAILED
										</div>
									{/if}
								</div>
							</div>
						</div>
					{/if}
				{/each}
			</div>

			<div class="footer mono">
				<span>{filteredTasks.length} of {allTasks.length} tasks</span>
				<span>Refresh · 5s</span>
			</div>
		{/if}
	{/snippet}
</Page>

<style>
	.filter-area {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.filter-chip {
		padding: 6px 12px;
		background: transparent;
		color: var(--ink-2);
		border: 1px solid var(--rule-soft);
		cursor: pointer;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.filter-chip.active {
		background: var(--ink);
		color: var(--paper);
		border-color: var(--ink);
	}

	.chip-count {
		font-size: 10px;
		padding: 1px 5px;
		background: var(--paper-3);
		color: var(--ink-3);
	}

	.filter-chip.active .chip-count {
		background: var(--accent);
		color: #fff;
	}

	.state {
		padding: 40px;
		text-align: center;
		color: var(--ink-3);
		font-style: italic;
	}

	.task-list {
		border: 1px solid var(--rule-soft);
		background: var(--paper);
	}

	.task-list-header {
		display: grid;
		grid-template-columns: 18px 96px 1fr 96px 140px 90px 90px 70px 90px 70px;
		gap: 14px;
		padding: 12px 18px;
		background: var(--paper-3);
		border-bottom: 1px solid var(--ink);
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-2);
	}

	.right {
		text-align: right;
	}

	.task-row {
		position: relative;
		display: grid;
		grid-template-columns: 18px 96px 1fr 96px 140px 90px 90px 70px 90px 70px;
		gap: 14px;
		padding: 13px 18px;
		border-bottom: 1px solid var(--rule-faint);
		cursor: pointer;
		align-items: center;
		transition: background 0.12s ease;
	}

	.task-row:hover:not(.expanded) {
		background: rgba(26, 24, 20, 0.035);
	}

	.task-row.expanded {
		background: var(--paper-3);
	}

	.line-accent {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 3px;
	}

	.task-row.dim .line-accent {
		opacity: 0.35;
	}

	.chevron {
		font-family: var(--font-mono);
		color: var(--ink-3);
		transition: transform 0.15s ease;
	}

	.chevron.open {
		transform: rotate(90deg);
	}

	.task-name {
		font-family: var(--font-mono);
		font-size: 12.5px;
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.task-type {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--ink-2);
	}

	.type-label {
		color: var(--ink-2);
	}

	.schedule {
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--ink-2);
	}

	.mono {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: 11.5px;
	}

	.dim-value {
		color: var(--ink-3);
	}

	.action-btn {
		padding: 3px 8px;
		background: transparent;
		border: 1px solid var(--err);
		color: var(--err);
		border-radius: 0;
		cursor: pointer;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	.action-btn.cancel:hover {
		background: rgba(178, 34, 34, 0.08);
	}

	.err-badge {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--err);
		background: rgba(178, 34, 34, 0.08);
		padding: 2px 5px;
		font-weight: 600;
		letter-spacing: 0.12em;
	}

	.task-expanded {
		padding: 16px 40px 18px 36px;
		background: var(--paper-2);
		border-bottom: 1px solid var(--rule-faint);
		border-left: 3px solid var(--ink);
	}

	.expand-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 22px;
	}

	.detail-block {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-3);
		margin-bottom: 6px;
	}

	.err-label {
		color: var(--err);
	}

	.err-box {
		margin: 0;
		padding: 12px;
		background: var(--paper);
		border: 1px solid var(--err);
		border-left: 3px solid var(--err);
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--err);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.history {
		display: flex;
		gap: 3px;
		align-items: flex-end;
		height: 44px;
	}

	.history-bar {
		width: 8px;
		opacity: 0.8;
	}

	.history-legend {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--ink-4);
		margin-top: 6px;
		letter-spacing: 0.1em;
	}

	.detail-row {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}

	.detail-kicker {
		min-width: 80px;
	}

	.detail-value {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--ink);
	}

	.thread-link {
		background: transparent;
		border: none;
		padding: 0;
		margin: 0;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.thread-link:hover {
		color: var(--ink);
	}

	.footer {
		display: flex;
		justify-content: space-between;
		padding: 14px 4px 0;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--ink-4);
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}
</style>
