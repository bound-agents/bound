# Context Debugger — Human Test Plan

## Prerequisites

- Bound server running (`bun packages/cli/src/bound.ts start`)
- At least one thread with 3+ agent turns (send a few messages to generate turns)
- Browser open at `http://localhost:3000`

## Test Scenarios

### AC5.1: Toggle Button Opens/Closes Panel

1. Navigate to a thread view
2. Locate the gear icon (⚙) button in the thread header
3. Click it — the context debug panel should appear on the right side
4. Click it again (now shows ✕) — the panel should hide
5. The main content should re-center when the panel closes

**Pass:** Panel toggles open/closed on each click

### AC5.2: Panel Closed by Default

1. Navigate to a thread view (fresh page load)
2. Verify no debug panel is visible on the right side
3. Only the centered message column should be visible

**Pass:** Panel is not visible on initial page load

### AC5.3: Historical Data Fetch on First Open

1. Open a thread with 3+ agent turns
2. Click the debug toggle button
3. The panel should show "Loading..." briefly, then populate with turn data
4. Turn navigation should show "Turn N of M" where M equals the number of agent turns

**Pass:** Historical turn data is populated on first panel open

### AC5.4: Live WebSocket Updates

1. Open a thread and open the debug panel
2. Note the current turn count (e.g., "Turn 3 of 3")
3. Send a new message in the thread
4. After the agent responds, the panel should update to show the new turn (e.g., "Turn 4 of 4")
5. If you were viewing the latest turn, it should auto-advance

**Pass:** New turns appear in the panel after agent responses without manual refresh

### AC5.5: Proportional Stacked Bar

1. With the debug panel open and a turn selected
2. Verify a colored horizontal bar appears near the top of the panel
3. Hover over each segment — tooltip should show section name, token count, and percentage
4. Segments should be proportional to their token counts
5. Colors should match Tokyo Metro theme:
   - Orange (system)
   - Red (tools)
   - Purple (history)
   - Green (memory)
   - Blue (task-digest)
   - Gold (skill-context)
   - Emerald (volatile-other)
   - Gray (free space)

**Pass:** Bar renders with proportional segments in correct colors

### AC5.6: Section List Display

1. Below the bar, verify a list of sections appears
2. Each row should show: colored dot, section name, token count, percentage
3. Token counts should be formatted with locale separators (e.g., "12,345")
4. Percentages should have one decimal place (e.g., "15.3%")
5. A "free space" row should appear at the bottom in gray

**Pass:** All sections listed with correct formatting

### AC5.7: History Section Expand/Collapse

1. Find the "history" row in the section list
2. It should have a chevron (▶) indicating it's expandable
3. Click on it — children should expand showing "user", "assistant", "tool_result" with individual token counts
4. Click again — children should collapse

**Pass:** History section expands to show role breakdown and collapses on toggle

### AC5.8: Turn Navigation

1. With multiple turns available, verify arrow buttons (< >) appear
2. Click ">" to advance to a later turn — all visualizations should update
3. Click "<" to go back — visualizations should revert
4. When viewing the latest turn, a "Latest" badge should appear
5. The "<" button should be disabled on the first turn
6. The ">" button should be disabled on the latest turn

**Pass:** Arrow buttons navigate between turns correctly

### AC5.9: Sparkline Chart

1. Verify an SVG area chart appears below the section list
2. The chart should show a trend line of token usage across turns
3. The currently selected turn should have a highlighted dot
4. Click on a different point on the chart — the selected turn should change
5. All other visualizations (bar, section list, summary) should update

**Pass:** Sparkline shows trend with interactive turn selection

### AC5.10: Actual vs Estimated Display

1. In the turn summary area, verify both "Estimated" and "Actual (API)" token counts are shown
2. If actual token data is available, a "Variance" line should appear showing the difference
3. Variance should show both absolute difference and percentage

**Pass:** Both estimated and actual token counts displayed with variance when available

## Notes

- AC5.5 and AC5.9 require visual inspection for proportionality and color accuracy
- The sparkline chart uses `preserveAspectRatio="none"` so it stretches to fill width
- Budget pressure warning (orange banner) only appears when context window is nearly full
- If no turns have context debug data (pre-existing threads), the panel will show "No turn data yet"
