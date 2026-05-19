# Observability Dashboard Implementation Plan — Phase 3

**Goal:** Interactive date range selection component shared across all metrics sections, with presets and custom date inputs

**Architecture:** Standalone DateRangeBar.svelte component using callback props for range changes. Parent MetricsView holds date state and passes an `onRangeChange` callback. Presets compute ISO strings, custom inputs use native date inputs with 300ms debounce.

**Tech Stack:** Svelte 5 (runes, $state, $props), native HTML date inputs, TypeScript

**Scope:** 7 phases from original design (this is phase 3 of 7)

**Codebase verified:** 2026-05-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### observability-dashboard.AC2: Token usage and cost dashboard (partial)
- **observability-dashboard.AC2.2 Success:** Date range presets (24h/7d/30d/All) filter the displayed data correctly
- **observability-dashboard.AC2.6 Edge:** Custom date range with future end-date clamps to current time

### observability-dashboard.AC3: Relay performance dashboard (partial)
- **observability-dashboard.AC3.2 Success:** Same date range filter applies to relay section as token section

### observability-dashboard.AC4: Context assembly metrics (partial)
- **observability-dashboard.AC4.2 Success:** Same date range filter applies to context section

---

<!-- START_TASK_1 -->
### Task 1: Create DateRangeBar component

**Verifies:** observability-dashboard.AC2.2, observability-dashboard.AC2.6

**Files:**
- Create: `packages/web/src/client/components/DateRangeBar.svelte`

**Implementation:**

Create a Svelte 5 component with these props (using `$props()` rune):

```typescript
interface Props {
	from: string;
	to: string;
	onRangeChange: (from: string, to: string) => void;
	disabled?: boolean;
}
```

State:
- `let activePreset = $state<"24h" | "7d" | "30d" | "all" | "custom">("24h")` — tracks which preset is active
- `let customFrom = $state("")` and `let customTo = $state("")` — for custom date input values
- `let debounceTimer: ReturnType<typeof setTimeout> | null = $state(null)` — debounce handle

Preset handlers:
- `24h`: `from = new Date(Date.now() - 24 * 3600_000).toISOString()`, `to = new Date().toISOString()`
- `7d`: `from = new Date(Date.now() - 7 * 24 * 3600_000).toISOString()`, `to = new Date().toISOString()`
- `30d`: `from = new Date(Date.now() - 30 * 24 * 3600_000).toISOString()`, `to = new Date().toISOString()`
- `all`: `from = "2020-01-01T00:00:00.000Z"` (epoch floor), `to = new Date().toISOString()`

When a preset is clicked: compute `from`/`to`, call `onRangeChange(from, to)`, set `activePreset`.

Custom date inputs:
- Use `<input type="datetime-local">` for granular selection
- On input change, set `activePreset = "custom"`, start 300ms debounce timer
- After debounce, validate dates (from < to), clamp `to` to current time if in future (AC2.6), call `onRangeChange`
- If validation fails (from >= to), do not call `onRangeChange` — show subtle visual indication

Styling:
- Follow MemoryGraph.svelte tier-pill pattern for preset buttons
- `class:active={activePreset === preset}` for visual toggle
- Active: `background: var(--ink); color: var(--paper); border-color: var(--ink)`
- Inactive: `background: transparent; border: 1px solid var(--rule-soft)`
- Date inputs: `border: 1px solid var(--rule-soft); background: transparent; font-family: var(--font-mono); font-size: 12px`
- Layout: `display: flex; gap: 8px; align-items: center; flex-wrap: wrap`
- Separator text "to" between date inputs in `var(--ink-3)` color

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

**Commit:** `feat(web): add DateRangeBar component with presets and custom range`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Integrate DateRangeBar into MetricsView

**Verifies:** observability-dashboard.AC2.2, observability-dashboard.AC3.2, observability-dashboard.AC4.2

**Files:**
- Modify: `packages/web/src/client/views/MetricsView.svelte` — add DateRangeBar import and wire up state

**Implementation:**

In MetricsView.svelte:

1. Import DateRangeBar: `import DateRangeBar from "../components/DateRangeBar.svelte"`

2. Replace the inline `from`/`to` state initialization with proper defaults:
   ```typescript
   let from = $state(new Date(Date.now() - 24 * 3600_000).toISOString());
   let to = $state(new Date().toISOString());
   ```

3. Create a `handleRangeChange` function:
   ```typescript
   function handleRangeChange(newFrom: string, newTo: string): void {
       from = newFrom;
       to = newTo;
       loadMetrics();
   }
   ```

4. Place `<DateRangeBar>` in the template between the first SectionHeader and the content area, above all three metric sections:
   ```svelte
   <DateRangeBar {from} {to} onRangeChange={handleRangeChange} disabled={loading} />
   ```

5. Update polling logic: the 30-second poll should only fire when the range includes "now" — check if `to` is within 1 minute of the current time (presets always do this, custom past-only ranges don't). When poll fires, refresh `to` to current time before fetching.

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

Manual: Verify that clicking presets triggers a new fetch (check network tab or console.log).

**Commit:** `feat(web): integrate DateRangeBar into MetricsView with reactive fetching`
<!-- END_TASK_2 -->
