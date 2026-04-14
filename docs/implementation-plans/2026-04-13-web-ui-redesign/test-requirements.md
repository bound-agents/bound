# Web UI Redesign — Test Requirements

Maps each acceptance criterion across all 8 phases to specific automated tests or human verification steps.

**Test frameworks:** bun:test (unit/integration), Playwright (e2e)
**Test locations:**
- Server tests: `packages/web/src/server/__tests__/*.test.ts`
- Client utility tests: `packages/web/src/client/lib/__tests__/*.test.ts`
- E2e tests: `e2e/*.spec.ts`

---

## Phase 1: Shared Design System

| AC ID | Description | Test Type | Test File Path | Automated? | Notes |
|-------|-------------|-----------|---------------|------------|-------|
| AC1.1 | LineBadge renders colored circle with correct metro line letter for index 0-9 | e2e | `e2e/web-chat.spec.ts` | Yes | Verify `.line-badge` elements render with correct `aria-label` text for each line code (G, M, H, T, C, Y, Z, N, F, E). Also verify via build success that component compiles. |
| AC1.2 | MetroCard renders with bg-secondary background, optional accent border, hover state | e2e | `e2e/web-chat.spec.ts` | Partial | Verify `.metro-card` elements exist on page. **Human verification:** Inspect accent border color, hover background shift (rgba(15,52,96,0.3)), and 0.15s transition in browser devtools. |
| AC1.3 | StatusChip renders dot + label with correct color for each status type | unit | `packages/web/src/client/lib/__tests__/status-chip-utils.test.ts` | Partial | If color mapping is extracted to a utility, test the mapping function. Otherwise **human verification:** Inspect each status color in running app — active/running/healthy=green, pending/delayed=orange, failed/overdue/unreachable=red, idle/cancelled/degraded=muted. Verify badge-pulse animation on active/running statuses. |
| AC1.4 | DataTable renders sortable columns with sticky header and row expansion | unit | `packages/web/src/client/lib/__tests__/data-table-utils.test.ts` | Yes | Tests sort logic: string asc/desc, numeric asc/desc, null-to-end, no-sort passthrough, immutability. Sticky header and row expansion are structural — verified via build + e2e. |
| AC1.5 | SectionHeader renders title, subtitle, and action slot | e2e | `e2e/web-chat.spec.ts` | Partial | Verify `h1` text matches expected view title. **Human verification:** Confirm subtitle uppercase/muted styling, action slot right-alignment. |
| AC2.1 | No view-specific surface colors outside bg-primary/secondary/surface | unit | N/A | No | **Human verification:** Grep CSS in all `.svelte` view files for hardcoded `background` or `background-color` values that don't reference `--bg-primary`, `--bg-secondary`, or `--bg-surface`. Run: `grep -rn 'background.*#' packages/web/src/client/views/` and inspect results. |
| AC2.2 | All status indicators use StatusChip with shared status color palette | unit | N/A | No | **Human verification:** Search view files for inline status badge implementations that bypass StatusChip. Run: `grep -rn 'badge-pulse\|status-dot\|\.status' packages/web/src/client/views/` and verify they delegate to StatusChip. |

---

## Phase 2: API Enhancements

