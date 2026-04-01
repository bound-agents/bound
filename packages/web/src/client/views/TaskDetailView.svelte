<script lang="ts">
import { onDestroy, onMount } from "svelte";
import DebugPanelWrapper from "../components/DebugPanelWrapper.svelte";
import MessageList from "../components/MessageList.svelte";
import { api } from "../lib/api";
import { navigateTo } from "../lib/router";
import { connectWebSocket, disconnectWebSocket, subscribeToThread } from "../lib/websocket";
import { wsEvents } from "../lib/websocket";

interface TaskDetail {
	id: string;
	type: string;
	status: string;
	trigger_spec: string;
	payload: string | null;
	thread_id: string | null;
	origin_thread_id: string | null;
	claimed_by: string | null;
	next_run_at: string | null;
	last_run_at: string | null;
	run_count: number;
	max_runs: number | null;
	created_at: string;
	created_by: string | null;
	error: string | null;
}

interface Message {
	id: string;
	thread_id: string;
	role: string;
	content: string;
	model_id: string | null;
	tool_name: string | null;
	created_at: string;
}

const { taskId } = $props<{ taskId: string }>();

let task: TaskDetail | null = $state(null);
let messages: Message[] = $state([]);
let loading = $state(true);
let errorMsg = $state<string | null>(null);

let pollInterval: ReturnType<typeof setInterval> | null = null;

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

function formatRelativeTime(iso: string | null): string {
	if (!iso) return "—";
	const date = new Date(iso);
	const now = Date.now();
	const diffMs = now - date.getTime();
	const absDiff = Math.abs(diffMs);
	const future = diffMs < 0;

	if (absDiff < 60_000) return future ? "in <1m" : "<1m ago";
	if (absDiff < 3_600_000) {
		const mins = Math.floor(absDiff / 60_000);
		return future ? `in ${mins}m` : `${mins}m ago`;
	}
	if (absDiff < 86_400_000) {
		const hrs = Math.floor(absDiff / 3_600_000);
		return future ? `in ${hrs}h` : `${hrs}h ago`;
	}
	const days = Math.floor(absDiff / 86_400_000);
	return future ? `in ${days}d` : `${days}d ago`;
}

async function fetchData() {
	try {
		task = (await api.getTask(taskId)) as TaskDetail;
		errorMsg = null;

		if (task.thread_id) {
			messages = (await api.listMessages(task.thread_id)) as Message[];
		}
	} catch {
		if (!task) {
			errorMsg = "Task not found";
		}
	} finally {
		loading = false;
	}
}

onMount(() => {
	fetchData();
	pollInterval = setInterval(fetchData, 5000);
	connectWebSocket();
});

// Subscribe to WebSocket when thread_id becomes available
$effect(() => {
	if (task?.thread_id) {
		subscribeToThread(task.thread_id);
	}
});

onDestroy(() => {
	if (pollInterval) clearInterval(pollInterval);
	disconnectWebSocket();
});
</script>

