# Observability Dashboard Implementation Plan — Phase 7

**Goal:** Loading states, empty states, error handling, responsive layout, and tooltip interactions for all dashboard sections

**Architecture:** Follow established codebase patterns: `.state` div with italic text for loading, `.state.err` for errors, conversational empty messages, single 960px responsive breakpoint, native HTML `title` tooltips on chart elements.

**Tech Stack:** Svelte 5, CSS (no additional dependencies), native HTML title attributes

**Scope:** 7 phases from original design (this is phase 7 of 7)

**Codebase verified:** 2026-05-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### observability-dashboard.AC1: Metrics tab exists and follows UI conventions (partial)
- **observability-dashboard.AC1.3 Failure:** API error displays error state with descriptive message (not blank page)
- **observability-dashboard.AC1.4 Edge:** Empty date range (no turns in period) shows informative empty state

---

<!-- START_TASK_1 -->
### Task 1: Add loading and error states to MetricsView

**Verifies:** observability-dashboard.AC1.3

**Files:**
- Modify: `packages/web/src/client/views/MetricsView.svelte` — add loading/error rendering

**Implementation:**

Update MetricsView.svelte to follow the established pattern from NetworkStatus.svelte and other views:

1. **Loading state** — shown while fetching:
   ```svelte
   {#if loading}
       <div class="state">
           <p>Loading metrics…</p>
       </div>
   {:else if error}
       <div class="state err">
           <p>{error}</p>
       </div>
   {:else if data}
       <!-- existing content sections -->
   {/if}
   ```

2. **Error handling** in the `loadMetrics()` function:
   ```typescript
   async function loadMetrics(): Promise<void> {
       loading = true;
       error = null;
       try {
           const res = await fetch(`/api/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
           if (!res.ok) {
               const body = await res.json().catch(() => ({}));
               error = body.error || `Request failed (${res.status})`;
               return;
           }
           data = await res.json();
       } catch (err) {
           console.error("Failed to load metrics:", err);
           error = "Failed to load metrics. Check network connection.";
       } finally {
           loading = false;
       }
   }
   ```

3. **CSS** (use existing global `.state` class from App.svelte, add `.err` variant):
   ```css
   .state.err {
       color: var(--err);
   }
   ```

The key requirement from AC1.3: API errors MUST show a descriptive message, never a blank page. The `.state.err` container ensures visibility even when `data` is null.

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

Manual: Temporarily break the API (wrong URL) and verify error state appears with message.

**Commit:** `feat(web): add loading and error states to MetricsView`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add empty state handling

**Verifies:** observability-dashboard.AC1.4

**Files:**
- Modify: `packages/web/src/client/views/MetricsView.svelte` — add empty state checks per section

**Implementation:**

When data exists but contains no meaningful content for a section, show informative empty messages.

1. **Token section empty state**: Check if `data.tokens.totals.turn_count === 0`:
   ```svelte
   {#if data.tokens.totals.turn_count === 0}
       <div class="state">
           <p>No turns recorded in the selected range.</p>
       </div>
   {:else}
       <!-- MetroCards + charts -->
   {/if}
   ```

2. **Relay section empty state**: Already handled in Phase 5 (check `total_cycles === 0`). Verify it's present.

3. **Context section empty state**: Check if `data.context.totals.total_turns_with_debug === 0`:
   ```svelte
   {#if data.context.totals.total_turns_with_debug === 0}
       <div class="state">
           <p>No context debug data in the selected range.</p>
       </div>
   {:else}
       <!-- MetroCards + charts + sparklines -->
   {/if}
   ```

4. **Global empty state** (AC1.4): When ALL sections are empty (no turns AND no relay cycles AND no context debug), show a single top-level empty message:
   ```svelte
   {#if data.tokens.totals.turn_count === 0 && data.relay.totals.total_cycles === 0}
       <div class="state">
           <p>No data recorded in the selected range. Try expanding the date range.</p>
       </div>
   {:else}
       <!-- individual sections with their own empty checks -->
   {/if}
   ```

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

Manual: Select a future date range (no data) and verify empty state message appears.

**Commit:** `feat(web): add empty state handling for all metrics sections`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add responsive layout breakpoint

**Verifies:** observability-dashboard.AC1.2 (follows UI conventions)

**Files:**
- Modify: `packages/web/src/client/views/MetricsView.svelte` — add responsive CSS

**Implementation:**

Follow the established single-breakpoint pattern used across the codebase:

```css
@media (max-width: 960px) {
    .metrics-cards {
        grid-template-columns: 1fr;
    }

    .sparkline-row {
        flex-direction: column;
    }

    .chart-container {
        min-height: 150px;
    }
}
```

Key responsive adjustments:
- **MetroCard grid**: Switch from `repeat(auto-fill, minmax(200px, 1fr))` to single column
- **Sparkline row**: Stack vertically instead of side-by-side
- **Chart containers**: Reduce minimum height for narrow viewports
- **DataTable**: Already handles overflow via horizontal scroll (built into component)

The `repeat(auto-fill, minmax(200px, 1fr))` pattern already handles intermediate sizes well (it's auto-responsive), so the 960px breakpoint primarily addresses very narrow viewports where even the minimum 200px cards would overflow.

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

Manual: Resize browser below 960px and verify layout adapts (cards stack, sparklines stack).

**Commit:** `feat(web): add responsive breakpoint for metrics view`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Add tooltip interactions to chart elements

**Verifies:** observability-dashboard.AC2.3, observability-dashboard.AC3.3, observability-dashboard.AC4.3

**Files:**
- Modify: `packages/web/src/client/components/TokenBarChart.svelte` — add title attributes
- Modify: `packages/web/src/client/components/CostTimeline.svelte` — add title attributes
- Modify: `packages/web/src/client/components/LatencyBarChart.svelte` — add title attributes
- Modify: `packages/web/src/client/components/CacheHitTimeline.svelte` — add title attributes

**Implementation:**

Follow the established pattern from ContextBar.svelte — use native HTML `title` attributes on SVG elements for hover information.

1. **TokenBarChart** — on each bar segment `<rect>`:
   ```svelte
   <rect
       ...dimensions...
       title="{model}: {tokens.toLocaleString()} tokens ({type})"
   />
   ```
   Note: SVG `<rect>` doesn't support `title` directly. Use a `<title>` child element instead:
   ```svelte
   <rect ...>
       <title>{model}: {segment.toLocaleString()} tokens ({type})</title>
   </rect>
   ```

2. **CostTimeline** — add invisible hit-area `<rect>` elements over each data point (same pattern as ContextSparkline):
   ```svelte
   {#each data as point, i}
       <rect
           x={xGet(point) - 8}
           y={0}
           width={16}
           height={$height}
           fill="transparent"
       >
           <title>{point.date}: ${point.cost_usd.toFixed(4)}</title>
       </rect>
   {/each}
   ```

3. **LatencyBarChart** — on each latency bar:
   ```svelte
   <rect ...>
       <title>{host}: {type} {value}ms</title>
   </rect>
   ```

4. **CacheHitTimeline** — same invisible hit-area pattern as CostTimeline:
   ```svelte
   <rect ...>
       <title>{point.date}: {(point.cache_hit_rate * 100).toFixed(1)}% cache hit</title>
   </rect>
   ```

This approach is consistent with existing chart interactions and requires no additional dependencies.

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

Manual: Hover over chart bars and timeline points to verify browser tooltips appear.

**Commit:** `feat(web): add native tooltips to all chart elements`
<!-- END_TASK_4 -->
