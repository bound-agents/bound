# Observability Dashboard Design

## Summary

This design adds a comprehensive observability dashboard to the Bound web UI as a new "Metrics" tab. The dashboard aggregates and visualizes three key operational areas: token usage and cost across LLM backends, relay performance between distributed hosts, and context assembly efficiency (cache hit rates, budget pressure, truncation patterns). All metrics are filtered by an interactive date range selector with presets (24h/7d/30d/All) and custom date inputs.

The implementation uses a single parameterized API endpoint (`GET /api/metrics?from=<ISO>&to=<ISO>`) that performs server-side aggregation across the `turns`, `relay_cycles`, and `context_debug` tables, returning a structured payload with per-model token breakdowns, per-host relay latencies, and context assembly statistics over time. The UI follows existing Svelte 5 conventions from the codebase (Tokyo Metro aesthetic, MetroCard summary components, DataTable for tabular data) and introduces LayerCake for interactive charting — adding stacked bar charts for token usage, timeline charts for cost trends, and line charts for cache hit rate evolution. Visualization and layout patterns are borrowed directly from existing views like NetworkStatus and Timetable, ensuring consistency with the established design system.

## Definition of Done

A comprehensive observability tab (tab 09) added to the Bound web UI, providing interactive exploration of token usage, cost, relay performance, and context assembly metrics across arbitrary date ranges. The tab follows existing Svelte 5 / Tokyo Metro conventions and is backed by parameterized API endpoints querying the `turns`, `relay_cycles`, and `context_debug` data sources.

Specifically:
1. A new "Metrics" tab (09) in the web UI following existing conventions (Svelte 5, hash-based routing, Tokyo Metro aesthetic, MetroCard/DataTable components)
2. Token usage and cost dashboard grouped by model, with interactive date range selection
3. Relay performance dashboard showing latency distribution, success/failure rates, and per-host breakdown with the same date filtering
4. Context assembly metrics including cache hit rates, budget pressure frequency, and truncation patterns
5. API endpoints backing the above with parameterized date-range queries

## Acceptance Criteria

### observability-dashboard.AC1: Metrics tab exists and follows UI conventions
- **observability-dashboard.AC1.1 Success:** Tab 09 "Metrics" appears in TopBar navigation and routes to `#/metrics`
- **observability-dashboard.AC1.2 Success:** MetricsView renders inside `<Page>` wrapper with SectionHeader components
- **observability-dashboard.AC1.3 Failure:** API error displays error state with descriptive message (not blank page)
- **observability-dashboard.AC1.4 Edge:** Empty date range (no turns in period) shows informative empty state

### observability-dashboard.AC2: Token usage and cost dashboard
- **observability-dashboard.AC2.1 Success:** MetroCards display total tokens, total cost, and turn count for selected range
- **observability-dashboard.AC2.2 Success:** Date range presets (24h/7d/30d/All) filter the displayed data correctly
- **observability-dashboard.AC2.3 Success:** Bar chart shows per-model token usage with stacked in/out segments, sorted descending
- **observability-dashboard.AC2.4 Success:** Cost timeline displays cost over time with appropriate bucketing (hourly ≤48h, daily otherwise)
- **observability-dashboard.AC2.5 Failure:** Model with zero turns in range does not appear in bar chart
- **observability-dashboard.AC2.6 Edge:** Custom date range with future end-date clamps to current time

### observability-dashboard.AC3: Relay performance dashboard
- **observability-dashboard.AC3.1 Success:** MetroCards display success rate, avg latency, and expired count for selected range
- **observability-dashboard.AC3.2 Success:** Same date range filter applies to relay section as token section
- **observability-dashboard.AC3.3 Success:** Latency bar chart shows avg and p95 per host, color-coded by health threshold
- **observability-dashboard.AC3.4 Success:** DataTable shows 50 most recent relay cycles with sortable columns and failure row accents
- **observability-dashboard.AC3.5 Failure:** No relay_cycles in range shows empty state (not error)
- **observability-dashboard.AC3.6 Edge:** Single host in cluster still renders bar chart with one row