<DebugPanelWrapper threadId={task?.thread_id ?? null} {wsEvents}>
	{#snippet children({ debugOpen, toggleDebug })}
{#if loading}
	<div class="task-detail-view">
		<div class="loading">Loading task...</div>
	</div>
{:else if errorMsg}
	<div class="task-detail-view">
		<div class="error-state">
			<div class="error-icon">!!</div>
			<h2>Task not found</h2>
			<p>This task may have been deleted or doesn't exist.</p>
			<button class="back-link" onclick={() => navigateTo("/timetable")}>
				← Back to Timetable
			</button>
		</div>
	</div>
{:else if task}
	<div class="task-detail-view">
		<!-- Back link -->
		<div class="header">
			<button class="back-link" onclick={() => navigateTo("/timetable")}>
				← Back to Timetable
			</button>
			{#if task.thread_id}
				<button class="debug-toggle" onclick={toggleDebug} title="Context Debug">
					{debugOpen ? "✕" : "⚙"}
				</button>
			{/if}

			<!-- Task metadata header -->
			<div class="task-meta">
				<div class="meta-row">
					<span class="status-chip {getStatusBadgeClass(task.status)}">
						<span class="status-icon">{getStatusIcon(task.status)}</span>
						{task.status}
					</span>
					<span class="task-type">{task.type}</span>
					<span class="trigger-spec">{task.trigger_spec}</span>
				</div>

				<div class="meta-row stats">
					<span class="stat">
						<span class="stat-label">Runs</span>
						<span class="stat-value">
							{task.run_count}{task.max_runs ? ` / ${task.max_runs}` : ""}
						</span>
					</span>
					<span class="stat">
						<span class="stat-label">Last run</span>
						<span class="stat-value">{formatRelativeTime(task.last_run_at)}</span>
					</span>
					<span class="stat">
						<span class="stat-label">Next run</span>
						<span class="stat-value">{formatRelativeTime(task.next_run_at)}</span>
					</span>
					{#if task.claimed_by}
						<span class="stat">
							<span class="stat-label">Host</span>
							<span class="stat-value">{task.claimed_by}</span>
						</span>
					{/if}
				</div>

				<!-- Error message for failed tasks -->
				{#if task.status === "failed" && task.error}
					<div class="error-banner">
						<span class="error-label">Error:</span> {task.error}
					</div>
				{/if}
			</div>
		</div>

		<!-- Message history -->
		<MessageList
			{messages}
			emptyText={!task.thread_id
				? "This task hasn't run yet. Messages will appear here after the first execution."
				: "No messages yet."}
		/>
	</div>
{/if}
	{/snippet}
</DebugPanelWrapper>

<style>
	.task-detail-view {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		max-width: 48rem;
		width: 100%;
		margin: 0 auto;
		padding: 24px;
		overflow: hidden;
		box-sizing: border-box;
	}

	.header {
		display: flex;
		flex-direction: column;
		gap: 16px;
		margin-bottom: 24px;
		flex-shrink: 0;
		border-bottom: 1px solid var(--bg-surface);
		padding-bottom: 16px;
	}

	.debug-toggle {
		align-self: flex-end;
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface);
		color: var(--text-secondary);
		padding: 4px 8px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 14px;
		transition: color 0.2s;
		flex-shrink: 0;
	}

	.debug-toggle:hover {
		color: var(--text-primary);
		border-color: var(--line-7);
	}

	.back-link {
		align-self: flex-start;
		padding: 8px 16px;
		background: var(--bg-secondary);
		border: 1px solid var(--bg-surface);
		color: var(--text-secondary);
		border-radius: 6px;
		cursor: pointer;
		font-family: var(--font-display);
		font-size: var(--text-sm);
		font-weight: 600;
		transition: all 0.2s ease;
	}

	.back-link:hover {
		background: var(--bg-surface);
		color: var(--text-primary);
	}

	.task-meta {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.meta-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
	}

	.meta-row.stats {
		gap: 24px;
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
		50% {
			opacity: 0;
		}
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

	.task-type {
		color: var(--text-secondary);
		font-family: var(--font-display);
		font-size: var(--text-sm);
	}

	.trigger-spec {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--text-secondary);
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.stat-label {
		font-family: var(--font-display);
		font-size: var(--text-xs);
		color: var(--text-muted);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.stat-value {
		font-family: var(--font-display);
		font-size: var(--text-sm);
		color: var(--text-primary);
		font-weight: 600;
	}

	.error-banner {
		background: rgba(255, 23, 68, 0.08);
		color: var(--alert-disruption);
		padding: 12px 16px;
		border-radius: 6px;
		margin-top: 12px;
		font-family: var(--font-body);
		font-size: var(--text-sm);
	}

	.error-label {
		font-weight: 600;
	}

.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 64px 32px;
		text-align: center;
	}

	.error-icon {
		font-family: var(--font-mono);
		font-size: 48px;
		font-weight: 700;
		color: var(--alert-disruption);
		margin-bottom: 16px;
	}

	.error-state h2 {
		margin: 0 0 8px 0;
		color: var(--text-primary);
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: 700;
	}

	.error-state p {
		margin: 0 0 24px 0;
		color: var(--text-muted);
		font-family: var(--font-body);
		font-size: var(--text-sm);
	}

	.loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 64px 32px;
		color: var(--text-muted);
		font-family: var(--font-display);
		font-size: var(--text-sm);
		min-height: 200px;
	}
</style>
