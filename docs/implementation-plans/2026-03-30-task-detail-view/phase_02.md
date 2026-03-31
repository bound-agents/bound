# Task Detail View Implementation Plan — Phase 2

**Goal:** Create the TaskDetailView Svelte component with task metadata header, message history display, and wire it into the hash-based router.

**Architecture:** New `TaskDetailView.svelte` view component following the LineView pattern — fetches task metadata from `GET /api/tasks/:id` (Phase 1), conditionally fetches messages via `api.listMessages()` when the task has a `thread_id`, renders metadata header with status badges and message history with `MessageBubble`. 5-second polling for both. New route `#/task/{taskId}` added to `App.svelte`.

**Tech Stack:** Svelte 5 (runes: `$state`, `$effect`, `$props`), TypeScript, existing MessageBubble component, existing api module

**Scope:** 3 phases from original design (phases 1-3). This is phase 2.

**Codebase verified:** 2026-03-30

**Key reference files:**
- `packages/web/src/client/views/LineView.svelte` — primary structural model (polling, MessageBubble loop, layout)
- `packages/web/src/client/views/Timetable.svelte` — status badge functions and CSS classes
- `packages/web/src/client/App.svelte` — routing pattern
- `packages/web/src/client/components/MessageBubble.svelte` — props: `role`, `content`, `toolName`, `modelId`
- `packages/web/src/client/lib/api.ts` — `getTask()` (Phase 1), `listMessages()`
- `packages/web/src/client/lib/router.ts` — `navigateTo()` function

---

## Acceptance Criteria Coverage

This phase implements and tests:

### task-detail-view.AC2: Task metadata header
- **task-detail-view.AC2.1 Success:** Header displays task status with color-coded badge matching Timetable conventions
- **task-detail-view.AC2.2 Success:** Header displays task type and human-readable trigger specification
- **task-detail-view.AC2.3 Success:** Header displays run count, last run time, and next run time in relative format
- **task-detail-view.AC2.4 Success:** Header displays error message prominently when task status is "failed"
- **task-detail-view.AC2.5 Edge:** Header renders correctly for all six task statuses (pending, claimed, running, completed, failed, cancelled)

### task-detail-view.AC3: Message history display
- **task-detail-view.AC3.1 Success:** Task's thread messages render chronologically via MessageBubble with all roles handled (user, assistant, tool_call, tool_result, alert, system)
- **task-detail-view.AC3.2 Edge:** Task with null `thread_id` shows empty state message indicating the task hasn't run yet

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Create TaskDetailView.svelte

**Verifies:** task-detail-view.AC2.1, task-detail-view.AC2.2, task-detail-view.AC2.3, task-detail-view.AC2.4, task-detail-view.AC2.5, task-detail-view.AC3.1, task-detail-view.AC3.2

**Files:**
- Create: `packages/web/src/client/views/TaskDetailView.svelte`

**Implementation:**

Create a new Svelte 5 component following the LineView pattern. The component has two zones: a metadata header and a message history area.

**Script section structure:**

```typescript
// Imports
import { onMount, onDestroy } from "svelte";
import { navigateTo } from "../lib/router";
import { api } from "../lib/api";
import MessageBubble from "../components/MessageBubble.svelte";

// Props (Svelte 5 $props rune)
const { taskId } = $props<{ taskId: string }>();

// Local interface for task data display
// (the Task type from api.ts covers the same fields, but we define
//  a view-local alias consistent with how Timetable.svelte does it)
interface TaskDetail {
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

// Message interface (matches api.ts Message)
interface Message {
	id: string;
	thread_id: string;
	role: string;
	content: string;
	model_id: string | null;
	tool_name: string | null;
	created_at: string;
}

// State (Svelte 5 $state rune)
let task: TaskDetail | null = $state(null);
let messages: Message[] = $state([]);
let loading = $state(true);
let errorMsg = $state<string | null>(null);

let pollInterval: ReturnType<typeof setInterval> | null = null;
```

**Status badge helper functions** — copy the exact `getStatusBadgeClass()` and `getStatusIcon()` functions from `Timetable.svelte` lines 58-93. Add `biome-ignore` comments since these functions are only referenced in the template:

```typescript
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
```

**Relative time formatter** (also needs biome-ignore for template usage):

```typescript
// biome-ignore lint/correctness/noUnusedVariables: used in template
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
```

**Data fetching and polling:**

```typescript
async function fetchData() {
	try {
		task = await api.getTask(taskId) as TaskDetail;
		errorMsg = null;

		if (task.thread_id) {
			messages = await api.listMessages(task.thread_id) as Message[];
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
});

onDestroy(() => {
	if (pollInterval) clearInterval(pollInterval);
});
```

**Template structure (HTML):**

Three states: loading, error, and normal display.

