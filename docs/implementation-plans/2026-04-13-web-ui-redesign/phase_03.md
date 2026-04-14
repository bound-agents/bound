# Web UI Redesign — Phase 3: System Map Redesign

**Goal:** Replace the current SystemMap (track visualization + interchange splines) with a split-view thread list and memory station graph.

**Architecture:** Rewrite SystemMap.svelte as a two-column layout. Left panel: thread list using shared components (MetroCard, LineBadge, StatusChip, SectionHeader). Right panel: new MemoryGraph.svelte component rendering an SVG graph of memory nodes and edges.

**Tech Stack:** Svelte 5, SVG, shared components from Phase 1, API from Phase 2

**Scope:** 8 phases from original design (phase 3 of 8)

**Codebase verified:** 2026-04-13

**Investigation findings:**
- SystemMap.svelte is 764 lines. Core sections: script (1-249), markup (251-367), styles (369-764).
- Data fetching: `api.listThreads()` every 5s, `api.getInterchange()` for spline data, per-thread status polling.
- Thread color: `LINE_COLORS[thread.color % LINE_COLORS.length]` — correctly uses `thread.color` field.
- Interchange spline system: `computeSplines()` function (lines 126-211), SVG `<linearGradient>` + cubic Bezier paths. All of this is removed.
- Client API pattern: `fetchJson<T>(url)` in `api.ts`.

---

## Acceptance Criteria Coverage

### ui-redesign.AC6: System Map thread list
- **ui-redesign.AC6.1 Success:** Thread list shows LineBadge with correct line color per thread
- **ui-redesign.AC6.2 Success:** Thread list shows full title (up to 2 lines), summary, message count, relative time, StatusChip
- **ui-redesign.AC6.3 Success:** Thread list sorts by last activity with "today" / "older" visual separator
- **ui-redesign.AC6.4 Success:** Clicking a thread navigates to LineView

### ui-redesign.AC7: Memory station map
- **ui-redesign.AC7.1 Success:** Memory graph renders nodes styled by tier (pinned=12px, summary=8px, default=6px, detail=4px)
- **ui-redesign.AC7.2 Success:** Memory graph renders edges between connected nodes
- **ui-redesign.AC7.3 Success:** Selecting a thread highlights its memories and dims others to ~20% opacity
- **ui-redesign.AC7.4 Success:** Hovering a node shows tooltip with key, value preview, tier, source
- **ui-redesign.AC7.5 Success:** Map panel is collapsible
- **ui-redesign.AC7.6 Success:** Empty/loading/error states render correctly

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Create ThreadList component

**Verifies:** ui-redesign.AC6.1, ui-redesign.AC6.2, ui-redesign.AC6.3, ui-redesign.AC6.4

**Files:**
- Create: `packages/web/src/client/components/ThreadList.svelte`

**Implementation:**

Svelte 5 component that renders the redesigned thread list.

Props:
- `threads: Thread[]` — thread data (enhanced with `messageCount`, `lastModel`)
- `threadStatuses: Map<string, { active: boolean }>` — live status per thread
- `selectedThreadId?: string | null` — currently selected thread (for memory map highlighting)
- `onSelectThread?: (threadId: string) => void` — selection callback
- `onNavigateThread?: (threadId: string) => void` — navigation callback (double-click or Enter)

Render each thread as a **MetroCard** (import from `./shared`) with `interactive={true}` and `accentColor` from `getLineColor(thread.color)`:
- **LineBadge** (import from `./shared`): `lineIndex={thread.color}`
- **Title**: `thread.title ?? "Untitled"`, `--text-base`, max 2 lines with `-webkit-line-clamp: 2`
- **Summary**: `thread.summary`, `--text-sm`, `--text-secondary`, single line ellipsis
- **Metadata row**: Flex with gap 8px. Relative time from `thread.last_message_at` (use a simple `formatRelativeTime()` helper). Message count badge. Model pill if `lastModel` exists. **StatusChip** if thread is active.

**Group separator**: Compute "today" vs "older" groups from `thread.last_message_at`. Insert a divider `<div>` with muted date label between groups.

Click handler: `onSelectThread(thread.id)`. Double-click / keyboard Enter: `onNavigateThread(thread.id)` → triggers hash navigation to `/line/{threadId}`.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

**Commit:** `feat(web): add ThreadList shared component`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create MemoryGraph component

