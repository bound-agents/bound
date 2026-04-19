# Boundless Implementation Plan — Phase 6: TUI Primitives & Design System

**Goal:** Build the shared primitive component library that all views compose from. Each component is a self-contained Ink (React for terminals) component with keyboard handling where needed.

**Architecture:** Atomic components in `packages/less/src/tui/components/`. Primitives (Spinner, Badge, KeyHint) are display-only. Controls (TextInput, SelectList, Confirm) handle keyboard input via Ink's `useInput` hook. Layout components (ScrollRegion, Banner, ModalOverlay, SplitView) provide structural composition. All use Ink's `<Box>` and `<Text>` with Flexbox layout.

**Tech Stack:** TypeScript, React 18, Ink 5, ink-testing-library for tests, bun:test

**Scope:** 8 phases from original design (phase 6 of 8)

**Codebase verified:** 2026-04-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### boundless.AC8: TUI Primitives
- **boundless.AC8.1 Success:** SelectList handles arrow-key navigation, enter to select, escape/Ctrl-C to cancel
- **boundless.AC8.2 Success:** Confirm handles yes/no with keyboard
- **boundless.AC8.3 Success:** TextInput handles text entry, submit, disabled state, placeholder
- **boundless.AC8.4 Success:** Collapsible toggles content visibility
- **boundless.AC8.5 Success:** Banner renders error/info with dismissal
- **boundless.AC8.6 Success:** ModalOverlay traps focus and dismisses on escape

---

<!-- START_TASK_1 -->
### Task 1: Display primitives — Spinner, Badge, KeyHint, Collapsible

**Verifies:** boundless.AC8.4

**Files:**
- Create: `packages/less/src/tui/components/Spinner.tsx`
- Create: `packages/less/src/tui/components/Badge.tsx`
- Create: `packages/less/src/tui/components/KeyHint.tsx`
- Create: `packages/less/src/tui/components/Collapsible.tsx`
- Test: `packages/less/src/__tests__/tui-primitives.test.tsx`

**Implementation:**

**Spinner**: Displays an activity indicator with elapsed time. Uses `useState` + `useEffect` with a 1-second interval to track elapsed seconds. Renders a rotating character (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) and formatted time.

**Badge**: Renders a colored status label. Props: `status: "running" | "failed" | "disabled" | "connected" | "disconnected"`. Maps each status to a color (green/red/gray/green/yellow) via Ink's `<Text color={...}>`.

**KeyHint**: Renders a keyboard shortcut hint. Props: `keys: string` (e.g., "Ctrl+C"), `label: string`. Renders as `<Text dimColor>[keys]</Text> <Text>{label}</Text>`.

**Collapsible** (AC8.4): Props: `header: string`, `defaultOpen?: boolean`, `children: ReactNode`. Uses `useState(defaultOpen ?? false)` for visibility. The header line shows `▸`/`▾` indicator. Keyboard toggle handled by parent via callback, not internally (to avoid input conflicts).

Add `"ink-testing-library": "^4.0.0"` as a devDependency in `packages/less/package.json` (v4 is compatible with Ink 5). Run `bun install` after adding.

**Testing:**

- boundless.AC8.4: Render Collapsible with defaultOpen=false, verify children not in output. Set open=true, verify children visible.

**Verification:**
Run: `bun test packages/less/src/__tests__/tui-primitives.test.tsx`
Expected: All tests pass

**Commit:** `feat(less): TUI display primitives — Spinner, Badge, KeyHint, Collapsible`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Control primitives — TextInput, SelectList, Confirm

**Verifies:** boundless.AC8.1, boundless.AC8.2, boundless.AC8.3

**Files:**
- Create: `packages/less/src/tui/components/TextInput.tsx`
- Create: `packages/less/src/tui/components/SelectList.tsx`
- Create: `packages/less/src/tui/components/Confirm.tsx`
- Test: `packages/less/src/__tests__/tui-controls.test.tsx`

**Implementation:**

**TextInput** (AC8.3): Props: `onSubmit: (value: string) => void`, `placeholder?: string`, `disabled?: boolean`. Uses `useState("")` for value, `useInput` for keyboard handling. On character input: append to value. On backspace: remove last char. On return: call onSubmit. When disabled: `useInput` with `isActive: false`. Renders cursor indicator, value text, or dimmed placeholder when empty.

