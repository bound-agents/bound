# Web UI Redesign — Phase 2: API Enhancements

**Goal:** Add new server-side API endpoints and enhance existing ones to support the redesigned UI views.

**Architecture:** Add a new `/api/memory` Hono sub-app for the memory graph endpoint, and enhance the existing `/api/threads` and `/api/tasks` routes with computed fields. Follow the existing `createXxxRoutes(db, ...)` → Hono sub-app pattern.

**Tech Stack:** Hono routes, bun:sqlite, bun:test

**Scope:** 8 phases from original design (phase 2 of 8)

**Codebase verified:** 2026-04-13

**Investigation findings:**
- Thread routes (`packages/web/src/server/routes/threads.ts`) already return all DB columns including `summary` via `SELECT *`. Client-side `Thread` interface in `api.ts` already has `summary`.
- Task routes (`packages/web/src/server/routes/tasks.ts`) return raw DB columns. No computed fields.
- No memory-related routes exist. Must create from scratch.
- Route registration in `packages/web/src/server/routes/index.ts` via `registerRoutes()`.
- Mounting in `packages/web/src/server/index.ts:86-92` via `app.route()`.
- `hosts` table has `host_name` column. PK is `site_id`.

---

## Acceptance Criteria Coverage

### ui-redesign.AC3: Memory graph API returns correct data
- **ui-redesign.AC3.1 Success:** `GET /api/memory/graph` returns nodes with key, value, tier, source, lineIndex, modifiedAt
- **ui-redesign.AC3.2 Success:** `GET /api/memory/graph` returns edges with sourceKey, targetKey, relation, modifiedAt
- **ui-redesign.AC3.3 Success:** Soft-deleted memories and edges are excluded
- **ui-redesign.AC3.4 Success:** Source provenance resolves to thread title and line index when available

### ui-redesign.AC4: Thread API returns enhanced fields
- **ui-redesign.AC4.1 Success:** `GET /api/threads` includes `messageCount` per thread
- **ui-redesign.AC4.2 Success:** `GET /api/threads` includes `lastModel` per thread

### ui-redesign.AC5: Task API returns enhanced fields
- **ui-redesign.AC5.1 Success:** `GET /api/tasks` includes `displayName` extracted from payload
- **ui-redesign.AC5.2 Success:** `GET /api/tasks` includes `schedule` in human-readable form
- **ui-redesign.AC5.3 Success:** `GET /api/tasks` includes `hostName` resolved from hosts table
- **ui-redesign.AC5.4 Success:** `GET /api/tasks` includes `lastDurationMs` computed from claimed_at and turn timestamps

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Create memory graph route

**Verifies:** ui-redesign.AC3.1, ui-redesign.AC3.2, ui-redesign.AC3.3, ui-redesign.AC3.4

**Files:**
- Create: `packages/web/src/server/routes/memory.ts`
- Modify: `packages/web/src/server/routes/index.ts` (add to registerRoutes return object)
- Modify: `packages/web/src/server/index.ts` (add app.route mount)

**Implementation:**

Create `createMemoryRoutes(db: Database): Hono` following the existing route pattern.

`GET /api/memory/graph` handler:

1. Query all non-deleted memories:
```sql
SELECT id, key, value, tier, source, created_at, modified_at FROM semantic_memory WHERE deleted = 0
```

2. Query all non-deleted edges:
```sql
SELECT source_key, target_key, relation, modified_at FROM memory_edges WHERE deleted = 0
```

3. Resolve source provenance to thread info. For each memory where `source` looks like a thread ID (UUID format), left-join against threads to get `title` and `color`:
```sql
SELECT sm.key, t.title as source_thread_title, t.color as line_index
FROM semantic_memory sm
LEFT JOIN threads t ON sm.source = t.id AND t.deleted = 0
WHERE sm.deleted = 0 AND sm.source IS NOT NULL
```

4. Build response matching `MemoryGraphResponse` interface from design doc. For nodes without a thread source (source is a task_id or "agent"), set `sourceThreadTitle: null`, `lineIndex: null`.

Register in `routes/index.ts`: add `memory: createMemoryRoutes(db)` to the return object.
Mount in `index.ts`: add `app.route("/api/memory", routes.memory)`.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

**Commit:** `feat(web): add memory graph API endpoint`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Test memory graph route

**Verifies:** ui-redesign.AC3.1, ui-redesign.AC3.2, ui-redesign.AC3.3, ui-redesign.AC3.4

