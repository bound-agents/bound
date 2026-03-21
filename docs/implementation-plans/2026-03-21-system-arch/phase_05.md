# Bound System Architecture - Phase 5: Web Interface

**Goal:** Interactive web UI at localhost:3000 for chatting with the agent. Browser-based System Map, Line View (chat), Timetable (tasks), and Network Status views with real-time WebSocket updates.

**Architecture:** `@bound/web` package containing Hono API routes (threads, messages, files, status, cancel, sync endpoints), Bun.serve native WebSocket for real-time push, and a Svelte 5 SPA built via Vite. The web server runs alongside the agent on a single `Bun.serve` call, serving both API routes and static Svelte assets.

**Tech Stack:** Hono (HTTP API + serveStatic), Bun.serve WebSocket (native pub/sub), Svelte 5 + Vite (SPA), @testing-library/svelte (component tests), Playwright (E2E)

**Scope:** 8 phases from original design (phase 5 of 8)

**Codebase verified:** 2026-03-22 — Phase 1 provides DB/DI, Phase 4 provides agent loop for message processing.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### system-arch.AC3: Phased build order produces working vertical slices
- **system-arch.AC3.4 Success:** Phase 5 completes with a browser-based chat UI at localhost:3000

### system-arch.AC4: Testing strategy covers all packages with multi-instance sync validation
- **system-arch.AC4.5 Success:** Playwright E2E tests verify the web chat flow end-to-end

### Phase 5 Verification Criteria (derived from design "Done when")
- **V5.1:** Open browser at localhost:3000, see System Map with metro-themed SVG transit diagram
- **V5.2:** Create thread, send message, see agent response with tool calls in real-time via WebSocket
- **V5.3:** Cancel running agent loop via cancel button in Line View
- **V5.4:** Switch models via model selector in top bar
- **V5.5:** File uploads via drag-and-drop or attachment button (R-U25)
- **V5.6:** Host header validation rejects non-localhost requests (R-U4)

---

<!-- START_SUBCOMPONENT_A (tasks 1-4) -->
<!-- START_TASK_1 -->
### Task 1: @bound/web package setup with Hono + Svelte + Vite

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/vite.config.ts`
- Create: `packages/web/src/server/index.ts`
- Create: `packages/web/src/client/App.svelte`
- Create: `packages/web/src/client/main.ts`
- Create: `packages/web/index.html`
- Modify: `tsconfig.json` (root) — add web to references

**Step 1: Create package.json**

```json
{
  "name": "@bound/web",
  "version": "0.0.1",
  "description": "Hono HTTP API, Bun.serve WebSocket, and Svelte 5 metro-themed web UI for the Bound agent system",
  "type": "module",
  "main": "src/server/index.ts",
  "types": "src/server/index.ts",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@bound/shared": "workspace:*",
    "@bound/core": "workspace:*",
    "@bound/agent": "workspace:*",
    "hono": "^4.0.0"
  },
  "devDependencies": {
    "@sveltejs/vite-plugin-svelte": "^4.0.0",
    "svelte": "^5.0.0",
    "vite": "^6.0.0",
    "@testing-library/svelte": "^5.0.0"
  }
}
```

**Step 2: Create vite.config.ts for Svelte 5 SPA**

Configure Vite with `@sveltejs/vite-plugin-svelte`, output to `dist/client/`, and set up proxy for API requests to the Hono server during development.

**Step 3: Create minimal Svelte app skeleton**

`src/client/main.ts` — Mount Svelte app to `#app` div.
`src/client/App.svelte` — Shell with hash-based router and placeholder views.
`index.html` — Standard Vite HTML entry point.

**Step 4: Create server entry**

`src/server/index.ts` — Hono app creation and Bun.serve setup. Serve static assets from `dist/client/` via Hono's `serveStatic` middleware. Export the app for testing.

**Step 5: Verify**

Run: `bun install && cd packages/web && bun run build`
Expected: Vite builds Svelte SPA to dist/client/

**Step 6: Commit**

