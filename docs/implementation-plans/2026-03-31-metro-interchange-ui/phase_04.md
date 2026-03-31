# Metro Interchange UI — Phase 4: Interchange Rail Visualization

**Goal:** Render a persistent metro rail with cross-thread interchange branches in the thread view. A vertical line in the current thread's color runs down the messages panel, with horizontal branch lines at turns where cross-thread context was used, each terminating in a station marker with the source thread's letter code.

**Architecture:** New `InterchangeRail.svelte` component renders as an absolutely-positioned SVG inside the `.board` container from Phase 3. It subscribes to the same `wsEvents` store used by `ContextDebugPanel.svelte` and consumes `context:debug` events enriched with `crossThreadSources` from Phase 1. LineView passes thread color, messages, and context debug turn data as props.

**Tech Stack:** Svelte 5, SVG, WebSocket events

**Scope:** Phase 4 of 4 from original design

**Codebase verified:** 2026-03-31

**Dependencies:** Phase 1 (backend `crossThreadSources` in `ContextDebugInfo`), Phase 3 (`.board` container with left padding)

---

## Acceptance Criteria Coverage

This phase implements and tests:

### metro-interchange-ui.AC3: Metro Interchange Visualization
- **metro-interchange-ui.AC3.3 Success:** Vertical rail in current thread's metro color is visible on every LineView conversation
- **metro-interchange-ui.AC3.4 Success:** Horizontal branch lines appear at turns with cross-thread sources, each colored in the source thread's metro color
- **metro-interchange-ui.AC3.5 Success:** Each branch terminates with a station marker showing the source thread's letter code (white inner circle + black text style)
- **metro-interchange-ui.AC3.6 Edge:** Rail displays with no branches when no cross-thread context exists (clean vertical line only)

---

<!-- START_SUBCOMPONENT_A (tasks 1-4) -->

<!-- START_TASK_1 -->
### Task 1: Extend client-side types and add shared line constants

**Files:**
- Modify: `packages/web/src/client/lib/api.ts:41-59` (extend ContextDebugTurn)
- Create: `packages/web/src/client/lib/metro-lines.ts` (shared line codes and colors)

**Implementation:**

**api.ts** — Extend the `ContextDebugTurn.context_debug` inline type to include the optional `crossThreadSources` field added by Phase 1:

```typescript
export interface ContextDebugTurn {
	turn_id: number;
	model_id: string;
	tokens_in: number;
	tokens_out: number;
	context_debug: {
		contextWindow: number;
		totalEstimated: number;
		model: string;
		sections: Array<{
			name: string;
			tokens: number;
			children?: Array<{ name: string; tokens: number }>;
		}>;
		budgetPressure: boolean;
		truncated: number;
		crossThreadSources?: Array<{
			threadId: string;
			title: string;
			color: number;
			messageCount: number;
			lastMessageAt: string;
		}>;
	};
	created_at: string;
}
```

**metro-lines.ts** — Extract the line codes and colors from SystemMap.svelte into a shared module so InterchangeRail can use them without importing from a view:

```typescript
// Tokyo Metro line colors — same palette as SystemMap.svelte and App.svelte CSS vars
export const LINE_COLORS = [
	"#F39700", // Ginza (G)        — orange
	"#E60012", // Marunouchi (M)   — red
	"#9CAEB7", // Hibiya (H)       — silver
	"#009BBF", // Tozai (T)        — sky blue
	"#009944", // Chiyoda (C)      — green
	"#C1A470", // Yurakucho (Y)    — gold
	"#8F76D6", // Hanzomon (Z)     — purple
	"#00AC9B", // Namboku (N)      — emerald
	"#9C5E31", // Fukutoshin (F)   — brown
	"#B6007A", // Oedo (E)         — ruby
];

// Tokyo Metro line letter codes
export const LINE_CODES = ["G", "M", "H", "T", "C", "Y", "Z", "N", "F", "E"];

export function getLineColor(colorIndex: number): string {
	return LINE_COLORS[colorIndex % LINE_COLORS.length];
}

export function getLineCode(colorIndex: number): string {
	return LINE_CODES[colorIndex % LINE_CODES.length];
}
```

**Optional refactor:** After creating `metro-lines.ts`, refactor `SystemMap.svelte` to import `LINE_COLORS` and `LINE_CODES` from `../lib/metro-lines.ts` instead of maintaining its own duplicate `colors` and `lineCodes` arrays (lines 82-97). This eliminates constant duplication. If time permits, do this in the same commit; otherwise note it as follow-up.

