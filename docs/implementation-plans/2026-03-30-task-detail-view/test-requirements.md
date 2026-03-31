# Task Detail View -- Test Requirements

Maps each acceptance criterion to automated tests and/or human verification steps.

---

## Summary

| AC | Automated | Human | Notes |
|----|-----------|-------|-------|
| AC1.1 | Playwright e2e | Manual | Row click navigates to `#/task/{id}` |
| AC1.2 | Playwright e2e | Manual | Cancel button does not trigger row navigation |
| AC1.3 | Playwright e2e | Manual | Back link navigates to `#/timetable` |
| AC1.4 | Integration + Playwright e2e | Manual | 404 from API; error state in UI |
| AC2.1 | -- | Manual | Color-coded status badge |
| AC2.2 | -- | Manual | Type and trigger spec display |
| AC2.3 | -- | Manual | Relative time formatting |
| AC2.4 | -- | Manual | Error banner on failed tasks |
| AC2.5 | Component import test | Manual | All six statuses render without error |
| AC3.1 | -- | Manual | Message history with all roles |
| AC3.2 | -- | Manual | Empty state for null `thread_id` |
| AC4.1 | -- | Manual | Scroll when content exceeds viewport |

---

## AC1: Navigation between Timetable and task detail

### AC1.1 -- Clicking a task row in Timetable navigates to `#/task/{taskId}`

**Automated: Playwright e2e**
- File: `e2e/task-detail.spec.ts`
- Test: Navigate to `#/timetable`, click a task row, assert `location.hash` equals `#/task/{expectedTaskId}` and the TaskDetailView content is visible.

**Human verification**
- Justification: Visual confirmation that the click target feels correct (full row is clickable, cursor changes to pointer, no dead zones).
- Steps:
  1. Start the app with at least one configured task (`bun packages/cli/src/bound.ts start`).
  2. Navigate to `#/timetable` in the browser.
  3. Hover over a task row -- confirm cursor changes to `pointer`.
  4. Click the task row.
  5. Confirm the URL hash changes to `#/task/{taskId}` and the task detail view renders.

---

### AC1.2 -- Clicking the cancel button on a task row does not trigger row navigation

**Automated: Playwright e2e**
- File: `e2e/task-detail.spec.ts`
- Test: Navigate to `#/timetable`, click the cancel button on a running/pending task row, assert `location.hash` remains `#/timetable` (does not change to `#/task/{id}`).

**Human verification**
- Justification: Confirms `stopPropagation()` works correctly in practice and the cancel action itself still fires.
- Steps:
  1. Start the app with at least one pending or running task.
  2. Navigate to `#/timetable`.
  3. Click the cancel button on a task row.
  4. Confirm the URL hash remains `#/timetable`.
  5. Confirm the task status updates (cancelled) -- the cancel action itself was not suppressed.

---

### AC1.3 -- "Back to Timetable" link on the task detail page navigates to `#/timetable`

**Automated: Playwright e2e**
- File: `e2e/task-detail.spec.ts`
- Test: Navigate directly to `#/task/{taskId}`, click the "Back to Timetable" button, assert `location.hash` equals `#/timetable`.

**Human verification**
- Justification: Visual confirmation the back link is visible and positioned correctly in the header area.
- Steps:
  1. Navigate to `#/task/{taskId}` for a valid task.
  2. Locate the "Back to Timetable" link in the header area.
  3. Click it.
  4. Confirm navigation returns to the Timetable view.

---

### AC1.4 -- Navigating to `#/task/{nonexistent-or-deleted-id}` shows error state with link back to Timetable

**Automated: Integration test (API layer)**
- File: `packages/web/src/server/__tests__/routes.integration.test.ts`
- Tests (Phase 1, Task 2):
  - `GET /api/tasks/{nonexistent-id}` returns HTTP 404 with `{ error: "Task not found" }`.
  - `GET /api/tasks/{deleted-task-id}` (task with `deleted = 1`) returns HTTP 404 with `{ error: "Task not found" }`.
  - `GET /api/tasks/{valid-id}` returns HTTP 200 with correct task data.
- Run: `bun test packages/web/src/server/__tests__/routes.integration.test.ts`

**Automated: Playwright e2e**
- File: `e2e/task-detail.spec.ts`
- Test: Navigate to `#/task/nonexistent-id-12345`, assert the error state element is visible with "Task not found" text, assert a "Back to Timetable" link is present. Click the link and assert navigation to `#/timetable`.

**Human verification**
- Justification: Visual confirmation the error state is styled appropriately (error icon, clear messaging, link back).
- Steps:
  1. Navigate to `#/task/this-id-does-not-exist` in the browser.
  2. Confirm an error state renders with "Task not found" text and the `!!` error icon.
  3. Confirm a "Back to Timetable" link is visible.
  4. Click the link and confirm navigation to `#/timetable`.

