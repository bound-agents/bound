# Web UI Redesign: Cohesive Metro Design System

This document describes the redesign of the `@bound/web` Svelte 5 client. The redesign preserves the Tokyo Metro visual metaphor but redirects it from decorative track visualizations to meaningful, information-dense interfaces. Each view gets one signature metro-inspired element while sharing a unified component library.

## Table of Contents

1. [Design Principles](#design-principles)
2. [Shared Design System](#shared-design-system)
   - [Design Tokens](#design-tokens)
   - [Shared Components](#shared-components)
   - [Typography Hierarchy](#typography-hierarchy)
   - [Spacing System](#spacing-system)
3. [View Redesigns](#view-redesigns)
   - [System Map](#system-map)
   - [LineView (Thread Detail)](#lineview-thread-detail)
   - [Timetable](#timetable)
   - [Network Status](#network-status)
   - [Advisories](#advisories)
   - [Files](#files)
   - [TopBar](#topbar)
4. [Removed Elements](#removed-elements)
5. [New API Requirements](#new-api-requirements)

---

## Design Principles

1. **Metro metaphor earns its place through meaning.** Line colors represent categorization. Station nodes represent memory entries. Track diagrams represent real topology. Nothing is purely decorative.
2. **Information-first, personality second.** Every pixel of space given to a metro visual element must justify itself against the information it displaces.
3. **One signature element per view.** Each view gets one metro-inspired feature that fits its context. The rest of the view is built from shared components.
4. **Shared foundation, consistent feel.** A single component library (MetroCard, DataTable, StatusChip, LineBadge) used across all views. No view invents its own card or table style.
5. **The Files view is the north star.** Clean two-column layout, good information density, professional feel. Every view should aspire to this energy.

---

## Shared Design System

### Design Tokens

**Line Colors** — kept as-is from the existing palette. Used for **categorization only**:

| Var | Name | Hex | Assignment |
|-----|------|-----|------------|
| `--line-0` | Ginza | `#F39700` | Thread index 0, TopBar "System Map" |
| `--line-1` | Marunouchi | `#E60012` | Thread index 1, TopBar "Timetable" |
| `--line-2` | Hibiya | `#9CAEB7` | Thread index 2 |
| `--line-3` | Tozai | `#009BBF` | Thread index 3, TopBar "Files" |
| `--line-4` | Chiyoda | `#009944` | Thread index 4, TopBar "Network" |
| `--line-5` | Yurakucho | `#C1A470` | Thread index 5 |
| `--line-6` | Hanzomon | `#8F76D6` | Thread index 6, tool call groups |
| `--line-7` | Namboku | `#00AC9B` | Thread index 7, user messages, send button |
| `--line-8` | Fukutoshin | `#9C5E31` | Thread index 8 |
| `--line-9` | Oedo | `#B6007A` | Thread index 9, TopBar "Advisories" |

Each thread's color is determined by the `color` field assigned at creation time: `lineColors[thread.color % 10]`. This is the existing behavior in the database (the `threads` table has a `color` integer column, cycled sequentially via `lastThread.color + 1` on creation). The current SystemMap.svelte already reads this field — the bug causing all-orange threads is in the color assignment or lookup, not in the schema. This redesign preserves the existing `thread.color` mechanism.

For non-thread entities that need a LineBadge color (hosts, tasks, advisories), the following rules apply:
- **Hosts**: `lineColors[hostIndex % 10]` where `hostIndex` is the host's position in the sorted hosts list (by `host_name` or `site_id`). Alternatively, derive from a hash of `site_id` for stability.
- **Tasks**: Derive from task type: `cron` → Ginza (`0`), `heartbeat` → Namboku (`7`), `deferred` → Tozai (`3`), `event` → Hanzomon (`6`).
- **Advisories**: Inherit the color of the source entity (task or host). Fall back to `--alert-warning` orange if source is unknown.

**Text Colors** — referenced across components:

| Token | Hex | Usage |
|-------|-----|-------|
| `--text-primary` | `#E8E8E8` | High contrast, headings, titles |
| `--text-secondary` | `#A0A0B0` | Mid-tone, summaries, descriptions |
| `--text-muted` | `#6B6B80` | Subtle, timestamps, inactive labels |

**Surface Hierarchy** — strict three-level system:

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-primary` | `#1A1A2E` | Page background |
| `--bg-secondary` | `#16213E` | Cards, panels, elevated surfaces |
| `--bg-surface` | `#0F3460` | Interactive elements, hover states, inputs |

No additional surface colors. Views must not invent their own backgrounds.

**Status Colors** — used identically across all views:

| Token | Hex | Meaning |
|-------|-----|---------|
| `--status-active` | `#69F0AE` | Running, healthy, online |
| `--alert-warning` | `#FF9100` | Pending, delayed, degraded |
| `--alert-disruption` | `#FF1744` | Failed, error, unreachable |
| `--text-muted` | `#6B6B80` | Idle, cancelled, dismissed |

### Shared Components

#### LineBadge

Circle badge with line letter. Used across all views for identity.

- Size: 32px (standard), 20px (compact/inline)
- Appearance: Line-colored background circle, white single letter centered (the metro line code: G, M, H, T, C, Y, Z, N, F, E)
- Props: `lineIndex: number`, `size?: "standard" | "compact"`

#### MetroCard

The single card style used for all card-like containers.

- Background: `var(--bg-secondary)`
- Border: `1px solid var(--bg-surface)`
- Border radius: `8px`
- Optional left accent border: `3px solid var(--line-N)` (the card's associated line color)
- Hover state: Background shifts to `rgba(15, 52, 96, 0.3)` (current `--bg-surface` at 30% opacity)
- Props: `accentColor?: string`, `interactive?: boolean`

Replaces: Thread rows, advisory cards, network host cards, task row expansion panels. Every view uses this one card.

#### StatusChip

Small status indicator pill.

- Appearance: Colored dot (6px) + uppercase label in `--text-xs`, `letter-spacing: 0.04em`
- Color determined by status: active (green), pending (orange), failed (red), idle/cancelled (muted)
- Optional animation: `badge-pulse` for running/active states
- Props: `status: "active" | "pending" | "failed" | "idle" | "cancelled" | "delayed" | "overdue"`

Replaces: The 5+ different status badge implementations across views.

#### DataTable

Consistent table component for tabular data.

- Sticky header row with uppercase labels, `--text-xs`, `--text-muted` color
- Monospace font for data columns (IDs, timestamps, counts)
- Row hover: subtle background shift
- Sortable columns: Click header to sort, indicator arrow
- Optional row expansion: Click row to reveal detail panel
- Props: `columns: Column[]`, `data: Row[]`, `sortable?: boolean`, `expandable?: boolean`

Replaces: Timetable grid, Sync Mesh table, any future tabular display.

#### SectionHeader

View title bar with consistent sizing.

- Title: `--text-xl`, font-weight 700
- Subtitle: `--text-sm`, uppercase, `--text-muted`, `letter-spacing: 0.06em`
- Optional action area (right-aligned): buttons, dropdowns, filter chips
- Props: `title: string`, `subtitle?: string`, `children?: Snippet` (action slot)

### Typography Hierarchy

Font stacks unchanged. Enforcement tightened:

| Token | Size | Usage |
|-------|------|-------|
| `--text-xl` | `1.5rem` | View titles only (via SectionHeader) |
| `--text-lg` | `1.25rem` | Section headers within views |
| `--text-base` | `1rem` | Body text, message content |
| `--text-sm` | `0.875rem` | Metadata, secondary info, card subtitles |
| `--text-xs` | `0.75rem` | Badges, chips, table headers, timestamps |

### Spacing System

4px base grid, applied consistently:

| Context | Value |
|---------|-------|
| Card internal padding | `12px` or `16px` |
| Gap between cards/rows | `8px` |
| View content margin | `24px` |
| Section gap (between groups) | `16px` |
| Inline element gap | `8px` |

---

## View Redesigns

### System Map

**Signature element: Memory station graph (context companion)**

#### Layout

Split view matching the Files view's two-column pattern:

```
┌─────────────────────┬──────────────────────────────┐
│   Thread List        │   Memory Station Map          │
│   (~40% width)       │   (~60% width)                │
│                      │                               │
│  ● G  Research...    │      ○──●──○                  │
│  ● M  MCP Debug...   │      |    \                   │
│  ● H  Heartbeat...   │      ○    ●─○                 │
│                      │                               │
└─────────────────────┴──────────────────────────────┘
```

- Resizable divider between panels (drag to resize)
- Map panel is collapsible — collapse to get a full-width thread list

**Responsive behavior**: At viewport widths below `900px`, the Memory Station Map panel collapses to a toggle button in the SectionHeader. Tapping the toggle shows the map as a full-width overlay panel above the thread list (slide-down animation). The thread list becomes full-width single-column. This matches the Files view's responsive pattern (at narrow widths, the tree sidebar should also collapse similarly).

#### Thread List (left panel)

Each thread is a **MetroCard** row:

- **LineBadge** (32px, deterministic color from thread index)
- **Title** — full width, up to two lines allowed, no aggressive truncation
- **Summary line** — thread's generated `summary` field, `--text-sm`, `--text-secondary`, single line with ellipsis
- **Metadata row** — relative timestamp, message count, model pill, StatusChip
- **Left accent border** in the thread's line color

No track visualization. No stations. No horizontal bars. The LineBadge + accent border carries the metro identity.

**Sorting**: By last activity (current behavior). Visual separator between "active today" and "older" — subtle divider with muted date label.

**"+ New Line" button**: Keep in SectionHeader action area.

#### Memory Station Map (right panel)

Graph visualization where nodes are memory entries and edges are memory relations.

**Node styling by tier**:

| Tier | Size | Style | Visibility |
|------|------|-------|------------|
| `pinned` | 12px | Bold ring, filled center | Always visible |
| `summary` | 8px | Double ring | Always visible |
| `default` | 6px | Single ring | Always visible |
| `detail` | 4px | Small filled dot | Only when parent summary is selected/highlighted |

**Node color**: Derived from the thread that created the memory (via `source` provenance → thread lookup → line color). Memories contributed to by multiple threads get a split or gradient marker.

**Edge styling**: Lines between connected memory nodes. Color from relation type or source thread. `summarizes` edges use a dashed line style to distinguish from other relation types.

**Graph layout**: Hierarchical/layered layout with static positioning (no force-directed physics).

Layout algorithm:
- **Layer assignment**: Three horizontal bands — pinned nodes at top, summary nodes in middle, default/detail nodes at bottom. Layer Y-offsets: `pinned: 40px`, `summary: 160px`, `default: 280px` from canvas top. Adjust dynamically if a layer is empty.
- **X-coordinate assignment within layers**: Nodes ordered by `modifiedAt` descending (most recently modified on the left). Equal horizontal spacing with a minimum of `60px` between node centers.
- **Overflow handling**: If a layer has more nodes than fit in the panel width, the layer scrolls horizontally (overflow-x: auto on the layer row). Alternatively, nodes beyond a threshold (e.g., 20 per layer) are collapsed into a `+N more` indicator that expands on click.
- **Canvas sizing**: Width matches the panel width. Height is fixed at 3 layers × ~120px spacing = ~360px, with scroll if detail nodes expand below.
- **Edge routing**: Straight lines between connected nodes. Edges that cross layers route vertically. No edge crossing minimization needed for the initial implementation — the layout is simple enough that crossings are acceptable.

**Context companion behavior**:

| State | Behavior |
|-------|----------|
| No thread selected | Full graph visible, pinned + summary tiers only. Detail nodes hidden. |
| Thread selected | Memories from that thread at full opacity. Everything else dimmed to ~20%. Detail nodes connected to highlighted summaries expand into view. Smooth 200ms transition. |
| Hover on node | Tooltip: memory key, value preview (truncated ~100 chars), tier badge, source thread name, modified date. |
| Click on node | Small detail popover with full memory content. Link to source thread if applicable. |
| Loading | Skeleton placeholder with pulsing dots at the 3 layer positions. Shown on initial mount and when switching thread selection triggers a re-fetch. |
| Error (fetch failed) | Muted message centered in panel: "Could not load memory graph" with a retry button. Panel still renders at full size. |
| Empty graph (zero memories) | Friendly empty state: a single muted station icon with text "No memories yet — they'll appear here as the agent learns." |
| Thread selected, zero connected memories | Full graph stays visible (dimmed). A muted label at the top of the panel: "No memories linked to this thread." No nodes highlighted. |

**Data source**: New API endpoint (see [New API Requirements](#new-api-requirements)) returning semantic_memory + memory_edges for the graph.

**Update strategy**: Fetch on view mount. Re-fetch when thread selection changes (debounced 200ms). No WebSocket subscription needed — memories change infrequently and the graph is not latency-sensitive. A manual refresh button in the panel header provides explicit re-fetch for users who want to see recent changes.

### LineView (Thread Detail)

**Signature element: Station-dot turn indicator**

#### Layout

Vertical flex column (keep current structure), with width constraint:

- **Header**: Back button (`‹ Map`), thread title (full, not truncated), LineBadge, StatusChip, debug toggle
- **Message area**: `max-width: 800px`, centered. Prevents text from stretching across wide viewports.
- **Input area**: Same max-width. Attach button + textarea + emerald send button (keep `--line-7`).

#### Station-dot turn indicator

Thin vertical "metro line" running down the left margin of the message list:

- 2px vertical line in the thread's line color
- 6px station dot at each turn boundary (user message → agent response = one turn)
- Latest turn's dot pulses gently (`badge-pulse` animation)
- During active thinking: dashed line animation extends below the last station dot
- This is additive and restrained — a subtle visual rhythm, not a centerpiece

#### Message bubbles

Role-based coloring using **MetroCard** as the base:

| Role | Left accent color | Background tint |
|------|-------------------|-----------------|
| User | `--line-7` (emerald) | `rgba(0, 172, 155, 0.1)` |
| Assistant | Thread's own line color | `rgba(line-color, 0.08)` |
| Tool group | `--line-6` (Hanzomon purple), dashed | `rgba(143, 118, 214, 0.06)` |
| Tool error | `--alert-disruption` | `rgba(255, 23, 68, 0.06)` |
| System | No border | Transparent, centered, italic |

Assistant messages use the **thread's line color** for their left accent, not always Ginza orange. This means different threads have different visual personalities.

**Model pill**: Moved to message metadata row (bottom of bubble) alongside timestamp, rather than floating at top.

### Timetable

**Signature element: Departure board header**

#### Departure board strip

Compact "next departures" panel at the top of the view:

- Dark inset panel (`--bg-primary` background, on `--bg-secondary` page)
- Maximum height ~120px
- Each upcoming task as a single line: `LineBadge (compact 20px) · task name · countdown to next run · ON TIME | DELAYED | OVERDUE`
- Monospace font for countdown times, slight letter-spacing
- Shows next 3-5 scheduled tasks only
- "DELAYED": task is past its scheduled time but hasn't started. "OVERDUE": last run failed.

#### Main table

**DataTable** with these columns:

| Column | Content | Width |
|--------|---------|-------|
| Status | StatusChip | 100px |
| Name | Human-readable task name extracted from payload (cron key name for cron tasks, action description for deferred) | 1fr |
| Type | Small colored pill: `cron`, `deferred`, `event`, `heartbeat` | 100px |
| Schedule | Human-readable: `every 15m`, `hourly`, `one-time` | 120px |
| Next Run | Relative countdown or absolute date | 100px |
| Last Run | Relative time | 100px |
| Duration | How long last run took | 80px |
| Host | Host **name** (from `hosts.host_name`), not truncated site ID | 120px |
| Actions | Cancel button (if applicable), error badge (if failed) | 70px |

**Removed columns**: Raw ID (available in row expansion), raw JSON trigger.

**Default sort**: Primary by status weight (Running > Failed > Pending > Cancelled > Completed), secondary by next_run ascending. Active cron tasks with upcoming runs stay near the top. Completed one-shots and cancelled tasks sink.

**Section separator**: Subtle divider between active tasks (running/failed/pending) and inactive tasks (cancelled/completed) with muted "INACTIVE" group label.

**Row expansion**: Click to reveal full details — payload JSON, execution history, consecutive failures, associated thread link. Row expansion replaces the current `TaskDetailView` (`/task/:id` route), which is removed. All task detail is accessible inline via the expandable row. The `/task/:id` route is removed from the router in `App.svelte`.

**Filtering**: Quick-filter chips above the table for status (Pending, Running, Failed, Cancelled) alongside the existing "All Services" dropdown.

### Network Status

**Signature element: Line topology schematic**

#### Topology diagram

Compact transit-line schematic at the top (~150px tall):

- Hub node rendered as large "interchange" station (double circle) in center
- Spoke nodes on branches, each with their LineBadge
- Connection lines colored by sync health:
  - Green: healthy (recent sync, no errors)
  - Orange: degraded (high error count or stale)
  - Red: unreachable (beyond reachability threshold)
  - Grey: no sync data
- Static layout, not interactive. Sized like a metro wayfinding sign.

#### Host cards

Each host as a **MetroCard**:

- **Header**: LineBadge + host name (fall back to truncated site ID if unnamed) + StatusChip
- **Status semantics fix**: "Online" = last seen within reachability threshold. "Offline" = beyond threshold. Sync health is a separate field, not conflated with online status. No more "Offline" + "Sync: Healthy" contradiction.
- **Key-value rows**: Site ID (full, copy-on-click), Last Seen, Sync Status, Last Sync, Models (as small pills), MCP Tools (as small pills)
- **Border color**: Host's LineBadge color. Red border ONLY for genuinely unreachable hosts.

#### Sync Mesh table

**DataTable** with properly sized columns:

| Column | Content |
|--------|---------|
| Peer | Host **name**, not raw ID |
| Sent | HLC timestamp (full width, or truncated with tooltip) |
| Received | HLC timestamp |
| Last Sync | Relative time |
| Errors | Count with color coding (0 = green, >0 = orange/red) |

### Advisories

**Signature element: Service disruption severity banding**

#### Severity bands

Solid color bar across the top of each advisory card (4px height):

| Status | Band color | Card treatment |
|--------|-----------|----------------|
| Proposed | `--alert-warning` (orange) | Orange accent, full opacity |
| Approved | `--status-active` (green) | Green accent |
| Failed/escalated | `--alert-disruption` (red) | Red accent, subtle red glow (`box-shadow`) |
| Dismissed/deferred | None | Muted opacity, visually recedes |
| Applied | `--line-6` (Hanzomon purple) | Purple accent, completed feel |

#### Card content

- **Source badge**: LineBadge for the originating task type or host, replacing the meaningless star icon
- **Title**: Full width, no truncation
- **Dedup collapse**: Multiple advisories with identical titles collapse into one card with a count badge (`×5`) and expandable list showing individual sources
- **Source attribution**: Human-readable: `"from research-scan on polaris"` instead of raw site ID
- **Action buttons**: Small outline buttons in card footer (Approve, Dismiss, Defer, Apply). Not prominent CTAs.

#### List organization

Grouped by resolution status:
1. **Unresolved** (proposed, approved) — always visible at top
2. **Resolved** (applied, dismissed, deferred) — collapsible section with divider

Within each group, sorted by recency.

### Files

**Lightest touch — alignment pass only.**

- Align TreeNode, DirectoryListing, FilePreviewModal to shared MetroCard / DataTable components
- Directory icons use a neutral shared color (Yurakucho gold `--line-5` for folders, keep existing per-type colors for files)
- FilePreviewModal: Align border/radius/spacing to MetroCard system
- No signature metro element needed — the two-column layout is the signature, and it's already good

### TopBar

**Minor evolution, not a rethink.**

- **Nav dots**: Replace generic dots with consistent per-nav color assignment:
  - System Map → Ginza orange (`--line-0`)
  - Timetable → Marunouchi red (`--line-1`)
  - Network → Chiyoda green (`--line-4`)
  - Files → Tozai blue (`--line-3`)
  - Advisories → Oedo ruby (`--line-9`)
- **Advisory counter**: Keep pulsing dot (works well)
- **Model selector**: Keep as-is
- **Logo**: Keep concentric circle. Optional future polish: refine toward metro roundel shape.

---

## Removed Elements

The following elements from the current UI are removed in this redesign:

| Element | Location | Reason |
|---------|----------|--------|
| SVG gradient interchange splines | SystemMap.svelte | No meaningful information conveyed, visual noise |
| Horizontal track-rail visualization | SystemMap.svelte | Decorative, consumes space needed for information |
| Station dots on track | SystemMap.svelte | Meaningless — don't represent real data points |
| Train indicator animation | SystemMap.svelte | Decorative, no information value |
| Track terminus pulse | SystemMap.svelte | Replaced by StatusChip for thread activity state |
| Thread row hover dimming | SystemMap.svelte | Tied to removed interchange splines |
| Raw JSON in trigger column | Timetable.svelte | Replaced by human-readable name + schedule columns |
| Raw site ID as host display | Timetable, Network, Advisories | Replaced by host name lookup |
| Star icon type badge | AdvisoryView.svelte | Replaced by source-aware LineBadge |
| TaskDetailView route (`/task/:id`) | App.svelte, TaskDetailView.svelte | Replaced by inline row expansion in Timetable |

---

## New API Requirements

The memory station map requires data not currently exposed by the web API:

### `GET /api/memory/graph`

Returns the memory graph for visualization.

**Response shape**:
```ts
interface MemoryGraphResponse {
  nodes: Array<{
    key: string;
    value: string;           // full memory content
    tier: "pinned" | "summary" | "default" | "detail";
    source: string | null;   // provenance (thread_id, task_id, or "agent")
    sourceThreadTitle: string | null;  // resolved thread title for display
    lineIndex: number | null;          // resolved thread line color index
    modifiedAt: string;
  }>;
  edges: Array<{
    sourceKey: string;
    targetKey: string;
    relation: string;
    modifiedAt: string;   // edge creation/modification timestamp
  }>;
}
```

**Implementation**: Query `semantic_memory WHERE deleted = 0` joined with `memory_edges WHERE deleted = 0`. Resolve source provenance to thread titles and line indices via lookup. Cache-friendly (memories change infrequently).

### `GET /api/threads` enhancement

Current response should be augmented with:
- `summary: string | null` — already exists in the threads table, may not be returned in the API response currently
- `messageCount: number` — count of messages in the thread
- `lastModel: string | null` — model used in the most recent assistant turn

These fields support the richer thread list display.

### `GET /api/tasks` enhancement

Current response should return:
- `displayName: string` — human-readable task name extracted from payload (cron key name, deferred description, etc.)
- `schedule: string | null` — human-readable schedule (`every 15m`, `hourly`, etc.)
- `lastDurationMs: number | null` — duration of the last run. Computed server-side as the difference between the task's `claimed_at` timestamp and the most recent turn's `created_at` for the task's associated thread. Returns `null` if the task has never run or has no associated turns.
- `hostName: string | null` — resolved host name from hosts table

These fields support the Timetable redesign without requiring the client to parse raw JSON payloads.