**Files:**
- Create: `packages/web/src/server/__tests__/memory-graph.test.ts`

**Testing:**

Follow the existing server test pattern: create in-memory DB with `createDatabase(":memory:")`, apply schema, create `app` via `createWebApp()`, test with `app.fetch(new Request(...))`.

Tests must verify:
- **AC3.1**: Insert 3 semantic_memory rows (pinned, summary, default tiers), fetch `/api/memory/graph`. Verify response has `nodes` array with correct `key`, `value`, `tier`, `modifiedAt` for each.
- **AC3.2**: Insert 2 memory_edges rows, fetch endpoint. Verify `edges` array has correct `sourceKey`, `targetKey`, `relation`, `modifiedAt`.
- **AC3.3**: Insert a memory with `deleted = 1` and an edge with `deleted = 1`. Verify neither appears in response.
- **AC3.4**: Insert a memory with `source` matching a thread ID. Insert a thread with that ID, title "Test Thread", color 3. Verify the node has `sourceThreadTitle: "Test Thread"`, `lineIndex: 3`. Also test a memory with `source = "agent"` has `sourceThreadTitle: null`, `lineIndex: null`.

**Verification:**
Run: `bun test packages/web/src/server/__tests__/memory-graph.test.ts`
Expected: All tests pass

**Commit:** `test(web): add memory graph API tests`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Enhance threads route with computed fields

**Verifies:** ui-redesign.AC4.1, ui-redesign.AC4.2

**Files:**
- Modify: `packages/web/src/server/routes/threads.ts` (GET /api/threads handler, lines 19-42)

**Implementation:**

Replace the simple `SELECT * FROM threads` query with a query that joins computed fields:

```sql
SELECT t.*,
  (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.deleted = 0) as messageCount,
  (SELECT tu.model_id FROM turns tu WHERE tu.thread_id = t.id ORDER BY tu.id DESC LIMIT 1) as lastModel
  -- Note: turns.id is an autoincrement integer PK, so ORDER BY tu.id DESC correctly returns the most recent turn
FROM threads t
WHERE t.deleted = 0 AND t.user_id = ?
ORDER BY t.last_message_at DESC
```

The response type extends `Thread` with `messageCount: number` and `lastModel: string | null`.

**Verification:**
Run: `bun test packages/web`
Expected: Existing thread tests still pass (they test against `Thread` fields, computed fields are additive)

**Commit:** `feat(web): add messageCount and lastModel to threads API`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Test enhanced thread fields

**Verifies:** ui-redesign.AC4.1, ui-redesign.AC4.2

**Files:**
- Modify: `packages/web/src/server/__tests__/routes.integration.test.ts` (add new describe block)

**Testing:**

Add a `describe("GET /api/threads - enhanced fields")` block within the existing test file.

Tests must verify:
- **AC4.1**: Create a thread, insert 3 messages for it. Fetch `/api/threads`. Verify response includes `messageCount: 3`. Create a thread with 0 messages, verify `messageCount: 0`.
- **AC4.2**: Create a thread, insert a turn with `model_id = "opus"`. Fetch `/api/threads`. Verify `lastModel: "opus"`. Create a thread with no turns, verify `lastModel: null`.

**Verification:**
Run: `bun test packages/web/src/server/__tests__/routes.integration.test.ts`
Expected: All tests pass including new ones

**Commit:** `test(web): add enhanced thread field tests`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-7) -->
<!-- START_TASK_5 -->
### Task 5: Create task display utilities

**Verifies:** ui-redesign.AC5.1, ui-redesign.AC5.2

**Files:**
- Create: `packages/web/src/server/lib/task-display.ts`

**Implementation:**

Pure utility functions for extracting human-readable task info from raw task data:

`extractDisplayName(task: Task): string` — Parse `task.payload` JSON. For cron tasks, the display name is the cron key from the payload (e.g., `"research-scan"`). For deferred tasks, extract a description from the payload. For heartbeat, return `"heartbeat"`. Fallback: `task.type + " " + task.id.slice(0, 8)`.

`extractSchedule(task: Task): string | null` — Parse `task.trigger_spec`. For cron expressions, convert to human-readable (e.g., `"*/15 * * * *"` → `"every 15m"`, `"0 * * * *"` → `"hourly"`). For deferred tasks return `"one-time"`. For event tasks return `"on-event"`.

These are pure functions, easily testable without DB.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