---

## AC2: Task metadata header

### AC2.1 -- Header displays task status with color-coded badge matching Timetable conventions

**Automated: None practical**
- Rationale: Color-coded badges are CSS-driven visual styling. Verifying the correct CSS class is applied would require DOM-level testing (jsdom or Playwright). A Playwright e2e test could assert the class name, but the meaningful verification is visual -- that the colors actually match between Timetable and TaskDetailView.

**Human verification**
- Justification: Badge colors are a visual design requirement. Automated class-name assertions do not verify the rendered color matches Timetable conventions.
- Steps:
  1. Create or ensure tasks exist with statuses: `completed`, `running`, `failed`, `pending`, `cancelled`.
  2. Open `#/timetable` and note the badge color for each status.
  3. Click each task row to navigate to its detail view.
  4. Confirm the status badge in the detail header uses the same color as the Timetable row.
  5. Specifically verify: green for completed, emerald-pulse for running/claimed, red for failed, orange for pending, gray for cancelled.

---

### AC2.2 -- Header displays task type and human-readable trigger specification

**Automated: None practical**
- Rationale: This is a data-binding and formatting concern in the Svelte template. The API returns the raw fields (verified by AC1.4 integration tests). Template rendering requires a DOM environment.

**Human verification**
- Justification: Confirms the type and trigger spec are rendered in a human-readable form and positioned correctly.
- Steps:
  1. Create a cron task with trigger spec `0 9 * * MON`.
  2. Navigate to `#/task/{id}`.
  3. Confirm the header displays the task type (e.g., "cron") and the trigger spec (e.g., "0 9 * * MON") as separate readable elements in the metadata row.
  4. Repeat with other task types if available (e.g., one-shot).

---

### AC2.3 -- Header displays run count, last run time, and next run time in relative format

**Automated: None practical**
- Rationale: Relative time formatting (`formatRelativeTime`) is a pure function inside the component, but it is not exported. It could be extracted and unit-tested, but the implementation plan keeps it component-local following existing patterns (Timetable does the same). The display of run count, last run, and next run is template-level.

**Human verification**
- Justification: Confirms relative time is displayed correctly (not raw ISO timestamps) and run count formatting is correct.
- Steps:
  1. Navigate to a task that has run at least once (non-null `last_run_at`, non-zero `run_count`).
  2. Confirm the header shows:
     - Run count as a number (e.g., "3" or "3 / 10" if max_runs is set).
     - Last run in relative format (e.g., "5m ago", "2h ago").
     - Next run in relative format (e.g., "in 1h", "in 3d").
  3. Navigate to a task that has never run (`run_count = 0`, `last_run_at = null`).
  4. Confirm last run shows an em-dash or equivalent "no data" indicator.

---

### AC2.4 -- Header displays error message prominently when task status is "failed"

**Automated: None practical**
- Rationale: This is a conditional CSS-styled element. The API returning the `error` field is covered by AC1.4 integration tests. The visual prominence is a design concern.

**Human verification**
- Justification: The error banner must be visually prominent (red background, readable text). This is a visual design requirement.
- Steps:
  1. Trigger a task failure (or manually insert a task with `status = 'failed'` and `error = 'Connection timeout after 30s'`).
  2. Navigate to `#/task/{id}`.
  3. Confirm a red-tinted error banner is visible below the stats row.
  4. Confirm the error banner displays "Error:" followed by the error message text.
  5. Confirm the banner is distinct from the rest of the header (colored background, not just text).

---

### AC2.5 -- Header renders correctly for all six task statuses

**Automated: Component import test**
- File: `packages/web/src/client/__tests__/components.test.ts`
- Test (Phase 2, Task 2): `TaskDetailView` component module imports without error. This verifies syntactic validity and that the component can be loaded by the bundler.
- Run: `bun test packages/web/src/client/__tests__/components.test.ts`
- Note: This is a smoke test, not a full rendering test. It catches syntax errors, broken imports, and module-level exceptions, but does not verify per-status rendering.

**Human verification**
- Justification: Each of the six statuses has a distinct badge class and icon. Verifying all six render correctly requires visual inspection or a Playwright matrix test.
- Steps:
  1. Ensure tasks exist (or are created) with each status: `pending`, `claimed`, `running`, `completed`, `failed`, `cancelled`.
  2. Navigate to the detail view for each task.
  3. For each, confirm:
     - The status badge renders with the correct icon (pending: `..`, claimed/running: `>>`, completed: `OK`, failed: `!!`, cancelled: `XX`).
     - The status badge renders with the correct color class.
     - The overall header layout does not break (no overflow, no missing elements).
  4. For the `failed` status specifically, confirm the error banner also renders (per AC2.4).

---

## AC3: Message history display

