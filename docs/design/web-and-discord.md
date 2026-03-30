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
   - [PlatformConnector Interface](#platformconnector-interface)
   - [PlatformLeaderElection](#platformleaderelection)
   - [PlatformConnectorRegistry](#platformconnectorregistry)
   - [DiscordConnector](#discordconnector)
   - [Webhook Ingress](#webhook-ingress)

---

## @bound/web Server

### Server Bootstrap

`createWebServer` in `packages/web/src/server/start.ts` is the top-level entry point for the server. It accepts a `Database`, a `TypedEventEmitter`, and an optional `WebServerConfig` and returns a `WebServer` handle with `start`, `stop`, and `address` methods.

```ts
interface WebServerConfig {
  port?: number;   // default: 3000
  host?: string;   // default: "localhost"
}

interface WebServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  address(): string;
}
```

The server is launched with `Bun.serve` and binds to `localhost` by default. Set `BIND_HOST=0.0.0.0` for hub nodes that must accept external spoke connections. The `fetch` handler intercepts upgrade requests arriving on the `/ws` path and hands them to the Bun WebSocket subsystem; all other requests are forwarded to the Hono application. Stopping the server calls `Bun.Server.stop(true)`, which closes all active connections.

The SPA is embedded into the compiled binary via `scripts/embed-assets.ts`. At runtime, `createApp` attempts to import the `embedded-assets` module; if embedded assets are present they are served directly from in-memory byte arrays, so `dist/client/index.html` does not need to exist on disk. If no embedded assets are found, the server falls back to `serveStatic` from `dist/client/`.

### Host Header Validation

A middleware registered on `"*"` runs before every API handler. It reads the `Host` request header, strips any port suffix, and checks the hostname against an allowlist:

```
localhost
127.0.0.1
[::1]
```

Any request whose `Host` header resolves to a hostname not in that list is rejected with `400 Bad Request` and the JSON body `{ "error": "Invalid Host header" }`. Requests with no `Host` header pass through unchanged.

The `/sync/*` routes and `POST /api/relay-deliver` are **exempt** from this check. These routes carry Ed25519 signature authentication and must be reachable by remote spokes connecting to a hub through a reverse proxy.

This exemption aside, host header validation is the primary mechanism that prevents the local API from being reachable by remote callers via DNS rebinding or forwarded proxies.

### API Route Reference

All routes are mounted under `/api` and registered in `packages/web/src/server/routes/`. Static SPA assets are served after API routes so the API always takes precedence.

#### Threads — `/api/threads`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/threads` | List all non-deleted threads for `default_web_user`, ordered by `last_message_at` descending. |
| POST | `/api/threads` | Create a new thread. |
| GET | `/api/threads/:id` | Fetch a single thread by ID. |
| GET | `/api/threads/:id/status` | Fetch the current agent status for a thread. |
| POST | `/api/mcp/threads` | Create a thread owned by the deterministic `mcp` system user (interface `"mcp"`). Used by `bound-mcp` stdio server. Response `201`: `{ thread_id: string }`. |

**GET /api/threads** — Response: `Thread[]`

**POST /api/threads** — No request body required. Inserts a new row with `interface = "web"`, `host_origin = "localhost:3000"`, a `color` cycling from the last thread's value (mod 10), and an empty `title`. Response `201`: `Thread`.

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

**POST /api/threads/:threadId/messages** — Request body: `{ "content": string }`. Inserts a message with `role = "user"` and emits a `message:created` event on the event bus (which fans the message out to all subscribed WebSocket clients). Response `201`: `Message`.

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
| GET | `/api/files` | List all non-deleted files, ordered by `created_at` descending. |
| GET | `/api/files/*` | Fetch a single file by its path (the wildcard is the file path stripped of the `/api/files/` prefix). |
| POST | `/api/files/upload` | Upload a new file via `multipart/form-data`. |

**GET /api/files** — Response `200`: `AgentFile[]`.

**GET /api/files/*** — The path after `/api/files/` is used as the lookup key in the `files` table. Response `200`: `AgentFile`. Response `404`: `{ "error": "File not found" }`.

**POST /api/files/upload** — Expects `multipart/form-data` with a `file` field. The file is stored as text at `/home/user/uploads/<filename>` with `created_by = "default_web_user"`. Response `201`: `AgentFile`.

#### Status — `/api/status`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Return host uptime and active loop count. |
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

**GET /api/tasks** — Accepts an optional `?status=` query parameter (`pending`, `running`, `completed`, `failed`). Returns all non-deleted tasks ordered by `created_at` descending. Response `200`: `Task[]`.

#### Relay — `/api/relay-deliver`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/relay-deliver` | Receives eager-pushed relay messages from the hub (Ed25519 signed). Exempt from host header validation. |

This endpoint is used when the hub pushes relay messages directly to spokes with a known `sync_url`, bypassing the next scheduled sync cycle. The request body is an Ed25519-signed relay payload; the sync package verifies the signature.

#### Webhook Ingress — `/hooks`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/hooks/:platform` | Webhook ingress for exclusive-delivery platform connectors. Emits `platform:webhook` event; signature verification is handled by each connector's `handleWebhookPayload()`. Exempt from host header validation. |

The raw body and all headers are forwarded to `platform:webhook` on the eventBus unchanged. The `PlatformConnectorRegistry` routes this event to the leader connector matching `payload.platform`.

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

The handler listens to four event bus events and pushes corresponding frames to connected clients.

| Event bus event | WS frame type | Routing | Payload |
|----------------|---------------|---------|---------|
| `message:created` | `"message"` | Thread subscribers only | The full message object from the database |
| `task:completed` | `"task_update"` | All connected clients | `{ taskId, status: "completed" }` |
| `file:changed` | `"file_update"` | All connected clients | `{ path, operation }` where operation is `"created"`, `"modified"`, or `"deleted"` |
| `alert:created` | `"alert"` | Thread subscribers only | The full alert message object |

All frames follow the envelope:
```json
{
  "type": "<event-type>",
  "data": { ... }
}
```

Only clients whose connection `readyState` equals `WebSocket.OPEN` receive frames; stale connections are skipped but not explicitly removed here — that happens on `close`.

---

## @bound/web Client

The client is a Svelte 5 single-page application built with Vite and embedded into the compiled binary. In development, assets can also be served from `dist/client/` via the static fallback.

### Entry Point and Routing

`App.svelte` is the root component. It mounts a single `TopBar` across the top and renders a view in the `<main>` area below it.

Routing is hash-based. The router in `packages/web/src/client/lib/router.ts` exposes a writable Svelte store `currentRoute` and a `navigateTo(route)` function that sets `window.location.hash`. `App.svelte` listens to the browser `hashchange` event and syncs the hash (without the leading `#`) back into the store.

| Hash | View rendered |
|------|---------------|
| `#/` or empty | `SystemMap` |
| `#/line/<thread-id>` | `LineView` with the thread ID extracted from the path segment |
| `#/timetable` | `Timetable` |
| `#/network` | `NetworkStatus` |
| Any other value | `SystemMap` (fallback) |

### Views

#### SystemMap

`views/SystemMap.svelte` is the landing view. On mount it calls `api.listThreads()` and renders each thread as a horizontal line in an SVG metro-style diagram.

- Each thread occupies a horizontal band in an SVG viewport of `1200 x 600`. Threads are stacked vertically with 50 px spacing starting at y = 100.
- The line color is determined by `thread.color % 10`, mapped into a fixed 10-color palette (red, blue, green, orange, purple, cyan, magenta, yellow, dark orange, light blue).
- Five station circles are drawn at fixed x positions (100, 300, 500, 700, 900) along each line.
- A transparent `<rect>` covers the full width of each line and acts as a clickable hit area. Clicking or pressing Enter/Space navigates to `#/line/<thread.id>`.

#### LineView

`views/LineView.svelte` is the per-thread conversation view. It receives a `threadId` prop from the router.

On mount it:
1. Calls `api.getThread(threadId)` to verify the thread exists.
2. Calls `api.listMessages(threadId)` to populate the message list.
3. Calls `connectWebSocket()` and `subscribeToThread(threadId)` to receive real-time updates.

The input area contains a resizable `<textarea>` and a Send button. `handleSendMessage` calls `api.sendMessage` and appends the returned message to the local array. While sending, both the textarea and button are disabled. A back button navigates to `#/`.

Each message is rendered by a `MessageBubble` component.

#### Timetable

`views/Timetable.svelte` displays all tasks fetched from `GET /api/tasks`. On mount it fetches directly via `fetch("/api/tasks")`.

The table columns are: Task ID (first 8 characters, monospace), Type, Status, Run Count, Created (formatted with `toLocaleString()`). Status cells are styled with distinct colors: completed (green), running (teal), failed (red), pending (amber).

#### NetworkStatus

`views/NetworkStatus.svelte` fetches `GET /api/status` on mount and builds a single host card for `localhost` from the response. The card shows:
- An online/offline indicator dot (green when online).
- The sync status string (`"synced"`).
- A "Last sync" timestamp derived by subtracting `host_info.uptime_seconds` from the current time.

The grid layout uses `auto-fill` columns of minimum 250 px, so additional host cards would wrap naturally.

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
- The application name ("Bound") on the left.
- A `ModelSelector` in the center-right.
- An "Advisory Count: 0" indicator on the far right.

#### ModelSelector

`components/ModelSelector.svelte` renders a `<select>` element populated from `GET /api/status/models`. On mount the component fetches the models list and sets the initial selection to `data.default`. Each option displays the model ID; relay models show their host name and an `"offline?"` annotation when stale. When the selection changes, `handleChange` strips any `@host` suffix and writes the model ID to `modelStore`, which other components subscribe to in order to send the selected model to the server.

### API Client

`lib/api.ts` exports a singleton `api` object that wraps `fetch` calls with typed response parsing. All requests use relative URLs, so they are always routed to the same origin.

Internal helper `fetchJson<T>(url, options?)` calls `fetch`, throws an `Error` constructed from `response.json().error` if the response is not OK, and otherwise returns the parsed body as `T`.

| Method | Signature | Endpoint called |
|--------|-----------|-----------------|
| `listThreads` | `() => Promise<Thread[]>` | `GET /api/threads` |
| `createThread` | `() => Promise<Thread>` | `POST /api/threads` |
| `getThread` | `(id: string) => Promise<Thread>` | `GET /api/threads/:id` |
| `listMessages` | `(threadId: string) => Promise<Message[]>` | `GET /api/threads/:threadId/messages` |
| `sendMessage` | `(threadId: string, content: string) => Promise<Message>` | `POST /api/threads/:threadId/messages` |

The `Thread` and `Message` types are defined in the same file and match the server shapes documented above.

### WebSocket Client

`lib/websocket.ts` manages a single shared WebSocket connection for the entire SPA.

**`wsEvents`** — A Svelte writable store of type `WebSocketMessage[]`. Each incoming frame is appended to this array; components can subscribe to it to react to real-time events.

**`connectWebSocket()`** — Opens the connection if one is not already active. The URL is derived from the current origin (`ws:` for `http:`, `wss:` for `https:`), always connecting to `/ws`. On open, any thread IDs already in the local `subscriptions` set are re-sent as a subscribe frame so that subscriptions survive page navigation that re-calls this function. On close, the `ws` reference is cleared.

**`subscribeToThread(threadId)`** — Adds `threadId` to the local `subscriptions` set and, if the socket is open, immediately sends a subscribe frame containing the full current subscription set.

**`disconnectWebSocket()`** — Closes the connection and clears the `ws` reference.

The module does not implement automatic reconnection. A connection dropped by the server (e.g. server restart) will not be re-established until the user navigates to a view that calls `connectWebSocket()` again.

---

## @bound/platforms

The `@bound/platforms` package connects the agent system to external messaging platforms. It replaces the old `@bound/discord` package with a generic connector framework supporting multiple platforms (Discord, and future webhook-based connectors).

### PlatformConnector Interface

Every platform connector implements `PlatformConnector`:

```typescript
interface PlatformConnector {
  readonly platform: string;          // e.g. "discord"
  readonly delivery: "broadcast" | "exclusive";
  connect(hostBaseUrl?: string): Promise<void>;
  disconnect(): Promise<void>;
  deliver(threadId: string, messageId: string, content: string, attachments?: unknown[]): Promise<void>;
  handleWebhookPayload?(rawBody: string, headers: Record<string, string>): Promise<void>;
  getPlatformTools?(
    threadId: string,
    readFileFn?: (path: string) => Promise<Uint8Array>,
  ): Map<string, { toolDefinition: ToolDefinition; execute: (input: Record<string, unknown>) => Promise<string> }>;
}
```

- **`broadcast`** connectors maintain a persistent gateway connection (Discord). Only the elected leader connects.
- **`exclusive`** connectors receive events via HTTP webhook (Telegram, Slack Events API). The new leader re-registers the webhook URL on failover.
- **`getPlatformTools`** is optional. When a `process` relay payload has `platform` set, the `RelayProcessor` calls `getPlatformTools()` on the matching connector and injects those tools into the delegated agent loop's config. This is how platform-scoped tools (e.g. `discord_send_message`) reach loops running on remote hosts. The `readFileFn` parameter, when provided, lets the tool read files from the virtual filesystem rather than the host OS filesystem.

### PlatformLeaderElection

`PlatformLeaderElection` ensures exactly one host holds the platform connection per platform at a time. It uses `cluster_config` (key `platform_leader:<platform>`) as the distributed lock, synced via the change-log outbox.

**Startup logic:**
- If no `cluster_config` entry exists for this platform, the host claims leadership immediately.
- If this host is already registered as leader, it reclaims (idempotent).
- If another host is leader, the host enters standby and polls for staleness.

**Heartbeat:** The leader updates `hosts.modified_at` every `failover_threshold_ms / 3` (default 10s).

**Failover:** A standby host checks the leader's `hosts.modified_at` on the same interval. If the leader's timestamp is older than `failover_threshold_ms` (default 30s), the standby promotes itself.

### PlatformConnectorRegistry

`PlatformConnectorRegistry` instantiates all configured connectors from `platforms.json`, starts their leader elections, and routes `platform:deliver` and `platform:webhook` eventBus events to the correct leader connector.

```typescript
const registry = new PlatformConnectorRegistry(ctx, platformsConfig, hostBaseUrl);
registry.start();   // launches leader elections, wires eventBus listeners
// ... on shutdown:
registry.stop();
```

Only the leader connector for a given platform handles `platform:deliver` and `platform:webhook` events. Non-leaders ignore them.

After startup, the registry is wired into the `RelayProcessor` via `setPlatformConnectorRegistry()` so the processor can look up connectors when dispatching `platform_deliver` relay messages and injecting platform tools into delegated loops.

### DiscordConnector

`DiscordConnector` migrates the old `DiscordBot` behavior to the new connector contract:

| Aspect | Old `DiscordBot` | New `DiscordConnector` |
|--------|------------------|------------------------|
| Message handling | Called `agentLoopFactory()` directly | Writes `intake` relay to `relay_outbox` targeting hub |
| Activation | `shouldActivate()` hostname check | Leader election handles this |
| User identity | `discord_id` DB column | `platform_ids` JSON (`{"discord":"<id>"}`) |
| Allowlist | Queried DB for `discord_id` | Reads `allowed_users` from `platforms.json` connector config |
| Interface | `start()` / `stop()` | `connect()` / `disconnect()` |

**Inbound flow (DM received):**
1. Allowlist check against `config.allowed_users` — non-allowlisted users silently dropped.
2. `findOrCreateUser` looks up by `json_extract(platform_ids, '$.discord') = ?`, creates if absent.
3. `findOrCreateThread` finds or creates a thread with `interface = 'discord'` for that user.
4. Image attachments are downloaded from Discord CDN URLs (30s timeout per attachment). Images smaller than 1 MB are stored inline as base64 `ContentBlock` image entries. Images 1 MB or larger are written to the `files` table and referenced via a `file_ref` source (storing only the file ID in the message). Non-image attachments are skipped.
5. Persists the message via `insertRow()` with `role = "user"`. When image blocks were added, `content` is stored as a JSON-serialised `ContentBlock[]`; otherwise plain text is stored for backward compatibility.
6. Writes an `intake` relay to `relay_outbox` with `target_site_id = hub`. The hub's `RelayProcessor` routes this to the appropriate spoke via the four-tier intake routing algorithm (thread affinity → model match → tool match → least-loaded).

**Outbound flow (deliver called):**
1. Looks up `platform_ids.discord` for the thread's user.
2. Opens a DM channel via the Discord client.
3. If attachments are present, sends content and files in a single Discord message. Otherwise, chunks text content at Discord's 2000-character limit and sends each chunk sequentially.

**Platform tools:** `getPlatformTools(threadId, readFileFn?)` returns a single `discord_send_message` tool. The tool validates that `content` does not exceed 2000 characters, loads any requested file attachment paths (using `readFileFn` if provided, falling back to `node:fs/promises`), and calls `deliver()`. If any attachment path cannot be read, an error string is returned and no message is sent (fail-fast, no partial delivery).

### Webhook Ingress

The web server exposes `POST /hooks/:platform` for exclusive-delivery connectors. It emits `platform:webhook` on the eventBus with the raw body and headers; signature verification is delegated to each connector's `handleWebhookPayload()` implementation.

```
POST /hooks/discord  →  eventBus.emit("platform:webhook", { platform, rawBody, headers })
POST /hooks/telegram →  eventBus.emit("platform:webhook", { platform, rawBody, headers })
```

The `PlatformConnectorRegistry` routes `platform:webhook` events to the leader connector matching `payload.platform`.
