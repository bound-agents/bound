# Observability Dashboard Implementation Plan — Phase 6

**Goal:** Cache hit rate, budget pressure, and context utilization visualization with timeline charts and sparklines

**Architecture:** CacheHitTimeline component using LayerCake for line chart of cache hit % over time. Compact sparklines for budget pressure frequency and context utilization trends. MetroCards for summary stats.

**Tech Stack:** Svelte 5, LayerCake (installed in Phase 4), SVG rendering, TypeScript

**Scope:** 7 phases from original design (this is phase 6 of 7)

**Codebase verified:** 2026-05-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### observability-dashboard.AC4: Context assembly metrics
- **observability-dashboard.AC4.1 Success:** MetroCards display cache hit rate, budget pressure count, and avg truncation
- **observability-dashboard.AC4.3 Success:** Cache hit timeline shows percentage over time as line chart
- **observability-dashboard.AC4.4 Success:** Budget pressure sparkline shows truncation frequency trend
- **observability-dashboard.AC4.5 Failure:** Turns without context_debug are excluded from context metrics (no NaN/divide-by-zero)
- **observability-dashboard.AC4.6 Edge:** Zero cache_read tokens in range shows 0% hit rate (not undefined)

---

## Important: context_debug JSON Structure

**Codebase investigation revealed the actual field names differ from the design document's assumptions.** The `context_debug` column contains a JSON object with these relevant fields:

```typescript
interface ContextDebugInfo {
    contextWindow: number;      // max tokens for model
    totalEstimated: number;     // total tokens used in assembly
    budgetPressure: boolean;    // true when headroom < 2000 tokens
    truncated: number;          // count of MESSAGES removed (not tokens)
    model: string;              // model used
}
```

**Cache hit rate** is NOT stored in `context_debug`. It must be computed from the `turns` table columns:
- `tokens_cache_read` (INTEGER, nullable) — tokens served from cache
- `tokens_in` (INTEGER NOT NULL) — total input tokens
- Formula: `COALESCE(tokens_cache_read, 0) / NULLIF(tokens_cache_read + tokens_in, 0)`

**Context utilization** must be computed from: `totalEstimated / contextWindow` (both from the JSON).

The design plan's assumed key `cacheHitRate` does NOT exist in the JSON. The design plan's assumed key `truncatedTokens` is actually `truncated` and contains message count (not token count). **Phase 1, Task 4 already uses the correct field names and calculation methods (corrected during planning).**

---

<!-- START_TASK_1 -->
### Task 1: Verify and finalize context assembly queries

**Verifies:** observability-dashboard.AC4.5, observability-dashboard.AC4.6

**Files:**
- Modify: `packages/web/src/server/routes/metrics.ts` — verify context queries use correct fields

**Implementation:**

Phase 1, Task 4 already implements the context queries with the correct field names (verified during planning). This task confirms correctness and adds any missing edge case handling:

1. **Cache hit rate**: Compute from `turns` TABLE COLUMNS (not JSON):
   ```sql
   AVG(
       CAST(COALESCE(tokens_cache_read, 0) AS REAL) /
       NULLIF(COALESCE(tokens_cache_read, 0) + tokens_in, 0)
   )
   ```
   - When both `tokens_cache_read` IS NULL and `tokens_in` > 0: `0 / tokens_in = 0` (AC4.6: 0% not undefined)
   - When `tokens_in = 0` AND `tokens_cache_read = 0`: NULLIF returns NULL, AVG ignores it (no divide-by-zero)

2. **Budget pressure count**: JSON field is boolean `budgetPressure`:
   ```sql
   SUM(CASE WHEN json_extract(context_debug, '$.budgetPressure') = 1 THEN 1 ELSE 0 END)
   ```
   Note: SQLite stores JSON `true` as integer `1`, `false` as `0`.

3. **Average truncation** (messages removed, not tokens):
   ```sql
   AVG(COALESCE(CAST(json_extract(context_debug, '$.truncated') AS INTEGER), 0))
   ```

4. **Context utilization** for timeline:
   ```sql
   AVG(
       CAST(json_extract(context_debug, '$.totalEstimated') AS REAL) /
       NULLIF(CAST(json_extract(context_debug, '$.contextWindow') AS INTEGER), 0)
   )
   ```

5. **Filter** (AC4.5): All context queries include `AND context_debug IS NOT NULL` to exclude turns without debug info.

