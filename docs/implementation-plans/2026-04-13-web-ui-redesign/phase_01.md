# Web UI Redesign — Phase 1: Shared Design System

**Goal:** Create the foundational shared component library that all views will use.

**Architecture:** Extract inline styling patterns into 5 reusable Svelte 5 components (LineBadge, MetroCard, StatusChip, DataTable, SectionHeader) with consistent design tokens. All components use existing CSS custom properties from App.svelte.

**Tech Stack:** Svelte 5 (runes, snippets), existing CSS custom properties, bun:test

**Scope:** 8 phases from original design (phase 1 of 8)

**Codebase verified:** 2026-04-13

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ui-redesign.AC1: Shared components exist and render correctly
- **ui-redesign.AC1.1 Success:** LineBadge renders a colored circle with the correct metro line letter for any index 0-9
- **ui-redesign.AC1.2 Success:** MetroCard renders with bg-secondary background, optional accent border, and hover state
- **ui-redesign.AC1.3 Success:** StatusChip renders dot + label with correct color for each status type
- **ui-redesign.AC1.4 Success:** DataTable renders sortable columns with sticky header and row expansion
- **ui-redesign.AC1.5 Success:** SectionHeader renders title, subtitle, and action slot

### ui-redesign.AC2: Design tokens are consistent
- **ui-redesign.AC2.1 Success:** No view-specific surface colors exist outside the --bg-primary/secondary/surface hierarchy
- **ui-redesign.AC2.2 Success:** All status indicators use StatusChip with the shared status color palette

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Create LineBadge component

**Verifies:** ui-redesign.AC1.1

**Files:**
- Create: `packages/web/src/client/components/LineBadge.svelte`

**Implementation:**

Create a Svelte 5 component that renders a colored circle badge with a metro line letter.

Props (using `$props()` rune):
- `lineIndex: number` — index into `LINE_COLORS`/`LINE_CODES` arrays
- `size?: "standard" | "compact"` — defaults to `"standard"` (32px vs 20px)

Import `getLineColor` and `getLineCode` from `../lib/metro-lines.ts` (already exported).

Render: A `<span>` with inline `background-color` from `getLineColor(lineIndex)`, border-radius 50%, white centered letter from `getLineCode(lineIndex)`. Standard = 32px diameter, font-size 14px. Compact = 20px diameter, font-size 10px. Both use `--font-display` font-family, font-weight 700.

Add `role="img"` and `aria-label="Line {code}"` for accessibility.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests still pass (no regressions)

**Commit:** `feat(web): add LineBadge shared component`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create MetroCard component

**Verifies:** ui-redesign.AC1.2

**Files:**
- Create: `packages/web/src/client/components/MetroCard.svelte`

**Implementation:**

Svelte 5 component for the universal card container.

Props:
- `accentColor?: string` — CSS color for optional 3px left border
- `interactive?: boolean` — defaults to `false`. When true, adds hover state and `cursor: pointer`
- `children: Snippet` — Svelte 5 snippet for card content (default slot)

Styles (scoped `<style>`):
- `.metro-card`: `background: var(--bg-secondary)`, `border: 1px solid var(--bg-surface)`, `border-radius: 8px`, `padding: 12px`
- When `accentColor` is set: `border-left: 3px solid {accentColor}`
- `.metro-card.interactive:hover`: `background: rgba(15, 52, 96, 0.3)`
- Transition: `background 0.15s ease`

Use `{@render children()}` for content slot.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests still pass

**Commit:** `feat(web): add MetroCard shared component`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Create StatusChip component

**Verifies:** ui-redesign.AC1.3

**Files:**
- Create: `packages/web/src/client/components/StatusChip.svelte`

**Implementation:**

Svelte 5 component for status indicator pills.

Props:
- `status: "active" | "running" | "pending" | "failed" | "idle" | "cancelled" | "delayed" | "overdue" | "healthy" | "degraded" | "unreachable"`
- `label?: string` — override the default label (defaults to uppercase status name)
- `animate?: boolean` — defaults to `true` for running/active statuses

