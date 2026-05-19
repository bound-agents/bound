# Human Test Plan: Observability Dashboard

Covers manual verification items that require a browser DOM or visual inspection.

## Prerequisites

- System running locally (`bound start` or dev mode)
- Some existing turns in the database (at least a few conversations)
- At least one relay connection configured (for relay section)

## Test Procedures

### TP-1: Tab Navigation (AC1.1)

1. Open http://localhost:3001
2. Verify "08 Metrics" tab appears in the TopBar navigation
3. Click the tab
4. Verify URL changes to `#/metrics`
5. Verify MetricsView renders (not blank)

**Pass criteria:** Tab visible, clickable, routes correctly.

### TP-2: Page Structure (AC1.2)

1. Navigate to `#/metrics`
2. Open browser DevTools → Elements
3. Verify the view is wrapped in a `<Page>` component (look for page wrapper div)
4. Verify three SectionHeader components are present: "Tokens", "Relay Performance", "Context Assembly"

**Pass criteria:** Page wrapper and 3 section headers present in DOM.

### TP-3: Error State Display (AC1.3)

1. Open DevTools → Network tab
2. Block requests to `/api/metrics` (right-click → Block request URL)
3. Navigate to `#/metrics` or change date range
4. Verify an error message appears (red text, not a blank page)
5. Verify the message is descriptive (e.g., "Failed to load metrics. Check network connection.")
6. Unblock the request and verify data loads on next poll or range change

**Pass criteria:** Error state visible with descriptive message; never blank.

### TP-4: Empty State (AC1.4)

1. Navigate to `#/metrics`
2. Set a custom date range in the far future (e.g., 2030-01-01 to 2030-01-02)
3. Verify an informative message appears: "No data recorded in the selected range. Try expanding the date range."
4. Verify no broken charts or errors appear

**Pass criteria:** Empty state message visible; no crashes or blank sections.

### TP-5: Date Presets (AC2.2)

1. Navigate to `#/metrics`
2. Click each preset button: 24h, 7d, 30d, All
3. Verify MetroCard values change between presets (e.g., "All" shows higher counts than "24h")
4. Verify data refreshes on each click (loading indicator briefly appears)

**Pass criteria:** Each preset triggers new data; values differ across ranges.

### TP-6: Token MetroCards (AC2.1)

1. Navigate to `#/metrics` with the 7d preset
2. Verify three MetroCards visible: Total Tokens, Total Cost, Turn Count
3. Verify values are formatted: tokens with commas (e.g., "1,234,567"), cost with $ prefix and 4 decimals (e.g., "$0.1234"), count as integer
4. Verify accent colors: blue for tokens, amber for cost, green for turns

**Pass criteria:** Three cards with correct formatting and colors.

### TP-7: Token Bar Chart (AC2.3)

1. Verify horizontal stacked bar chart renders below MetroCards
2. Verify bars are sorted top-to-bottom by total tokens (largest model first)
3. Verify two distinct colors for input (blue) and output (amber) segments
4. Hover over a bar — verify tooltip shows model name and token count

**Pass criteria:** Stacked bars, sorted descending, tooltips work.

### TP-8: Cost Timeline (AC2.4)

1. Verify area chart renders below the bar chart
2. With 24h range: verify x-axis shows hourly labels (e.g., "14:00")
3. Switch to 30d range: verify x-axis shows daily labels (e.g., "05/18")
4. Hover over data points — verify tooltip shows date and cost value

**Pass criteria:** Area chart with correct date bucketing; tooltips work.

### TP-9: Future Date Clamping (AC2.6)

1. Click "custom" date range
2. Set "to" date to a future date (e.g., next year)
3. Verify the component clamps it (data loads without error)
4. Verify the displayed data includes current data (not empty)

**Pass criteria:** Future dates don't break the UI; data still loads.

### TP-10: Relay MetroCards (AC3.1)

1. Scroll to "Relay Performance" section
2. Verify three MetroCards: Success Rate (%), Avg Latency (ms), Expired Count
3. Verify success rate accent: green >= 95%, amber >= 80%, red < 80%
4. Verify expired accent: green if 0, amber if > 0

