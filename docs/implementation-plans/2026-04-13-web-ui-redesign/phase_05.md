# Web UI Redesign — Phase 5: Timetable Redesign

**Goal:** Replace the raw data grid with a departure board header, DataTable with human-readable columns, smart sorting, and inline row expansion (replacing TaskDetailView).

**Architecture:** Rewrite Timetable.svelte to use shared components (SectionHeader, DataTable, StatusChip, LineBadge). Add departure board strip component. Remove TaskDetailView route.

**Tech Stack:** Svelte 5, shared components from Phase 1, enhanced task API from Phase 2

**Scope:** 8 phases from original design (phase 5 of 8)

**Codebase verified:** 2026-04-13

**Investigation findings:**
- Timetable.svelte: 551 lines, 8-column CSS Grid, polls `/api/tasks` every 5s.
- Status badges use monospace icons (OK, >>, !!, .., XX) with color-coded backgrounds.
- TaskDetailView.svelte: 454 lines, exists at `/task/:id` route. Shows task metadata + message history.
- App.svelte routing: Hash-based if/else chain, `/task/:id` route at line ~33.

---

## Acceptance Criteria Coverage

### ui-redesign.AC11: Departure board header
- **ui-redesign.AC11.1 Success:** Top strip shows next 3-5 scheduled tasks with compact LineBadge, name, countdown, and ON TIME/DELAYED/OVERDUE status

### ui-redesign.AC12: Task table with human-readable columns
- **ui-redesign.AC12.1 Success:** Table shows displayName instead of raw JSON trigger
- **ui-redesign.AC12.2 Success:** Table shows human-readable schedule instead of cron expression
- **ui-redesign.AC12.3 Success:** Table shows hostName instead of truncated site ID
- **ui-redesign.AC12.4 Success:** Default sort: status weight (Running > Failed > Pending > Cancelled > Completed), then next_run ascending

### ui-redesign.AC13: TaskDetailView replaced by inline expansion
- **ui-redesign.AC13.1 Success:** Clicking a row expands to show full task details (payload, history, thread link)
- **ui-redesign.AC13.2 Success:** `/task/:id` route is removed from App.svelte

---

<!-- START_TASK_1 -->
### Task 1: Create DepartureBoard component

**Verifies:** ui-redesign.AC11.1

**Files:**
- Create: `packages/web/src/client/components/DepartureBoard.svelte`

**Implementation:**

Compact header strip showing upcoming task departures.

Props:
- `tasks: EnhancedTask[]` — task list (with `displayName`, `schedule`, etc. from Phase 2 API)

Internal: Filter to pending tasks with `next_run_at`, sort by `next_run_at` ascending, take first 5.

For each task, compute status label:
- `"ON TIME"` — next_run_at is in the future
- `"DELAYED"` — next_run_at is in the past but status is still `pending`
- `"OVERDUE"` — last run was `failed`

Render: Dark inset panel (`background: var(--bg-primary)`, `border: 1px solid var(--bg-surface)`, `border-radius: 8px`, `padding: 12px`, `max-height: 120px`).

Each row: `LineBadge` (compact, color from task type mapping: cron→0, heartbeat→7, deferred→3, event→6) + task `displayName` + countdown to next_run + status label (color-coded: green/orange/red). Monospace font for countdown, `letter-spacing: 0.04em`.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

**Commit:** `feat(web): add DepartureBoard component`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create task sort utility with tests

**Verifies:** ui-redesign.AC12.4

**Files:**
- Create: `packages/web/src/client/lib/task-sort.ts`
- Create: `packages/web/src/client/lib/__tests__/task-sort.test.ts`

**Implementation:**

`task-sort.ts`:
- `STATUS_WEIGHT` map: `{ running: 0, failed: 1, pending: 2, claimed: 2, cancelled: 3, completed: 4 }`
- `export function sortTasks(tasks): Task[]` — primary sort by `STATUS_WEIGHT[task.status]` ascending, secondary by `next_run_at` ascending (null → end), tertiary by `last_run_at` descending

