<script lang="ts">
import type { TaskListEntry } from "@bound/client";
import { ArrowRight, CalendarClock } from "lucide-svelte";
import { onDestroy, onMount } from "svelte";
import { client } from "../lib/bound";
import { lineRoute } from "../lib/route-utils";
import { navigateTo } from "../lib/router";
import StatusChip from "./StatusChip.svelte";

// Inline card for a task the agent just scheduled (#90). Shows the task's
// display name, schedule, and live status, with a link to its thread once the
// task has run and acquired one. A freshly-scheduled task has no thread yet
// (thread_id is null until first run), so the card refreshes on `task:updated`
// and surfaces the link the moment the thread resolves.

interface Props {
	taskId: string;
	lineColor?: string;
}

const { taskId, lineColor = "var(--rule-soft)" }: Props = $props();

let task = $state<TaskListEntry | null>(null);
let loadError = $state(false);

async function load(): Promise<void> {
	try {
		task = await client.getTask(taskId);
		loadError = false;
	} catch {
		loadError = true;
	}
}

function onTaskUpdated(data: { taskId: string; status: string }): void {
	if (data.taskId === taskId) void load();
}

onMount(() => {
	void load();
	client.on("task:updated", onTaskUpdated);
});

onDestroy(() => {
	client.off("task:updated", onTaskUpdated);
});

// `claimed` is an in-flight task; render it as "running" to match the Timetable.
const chipStatus = $derived(task?.status === "claimed" ? "running" : (task?.status ?? "pending"));

function openThread(): void {
	if (task?.thread_id) navigateTo(lineRoute(task.thread_id));
}
</script>

<div class="task-card" style="--line-color: {lineColor}">
	<span class="tc-icon"><CalendarClock size={13} /></span>

	{#if loadError}
		<span class="tc-name tc-muted">Task unavailable</span>
	{:else if !task}
		<span class="tc-name tc-muted">Loading task…</span>
	{:else}
		<div class="tc-body">
			<div class="tc-line">
				<span class="tc-name mono">{task.displayName}</span>
				<StatusChip status={chipStatus as never} size="sm" />
			</div>
			{#if task.schedule}
				<span class="tc-schedule">{task.schedule}</span>
			{/if}
		</div>

		{#if task.thread_id}
			<button type="button" class="tc-open" onclick={openThread}>
				Open line <ArrowRight size={12} />
			</button>
		{:else}
			<span class="tc-pending-note">Hasn't departed yet</span>
		{/if}
	{/if}
</div>

<style>
	.task-card {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 0.7rem;
		margin: 0.4rem 0;
		background: var(--paper-2);
		border: 1px solid var(--rule-faint);
		border-left: 3px solid var(--line-color);
		border-radius: 4px;
		font-size: 0.85rem;
	}

	.tc-icon {
		display: flex;
		align-items: center;
		color: var(--ink-3);
		flex-shrink: 0;
	}

	.tc-body {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		flex: 1;
	}

	.tc-line {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.tc-name {
		color: var(--ink);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tc-muted {
		color: var(--ink-3);
		font-weight: 400;
		font-style: italic;
	}

	.tc-schedule {
		color: var(--ink-3);
		font-size: 0.75rem;
	}

	.tc-open {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.25rem 0.55rem;
		background: transparent;
		border: 1px solid var(--rule-soft);
		border-radius: 3px;
		color: var(--accent);
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
		flex-shrink: 0;
		transition: background 0.12s ease;
	}

	.tc-open:hover {
		background: var(--accent-wash);
	}

	.tc-pending-note {
		color: var(--ink-4);
		font-size: 0.75rem;
		font-style: italic;
		flex-shrink: 0;
	}
</style>
