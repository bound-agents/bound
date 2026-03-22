<script lang="ts">
import { onMount } from "svelte";

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

onMount(() => {
	loadTasks();
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
</script>

<div class="timetable">
	<h1>Timetable</h1>

	{#if loading}
		<p>Loading tasks...</p>
	{:else if tasks.length === 0}
		<p>No tasks scheduled.</p>
	{:else}
		<table class="tasks-table">
			<thead>
				<tr>
					<th>Task ID</th>
					<th>Type</th>
					<th>Status</th>
					<th>Run Count</th>
					<th>Created</th>
				</tr>
			</thead>
			<tbody>
				{#each tasks as task}
					<tr>
						<td class="task-id">{task.id.substring(0, 8)}</td>
						<td class="task-type">{task.type}</td>
						<td class={getStatusBadgeClass(task.status)}>{task.status}</td>
						<td class="run-count">{task.run_count}</td>
						<td class="created-at">{new Date(task.created_at).toLocaleString()}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	.timetable {
		padding: 20px;
	}

	h1 {
		margin-bottom: 20px;
		color: #e0e0e0;
	}

	p {
		color: #888;
	}

	.tasks-table {
		width: 100%;
		border-collapse: collapse;
		margin-top: 20px;
	}

	thead {
		background: #16213e;
		border-bottom: 2px solid #0f3460;
	}

	th {
		padding: 12px;
		text-align: left;
		color: #e0e0e0;
		font-weight: 500;
	}

	td {
		padding: 10px 12px;
		border-bottom: 1px solid #0f3460;
		color: #bbb;
	}

	tbody tr:hover {
		background: rgba(15, 52, 96, 0.5);
	}

	.task-id {
		font-family: monospace;
		font-size: 12px;
	}

	.status-completed {
		color: #00c994;
		font-weight: 500;
	}

	.status-running {
		color: #00a884;
		font-weight: 500;
	}

	.status-failed {
		color: #ff6b6b;
		font-weight: 500;
	}

	.status-pending {
		color: #ffaa00;
		font-weight: 500;
	}

	.status-unknown {
		color: #888;
	}
</style>
