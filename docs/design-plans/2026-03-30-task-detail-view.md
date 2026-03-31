# Task Detail View Design

## Summary

This design adds a dedicated task detail page to the Bound web UI, allowing users to drill down from the high-level Timetable view into the complete execution history of an individual task. The page provides a metadata header showing task status, trigger configuration, and run statistics, followed by a chronological read-only display of all messages exchanged during the task's execution(s). The implementation follows existing patterns from the LineView component, reusing the MessageBubble component for message rendering and applying the same 5-second polling strategy for data refresh.

The approach is straightforward: add a single new API endpoint (`GET /api/tasks/:id`) that mirrors the existing `GET /api/threads/:id` pattern, create a new TaskDetailView Svelte component that fetches task metadata and then conditionally fetches messages from the task's associated thread, and wire the new view into the hash-based router alongside existing routes. The Timetable is enhanced to make task rows clickable, routing users to the new detail view. All UI elements maintain consistency with the Tokyo Metro aesthetic established throughout the application.

## Definition of Done

Users can click a task row in the Timetable view to navigate to a dedicated task detail page. This page displays the full message history associated with that task's thread (read-only), with a task metadata header showing key info (status, type, trigger, run count, etc.) above the messages. Tasks that haven't run yet show an appropriate empty state. Back navigation returns to the Timetable. The page is consistent with the Tokyo Metro aesthetic used throughout the app.

## Acceptance Criteria

### task-detail-view.AC1: Navigation between Timetable and task detail
- **task-detail-view.AC1.1 Success:** Clicking a task row in Timetable navigates to `#/task/{taskId}`
- **task-detail-view.AC1.2 Success:** Clicking the cancel button on a task row does not trigger row navigation
- **task-detail-view.AC1.3 Success:** "Back to Timetable" link on the task detail page navigates to `#/timetable`
- **task-detail-view.AC1.4 Failure:** Navigating to `#/task/{nonexistent-or-deleted-id}` shows error state with link back to Timetable

### task-detail-view.AC2: Task metadata header
- **task-detail-view.AC2.1 Success:** Header displays task status with color-coded badge matching Timetable conventions
- **task-detail-view.AC2.2 Success:** Header displays task type and human-readable trigger specification
- **task-detail-view.AC2.3 Success:** Header displays run count, last run time, and next run time in relative format
- **task-detail-view.AC2.4 Success:** Header displays error message prominently when task status is "failed"
- **task-detail-view.AC2.5 Edge:** Header renders correctly for all six task statuses (pending, claimed, running, completed, failed, cancelled)

### task-detail-view.AC3: Message history display
- **task-detail-view.AC3.1 Success:** Task's thread messages render chronologically via MessageBubble with all roles handled (user, assistant, tool_call, tool_result, alert, system)
- **task-detail-view.AC3.2 Edge:** Task with null `thread_id` shows empty state message indicating the task hasn't run yet

### task-detail-view.AC4: Timetable scroll fix
- **task-detail-view.AC4.1 Success:** Timetable task list scrolls when content exceeds viewport height

## Glossary

- **Timetable**: The scheduled task management view in the Bound web UI that displays all configured tasks with their status, next run time, and controls.
- **MessageBubble**: A reusable Svelte component that renders individual messages with role-appropriate styling (user, assistant, tool_call, tool_result, alert, system).
- **LineView**: The existing thread detail view that displays the message history for a conversation thread; the TaskDetailView follows the same architectural pattern.
- **Hash-based routing**: A client-side navigation pattern where routes are encoded after the `#` in the URL (e.g., `#/task/abc123`), allowing single-page apps to handle navigation without server round-trips.
- **Tokyo Metro aesthetic**: The design language used throughout the Bound web UI, characterized by subway-line colors, station motifs, and clean typography inspired by Tokyo's transit system.
- **Polling**: A data refresh strategy where the client makes periodic HTTP requests (every 5 seconds in this case) to check for updates, as opposed to real-time push via WebSockets.
- **Hono**: The web framework used for the Bound HTTP server, providing routing and middleware for API endpoints.
- **thread_id**: A foreign key on the tasks table linking each task to the conversation thread that stores its message history; null until the task's first execution.
- **no_history flag**: A task configuration option that excludes previous messages from LLM context assembly (the agent sees only the current turn), but does not affect message persistence or UI display.
- **Cron tasks**: Scheduled tasks configured with cron expressions (e.g., `0 9 * * MON` for "every Monday at 9:00 AM") that reuse the same thread across multiple runs.
- **onDestroy**: A Svelte lifecycle hook that runs when a component is removed from the DOM, used here to clean up polling intervals.
- **Svelte 5**: The UI framework version used for the Bound web client, featuring runes and modern reactivity primitives.

## Architecture

Standalone `TaskDetailView.svelte` component at route `#/task/{taskId}`. Fetches task metadata from a new `GET /api/tasks/:id` endpoint, then fetches associated messages via the existing `api.listMessages(threadId)` when the task has a `thread_id`.

The page has two zones:

