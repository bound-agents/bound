# Web and Discord Interfaces

This document covers the `@bound/web` and `@bound/discord` packages. The web package provides a local HTTP/WebSocket API server and a Svelte single-page application with a Tokyo Metro-inspired visual design (Nunito Sans + IBM Plex Mono typography, 10-line color palette). The Discord package connects the agent system to a Discord bot that accepts direct messages from allowlisted users.

### Recent changes

- **Tokyo Metro visual design** with authentic 10-line color palette, station-style navigation, and Beck-inspired transit map
- **`POST /api/mcp-proxy`** endpoint for cross-host MCP tool proxying with Ed25519 signed request auth
- **`GET /api/status/models`** returns real model backends from config (not hardcoded)
- **`GET /api/threads/:id/status`** queries actual running tasks instead of returning hardcoded `active: false`
- **Host validation** accepts `localhost`, `127.0.0.1`, and `[::1]`
- **Thinking indicator** (bouncing dots) while the LLM generates a response
- **Viewport-pinned layout** — messages scroll independently, input fixed at bottom
- **Embedded SPA** — web assets are embedded into the compiled binary via `embedded-assets.ts`

---

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
3. [@bound/discord](#bounddiscord)
   - [shouldActivate](#shouldactivate)
   - [DiscordBot Lifecycle](#discordbot-lifecycle)
   - [Allowlist Enforcement](#allowlist-enforcement)
   - [DM-to-Agent Message Flow](#dm-to-agent-message-flow)
   - [Thread Mapping](#thread-mapping)
   - [Reaction-Based Cancellation](#reaction-based-cancellation)

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

Before starting, it checks that `dist/client/index.html` exists and throws if the Svelte SPA has not been built (`bun run build` inside `packages/web`).

The server is launched with `Bun.serve`. The `fetch` handler intercepts upgrade requests arriving on the `/ws` path and hands them to the Bun WebSocket subsystem; all other requests are forwarded to the Hono application. Stopping the server calls `Bun.Server.stop(true)`, which closes all active connections.

### Host Header Validation

A middleware registered on `"*"` runs before every API handler. It reads the `Host` request header, strips any port suffix, and checks the hostname against an allowlist:

```
localhost
127.0.0.1
[::1]
```

Any request whose `Host` header resolves to a hostname not in that list is rejected with `400 Bad Request` and the JSON body `{ "error": "Invalid Host header" }`. Requests with no `Host` header pass through unchanged.

This is the primary mechanism that prevents the local API from being reachable by remote callers via DNS rebinding or forwarded proxies.

### API Route Reference

All routes are mounted under `/api` and registered in `packages/web/src/server/routes/`. Static SPA assets are served from `dist/client/` and are mounted after API routes so the API always takes precedence.

#### Threads — `/api/threads`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/threads` | List all non-deleted threads for `default_web_user`, ordered by `last_message_at` descending. |
| POST | `/api/threads` | Create a new thread. |
| GET | `/api/threads/:id` | Fetch a single thread by ID. |
| GET | `/api/threads/:id/status` | Fetch the current agent status for a thread. |

**GET /api/threads** — Response: `Thread[]`

**POST /api/threads** — No request body required. Inserts a new row with `interface = "web"`, `host_origin = "localhost:3000"`, a random `color` in `0..9`, and `title = "New Thread"`. Response `201`: `Thread`.

**GET /api/threads/:id** — Response `200`: `Thread`. Response `404`: `{ "error": "Thread not found" }`.

**GET /api/threads/:id/status** — Verifies the thread exists, then returns a static placeholder object. Response `200`:
```json
{
  "active": false,
  "state": null,
  "model": "gpt-4"
}
```

The `Thread` shape:
```ts
interface Thread {
  id: string;
  user_id: string;
  interface: "web" | "discord";
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

**POST /api/status/cancel/:threadId** — Verifies the thread exists, then emits `agent:cancel` with `{ thread_id }` on the event bus so the agent loop can observe the signal and stop. Response `200`:
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

The client is a Svelte 5 single-page application built with Vite and served as static files from `dist/client/`.

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

`components/ModelSelector.svelte` renders a `<select>` element pre-populated with three model options (`gpt-4`, `gpt-3.5-turbo`, `claude-3-opus`). The selected value is bound to a local `selectedModel` variable. An `onchange` handler is wired up but does not yet dispatch the selection to the server.

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

## @bound/discord

The `@bound/discord` package connects the agent system to Discord. It operates exclusively over DMs: guild messages are ignored.

### shouldActivate

`shouldActivate(ctx: AppContext): boolean` is called at startup to decide whether the Discord bot should be started on the current machine. It reads `ctx.optionalConfig.discord`:

- If the config is absent or failed to load, returns `false`.
- If the config loaded successfully, compares `config.host` against `ctx.hostName`. Returns `true` only when they match.

This allows a single shared configuration store to contain a Discord token that is only activated on the designated host, preventing duplicate bots from connecting when the agent system runs on multiple machines.

### DiscordBot Lifecycle

`DiscordBot` is a class that wraps a `discord.js` `Client`. It is constructed with:

| Parameter | Type | Description |
|-----------|------|-------------|
| `ctx` | `AppContext` | Application context: database, event bus, logger, siteId, hostName |
| `agentLoopFactory` | `AgentLoopFactory` | Factory that creates an `AgentLoop` from a config |
| `botToken` | `string` | Discord bot token |

**`start()`** — Dynamically imports `discord.js`, creates a `Client` requesting the `DirectMessages` and `MessageContent` gateway intents, registers the `messageCreate` and `messageReactionAdd` handlers, and calls `client.login(botToken)`.

**`stop()`** — Calls `client.destroy()`, which closes the gateway connection and cleans up all internal state.

### Allowlist Enforcement

`isAllowlisted(discordId, db)` in `packages/discord/src/allowlist.ts` queries the `users` table for a non-deleted row where `discord_id` matches the given Discord snowflake. It returns `true` if such a row exists, `false` otherwise.

Per the spec, rejection is silent: no reply is sent to non-allowlisted users and nothing is logged above the `debug` level. This prevents the bot from being a signal to unapproved users that the account is active.

### DM-to-Agent Message Flow

When a `messageCreate` event fires:

1. Bot messages and non-DM messages are filtered out.
2. `isAllowlisted` checks whether the author's Discord ID exists in the database. Non-allowlisted users are silently ignored.
3. `mapDiscordUser` resolves the Discord ID to a database `User` row. If no mapping exists the message is dropped.
4. `findOrCreateThread` fetches or creates the user's persistent Discord thread (see [Thread Mapping](#thread-mapping)).
5. The user's message is persisted to the `messages` table with `role = "user"`, `host_origin` set to `ctx.hostName`, and the current timestamp.
6. An `AbortController` is created and registered in the module-level `activeLoops` map under the thread ID.
7. `agentLoopFactory` produces an `AgentLoop` bound to the thread, user, and abort signal. `agentLoop.run()` is awaited.
8. On success, the most recent `assistant`-role message from the thread is fetched and sent back as a Discord reply.
9. On failure, the error message is sent as a reply. Either way, the `AbortController` is removed from `activeLoops` in the `finally` block.

### Thread Mapping

`packages/discord/src/thread-mapping.ts` exposes two functions.

**`mapDiscordUser(db, discordId)`** — Queries `users WHERE discord_id = ? AND deleted = 0` and returns the first matching `User`, or `null` if none exists. The users table must be pre-populated; the Discord bot does not auto-register new users.

**`findOrCreateThread(db, userId, siteId)`** — Looks for an existing thread with `user_id = userId`, `interface = 'discord'`, and `deleted = 0`. If found, it is returned directly. Otherwise, a new thread is inserted with `host_origin = siteId` and both `created_at` and `last_message_at` set to the current time. The newly inserted row is fetched and returned.

Each Discord user has exactly one active Discord thread at a time. The bot does not provide a mechanism to start a new thread; continued DMs always continue the same thread.

### Reaction-Based Cancellation

The `messageReactionAdd` handler provides an out-of-band mechanism for a user to cancel a running agent loop without sending a new message.

When a reaction is added:

1. Bot reactions are ignored.
2. The reaction emoji must be either `"❌"` (the Unicode cross mark) or the custom emoji named `"cancel"`. All other emoji are ignored.
3. The reaction must be on a message in a DM channel. Reactions in guilds are ignored.
4. The reacted-to message must be authored by the bot itself. This prevents a user from accidentally cancelling a loop by reacting to their own messages.
5. `mapDiscordUser` resolves the reactor's Discord ID. If no database user is found, the event is dropped.
6. The most recent non-deleted Discord thread for that user is looked up.
7. If an `AbortController` exists in `activeLoops` for that thread, it is aborted. The agent loop receives the abort signal via the `AbortSignal` it was given at construction time and is expected to stop at its next cancellation checkpoint.