**Testing:**
- Running tasks sort before failed tasks
- Failed tasks sort before pending tasks
- Among pending tasks, soonest `next_run_at` comes first
- Null `next_run_at` sorts to end within same status group
- Cancelled/completed tasks always at bottom

**Verification:**
Run: `bun test packages/web/src/client/lib/__tests__/task-sort.test.ts`
Expected: All tests pass

**Commit:** `feat(web): add task sort utility with tests`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Rewrite Timetable.svelte

**Verifies:** ui-redesign.AC12.1, ui-redesign.AC12.2, ui-redesign.AC12.3, ui-redesign.AC12.4, ui-redesign.AC13.1

**Files:**
- Modify: `packages/web/src/client/views/Timetable.svelte` (full rewrite — 551 lines → ~250 lines)

**Implementation:**

Replace the custom grid with shared components.

**Remove**: The 8-column CSS grid, custom `.board-row` styling, monospace status icons (OK, >>, etc.), raw JSON trigger display, truncated host IDs.

**New structure**:

Import: `SectionHeader`, `StatusChip`, `LineBadge`, `DataTable` from `../components/shared`. Import `DepartureBoard` from `../components/DepartureBoard.svelte`. Import `sortTasks` from `../lib/task-sort`.

Data fetching: Keep existing `/api/tasks` polling. The enhanced API from Phase 2 provides `displayName`, `schedule`, `hostName`, `lastDurationMs`.

Layout:
1. `SectionHeader` with title "Timetable", subtitle "DEPARTURES & ARRIVALS", action area has filter dropdown + status filter chips.

**Status filter chips**: `let activeFilters = $state<Set<string>>(new Set())`. Render small toggle buttons for each status: Pending, Running, Failed, Cancelled. Clicking a chip toggles it in/out of `activeFilters`. When any filters are active, compute `filteredTasks = $derived(sortedTasks.filter(t => activeFilters.size === 0 || activeFilters.has(t.status)))` and pass to DataTable. Chips use StatusChip-like styling — colored outline when active, muted when inactive.
2. `DepartureBoard` component with filtered tasks.
3. `DataTable` with columns:
   - Status (100px): Render `StatusChip` from task status
   - Name (1fr): `task.displayName`
   - Type (100px): `LineBadge` compact + type label
   - Schedule (120px): `task.schedule`
   - Next Run (100px): relative time
   - Last Run (100px): relative time
   - Duration (80px): formatted `task.lastDurationMs`
   - Host (120px): `task.hostName`
   - Actions (70px): Cancel button / error badge

4. Row expansion via DataTable's `expandedContent` snippet: Show full payload JSON, execution history (run_count, consecutive_failures), associated thread link.

5. Separator between active (running/failed/pending) and inactive (cancelled/completed) tasks: Insert a muted "INACTIVE" divider row.

Sort: Apply `sortTasks()` to the task list before passing to DataTable.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

Run: `bun run build`
Expected: Build succeeds

**Commit:** `feat(web): rewrite Timetable with DepartureBoard and DataTable`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Remove TaskDetailView route

**Verifies:** ui-redesign.AC13.2

**Files:**
- Modify: `packages/web/src/client/App.svelte` (remove `/task/:id` route block and import)

**Implementation:**

In App.svelte routing section (~line 33), remove:
```svelte
{:else if route.startsWith("/task/")}
  <TaskDetailView taskId={route.split("/")[2]} />
```

Remove the `TaskDetailView` import at the top of the script section.

Do NOT delete `TaskDetailView.svelte` file yet — it may be referenced in tests. The file becomes dead code.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass. If `components.test.ts` imports TaskDetailView, it still works (file exists, just not routed).

Run: `bun run build`
Expected: Build succeeds (Vite tree-shakes unused import)

**Commit:** `refactor(web): remove TaskDetailView route in favor of Timetable inline expansion`
<!-- END_TASK_4 -->