**SelectList** (AC8.1): Props: `items: T[]`, `onSelect: (item: T) => void`, `onCancel?: () => void`, `renderItem: (item: T, selected: boolean) => ReactNode`. Uses `useState(0)` for selected index. `useInput`: up arrow decrements, down arrow increments (clamped to bounds), return calls onSelect, escape/Ctrl-C calls onCancel. Renders items vertically with highlight on selected.

**Confirm** (AC8.2): Props: `message: string`, `onYes: () => void`, `onNo: () => void`. Uses `useInput`: 'y' calls onYes, 'n' calls onNo, return confirms current selection. Renders message with [Y/n] hint.

**Testing:**

- boundless.AC8.1: Render SelectList with 3 items, write down arrow to stdin, verify selected index moves, write enter, verify onSelect called with correct item. Write escape, verify onCancel called.
- boundless.AC8.2: Render Confirm, write 'y' to stdin, verify onYes called. Render again, write 'n', verify onNo called.
- boundless.AC8.3: Render TextInput, write characters to stdin, verify value displayed. Write enter, verify onSubmit called with typed value. Render with disabled=true, write characters, verify no change.

Use `ink-testing-library`'s `render()` and `stdin.write()` for all input simulation.

**Verification:**
Run: `bun test packages/less/src/__tests__/tui-controls.test.tsx`
Expected: All tests pass

**Commit:** `feat(less): TUI control primitives — TextInput, SelectList, Confirm`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Layout primitives — ScrollRegion, Banner, ModalOverlay, SplitView, ActionBar

**Verifies:** boundless.AC8.5, boundless.AC8.6

**Files:**
- Create: `packages/less/src/tui/components/ScrollRegion.tsx`
- Create: `packages/less/src/tui/components/Banner.tsx`
- Create: `packages/less/src/tui/components/ModalOverlay.tsx`
- Create: `packages/less/src/tui/components/SplitView.tsx`
- Create: `packages/less/src/tui/components/ActionBar.tsx`
- Test: `packages/less/src/__tests__/tui-layout.test.tsx`

**Implementation:**

**ScrollRegion**: Props: `maxHeight?: number`, `children: ReactNode`. Wraps children in a `<Box>` with `height` constrained. Ink doesn't have native scroll, so this limits visible area and the parent manages scroll offset via `useState`. Renders a subset of children based on offset.

**Banner** (AC8.5): Props: `type: "error" | "info"`, `message: string`, `onDismiss?: () => void`. Renders a colored bar (red for error, blue for info) with the message. If `onDismiss` provided, shows a dismiss hint. Background color via `<Text backgroundColor={...}>`.

**ModalOverlay** (AC8.6): Props: `onDismiss: () => void`, `children: ReactNode`. Renders children on top of the screen content. Uses `useInput` to capture escape key for dismissal. The `isActive` flag on `useInput` should be true only when the modal is mounted, effectively trapping focus.

**SplitView**: Props: `top: ReactNode`, `bottom: ReactNode`. Renders two `<Box>` regions vertically. The top region flexes, the bottom is fixed height. Used for ChatView (scrollback top, input bottom).

**ActionBar**: Props: `actions: Array<{ keys: string, label: string }>`. Renders a horizontal bar of `<KeyHint>` components separated by spaces.

**Testing:**

- boundless.AC8.5: Render Banner with type="error", verify red-colored output with message text
- boundless.AC8.6: Render ModalOverlay, write escape to stdin, verify onDismiss called

**Verification:**
Run: `bun test packages/less/src/__tests__/tui-layout.test.tsx`
Expected: All tests pass

**Commit:** `feat(less): TUI layout primitives — ScrollRegion, Banner, ModalOverlay, SplitView, ActionBar`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Component index and integration verification

**Verifies:** None (infrastructure)

**Files:**
- Create: `packages/less/src/tui/components/index.ts` (barrel export)

**Step 1: Create barrel export**

Export all components from a single index file for clean imports:
```ts
export { Spinner } from "./Spinner.js";
export { Badge } from "./Badge.js";
// ... all 12 components
```

**Step 2: Verify operationally**

Run: `tsc -p packages/less --noEmit`
Expected: All components typecheck clean

Run: `bun test packages/less`
Expected: All component tests pass

**Step 3: Commit**

```bash
git add packages/less/src/tui/
git commit -m "feat(less): complete TUI primitive design system"
```
<!-- END_TASK_4 -->