**Verifies:** ui-redesign.AC7.1, ui-redesign.AC7.2, ui-redesign.AC7.3, ui-redesign.AC7.4, ui-redesign.AC7.6

**Files:**
- Create: `packages/web/src/client/components/MemoryGraph.svelte`

**Implementation:**

SVG-based graph visualization of the memory station map. This is the signature metro element.

Props:
- `selectedThreadId?: string | null` — thread to highlight (context companion mode)
- `onNodeClick?: (key: string) => void` — optional node click handler

Internal state:
- `let graphData = $state<MemoryGraphResponse | null>(null)`
- `let loading = $state(true)`
- `let error = $state<string | null>(null)`
- `let hoveredNode = $state<string | null>(null)`
- `let tooltipPos = $state<{ x: number; y: number } | null>(null)`

Fetch data via `api.getMemoryGraph()` on mount (using `$effect`). Re-fetch when `selectedThreadId` changes (debounce 200ms via `setTimeout`/`clearTimeout` pattern inside the `$effect` — Svelte 5 `$effect` does not have built-in debounce, so use a local timer variable).

**Panel header**: Include a small refresh button (circular arrow icon) in the top-right of the map panel that calls `api.getMemoryGraph()` to re-fetch. This is the explicit re-fetch mechanism per the design doc.

**Layout algorithm** (per design doc):
- Three horizontal layers: pinned (Y=40), summary (Y=160), default (Y=280)
- Nodes within each layer ordered by `modifiedAt` descending, spaced 60px apart
- Detail nodes (Y=360) only visible when a connected summary is highlighted
- If layer has >20 nodes, show first 20 + a `+N more` text indicator

**SVG rendering**:
- Nodes: `<circle>` elements. Size by tier (pinned=12px radius, summary=8px, default=6px, detail=4px). Fill color from `lineIndex` → `getLineColor()`, fallback to `--text-muted`.
- Node ring styles: pinned = bold stroke (3px), summary = double ring (two concentric circles), default = single ring (1.5px), detail = filled dot.
- Edges: `<line>` elements between connected node centers. Stroke color from source node. `summarizes` edges use `stroke-dasharray: "6 3"`.
- When `selectedThreadId` is set: nodes with matching `lineIndex` get full opacity, others get `opacity: 0.2`. Transition: `opacity 200ms ease`.

**States**:
- Loading: Render 3 pulsing placeholder dots at layer Y positions.
- Error: Centered muted text "Could not load memory graph" + retry button.
- Empty (0 nodes): Single muted station icon + "No memories yet — they'll appear here as the agent learns."
- Selected thread, 0 matching memories: Full graph dimmed, muted label "No memories linked to this thread."

**Tooltip**: Absolutely positioned `<div>` shown on node hover. Contains: key (bold), value preview (truncated 100 chars), tier badge (StatusChip), source thread name, modified date.

**Node click popover**: When a node is clicked, render an absolutely positioned detail panel (similar to tooltip but larger, fixed width ~300px):
- Full memory `key` as header
- Full `value` content (scrollable if long, max-height 200px)
- Tier badge (StatusChip)
- Source thread name + link (clicking navigates to `/line/{threadId}`)
- Modified date
- Close button (X) or click-outside-to-dismiss
- Track `let activePopoverNode = $state<string | null>(null)` — only one popover at a time.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

**Commit:** `feat(web): add MemoryGraph component`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Create graph layout utility with tests

**Verifies:** ui-redesign.AC7.1, ui-redesign.AC7.2

**Files:**
- Create: `packages/web/src/client/lib/graph-layout.ts`
- Create: `packages/web/src/client/lib/__tests__/graph-layout.test.ts`

**Implementation:**

Pure utility functions for computing node positions from memory graph data:

`computeGraphLayout(nodes, edges, canvasWidth, selectedThreadId?)`:
- Returns `{ positionedNodes: Array<{ key, x, y, tier, color, opacity, radius }>, positionedEdges: Array<{ x1, y1, x2, y2, dashed, color, opacity }> }`
- Layer assignment by tier
- X spacing: max(60px, canvasWidth / nodesInLayer)
- Y positions: per design doc layer offsets
- Detail nodes only included when selectedThreadId highlights a connected summary
- Opacity: 1.0 for highlighted nodes, 0.2 for dimmed