```bash
git add packages/web/ tsconfig.json bun.lockb
git commit -m "chore(web): initialize @bound/web with Hono + Svelte 5 + Vite"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Hono API routes

**Verifies:** system-arch.AC3.4

**Files:**
- Create: `packages/web/src/server/routes/threads.ts`
- Create: `packages/web/src/server/routes/messages.ts`
- Create: `packages/web/src/server/routes/files.ts`
- Create: `packages/web/src/server/routes/status.ts`
- Create: `packages/web/src/server/routes/tasks.ts`
- Create: `packages/web/src/server/routes/index.ts`
- Modify: `packages/web/src/server/index.ts` — mount routes

**Implementation:**

Each route file exports a Hono sub-app that gets mounted on the main app at `/api/...`:

**Threads routes (`/api/threads`):**
- `GET /api/threads` — List non-deleted threads for the default web user, ordered by last_message_at desc
- `POST /api/threads` — Create new thread (auto-generate UUID, set user_id from default_web_user, interface='web')
- `GET /api/threads/:id` — Get single thread
- `GET /api/threads/:id/status` — Activity status: is an agent loop running on this thread? Returns `{ active: boolean, state: AgentLoopState, model: string }`

**Messages routes (`/api/threads/:id/messages`):**
- `GET /api/threads/:id/messages` — List messages for thread, ordered by created_at
- `POST /api/threads/:id/messages` — Submit user message. Persist to DB. Emit `message:created`. Trigger agent loop.

**Files routes (`/api/files`):**
- `GET /api/files` — List files in `/home/user/` from files table
- `GET /api/files/*` — Get file content by path
- `POST /api/files/upload` — Upload file via multipart form data (R-U25). Write to `/home/user/uploads/` in files table. Return file path and metadata.

**Status routes (`/api/status`):**
- `GET /api/status` — System status: host info, uptime, active loops count
- `POST /api/cancel/:threadId` — Cancel running agent loop for a thread

**Tasks routes (`/api/tasks`):**
- `GET /api/tasks` — List tasks (filter by status via query params)

All routes use JSON request/response. Error responses use consistent `{ error: string, details?: object }` format with appropriate HTTP status codes.

**Testing:**
- Each route tested via Hono's built-in test utilities (create app, call `app.fetch(new Request(...))`)
- Test CRUD operations against a real SQLite database
- Test error cases (404 for unknown thread, 400 for invalid body)

Test file: `packages/web/src/server/__tests__/routes.test.ts` (integration — real Hono + real SQLite)

**Verification:**
Run: `bun test packages/web/`
Expected: All tests pass

**Commit:** `feat(web): add Hono API routes for threads, messages, files, status, and tasks`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: WebSocket handler for real-time updates

**Verifies:** system-arch.AC3.4

**Files:**
- Create: `packages/web/src/server/websocket.ts`
- Modify: `packages/web/src/server/index.ts` — integrate WebSocket

**Implementation:**

`packages/web/src/server/websocket.ts` — Bun.serve native WebSocket handler:

- `createWebSocketHandler(eventBus: TypedEventEmitter)` — Returns the WebSocket configuration for Bun.serve:
  ```typescript
  {
    open(ws) { /* subscribe to updates channel */ },
    message(ws, message) { /* handle client subscriptions */ },
    close(ws) { /* cleanup */ },
  }
  ```

- Subscribe to EventBus events and push to connected clients:
  - `message:created` → push `{ type: "message", data: message }` to clients subscribed to the thread
  - `task:completed` → push `{ type: "task_update", data: { taskId, status } }`
  - `file:changed` → push `{ type: "file_update", data: { path, operation } }`
  - `alert:created` → push `{ type: "alert", data: message }`

- Client subscription protocol: on connect, client sends `{ subscribe: [threadId1, threadId2] }`. Server tracks subscriptions per connection. Client can update subscriptions at any time.

- Integration with `Bun.serve`:
  ```typescript
  Bun.serve({
    port: 3000,
    fetch: app.fetch, // Hono handles HTTP
    websocket: createWebSocketHandler(eventBus), // Native WS
  });
  ```

  Upgrade HTTP to WebSocket for requests to `/ws` path.

**Testing:**
- Connect a WebSocket client, subscribe to a thread, emit message:created on EventBus, verify client receives the update
- Multiple clients subscribed to different threads receive only their updates

Test file: `packages/web/src/server/__tests__/websocket.test.ts` (integration)

**Verification:**
Run: `bun test packages/web/`
Expected: All tests pass

**Commit:** `feat(web): add WebSocket handler for real-time message push`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Svelte 5 SPA — System Map and Line View

**Verifies:** system-arch.AC3.4

**Files:**
- Create: `packages/web/src/client/views/SystemMap.svelte`
- Create: `packages/web/src/client/views/LineView.svelte`
- Create: `packages/web/src/client/views/Timetable.svelte`
- Create: `packages/web/src/client/views/NetworkStatus.svelte`
- Create: `packages/web/src/client/components/MessageBubble.svelte`
- Create: `packages/web/src/client/components/TopBar.svelte`
- Create: `packages/web/src/client/components/ModelSelector.svelte`
- Create: `packages/web/src/client/lib/api.ts`
- Create: `packages/web/src/client/lib/websocket.ts`
- Create: `packages/web/src/client/lib/router.ts`
- Modify: `packages/web/src/client/App.svelte` — add views and routing

**Implementation:**

Implement the metro-themed web UI per spec §11:

**`lib/api.ts`** — API client wrapping `fetch()` calls to `/api/...` endpoints. Typed responses.

**`lib/websocket.ts`** — WebSocket client that connects to `/ws`, manages subscriptions, and exposes a reactive store of incoming events.

**`lib/router.ts`** — Hash-based router (`/#/`, `/#/line/{threadId}`, `/#/timetable`, `/#/network`).

