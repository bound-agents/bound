# Metro Interchange UI — Phase 3: Compact LineView & Timetable Container

**Goal:** Increase information density in the thread view and wrap messages in a Timetable-style dark panel for visual containment, creating space for the Phase 4 interchange rail.

**Architecture:** CSS-only changes to LineView.svelte and MessageBubble.svelte. Wrap the messages area in a `.board` panel matching the Timetable view pattern. Reduce padding, margins, gaps, and max-width throughout. Header and input area remain outside the container. Add left padding inside the board to accommodate the future rail visualization.

**Tech Stack:** Svelte 5, CSS

**Scope:** Phase 3 of 4 from original design

**Codebase verified:** 2026-03-31

---

## Acceptance Criteria Coverage

This phase implements and tests:

### metro-interchange-ui.AC1: Compact LineView
- **metro-interchange-ui.AC1.1 Success:** Message bubbles use reduced padding (10px 14px) and margin (6px 0)
- **metro-interchange-ui.AC1.2 Success:** Header gap (10px), header margin-bottom (12px), and bottom-area padding (10px) are tighter than current values
- **metro-interchange-ui.AC1.3 Success:** LineView max-width is 42rem (narrower than current 48rem)
- **metro-interchange-ui.AC1.4 Success:** Textarea min-height is 44px with 8px 12px padding

### metro-interchange-ui.AC2: Timetable-Style Container
- **metro-interchange-ui.AC2.1 Success:** Messages area is wrapped in a panel with `background: rgba(10, 10, 20, 0.5)`, `border: 1px solid var(--bg-surface)`, `border-radius: 8px`
- **metro-interchange-ui.AC2.2 Success:** Header and input area remain outside the container panel
- **metro-interchange-ui.AC2.3 Success:** Messages scroll within the container while header and input stay fixed

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Wrap messages area in Timetable-style .board panel

**Verifies:** metro-interchange-ui.AC2.1, metro-interchange-ui.AC2.2, metro-interchange-ui.AC2.3

**Files:**
- Modify: `packages/web/src/client/views/LineView.svelte` (HTML template — messages section)
- Modify: `packages/web/src/client/views/LineView.svelte` (CSS — add `.board` class)

**Implementation:**

First, add a state variable for the messages DOM element reference in the script section (Phase 4 needs this for scroll synchronization):

```typescript
let messagesEl: HTMLDivElement | null = $state(null);
```

Then in the HTML template, wrap the existing `.messages` div in a new `.board` container. The current structure has three siblings: `.header`, `.messages`, `.bottom-area`. The new structure keeps `.header` and `.bottom-area` outside, and adds `bind:this={messagesEl}` to the messages div:

```html
<!-- Current structure: -->
<div class="header">...</div>
<div class="messages" bind:this={messagesEl}>
    {#each messages as msg}
        <MessageBubble ... />
    {/each}
</div>
<div class="bottom-area">...</div>

<!-- New structure: -->
<div class="header">...</div>
<div class="board">
    <div class="messages" bind:this={messagesEl}>
        {#each messages as msg}
            <MessageBubble ... />
        {/each}
    </div>
</div>
<div class="bottom-area">...</div>
```

Add the `.board` CSS class matching the Timetable.svelte pattern:

```css
.board {
    background: rgba(10, 10, 20, 0.5);
    border: 1px solid var(--bg-surface);
    border-radius: 8px;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    position: relative;
}
```

Update the existing `.messages` CSS — it should now fill the board and handle scrolling:

```css
.messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px 8px 12px 40px;
    height: 100%;
    position: relative;
}
```

The `padding-left: 40px` creates space for the Phase 4 interchange rail SVG overlay. The board uses `overflow: hidden` while the inner `.messages` div handles scroll with `overflow-y: auto`.

The board gets `flex: 1; min-height: 0` to fill available space between header and bottom-area (the LineView container is already a flex column). This matches how Timetable.svelte's `.board` fills its parent.

**Verification:**

Run: `bun run build`
Expected: Build succeeds.

Visual verification: Messages area wrapped in a dark panel with rounded corners. Header and input stay outside. Messages scroll within the panel.

**Commit:** `style(web): wrap LineView messages in Timetable-style board panel`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Compact LineView layout — reduce spacing and max-width

**Verifies:** metro-interchange-ui.AC1.2, metro-interchange-ui.AC1.3, metro-interchange-ui.AC1.4

**Files:**
- Modify: `packages/web/src/client/views/LineView.svelte` (CSS — layout properties)

**Implementation:**

Update the following CSS values in LineView.svelte:

| Selector | Property | Current | New | Line |
|----------|----------|---------|-----|------|
| `.line-view` (container) | `max-width` | `48rem` | `42rem` | 298 |
| `.header` | `gap` | `16px` | `10px` | 308 |
| `.header` | `margin-bottom` | `24px` | `12px` | 310 |
| `.bottom-area` | `padding-top` | `16px` | `10px` | 398 |
| `textarea` | `padding` | `12px 16px` | `8px 12px` | 449 |
| `textarea` | `min-height` | `56px` | `44px` | 457 |

These are straightforward CSS value changes. The exact selectors and properties already exist — only the values change.

**Verification:**

Run: `bun run build`
Expected: Build succeeds.

Visual verification: LineView narrower (42rem), header more compact, textarea smaller but still usable.

**Commit:** `style(web): compact LineView layout with reduced spacing and max-width`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Compact MessageBubble styling

**Verifies:** metro-interchange-ui.AC1.1

**Files:**
- Modify: `packages/web/src/client/components/MessageBubble.svelte:99-103` (CSS)

**Implementation:**

Update the `.message` CSS class in MessageBubble.svelte:

| Property | Current | New | Line |
|----------|---------|-----|------|
| `padding` | `14px 18px` | `10px 14px` | 99 |
| `margin` | `10px 0` | `6px 0` | 100 |
| `border-left` width | `3px` | `2px` | 103 |

The border-left change from 3px to 2px is a subtle refinement for the denser layout. All role-specific border colors remain unchanged.

**Verification:**

Run: `bun run build`
Expected: Build succeeds.

Visual verification: Messages appear more compact with tighter padding and margins. Border-left is thinner but still clearly visible.

**Commit:** `style(web): compact MessageBubble padding and margins`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
