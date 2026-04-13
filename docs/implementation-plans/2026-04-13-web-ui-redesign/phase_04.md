# Web UI Redesign — Phase 4: LineView Redesign

**Goal:** Update the thread detail view with max-width message area, station-dot turn indicator, and shared components.

**Architecture:** Modify existing LineView.svelte and MessageBubble.svelte to use MetroCard-based message styling, add a TurnIndicator component for the left-margin station dots, and constrain message width.

**Tech Stack:** Svelte 5, shared components from Phase 1

**Scope:** 8 phases from original design (phase 4 of 8)

**Codebase verified:** 2026-04-13

**Investigation findings:**
- LineView.svelte: Vertical flex column with header, MessageList, and input area.
- MessageBubble.svelte: Role-based styling with inline CSS. Has `.user`, `.assistant`, `.tool_result`, `.tool_error`, `.system` classes.
- MessageList.svelte: Scrollable container with auto-scroll, tool call grouping, turn range filtering.
- All styling is inline per-component. No shared card abstraction used.

---

## Acceptance Criteria Coverage

### ui-redesign.AC8: LineView layout
- **ui-redesign.AC8.1 Success:** Message area has max-width 800px, centered
- **ui-redesign.AC8.2 Success:** Header shows LineBadge for thread color, StatusChip for active state
- **ui-redesign.AC8.3 Success:** Model pill appears in message metadata row (bottom), not top

### ui-redesign.AC9: Station-dot turn indicator
- **ui-redesign.AC9.1 Success:** Vertical line in thread's line color runs along left margin of message list
- **ui-redesign.AC9.2 Success:** Station dot (6px) appears at each turn boundary
- **ui-redesign.AC9.3 Success:** Latest turn's dot pulses with badge-pulse animation

### ui-redesign.AC10: Message bubble styling
- **ui-redesign.AC10.1 Success:** User messages have emerald (--line-7) accent border
- **ui-redesign.AC10.2 Success:** Assistant messages have thread's own line color accent border
- **ui-redesign.AC10.3 Success:** Tool groups retain purple dashed border

---

<!-- START_TASK_1 -->
### Task 1: Create TurnIndicator component

**Verifies:** ui-redesign.AC9.1, ui-redesign.AC9.2, ui-redesign.AC9.3

**Files:**
- Create: `packages/web/src/client/components/TurnIndicator.svelte`

**Implementation:**

Component that renders the vertical station-dot line for the message list.

Props:
- `turnCount: number` — total number of turns (user→agent pairs)
- `lineColor: string` — CSS color for the line and dots
- `isActive: boolean` — whether agent is currently thinking (extends dashed line)

Render:
- Container: `position: absolute; left: 0; top: 0; bottom: 0; width: 24px`
- Vertical line: `position: absolute; left: 11px; top: 0; bottom: 0; width: 2px; background: {lineColor}; opacity: 0.4`
- Station dots: Positioned absolutely at calculated Y offsets. Each dot: `width: 6px; height: 6px; border-radius: 50%; background: {lineColor}; border: 2px solid var(--bg-secondary)`
- Last dot: Apply `animation: badge-pulse 2s ease-in-out infinite` (uses existing global keyframe)
- Active thinking: Append a dashed line segment below the last dot: `border-left: 2px dashed {lineColor}; opacity: 0.3; animation: extend-line 1s ease-in-out infinite`

The Y positions of dots will need to be coordinated with the MessageList — pass `turnBoundaryOffsets: number[]` as a prop, computed by MessageList from DOM measurements of where each turn starts.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

**Commit:** `feat(web): add TurnIndicator component`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update MessageBubble to use MetroCard styling

**Verifies:** ui-redesign.AC10.1, ui-redesign.AC10.2, ui-redesign.AC10.3, ui-redesign.AC8.3

**Files:**
- Modify: `packages/web/src/client/components/MessageBubble.svelte`

**Implementation:**

Replace the inline card styling with MetroCard. The component already receives `role` and renders role-specific styling.

Changes:
1. Import `MetroCard` from `./shared`.
2. Replace the outer `<div class="bubble {role}">` with `<MetroCard accentColor={accentColor}>` where `accentColor` is computed:
   - `role === "user"` → `"var(--line-7)"` (emerald)
   - `role === "assistant"` → `getLineColor(threadColor)` (thread's own color). Add `threadColor: number` prop.
   - `role === "tool_result"` → keep existing purple via ToolCallGroup (no change needed)
   - `role === "tool_error"` → `"var(--alert-disruption)"`
   - `role === "system"` → no MetroCard (keep transparent/centered/italic)

3. Move model pill from the top of the bubble to a metadata row at the bottom, alongside the timestamp.

4. The background tints (`rgba(...)`) become part of MetroCard's content area, applied via a class on an inner wrapper.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass (component import tests in components.test.ts should still work)

**Commit:** `refactor(web): update MessageBubble to use MetroCard`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Update LineView layout with max-width and header

**Verifies:** ui-redesign.AC8.1, ui-redesign.AC8.2

**Files:**
- Modify: `packages/web/src/client/views/LineView.svelte`

**Implementation:**

1. Import `LineBadge`, `StatusChip` from `../components/shared`.

2. **Header update**: Add `LineBadge lineIndex={thread.color}` next to the thread title. Add `StatusChip` showing thread status (active/idle) from the existing status fetch. Remove cancel button from header (it's rarely needed and clutters).

3. **Max-width constraint**: Wrap the MessageList and input area in a container:
```css
.line-content {
  max-width: 800px;
  margin: 0 auto;
  width: 100%;
}
```

4. **Turn indicator integration**: Add a `position: relative` wrapper around MessageList. Place `TurnIndicator` as an absolutely positioned child. Compute turn boundaries from the message list (count user→assistant turn pairs). Add `padding-left: 32px` to MessageList to make room for the indicator.

5. Pass `threadColor` prop down to MessageBubble for thread-colored assistant accents.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

Run: `bun run build`
Expected: Build succeeds

**Commit:** `feat(web): update LineView with max-width, LineBadge header, and turn indicator`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Verify LineView in e2e

**Verifies:** ui-redesign.AC8.1, ui-redesign.AC9.1

**Files:**
- Modify: `e2e/web-chat.spec.ts` (extend existing LineView tests)

**Testing:**

Add tests:
- Verify `.line-content` element has `max-width: 800px` CSS property
- Verify `.turn-indicator` element exists when viewing a thread with messages
- Verify LineBadge element exists in the header

**Verification:**
Run: `bun run test:e2e`
Expected: All e2e tests pass

**Commit:** `test(web): add LineView redesign e2e tests`
<!-- END_TASK_4 -->
