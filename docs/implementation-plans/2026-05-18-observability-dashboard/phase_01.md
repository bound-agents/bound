# Observability Dashboard Implementation Plan

**Goal:** Server-side metrics aggregation endpoint returning the full MetricsResponse shape with token/relay/context data

**Architecture:** Single Hono route factory (`createMetricsRoutes`) performing parameterized SQL aggregation across `turns` and `relay_cycles` tables, with JSON extraction from the `context_debug` column for context assembly metrics.

**Tech Stack:** Hono (web framework), bun:sqlite (database), TypeScript

**Scope:** 7 phases from original design (this is phase 1 of 7)

**Codebase verified:** 2026-05-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### observability-dashboard.AC5: API endpoints with parameterized queries
- **observability-dashboard.AC5.1 Success:** `GET /api/metrics?from=<ISO>&to=<ISO>` returns MetricsResponse shape
- **observability-dashboard.AC5.2 Success:** Bucketing switches from hourly to daily based on range length (threshold: 48h)
- **observability-dashboard.AC5.3 Success:** Response includes all three sections (tokens, relay, context) in single payload
- **observability-dashboard.AC5.4 Failure:** Missing or invalid date parameters return 400 with descriptive error
- **observability-dashboard.AC5.5 Edge:** Very large range (all time) completes within reasonable time (<2s on 10k turns)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Create metrics route factory with date validation

**Verifies:** observability-dashboard.AC5.1, observability-dashboard.AC5.4

**Files:**
- Create: `packages/web/src/server/routes/metrics.ts`

**Implementation:**

Create the route factory following the established pattern from `routes/threads.ts` and `routes/webhooks.ts`. The factory takes a `Database` parameter and returns a Hono instance.

The endpoint `GET /` (mounted at `/api/metrics`) accepts `from` and `to` query parameters as ISO 8601 strings. Validation:
- Both `from` and `to` are required — return 400 if missing
- Both must parse as valid ISO 8601 dates (`new Date(param).toISOString()` should not throw or return "Invalid Date")
- `to` must be after `from` — return 400 if not
- If `to` is in the future, clamp it to current time (`new Date().toISOString()`)

The response shape matches the `MetricsResponse` interface from the design plan. For this task, return the full shape with placeholder empty arrays/zeros for token/relay/context sections — subsequent steps fill in the actual queries.

Determine bucketing mode: if the range (`to - from`) is ≤ 48 hours, use hourly buckets; otherwise use daily buckets. This decision is made once and used by all aggregation queries.

Response pattern: `c.json(metricsResponse)` for success, `c.json({ error: "...", details: "..." }, 400)` for validation failures.

Export the `MetricsResponse` TypeScript interface from this file so it can be imported by both the test file and the client-side view component. Define it at the top of the module.

**Note:** The test file (`packages/web/src/server/__tests__/metrics-route.test.ts`) should be created alongside this task with initial validation test cases. Subsequent tasks (2-4) add test cases incrementally as each query section is implemented. Task 6 documents the complete test suite requirements.

**Verification:**
Run: `bun test packages/web/src/server/__tests__/metrics-route.test.ts`
Expected: Tests pass for validation cases

**Commit:** `feat(web): add metrics route factory with date range validation`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Token aggregation queries

**Verifies:** observability-dashboard.AC5.1, observability-dashboard.AC5.2, observability-dashboard.AC5.3

**Files:**
- Modify: `packages/web/src/server/routes/metrics.ts`

**Implementation:**

Add three SQL queries for the token section:

1. **byModel aggregation:** Group by `model_id`, summing `tokens_in`, `tokens_out`, `COALESCE(tokens_cache_read, 0)`, `COALESCE(tokens_cache_write, 0)`, `COALESCE(cost_usd, 0)`, and `COUNT(*)` as turn_count. Filter by `created_at BETWEEN ? AND ?` and `deleted = 0`. Order by total tokens descending.

2. **timeline aggregation:** Group by bucketed date. For hourly: `strftime('%Y-%m-%dT%H:00', created_at)`. For daily: `date(created_at)`. Sum `tokens_in`, `tokens_out`, `COALESCE(cost_usd, 0)`. Filter same as above. Order by date ascending.

3. **totals aggregation:** Single row with `SUM(tokens_in)`, `SUM(tokens_out)`, `SUM(COALESCE(cost_usd, 0))`, `COUNT(*)`, and `SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)` as error_count. Same date/deleted filter.

All queries use parameterized `?` for date values (never interpolate). `COALESCE` handles nullable columns (`tokens_cache_read`, `tokens_cache_write`, `cost_usd`).

