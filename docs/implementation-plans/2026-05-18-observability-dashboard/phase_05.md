# Observability Dashboard Implementation Plan — Phase 5

**Goal:** Relay latency and success rate visualization with per-host breakdown, DataTable for recent cycles, and summary MetroCards

**Architecture:** LatencyBarChart component using LayerCake for per-host avg/p95 horizontal bars. DataTable (existing component) for relay cycle history with rowAccent on failures. MetroCards for summary stats.

**Tech Stack:** Svelte 5, LayerCake (installed in Phase 4), DataTable component, StatusChip, TypeScript

**Scope:** 7 phases from original design (this is phase 5 of 7)

**Codebase verified:** 2026-05-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### observability-dashboard.AC3: Relay performance dashboard
- **observability-dashboard.AC3.1 Success:** MetroCards display success rate, avg latency, and expired count for selected range
- **observability-dashboard.AC3.3 Success:** Latency bar chart shows avg and p95 per host, color-coded by health threshold
- **observability-dashboard.AC3.4 Success:** DataTable shows 50 most recent relay cycles with sortable columns and failure row accents
- **observability-dashboard.AC3.5 Failure:** No relay_cycles in range shows empty state (not error)
- **observability-dashboard.AC3.6 Edge:** Single host in cluster still renders bar chart with one row

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Create LatencyBarChart component

**Verifies:** observability-dashboard.AC3.3, observability-dashboard.AC3.6

**Files:**
- Create: `packages/web/src/client/components/LatencyBarChart.svelte`

**Implementation:**

A horizontal grouped bar chart showing average and P95 latency per host, color-coded by health thresholds.

Props:
```typescript
interface Props {
	data: Array<{
		peer_site_id: string;
		avg_latency_ms: number;
		p95_latency_ms: number;
		success_count: number;
		failure_count: number;
	}>;
}
```

Key behavior:
- Each host gets two bars: one for avg_latency_ms, one for p95_latency_ms
- X scale: linear, domain [0, max p95_latency_ms across all hosts] with `.nice()`
- Y scale: ordinal/band with two sub-bands per host (avg + p95)
- Container height: dynamic based on host count (`hostCount * 60px + padding`)
- Container width: 100%

Color-coding based on health thresholds (following NetworkStatus pattern):
- avg_latency_ms < 500ms: `var(--ok)` (green)
- avg_latency_ms 500-2000ms: `var(--warn)` (amber)
- avg_latency_ms > 2000ms: `var(--err)` (red)

For P95 bars, use the same color logic but at 50% opacity to distinguish from avg.

Rendering:
- Host label on left (mono font, truncated site ID to last 8 chars for readability)
- Two `<rect>` per host, vertically stacked within the band
- Small text label at end of each bar showing the value (e.g., "234ms")
- Legend: "Avg" (solid) and "P95" (semi-transparent)

Handles AC3.6 (single host): works naturally since it just renders one row.

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

**Commit:** `feat(web): add LatencyBarChart with health-threshold coloring`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Integrate relay section into MetricsView

**Verifies:** observability-dashboard.AC3.1, observability-dashboard.AC3.3, observability-dashboard.AC3.4, observability-dashboard.AC3.5

**Files:**
- Modify: `packages/web/src/client/views/MetricsView.svelte` — add relay section content

**Implementation:**

In MetricsView.svelte, after the token section, add the relay performance section:

1. **SectionHeader:**
   ```svelte
   <SectionHeader number={2} subtitle="Local-only — reflects this node's observations" title="Relay Performance" />
   ```
   Note: `number` is section-relative within MetricsView (1=Tokens, 2=Relay, 3=Context), not a global tab number.

2. **Empty state check** (AC3.5): If `data.relay.totals.total_cycles === 0`, render an informative empty state message:
   ```svelte
   {#if data.relay.totals.total_cycles === 0}
       <p class="empty-state">No relay cycles recorded in the selected range.</p>
   {:else}
       <!-- MetroCards + chart + table -->
   {/if}
   ```

3. **MetroCard row** (same grid pattern as token section):
   - **Success Rate**: `${(data.relay.totals.success_rate * 100).toFixed(1)}%`
     - Accent color: success_rate >= 0.95 → `var(--ok)`, >= 0.80 → `var(--warn)`, else `var(--err)`
   - **Avg Latency**: `${Math.round(data.relay.totals.avg_latency_ms)}ms`
     - Accent: `var(--line-3)` (blue, neutral)
   - **Expired Count**: `${data.relay.totals.expired_count}`
     - Accent: expired > 0 → `var(--warn)`, else `var(--ok)`

4. **LatencyBarChart:**
   ```svelte
   <LatencyBarChart data={data.relay.byHost} />
   ```

5. **DataTable** for recent cycles (AC3.4):
   ```svelte
   <DataTable
       columns={relayCycleColumns}
       rows={relayCycleRows}
       sortable={true}
       rowAccent={relayRowAccent}
   />
   ```

   Column definitions:
   ```typescript
   const relayCycleColumns = [
       { key: "peer_site_id", label: "Peer", width: "1fr", mono: true, sortable: true },
       { key: "direction", label: "Direction", width: "100px", sortable: true },
       { key: "kind", label: "Kind", width: "100px", sortable: true },
       { key: "latency_ms", label: "Latency", width: "100px", mono: true, sortable: true },
       { key: "success", label: "Status", width: "80px", sortable: true },
       { key: "created_at", label: "Time", width: "140px", sortable: true },
   ];
   ```

   Row accent function:
   ```typescript
   function relayRowAccent(row: Record<string, unknown>): string | null {
       if (row.success === false) return "var(--err)";
       if (row.expired === true) return "var(--warn)";
       return null;
   }
   ```

   Transform `recentCycles` for display: format `created_at` with `formatRelativeTime()`, map `success` boolean to "OK"/"FAIL" text, format `latency_ms` with "ms" suffix.

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

Manual: Verify relay section renders with DataTable showing sortable columns and red accents on failure rows.

**Commit:** `feat(web): integrate relay performance section with DataTable and charts`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->
