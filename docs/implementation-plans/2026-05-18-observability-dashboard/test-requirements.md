# Test Requirements: Observability Dashboard

Maps each acceptance criterion (AC1.1 through AC5.5) to either an automated test or documented human verification.

## Test Infrastructure

- **Runner:** `bun:test` (`describe` / `it` / `expect`)
- **API route tests:** Real temp SQLite databases via `createDatabase(path)` + `applySchema(db)` + `applyMetricsSchema(db)`
- **Route test pattern:** `createMetricsRoutes(db)` called directly, requests via `app.request()`
- **Test file location:** `packages/web/src/server/__tests__/metrics-route.test.ts`
- **UI verification:** Manual + typecheck (no component-level Svelte tests exist in this project)
- **Coverage target:** 60% for web package

---

## AC1: Metrics tab exists and follows UI conventions

### observability-dashboard.AC1.1 — Tab 09 "Metrics" appears in TopBar navigation and routes to `#/metrics`

| Attribute | Value |
|-----------|-------|
| Verification | Human |
| Reason | No Svelte component tests exist in this project. TopBar rendering, hash routing, and navigation require a browser DOM. |
| Approach | (1) Run `bun run typecheck` to confirm the component compiles without errors. (2) Run `bun run build` to confirm the Svelte build succeeds. (3) Manual: open http://localhost:3001, verify "08 Metrics" tab appears in TopBar, click it, confirm URL changes to `#/metrics` and MetricsView renders. |

### observability-dashboard.AC1.2 — MetricsView renders inside `<Page>` wrapper with SectionHeader components

| Attribute | Value |
|-----------|-------|
| Verification | Human |
| Reason | Component structure verification requires DOM rendering (no component tests). |
| Approach | (1) `bun run typecheck` confirms imports and prop types are correct. (2) Manual: inspect MetricsView in browser dev tools, confirm `<Page>` wrapper exists as parent and three `<SectionHeader>` elements are present for Tokens, Relay, Context. |

### observability-dashboard.AC1.3 — API error displays error state with descriptive message (not blank page)

| Attribute | Value |
|-----------|-------|
| Verification | Human |
| Reason | Error state rendering is a DOM concern; the API-side error response shape is tested automatically (see AC5.4). |
| Approach | (1) Confirm AC5.4 automated tests pass (API returns structured error JSON). (2) Manual: temporarily modify the fetch URL in MetricsView to a broken path, reload, confirm a visible error message appears (not a blank page). Alternatively, use browser DevTools to block the `/api/metrics` request and verify error state. |

### observability-dashboard.AC1.4 — Empty date range (no turns in period) shows informative empty state

| Attribute | Value |
|-----------|-------|
| Verification | Automated (API response) + Human (UI rendering) |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Automated portion | Test that a request with a date range containing no data returns zeros/empty arrays (not an error). Specifically: `tokens.totals.turn_count === 0`, `relay.totals.total_cycles === 0`, `context.totals.total_turns_with_debug === 0`, and all arrays are empty `[]`. |
| Human portion | Manual: select a future custom date range in the UI. Confirm an informative message ("No data recorded in the selected range. Try expanding the date range.") appears instead of blank sections. |

---

## AC2: Token usage and cost dashboard

### observability-dashboard.AC2.1 — MetroCards display total tokens, total cost, and turn count for selected range

| Attribute | Value |
|-----------|-------|
| Verification | Automated (data correctness) + Human (visual rendering) |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Automated test | Seed 5+ turns with known `tokens_in`, `tokens_out`, `cost_usd` values within a date range. Request the API. Assert `tokens.totals.tokens_in`, `tokens.totals.tokens_out`, `tokens.totals.cost_usd`, and `tokens.totals.turn_count` match expected sums. |
| Human portion | Manual: verify MetroCards render the correct values with proper formatting (toLocaleString for tokens, $X.XXXX for cost). |

### observability-dashboard.AC2.2 — Date range presets (24h/7d/30d/All) filter the displayed data correctly