**Verification:**

Run: `bun run build`
Expected: Build succeeds. No runtime impact yet — just type and constant additions.

**Commit:** `feat(web): extend ContextDebugTurn type and add shared metro line constants`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create InterchangeRail.svelte component

**Verifies:** metro-interchange-ui.AC3.3, metro-interchange-ui.AC3.4, metro-interchange-ui.AC3.5, metro-interchange-ui.AC3.6

**Files:**
- Create: `packages/web/src/client/components/InterchangeRail.svelte`

**Implementation:**

Create a new Svelte 5 component that renders an SVG overlay inside the LineView board container. The component receives props and renders reactively.

**Props:**
- `threadColor: number` — current thread's color index (from `thread.color`)
- `messages: Message[]` — the messages array for positioning branches
- `contextDebugTurns: ContextDebugTurn[]` — turn data with potential crossThreadSources
- `scrollContainer: HTMLElement | null` — reference to the `.messages` scroll container for height/scroll sync

**Core rendering logic:**

1. **Vertical rail:** A single `<line>` or `<rect>` in the current thread's metro color, running the full scrollable height of the messages container. Positioned at `x=20` (within the 40px left padding from Phase 3). Width: 3px. Color: `getLineColor(threadColor)`.

2. **Branch lines:** For each turn that has `crossThreadSources`, find the corresponding assistant message position in the DOM (by matching turn index to assistant message index, or by `created_at` timestamp proximity). At that Y position, draw horizontal branch lines extending from x=0 to x=20 (meeting the vertical rail). One branch per source thread, stacked vertically with ~16px spacing.

3. **Station markers:** At the end of each branch line (x=0 side), render a small station marker circle (12px diameter) in the source thread's metro color with white inner circle and black letter code — matching the Phase 2 Tokyo Metro signage style. Uses `getLineColor(source.color)` and `getLineCode(source.color)`.

4. **Scroll synchronization:** The SVG element should be absolutely positioned within the board container and match the full scrollable height. As the messages container scrolls, the SVG scrolls with it (either by being inside the scrolling container, or by transforming based on scroll offset).

**Approach for scroll sync:** Place the SVG inside the `.messages` div (before the message list) with `position: absolute`, matching the full `scrollHeight`. Since it's inside the scrolling container, it scrolls naturally with the messages. Use a `$effect` reactive block to update SVG height when messages change.

**Turn-to-message correlation:** Correlate turns to assistant messages by **timestamp proximity**, not by index order. For each `ContextDebugTurn`, find the assistant message whose `created_at` is closest to (and not before) `turn.created_at`. This is more robust than index matching because a single turn can produce multiple messages (tool calls generate tool_call + tool_result messages alongside the assistant message). For each matched assistant message element, compute its `offsetTop` relative to the scroll container to get the Y position for branches. If no assistant message matches a turn (e.g., turn is still in progress), skip that turn's branches.

Use `$effect` to observe:
- `messages` length changes (re-render rail)
- `contextDebugTurns` changes (re-render branches)
- `scrollContainer?.scrollHeight` changes (resize SVG)

**Edge case (AC3.6):** When no turns have `crossThreadSources` (or no turns exist yet), the component renders only the vertical rail line — a clean vertical line with no branches.

**Edge case (AC3.7 from Phase 1):** When `contextDebugTurns[n].context_debug.crossThreadSources` is `undefined` (old turn data), treat it as no cross-thread context for that turn — no branches drawn.

**Verification:**

Run: `bun run build`
Expected: Build succeeds.

Visual verification: Component renders correctly when mounted (verified in Task 3 integration).

**Commit:** `feat(web): create InterchangeRail.svelte metro rail visualization component`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Integrate InterchangeRail into LineView

**Verifies:** metro-interchange-ui.AC3.3, metro-interchange-ui.AC3.4, metro-interchange-ui.AC3.5, metro-interchange-ui.AC3.6

**Files:**
- Modify: `packages/web/src/client/views/LineView.svelte` (import component, add data flow, mount in template)

**Implementation:**

**Script section — Add imports and state:**

```typescript
import InterchangeRail from "../components/InterchangeRail.svelte";
import type { ContextDebugTurn } from "../lib/api.ts";
import { wsEvents, type WebSocketMessage } from "../lib/websocket.ts";
```