### observability-dashboard.AC4: Context assembly metrics
- **observability-dashboard.AC4.1 Success:** MetroCards display cache hit rate, budget pressure count, and avg truncation
- **observability-dashboard.AC4.2 Success:** Same date range filter applies to context section
- **observability-dashboard.AC4.3 Success:** Cache hit timeline shows percentage over time as line chart
- **observability-dashboard.AC4.4 Success:** Budget pressure sparkline shows truncation frequency trend
- **observability-dashboard.AC4.5 Failure:** Turns without context_debug are excluded from context metrics (no NaN/divide-by-zero)
- **observability-dashboard.AC4.6 Edge:** Zero cache_read tokens in range shows 0% hit rate (not undefined)

### observability-dashboard.AC5: API endpoints with parameterized queries
- **observability-dashboard.AC5.1 Success:** `GET /api/metrics?from=<ISO>&to=<ISO>` returns MetricsResponse shape
- **observability-dashboard.AC5.2 Success:** Bucketing switches from hourly to daily based on range length (threshold: 48h)
- **observability-dashboard.AC5.3 Success:** Response includes all three sections (tokens, relay, context) in single payload
- **observability-dashboard.AC5.4 Failure:** Missing or invalid date parameters return 400 with descriptive error
- **observability-dashboard.AC5.5 Edge:** Very large range (all time) completes within reasonable time (<2s on 10k turns)

## Glossary

- **Svelte 5**: JavaScript UI framework used for the Bound web client. Version 5 introduces "runes" (reactive primitives like `$state`, `$derived`) replacing the older reactive syntax.
- **LayerCake**: Headless charting library for Svelte that provides responsive scales and layout calculations while leaving rendering (SVG/Canvas/HTML) to the developer. Official Svelte 5 runes support since v10.
- **MetroCard**: Reusable Svelte component in the Bound UI that displays a single metric with a title, value, and optional accent color (following Tokyo Metro aesthetic).
- **DataTable**: Reusable Svelte component that renders tabular data with sortable columns, row accents, and expandable rows.
- **Hono**: Lightweight web framework (similar to Express) used for the Bound server API routes.
- **Relay**: The distributed inference routing system in Bound. Hosts forward LLM requests to peers with available models and receive streamed responses via the sync protocol.
- **relay_cycles**: SQLite table (local-only, not synced) that records each relay inference request/response cycle with latency, success/failure, and peer metadata.
- **turns**: Synced SQLite table that records each agent loop iteration, including tokens consumed, cost, model used, and cache statistics.
- **context_debug**: JSON column on the `turns` table storing detailed context assembly metrics (budget pressure, truncation size, cache breakpoint placement, etc.).
- **Budget pressure**: Occurs when the assembled context approaches the model's maximum token limit, triggering truncation or enrichment reduction to stay within bounds.
- **Truncation**: Removal of older messages from the conversation history when the context exceeds the model's token limit. Measured in tokens removed.
- **Cache hit rate**: Percentage of tokens served from prompt cache (Anthropic/Bedrock feature) rather than re-processed, reducing latency and cost.
- **P95 latency**: 95th percentile latency — the value below which 95% of observations fall. Useful for identifying tail latencies.
- **strftime**: SQLite function for formatting timestamps into strings. Used for bucketing turns into hourly/daily groups.
- **Tokyo Metro aesthetic**: Visual design system for the Bound UI inspired by the Tokyo subway system — bold accent colors per "line," clean typography (Space Grotesk + JetBrains Mono), 8px border-radius.
- **onMount/onDestroy**: Svelte lifecycle hooks that run when a component is first rendered and when it's removed, respectively. Used for setting up polling intervals and cleanup.
- **WAL mode**: Write-Ahead Logging mode for SQLite, allowing concurrent reads while writes are in progress. Bound's database runs in WAL mode.

## Architecture

Single-scroll dashboard registered as tab 09 (`#/metrics`). Three metric sections (Tokens, Relay, Context) stack vertically below a shared DateRangeBar. Charts are built on LayerCake (~8-10KB gzipped, headless SVG, official Svelte 5 runes support since v10).

A single API endpoint serves all dashboard data:

```
GET /api/metrics?from=<ISO>&to=<ISO>
```

Response contract:

```typescript
interface MetricsResponse {
	tokens: {
		byModel: Array<{
			model_id: string;
			tokens_in: number;
			tokens_out: number;
			cache_read: number;
			cache_write: number;
			cost_usd: number;
			turn_count: number;
		}>;
		timeline: Array<{ date: string; tokens_in: number; tokens_out: number; cost_usd: number }>;
		totals: {
			tokens_in: number;
			tokens_out: number;
			cost_usd: number;
			turn_count: number;
			error_count: number;
		};
	};
	relay: {
		byHost: Array<{
			peer_site_id: string;
			avg_latency_ms: number;
			p95_latency_ms: number;
			success_count: number;
			failure_count: number;
			expired_count: number;
		}>;
		recentCycles: Array<{
			direction: string;
			peer_site_id: string;
			kind: string;
			latency_ms: number;
			success: boolean;
			expired: boolean;
			created_at: string;
		}>;
		totals: {
			total_cycles: number;
			success_rate: number;
			avg_latency_ms: number;
			expired_count: number;
		};
	};
	context: {
		totals: {
			avg_cache_hit_rate: number;
			budget_pressure_count: number;
			avg_truncated_tokens: number;
			total_turns_with_debug: number;
		};
		timeline: Array<{
			date: string;
			cache_hit_rate: number;
			budget_pressure_pct: number;
			avg_context_utilization: number;
		}>;
	};
}
```

Data flow: MetricsView holds date range in `$state`. On mount and range change, fetches the single endpoint. LayerCake chart components render reactively from `$derived` computations over the response.

Bucketing logic lives server-side: ranges ≤48h use hourly buckets (`strftime('%Y-%m-%dT%H:00', created_at)`), ranges >48h use daily buckets (`date(created_at)`). The API detects range length and picks the appropriate bucket.

Polling: 30-second interval, fires only when the range includes "now" (all presets do; custom past ranges skip polling).

## Existing Patterns

This design follows patterns established in the existing web UI:

**Layout pattern** (from NetworkStatus.svelte, Timetable.svelte): `<Page>` wrapper → stacked `<SectionHeader>` + content sections. CSS Grid for card rows (`repeat(auto-fill, minmax(300px, 1fr))`). No sub-routing within the tab.

**Component reuse**: MetroCard with `accentColor` for summary stats. DataTable with `sortable`, `rowAccent`, and column definitions for relay cycles. StatusChip for status indicators.

**API pattern** (from routes/threads.ts, routes/tasks.ts): Hono route factory `createMetricsRoutes(db: Database): Hono`, registered in `routes/index.ts` and mounted at `/api/metrics`.

**Data fetching** (from all views): Direct `fetch()` in view component, polling via `setInterval` in `onMount`, cleanup in `onDestroy`. No BoundClient method initially.

**Visualization** (from ContextSparkline.svelte): SVG-based rendering with normalized data. LayerCake extends this with proper scales and responsive containers, but the SVG rendering model is consistent.

**Styling**: Tokyo Metro color palette via CSS variables (`--line-0` through `--line-9`). Space Grotesk body, JetBrains Mono for data. 8px border-radius on cards.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: API Endpoint and Data Aggregation
**Goal:** Server-side metrics aggregation endpoint returning the full MetricsResponse shape

**Components:**
- `packages/web/src/server/routes/metrics.ts` — Hono route factory with SQL aggregation queries
- `packages/web/src/server/routes/index.ts` — route registration
- `packages/web/src/server/index.ts` — mount point for `/api/metrics`

**Dependencies:** None (first phase)

**Done when:** `GET /api/metrics?from=...&to=...` returns correctly-shaped JSON with token/relay/context aggregations. Bucketing switches between hourly and daily based on range length. Covers `observability-dashboard.AC5.*`.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Tab Registration and View Skeleton
**Goal:** Metrics tab visible in navigation, renders a loading state, fetches data on mount

**Components:**
- `packages/web/src/client/views/MetricsView.svelte` — view component with fetch + polling lifecycle
- `packages/web/src/client/App.svelte` — route registration for `#/metrics`
- `packages/web/src/client/components/TopBar.svelte` — nav entry (tab 09)

**Dependencies:** Phase 1 (API must exist to fetch from)