| Attribute | Value |
|-----------|-------|
| Verification | Automated (API filtering) + Human (UI preset interaction) |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Automated test | Seed turns at timestamps spanning 48+ hours. (a) Request with `from` = 24h ago: assert only recent turns included in totals. (b) Request with `from` = 7d ago: assert older turns now included. The API correctly filters by `created_at BETWEEN from AND to`. |
| Human portion | Manual: click each preset button (24h, 7d, 30d, All). Verify the MetroCard values change appropriately (e.g., "All" shows higher counts than "24h"). |

### observability-dashboard.AC2.3 — Bar chart shows per-model token usage with stacked in/out segments, sorted descending

| Attribute | Value |
|-----------|-------|
| Verification | Automated (data ordering) + Human (visual rendering) |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Automated test | Seed turns with 3+ different `model_id` values and varying token counts. Assert `tokens.byModel` array is sorted by `(tokens_in + tokens_out)` descending. Assert each entry contains correct `tokens_in` and `tokens_out` sums for that model. |
| Human portion | Manual: verify bar chart renders horizontal stacked bars with visually distinct in/out segments, descending order top-to-bottom. Hover to verify tooltips show correct values. |

### observability-dashboard.AC2.4 — Cost timeline displays cost over time with appropriate bucketing

| Attribute | Value |
|-----------|-------|
| Verification | Automated |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Test type | Integration |
| Automated test | (a) Seed turns spread across 6 distinct hours within a 24h window. Request with that 24h range. Assert `tokens.timeline` entries use hourly format (match pattern `/^\d{4}-\d{2}-\d{2}T\d{2}:00$/`). Assert each bucket's `cost_usd` sums correctly. (b) Seed turns across 5 distinct days. Request with a 5-day range (>48h). Assert timeline entries use daily format (match pattern `/^\d{4}-\d{2}-\d{2}$/`). |

### observability-dashboard.AC2.5 — Model with zero turns in range does not appear in bar chart

| Attribute | Value |
|-----------|-------|
| Verification | Automated |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Test type | Integration |
| Automated test | Seed turns for model "alpha" within the range and model "beta" outside the range. Request with the range. Assert `tokens.byModel` contains only "alpha" (not "beta"). Assert no entry exists with `turn_count === 0`. |

### observability-dashboard.AC2.6 — Custom date range with future end-date clamps to current time

| Attribute | Value |
|-----------|-------|
| Verification | Automated (API clamping) + Human (UI clamping) |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Automated test | Send a request with `to` set 1 year in the future. Assert the response succeeds (200). Seed a turn "now" — assert it appears in results (proving the query uses clamped `to`, not the raw future value). The exact clamped timestamp cannot be asserted precisely, but behavior is verifiable. |
| Human portion | Manual: enter a future date in the custom "to" input. Verify the DateRangeBar clamps it (debounced callback uses `Math.min(customTo, Date.now())`). |

---

## AC3: Relay performance dashboard

### observability-dashboard.AC3.1 — MetroCards display success rate, avg latency, and expired count for selected range

| Attribute | Value |
|-----------|-------|
| Verification | Automated (data correctness) + Human (visual rendering) |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Automated test | Seed 10 relay_cycles with known latency_ms, success (0/1), and expired (0/1) values within range. Assert `relay.totals.success_rate` equals `(sum_success / total_cycles)`. Assert `relay.totals.avg_latency_ms` equals arithmetic mean of non-null latencies. Assert `relay.totals.expired_count` equals sum of expired. |
| Human portion | Manual: verify MetroCards show formatted values (e.g., "92.5%", "234ms", "3 expired") with correct accent colors. |

### observability-dashboard.AC3.2 — Same date range filter applies to relay section as token section

| Attribute | Value |
|-----------|-------|
| Verification | Automated |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Test type | Integration |
| Automated test | Seed relay_cycles at two distinct time periods: some within [from, to] and some outside. Request with [from, to]. Assert `relay.totals.total_cycles` counts only cycles within range. Assert `relay.recentCycles` contains only entries within range. |

### observability-dashboard.AC3.3 — Latency bar chart shows avg and p95 per host, color-coded by health threshold