**Verification:**
Run: `bun test packages/web/src/server/__tests__/metrics-route.test.ts`
Expected: Tests pass for token aggregation including bucketing behavior

**Commit:** `feat(web): add token usage aggregation to metrics endpoint`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Relay performance queries

**Verifies:** observability-dashboard.AC5.1, observability-dashboard.AC5.3

**Files:**
- Modify: `packages/web/src/server/routes/metrics.ts`

**Implementation:**

Add relay aggregation queries. Note: `relay_cycles` is local-only (not synced), has no `deleted` column.

1. **byHost aggregation:** Group by `peer_site_id`. Compute:
   - `AVG(latency_ms)` as avg_latency_ms
   - P95 latency: use a subquery or window function. SQLite approach: `SELECT latency_ms FROM relay_cycles WHERE peer_site_id = ? AND created_at BETWEEN ? AND ? ORDER BY latency_ms DESC LIMIT 1 OFFSET (COUNT(*) * 5 / 100)`. Alternatively, compute per-host in a single query using a correlated subquery or approximate with `NTILE`.
   - Simpler approach for P95: For each host, query all latencies in range, sort, pick the value at index `floor(count * 0.95)`. Since this is a dashboard query (not real-time), a grouped approach with `GROUP_CONCAT` + JS-side percentile calculation is pragmatic.
   - `SUM(success)` as success_count, `COUNT(*) - SUM(success)` as failure_count, `SUM(expired)` as expired_count

   Filter by `created_at BETWEEN ? AND ?`.

   **P95 approach:** Use a pragmatic method — query per-host aggregates first (avg, sum, count), then for P95 compute it in a separate query per host OR use SQLite's percentile extension if available. The simplest correct approach: query all latency values per host, compute P95 in JavaScript. Since host count is typically small (< 10), this is efficient.

   Actually, the cleanest approach: one query gets the aggregates (avg, success, failure, expired counts grouped by host), and a second query gets all `(peer_site_id, latency_ms)` pairs in the range **with `WHERE latency_ms IS NOT NULL`** (expired requests may have NULL latency). Then compute P95 per host in JS. This avoids complex SQL and scales fine for dashboard use. Filter out NULL latency values before percentile calculation to prevent NaN.

2. **recentCycles:** `SELECT direction, peer_site_id, kind, latency_ms, success, expired, created_at FROM relay_cycles WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 50`. Map `success`/`expired` from INTEGER (0/1) to boolean in the response.

3. **totals:** Compute from the byHost results: total cycles, overall success rate (total success / total cycles), average latency across all cycles, total expired count.

**Verification:**
Run: `bun test packages/web/src/server/__tests__/metrics-route.test.ts`
Expected: Tests pass for relay aggregation

**Commit:** `feat(web): add relay performance aggregation to metrics endpoint`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Context assembly queries

**Verifies:** observability-dashboard.AC5.1, observability-dashboard.AC5.3

**Files:**
- Modify: `packages/web/src/server/routes/metrics.ts`

**Implementation:**

Add context assembly aggregation. The `context_debug` column on `turns` is a JSON TEXT column containing a `ContextDebugInfo` object (camelCase keys). Only rows where `context_debug IS NOT NULL` are included (per AC4.5).

**Verified field names** (from `packages/shared/src/types.ts` ContextDebugInfo interface):
- `$.budgetPressure` — boolean (true when headroom < 2000 tokens)
- `$.truncated` — integer (count of MESSAGES removed, not tokens)
- `$.totalEstimated` — integer (total tokens used in assembly)
- `$.contextWindow` — integer (max tokens for the model)
- There is NO `$.cacheHitRate` key — cache hit rate is computed from TABLE COLUMNS

1. **totals:** Query turns with non-null `context_debug` in range:
   - Cache hit rate (from TABLE COLUMNS, not JSON):
     ```sql
     AVG(
         CAST(COALESCE(tokens_cache_read, 0) AS REAL) /
         NULLIF(COALESCE(tokens_cache_read, 0) + tokens_in, 0)
     )
     ```
     This handles AC4.6: when `tokens_cache_read` is NULL/0 and `tokens_in` > 0, result is 0.0 (not undefined). When both are 0, NULLIF returns NULL which AVG ignores.
   - Budget pressure count: `SUM(CASE WHEN json_extract(context_debug, '$.budgetPressure') = 1 THEN 1 ELSE 0 END)` (SQLite stores JSON `true` as integer 1)
   - Average truncated messages: `AVG(COALESCE(CAST(json_extract(context_debug, '$.truncated') AS INTEGER), 0))` — note: this is message count, not token count. The API field is named `avg_truncated_messages` (not `avg_truncated_tokens` as the design originally specified) to accurately reflect the semantics.
   - Count of turns with debug: `COUNT(*)`

   Filter: `created_at BETWEEN ? AND ? AND context_debug IS NOT NULL AND deleted = 0`