**`SystemMap.svelte`** — Hero view showing threads as metro lines. Each thread is a colored line with station dots for recent messages. SVG-based transit diagram per spec §11.2. Lines are colored using the 10-color metro palette. Click a line to navigate to its Line View.

**`LineView.svelte`** — Conversation view for a single thread. Shows messages as a timeline. User messages on one side, assistant on the other. Tool calls shown inline with expandable details. Real-time updates via WebSocket. Input box at bottom for sending messages. Cancel button visible when agent loop is active.

**`Timetable.svelte`** — Task monitoring view. Lists active/pending/recent tasks with status indicators. Per spec §11.4.

**`NetworkStatus.svelte`** — Cluster topology view showing connected hosts, sync status, and last sync times. Per spec §11.5.

**`TopBar.svelte`** — Persistent top bar with: app name, current view indicator, model selector dropdown, advisory count indicator.

**`ModelSelector.svelte`** — Dropdown to switch the active LLM model. Fetches available models from `/api/status`.

**Design system per spec §11.1:**
- 10-color metro line palette
- Dark background (`#1a1a2e`), light text
- SVG-based graphics for System Map
- Monospace font for code/tool output

**Testing:**
- Component tests using @testing-library/svelte for MessageBubble, TopBar, ModelSelector
- Verify MessageBubble renders different roles correctly (user, assistant, tool_call, tool_result, alert)

Test file: `packages/web/src/client/__tests__/components.test.ts` (unit — @testing-library/svelte)

**Verification:**
Run: `bun test packages/web/ && cd packages/web && bun run build`
Expected: Tests pass, Vite builds successfully

**Commit:** `feat(web): add Svelte 5 metro-themed SPA with System Map and Line View`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 5-6) -->
<!-- START_TASK_5 -->
### Task 5: Web server integration (Hono + WebSocket + static assets)

**Verifies:** system-arch.AC3.4

**Files:**
- Modify: `packages/web/src/server/index.ts` — complete integration
- Create: `packages/web/src/server/start.ts`

**Implementation:**

`packages/web/src/server/start.ts` — Complete web server startup:

1. Build Svelte SPA if not already built (check for dist/client/index.html)
2. Create Hono app with all API routes mounted
3. Add `serveStatic` middleware to serve built Svelte assets from `dist/client/`
4. Set up WebSocket handler
5. Start `Bun.serve` on configured port (default 3000)
6. Return server handle for graceful shutdown

The server serves:
- `/api/*` → Hono routes (JSON API)
- `/ws` → WebSocket upgrade
- `/*` → Static Svelte SPA files (with fallback to index.html for client-side routing)

Export `createWebServer(ctx: AppContext, agentLoopFactory): { start, stop }` for use by the CLI in Phase 7.

**Testing:**
- Start the server, fetch `/api/status`, verify JSON response
- Fetch `/` (root), verify HTML returned (Svelte SPA)
- Fetch `/api/threads`, verify empty array response

Test file: `packages/web/src/server/__tests__/integration.test.ts` (integration)

**Verification:**
Run: `bun test packages/web/`
Expected: All tests pass

**Commit:** `feat(web): integrate Hono API, WebSocket, and static asset serving`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Playwright E2E tests

**Verifies:** system-arch.AC4.5

**Files:**
- Create: `e2e/web-chat.spec.ts`
- Create: `e2e/playwright.config.ts`
- Modify: root `package.json` — add e2e script

**Implementation:**

`e2e/playwright.config.ts` — Playwright configuration:
- Base URL: `http://localhost:3000`
- Web server command: start the bound web server before tests
- Browser: chromium (headless)

`e2e/web-chat.spec.ts` — End-to-end web chat flow:

1. Navigate to `http://localhost:3000`
2. Verify System Map is displayed
3. Create a new thread (click "New Thread" button)
4. Verify Line View opens for the new thread
5. Type a message in the input box
6. Submit the message
7. Verify user message appears in the chat
8. Wait for agent response (with mock LLM backend)
9. Verify assistant response appears in the chat
10. Navigate back to System Map, verify the thread appears as a metro line

Note: These tests require a running server with a mock LLM backend. The test setup should configure the system with a mock backend that returns predictable responses.

Mark tests as skippable via `SKIP_E2E=1` env var.

**Verification:**
Run: `bunx playwright test`
Expected: E2E test passes (or skips if SKIP_E2E=1)

**Commit:** `test(e2e): add Playwright web chat flow test`
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_B -->
