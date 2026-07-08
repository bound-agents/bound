# Web and Platform Interfaces

This document covers the `@bound/web` and `@bound/platforms` packages. The web package provides a local HTTP/WebSocket API server and a Svelte single-page application with a Tokyo Metro-inspired visual design (Nunito Sans + IBM Plex Mono typography, 10-line color palette). The platforms package connects the agent system to external messaging platforms (Discord, and future connectors) via a relay-based intake pipeline and cluster-wide leader election.

## Table of Contents

1. [@bound/web Server](#boundweb-server)
   - [Server Bootstrap](#server-bootstrap)
   - [Host Header Validation](#host-header-validation)
   - [API Route Reference](#api-route-reference)
   - [WebSocket Handler](#websocket-handler)
2. [@bound/web Client](#boundweb-client)
   - [Entry Point and Routing](#entry-point-and-routing)
   - [Views](#views)
   - [Components](#components)
   - [API Client](#api-client)
   - [WebSocket Client](#websocket-client)
3. [@bound/platforms](#boundplatforms)
   - [PlatformMcpRegistry](#platformmcpregistry)
   - [PlatformLeaderElection](#platformleaderelection)
   - [Discord MCP Server](#discord-mcp-server)
   - [Connector Handles and the connector Tool](#connector-handles-and-the-connector-tool)
   - [Webhook Ingress](#webhook-ingress)

---

## @bound/web Server

### Server Bootstrap

`createWebServer` in `packages/web/src/server/start.ts` is the top-level entry point for the server. It accepts a `Database`, a `TypedEventEmitter`, and a required `WebServerConfig` and returns a `WebServer` handle with `start`, `stop`, and `address` methods.

```ts
interface WebServerConfig {
  port?: number;            // default: 3001
  host?: string;            // default: "localhost"
  hostName?: string;
  operatorUserId: string;   // required
  models?: ModelsConfig;
  siteId?: string;
  statusForwardCache?: Map<string, StatusForwardPayload>;
  activeLoops?: Set<string>;
}

interface WebServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  address(): string;
}
```

The server is launched with `Bun.serve` and binds to `localhost` by default. Set `WEB_BIND_HOST=0.0.0.0` for hub nodes that must accept external spoke connections; the companion sync server (a separate `Bun.serve` on a different port) uses `BIND_HOST`. The `fetch` handler intercepts upgrade requests arriving on the `/ws` path and hands them to the Bun WebSocket subsystem; all other requests are forwarded to the Hono application. Stopping the server calls `Bun.Server.stop(true)`, which closes all active connections.

The SPA is embedded into the compiled binary via `scripts/embed-assets.ts`. At runtime, `createWebApp` attempts to import the `embedded-assets` module; if embedded assets are present they are served directly from in-memory byte arrays, so `dist/client/index.html` does not need to exist on disk. If no embedded assets are found, the server falls back to `serveStatic` from `dist/client/`.

### Host Header Validation

A middleware registered on `"*"` runs before every API handler. It reads the `Host` request header, strips any port suffix, and checks the hostname against an allowlist:

```
localhost
127.0.0.1
[::1]
```

Any request whose `Host` header resolves to a hostname not in that list is rejected with `400 Bad Request` and the JSON body `{ "error": "Invalid Host header" }`. Requests with no `Host` header pass through unchanged.

The middleware is mounted globally on the web app (`app.use("*", ...)`), so it runs for every route on this (web/API) server. Neither Ed25519-authenticated sync traffic nor webhook ingress is affected: both are served by a separate sync server (`createSyncServer`) on its own port (`/sync/ws` and `/webhook/:name`), which has its own binding and does not share this middleware.

Host header validation is the primary mechanism that prevents the local API from being reachable by remote callers via DNS rebinding or forwarded proxies.

### API Route Reference

All routes are mounted under `/api` and registered in `packages/web/src/server/routes/`. Static SPA assets are served after API routes so the API always takes precedence.

#### Threads — `/api/threads`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/threads` | List non-deleted threads for the configured `operatorUserId` (resolved from the allowlist's `default_web_user`), ordered by `last_message_at` descending. Each row is enriched with `messageCount`, `lastModel`, and `hasRunningTask`. By default, threads with zero non-deleted `role='user'` messages are hidden from the directory to reduce clutter from task-only / system-only threads; pass `?include_empty=true` to include them. |
| POST | `/api/threads` | Create a new thread. |
| GET | `/api/threads/:id` | Fetch a single thread by ID. |
| GET | `/api/threads/:id/status` | Fetch the current agent status for a thread. |
| GET | `/api/threads/:id/context-debug` | Fetch per-turn context-debug records for a thread (for the debug panel). |

**GET /api/threads** — Optional query param `?include_empty=true` disables the default filter that hides threads with no user messages (evaluated via an `EXISTS` correlated subquery against `messages` with `role='user' AND deleted=0`). Response: `Thread[]`.

**POST /api/threads** — No request body required. Inserts a new row with `interface = "web"`, `host_origin = "localhost:3000"`, a `color` cycling from the last thread's value (mod 10), and an empty `title`. The row is owned by the configured `operatorUserId`. Response `201`: `Thread`.

**GET /api/threads/:id** — Response `200`: `Thread`. Response `404`: `{ "error": "Thread not found" }`.

**GET /api/threads/:id/status** — Verifies the thread exists, checks for a running task, and merges any forwarded status from delegated loops. Returns `{ active: boolean; state: string | null; detail: string | null; tokens: number; model: string | null }`. When the thread has a delegated loop running on a remote host, `state` reflects the forwarded status from `StatusForwardPayload` events cached in `statusForwardCache`. Response `200`:

```ts
{
  active: boolean;
  state: string | null;   // e.g. "thinking", "tool_call", "running", or null
  detail: string | null;  // forwarded detail from delegated loop, or null
  tokens: number;         // forwarded token count from delegated loop, or 0
  model: string | null;
}
```

The `Thread` shape:
```ts
interface Thread {
  id: string;
  user_id: string;
  interface: "web" | "discord" | "mcp";
  host_origin: string;
  color: number;           // 0–9, index into a 10-color palette
  title: string;
  summary: string | null;
  created_at: string;      // ISO 8601
  last_message_at: string; // ISO 8601
}
```

#### Messages — `/api/threads`

Message routes are also mounted at `/api/threads` and share path parameters with the thread routes.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/threads/:threadId/messages` | List all messages in a thread, ordered by `created_at` ascending. |
| POST | `/api/threads/:threadId/messages` | Post a new user message to a thread. |

**GET /api/threads/:threadId/messages** — Verifies the thread exists first. Response `200`: `Message[]`.

**POST /api/threads/:threadId/messages** — Request body: `{ content: string, file_ids?: string[], model_id?: string }`. Content is capped at 512 KB; up to 20 attached files have their stored contents (or a binary-metadata placeholder) appended to the message body. If `model_id` is provided, it is stored as `threads.model_hint`. Inserts a message with `role = "user"` and emits a `message:created` event on the event bus (which fans the message out to all subscribed WebSocket clients). Response `201`: `Message`.

Two additional redaction endpoints live on the same route group:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/threads/:threadId/messages/:messageId/redact` | Redact a single message. |
| POST | `/api/threads/:threadId/redact` | Redact an entire thread (messages + derived memories). |

The `Message` shape:
```ts
interface Message {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  model_id: string | null;
  tool_name: string | null;
  created_at: string;   // ISO 8601
  modified_at: string;  // ISO 8601
  host_origin: string;
}
```

#### Files — `/api/files`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/files` | List all non-deleted files, ordered by `created_at` descending. Response rows have `content` stripped. |
| GET | `/api/files/download?path=…` | Download raw file bytes with MIME type inferred from extension and a `Content-Disposition` attachment header. |
| GET | `/api/files/*` | Fetch a single file (metadata + content) by its path (the wildcard is the file path stripped of the `/api/files/` prefix). |
| POST | `/api/files/upload` | Upload a new file via `multipart/form-data`. |

**GET /api/files** — Response `200`: `AgentFile[]` with each row's `content` field removed.

**GET /api/files/*** — The path after `/api/files/` is used as the lookup key in the `files` table. Response `200`: `AgentFile`. Response `404`: `{ "error": "File not found" }`.

**POST /api/files/upload** — Expects `multipart/form-data` with a `file` field. Text-typed files are stored decoded, binary files as base64; size is capped at `MAX_FILE_STORAGE_BYTES`. The file is stored at `/home/user/uploads/<sanitized-filename>` with `created_by = "default_web_user"`. Response `201`: `AgentFile`.

#### Status — `/api/status`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Return host uptime and active loop count. |
| GET | `/api/status/network` | Return the `hosts` table, the hub `cluster_config` value, the local `site_id`, and per-peer sync state. |
| GET | `/api/status/models` | Return all cluster-wide models (local and remote). |
| POST | `/api/status/cancel/:threadId` | Cancel the agent loop running on the given thread. |

**GET /api/status** — Reads `process.uptime()` and counts tasks with `status = 'running'`. Response `200`:
```json
{
  "host_info": {
    "uptime_seconds": 3621,
    "active_loops": 2
  }
}
```

**GET /api/status/models** — Returns all models visible across the cluster. Local models come from `modelsConfig`; remote models are read from the `hosts` table (excluding the local host by `site_id`). A remote model is annotated `"offline?"` if the host's `online_at` timestamp is more than 5 minutes old. Response `200`:
```ts
{
  models: Array<{
    id: string;
    provider: string;        // "remote" for relay-sourced models
    host: string;
    via: "local" | "relay";
    status: "local" | "online" | "offline?";
  }>;
  default: string;
}
```
The same model ID may appear multiple times if it is available on more than one host — each host gets a separate entry.

**POST /api/status/cancel/:threadId** — Verifies the thread exists, persists a cancellation system message, then emits `agent:cancel` with `{ thread_id }` on the event bus so the agent loop can observe the signal and stop. If the thread has an active delegation, a `cancel` relay is written to `relay_outbox` targeting the remote host. Response `200`:
```json
{
  "cancelled": true,
  "thread_id": "<uuid>"
}
```

#### Tasks — `/api/tasks`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List tasks, with an optional `status` query parameter filter. |
| GET | `/api/tasks/:id` | Fetch a single task row. |
| POST | `/api/tasks/:id/cancel` | Mark a `pending`/`running`/`claimed` task as `cancelled`. |

**GET /api/tasks** — Accepts an optional `?status=` query parameter (`pending`, `running`, `completed`, `failed`). Returns all non-deleted tasks ordered by `created_at` descending, enriched with `displayName`, `schedule`, `hostName`, and `lastDurationMs`. Response `200`: `Task[]`.

#### Memory — `/api/memory`

Routes under `/api/memory` back the memory-graph view (e.g. `GET /api/memory/graph`). They return the nodes/edges rendered by the client's `MemoryGraph` component.

#### Advisories — `/api/advisories`

Routes under `/api/advisories` back the advisory view and the TopBar advisory-count badge (`GET /api/advisories/count`).

#### Metrics — `/api/metrics`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/metrics?from=&to=` | Aggregated observability metrics for the dashboard. |

**GET /api/metrics** — Required query params: `from` and `to` (ISO 8601 date strings). Returns a `MetricsResponse` with three sections:

- **tokens**: per-model token/cost breakdown, a `costByModelTimeline` (hourly buckets for ranges ≤2 days, daily otherwise), and `totals` carrying `tokens_in`, `tokens_out`, `cache_read`, `cache_write`, `cost_usd`, and `error_count`. Each `costByModelTimeline` row carries the four token classes (`tokens_in`, `tokens_out`, `cache_read`, `cache_write`) plus matching per-component cost fields (`cost_input_usd`, `cost_output_usd`, `cost_cache_read_usd`, `cost_cache_write_usd`); the four `cost_*_usd` fields are recomputed at query time from current `model_backends.json` pricing and will not always sum exactly to the persisted `cost_usd` after a price change. When pricing is missing for a model, the route falls back to a proportional split of `cost_usd` weighted by the four token counts.
- **relay**: per-host latency aggregates (avg + P95), success/failure/expired counts, recent cycles (last 50), and totals with success rate.
- **context**: `totals.last_cache_hit_rate` (the cache hit rate of the most recent turn in the range with `tokens_cache_read + tokens_in > 0`, or `0` when no qualifying turn exists — chosen so the dashboard card surfaces "is caching effective right now" rather than a window-averaged ratio that masks current behavior), budget pressure count, average truncated tokens, and a timeline of cache hit rate / budget pressure / context utilization.

All queries filter on `turns.deleted = 0`. Relay metrics come from the local-only `relay_cycles` table. The `to` parameter is clamped to the current time if it's in the future. Timeline bucketing switches from daily to hourly when the requested range is ≤48 hours.

The `MetricsResponse` type is exported from `packages/web/src/server/routes/metrics.ts`. The route factory signature is `createMetricsRoutes(db, backends?: BackendPricing[])`; `BackendPricing` is also exported from `packages/web/src/server/routes/metrics.ts` (and re-exported from `routes/index.ts`, `server/index.ts`, `server/start.ts`) and is intentionally local to `@bound/web` rather than imported from `@bound/agent` to avoid pulling agent code into the web package. The CLI populates it from `modelBackends.backends` at `createWebServer()` call time in `packages/cli/src/commands/start/server.ts`.

#### Webhook Ingress — `/webhook/:name`

Webhook ingestion is **not** served by the web/API server (port 3001). External services deliver events to `POST /webhook/:name` on the **sync** server (port 3000, alongside `/sync/ws`); see [Webhook Ingress](#webhook-ingress) below for the full flow. The route lives there because the handler writes a `relay_inbox` row and emits on the same eventBus the scheduler listens to. Peer-to-peer relay traffic (Ed25519-signed sync) also runs on that server at `/sync/ws`.

#### Error Shape

All routes return errors in the same shape:
```json
{
  "error": "Human-readable description",
  "details": "optional underlying message"
}
```

---

### WebSocket Handler

The WebSocket handler is created by `createWebSocketHandler` in `packages/web/src/server/websocket.ts`. It takes the shared `TypedEventEmitter` and returns a Bun-compatible `websocket` configuration object with `open`, `message`, and `close` callbacks.

#### Connection Lifecycle

- **open** — Registers a new `ClientConnection` keyed on the `WebSocket` object. Each connection starts with an empty subscription set.
- **message** — Parses the incoming JSON frame. Accepts two optional fields:
  - `subscribe: string[]` — adds each thread ID to the connection's subscription set
  - `unsubscribe: string[]` — removes each thread ID from the subscription set

  Non-string messages and unparseable frames are silently dropped.
- **close** — Removes the connection from the client map.

#### Subscription Protocol

Clients control which threads they receive updates for by sending subscription control frames:

```json
{ "subscribe": ["<thread-id-1>", "<thread-id-2>"] }
```

```json
{ "unsubscribe": ["<thread-id-1>"] }
```

Both fields may appear in the same frame. There is no acknowledgement response from the server.

#### Server-Push Event Types

The handler listens to six event bus events and pushes corresponding frames to connected clients.

| Event bus event | WS frame type | Routing | Payload |
|----------------|---------------|---------|---------|
| `message:created` | `"message:created"` | Thread subscribers only | The full message object from the database |
| `message:broadcast` | `"message:created"` | Thread subscribers only | Same as above; used to re-emit assistant responses to WS clients without re-triggering the agent-loop handler |
| `task:completed` | `"task_update"` | All connected clients | `{ taskId, status: "completed" }` |
| `file:changed` | `"file_update"` | All connected clients | `{ path, operation }` where operation is `"created"`, `"modified"`, or `"deleted"` |
| `alert:created` | `"alert"` | Thread subscribers only | The full alert message object |
| `context:debug` | `"context:debug"` | Thread subscribers only | `{ turn_id, debug }` — context-budget breakdown for the debug panel |

All frames follow the envelope:
```json
{
  "type": "<event-type>",
  "data": { ... }
}
```

Only clients whose connection `readyState` equals `WebSocket.OPEN` (numeric `1`) receive frames; stale connections are skipped but not explicitly removed here — that happens on `close`.

---

## @bound/web Client

The client is a Svelte 5 single-page application built with Vite and embedded into the compiled binary. In development, assets can also be served from `dist/client/` via the static fallback.

### Entry Point and Routing

`App.svelte` is the root component. It mounts a single `TopBar` across the top and renders a view in the `<main>` area below it.

Routing is hash-based. `App.svelte` owns a local `$state` `route` that is initialised from `window.location.hash` and updated on every `hashchange` event. The helper in `packages/web/src/client/lib/router.ts` exports a `navigateTo(route)` function that sets `window.location.hash` (and a `currentRoute` writable store, currently unused by `App.svelte`).

| Hash | View rendered |
|------|---------------|
| `#/` or empty | `SystemMap` |
| `#/line/<thread-id>` | `LineView` with the thread ID extracted from the path segment |
| `#/timetable` | `Timetable` |
| `#/network` | `NetworkStatus` |
| `#/advisories` | `AdvisoryView` |
| `#/files` | `FilesView` |
| Any other value | `SystemMap` (fallback) |

### Views

#### SystemMap

`views/SystemMap.svelte` is the landing view. On mount it calls `api.listThreads()` (polling every 5 s) and in parallel fetches `/api/threads/:id/status` for each thread to populate per-line status dots.

The view is a split panel: a resizable left column renders a `ThreadList` (with a search box and a "+ New Line" button), and the right column renders a `MemoryGraph` keyed by the hovered thread. Thread color is taken from `thread.color` and resolved through the Tokyo Metro 10-color palette in `lib/metro-lines.ts` (Ginza orange, Marunouchi red, Hibiya silver, Tozai sky blue, Chiyoda green, Yurakucho gold, Hanzomon purple, Namboku emerald, Fukutoshin brown, Oedo ruby). Clicking a thread navigates to `#/line/<thread.id>`.

#### LineView

`views/LineView.svelte` is the per-thread conversation view. It receives a `threadId` prop from the router.

On mount it:
1. Calls `api.getThread(threadId)` to verify the thread exists.
2. Calls `api.listMessages(threadId)` to populate the message list.
3. Calls `connectWebSocket()` and `subscribeToThread(threadId)` to receive real-time updates.
4. Starts two polling timers — a 5 s poll on `api.listMessages` (belt-and-braces over the WS) and a 2 s poll on `/api/threads/:id/status` to drive the active/idle/"thinking"/"using tool" indicator and its Cancel button.

The bottom area contains a file-attachment control (uploading via `POST /api/files/upload` and stashing the returned file ID as a pending attachment), a `<textarea>`, and a Send button. `handleSendMessage` calls `api.sendMessage` with the currently selected model (from `modelStore`) and any pending `file_id`. A debug toggle in the header opens a context-debug panel. A back button navigates to `#/`.

Messages are rendered by a `MessageList` component, which in turn renders each message through `MessageBubble`.

#### Timetable

`views/Timetable.svelte` displays all tasks fetched from `GET /api/tasks` (polled every 5 s) rendered as a departure-board style table with filter chips (pending / running / failed / cancelled).

Table columns: Status, Name, Type (with a `LineBadge` colored by task type), Schedule, Next Run, Last Run, Duration, Host, Actions. Rows are grouped into active (running / claimed / failed / pending) and inactive (cancelled / completed) sections, and can be expanded for a detail pane. The Actions column exposes a Cancel button for cancellable tasks that calls `POST /api/tasks/:id/cancel`.

#### NetworkStatus

`views/NetworkStatus.svelte` fetches `GET /api/status/network` on mount (polled every 10 s) and renders a `TopologyDiagram` together with one `MetroCard` per entry in the returned `hosts` array. Each card shows: host name, local/hub badges, online status (derived from `online_at` vs. a 5 min threshold; the local host is always shown online), site ID, last-seen timestamp, version, per-peer sync health (healthy / degraded / unreachable / unknown, derived from the matching `sync_state` row), last sync time, and pill lists of advertised models and MCP tools. Below the card grid is a "Sync Mesh" `DataTable` summarising per-peer `sent` / `received` / `last_sync` / `errors` columns.

The grid layout uses `auto-fill` columns of minimum 340 px, so host cards wrap naturally.

### Components

#### MessageBubble

`components/MessageBubble.svelte` renders a single chat message. Props:

| Prop | Type |
|------|------|
| `role` | `"user" \| "assistant" \| "tool_call" \| "tool_result" \| "alert" \| "system"` |
| `content` | `string` |

The `role` is applied as a CSS class on the outer div, giving each role a distinct left-border color. A small role badge appears above the content text. Content uses `word-wrap: break-word`.

#### TopBar

`components/TopBar.svelte` is a fixed header rendered on every view. It displays:
- The application name ("Bound") and logo on the left (clickable — navigates to `#/`).
- A navigation row of buttons, each tinted with its metro line color: System Map (`#/`), Timetable (`#/timetable`), Network (`#/network`), Files (`#/files`), Advisories (`#/advisories`). The active button is highlighted based on the current hash. The Advisories button carries a numeric badge when the count is non-zero.
- A `ModelSelector` on the right.
- An advisory indicator button showing the current advisory count (polled every 10 s from `GET /api/advisories/count`) — clicking it navigates to `#/advisories`.

#### ModelSelector

`components/ModelSelector.svelte` renders a `<select>` element populated from `GET /api/status/models`. On mount the component fetches the models list and sets the initial selection to the default model's `${id}@${host}` value (so the same model ID on multiple hosts remains distinguishable). Each option displays the model ID; relay models show their host name and either a "via relay" or "offline?" annotation. When the selection changes, `handleChange` strips the `@host` suffix and writes the model ID to `modelStore`, which other components subscribe to in order to send the selected model to the server.

### API Client

`lib/api.ts` exports a singleton `api` object that wraps `fetch` calls with typed response parsing. All requests use relative URLs, so they are always routed to the same origin.

Internal helper `fetchJson<T>(url, options?)` calls `fetch`, throws an `Error` constructed from `response.json().error` if the response is not OK, and otherwise returns the parsed body as `T`.

| Method | Signature | Endpoint called |
|--------|-----------|-----------------|
| `listThreads` | `(opts?: { includeEmpty?: boolean }) => Promise<Thread[]>` | `GET /api/threads` (appends `?include_empty=true` when `opts.includeEmpty`) |
| `createThread` | `() => Promise<Thread>` | `POST /api/threads` |
| `getThread` | `(id: string) => Promise<Thread>` | `GET /api/threads/:id` |
| `getTask` | `(id: string) => Promise<Task>` | `GET /api/tasks/:id` |
| `listMessages` | `(threadId: string) => Promise<Message[]>` | `GET /api/threads/:threadId/messages` |
| `sendMessage` | `(threadId: string, content: string, modelId?: string, fileId?: string) => Promise<Message>` | `POST /api/threads/:threadId/messages` |
| `getContextDebug` | `(threadId: string) => Promise<ContextDebugTurn[]>` | `GET /api/threads/:threadId/context-debug` |
| `getMemoryGraph` | `() => Promise<MemoryGraphResponse>` | `GET /api/memory/graph` |

The `Thread`, `Message`, `Task`, `ContextDebugTurn`, and `MemoryGraph*` types are defined in the same file and match the server shapes documented above.

### WebSocket Client

`lib/websocket.ts` manages a single shared WebSocket connection for the entire SPA.

**`wsEvents`** — A Svelte writable store of type `WebSocketMessage[]`. Each incoming frame is appended to this array; components can subscribe to it to react to real-time events.

**`connectWebSocket()`** — Opens the connection if one is not already active. The URL is derived from the current origin (`ws:` for `http:`, `wss:` for `https:`), always connecting to `/ws`. On open, any thread IDs already in the local `subscriptions` set are re-sent as a subscribe frame so that subscriptions survive page navigation that re-calls this function. On close, the `ws` reference is cleared.

**`subscribeToThread(threadId)`** — Adds `threadId` to the local `subscriptions` set and, if the socket is open, immediately sends a subscribe frame containing the full current subscription set.

**`disconnectWebSocket()`** — Closes the connection and clears the `ws` reference.

The module does not implement automatic reconnection. A connection dropped by the server (e.g. server restart) will not be re-established until the user navigates to a view that calls `connectWebSocket()` again.

### MCP Apps

The web UI can act as an [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) **renderer** for the servers the agent already connects to. When a server in `mcp.json` advertises the `io.modelcontextprotocol/ui` capability and binds UI resources to its tools, its UI-bearing tool results render as interactive apps inline in the conversation. The agent calls those tools **server-side** as normal — the browser is purely a renderer, never a second tool provider. Renderer and sourcing live entirely in the web router (`:3001`) and never touch the sync router.

**Why renderer-not-provider.** An earlier iteration registered the app servers' tools on the shared `BoundClient` as **client tools** (the deferral mechanism `boundless` uses), with a dedicated `mcp_apps.json` config listing browser-reachable servers. That created two doors for the same tool — an agent-side one and a browser-side one that requires a live web session — and forced a parallel config for servers the agent already knew about. (Client tools that do require a WS session now dispatch uniformly: a loop on a non-session host relays a `client_tool` request to the session host and awaits a `client_result`, so session affinity is an optimization, not a correctness requirement — `docs/design/specs/2026-06-29-unified-delegation.md`, R-UD5/R-UD8/R-UD12.) The renderer model drops both: there is no `mcp_apps.json`, and the browser registers nothing on the client.

**Config and discovery.** App-bearing servers are discovered by joining `mcp.json` (the agent's server-side connections) against the synced **capability inventory** — `hosts.mcp_capabilities`, captured at connect time, records each server's `serverInfo` and the per-tool `ui://` resource bindings. `GET /api/mcp-apps` (`routes/mcp-apps.ts`) returns the browser-reachable subset (`http` transport) as same-origin `proxyPath`s plus each server's UI-bearing `tools`; the real upstream `url` and any auth `headers` stay server-side and are injected by the proxy, never sent to the browser. `stdio` servers are excluded — a browser cannot reach them.

**Bootstrap** (`lib/mcp-apps-bootstrap.ts`, run once from `App.svelte`'s `onMount`): fetch the app-bearing server list, `connectToMcpServer` to each through its same-origin proxy (Streamable HTTP), and `listTools`. The connection exists so the renderer can read the server's `ui://` app resources and route an app's `AppBridge.callServerTool` callbacks back to the server — it does **not** register the tools on the `BoundClient`. Per-server connect failures are logged and skipped so one unreachable server doesn't sink the rest. The populated `McpAppHost` is exposed via the `mcpAppHost` store for the renderer.

**Render trigger** (`lib/mcp-app-store.ts`, `components/McpAppPanel.svelte`): the renderer watches the conversation message stream for tool results on tools the capability inventory flags as UI-bearing; a match registers an `McpAppInstance` (keyed by tool call id) in the `mcpAppInstances` store, and `LineView` renders an `McpAppPanel` for it. (The message-stream watcher is the in-progress piece; the panel/sandbox machinery below is shared.)

**Sandbox** (`lib/mcp-app-frame.ts`, `lib/mcp-app-bridge.ts`, `components/McpAppPanel.svelte`): each app renders in a single iframe sandboxed to an **opaque origin** (`sandbox="allow-scripts allow-forms"`, no `allow-same-origin`), with the app HTML delivered via `srcdoc`. Because everything is served from one origin, a separate sandbox-proxy document (as in the ext-apps reference) would itself have to be sandboxed, which forces the nested app frame opaque by sandbox-flag inheritance — so the proxy buys a postMessage relay hop and no extra isolation. One opaque-origin frame is equally isolated and simpler; the host↔app channel is the MCP Apps `postMessage` protocol (ext-apps `PostMessageTransport` validates window identity via `event.source`, not `event.origin`, so it works against an opaque origin). The resource's requested CSP is applied via an injected `<meta http-equiv>` tag (srcdoc carries no HTTP headers); sandbox isolation is the primary control and CSP is defense-in-depth. Trade-off: opaque-origin apps cannot use `localStorage`/`sessionStorage`.

---

## @bound/platforms

The `@bound/platforms` package connects the agent system to external messaging platforms. Platform connectors are **in-process MCP servers**: a connector declares event types and tools through the Model Context Protocol, and the agent system consumes them like any other MCP server. The package manages tool discovery, event subscriptions (connector handles), tool-annotation filtering, and the unified `connector` management tool. See `packages/platforms/CLAUDE.md` for the contract-level summary.

### PlatformMcpRegistry

`PlatformMcpRegistry` (`packages/platforms/src/mcp-registry.ts`) owns every in-process MCP platform server on a host and the active event subscriptions bound to them. `setupDiscordServers` logs the Discord.js client in and calls `registry.registerServer(platform, server)` with the server returned by `createDiscordServer`.

Key methods:

- `getServerNames()` / `getClient(name)` / `getServerEntry(name)` — server discovery.
- `getToolsForThread(threadId)` — resolves the scoped tool set for an event-task thread by tracing thread → task → `connector_handle` → `server_name`.
- `getReadOnlyPlatformTools()` — every tool annotated `readOnlyHint === true`, across all servers, for non-event-task threads.
- `getInstructionsForThread(threadId)` — connector-authored orientation prose, surfaced only to threads bound to that connector (e.g. Discord's markdown dialect).
- `activateSubscription(handle)` — starts push or poll delivery for a connector handle; only the elected leader activates.
- `reconnectAll()` — reconstitutes all active subscriptions after a leadership change.
- `setRemotePlatformRequest(fn)` — wires the relay proxy so tool calls and `events/list` can reach a connector hosted on another cluster node.

**Event subscription and push delivery.** A connector handle binds `(server_name, event_name, event_args)` to a `delivery_mode` (`"push"` or `"poll"`) and a `task_id`. In push mode the registry installs a `notifications/events/event` handler on the MCP client, buffers matching events per subscription, and flushes on a ~2s cadge through `deliverBatch()`. `deliverBatch()` deduplicates by `eventId`, persists each event as a `developer`-role message, advances the handle cursor, writes a relay `intake` row for multi-host routing, and emits a `connector:event` trigger keyed `connector:event:<handleId>` so only the bound task wakes. Poll mode calls `events/poll` on the same cadence (exponential backoff to 60s on error) and runs the identical `deliverBatch()` path. Cursors are the Discord-issued snowflake, not an in-process counter, so they survive daemon restarts without collision.

**`registerConnectorEventDelivery(registry, scheduler, eventBus)`** wires the `connector:event` eventBus signal to the scheduler's event-task wakeup. There is no `connector:list_changed` event; tool discovery happens at server registration, not per-thread.

### PlatformLeaderElection

`PlatformLeaderElection` (`packages/platforms/src/leader-election.ts`) ensures exactly one host runs active subscriptions per platform. It uses `cluster_config` (key `platform_leader:<platform>`) as the distributed lock, synced via the change-log outbox.

- **Startup:** claim leadership if no entry exists; reclaim idempotently if already leader; otherwise enter standby.
- **Liveness signal:** leadership uses `hosts.modified_at` as the freshness signal. That column is refreshed by the process-wide `startHostHeartbeat` (`@bound/core`, `HOST_HEARTBEAT_INTERVAL` = 120s) — it is not a leader-only write.
- **Failover:** a standby polls the current leader's `hosts.modified_at` every `failover_threshold_ms / 3` and promotes itself when the leader's timestamp is older than `failover_threshold_ms` (default 30s).

Only the leader activates subscriptions; on promotion the new leader calls `reconnectAll()`.

### Discord MCP Server

`createDiscordServer(config, client, logger)` (`packages/platforms/src/connectors/discord-server.ts`) returns an in-process MCP server. `setupDiscordServers` builds the Discord.js client — logging in **before** `registerServer` so a failed login never exposes a half-initialized tool to the cluster — with intents `DirectMessages`, `MessageContent`, `Guilds`, and `GuildMessages`. `GuildMessages` is required for the gateway to fire `messageCreate` in guild text channels; `Guilds` alone delivers only guild/channel metadata.

**Events** (declared via `events/list`, streamed via `events/stream`, polled via `events/poll`):

- `message.received` — requires a `channel_id` subscription filter. Fires for DMs and guild text channels. The `messageCreate` handler drops bot messages and any non-text channel; the `allowed_users` allowlist gates **DM authors only**. Guild channels are gated by the channel subscription itself, so any member of an attached channel may trigger the agent. Event data: `{ author, channel_id, guild_id, channel_name, content, attachments, message_id }` — `guild_id` is null for DMs; `channel_name` is undefined for DMs. Attachments are downloaded from the Discord CDN (30s timeout) and normalized to base64 `ContentBlock` images below 1 MB or `file_ref` entries at 1 MB and above.
- `interaction.received` — fires for slash commands and context-menu interactions. The handler defers with an ephemeral reply, stores the interaction under a `callback_id` (14-minute TTL), and emits `{ callback_id, interaction_type, user, channel_id, target_message?, command? }`. There is no longer a bespoke `DiscordInteractionConnector` or hardcoded filing-prompt logic: every interaction — including the "File for Later" message context-menu command (issue #196) — surfaces through this one generic event. The command is registered with Discord out of band (nothing in source calls `commands.create`); when a user invokes it, the context-menu interaction carries the `target_message`, the bound event task handles the filing in its own reasoning, and the agent replies by calling `discord_respond_interaction`.

**Tools:**

- `discord_send_message` — sends to any text-based channel (DM or guild), rejecting content over 2000 characters and non-text channels.
- `discord_respond_interaction` — edits the ephemeral reply for a stored `callback_id`.
- `discord_list_channels` (annotated `readOnlyHint: true`) — returns a flat array mixing DM entries (`{user_id, channel_id}` from `allowed_users`, or `{user_id, error}` on `createDM` failure) and guild entries (`{guild_id, guild_name, channel_id, channel_name}` from the visible guild text channels). Callers discriminate by `user_id` vs `guild_id`.

### Connector Handles and the connector Tool

Subscription lifecycle is driven by the unified `connector` tool (`createConnectorTool`, `packages/platforms/src/connector-tool.ts`), an action dispatcher available to any non-event-task thread:

- `list` — cluster-wide server discovery (local registry + synced `hosts.platforms`).
- `channels` — `events/list` for a server (local or via `remotePlatformRequest`), annotated with the existing handles bound to each event.
- `attach` — creates a `connector_handles` row (synced, LWW), an `event`-type task, and a thread, then activates the subscription if this host is the leader; otherwise the handle syncs to the leader and activates there.
- `detach` — soft-deletes the handle and its task.

**Tool scoping** uses a two-branch resolver, wired into the scheduler as `platformToolResolver` (and mirrored on the relay path via `RelayProcessor.setPlatformMcpRegistry`): event-task threads get their bound server's full tool set from `getToolsForThread(threadId)`; all other threads get `getReadOnlyPlatformTools()` plus the `connector` tool. The agent loop always runs on the trigger host; a tool whose serving host differs is reached through the uniform `{local | relay}` tool dispatch (`docs/design/specs/2026-06-29-unified-delegation.md`, R-UD5/R-UD8), never by injecting tools into a delegated loop's config.

### Webhook Ingress

External services deliver events to **`POST /webhook/:name` on the sync server** (port 3000, `PORT`), registered in `packages/web/src/server/start.ts` alongside `/sync/ws` — not on the web/API server. There is no `/hooks/:platform` route and no `platform:webhook` event; both were removed with the old connector framework.

The handler (`packages/web/src/server/webhook-handler.ts`):

1. Looks up the webhook by name; unknown names 404. Every rejection observable without the secret (unknown name, empty/oversized/unreadable body, bad signature) returns an identical 404 so responses can't distinguish a real webhook name.
2. Reads the body (capped at 1 MB) and validates the signature via `validateWebhookSignature` (`github | stripe | slack | raw`).
3. Builds an HTTP envelope with filtered headers and writes a `relay_inbox` row with `kind: "webhook_intake"` — a **passive** relay kind the relay-processor deliberately skips, so the scheduler's event-task wakeup (`buildEventWakeupContent`) is the sole consumer.
4. Deduplicates via platform delivery headers (`X-GitHub-Delivery`, `Stripe-Idempotency-Key`, `X-Idempotency-Key`) mapped to `relay_inbox.idempotency_key`.
5. Emits `connector:event` (`{ trigger_key: "webhook:<name>", handle_id, task_id, batch_size }`) to wake the bound task, and returns 202.