Internal color mapping (use a `const STATUS_COLORS` map):
- `active`, `running`, `healthy` → `var(--status-active)` (#69F0AE)
- `pending`, `delayed` → `var(--alert-warning)` (#FF9100)
- `failed`, `overdue`, `unreachable` → `var(--alert-disruption)` (#FF1744)
- `idle`, `cancelled`, `degraded` → `var(--text-muted)` (#6B6B80)

Render: `<span class="status-chip">` containing a 6px colored dot + uppercase label in `--text-xs` size, `letter-spacing: 0.04em`.

When `animate` is true and status is `active`/`running`: apply `badge-pulse` animation (already defined in App.svelte as a global keyframe).

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests still pass

**Commit:** `feat(web): add StatusChip shared component`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Create SectionHeader component

**Verifies:** ui-redesign.AC1.5

**Files:**
- Create: `packages/web/src/client/components/SectionHeader.svelte`

**Implementation:**

Svelte 5 component for view title bars.

Props:
- `title: string`
- `subtitle?: string`
- `actions?: Snippet` — optional Svelte 5 snippet for right-aligned action area

Render:
- Flex row, `align-items: center`, `gap: 12px`, `margin-bottom: 16px`
- `<h1>` with title: `font-size: var(--text-xl)`, `font-weight: 700`, `color: var(--text-primary)`, `margin: 0`
- `<span>` with subtitle (if provided): `font-size: var(--text-sm)`, `text-transform: uppercase`, `color: var(--text-muted)`, `letter-spacing: 0.06em`
- Actions area: `margin-left: auto` for right alignment, render via `{@render actions()}`

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests still pass

**Commit:** `feat(web): add SectionHeader shared component`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->
<!-- START_TASK_5 -->
### Task 5: Create DataTable component

**Verifies:** ui-redesign.AC1.4

**Files:**
- Create: `packages/web/src/client/components/DataTable.svelte`

**Implementation:**

Svelte 5 component for consistent tabular data. This is the most complex shared component.

Props:
- `columns: Array<{ key: string; label: string; width?: string; mono?: boolean; sortable?: boolean }>` — column definitions
- `rows: Array<Record<string, any>>` — row data, each keyed by column `key`
- `sortable?: boolean` — enable sort (default false). When true, clicking a header toggles sort.
- `expandable?: boolean` — enable row expansion (default false)
- `expandedContent?: Snippet<[row: Record<string, any>]>` — snippet for expanded row content
- `onRowClick?: (row: Record<string, any>) => void` — optional row click handler
- `rowAccent?: (row: Record<string, any>) => string | null` — optional function returning accent color per row

Internal state (runes):
- `let sortKey = $state<string | null>(null)`
- `let sortDir = $state<"asc" | "desc">("asc")`
- `let expandedRowId = $state<string | null>(null)`

Compute sorted rows via `$derived`.

Render:
- Wrapper: `overflow-x: auto` for horizontal scroll on narrow viewports
- Header row: `display: grid`, `grid-template-columns` from column widths, sticky positioning. Labels in `--text-xs`, uppercase, `--text-muted`. Sort indicator arrow (▲/▼) next to sortable column headers.
- Data rows: Same grid. Row hover: `background: rgba(15, 52, 96, 0.15)`. Monospace font for `mono: true` columns. Optional left accent border via `rowAccent()`.
- Expanded row: Full-width panel below the row, rendered via `{@render expandedContent(row)}` when `expandedRowId === row.id`.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests still pass

**Commit:** `feat(web): add DataTable shared component`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Add unit tests for DataTable sorting logic

**Verifies:** ui-redesign.AC1.4

**Files:**
- Create: `packages/web/src/client/lib/__tests__/data-table-utils.test.ts`
- Create: `packages/web/src/client/lib/data-table-utils.ts`

**Implementation:**

Extract the sort logic from DataTable into a pure utility function for testability:

`data-table-utils.ts`:
- `export function sortRows(rows, sortKey, sortDir)` — returns a new sorted array
- Handles string comparison, numeric comparison, null values (sort to end)

`data-table-utils.test.ts`:
Tests must verify:
- Sorts strings ascending/descending
- Sorts numbers ascending/descending
- Null values sort to end regardless of direction
- Returns original order when sortKey is null
- Does not mutate the input array

Update DataTable.svelte to import and use `sortRows` from `../lib/data-table-utils.ts`.

**Verification:**
Run: `bun test packages/web/src/client/lib/__tests__/data-table-utils.test.ts`
Expected: All sort tests pass

**Commit:** `test(web): add DataTable sort utility tests`
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_C -->

<!-- START_TASK_7 -->
### Task 7: Export shared components from barrel file

**Files:**
- Create: `packages/web/src/client/components/shared.ts`

**Implementation:**

Create a barrel export for all shared design system components:

```typescript
export { default as LineBadge } from "./LineBadge.svelte";
export { default as MetroCard } from "./MetroCard.svelte";
export { default as StatusChip } from "./StatusChip.svelte";
export { default as DataTable } from "./DataTable.svelte";
export { default as SectionHeader } from "./SectionHeader.svelte";
```

This allows views to import as: `import { LineBadge, MetroCard } from "../components/shared";`

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests still pass

Run: `tsc -p packages/web --noEmit`
Expected: No type errors (if tsconfig exists for web package; otherwise verify via `bun run build`)

**Commit:** `feat(web): add shared component barrel export`
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: Verify build succeeds with new components

**Files:**
- No new files

**Verification:**
Run: `bun run build`
Expected: Build succeeds. New components are compiled into the Vite bundle without errors.

Run: `bun test packages/web`
Expected: All existing tests pass, new data-table-utils tests pass.

**Commit:** No commit needed (verification only)
<!-- END_TASK_8 -->