| Attribute | Value |
|-----------|-------|
| Verification | Automated (data) + Human (visual) |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Automated test | Seed 20 relay_cycles for host "A" with known latencies (e.g., 19 at 100ms, 1 at 900ms). Assert `relay.byHost[0].avg_latency_ms` is approximately 140ms. Assert `relay.byHost[0].p95_latency_ms` equals 900 (the 95th percentile value). Verify P95 calculation correctness with a deterministic dataset. |
| Human portion | Manual: verify bar chart renders two bars per host (avg solid, p95 semi-transparent). Verify color-coding: green for <500ms, amber for 500-2000ms, red for >2000ms. |

### observability-dashboard.AC3.4 — DataTable shows 50 most recent relay cycles with sortable columns and failure row accents

| Attribute | Value |
|-----------|-------|
| Verification | Automated (data limit + content) + Human (sorting + accent) |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Automated test | Seed 60 relay_cycles within range. Assert `relay.recentCycles.length === 50` (limit). Assert entries are ordered by `created_at DESC`. Assert each entry has fields: `direction`, `peer_site_id`, `kind`, `latency_ms`, `success` (boolean), `expired` (boolean), `created_at`. |
| Human portion | Manual: verify DataTable renders with sortable column headers (click to sort). Verify rows with `success: false` have red left-border accent. Verify rows with `expired: true` have amber accent. |

### observability-dashboard.AC3.5 — No relay_cycles in range shows empty state (not error)

| Attribute | Value |
|-----------|-------|
| Verification | Automated (API response) + Human (UI empty state) |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Automated test | Request the API with a date range containing no relay_cycles. Assert response is 200 (not 4xx/5xx). Assert `relay.totals.total_cycles === 0`, `relay.totals.success_rate === 0`, `relay.byHost` is `[]`, `relay.recentCycles` is `[]`. |
| Human portion | Manual: with no relay data in range, verify the relay section shows "No relay cycles recorded in the selected range." (not an error state or broken chart). |

### observability-dashboard.AC3.6 — Single host in cluster still renders bar chart with one row

| Attribute | Value |
|-----------|-------|
| Verification | Automated (data) + Human (rendering) |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Automated test | Seed relay_cycles for exactly one `peer_site_id`. Assert `relay.byHost.length === 1`. Assert the single entry has valid `avg_latency_ms` and `p95_latency_ms`. |
| Human portion | Manual: with only one host's relay data, verify the LatencyBarChart renders a single row (not an empty chart or error). |

---

## AC4: Context assembly metrics

### observability-dashboard.AC4.1 — MetroCards display cache hit rate, budget pressure count, and avg truncation

| Attribute | Value |
|-----------|-------|
| Verification | Automated (data correctness) + Human (visual rendering) |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Automated test | Seed 5 turns with known `tokens_cache_read`, `tokens_in`, and `context_debug` JSON (containing `budgetPressure` and `truncated` fields). Assert `context.totals.avg_cache_hit_rate` equals expected average of `(cache_read / (cache_read + tokens_in))`. Assert `context.totals.budget_pressure_count` equals count of turns where `budgetPressure === true`. Assert `context.totals.avg_truncated_messages` equals average of `truncated` values (message count). |
| Human portion | Manual: verify MetroCards display formatted values (e.g., "78.2%", "3 turns", "4.2 msgs") with color-coded accents. |

### observability-dashboard.AC4.2 — Same date range filter applies to context section

| Attribute | Value |
|-----------|-------|
| Verification | Automated |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Test type | Integration |
| Automated test | Seed turns with `context_debug` at two time periods (within and outside the range). Request with [from, to]. Assert `context.totals.total_turns_with_debug` counts only turns within range. Assert timeline only contains buckets within range. |

### observability-dashboard.AC4.3 — Cache hit timeline shows percentage over time as line chart

| Attribute | Value |
|-----------|-------|
| Verification | Automated (data) + Human (visual) |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Automated test | Seed turns with varying `tokens_cache_read` across multiple time buckets. Assert `context.timeline` contains entries with `cache_hit_rate` values between 0.0 and 1.0 for each bucket. Assert bucketing format matches range duration (hourly if <=48h, daily if >48h). |
| Human portion | Manual: verify CacheHitTimeline renders as a line chart with Y-axis 0-100%, data points connected, area fill below. |