**Testing:**
Tests must verify:
- Nodes are assigned correct Y positions by tier (pinned→40, summary→160, default→280)
- Nodes within a layer are spaced >= 60px apart
- Detail nodes are excluded when no selectedThreadId
- Detail nodes appear when their parent summary is highlighted
- Opacity is 1.0 for matching lineIndex, 0.2 for non-matching when selectedThreadId is set
- Edge positions connect correct node pairs
- Empty input returns empty arrays

**Verification:**
Run: `bun test packages/web/src/client/lib/__tests__/graph-layout.test.ts`
Expected: All tests pass

**Commit:** `feat(web): add graph layout utility with tests`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: Rewrite SystemMap.svelte

**Verifies:** ui-redesign.AC6.1, ui-redesign.AC6.2, ui-redesign.AC6.3, ui-redesign.AC6.4, ui-redesign.AC7.5

**Files:**
- Modify: `packages/web/src/client/views/SystemMap.svelte` (full rewrite — 764 lines → ~200 lines)

**Implementation:**

Replace the entire SystemMap with a clean two-column split view.

**Remove**: All spline computation (`computeSplines`, `rawSplines`, `interchangeSplines`), SVG interchange overlay, track-rail/station/terminus/train-indicator markup, all track-related CSS (~400 lines of styles), the `api.getInterchange()` fetch, `hoveredIdx`/`connectedThreadIds` state.

**New structure**:

Script section:
- Fetch threads via `api.listThreads()` on interval (keep 5s poll)
- Fetch thread statuses (keep existing pattern)
- Track `selectedThreadId` state for memory graph highlighting
- Track `mapCollapsed` state for panel toggle

Markup:
```svelte
<div class="system-map">
  <SectionHeader title="System Map">
    {#snippet actions()}
      <button on:click={toggleMap}>{mapCollapsed ? 'Show Map' : 'Hide Map'}</button>
      <button on:click={newThread}>+ New Line</button>
    {/snippet}
  </SectionHeader>

  <div class="split-view" class:map-collapsed={mapCollapsed}>
    <div class="thread-panel">
      <ThreadList
        {threads}
        {threadStatuses}
        {selectedThreadId}
        onSelectThread={(id) => selectedThreadId = id}
        onNavigateThread={(id) => navigateTo(`/line/${id}`)}
      />
    </div>
    {#if !mapCollapsed}
      <div class="resizer"><!-- drag handle --></div>
      <div class="map-panel">
        <MemoryGraph {selectedThreadId} />
      </div>
    {/if}
  </div>
</div>
```

Styles:
- `.split-view`: `display: grid; grid-template-columns: 40% 4px 1fr; height: calc(100vh - 120px); gap: 0`
- `.map-collapsed .split-view`: `grid-template-columns: 1fr`
- `.thread-panel`: `overflow-y: auto`
- `.map-panel`: `overflow: hidden; background: var(--bg-primary)`
- `.resizer`: `cursor: col-resize; background: var(--bg-surface); width: 4px; user-select: none`

**Drag-to-resize logic**: Add pointer event handlers on `.resizer`:
- `let panelRatio = $state(0.4)` — fraction of width for thread panel (default 40%)
- On `pointerdown` on resizer: set `resizing = true`, capture pointer
- On `pointermove` (window): compute new ratio from `event.clientX / containerWidth`, clamp between 0.2 and 0.8
- On `pointerup` (window): set `resizing = false`, release pointer
- Apply: `grid-template-columns: {panelRatio * 100}% 4px 1fr` dynamically via style binding
- Responsive: `@media (max-width: 900px)` → single column, map toggle becomes overlay

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

Run: `bun run build`
Expected: Build succeeds

**Commit:** `feat(web): rewrite SystemMap with split-view thread list and memory graph`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Add SystemMap e2e test

**Verifies:** ui-redesign.AC6.4, ui-redesign.AC7.5

**Files:**
- Modify: `e2e/web-chat.spec.ts` (add or extend existing SystemMap tests)

**Testing:**

The existing `web-chat.spec.ts` tests basic page loading and thread navigation. Add tests for:
- **AC6.4**: Verify clicking a thread in the list navigates to the line view (hash changes to `/line/{threadId}`)
- **AC7.5**: Verify the map collapse toggle button exists and clicking it hides/shows the memory graph panel

Follow existing Playwright patterns in the e2e directory.

**Verification:**
Run: `bun run test:e2e`
Expected: All e2e tests pass

**Commit:** `test(web): add SystemMap split-view e2e tests`
<!-- END_TASK_5 -->
