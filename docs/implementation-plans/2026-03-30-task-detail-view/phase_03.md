# Task Detail View Implementation Plan — Phase 3

**Goal:** Make Timetable task rows clickable to navigate to the task detail view, and fix the scroll cutoff issue.

**Architecture:** Modify the existing `Timetable.svelte` component to add click-to-navigate on task rows, stop propagation on the cancel button, and fix the overflow CSS on the task list container.

**Tech Stack:** Svelte 5, TypeScript, existing router module

**Scope:** 3 phases from original design (phases 1-3). This is phase 3.

**Codebase verified:** 2026-03-30

**Key reference files:**
- `packages/web/src/client/views/Timetable.svelte` — the only file modified in this phase
- `packages/web/src/client/lib/router.ts` — `navigateTo()` function to import

---

## Acceptance Criteria Coverage

This phase implements and tests:

### task-detail-view.AC1: Navigation between Timetable and task detail
- **task-detail-view.AC1.1 Success:** Clicking a task row in Timetable navigates to `#/task/{taskId}`
- **task-detail-view.AC1.2 Success:** Clicking the cancel button on a task row does not trigger row navigation

### task-detail-view.AC4: Timetable scroll fix
- **task-detail-view.AC4.1 Success:** Timetable task list scrolls when content exceeds viewport height

---

<!-- START_TASK_1 -->
### Task 1: Add row click navigation and import navigateTo

**Verifies:** task-detail-view.AC1.1

**Files:**
- Modify: `packages/web/src/client/views/Timetable.svelte`

**Implementation:**

Two changes:

**1. Add import** — add `navigateTo` import alongside existing imports at the top of the `<script>` section:

```typescript
import { navigateTo } from "../lib/router";
```

Follow the pattern used in `SystemMap.svelte` and `LineView.svelte`.

**2. Add onclick handler to task row** — modify the `<div class="board-row">` element at line 191 to add an onclick handler and cursor style:

Current (line 191):
```svelte
<div class="board-row" class:row-running={task.status === "running" || task.status === "claimed"} class:row-failed={task.status === "failed"}>
```

Change to:
```svelte
<div class="board-row" class:row-running={task.status === "running" || task.status === "claimed"} class:row-failed={task.status === "failed"} onclick={() => navigateTo(`/task/${task.id}`)}>
```

Also add `cursor: pointer;` to the existing `.board-row` CSS rule (do NOT use inline styles — the codebase uses CSS classes exclusively):

```css
.board-row {
	/* existing properties... */
	cursor: pointer;
}
```

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

**Commit:** `feat(web): make Timetable task rows clickable for navigation`

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add stopPropagation on cancel button

**Verifies:** task-detail-view.AC1.2

**Files:**
- Modify: `packages/web/src/client/views/Timetable.svelte`

**Implementation:**

Modify the cancel button's onclick handler at line 211 to stop event propagation before calling `cancelTask()`:

Current (line 211):
```svelte
onclick={() => cancelTask(task.id)}
```

Change to:
```svelte
onclick={(e) => { e.stopPropagation(); cancelTask(task.id); }}
```

This prevents the click from bubbling up to the parent `<div class="board-row">` which would trigger navigation.

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

**Commit:** `fix(web): prevent cancel button click from triggering row navigation`

<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Fix Timetable scroll cutoff

**Verifies:** task-detail-view.AC4.1

**Files:**
- Modify: `packages/web/src/client/views/Timetable.svelte`

**Implementation:**

The `.board` container at line 340 has `overflow: hidden` which clips task rows that extend beyond the viewport. Change it to allow vertical scrolling.

Current CSS (line 340):
```css
overflow: hidden;
```

Change to:
```css
overflow-y: auto;
```

Additionally, the `.board` container needs a constrained height to enable scrolling. The parent layout uses flex (App.svelte's main/view-transition containers are flex column with `min-height: 0`). Add `flex: 1` and `min-height: 0` to the `.timetable` container to participate in the flex layout:

Check if `.timetable` already has flex properties. If not, add:
```css
.timetable {
	/* existing properties... */
	flex: 1;
	display: flex;
	flex-direction: column;
	min-height: 0;
	overflow: hidden;
}
```

And ensure `.board` can scroll within its flex container:
```css
.board {
	/* existing properties... */
	overflow-y: auto;
	flex: 1;
	min-height: 0;
}
```

The `min-height: 0` on both containers is critical — without it, flex children default to `min-height: auto` which prevents shrinking below content height, defeating the scroll behavior.

**Verification:**
Run: `bun run build`
Expected: Build succeeds

Manual verification: With many tasks, the board should scroll vertically instead of being cut off.

**Commit:** `fix(web): enable Timetable task list scrolling`

<!-- END_TASK_3 -->