| AC ID | Description | Test Type | Test File Path | Automated? | Notes |
|-------|-------------|-----------|---------------|------------|-------|
| AC3.1 | Memory graph returns nodes with key, value, tier, source, lineIndex, modifiedAt | integration | `packages/web/src/server/__tests__/memory-graph.test.ts` | Yes | Insert 3 semantic_memory rows (pinned, summary, default), fetch `/api/memory/graph`, assert nodes array has correct fields. |
| AC3.2 | Memory graph returns edges with sourceKey, targetKey, relation, modifiedAt | integration | `packages/web/src/server/__tests__/memory-graph.test.ts` | Yes | Insert 2 memory_edges rows, fetch endpoint, assert edges array shape. |
| AC3.3 | Soft-deleted memories and edges excluded | integration | `packages/web/src/server/__tests__/memory-graph.test.ts` | Yes | Insert rows with `deleted=1`, verify they do not appear in response. |
| AC3.4 | Source provenance resolves to thread title and line index | integration | `packages/web/src/server/__tests__/memory-graph.test.ts` | Yes | Insert memory with source=thread_id, insert matching thread. Verify `sourceThreadTitle` and `lineIndex`. Also test source="agent" returns nulls. |
| AC4.1 | Threads API includes messageCount | integration | `packages/web/src/server/__tests__/routes.integration.test.ts` | Yes | Create thread + 3 messages, fetch `/api/threads`, verify `messageCount: 3`. Also test 0-message thread. |
| AC4.2 | Threads API includes lastModel | integration | `packages/web/src/server/__tests__/routes.integration.test.ts` | Yes | Create thread + turn with model_id, verify `lastModel`. Test thread with no turns returns null. |
| AC5.1 | Tasks API includes displayName | unit | `packages/web/src/server/__tests__/task-display.test.ts` | Yes | Test `extractDisplayName()` with cron payload (returns key name), deferred (returns description), heartbeat (returns "heartbeat"), malformed (returns fallback). |
| AC5.2 | Tasks API includes human-readable schedule | unit | `packages/web/src/server/__tests__/task-display.test.ts` | Yes | Test `extractSchedule()` with `*/15 * * * *` -> "every 15m", `0 * * * *` -> "hourly", deferred -> "one-time", event -> "on-event". |
| AC5.3 | Tasks API includes hostName | integration | `packages/web/src/server/__tests__/task-display.test.ts` | Yes | Insert task with claimed_by matching host site_id, insert host with host_name. Fetch `/api/tasks`, verify `hostName`. Test null claimed_by. |
| AC5.4 | Tasks API includes lastDurationMs | integration | `packages/web/src/server/__tests__/task-display.test.ts` | Yes | Insert task with claimed_at, insert turn 5000ms later. Verify `lastDurationMs` ~5000. Test no-turns case returns null. |

---

## Phase 3: System Map Redesign

| AC ID | Description | Test Type | Test File Path | Automated? | Notes |
|-------|-------------|-----------|---------------|------------|-------|
| AC6.1 | Thread list shows LineBadge with correct line color | e2e | `e2e/web-chat.spec.ts` | Partial | Verify `.line-badge` elements exist in thread list panel. **Human verification:** Confirm badge colors match thread.color index (compare with LINE_COLORS palette). |
| AC6.2 | Thread list shows full title, summary, message count, relative time, StatusChip | e2e | `e2e/web-chat.spec.ts` | Partial | Verify thread card content includes title text, message count indicator, time element. **Human verification:** Confirm 2-line title clamp, summary ellipsis, correct relative time format. |
| AC6.3 | Thread list sorts by last activity with today/older separator | unit | N/A | No | **Human verification:** Create threads with activity today and >24h ago. Verify visual divider with date label appears between groups. Confirm sort order is newest-first. |
| AC6.4 | Clicking thread navigates to LineView | e2e | `e2e/web-chat.spec.ts` | Yes | Click thread row, assert hash changes to `#/line/{threadId}` and LineView renders. |
| AC7.1 | Memory graph nodes styled by tier (pinned=12px, summary=8px, default=6px, detail=4px) | unit | `packages/web/src/client/lib/__tests__/graph-layout.test.ts` | Yes | Test `computeGraphLayout()` returns correct radius per tier. Y positions: pinned=40, summary=160, default=280. |
| AC7.2 | Memory graph renders edges between connected nodes | unit | `packages/web/src/client/lib/__tests__/graph-layout.test.ts` | Yes | Test edge positions connect correct node pairs from input. |
| AC7.3 | Selecting thread highlights its memories, dims others to ~20% | unit | `packages/web/src/client/lib/__tests__/graph-layout.test.ts` | Yes | Test with selectedThreadId: matching nodes get opacity 1.0, non-matching get 0.2. |
| AC7.4 | Hovering node shows tooltip with key, value preview, tier, source | e2e | `e2e/web-chat.spec.ts` | No | **Human verification:** Hover over memory graph nodes and confirm tooltip appears with: key (bold), value preview (truncated 100 chars), tier badge, source thread name, modified date. Verify tooltip positions correctly near cursor. |
| AC7.5 | Map panel is collapsible | e2e | `e2e/web-chat.spec.ts` | Yes | Verify collapse toggle button exists. Click it, verify map panel hides. Click again, verify it reappears. |
| AC7.6 | Empty/loading/error states render correctly | e2e | `e2e/web-chat.spec.ts` | Partial | Verify empty state text "No memories yet" renders when no memories exist. **Human verification:** Confirm loading skeleton dots animate at layer positions. Confirm error state shows "Could not load memory graph" with retry button. |

---

## Phase 4: LineView Redesign

