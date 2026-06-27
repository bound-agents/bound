# Web UI

This document describes the frontend of the Bound web application — the Svelte 5 single-page application that provides the operator interface. The backend web server, REST API, and WebSocket transport are covered in [web-and-discord.md](./web-and-discord.md). This document focuses on views, components, design tokens, and UI-specific rendering.

---

## Table of Contents

1. [Design System](#design-system)
   - [Design Tokens](#design-tokens)
   - [Typography and Spacing](#typography-and-spacing)
   - [Shared Components](#shared-components)
2. [Routing and Navigation](#routing-and-navigation)
3. [Views](#views)
   - [System Map](#system-map)
   - [LineView (Thread Detail)](#lineview-thread-detail)
   - [Timetable](#timetable)
   - [Network Status](#network-status)
   - [Advisories](#advisories)
   - [Files](#files)
   - [Skills](#skills)
   - [Metrics](#metrics)
4. [Rendering Subsystems](#rendering-subsystems)
   - [Markdown Rendering](#markdown-rendering)
   - [MCP Apps Integration](#mcp-apps-integration)
5. [Data Fetching and State](#data-fetching-and-state)

---

## Design System

The Bound web UI follows a Tokyo Metro-inspired design language with a consistent component library and design token system. Each view uses one signature metro-themed element (memory graph, timetable board, topology diagram) while building from shared components.

### Design Tokens

**Line Colors** — The 10-color palette derived from Tokyo Metro lines, used for categorization and visual identity across the UI. Thread colors are assigned at creation time via the `threads.color` field (integer 0-9).

| Variable | Name | Hex | Thread Index | UI Usage |
|----------|------|-----|--------------|----------|
| `--line-0` | Ginza | `#F39700` | 0 | TopBar "System Map", thread/host badges |
| `--line-1` | Marunouchi | `#E60012` | 1 | TopBar "Timetable", thread/host badges |
| `--line-2` | Hibiya | `#9CAEB7` | 2 | Thread/host badges |
| `--line-3` | Tozai | `#009BBF` | 3 | TopBar "Files", thread/host badges |
| `--line-4` | Chiyoda | `#009944` | 4 | TopBar "Network", thread/host badges |
| `--line-5` | Yurakucho | `#C1A470` | 5 | Thread/host badges |
| `--line-6` | Hanzomon | `#8F76D6` | 6 | Tool call groups, thread/host badges |
| `--line-7` | Namboku | `#00AC9B` | 7 | User messages, send button, thread/host badges |
| `--line-8` | Fukutoshin | `#9C5E31` | 8 | Thread/host badges |
| `--line-9` | Oedo | `#B6007A` | 9 | TopBar "Advisories", thread/host badges |

**Text Hierarchy** — Three levels of contrast for semantic text roles.

| Token | Hex | Usage |
|-------|-----|-------|
| `--text-primary` | `#E8E8E8` | High contrast, headings, titles |
| `--text-secondary` | `#A0A0B0` | Mid-tone, summaries, descriptions |
| `--text-muted` | `#6B6B80` | Subtle, timestamps, inactive labels |

**Surface Colors** — Strict three-level hierarchy for depth and containment.

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-primary` | `#1A1A2E` | Page background |
| `--bg-secondary` | `#16213E` | Cards, panels, elevated surfaces |
| `--bg-surface` | `#0F3460` | Interactive elements, hover states, inputs |

**Status Colors** — Semantic mapping for operational states.

| Token | Hex | Meaning |
|-------|-----|---------|
| `--status-active` | `#69F0AE` | Running, healthy, online |
| `--alert-warning` | `#FF9100` | Pending, delayed, degraded |
| `--alert-disruption` | `#FF1744` | Failed, error, unreachable |
| `--text-muted` | `#6B6B80` | Idle, cancelled, dismissed |

### Typography and Spacing

**Fonts:**
- **Body text:** Nunito Sans (web font)
- **Monospace/data:** IBM Plex Mono (web font)

**Type Scale:**

| Token | Size | Usage |
|-------|------|-------|
| `--text-xl` | `1.5rem` | View titles only (via SectionHeader) |
| `--text-lg` | `1.25rem` | Section headers within views |
| `--text-base` | `1rem` | Body text, message content |
| `--text-sm` | `0.875rem` | Metadata, secondary info, card subtitles |
| `--text-xs` | `0.75rem` | Badges, chips, table headers, timestamps |

**Spacing (4px base grid):**

| Context | Value |
|---------|-------|
| Card internal padding | `12px` or `16px` |
| Gap between cards/rows | `8px` |
| View content margin | `24px` |
| Section gap | `16px` |
| Inline element gap | `8px` |

### Shared Components

**LineBadge** — Circle badge with metro line letter code. Size: 32px (standard) or 20px (compact). Appearance: line-colored background circle with white single letter centered (G, M, H, T, C, Y, Z, N, F, E).

**MetroCard** — The canonical card component. Background `--bg-secondary`, `1px solid --bg-surface` border, `8px` border-radius, optional `3px solid` left accent border in the associated line color. Hover state shifts background to `rgba(15, 52, 96, 0.3)`. Used for thread rows, advisory cards, host cards, task expansions.

**StatusChip** — Small status indicator pill with colored dot (6px) and uppercase label (`--text-xs`, `letter-spacing: 0.04em`). Colored by status: active (green), pending (orange), failed (red), idle/cancelled (muted). Running/active states show `badge-pulse` animation.

**DataTable** — Tabular display with sticky header, monospace data columns, row hover, sortable columns (click header, indicator arrow), optional row expansion (click row reveals detail panel).

**SectionHeader** — View title bar. Title in `--text-xl` (font-weight 700), optional subtitle in `--text-sm` (uppercase, `--text-muted`, `letter-spacing: 0.06em`), optional action slot (right-aligned buttons/dropdowns/filter chips).

---

## Routing and Navigation

Hash-based routing in `App.svelte`. The `route` variable is initialized from `window.location.hash` and updated on every `hashchange` event. The `navigateTo(route)` helper in `lib/router.ts` sets `window.location.hash` to trigger navigation.

| Hash | View |
|------|------|
| `#/` or empty | `SystemMap` |
| `#/line/<thread-id>` | `LineView` |
| `#/timetable` | `Timetable` |
| `#/network` | `NetworkStatus` |
| `#/advisories` | `AdvisoryView` |
| `#/files` | `FilesView` |
| `#/skills` | `SkillsView` |
| `#/metrics` | `MetricsView` |
| Any other value | `SystemMap` (fallback) |

**TopBar** navigation dots use consistent per-nav color assignment: System Map (Ginza orange), Timetable (Marunouchi red), Network (Chiyoda green), Files (Tozai blue), Skills (Yurakucho gold), Advisories (Oedo ruby), Metrics (Fukutoshin brown).

---

## Views

### System Map

Landing view. Split panel: left column (resizable, ~40% width) renders a `ThreadList` with search box and "+ New Line" button; right column renders a `MemoryGraph` keyed by the hovered thread.

**Thread List:** Each thread is a `MetroCard` row with `LineBadge` (32px, deterministic color from `thread.color`), title (up to two lines), summary line (`--text-sm`, `--text-secondary`, single line with ellipsis), metadata row (relative timestamp, message count, model pill, `StatusChip`), and left accent border in the thread's line color. Sorted by last activity with a visual divider separating "active today" from older threads.

**Memory Station Map (right panel):** Graph visualization where nodes are `semantic_memory` entries and edges are `memory_edges` relations. Nodes styled by tier:
- `pinned`: 12px, bold ring + filled center, always visible
- `summary`: 8px, double ring, always visible
- `default`: 6px, single ring, always visible
- `detail`: 4px, small filled dot, visible only when parent summary is selected

Node colors derive from the thread that created the memory (via `source` provenance → thread lookup → line color). Memories from multiple threads get split/gradient markers. Edges use dashed lines for `summarizes` relations. Layout is hierarchical (three horizontal bands: pinned at top, summary in middle, default/detail at bottom) with nodes ordered by `modified_at` descending (most recent on left), minimum 60px horizontal spacing.

**Context companion behavior:** When no thread is selected, full graph visible (pinned + summary tiers only, detail nodes hidden). When a thread is selected, memories from that thread at full opacity, everything else dimmed to ~20%, detail nodes connected to highlighted summaries expand into view (smooth 200ms transition). Hover on node shows tooltip (memory key, value preview ~100 chars, tier badge, source thread name, modified date). Click on node shows detail popover.

**Data source:** `GET /api/memory/graph` returns `{ nodes: Array<{ key, value, tier, source, sourceThreadTitle, lineIndex, modifiedAt }>, edges: Array<{ sourceKey, targetKey, relation, modifiedAt }> }`.

**Responsive:** At viewport widths below 900px, Memory Station Map collapses to a toggle button in the `SectionHeader`; tapping shows map as full-width overlay above thread list (slide-down animation), thread list becomes full-width single-column.

### LineView (Thread Detail)

Per-thread conversation view. Vertical flex column with width constraint (`max-width: 800px`, centered).

**Header:** Back button (`‹ Map`), thread title (full), `LineBadge`, `StatusChip`, debug toggle.

**Station-dot turn indicator:** Thin vertical line (2px) in thread's line color runs down left margin of message list, with 6px station dot at each turn boundary (user message → agent response = one turn). Latest turn's dot pulses (`badge-pulse` animation). During active thinking, dashed line animation extends below last station dot.

**Message rendering:** Messages rendered by `MessageBubble` component via `{#each messages as msg}` loop. Role-based coloring with `MetroCard` as base:

| Role | Left accent color | Background tint |
|------|-------------------|-----------------|
| User | `--line-7` (emerald) | `rgba(0, 172, 155, 0.1)` |
| Assistant | Thread's line color | `rgba(line-color, 0.08)` |
| Tool group | `--line-6` (Hanzomon purple), dashed | `rgba(143, 118, 214, 0.06)` |
| Tool error | `--alert-disruption` | `rgba(255, 23, 68, 0.06)` |
| System | No border | Transparent, centered, italic |

**Interchange rail visualization:** When context debug shows cross-thread sources, horizontal branch lines extend from the vertical rail at message positions corresponding to turns with cross-thread context. Each branch is colored in the source thread's color and terminates in a station marker with the source thread's letter code. Branch lines appear only when `ContextDebugInfo.crossThreadSources` is present for the turn.

**Input area:** File-attachment control (uploads via `POST /api/files/upload`, returns file ID as pending attachment), `<textarea>`, emerald send button (`--line-7`). Same max-width as messages.

**Data flow:** On mount, calls `api.getThread(threadId)`, `api.listMessages(threadId)`, `connectWebSocket()`, `subscribeToThread(threadId)`. Two polling timers: 5s poll on `api.listMessages` (belt-and-braces over WebSocket), 2s poll on `/api/threads/:id/status` to drive the active/idle/"thinking"/"using tool" indicator and Cancel button.

### Timetable

Scheduled task management view. Vertical layout with departure board strip at top, main `DataTable` below, filter chips, and inline row expansion for task detail.

**Departure board strip:** Compact dark inset panel (`--bg-primary` background on `--bg-secondary` page, max-height ~120px) showing next 3-5 scheduled tasks as single lines: `LineBadge` (compact 20px) · task name · countdown to next run · ON TIME | DELAYED | OVERDUE. Monospace font for countdown, slight letter-spacing.

**Main table (`DataTable`):** Columns: Status (`StatusChip`), Name (human-readable from payload), Type (colored pill: cron/deferred/event/heartbeat), Schedule (human-readable: `every 15m`, `hourly`, `one-time`), Next Run (relative countdown or absolute date), Last Run (relative time), Duration (how long last run took), Host (host name from `hosts.host_name`), Actions (Cancel button if applicable, error badge if failed).

**Default sort:** Primary by status weight (Running > Failed > Pending > Cancelled > Completed), secondary by `next_run` ascending. Visual divider between active tasks (running/failed/pending) and inactive tasks (cancelled/completed) with muted "INACTIVE" group label.

**Row expansion:** Click row to reveal full details — payload JSON, execution history, consecutive failures, associated thread link. Expansion replaces the standalone `/task/:id` route (removed in web-ui-redesign).

**Filtering:** Quick-filter chips above table for status (Pending, Running, Failed, Cancelled) alongside "All Services" dropdown.

**Data source:** `GET /api/tasks` (optionally `?status=` filter), polled every 5s. Response enriched with `displayName`, `schedule`, `lastDurationMs`, `hostName`.

### Network Status

Distributed cluster health view. Topology diagram at top (~150px tall), followed by host cards grid, then Sync Mesh `DataTable`.

**Topology diagram (signature element):** Compact transit-line schematic. Hub node rendered as large "interchange" station (double circle) in center, spoke nodes on branches with their `LineBadge`. Connection lines colored by sync health: green (healthy), orange (degraded), red (unreachable), grey (no sync data). Static layout.

**Host cards:** Each host as a `MetroCard` with header (`LineBadge` + host name + `StatusChip`), key-value rows (Site ID with copy-on-click, Last Seen, Sync Status, Last Sync, Models as small pills, MCP Tools as small pills), border color matching host's `LineBadge` color. Red border ONLY for genuinely unreachable hosts.

**Status semantics:** "Online" = last seen within reachability threshold. "Offline" = beyond threshold. Sync health is a separate field, not conflated with online status.

**Sync Mesh table (`DataTable`):** Columns: Peer (host name), Sent (HLC timestamp), Received (HLC timestamp), Last Sync (relative time), Errors (count with color coding: 0 = green, >0 = orange/red).

**Data source:** `GET /api/status/network` polled every 10s, returns `{ hosts: Array<{ site_id, host_name, online_at, version, models, mcp_tools, ... }>, sync_state: Array<{ peer, sent_at, received_at, last_sync, errors }>, hub, local_site_id }`.

### Advisories

Structured recommendation management view. Advisories listed with severity banding and dedup collapse.

**Severity bands:** Solid color bar across top of each advisory card (4px height):

| Status | Band color | Card treatment |
|--------|-----------|----------------|
| Proposed | `--alert-warning` (orange) | Orange accent, full opacity |
| Approved | `--status-active` (green) | Green accent |
| Failed/escalated | `--alert-disruption` (red) | Red accent, subtle red glow (`box-shadow`) |
| Dismissed/deferred | None | Muted opacity, visually recedes |
| Applied | `--line-6` (Hanzomon purple) | Purple accent, completed feel |

**Card content:** Source badge (`LineBadge` for originating task type or host), title (full width, no truncation), dedup collapse (multiple advisories with identical titles collapse into one card with count badge `×5` and expandable list showing individual sources), source attribution (human-readable: `from research-scan on polaris` instead of raw site ID), action buttons (small outline buttons: Approve, Dismiss, Defer, Apply).

**List organization:** Grouped by resolution status. "Unresolved" (proposed, approved) always visible at top. "Resolved" (applied, dismissed, deferred) collapsible section with divider. Within each group, sorted by recency.

**Data source:** `GET /api/advisories` (optionally `?status=` filter), polled every 10s.

### Files

Browser-based file explorer with stable two-panel layout. Fixed-width tree sidebar (~260px, left) for hierarchical navigation, flexible content area (right) with breadcrumb navigation and flat directory listing. Type-aware file preview modal.

**Tree sidebar (`TreeNode.svelte`):** Persistent hierarchical file tree with expand/collapse. Clicking a directory selects it, syncing content area and breadcrumbs. Gains "selected" visual state for active directory.

**Content area (top to bottom):**
- **Breadcrumbs (`Breadcrumbs.svelte`):** Clickable path segments from root to current directory. Clicking a segment navigates tree and listing to that folder.
- **Directory listing (`DirectoryListing.svelte`):** Flat table of selected directory's contents. Columns: icon, name, size (human-readable), modified (relative time). Subdirectories first, then files, both sorted alphabetically. Clicking folder navigates into it; clicking file opens preview modal.

**File preview modal (`FilePreviewModal.svelte`):** Fixed-position backdrop overlay with centered content panel. Header: filename, download button, close button. Body renders content by type:

| Category | Extensions | Rendering |
|----------|-----------|-----------|
| Code | `.ts`, `.js`, `.py`, `.sql`, `.bash`, `.json`, `.yaml`, `.html`, `.css` | Shiki syntax highlighting (Tokyo Night theme) |
| Markdown | `.md` | `renderMarkdown()` (marked + Shiki + DOMPurify) |
| Image | `.png`, `.jpg`, `.gif`, `.svg`, `.webp` | `<img>` with `object-fit: contain`, base64 decoded to blob URL |
| Plain text | `.txt`, `.log`, `.env`, `.csv`, other text | `<pre>` with IBM Plex Mono |
| Binary fallback | Any `is_binary = 1` non-image | Metadata + download button, no preview |

Modal closes via close button, Escape key, or backdrop click. Focus trap active (`role="dialog"`, `aria-modal="true"`).

**Data flow:** `FilesView.svelte` holds state in Svelte 5 runes: `$state` for `files`, `selectedPath`, `selectedFile`, `expandedPaths`; `$derived` for `fileTree`, `currentDirectoryContents`, `breadcrumbSegments`. Content area reacts to `selectedPath` changes. Modal opens when `selectedFile` is set, fetches full content via `GET /api/files/*`, renders by type, revokes blob URLs on close.

**Real-time updates:** Existing `file_update` WebSocket event triggers full file list reload. If modal is open, previewed file's `modified_at` is compared to detect changes and re-fetch content.

### Skills

Browser-based skill management interface. List view with `DataTable`, expandable rows showing skill detail and rendered markdown content, actions (retire, re-activate), and create modal with dual modes (form, upload).

**Skills list (`DataTable`):** Columns: Name, Status (`StatusChip`: active = green, retired = gray), Description, Last Activated (relative time). Status filter toggles between all/active/retired views. Expandable row detail shows: `allowed_tools`, `compatibility`, `activation_count`, `content_hash`, rendered SKILL.md content.

**Create modal (`SkillCreateModal.svelte`):** Mode toggle: "Form" / "Upload". Form mode: name input (validated `/^[a-z0-9]+(-[a-z0-9]+)*$/`), description textarea, body editor (markdown), expandable Advanced section (`allowed_tools`, `compatibility`). Upload mode: file input accepts single `.md` file or `.zip` archive. Client-side validation provides immediate feedback; server errors display in modal.

**Actions:** Retire action (with optional reason), re-activate action.

**Data sources:** `GET /api/skills` (optionally `?status=active|retired`) polled every 5s. `GET /api/skills/:id` fetches individual skill (metadata + content + file list). `POST /api/skills` creates (multipart or JSON body). `POST /api/skills/:id/retire` retires. `POST /api/skills/:id/activate` re-activates.

**Content rendering:** SKILL.md rendered as formatted markdown using shared `renderMarkdown()` pipeline (Shiki syntax highlighting, DOMPurify sanitization). Rendered inline in expanded row via dynamic import + `{@html}`, with `:global(.md-content)` CSS rules.

### Metrics

Observability dashboard. Single-scroll layout with three metric sections (Tokens, Relay, Context) stacking vertically below a shared `DateRangeBar`. Charts built on LayerCake (headless SVG).

**Date range selector (`DateRangeBar.svelte`):** Preset buttons (24h/7d/30d/All) + custom date inputs. Range changes trigger re-fetch with 300ms debounce. Preset buttons switch range; custom date inputs allow arbitrary selection. Future end-date clamps to current time.

**Token usage section:** `MetroCard` row showing total tokens, total cost, turn count for selected range. Horizontal stacked bar chart (in/out per model, sorted descending by total). Cost timeline (area/line chart of cost over time, hourly buckets ≤48h, daily otherwise).

**Relay performance section:** `MetroCard` row showing success rate (color-coded), avg latency, expired count. Latency bar chart (avg + P95 per host, color-coded by health threshold). `DataTable` (50 most recent cycles, sortable columns, failure row accents).

**Context assembly section:** `MetroCard` row showing cache hit rate, budget pressure count, avg truncation. Cache hit timeline (line chart of cache hit % over time). Compact sparklines (pressure frequency, context utilization trends).

**Data source:** Single API endpoint `GET /api/metrics?from=<ISO>&to=<ISO>` returns `MetricsResponse { tokens: { byModel, timeline, totals }, relay: { byHost, recentCycles, totals }, context: { totals, timeline } }`. Response includes bucketing logic (hourly ≤48h, daily >48h). Polled every 30s when range includes "now".

**Key metric definitions:**
- **Cache hit rate:** Percentage of tokens served from prompt cache rather than re-processed. Formula: `cache_read / (cache_read + tokens_in)`. The dashboard displays the hit rate of the most recent turn in the range with `tokens_cache_read + tokens_in > 0` (not a window-averaged ratio), surfacing "is caching effective right now."
- **Budget pressure:** Occurs when assembled context approaches model's max token limit, triggering truncation or enrichment reduction.
- **Success rate:** `success_count / (success_count + failure_count + expired_count)` for relay cycles.

---

## Rendering Subsystems

### Markdown Rendering

Client-side markdown rendering pipeline for `assistant` and `user` messages (other roles remain plain text). Implemented in `lib/markdown.ts`, consumed by `MessageBubble.svelte`.

**Pipeline:**
1. Split input on `<thinking>...</thinking>` blocks (regex `/<thinking>([\s\S]*?)<\/thinking>/gi`)
2. For each text segment: `marked.parse(text)` → HTML
3. For each thinking segment: `<details class="thinking-block"><summary>Thinking...</summary>marked.parse(innerText)</details>`
4. Join all segment HTML
5. `DOMPurify.sanitize(combined, { ADD_ATTR: ['style'], ADD_TAGS: ['details', 'summary'] })`
6. Safe HTML string → Svelte `{@html}`

**Syntax highlighting:** Shiki highlighter (Tokyo Night theme) configured with `markedHighlight` extension. Lazy singleton — `createHighlighter()` called once on first use, cached at module level. Preloaded languages: javascript, typescript, sql, python, bash, json, yaml, html, css, plaintext.

**Styling:** `:global(.md-content ...)` selectors in `MessageBubble.svelte`. Headings scaled down (h1: 1.25rem, h2: 1.1rem, h3: 1rem). Tables wrapped in `.table-wrap { overflow-x: auto }`. Inline code: IBM Plex Mono, `var(--bg-2)` background, 3px border-radius. Thinking blocks: left border in `var(--line-6)` (Hanzomon purple, 0.75 opacity), `<summary>` in `var(--text-secondary)`.

**Security:** DOMPurify strips `<script>`, event handlers, `javascript:` URLs. Shiki's inline `style="color:..."` attributes preserved via `ADD_ATTR: ['style']`. `<details>`/`<summary>` tags preserved via `ADD_TAGS`.

### MCP Apps Integration

The web UI acts as an [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) **renderer** (not provider) for servers the agent already connects to. When an MCP server in `mcp.json` advertises the `io.modelcontextprotocol/ui` capability and binds UI resources to its tools, those tool results render as interactive apps inline in the conversation. The agent calls tools server-side as normal — the browser is purely a renderer, never a second tool provider. Renderer and sourcing live entirely in the web router (`:3001`), never touching the sync router.

**Config and discovery:** App-bearing servers discovered by joining `mcp.json` (agent's server-side connections) against synced **capability inventory** (`hosts.mcp_capabilities`, captured at connect time, records each server's `serverInfo` and per-tool `ui://` resource bindings). `GET /api/mcp-apps` (`routes/mcp-apps.ts`) returns the browser-reachable subset (`http`/`sse` transports) as same-origin `proxyPath`s plus each server's UI-bearing `tools`; the real upstream `url` and auth `headers` stay server-side and are injected by the proxy. `stdio` servers excluded (browser cannot reach).

**Bootstrap (`lib/mcp-apps-bootstrap.ts`, run once from `App.svelte`'s `onMount`):** Fetch app-bearing server list, `connectToMcpServer` to each through same-origin proxy (Streamable HTTP with SSE fallback), `listTools`. Connection exists so renderer can read server's `ui://` app resources and route an app's `AppBridge.callServerTool` callbacks back to server — does NOT register tools on `BoundClient`. Per-server connect failures logged and skipped. Populated `McpAppHost` exposed via `mcpAppHost` store.

**Render trigger (`lib/mcp-app-store.ts`, `components/McpAppPanel.svelte`):** Renderer watches conversation message stream for tool results on tools the capability inventory flags as UI-bearing; match registers `McpAppInstance` (keyed by tool call id) in `mcpAppInstances` store, and `LineView` renders `McpAppPanel` for it.

**Sandbox (`lib/mcp-app-frame.ts`, `lib/mcp-app-bridge.ts`, `components/McpAppPanel.svelte`):** Each app renders in single iframe sandboxed to **opaque origin** (`sandbox="allow-scripts allow-forms"`, no `allow-same-origin`), with app HTML delivered via `srcdoc`. Requested CSP applied via injected `<meta http-equiv>` tag. Host↔app channel is MCP Apps `postMessage` protocol (ext-apps `PostMessageTransport` validates window identity via `event.source`, works against opaque origin). Trade-off: opaque-origin apps cannot use `localStorage`/`sessionStorage`.

---

## Data Fetching and State

**Polling:** All views use 5-second `setInterval` for data refresh (10s for Network Status, 30s for Metrics), matching the belt-and-braces pattern established across the codebase. Cleanup in `onDestroy`.

**WebSocket:** Shared `WebSocket` connection at `/ws` (managed by `lib/websocket.ts`). `wsEvents` writable store appends incoming frames (`WebSocketMessage[]`). Components subscribe via `connectWebSocket()` + `subscribeToThread(threadId)`. Connection lifecycle: `open` re-sends subscriptions, `message` parses and appends to `wsEvents`, `close` clears `ws` reference. No automatic reconnection (reconnects on next `connectWebSocket()` call).

**Server-push event types:**

| Event bus event | WS frame type | Routing | Payload |
|----------------|---------------|---------|---------|
| `message:created` | `"message:created"` | Thread subscribers | Full message object |
| `message:broadcast` | `"message:created"` | Thread subscribers | Re-emitted assistant responses |
| `task:completed` | `"task_update"` | All clients | `{ taskId, status: "completed" }` |
| `file:changed` | `"file_update"` | All clients | `{ path, operation }` |
| `alert:created` | `"alert"` | Thread subscribers | Full alert message object |
| `context:debug` | `"context:debug"` | Thread subscribers | `{ turn_id, debug }` |

**State management:** Svelte 5 runes (`$state`, `$derived`, `$effect`) for component-local state. No external stores except shared `wsEvents` and `modelStore` (selected model ID).

**API client (`lib/api.ts`):** Singleton `api` object wrapping `fetch` calls with typed response parsing. Internal helper `fetchJson<T>(url, options?)` throws `Error` from `response.json().error` if not OK, otherwise returns parsed body as `T`. Methods: `listThreads`, `createThread`, `getThread`, `getTask`, `listMessages`, `sendMessage`, `getContextDebug`, `getMemoryGraph`, etc.

**Error handling:** All routes return errors as `{ error: string, details?: unknown }` with appropriate HTTP status codes. UI displays error states with descriptive messages (not blank pages).