**Pass criteria:** Three cards with dynamic accent colors.

### TP-11: Latency Bar Chart (AC3.3)

1. Verify horizontal grouped bar chart shows avg and p95 per host
2. Verify color coding: green < 500ms, amber 500-2000ms, red > 2000ms
3. Verify P95 bars are semi-transparent (50% opacity)
4. Verify host labels are truncated site IDs
5. Hover — verify tooltips show "avg Xms" or "p95 Xms"

**Pass criteria:** Grouped bars with health colors and tooltips.

### TP-12: Relay DataTable (AC3.4)

1. Verify table renders below the chart with columns: Peer, Direction, Kind, Latency, Status, Time
2. Click column headers — verify sorting works
3. Verify failed rows (Status = "FAIL") have red left-border accent
4. Verify expired rows have amber accent
5. Verify table shows at most 50 rows

**Pass criteria:** Sortable table, row accents, 50-row limit.

### TP-13: Empty Relay State (AC3.5)

1. Set a custom date range where no relay cycles exist
2. Verify message: "No relay cycles recorded in the selected range."
3. Verify no broken chart or error appears

**Pass criteria:** Informative empty message, no crashes.

### TP-14: Single Host Chart (AC3.6)

1. If cluster has only one host, verify the latency chart still renders with one row
2. Verify it doesn't show empty state or error

**Pass criteria:** Single-row bar chart renders correctly.

### TP-15: Context MetroCards (AC4.1)

1. Scroll to "Context Assembly" section
2. Verify three MetroCards: Cache Hit Rate (%), Budget Pressure (count), Avg Truncation (msgs)
3. Verify cache accent: green >= 80%, amber >= 50%, red < 50%
4. Verify budget accent: green if 0, amber if > 0

**Pass criteria:** Three cards with correct values and dynamic accents.

### TP-16: Cache Hit Timeline (AC4.3)

1. Verify line chart renders with Y-axis 0-100%
2. Verify data points are connected by a green line with area fill below
3. Verify grid lines at 25% intervals
4. Hover — verify tooltips show date and percentage

**Pass criteria:** Line chart with [0,1] range, tooltips work.

### TP-17: Sparklines (AC4.4)

1. Verify two sparklines render below the cache timeline: "Budget Pressure Frequency" and "Context Utilization"
2. Verify budget pressure sparkline is amber colored
3. Verify context utilization sparkline is blue colored
4. Verify sparklines show variation (not flat) when data exists

**Pass criteria:** Two labeled sparklines with correct colors.

### TP-18: Responsive Layout

1. Resize browser window below 960px width
2. Verify MetroCards stack into a single column
3. Verify sparklines stack vertically (instead of side-by-side)
4. Verify charts remain readable (SVG scales via viewBox)
5. Resize back above 960px — verify multi-column layout returns

**Pass criteria:** Layout adapts at 960px breakpoint.

---

## Summary

| # | AC | Area | Type |
|---|----|----|------|
| TP-1 | AC1.1 | Navigation | Visual |
| TP-2 | AC1.2 | Structure | DOM inspection |
| TP-3 | AC1.3 | Error handling | Network block |
| TP-4 | AC1.4 | Empty state | Date range |
| TP-5 | AC2.2 | Presets | Interaction |
| TP-6 | AC2.1 | Token cards | Visual |
| TP-7 | AC2.3 | Token chart | Visual + tooltip |
| TP-8 | AC2.4 | Cost timeline | Visual + tooltip |
| TP-9 | AC2.6 | Date clamping | Input |
| TP-10 | AC3.1 | Relay cards | Visual |
| TP-11 | AC3.3 | Latency chart | Visual + tooltip |
| TP-12 | AC3.4 | DataTable | Sorting + accent |
| TP-13 | AC3.5 | Empty relay | Date range |
| TP-14 | AC3.6 | Single host | Visual |
| TP-15 | AC4.1 | Context cards | Visual |
| TP-16 | AC4.3 | Cache timeline | Visual + tooltip |
| TP-17 | AC4.4 | Sparklines | Visual |
| TP-18 | - | Responsive | Resize |
