# Task Detail View Implementation Plan — Phase 1

**Goal:** Add a `GET /api/tasks/:id` endpoint that returns a single task by ID, and a corresponding `getTask()` client API function.

**Architecture:** New route handler added to the existing `packages/web/src/server/routes/tasks.ts` file, following the identical pattern from `GET /api/threads/:id` in `threads.ts`. Client function added to the existing API module. Route mounting already exists — no changes needed to `index.ts`.

**Tech Stack:** Hono (server routing), bun:sqlite (database), TypeScript, Svelte client API module

**Scope:** 3 phases from original design (phases 1-3). This is phase 1.

**Codebase verified:** 2026-03-30

**Testing reference files:**
- `packages/web/src/server/__tests__/routes.integration.test.ts` — API endpoint testing pattern
- `packages/web/src/server/__tests__/integration.test.ts` — app setup pattern

---

## Acceptance Criteria Coverage

This phase provides the API foundation for:

### task-detail-view.AC1.3: Navigation between Timetable and task detail
- **task-detail-view.AC1.3 Success:** "Back to Timetable" link on the task detail page navigates to `#/timetable`

### task-detail-view.AC1.4: Navigation between Timetable and task detail
- **task-detail-view.AC1.4 Failure:** Navigating to `#/task/{nonexistent-or-deleted-id}` shows error state with link back to Timetable

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Add GET /:id route handler to tasks.ts

**Verifies:** task-detail-view.AC1.4 (API foundation — returns 404 for invalid/deleted IDs)

**Files:**
- Modify: `packages/web/src/server/routes/tasks.ts` (add new route handler after existing endpoints)

**Implementation:**

Add a `GET /:id` route handler to the existing `createTasksRoutes` function. Follow the exact pattern from `packages/web/src/server/routes/threads.ts:91-118`:

```typescript
app.get("/:id", (c) => {
	try {
		const { id } = c.req.param();
		const task = db
			.query("SELECT * FROM tasks WHERE id = ? AND deleted = 0")
			.get(id) as Record<string, unknown> | null;

		if (!task) {
			return c.json({ error: "Task not found" }, 404);
		}

		return c.json(task);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return c.json({ error: "Failed to get task", details: message }, 500);
	}
});
```

Key details:
- Place this handler BEFORE the `POST /:id/cancel` route to avoid route conflicts (Hono matches in registration order)
- Use `deleted = 0` guard (soft-delete invariant)
- `.get()` returns `null` when no row found (bun:sqlite behavior)
- Error response structure matches existing pattern: `{ error: string, details?: string }`

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

**Commit:** `feat(web): add GET /api/tasks/:id endpoint`

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add integration tests for GET /api/tasks/:id

**Verifies:** task-detail-view.AC1.4 (404 behavior for non-existent and deleted tasks)

**Files:**
- Modify or Create: `packages/web/src/server/__tests__/routes.integration.test.ts` (add new describe block)

**Testing:**

Add a `describe("GET /api/tasks/:id")` block to the existing routes integration test file. Follow the existing test setup pattern that uses `createDatabase(":memory:")`, `applySchema(db)`, and `createApp(db, eventBus)`.

Tests must verify:
- **task-detail-view.AC1.4 — valid task ID:** Insert a task row directly via SQL, fetch `GET /api/tasks/{id}`, assert 200 with correct task data returned
- **task-detail-view.AC1.4 — non-existent ID:** Fetch `GET /api/tasks/nonexistent-id`, assert 404 with `{ error: "Task not found" }`
- **task-detail-view.AC1.4 — deleted task:** Insert a task with `deleted = 1`, fetch by its ID, assert 404 with `{ error: "Task not found" }`

Test setup note: Insert test tasks directly via `db.run()` SQL statements. The tasks table requires these NOT NULL columns: `id`, `type`, `status`, `trigger_spec`, `created_at`, `modified_at`. Example:

```typescript
db.run(
	`INSERT INTO tasks (id, type, status, trigger_spec, created_at, modified_at, deleted)
	 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	["task-1", "cron", "pending", "0 9 * * MON", new Date().toISOString(), new Date().toISOString(), 0]
);
```

**Verification:**
Run: `bun test packages/web/src/server/__tests__/routes.integration.test.ts`
Expected: All new tests pass, existing tests unaffected

**Commit:** `test(web): add integration tests for GET /api/tasks/:id`

<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add getTask() client API function

**Verifies:** task-detail-view.AC1.3 (client can fetch task data to render detail view with back link)

**Files:**
- Modify: `packages/web/src/client/lib/api.ts` (add new method to api object)

**Implementation:**

First, add a local `Task` interface to `api.ts`, following the same pattern as the existing local `Thread` and `Message` interfaces. Place it after the `Message` interface. Include only the fields the UI needs:

```typescript
interface Task {
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
```

Then add a `getTask` method to the API object, following the exact pattern from `getThread()` at lines 50-52:

```typescript
async getTask(id: string): Promise<Task> {
	return fetchJson(`/api/tasks/${id}`);
},
```

Do NOT import `Task` from `@bound/shared`. The established pattern in `api.ts` is to define all types locally (`Thread`, `Message`, `ApiError`). This keeps the client module self-contained and avoids pulling in server-side type unions the client doesn't need.

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

**Commit:** `feat(web): add getTask() client API function`

<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