**Commit:** `feat(web): add task display name and schedule utilities`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Enhance tasks route with computed fields

**Verifies:** ui-redesign.AC5.1, ui-redesign.AC5.2, ui-redesign.AC5.3, ui-redesign.AC5.4

**Files:**
- Modify: `packages/web/src/server/routes/tasks.ts` (GET /api/tasks handler, lines 11-38)

**Implementation:**

After fetching raw tasks, compute the additional fields:

1. `displayName` and `schedule`: call `extractDisplayName(task)` and `extractSchedule(task)` for each task.

2. `hostName`: Query hosts table to build a `Map<string, string>` of `site_id → host_name`:
```sql
SELECT site_id, host_name FROM hosts WHERE deleted = 0
```
For each task, resolve `task.claimed_by` to a host name.

3. `lastDurationMs`: For tasks with `claimed_at` and a `thread_id`, compute duration:
```sql
SELECT MAX(created_at) as last_turn_at FROM turns WHERE thread_id = ? AND task_id = ?
```
Duration = `Date.parse(lastTurnAt) - Date.parse(claimedAt)`. Return `null` if no turns exist or if `task.claimed_at` is null (task was never claimed). Guard: skip the turns query entirely when `claimed_at` is null.

Map each task to an enhanced object with the 4 new fields appended.

**Verification:**
Run: `bun test packages/web`
Expected: Existing task tests still pass

**Commit:** `feat(web): add computed fields to tasks API`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Test enhanced task fields and display utilities

**Verifies:** ui-redesign.AC5.1, ui-redesign.AC5.2, ui-redesign.AC5.3, ui-redesign.AC5.4

**Files:**
- Create: `packages/web/src/server/__tests__/task-display.test.ts`

**Testing:**

Test the pure utility functions:
- **AC5.1**: `extractDisplayName` with cron task payload containing key name → returns key name. Deferred task → returns description. Heartbeat → returns "heartbeat". Null/malformed payload → returns type + ID prefix fallback.
- **AC5.2**: `extractSchedule` with `"*/15 * * * *"` → `"every 15m"`. `"0 * * * *"` → `"hourly"`. Deferred type → `"one-time"`. Event type → `"on-event"`.

Test the route integration (add to existing task tests or create new block):
- **AC5.3**: Insert a task with `claimed_by` matching a host's `site_id`. Insert that host with `host_name = "polaris"`. Fetch `/api/tasks`. Verify `hostName: "polaris"`. Test task without claimed_by → `hostName: null`.
- **AC5.4**: Insert a task with `claimed_at` and a turn with `created_at` 5000ms later. Verify `lastDurationMs` is approximately 5000. Task without turns → `lastDurationMs: null`.

**Verification:**
Run: `bun test packages/web/src/server/__tests__/task-display.test.ts`
Expected: All tests pass

**Commit:** `test(web): add task display utility and enhanced field tests`
<!-- END_TASK_7 -->
<!-- END_SUBCOMPONENT_C -->

<!-- START_TASK_8 -->
### Task 8: Add client-side API function for memory graph

**Files:**
- Modify: `packages/web/src/client/lib/api.ts` (add interface and fetch function)

**Implementation:**

Add the `MemoryGraphResponse` interface and a fetch function following the existing `fetchJson<T>()` pattern:

```typescript
export interface MemoryGraphNode {
  key: string;
  value: string;
  tier: "pinned" | "summary" | "default" | "detail";
  source: string | null;
  sourceThreadTitle: string | null;
  lineIndex: number | null;
  modifiedAt: string;
}

export interface MemoryGraphEdge {
  sourceKey: string;
  targetKey: string;
  relation: string;
  modifiedAt: string;
}

export interface MemoryGraphResponse {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}
```

Add to the `api` export object:
```typescript
getMemoryGraph: () => fetchJson<MemoryGraphResponse>("/api/memory/graph"),
```

**Verification:**
Run: `tsc -p packages/web --noEmit` (or `bun run build`)
Expected: No type errors

**Commit:** `feat(web): add client-side memory graph API function`
<!-- END_TASK_8 -->

<!-- START_TASK_9 -->
### Task 9: Verify all tests pass and build succeeds

**Files:** No new files

**Verification:**
Run: `bun test packages/web`
Expected: All tests pass including new memory graph and task display tests

Run: `bun run build`
Expected: Build succeeds

**Commit:** No commit (verification only)
<!-- END_TASK_9 -->
