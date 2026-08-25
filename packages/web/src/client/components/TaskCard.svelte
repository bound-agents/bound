<script lang="ts">
import type { TaskListEntry } from "@bound/client";
import { CalendarClock } from "lucide-svelte";
import { onDestroy, onMount } from "svelte";
import { client } from "../lib/bound";
import StatusChip from "./StatusChip.svelte";
import ThreadLinkCard from "./ThreadLinkCard.svelte";

// Inline card for a task the agent just scheduled (#90). Shows the task's
// display name, schedule, and live status, with a link to its thread once the
// task has run and acquired one. A freshly-scheduled task has no thread yet
// (thread_id is null until first run), so the card refreshes on `task:updated`
// and surfaces the link the moment the thread resolves.
//
// The frame (icon slot, open-thread action, pending note) is the shared
// ThreadLinkCard shell; this component owns only the task-specific body and
// the load/refresh lifecycle.

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
</script>

<ThreadLinkCard
	{lineColor}
	threadId={task?.thread_id ?? null}
	pendingLabel={task && !loadError ? "Hasn't departed yet" : null}
>
	{#snippet icon()}
		<CalendarClock size={13} />
	{/snippet}

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
	{/if}
</ThreadLinkCard>

<style>
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
</style>
