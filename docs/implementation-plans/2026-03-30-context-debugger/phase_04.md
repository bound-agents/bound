# Context Debugger Implementation Plan - Phase 4

**Goal:** Collapsible debug panel in the thread view with data fetching and turn navigation.

**Architecture:** `LineView.svelte` expands from a single centered column to a flex row when the debug panel is open. A new `ContextDebugPanel.svelte` component sits on the right side (320px wide), closed by default, toggled by a header button. The panel fetches historical data on first open via the Phase 3 API endpoint, then appends live updates via the existing WebSocket event subscription. Turn navigation with arrow buttons lets the user browse between turns.

**Tech Stack:** Svelte 5 (runes: $state, $derived, $effect), TypeScript, plain scoped CSS

**Scope:** 5 phases from original design (phase 4 of 5)

**Codebase verified:** 2026-03-31

**Testing reference:** This phase is primarily UI work. Verification is operational (visual inspection + Playwright e2e if configured). No unit tests for Svelte components — follow existing project pattern (no component unit tests found).

---

## Acceptance Criteria Coverage

This phase implements and tests:

### context-debugger.AC5: Debug Side Panel UI (partial — layout and data flow)
- **context-debugger.AC5.1 Success:** Toggle button in thread header opens/closes the debug panel
- **context-debugger.AC5.2 Success:** Panel is closed by default on page load
- **context-debugger.AC5.3 Success:** Panel fetches historical turn data on first open
- **context-debugger.AC5.4 Success:** Panel receives and appends live turn data via WebSocket

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add context-debug API function to api.ts

**Files:**
- Modify: `packages/web/src/client/lib/api.ts` (add new function, currently ~74 lines)

**Implementation:**

Add a new API function to the `api` object in `packages/web/src/client/lib/api.ts`. Follow the existing `fetchJson<T>()` pattern used by other API methods:

```typescript
/** Fetch context debug data for all turns in a thread */
async getContextDebug(threadId: string): Promise<ContextDebugTurn[]> {
	return fetchJson<ContextDebugTurn[]>(`/api/threads/${threadId}/context-debug`);
},
```

Add the type near the top of the file (or in a shared types file if one exists):

```typescript
interface ContextDebugTurn {
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
	};
	created_at: string;
}
```

**Verification:**

Run: `tsc -p packages/web --noEmit` (if applicable) or `bun run build`
Expected: No type errors

**Commit:** `feat(web): add context debug API client function`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create ContextDebugPanel.svelte component

**Verifies:** context-debugger.AC5.1, context-debugger.AC5.3, context-debugger.AC5.4

**Files:**
- Create: `packages/web/src/client/components/ContextDebugPanel.svelte`

**Implementation:**

Create a new Svelte 5 component with runes for reactive state management. Follow the patterns used by existing components (`MessageBubble.svelte`, `TreeNode.svelte`).

**Props:**
- `threadId: string` — the thread to fetch debug data for
- `wsEvents: import("svelte/store").Writable<WebSocketMessage[]>` — the WebSocket events store (imported from `../lib/websocket"`: `import { wsEvents, type WebSocketMessage } from "../lib/websocket"`)

**Reactive State:**
- `turns: ContextDebugTurn[]` = $state([]) — all turn debug records
- `selectedTurnIdx: number` = $state(-1) — currently selected turn index (-1 = latest)
- `loaded: boolean` = $state(false) — whether initial fetch has completed
- `loading: boolean` = $state(false) — whether fetch is in progress

**Data Flow:**

1. **On mount / first open:** Fetch historical data via `api.getContextDebug(threadId)`. Store in `turns`. Set `selectedTurnIdx` to last index (latest turn). Mark `loaded = true`.

2. **WebSocket subscription:** Use `$effect` to subscribe to `wsEvents` store. When a `context:debug` event arrives for this thread, append the new turn to `turns`. If user is viewing latest turn (selectedTurnIdx was at end), auto-advance to new latest.

3. **Turn navigation:** Arrow buttons (`<` and `>`) increment/decrement `selectedTurnIdx`. Derived state `selectedTurn` computes the currently displayed turn data. "Turn N of M" label between arrows.

4. **Thread navigation (threadId change):** Use a `$effect` to watch `threadId`. When it changes (user navigates to a different thread), reset state and re-fetch:

```typescript
$effect(() => {
	const _tid = threadId; // track dependency
	turns = [];
	selectedTurnIdx = -1;
	loaded = false;
	loading = false;
	// Re-fetch for the new thread
	fetchData();
});
```

