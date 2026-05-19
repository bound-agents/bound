# Observability Dashboard Implementation Plan — Phase 4

**Goal:** Token usage and cost visualization with MetroCards and LayerCake charts — stacked bar chart per model, cost timeline over time

**Architecture:** Install LayerCake v10+ as a dependency. Create two chart components (TokenBarChart, CostTimeline) using LayerCake's headless SVG rendering with `getContext('LayerCake')` for scales. MetroCards display totals. Layout uses CSS Grid.

**Tech Stack:** Svelte 5, LayerCake v10 (headless charting), d3-scale (via LayerCake), SVG rendering, TypeScript

**Scope:** 7 phases from original design (this is phase 4 of 7)

**Codebase verified:** 2026-05-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### observability-dashboard.AC2: Token usage and cost dashboard
- **observability-dashboard.AC2.1 Success:** MetroCards display total tokens, total cost, and turn count for selected range
- **observability-dashboard.AC2.3 Success:** Bar chart shows per-model token usage with stacked in/out segments, sorted descending
- **observability-dashboard.AC2.4 Success:** Cost timeline displays cost over time with appropriate bucketing (hourly ≤48h, daily otherwise)
- **observability-dashboard.AC2.5 Failure:** Model with zero turns in range does not appear in bar chart

---

<!-- START_TASK_1 -->
### Task 1: Install LayerCake dependency

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/web/package.json` — add `layercake` to dependencies

**Implementation:**

From the worktree root, run:
```bash
cd packages/web && bun add layercake
```

This installs LayerCake v10.0.2+ which has full Svelte 5 runes support. LayerCake pulls in `d3-scale` as a peer dependency — verify it's resolved after install.

**Verification:**
Run: `bun install` (from project root)
Expected: Installs without errors, no peer dependency warnings for layercake

Run: `bun run typecheck`
Expected: No new type errors

**Commit:** `chore(web): add layercake charting dependency`
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-3) -->
<!-- START_TASK_2 -->
### Task 2: Create TokenBarChart component

**Verifies:** observability-dashboard.AC2.3, observability-dashboard.AC2.5

**Files:**
- Create: `packages/web/src/client/components/TokenBarChart.svelte`

**Implementation:**

A horizontal stacked bar chart showing per-model token usage. Each row is a model, with stacked segments for tokens_in (input) and tokens_out (output).

Props:
```typescript
interface Props {
	data: Array<{
		model_id: string;
		tokens_in: number;
		tokens_out: number;
	}>;
}
```

Key behavior:
- Data should already be sorted descending by total tokens (API does this, but defensive sort in component too)
- Models with zero total tokens should be filtered out (AC2.5)
- Use LayerCake with `<Svg>` container
- Container height: dynamic based on row count (`rowCount * 40px + padding`)
- Container width: 100% of parent
- X scale: linear, domain [0, max total tokens across all models]
- Y scale: ordinal/band, one band per model_id

Rendering inside the `<Svg>`:
- For each model (row): render two `<rect>` elements side by side
  - First rect (tokens_in): starts at x=0, width = xScale(tokens_in), fill = `var(--line-3)` (blue)
  - Second rect (tokens_out): starts at x=xScale(tokens_in), width = xScale(tokens_out), fill = `var(--line-0)` (amber)
- Model label on the left outside the chart area (via left padding)
- Tooltip on hover showing exact token counts (simple title attribute or custom tooltip div)

Use `getContext('LayerCake')` inside a child component to access scales:
```svelte
<script lang="ts">
  import { getContext } from 'svelte';
  const { xScale, yScale, width, height, data } = getContext('LayerCake');
</script>
```

Color legend below the chart: small colored squares with labels "Input" and "Output".

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

**Commit:** `feat(web): add TokenBarChart component with stacked horizontal bars`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Create CostTimeline component

**Verifies:** observability-dashboard.AC2.4

**Files:**
- Create: `packages/web/src/client/components/CostTimeline.svelte`

**Implementation:**

A time-series area chart showing cost over time (bucketed by the API into hourly or daily).

Props:
```typescript
interface Props {
	data: Array<{
		date: string;
		cost_usd: number;
	}>;
}
```

Key behavior:
- Parse `date` strings into Date objects for the x scale
- X scale: `scaleTime()` (from d3-scale, re-exported by LayerCake or import separately)
- Y scale: `scaleLinear()`, domain [0, max cost_usd] with `.nice()`
- Container height: fixed 200px
- Container width: 100%

Rendering inside `<Svg>`:
- Area fill below the line: a `<path>` with fill color `var(--line-0)` at ~20% opacity
- Line on top: a `<path>` with stroke `var(--line-0)`, strokeWidth 2
- X-axis ticks: rendered as text labels along the bottom
- Y-axis ticks: rendered as text labels along the left, formatted as USD (`$0.12`)

Build the SVG `d` attribute for the path using the scale functions from context:
```svelte
const pathData = $derived.by(() => {
    return data.map((d, i) => {
        const x = $xGet(d);
        const y = $yGet(d);
        return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    }).join(' ');
});
```

For the area, close the path down to the baseline (y=height) and back to start.

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

**Commit:** `feat(web): add CostTimeline area chart component`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: Integrate Token section into MetricsView

**Verifies:** observability-dashboard.AC2.1, observability-dashboard.AC2.3, observability-dashboard.AC2.4

**Files:**
- Modify: `packages/web/src/client/views/MetricsView.svelte` — add token section content

**Implementation:**

In MetricsView.svelte, after the first `<SectionHeader>` (for the Token section):

1. Add MetroCard row with CSS Grid layout:
   ```css
   .metrics-cards {
       display: grid;
       grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
       gap: 16px;
       margin: 16px 0;
   }
   ```

2. Three MetroCards showing:
   - **Total Tokens**: `data.tokens.totals.tokens_in + data.tokens.totals.tokens_out` formatted with `toLocaleString()`
   - **Total Cost**: `$${data.tokens.totals.cost_usd.toFixed(4)}` (4 decimal places for small costs)
   - **Turn Count**: `data.tokens.totals.turn_count.toLocaleString()`

   Each MetroCard uses a different accent color from the Tokyo Metro palette:
   - Tokens: `var(--line-3)` (blue)
   - Cost: `var(--line-0)` (amber)
   - Turns: `var(--line-5)` (green)

3. Content area inside MetroCard (using snippet children):
   ```svelte
   <MetroCard accentColor="var(--line-3)">
       {#snippet children()}
           <span class="metric-label">Total Tokens</span>
           <span class="metric-value">{totalTokens.toLocaleString()}</span>
       {/snippet}
   </MetroCard>
   ```

4. Below the cards, render TokenBarChart and CostTimeline:
   ```svelte
   <TokenBarChart data={data.tokens.byModel} />
   <CostTimeline data={data.tokens.timeline} />
   ```

5. Add derived computations:
   ```typescript
   const totalTokens = $derived(data ? data.tokens.totals.tokens_in + data.tokens.totals.tokens_out : 0);
   ```

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

Manual: Start dev server, verify MetroCards appear with data and charts render with bars/lines.

**Commit:** `feat(web): integrate token usage section with MetroCards and charts`
<!-- END_TASK_4 -->