### observability-dashboard.AC4.4 — Budget pressure sparkline shows truncation frequency trend

| Attribute | Value |
|-----------|-------|
| Verification | Automated (data) + Human (visual) |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Automated test | Seed turns with `budgetPressure: true` clustered in certain time buckets. Assert `context.timeline` entries contain `budget_pressure_pct` values representing the fraction of turns with budget pressure per bucket (e.g., 0.5 if 2/4 turns in that bucket had pressure). |
| Human portion | Manual: verify sparkline SVG renders below the CacheHitTimeline with visible variation in the line corresponding to pressure frequency. |

### observability-dashboard.AC4.5 — Turns without context_debug are excluded from context metrics (no NaN/divide-by-zero)

| Attribute | Value |
|-----------|-------|
| Verification | Automated |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Test type | Integration |
| Automated test | Seed 3 turns with `context_debug = NULL` and 2 turns with valid `context_debug` JSON in the same range. Assert `context.totals.total_turns_with_debug === 2` (not 5). Assert all numeric fields are valid numbers (not NaN, not null, not undefined). Assert `avg_cache_hit_rate` is computed from only the 2 turns with debug data. |

### observability-dashboard.AC4.6 — Zero cache_read tokens in range shows 0% hit rate (not undefined)

| Attribute | Value |
|-----------|-------|
| Verification | Automated |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Test type | Integration |
| Automated test | Seed turns with `tokens_cache_read = NULL` (or 0) and `tokens_in > 0`, with valid `context_debug`. Assert `context.totals.avg_cache_hit_rate === 0` (exactly zero, not null, not undefined, not NaN). Verify the response JSON serializes this as `0` (a number). |

---

## AC5: API endpoints with parameterized queries

### observability-dashboard.AC5.1 — `GET /api/metrics?from=<ISO>&to=<ISO>` returns MetricsResponse shape

| Attribute | Value |
|-----------|-------|
| Verification | Automated |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Test type | Integration |
| Automated test | Seed representative data in `turns` and `relay_cycles`. Request the endpoint with valid ISO date params. Assert: (a) response status is 200, (b) response body has top-level keys `tokens`, `relay`, `context`, (c) `tokens` has keys `byModel` (array), `timeline` (array), `totals` (object with `tokens_in`, `tokens_out`, `cost_usd`, `turn_count`, `error_count`), (d) `relay` has keys `byHost` (array), `recentCycles` (array), `totals` (object with `total_cycles`, `success_rate`, `avg_latency_ms`, `expired_count`), (e) `context` has keys `totals` (object with `avg_cache_hit_rate`, `budget_pressure_count`, `avg_truncated_messages`, `total_turns_with_debug`), `timeline` (array). All numeric fields are typeof number. |

### observability-dashboard.AC5.2 — Bucketing switches from hourly to daily based on range length (threshold: 48h)

| Attribute | Value |
|-----------|-------|
| Verification | Automated |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Test type | Integration |
| Automated test | (a) Seed turns across 12 distinct hours. Request with a 24h range. Assert `tokens.timeline[0].date` matches hourly format (`/^\d{4}-\d{2}-\d{2}T\d{2}:00$/`). (b) Seed turns across 5 distinct days. Request with a 7d range. Assert `tokens.timeline[0].date` matches daily format (`/^\d{4}-\d{2}-\d{2}$/`). (c) Edge: exactly 48h range should use hourly. (d) Edge: 48h + 1ms range should use daily. |

### observability-dashboard.AC5.3 — Response includes all three sections (tokens, relay, context) in single payload

| Attribute | Value |
|-----------|-------|
| Verification | Automated |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Test type | Integration |
| Automated test | Seed data in both `turns` (with `context_debug`) and `relay_cycles`. Single request. Assert all three top-level sections (`tokens`, `relay`, `context`) are present and contain non-empty data reflecting the seeded rows. This confirms a single HTTP call returns the full payload. |

### observability-dashboard.AC5.4 — Missing or invalid date parameters return 400 with descriptive error