```svelte
{#if loading}
	<!-- Loading state: centered spinner/text -->
	<div class="task-detail-view">
		<div class="loading">Loading task...</div>
	</div>
{:else if errorMsg}
	<!-- Error state (AC1.4): task not found -->
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
		<!-- Back link (AC1.3) -->
		<div class="header">
			<button class="back-link" onclick={() => navigateTo("/timetable")}>
				← Back to Timetable
			</button>

			<!-- Task metadata header (AC2.1-AC2.5) -->
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

				<!-- Error message for failed tasks (AC2.4) -->
				{#if task.status === "failed" && task.error}
					<div class="error-banner">
						<span class="error-label">Error:</span> {task.error}
					</div>
				{/if}
			</div>
		</div>

		<!-- Message history (AC3.1, AC3.2) -->
		<div class="messages">
			{#if !task.thread_id}
				<!-- Empty state (AC3.2) -->
				<div class="empty-state">
					<p>This task hasn't run yet. Messages will appear here after the first execution.</p>
				</div>
			{:else if messages.length === 0}
				<div class="empty-state">
					<p>No messages yet.</p>
				</div>
			{:else}
				{#each messages as msg}
					<MessageBubble
						role={msg.role}
						content={msg.content}
						toolName={msg.tool_name}
						modelId={msg.model_id}
					/>
				{/each}
			{/if}
		</div>
	</div>
{/if}
```

**Styling:**

Follow Tokyo Metro aesthetic. Use CSS variables from App.svelte global styles. Key style rules:

- `.task-detail-view` — flex column, max-width 48rem (same as `.line-view`), margin auto, height 100%, padding
- `.header` — sticky top, background `var(--bg-primary)`, border-bottom
- `.back-link` — styled as link button, `var(--text-secondary)` color, no border, cursor pointer, hover underline
- `.task-meta` — padding, flex column gap
- `.meta-row` — flex row, align-items center, gap 0.75rem, flex-wrap
- `.status-chip` — same styles as Timetable's `.status-chip` (inline-flex, align-items center, border-radius, padding, font-size `var(--text-xs)`, text-transform uppercase)
- Copy all `.status-completed`, `.status-running`, `.status-failed`, `.status-pending`, `.status-cancelled` classes from Timetable.svelte (lines 491-527)
- `.task-type` — muted text
- `.trigger-spec` — monospace font, `var(--text-secondary)`
- `.stats` — flex row with gap, wrapping
- `.stat` — flex column, `.stat-label` small muted, `.stat-value` normal weight
- `.error-banner` — background with alpha red, red text, padding, border-radius, margin-top
- `.messages` — flex-grow 1, overflow-y auto, padding
- `.empty-state` — centered text, muted, padding
- `.error-state` — centered, flex column, align-items center, padding
- `.loading` — centered text, muted

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

**Manual verification checklist** (Svelte components cannot be fully tested without a DOM environment; these manual checks map ACs to specific visual verification steps):

| AC | Verification Step |
|----|------------------|
| AC2.1 | Create tasks with each status, navigate to `#/task/{id}`, verify status badge color matches Timetable |
| AC2.2 | Verify task type label and trigger spec (e.g., "cron" and "0 9 * * MON") display in header |
| AC2.3 | Verify run count, last run time, and next run time display in relative format (e.g., "3h ago", "in 2d") |
| AC2.4 | Create a task with `status=failed` and `error="something broke"`, verify red error banner is visible |
| AC2.5 | Create tasks with all six statuses (pending, claimed, running, completed, failed, cancelled), verify each renders |
| AC3.1 | Navigate to a task with messages, verify all message roles render via MessageBubble |
| AC3.2 | Navigate to a task with null `thread_id`, verify "hasn't run yet" empty state message |

Full behavioral coverage will be achieved via Playwright e2e tests (deferred to post-implementation).

**Commit:** `feat(web): create TaskDetailView component with metadata header and message history`

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add TaskDetailView component import test

**Verifies:** task-detail-view.AC2.5 (component can be instantiated without error)

**Files:**
- Modify: `packages/web/src/client/__tests__/components.test.ts` (add new import test)

**Testing:**

Add a test case following the existing pattern in `components.test.ts`:

```typescript
it("TaskDetailView component module imports without error", async () => {
	const TaskDetailView = await import("../views/TaskDetailView.svelte");
	expect(TaskDetailView).toBeDefined();
});
```

This verifies the component module is syntactically valid and can be loaded.

**Verification:**
Run: `bun test packages/web/src/client/__tests__/components.test.ts`
Expected: All tests pass including new import test

**Commit:** `test(web): add TaskDetailView component import test`

<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Add #/task/{taskId} route to App.svelte

**Verifies:** task-detail-view.AC2.1 through AC2.5, task-detail-view.AC3.1, task-detail-view.AC3.2 (route makes the component accessible)

**Files:**
- Modify: `packages/web/src/client/App.svelte` (add import and route conditional)

**Implementation:**

Two changes to App.svelte:

**1. Add import** — at the top of the `<script>` section, alongside other view imports. IMPORTANT: Every component import in App.svelte requires a `biome-ignore` comment because Biome cannot see Svelte template usage:

```typescript
// biome-ignore lint/correctness/noUnusedImports: used in template
import TaskDetailView from "./views/TaskDetailView.svelte";
```

**2. Add route conditional** — in the `{#if}` routing block, add a new `{:else if}` clause for the task detail route. Place it AFTER the `/line/` route and BEFORE the `/timetable` route, following the established pattern:

```svelte
{:else if route.startsWith("/task/")}
	<TaskDetailView taskId={route.split("/")[2]} />
```

This follows the exact same pattern as the existing LineView route:
```svelte
{:else if route.startsWith("/line/")}
	<LineView threadId={route.split("/")[2]} />
```

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

Run: `bun run build`
Expected: Build succeeds with new component included

**Commit:** `feat(web): add task detail route to App.svelte`

<!-- END_TASK_3 -->