**Done when:** Tab 09 appears in navigation. Clicking it renders MetricsView which fetches and logs the API response. Covers `observability-dashboard.AC1.*`.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: DateRangeBar Component
**Goal:** Interactive date range selection shared across all sections

**Components:**
- `packages/web/src/client/components/DateRangeBar.svelte` — preset buttons + custom date inputs
- Integration into MetricsView.svelte state management

**Dependencies:** Phase 2 (needs MetricsView to host it)

**Done when:** Preset buttons (24h/7d/30d/All) switch the range. Custom date inputs allow arbitrary selection with 300ms debounce. Range changes trigger re-fetch. Covers `observability-dashboard.AC2.2`, `observability-dashboard.AC3.2`, `observability-dashboard.AC4.2`.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Token Usage Section
**Goal:** Token usage and cost visualization with MetroCards and LayerCake charts

**Components:**
- `packages/web/src/client/components/TokenBarChart.svelte` — horizontal stacked bars (in/out per model)
- `packages/web/src/client/components/CostTimeline.svelte` — area/line chart of cost over time
- Token section layout in MetricsView.svelte (SectionHeader + MetroCard row + charts)

**Dependencies:** Phase 3 (date range drives the data), LayerCake dependency installed

**Done when:** MetroCards show total tokens/cost/turns. Bar chart displays per-model token usage (stacked in/out). Timeline shows cost over selected range. Covers `observability-dashboard.AC2.*`.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Relay Performance Section
**Goal:** Relay latency and success rate visualization with per-host breakdown

**Components:**
- `packages/web/src/client/components/LatencyBarChart.svelte` — horizontal bars with avg/p95 per host
- Relay section layout in MetricsView.svelte (SectionHeader + MetroCard row + chart + DataTable)

**Dependencies:** Phase 3 (date range), Phase 4 (LayerCake already installed)

**Done when:** MetroCards show success rate (color-coded), avg latency, expired count. Bar chart shows per-host avg+p95 latency. DataTable shows 50 most recent cycles with rowAccent on failures. Covers `observability-dashboard.AC3.*`.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Context Assembly Section
**Goal:** Cache hit rate, budget pressure, and context utilization visualization

**Components:**
- `packages/web/src/client/components/CacheHitTimeline.svelte` — line chart of cache hit % over time
- Context section layout in MetricsView.svelte (SectionHeader + MetroCard row + timeline + sparkline row)

**Dependencies:** Phase 3 (date range), Phase 4 (LayerCake already installed)

**Done when:** MetroCards show cache hit rate, budget pressure count, avg truncation. Timeline shows cache hit % over time. Compact sparklines show pressure frequency and context utilization trends. Covers `observability-dashboard.AC4.*`.
<!-- END_PHASE_6 -->

<!-- START_PHASE_7 -->
### Phase 7: Polish and Edge Cases
**Goal:** Loading states, empty states, error handling, responsive layout

**Components:**
- Skeleton/shimmer loading states in MetricsView.svelte
- Empty state messaging (no data in range)
- Error state handling (API failure)
- Responsive grid breakpoints for MetroCard rows
- Tooltip interactions on chart hover

**Dependencies:** Phases 4-6 (all sections rendered)

**Done when:** Loading shows shimmer placeholders. Empty ranges show informative message. API errors show retry-able error state. Layout adapts to narrow viewports. Chart hover shows data values. Covers `observability-dashboard.AC1.3`, `observability-dashboard.AC1.4`.
<!-- END_PHASE_7 -->

## Additional Considerations

**Performance:** SQLite `json_extract` on the `context_debug` column is acceptable for date-filtered queries (typically hundreds to low-thousands of rows). If query latency becomes noticeable on very large date ranges, a materialized `budget_pressure` INTEGER column on `turns` can be added in a follow-up without changing the API contract.

**Local-only data:** `relay_cycles` and `daily_summary` are not synced across hosts. The relay section reflects what the current node observes, not cluster-wide relay health. This is noted in the section header subtitle.

**Bundle impact:** LayerCake adds ~8-10KB gzipped. The new view and chart components are estimated at ~5-8KB total. Net impact: ~15-18KB added to the embedded binary — negligible relative to the existing SPA bundle.