This ensures the panel does not display stale data from a previous thread when the user navigates.

**Key reactive derivations:**
```typescript
let selectedTurn = $derived(
	turns.length > 0
		? turns[selectedTurnIdx >= 0 ? selectedTurnIdx : turns.length - 1]
		: null,
);
let turnLabel = $derived(
	turns.length > 0
		? `Turn ${(selectedTurnIdx >= 0 ? selectedTurnIdx : turns.length - 1) + 1} of ${turns.length}`
		: "No turns",
);
let isLatest = $derived(
	selectedTurnIdx < 0 || selectedTurnIdx === turns.length - 1,
);
```

**Template structure (skeleton — visualization components added in Phase 5):**
```svelte
<div class="debug-panel">
	<div class="panel-header">
		<span class="panel-title">Context Debug</span>
	</div>

	{#if loading}
		<div class="loading">Loading...</div>
	{:else if turns.length === 0}
		<div class="empty">No turn data yet</div>
	{:else}
		<div class="turn-nav">
			<button onclick={() => navigateTurn(-1)} disabled={selectedTurnIdx <= 0}>
				&lt;
			</button>
			<span class="turn-label">{turnLabel}</span>
			<button onclick={() => navigateTurn(1)} disabled={isLatest}>
				&gt;
			</button>
			{#if isLatest}
				<span class="latest-badge">Latest</span>
			{/if}
		</div>

		<div class="turn-summary">
			<div class="summary-row">
				<span>Estimated:</span>
				<span>{selectedTurn?.context_debug.totalEstimated.toLocaleString()} tokens</span>
			</div>
			<div class="summary-row">
				<span>Actual:</span>
				<span>{selectedTurn?.tokens_in.toLocaleString()} tokens</span>
			</div>
			<div class="summary-row">
				<span>Context window:</span>
				<span>{selectedTurn?.context_debug.contextWindow.toLocaleString()}</span>
			</div>
			{#if selectedTurn?.context_debug.budgetPressure}
				<div class="budget-warning">Budget pressure active</div>
			{/if}
		</div>

		<!-- Phase 5 visualization components will be inserted here -->
		<!-- <ContextBar sections={selectedTurn?.context_debug.sections} contextWindow={selectedTurn?.context_debug.contextWindow} /> -->
		<!-- <ContextSectionList sections={selectedTurn?.context_debug.sections} contextWindow={selectedTurn?.context_debug.contextWindow} /> -->
		<!-- <ContextSparkline turns={turns} selectedIdx={effectiveIdx} /> -->
	{/if}
</div>
```

**CSS (scoped):**
```css
.debug-panel {
	width: 320px;
	min-width: 320px;
	height: 100%;
	overflow-y: auto;
	border-left: 1px solid var(--bg-surface);
	background: var(--bg-secondary);
	padding: 16px;
	font-family: var(--font-body);
	font-size: 13px;
	color: var(--text-secondary);
}

.panel-header {
	display: flex;
	align-items: center;
	margin-bottom: 16px;
}

.panel-title {
	font-family: var(--font-display);
	font-size: 14px;
	font-weight: 600;
	color: var(--text-primary);
}

.turn-nav {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 12px;
}

.turn-nav button {
	background: var(--bg-surface);
	border: none;
	color: var(--text-primary);
	padding: 4px 8px;
	border-radius: 4px;
	cursor: pointer;
	font-size: 12px;
}

.turn-nav button:disabled {
	opacity: 0.3;
	cursor: default;
}

.turn-label {
	flex: 1;
	text-align: center;
	font-size: 12px;
}

.latest-badge {
	font-size: 10px;
	padding: 2px 6px;
	border-radius: 3px;
	background: var(--line-7);
	color: var(--bg-primary);
	font-weight: 600;
}

.turn-summary {
	margin-bottom: 16px;
}

.summary-row {
	display: flex;
	justify-content: space-between;
	padding: 4px 0;
	font-size: 12px;
}

.budget-warning {
	margin-top: 8px;
	padding: 4px 8px;
	border-radius: 4px;
	background: rgba(255, 145, 0, 0.15);
	color: var(--alert-warning);
	font-size: 11px;
	font-weight: 500;
}

.loading, .empty {
	text-align: center;
	padding: 32px 0;
	color: var(--text-muted);
	font-size: 12px;
}
```

**Testing:**

Tests must verify:
- **context-debugger.AC5.1:** Toggle button (in LineView, Task 3) opens/closes the panel.
- **context-debugger.AC5.3:** On first open, the component calls `api.getContextDebug(threadId)` and populates `turns`.
- **context-debugger.AC5.4:** When a `context:debug` WebSocket event arrives, a new turn is appended to `turns`.