### AC3.1 -- Task's thread messages render chronologically via MessageBubble with all roles handled

**Automated: None practical**
- Rationale: MessageBubble rendering for all roles (user, assistant, tool_call, tool_result, alert, system) is an existing, proven component. The new code passes message data to it. Testing the data flow requires a DOM environment with the full Svelte component tree. The existing `api.listMessages()` function is already in production use by LineView.

**Human verification**
- Justification: Confirms the task detail view correctly fetches and renders the same messages that LineView would show, and that all message roles appear with correct styling.
- Steps:
  1. Run a task that produces messages of multiple roles (a typical agent loop will produce user, assistant, tool_call, and tool_result messages at minimum).
  2. Navigate to `#/task/{id}` for that task.
  3. Confirm messages appear in chronological order (oldest at top, newest at bottom).
  4. Confirm each message role renders with appropriate MessageBubble styling:
     - `user` messages: right-aligned or user-styled bubble.
     - `assistant` messages: left-aligned or assistant-styled bubble.
     - `tool_call` messages: tool invocation display.
     - `tool_result` messages: tool result display.
  5. If the task has run multiple times (cron), confirm all runs' messages appear interleaved chronologically.

---

### AC3.2 -- Task with null `thread_id` shows empty state message

**Automated: None practical**
- Rationale: This is a conditional template branch (`{#if !task.thread_id}`). The condition depends on the task data returned by the API. The API correctly returns `thread_id: null` for tasks that haven't run (verified by AC1.4 integration tests at the data level).

**Human verification**
- Justification: The empty state message text and styling must be visually confirmed.
- Steps:
  1. Create a new scheduled task that has not yet run (or ensure one exists with `thread_id = null` and `run_count = 0`).
  2. Navigate to `#/task/{id}`.
  3. Confirm the metadata header renders normally (status, type, trigger spec, run count of 0).
  4. Confirm the message area displays: "This task hasn't run yet. Messages will appear here after the first execution."
  5. Confirm the message is styled as a muted, centered empty state (not an error).

---

## AC4: Timetable scroll fix

### AC4.1 -- Timetable task list scrolls when content exceeds viewport height

**Automated: None practical**
- Rationale: Scroll behavior is a CSS layout concern that depends on the actual viewport height, flex container chain, and number of task rows. Playwright could theoretically test this (check scrollHeight > clientHeight, then scrollTo and verify), but it requires a specific number of tasks to exceed the viewport, making the test fragile and environment-dependent.

**Human verification**
- Justification: CSS scroll behavior must be verified in a real browser with real viewport constraints.
- Steps:
  1. Create enough tasks to exceed the viewport height (typically 15-20+ tasks, depending on screen size).
  2. Navigate to `#/timetable`.
  3. Confirm the task list area shows a scrollbar (or is scrollable via mouse wheel / trackpad).
  4. Scroll to the bottom of the task list.
  5. Confirm all tasks are accessible -- the last task row is fully visible when scrolled to the bottom.
  6. Confirm the Timetable header (if any) remains visible while the task list scrolls (sticky header behavior, if applicable).
  7. Resize the browser window to a smaller height and confirm scrolling still works.

---

## Test File Index

| File | Type | Phase | ACs Covered |
|------|------|-------|-------------|
| `packages/web/src/server/__tests__/routes.integration.test.ts` | Integration (bun:test) | Phase 1 | AC1.4 (API layer) |
| `packages/web/src/client/__tests__/components.test.ts` | Component import (bun:test) | Phase 2 | AC2.5 (smoke) |
| `e2e/task-detail.spec.ts` | E2e (Playwright) | Post-implementation | AC1.1, AC1.2, AC1.3, AC1.4 (UI layer) |

### Notes on test coverage

**Integration tests** (Phase 1) provide the strongest automated coverage. They verify the API contract: correct data for valid IDs, 404 for missing/deleted IDs. These run in-process against an in-memory SQLite database and are fast and deterministic.

**Component import test** (Phase 2) is a minimal smoke test. It verifies the TaskDetailView module can be loaded without errors but does not render the component or verify any visual behavior.

**Playwright e2e tests** are referenced in the Playwright config (`e2e/playwright.config.ts`) but no spec files exist yet. The `e2e/task-detail.spec.ts` file listed above would be created as a follow-up after all three implementation phases are complete. These tests would cover the navigation ACs (AC1.1-AC1.4) at the UI level. The Playwright infrastructure (config, test server script) is already in place.

**Human verification is required for all visual/styling ACs** (AC2.1-AC2.5, AC3.1-AC3.2, AC4.1). These involve color-coded badges, relative time formatting, error banner styling, message bubble rendering, and CSS scroll behavior -- all of which are meaningful only when visually inspected in a browser. The manual verification steps above are written to be reproducible by any developer with a running instance.