Add state for context debug turns (following ContextDebugPanel.svelte's pattern at lines 43-80):

```typescript
let contextDebugTurns: ContextDebugTurn[] = $state([]);
```

**Script section — Subscribe to context:debug events:**

Add a WebSocket subscription in the `onMount` block, following the exact pattern from ContextDebugPanel.svelte:

```typescript
const unsubscribeDebug = wsEvents.subscribe((events: WebSocketMessage[]) => {
    if (events.length === 0) return;
    const last = events[events.length - 1];
    if (last && last.type === "context:debug" && typeof last.data === "object" && last.data !== null) {
        const debugData = last.data as ContextDebugTurn & { thread_id?: string };
        if (debugData.thread_id === threadId) {
            const exists = contextDebugTurns.some((t) => t.turn_id === debugData.turn_id);
            if (!exists) {
                contextDebugTurns = [...contextDebugTurns, debugData];
            }
        }
    }
});
```

**Clean up the subscription in `onDestroy`.** LineView already has an `onDestroy` block (around line 118) that calls `disconnectWebSocket()`. Add the debug subscription cleanup to the SAME block:

```typescript
onDestroy(() => {
    unsubscribeDebug();
    disconnectWebSocket();
    // ... any other existing cleanup
});
```

The `unsubscribeDebug` variable must be declared at the top-level scope of the script (not inside `onMount`) so it's accessible in `onDestroy`. Declare the subscription at the top-level, matching the existing `wsEvents` subscription pattern in LineView (around line 43).

**Script section — Load initial context debug data:**

On mount, also fetch historical context debug turns:

```typescript
const initialTurns = await api.getContextDebug(threadId);
contextDebugTurns = initialTurns;
```

**Template — Mount InterchangeRail inside the .messages div:**

Place the InterchangeRail **inside** the `.messages` div (as the first child, before the message list). This ensures the SVG scrolls naturally with the messages — no transform-based scroll sync needed:

```html
<div class="board">
    <div class="messages" bind:this={messagesEl}>
        <InterchangeRail
            threadColor={thread?.color ?? 0}
            {messages}
            {contextDebugTurns}
            scrollContainer={messagesEl}
        />
        {#each messages as msg}
            <MessageBubble ... />
        {/each}
    </div>
</div>
```

The InterchangeRail renders as a `position: absolute` SVG inside the scrolling `.messages` container. Because the `.messages` div has `position: relative` (set in Phase 3 Task 1), the SVG positions correctly relative to the message list — NOT relative to `.board`. This is critical: the SVG must be a child of the scrolling container AND that container must be the positioned ancestor. The SVG height matches the container's `scrollHeight`, so it scrolls naturally with the content.

**Verification:**

Run: `bun run build`
Expected: Build succeeds.

Visual verification:
1. Open any thread — vertical rail visible in thread's metro color (AC3.3)
2. Thread with no cross-thread context — clean vertical line only (AC3.6)
3. Thread where agent used cross-thread context — branch lines at corresponding turns in source thread colors (AC3.4)
4. Each branch ends with station marker showing letter code (AC3.5)
5. Scroll up/down — rail stays synchronized with messages

**Commit:** `feat(web): integrate InterchangeRail into LineView with context debug data flow`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Load context debug data on navigation and handle edge cases

**Files:**
- Modify: `packages/web/src/client/views/LineView.svelte` (handle thread navigation, error states)

**Implementation:**

Ensure context debug data is refreshed when the user navigates between threads (if LineView is reused across thread changes):

1. When `threadId` changes (if LineView remounts or uses reactive routing), reset `contextDebugTurns = []` and re-fetch via `api.getContextDebug(threadId)`.

2. Handle API errors gracefully — if `getContextDebug` fails, set `contextDebugTurns = []` (rail shows with no branches, which is the correct fallback per AC3.6).

3. Handle the case where `thread` object hasn't loaded yet — pass `threadColor={thread?.color ?? 0}` with a fallback to color index 0 (Ginza orange). This prevents errors during initial load.

**Verification:**

Run: `bun run build`
Expected: Build succeeds.

Visual verification:
1. Navigate between threads — rail updates to show correct thread color and branches
2. Open thread with no turns yet — clean vertical rail, no errors in console
3. Open thread with old turns (no crossThreadSources field) — clean vertical rail, no console errors (AC3.7 frontend handling)

**Commit:** `fix(web): handle thread navigation and edge cases in InterchangeRail data flow`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_A -->