| Attribute | Value |
|-----------|-------|
| Verification | Automated |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Test type | Unit |
| Automated test | Test cases: (a) No `from` param: assert 400 + body contains `error` string. (b) No `to` param: assert 400 + body contains `error` string. (c) Neither param: assert 400. (d) `from` = "not-a-date": assert 400 + descriptive error. (e) `to` = "not-a-date": assert 400. (f) `from` after `to` (inverted range): assert 400 + error mentions ordering. (g) Empty string params: assert 400. All 400 responses must have JSON body with an `error` field (string). |

### observability-dashboard.AC5.5 — Very large range (all time) completes within reasonable time (<2s on 10k turns)

| Attribute | Value |
|-----------|-------|
| Verification | Automated (smoke) + Human (full benchmark) |
| Test file | `packages/web/src/server/__tests__/metrics-route.test.ts` |
| Automated test (smoke) | Seed 200 turns and 100 relay_cycles with varied data (representative distribution). Request with "all time" range (`from=2020-01-01`, `to=now`). Assert response completes without timeout (bun:test default 5s). Assert response is valid JSON matching the schema. This gives confidence the query structure is sound without the full 10k benchmark. |
| Human portion (full benchmark) | For the 10k-turn performance requirement: manually seed a test database with 10,000 turns (script or production database copy). Run `time curl 'http://localhost:3001/api/metrics?from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z'`. Verify response completes in under 2 seconds. If it exceeds 2s, consider adding a materialized `budget_pressure` column or index. |

---

## Summary

| AC | Automated | Human | Test File |
|----|-----------|-------|-----------|
| AC1.1 | - | Typecheck + manual navigation | - |
| AC1.2 | - | Typecheck + manual DOM inspection | - |
| AC1.3 | - | Manual (API error handling tested via AC5.4) | - |
| AC1.4 | Partial (API zeros) | Manual (UI empty state text) | metrics-route.test.ts |
| AC2.1 | Yes (data sums) | Manual (MetroCard rendering) | metrics-route.test.ts |
| AC2.2 | Yes (filtering) | Manual (preset buttons) | metrics-route.test.ts |
| AC2.3 | Yes (sort order) | Manual (chart rendering + tooltips) | metrics-route.test.ts |
| AC2.4 | Yes | - | metrics-route.test.ts |
| AC2.5 | Yes | - | metrics-route.test.ts |
| AC2.6 | Yes (clamping) | Manual (UI clamping) | metrics-route.test.ts |
| AC3.1 | Yes (data) | Manual (MetroCard rendering) | metrics-route.test.ts |
| AC3.2 | Yes | - | metrics-route.test.ts |
| AC3.3 | Yes (P95 calc) | Manual (chart + colors) | metrics-route.test.ts |
| AC3.4 | Yes (limit + order) | Manual (sorting + accents) | metrics-route.test.ts |
| AC3.5 | Yes (API shape) | Manual (UI empty state) | metrics-route.test.ts |
| AC3.6 | Yes (single host) | Manual (chart renders) | metrics-route.test.ts |
| AC4.1 | Yes (data) | Manual (MetroCard rendering) | metrics-route.test.ts |
| AC4.2 | Yes | - | metrics-route.test.ts |
| AC4.3 | Yes (data) | Manual (line chart) | metrics-route.test.ts |
| AC4.4 | Yes (data) | Manual (sparkline) | metrics-route.test.ts |
| AC4.5 | Yes | - | metrics-route.test.ts |
| AC4.6 | Yes | - | metrics-route.test.ts |
| AC5.1 | Yes | - | metrics-route.test.ts |
| AC5.2 | Yes | - | metrics-route.test.ts |
| AC5.3 | Yes | - | metrics-route.test.ts |
| AC5.4 | Yes | - | metrics-route.test.ts |
| AC5.5 | Smoke (200 rows) | Full benchmark (10k rows) | metrics-route.test.ts |

**Automated test count:** ~25-30 test cases in a single file
**Human verification items:** 15 (all UI rendering/interaction that requires a browser)
**Estimated coverage contribution:** The metrics route file will be fully covered by automated tests. UI components contribute to the 60% web package target via typecheck validation only.