6. **Timeline bucketing**: Same hourly/daily logic as token timeline. Per bucket compute:
   - `cache_hit_rate`: average of per-turn cache hit rates (from table columns)
   - `budget_pressure_pct`: `SUM(budgetPressure=1) / COUNT(*)` as percentage
   - `avg_context_utilization`: average of `totalEstimated / contextWindow`

**Verification:**
Run: `bun test packages/web/src/server/__tests__/metrics-route.test.ts`
Expected: Context metrics tests pass with correct field extraction

**Commit:** `fix(web): use correct context_debug field names and cache hit calculation`
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-3) -->
<!-- START_TASK_2 -->
### Task 2: Create CacheHitTimeline component

**Verifies:** observability-dashboard.AC4.3

**Files:**
- Create: `packages/web/src/client/components/CacheHitTimeline.svelte`

**Implementation:**

A line chart showing cache hit percentage over time using LayerCake.

Props:
```typescript
interface Props {
	data: Array<{
		date: string;
		cache_hit_rate: number;   // 0.0 to 1.0
	}>;
}
```

Key behavior:
- X scale: `scaleTime()` from parsed date strings
- Y scale: `scaleLinear()`, domain [0, 1] (percentage, always 0-100%)
- Container height: 180px
- Container width: 100%

Rendering:
- Line chart with stroke `var(--line-5)` (green — cache is good!), strokeWidth 2
- Area fill below line at 15% opacity
- Y-axis: show percentage labels (0%, 25%, 50%, 75%, 100%)
- X-axis: date labels matching the token timeline
- Horizontal grid lines at 25% intervals (light gray, `var(--rule-faint)`)

If data array is empty or all values are 0, show a flat line at 0% with subtle "No cache data" text.

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

**Commit:** `feat(web): add CacheHitTimeline line chart component`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Integrate context section into MetricsView

**Verifies:** observability-dashboard.AC4.1, observability-dashboard.AC4.3, observability-dashboard.AC4.4

**Files:**
- Modify: `packages/web/src/client/views/MetricsView.svelte` — add context assembly section

**Implementation:**

In MetricsView.svelte, after the relay section, add the context assembly section:

1. **SectionHeader:**
   ```svelte
   <SectionHeader number={3} subtitle="Context Pipeline Performance" title="Context Assembly" />
   ```
   Note: `number` is section-relative within MetricsView (1=Tokens, 2=Relay, 3=Context).

2. **MetroCard row** (AC4.1):
   - **Cache Hit Rate**: `${(data.context.totals.avg_cache_hit_rate * 100).toFixed(1)}%`
     - Accent: rate >= 0.8 → `var(--ok)`, >= 0.5 → `var(--warn)`, else `var(--err)`
   - **Budget Pressure**: `${data.context.totals.budget_pressure_count}` turns
     - Accent: count === 0 → `var(--ok)`, else `var(--warn)`
   - **Avg Truncation**: `${data.context.totals.avg_truncated_tokens.toFixed(1)} msgs` (note: it's message count despite field name)
     - Accent: `var(--line-3)` (blue, neutral)

3. **CacheHitTimeline chart** (AC4.3):
   ```svelte
   <CacheHitTimeline data={data.context.timeline} />
   ```

4. **Compact sparkline row** (AC4.4) — reuse the ContextSparkline SVG pattern for a budget pressure frequency sparkline:
   - Create inline SVG sparklines (not full LayerCake — these are small, simple)
   - Budget pressure sparkline: shows percentage of turns with budget pressure per time bucket
   - Context utilization sparkline: shows average utilization ratio per time bucket
   - Use the same WIDTH=288, HEIGHT=48 pattern from ContextSparkline.svelte
   - Normalize data points to [0, 1] range, render as filled polygon + polyline
   - Color: budget pressure uses `var(--warn)`, utilization uses `var(--line-3)`

   Layout: two sparklines side by side in a flex row with labels above each:
   ```svelte
   <div class="sparkline-row">
       <div class="sparkline-item">
           <span class="sparkline-label">Budget Pressure Frequency</span>
           <svg>...</svg>
       </div>
       <div class="sparkline-item">
           <span class="sparkline-label">Context Utilization</span>
           <svg>...</svg>
       </div>
   </div>
   ```

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

Manual: Verify context section renders with MetroCards, timeline, and sparklines.

**Commit:** `feat(web): integrate context assembly section with cache timeline and sparklines`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