2. **timeline:** Group by bucketed date (same hourly/daily logic as tokens). For each bucket:
   - `cache_hit_rate`: average of per-turn cache hit rates (computed from table columns as above)
   - `budget_pressure_pct`: `CAST(SUM(CASE WHEN json_extract(context_debug, '$.budgetPressure') = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*)` as percentage
   - `avg_context_utilization`: `AVG(CAST(json_extract(context_debug, '$.totalEstimated') AS REAL) / NULLIF(CAST(json_extract(context_debug, '$.contextWindow') AS INTEGER), 0))` (ratio of used tokens to context window)

   Filter same as totals.

**Verification:**
Run: `bun test packages/web/src/server/__tests__/metrics-route.test.ts`
Expected: Tests pass for context assembly metrics including NULL handling

**Commit:** `feat(web): add context assembly aggregation to metrics endpoint`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->
<!-- START_TASK_5 -->
### Task 5: Route registration and mounting

**Verifies:** observability-dashboard.AC5.1

**Files:**
- Modify: `packages/web/src/server/routes/index.ts` — add `metrics: createMetricsRoutes(db)` to the returned object from `registerRoutes()`
- Modify: `packages/web/src/server/index.ts` — add `app.route("/api/metrics", routes.metrics)` alongside existing route mounts (around lines 123-133)

**Implementation:**

In `routes/index.ts`:
- Import: `import { createMetricsRoutes } from "./metrics.js";`
- Add to the returned object: `metrics: createMetricsRoutes(db),`
- The metrics route only needs `db` (no eventBus or config needed for read-only aggregation)

In `server/index.ts`:
- Add: `app.route("/api/metrics", routes.metrics);` after the existing route mounts

**Verification:**
Run: `bun test packages/web`
Expected: All existing web tests pass plus new metrics tests

Run: `bun run typecheck`
Expected: No type errors

**Commit:** `feat(web): register metrics route at /api/metrics`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Metrics route tests

**Verifies:** observability-dashboard.AC5.1, observability-dashboard.AC5.2, observability-dashboard.AC5.3, observability-dashboard.AC5.4, observability-dashboard.AC5.5

**Files:**
- Create: `packages/web/src/server/__tests__/metrics-route.test.ts`

**Testing:**

Follow the pattern from `webhooks-routes.test.ts`:
- Real temp SQLite DB via `createDatabase(path)` + `applySchema(db)` (also need `applyMetricsSchema(db)` for the turns table)
- Create route instance via `createMetricsRoutes(db)`
- Use `app.request()` or `app.fetch()` for HTTP requests

Tests must verify each AC listed above:

- **observability-dashboard.AC5.1:** Seed turns and relay_cycles with known data in a date range. Call `GET /?from=...&to=...`. Assert response has correct shape with `tokens`, `relay`, `context` sections. Assert numeric values match seeded data.

- **observability-dashboard.AC5.2:** Seed data across multiple hours. Call with a range ≤48h — assert timeline entries use hourly format (e.g., `2026-05-18T14:00`). Call with range >48h — assert daily format (e.g., `2026-05-18`).

- **observability-dashboard.AC5.3:** Single request returns all three sections populated when data exists for all three.

- **observability-dashboard.AC5.4:** Call without `from` param → 400. Call without `to` param → 400. Call with invalid date string → 400. Call with `from` after `to` → 400. Assert error response includes descriptive message.

- **observability-dashboard.AC5.5:** Seed 100+ turns (representative of performance). Assert response completes without timeout. (Actual 10k perf test is manual verification.)

Additional test cases:
- Empty range (no data) returns zeros/empty arrays (not errors)
- `context_debug` is NULL on some turns — those are excluded from context metrics, no divide-by-zero
- `cost_usd` is NULL on some turns — COALESCE handles it, totals still correct
- `tokens_cache_read`/`tokens_cache_write` NULL handling
- P95 latency calculation correctness with known data set
- Boolean mapping for relay `success`/`expired` (INTEGER 0/1 → boolean)

**Verification:**
Run: `bun test packages/web/src/server/__tests__/metrics-route.test.ts`
Expected: All tests pass

**Commit:** `test(web): add comprehensive metrics route tests`
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_C -->