| AC ID | Description | Test Type | Test File Path | Automated? | Notes |
|-------|-------------|-----------|---------------|------------|-------|
| AC8.1 | Message area has max-width 800px, centered | e2e | `e2e/web-chat.spec.ts` | Yes | Verify `.line-content` element has `max-width: 800px` CSS property via Playwright `evaluate`. |
| AC8.2 | Header shows LineBadge and StatusChip | e2e | `e2e/web-chat.spec.ts` | Yes | Navigate to a thread, verify `.line-badge` and `.status-chip` elements exist in header area. |
| AC8.3 | Model pill in message metadata row (bottom), not top | e2e | `e2e/web-chat.spec.ts` | No | **Human verification:** Open a thread with assistant messages. Confirm model indicator appears at the bottom of message bubbles alongside timestamp, not at the top. |
| AC9.1 | Vertical line in thread's line color runs along left margin | e2e | `e2e/web-chat.spec.ts` | Yes | Verify `.turn-indicator` element exists when viewing a thread with messages. |
| AC9.2 | Station dot (6px) at each turn boundary | e2e | `e2e/web-chat.spec.ts` | No | **Human verification:** Open thread with multiple turns. Count station dots — should equal number of user-to-agent turn pairs. Each dot should be 6px, positioned on the vertical line. |
| AC9.3 | Latest turn's dot pulses with badge-pulse animation | e2e | N/A | No | **Human verification:** Open a thread. Confirm the bottommost station dot has a visible pulse animation. During active thinking, confirm dashed line extends below with animation. |
| AC10.1 | User messages have emerald (--line-7) accent border | e2e | N/A | No | **Human verification:** Open thread, confirm user message bubbles have left border in emerald (#00AC9B). Compare against `--line-7` token value. |
| AC10.2 | Assistant messages have thread's own line color accent | e2e | N/A | No | **Human verification:** Open threads with different color indices. Confirm assistant message left borders match the thread's assigned line color, not a fixed color. |
| AC10.3 | Tool groups retain purple dashed border | e2e | N/A | No | **Human verification:** Open thread with tool calls. Confirm tool call group has dashed left border in Hanzomon purple (#8F76D6). |

---

## Phase 5: Timetable Redesign

| AC ID | Description | Test Type | Test File Path | Automated? | Notes |
|-------|-------------|-----------|---------------|------------|-------|
| AC11.1 | Departure board shows next 3-5 tasks with LineBadge, name, countdown, status | e2e | `e2e/web-chat.spec.ts` | Partial | Verify departure board panel element exists on Timetable view. **Human verification:** Confirm it shows compact task rows with LineBadge (20px), monospace countdown, ON TIME/DELAYED/OVERDUE labels with correct color coding. Max 5 items. |
| AC12.1 | Table shows displayName instead of raw JSON trigger | e2e | `e2e/web-chat.spec.ts` | Partial | Verify table cell text does not contain raw JSON. **Human verification:** Confirm human-readable task names appear (e.g., "research-scan" not `{"cron_key":"research-scan",...}`). |
| AC12.2 | Table shows human-readable schedule | unit | `packages/web/src/server/__tests__/task-display.test.ts` | Yes | Covered by AC5.2 server-side tests. Client renders the pre-computed field. **Human verification:** Confirm "every 15m", "hourly", "one-time" labels appear in Schedule column. |
| AC12.3 | Table shows hostName instead of truncated site ID | e2e | `e2e/web-chat.spec.ts` | Partial | **Human verification:** Confirm Host column shows readable names (e.g., "polaris") not hex site IDs. |
| AC12.4 | Default sort: status weight then next_run ascending | unit | `packages/web/src/client/lib/__tests__/task-sort.test.ts` | Yes | Running before failed, failed before pending, pending sorted by soonest next_run, cancelled/completed at bottom, null next_run to end. |
| AC13.1 | Clicking row expands to show full task details | e2e | `e2e/web-chat.spec.ts` | Partial | Click a task row, verify expanded panel appears below with payload content. **Human verification:** Confirm expanded panel shows payload JSON, execution history, consecutive_failures, thread link. |
| AC13.2 | `/task/:id` route removed from App.svelte | unit | N/A | No | **Verification approach:** Search App.svelte for `/task/` route handling — must be absent. Run `grep -n 'task/' packages/web/src/client/App.svelte` to confirm no route match. Build must succeed with route removed. |

---

## Phase 6: Network Status Redesign

| AC ID | Description | Test Type | Test File Path | Automated? | Notes |
|-------|-------------|-----------|---------------|------------|-------|
| AC14.1 | SVG diagram shows hub as central interchange, spokes as branches | e2e | `e2e/network-status.spec.ts` | Yes | Verify TopologyDiagram SVG element renders. Verify hub node (double circle) and spoke nodes exist. |
| AC14.2 | Connection lines colored by sync health | e2e | `e2e/network-status.spec.ts` | No | **Human verification:** With known sync state, inspect SVG line stroke colors: green for healthy, orange for degraded, red for unreachable, grey for unknown. |
| AC15.1 | Host cards use MetroCard with LineBadge | e2e | `e2e/network-status.spec.ts` | Yes | Verify `.metro-card` elements exist in host cards section. Verify `.line-badge` elements exist within cards. |
| AC15.2 | Online = last seen within 5min, Offline = beyond. No status contradiction. | integration | N/A | No | **Human verification:** (1) Confirm a host with `online_at` < 5min ago shows "Online" StatusChip. (2) Confirm a host with `online_at` > 5min ago shows "Offline". (3) Confirm no card simultaneously shows "Offline" + "Sync: Healthy" — the previous contradiction. **Suggested future test:** Integration test that mocks `online_at` timestamps and asserts computed status. |
| AC15.3 | Models and MCP tools shown as small pills | e2e | `e2e/network-status.spec.ts` | No | **Human verification:** Inspect host cards for model and MCP tool pill elements. Confirm they render as small rounded labels, not raw JSON arrays. |
| AC16.1 | Sync Mesh uses DataTable with properly sized columns | e2e | `e2e/network-status.spec.ts` | Yes | Verify DataTable renders with expected column headers (Peer, Sent, Received, Last Sync, Errors). |
| AC16.2 | Peer column shows host name, not raw site ID | e2e | `e2e/network-status.spec.ts` | No | **Human verification:** Inspect Sync Mesh table Peer column. Confirm values are human-readable host names, not 32-char hex site IDs. |
| AC16.3 | Error count color-coded (0=green, >0=red) | e2e | `e2e/network-status.spec.ts` | No | **Human verification:** Inspect Errors column. Confirm 0 appears in green, positive counts in orange/red. |

---

## Phase 7: Advisories Redesign

| AC ID | Description | Test Type | Test File Path | Automated? | Notes |
|-------|-------------|-----------|---------------|------------|-------|
| AC17.1 | Proposed cards have orange 4px top band | e2e | N/A | No | **Human verification:** Navigate to Advisories view with proposed advisories. Confirm each proposed card has a visible 4px orange top border (`--alert-warning`). |
| AC17.2 | Failed/escalated cards have red band + subtle glow | e2e | N/A | No | **Human verification:** Inspect failed advisory card. Confirm red 4px top border + subtle red box-shadow glow. |
| AC17.3 | Dismissed/deferred cards have muted opacity | e2e | N/A | No | **Human verification:** Confirm dismissed/deferred cards render with `opacity: 0.6`, visually receding compared to active cards. |
| AC18.1 | Source badge shows LineBadge, not star icon | e2e | N/A | No | **Human verification:** Inspect advisory cards. Confirm source badge is a colored LineBadge circle (not the old `*` / star icon). Color should derive from task type or host. |
| AC18.2 | Identical-title advisories collapse into one card with count badge | unit | `packages/web/src/client/lib/__tests__/advisory-utils.test.ts` | Yes | Test `deduplicateAdvisories()`: 5 same-title advisories collapse to count=5, mixed titles group correctly, singles have count=1. |
| AC18.3 | Source attribution shows "from task-name on host-name" | e2e | N/A | No | **Human verification:** Inspect advisory cards. Confirm source line reads like "from research-scan on polaris" rather than raw site ID or missing attribution. |
| AC19.1 | Unresolved (proposed, approved) grouped at top | unit | `packages/web/src/client/lib/__tests__/advisory-utils.test.ts` | Yes | Test that dedup output sorts unresolved before resolved. |
| AC19.2 | Resolved in collapsible section below | e2e | N/A | No | **Human verification:** Confirm resolved advisories appear in a collapsed section with a toggle. Expand it and verify applied/dismissed/deferred cards appear. Section starts collapsed. |

---

## Phase 8: Files + TopBar Alignment

| AC ID | Description | Test Type | Test File Path | Automated? | Notes |
|-------|-------------|-----------|---------------|------------|-------|
| AC20.1 | FilePreviewModal uses MetroCard-aligned border/radius/spacing | e2e | N/A | No | **Human verification:** Open a file preview modal. Confirm: background is `--bg-secondary`, border is `1px solid var(--bg-surface)`, border-radius is 8px, padding is 16px. Compare visually against MetroCard instances elsewhere. |
| AC20.2 | Directory icons use Yurakucho gold (--line-5) | e2e | N/A | No | **Human verification:** Navigate to Files view. Confirm folder icons render in Yurakucho gold (#C1A470). File-type icons should retain their existing distinct colors. |
| AC21.1 | System Map dot = Ginza orange (--line-0) | e2e | `e2e/web-chat.spec.ts` | Partial | Verify nav dot element for System Map has correct color. **Human verification:** Confirm dot is orange (#F39700). |
| AC21.2 | Timetable dot = Marunouchi red (--line-1) | e2e | `e2e/web-chat.spec.ts` | Partial | **Human verification:** Confirm Timetable nav dot is red (#E60012). |
| AC21.3 | Network dot = Chiyoda green (--line-4) | e2e | `e2e/web-chat.spec.ts` | Partial | **Human verification:** Confirm Network nav dot is green (#009944). |
| AC21.4 | Files dot = Tozai blue (--line-3) | e2e | `e2e/web-chat.spec.ts` | Partial | **Human verification:** Confirm Files nav dot is blue (#009BBF). |
| AC21.5 | Advisories dot = Oedo ruby (--line-9) | e2e | `e2e/web-chat.spec.ts` | Partial | **Human verification:** Confirm Advisories nav dot is ruby (#B6007A). |

---

## Summary

| Category | Count |
|----------|-------|
| Total ACs | 53 |
| Fully automated (Yes) | 21 |
| Partially automated (Partial) | 15 |
| Human verification only (No) | 17 |

### Automated test files to create

| File | Framework | Phase | Tests |
|------|-----------|-------|-------|
| `packages/web/src/client/lib/__tests__/data-table-utils.test.ts` | bun:test | 1 | Sort logic (5 cases) |
| `packages/web/src/server/__tests__/memory-graph.test.ts` | bun:test | 2 | Memory graph API (4 cases: nodes, edges, soft-delete, provenance) |
| `packages/web/src/server/__tests__/routes.integration.test.ts` | bun:test | 2 | Enhanced thread fields (2 cases, added to existing file) |
| `packages/web/src/server/__tests__/task-display.test.ts` | bun:test | 2 | Task display utilities + route integration (8+ cases) |
| `packages/web/src/client/lib/__tests__/graph-layout.test.ts` | bun:test | 3 | Graph layout: tier positions, spacing, detail visibility, opacity, edges, empty input (7 cases) |
| `packages/web/src/client/lib/__tests__/task-sort.test.ts` | bun:test | 5 | Task sorting: status weight ordering, next_run tiebreak, null handling (5 cases) |
| `packages/web/src/client/lib/__tests__/advisory-utils.test.ts` | bun:test | 7 | Advisory dedup: collapse, grouping, ordering (4 cases) |
| `e2e/web-chat.spec.ts` | Playwright | 3-5, 8 | Extended with SystemMap, LineView, Timetable, TopBar checks |
| `e2e/network-status.spec.ts` | Playwright | 6 | New file for Network Status topology, cards, DataTable |

### Human verification checklist

For visual/subjective checks that cannot be automated, use this workflow:

1. **Start the dev server**: `bun packages/cli/src/bound.ts start` from the bound config directory, or `bun run build && cp ./dist/bound* ~/.local/bin/` for compiled binary.
2. **Open the web UI**: Navigate to `http://localhost:3001` in a Chromium-based browser.
3. **Walk each view** in order: System Map, LineView (open a thread), Timetable, Network, Advisories, Files.
4. **For each "No" row above**: Visually confirm the described behavior. Use browser DevTools (Elements panel) to verify exact CSS values (colors, spacing, border-radius, opacity) where specified.
5. **Responsive check**: Resize viewport to <900px. Confirm System Map memory panel collapses, thread list goes full-width.
6. **Animation check**: Confirm badge-pulse on active StatusChips, station dot pulse on latest turn, dashed line during thinking state.
7. **Interaction check**: Confirm drag-to-resize on System Map split view, memory node hover tooltip, memory node click popover, task row expansion, advisory resolved section collapse/expand.