Verification is operational — manually test in the running application or via Playwright e2e:
1. Open a thread with at least one agent turn
2. Click the debug toggle button — panel should appear on the right
3. Turn data should be populated with historical records
4. Send a new message — after agent responds, a new turn should appear in the panel
5. Navigate between turns with arrow buttons

**Verification:**

Run: `bun run build`
Expected: Build succeeds without errors

**Commit:** `feat(web): create ContextDebugPanel component with data fetching and turn navigation`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3) -->

<!-- START_TASK_3 -->
### Task 3: Update LineView.svelte layout for collapsible side panel

**Verifies:** context-debugger.AC5.1, context-debugger.AC5.2

**Files:**
- Modify: `packages/web/src/client/views/LineView.svelte`

**Implementation:**

The current LineView is a single centered column (`max-width: 48rem, margin: 0 auto`). It needs to become a flex row that conditionally includes the debug panel on the right.

1. **Add debug panel state** (near existing state declarations, around line 17-39):

```typescript
let debugOpen = $state(false);
let debugMounted = $state(false); // tracks if panel has been opened at least once (lazy mount)

function toggleDebug() {
	debugOpen = !debugOpen;
	if (debugOpen && !debugMounted) {
		debugMounted = true; // first open triggers data fetch in ContextDebugPanel
	}
}
```

2. **Add toggle button to header** (around line 214, between the title and the thinking indicator):

```svelte
<button class="debug-toggle" onclick={toggleDebug} title="Context Debug">
	{debugOpen ? '✕' : '⚙'}
</button>
```

3. **Wrap the existing content in a flex row** with conditional panel:

The outer wrapper needs to change. Currently the view is:
```svelte
<div class="line-view">
	<!-- header -->
	<!-- messages -->
	<!-- input -->
</div>
```

Change to:
```svelte
<div class="line-view-wrapper" class:panel-open={debugOpen}>
	<div class="line-view">
		<!-- header (with toggle button added) -->
		<!-- messages -->
		<!-- input -->
	</div>
	{#if debugMounted}
		<div class="debug-panel-container" class:hidden={!debugOpen}>
			<ContextDebugPanel {threadId} {wsEvents} />
		</div>
	{/if}
</div>
```

4. **Import the component:**

```typescript
import ContextDebugPanel from "../components/ContextDebugPanel.svelte";
```

5. **CSS changes:**

Add new wrapper styles and modify existing `.line-view` to be flexible:

```css
.line-view-wrapper {
	display: flex;
	flex-direction: row;
	height: 100%;
	width: 100%;
	overflow: hidden;
}

.line-view-wrapper .line-view {
	flex: 1;
	min-width: 0;
	/* Keep existing styles: flex-direction: column, padding, etc. */
	/* Remove margin: 0 auto and max-width when panel is open */
}

.line-view-wrapper.panel-open .line-view {
	max-width: none;
}

.debug-panel-container {
	flex-shrink: 0;
}

.debug-panel-container.hidden {
	display: none;
}

.debug-toggle {
	background: var(--bg-surface);
	border: 1px solid var(--bg-surface);
	color: var(--text-secondary);
	padding: 4px 8px;
	border-radius: 4px;
	cursor: pointer;
	font-size: 14px;
	transition: color 0.2s;
}

.debug-toggle:hover {
	color: var(--text-primary);
	border-color: var(--line-7);
}
```

**Key design decisions:**
- **Lazy mounting** (`debugMounted`): ContextDebugPanel only mounts on first open, triggering the API fetch (AC5.3). Hidden via CSS (`display: none`) on subsequent closes, preserving state.
- **Panel closed by default** (`debugOpen = $state(false)`), satisfying AC5.2.
- **Layout shift**: When panel opens, the main content area flexes to fill available space without max-width constraint. When closed, max-width 48rem + centered layout is restored.

**Testing:**

Tests must verify:
- **context-debugger.AC5.1:** Click debug toggle — panel appears. Click again — panel hides.
- **context-debugger.AC5.2:** On page load, panel is not visible. `debugOpen` defaults to false.

Verification is operational or via Playwright e2e:
1. Load a thread view — no debug panel visible
2. Click toggle button — panel slides in from right
3. Click toggle again — panel hides, main content re-centers

**Verification:**

Run: `bun run build`
Expected: Build succeeds

**Commit:** `feat(web): add collapsible debug panel to LineView layout`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_B -->
