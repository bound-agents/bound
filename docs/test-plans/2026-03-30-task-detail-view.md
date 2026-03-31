# Task Detail View — Human Test Plan

**Feature:** Task Detail View with navigation, metadata header, message history, and scroll fix
**Implementation plan:** `docs/implementation-plans/2026-03-30-task-detail-view/`
**Date:** 2026-03-30

## Prerequisites

- Bound running locally: `bun packages/cli/src/bound.ts start` from the project root (or with `--config-dir` pointing to a valid config directory)
- Automated tests passing:
  - `bun test packages/web/src/server/__tests__/routes.integration.test.ts` (30 tests, 0 failures)
  - `bun test packages/web/src/client/__tests__/components.test.ts` (6 tests, 0 failures)
- At least one configured task exists (check `#/timetable` for rows). If no tasks exist, create one via `boundctl` or by configuring a cron schedule in `cron_schedules.json`.
- Browser open to `http://localhost:3000`

## Phase 1: Navigation (AC1.1 -- AC1.4)

| Step | Action | Expected |
|------|--------|----------|
| 1.1a | Navigate to `http://localhost:3000/#/timetable`. Hover the mouse over a task row. | Cursor changes to `pointer` over the entire row. |
| 1.1b | Click the task row body (not the cancel button). | URL hash changes to `#/task/{taskId}` (where `{taskId}` matches the row's ID). The TaskDetailView renders with the task's metadata header. |
| 1.2a | Navigate back to `#/timetable`. Locate a task with status `pending`, `running`, or `claimed` (one that shows a cancel button -- the X icon in the Actions column). | Cancel button (X icon) is visible in the Actions column for that row. |
| 1.2b | Click the cancel button (X icon). | URL hash remains `#/timetable` -- the page does NOT navigate to the task detail. The task's status updates to `cancelled` (row refreshes on next 5s poll or immediately). |
| 1.3a | Navigate to `#/task/{taskId}` for any valid task. Locate the "Back to Timetable" button at the top of the page. | A button reading "Back to Timetable" (with a left arrow) is visible in the header area. |
| 1.3b | Click the "Back to Timetable" button. | URL hash changes to `#/timetable`. The Timetable view renders. |
| 1.4a | Manually edit the URL to `http://localhost:3000/#/task/this-id-does-not-exist`. | An error state renders: large `!!` icon, heading "Task not found", explanatory text "This task may have been deleted or doesn't exist.", and a "Back to Timetable" button. |
| 1.4b | Click the "Back to Timetable" button in the error state. | URL hash changes to `#/timetable`. The Timetable view renders normally. |

## Phase 2: Task Metadata Header (AC2.1 -- AC2.5)

| Step | Action | Expected |
|------|--------|----------|
| 2.1a | Ensure tasks exist with statuses: `completed`, `running` (or `claimed`), `failed`, `pending`, `cancelled`. Navigate to each task's detail view. | Each status badge in the detail header uses the correct color: green for `completed`, emerald/teal for `running`/`claimed`, red for `failed`, orange for `pending`, gray for `cancelled`. |
| 2.1b | Compare each detail view badge to the same task's badge in the Timetable. | Colors match exactly between the Timetable row and the detail header. |
| 2.2a | Navigate to a cron task's detail view (e.g., one with trigger spec `0 9 * * MON`). | The header's first metadata row shows three elements: the status badge chip, the task type (e.g., "cron"), and the trigger spec (e.g., "0 9 * * MON" in monospace font). |
| 2.3a | Navigate to a task that has run at least once (`run_count > 0`, `last_run_at` is non-null). | The stats row shows: "Runs" with a number (e.g., "3" or "3 / 10" if `max_runs` is set); "Last run" in relative format (e.g., "5m ago", "2h ago"); "Next run" in relative format (e.g., "in 1h", "in 3d"). |
| 2.3b | Navigate to a task that has never run (`run_count = 0`, `last_run_at = null`). | "Runs" shows "0". "Last run" shows an em-dash character. "Next run" shows a relative time or em-dash. |
| 2.4a | Navigate to a task with status `failed` and a non-null `error` field. | A red-tinted banner appears below the stats row reading "Error:" followed by the error message text. The banner has a distinct background color (dark red tint), not just red text. |
| 2.4b | Navigate to a non-failed task (e.g., `completed`). | No error banner is visible. |
| 2.5a | Open the detail view for each of the six statuses: `pending`, `claimed`, `running`, `completed`, `failed`, `cancelled`. | For each status: the badge shows the correct icon (`..` for pending, `>>` for claimed/running, `OK` for completed, `!!` for failed, `XX` for cancelled); the layout does not break (no overflow, no missing elements). |

## Phase 3: Message History (AC3.1 -- AC3.2)

| Step | Action | Expected |
|------|--------|----------|
| 3.1a | Run or trigger a task that produces an agent loop (will generate user, assistant, tool_call, and tool_result messages). Navigate to its detail view. | The messages section below the header shows MessageBubble components in chronological order (oldest at top). |
| 3.1b | Verify each message role renders with appropriate styling. | `assistant` messages render as left-aligned bubbles. `tool_call` messages display tool invocation formatting. `tool_result` messages display tool result formatting. Messages appear in creation-time order. |
| 3.2a | Create or locate a task that has never run (`thread_id = null`, `run_count = 0`). Navigate to `#/task/{id}`. | The metadata header renders normally (status, type, trigger spec, run count of 0). Below the header, the message area displays: "This task hasn't run yet. Messages will appear here after the first execution." The text is muted/centered, not styled as an error. |

## Phase 4: Timetable Scroll Fix (AC4.1)

| Step | Action | Expected |
|------|--------|----------|
| 4.1a | Ensure enough tasks exist to exceed the viewport height (15-20+ tasks). Navigate to `#/timetable`. | The task board area shows a scrollbar (or is scrollable via mouse wheel / trackpad). The board header row ("Status", "ID", "Service", etc.) remains visible. |
| 4.1b | Scroll to the bottom of the task list. | All tasks are accessible. The last task row is fully visible when scrolled to the bottom. |
| 4.1c | Resize the browser window to a smaller height. | Scrolling still works. The header and footer of the timetable remain in position while the board rows scroll. |

## End-to-End: Task Lifecycle Drill-through

**Purpose**: Validates the complete user journey from Timetable overview through task detail inspection and back, covering the new navigation, metadata rendering, and message display in a single flow.

1. Navigate to `http://localhost:3000/#/timetable`.
2. Confirm the Timetable loads with at least one task row.
3. Identify a task that has run at least once (non-zero run count).
4. Click that task's row. Confirm navigation to `#/task/{taskId}`.
5. On the detail view, verify: status badge matches the Timetable badge color; type and trigger spec are visible; run count, last run (relative), and next run (relative) are displayed.
6. Scroll through the messages section. Confirm MessageBubble components render for the task's thread.
7. Click "Back to Timetable". Confirm return to `#/timetable`.
8. Identify a new/unrun task (or one with `thread_id = null`).
9. Click that task's row. Confirm the empty state message: "This task hasn't run yet. Messages will appear here after the first execution."
10. Click "Back to Timetable". Confirm return.
11. Edit the URL to `#/task/nonexistent-uuid-12345`. Confirm the error state with `!!` icon and "Task not found" heading.
12. Click the "Back to Timetable" button from the error state. Confirm return.

**Pass criteria**: All 12 steps complete without layout breakage, JavaScript errors, or navigation failures.

## End-to-End: Cancel Does Not Navigate

**Purpose**: Validates that the `stopPropagation()` on the cancel button correctly prevents the row click handler from firing, and the cancel action itself still works.

1. Navigate to `#/timetable`.
2. Locate a `pending` or `running` task with a visible cancel button (X icon).
3. Note the current URL hash (`#/timetable`).
4. Click the cancel button.
5. Confirm the URL hash is still `#/timetable`.
6. Wait for the 5-second poll (or manually refresh). Confirm the task's status changes to `cancelled`.
7. Confirm the cancel button is no longer visible for the now-cancelled task.

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 -- Row click navigates to `#/task/{id}` | Future: `e2e/task-detail.spec.ts` | Steps 1.1a-1.1b |
| AC1.2 -- Cancel button does not navigate | Future: `e2e/task-detail.spec.ts` | Steps 1.2a-1.2b |
| AC1.3 -- Back link navigates to `#/timetable` | Future: `e2e/task-detail.spec.ts` | Steps 1.3a-1.3b |
| AC1.4 -- Error state for nonexistent/deleted task | `routes.integration.test.ts`: 3 tests | Steps 1.4a-1.4b |
| AC2.1 -- Color-coded status badge | None (CSS) | Steps 2.1a-2.1b |
| AC2.2 -- Type and trigger spec display | None (template) | Step 2.2a |
| AC2.3 -- Relative time formatting | None (component-local) | Steps 2.3a-2.3b |
| AC2.4 -- Error banner on failed tasks | None (conditional CSS) | Steps 2.4a-2.4b |
| AC2.5 -- All six statuses render | `components.test.ts`: import smoke test | Step 2.5a |
| AC3.1 -- Message history display | None (DOM) | Steps 3.1a-3.1b |
| AC3.2 -- Empty state for null thread_id | None (DOM) | Step 3.2a |
| AC4.1 -- Timetable scroll fix | None (viewport) | Steps 4.1a-4.1c |
