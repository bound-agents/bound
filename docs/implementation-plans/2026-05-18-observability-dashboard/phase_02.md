# Observability Dashboard Implementation Plan — Phase 2

**Goal:** Metrics tab visible in navigation, renders a loading state, fetches data on mount with polling

**Architecture:** New MetricsView.svelte component following NetworkStatus.svelte pattern — Page wrapper, SectionHeader, $state for data, fetch+poll lifecycle via onMount/onDestroy.

**Tech Stack:** Svelte 5 (runes, snippets), Hono fetch API, TypeScript

**Scope:** 7 phases from original design (this is phase 2 of 7)

**Codebase verified:** 2026-05-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### observability-dashboard.AC1: Metrics tab exists and follows UI conventions
- **observability-dashboard.AC1.1 Success:** Tab 09 "Metrics" appears in TopBar navigation and routes to `#/metrics`
- **observability-dashboard.AC1.2 Success:** MetricsView renders inside `<Page>` wrapper with SectionHeader components

---

<!-- START_TASK_1 -->
### Task 1: Create MetricsView.svelte skeleton

**Verifies:** observability-dashboard.AC1.2

**Files:**
- Create: `packages/web/src/client/views/MetricsView.svelte`

**Implementation:**

Create the view component following the NetworkStatus.svelte pattern:

- `<script lang="ts">` with Svelte 5 runes
- Import `Page` from `../components/Page.svelte` and `SectionHeader` from `../components/SectionHeader.svelte`
- Import `onMount`, `onDestroy` from `svelte`
- Import the `MetricsResponse` type from `../../server/routes/metrics` (exported in Phase 1, Task 1). This ensures a single source of truth shared by the API route, tests, and view component.
- State: `let data: MetricsResponse | null = $state(null)`, `let loading = $state(true)`, `let error: string | null = $state(null)`
- State for date range: `let from = $state("")`, `let to = $state("")` (initialized to 24h preset in onMount)
- `loadMetrics()` async function: fetches `/api/metrics?from=${from}&to=${to}`, handles response/error
- `onMount`: initialize date range to last 24h, call `loadMetrics()`, set up 30-second polling interval (only fires when range includes "now")
- `onDestroy`: clear interval
- Template: `<Page>` wrapper with `{#snippet children()}` containing three `<SectionHeader>` placeholders for Tokens, Relay, Context sections
- Loading state: "Loading metrics..." text
- Error state: error message display
- Data state: placeholder text per section (actual charts come in later phases)

The 30-second poll interval matches the design spec. Only poll when the selected range includes the current time (all presets do; custom past-only ranges skip polling).

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

**Commit:** `feat(web): add MetricsView skeleton with fetch and polling lifecycle`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Register route in App.svelte

**Verifies:** observability-dashboard.AC1.1

**Files:**
- Modify: `packages/web/src/client/App.svelte` — add route case for `#/metrics` in the if-else chain (around lines 38-56)

**Implementation:**

Add a new route case in the existing if-else routing chain in App.svelte:
- Route: `metrics` (when `route === "metrics"`)
- Import: `import MetricsView from "./views/MetricsView.svelte"`
- Render: `<MetricsView />`

The route variable is derived from `window.location.hash` — strip the `#/` prefix. Pattern matches existing routes like `timetable`, `network`, `advisories`, etc.

Also update the `screenLabel()` function in App.svelte to include the metrics route. Add a case returning `"09 Metrics"` for the metrics route (matching the design's tab 09 designation for the screen label, while TopBar uses sequential "08" for visual ordering).

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

**Commit:** `feat(web): register metrics route in App.svelte`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add tab to TopBar.svelte navigation

**Verifies:** observability-dashboard.AC1.1

**Files:**
- Modify: `packages/web/src/client/components/TopBar.svelte` — add entry to the `NAV` array (around lines 17-25)

**Implementation:**

Add a new entry to the `NAV` array:
```typescript
{ hash: "#/metrics", route: "08", label: "Metrics" },
```

Note: The design plan specifies "tab 09" but the TopBar currently numbers tabs 01-07 (Skills is 07). The next sequential number is "08". Use "08" to maintain sequential ordering in the TopBar.

Place it at the end of the NAV array (after Skills).

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

Manual: Open http://localhost:3001 and verify "08 Metrics" tab appears in the TopBar and clicking it navigates to `#/metrics`.

**Commit:** `feat(web): add Metrics tab to TopBar navigation`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Verify end-to-end tab rendering

**Verifies:** observability-dashboard.AC1.1, observability-dashboard.AC1.2

**Files:**
- No new files — verification only

**Implementation:**

This is a verification task. Run the full type check and ensure the web package builds:

1. Run `bun run typecheck` — all packages should pass
2. Run `bun run build` — verify the Svelte build succeeds with the new component
3. Optionally start the dev server and verify the tab renders at `#/metrics`

**Verification:**
Run: `bun run typecheck && bun run build`
Expected: Both pass without errors

**Commit:** No commit needed — this is verification only.
<!-- END_TASK_4 -->