1. **Task metadata header** — compact display of status (color-coded badge), type, trigger spec (human-readable), run count, last/next run times, claimed host, and error message (if failed). Includes a "Back to Timetable" link.

2. **Message history** — chronological list of all messages in the task's thread, rendered with the existing `MessageBubble` component. Read-only (no input form).

Data refresh via 5-second polling for both task metadata and messages. No WebSocket subscription in initial implementation.

**Data flow:**
```
Timetable (click row) → navigateTo("/task/{taskId}")
  → App.svelte routes to <TaskDetailView taskId={id} />
    → GET /api/tasks/{taskId}  →  task metadata (including thread_id)
    → GET /api/threads/{threadId}/messages  →  message history
    → Render: metadata header + MessageBubble list
```

**Empty state:** When `thread_id` is null (task hasn't executed yet), the metadata header renders normally but the message area shows a placeholder message indicating the task hasn't run yet.

**Error state:** When the task ID doesn't exist or is deleted, display a "Task not found" message with a link back to the Timetable.

## Existing Patterns

This design follows established patterns from the existing web UI:

- **Routing:** Hash-based routing in `packages/web/src/client/App.svelte` with `route.startsWith("/task/")` and param extraction via `route.split("/")[2]`. Identical to the `/line/{threadId}` pattern.

- **Message rendering:** `{#each messages as msg}` loop with `<MessageBubble>` component, same as `packages/web/src/client/views/LineView.svelte` lines 225-227. MessageBubble handles all roles (user, assistant, tool_call, tool_result, alert, system).

- **Polling:** 5-second `setInterval` with cleanup in `onDestroy`, matching Timetable.svelte, LineView.svelte, and all other views.

- **Status badges:** Color-coded status indicators (green/completed, emerald-pulse/running, red/failed, orange/pending, gray/cancelled) from `packages/web/src/client/views/Timetable.svelte`.

- **API route pattern:** `GET /api/tasks/:id` follows the same Hono route handler pattern as `GET /api/threads/:id` in `packages/web/src/server/routes/threads.ts`. Query by ID with `deleted = 0` filter, return 404 if not found.

- **Tokyo Metro aesthetic:** Consistent use of line colors, station motifs, and the design language established across all existing views.

No new patterns are introduced. All components follow existing conventions.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Task Detail API Endpoint

**Goal:** Add a `GET /api/tasks/:id` endpoint that returns a single task by ID.

**Components:**
- Route handler in `packages/web/src/server/routes/tasks.ts` — new GET endpoint querying by ID with `deleted = 0` guard, returning 404 for missing/deleted tasks
- Client API function in `packages/web/src/client/lib/api.ts` — `getTask(id)` helper

**Dependencies:** None (first phase)

**Covers:** task-detail-view.AC1.3, task-detail-view.AC1.4

**Done when:** `GET /api/tasks/:id` returns correct task for valid IDs, 404 for invalid/deleted IDs, and `api.getTask()` client function works
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: TaskDetailView Component and Routing

**Goal:** Create the task detail page and wire it into the app router.

**Components:**
- `packages/web/src/client/views/TaskDetailView.svelte` — new view component with task metadata header, message history (MessageBubble loop), empty state, error state, loading state, and 5-second polling
- `packages/web/src/client/App.svelte` — add `#/task/{taskId}` route conditional and TaskDetailView import

**Dependencies:** Phase 1 (API endpoint must exist)

**Covers:** task-detail-view.AC2.1, task-detail-view.AC2.2, task-detail-view.AC2.3, task-detail-view.AC2.4, task-detail-view.AC2.5, task-detail-view.AC3.1, task-detail-view.AC3.2

**Done when:** Navigating to `#/task/{taskId}` renders the task detail page with metadata header and message history; empty state shows for tasks without threads; error state shows for invalid task IDs; polling refreshes data
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Timetable Navigation and Scroll Fix

**Goal:** Make Timetable task rows clickable to navigate to task detail, and fix the scroll cutoff issue.

**Components:**
- `packages/web/src/client/views/Timetable.svelte` — add `onclick` handler on task rows calling `navigateTo("/task/${task.id}")`, `cursor: pointer` style, `stopPropagation` on the cancel button, and `overflow-y: auto` on the task list container

**Dependencies:** Phase 2 (TaskDetailView must exist to navigate to)

**Covers:** task-detail-view.AC1.1, task-detail-view.AC1.2, task-detail-view.AC4.1

**Done when:** Clicking a task row navigates to the task detail page; cancel button still works without triggering navigation; Timetable content scrolls instead of being cut off
<!-- END_PHASE_3 -->

## Additional Considerations

**Cron task history:** Cron tasks reuse the same `thread_id` across all runs, so the message history shows the full execution history (all runs interleaved). No run-boundary markers are added in v1 — messages appear in chronological order.

**`no_history` tasks:** Tasks with `no_history = 1` still create messages in the database. These messages are fully viewable in the task detail view. The `no_history` flag only affects LLM context assembly, not UI display.

**Long message histories:** No pagination in v1, consistent with LineView's approach. The message container scrolls naturally via `overflow-y: auto`.
