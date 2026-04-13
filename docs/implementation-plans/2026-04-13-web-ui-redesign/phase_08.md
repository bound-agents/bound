# Web UI Redesign — Phase 8: Files + TopBar Alignment

**Goal:** Align Files view and TopBar to the shared design system. Lightest touch — consistency pass, not a rethink.

**Architecture:** Update FilesView.svelte to use MetroCard where applicable. Update TopBar.svelte nav dots to use consistent per-nav line color assignments.

**Tech Stack:** Svelte 5, shared components from Phase 1

**Scope:** 8 phases from original design (phase 8 of 8)

**Codebase verified:** 2026-04-13

**Investigation findings:**
- FilesView.svelte: 377 lines, two-column grid (260px/1fr). Already clean and well-structured.
- TopBar.svelte: 252 lines, 5 nav items with generic metro dots. Active state uses `--nav-color` inline style.
- FilePreviewModal.svelte: Fixed backdrop, modal panel, content-type-aware rendering. Good structure.
- TreeNode.svelte: Nested tree with indentation via CSS var `--tree-level`.

---

## Acceptance Criteria Coverage

### ui-redesign.AC20: Files alignment
- **ui-redesign.AC20.1 Success:** FilePreviewModal uses MetroCard-aligned border/radius/spacing
- **ui-redesign.AC20.2 Success:** Directory icons use Yurakucho gold (--line-5)

### ui-redesign.AC21: TopBar nav colors
- **ui-redesign.AC21.1 Success:** System Map dot = Ginza orange (--line-0)
- **ui-redesign.AC21.2 Success:** Timetable dot = Marunouchi red (--line-1)
- **ui-redesign.AC21.3 Success:** Network dot = Chiyoda green (--line-4)
- **ui-redesign.AC21.4 Success:** Files dot = Tozai blue (--line-3)
- **ui-redesign.AC21.5 Success:** Advisories dot = Oedo ruby (--line-9)

---

<!-- START_TASK_1 -->
### Task 1: Update TopBar nav dot colors

**Verifies:** ui-redesign.AC21.1, ui-redesign.AC21.2, ui-redesign.AC21.3, ui-redesign.AC21.4, ui-redesign.AC21.5

**Files:**
- Modify: `packages/web/src/client/components/TopBar.svelte` (nav items array, ~lines 18-24)

**Implementation:**

The current TopBar has nav items with `--nav-color` inline styles. Update the color assignments to use the consistent per-nav mapping from the design doc:

```typescript
const navItems = [
  { label: "System Map", hash: "/", color: "var(--line-0)" },     // Ginza orange
  { label: "Timetable", hash: "/timetable", color: "var(--line-1)" }, // Marunouchi red
  { label: "Network", hash: "/network", color: "var(--line-4)" },  // Chiyoda green
  { label: "Files", hash: "/files", color: "var(--line-3)" },      // Tozai blue
  { label: "Advisories", hash: "/advisories", color: "var(--line-9)" }, // Oedo ruby
];
```

Verify the `style="--nav-color: {item.color}"` binding propagates to the dot and active border styling.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

**Commit:** `style(web): update TopBar nav dots to consistent line color assignments`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Align FilePreviewModal to MetroCard

**Verifies:** ui-redesign.AC20.1

**Files:**
- Modify: `packages/web/src/client/components/FilePreviewModal.svelte`

**Implementation:**

Update the modal panel styling to align with the MetroCard design system:
- Modal panel background: `var(--bg-secondary)` (should already be close)
- Border: `1px solid var(--bg-surface)`
- Border-radius: `8px` (align to MetroCard)
- Internal padding: `16px` (align to MetroCard standard)

Check and adjust:
- Header styling: Ensure title uses `--text-lg`, metadata uses `--text-sm` + `--text-muted`
- Close button: Ensure hover uses `var(--bg-surface)` background
- Code block styling: Should already use Shiki tokyo-night theme (keep as-is)

This is a CSS alignment pass — no structural changes to the component.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

**Commit:** `style(web): align FilePreviewModal to MetroCard design system`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Update directory icon colors

**Verifies:** ui-redesign.AC20.2

**Files:**
- Modify: `packages/web/src/client/components/DirectoryListing.svelte` or `TreeNode.svelte` (wherever folder icon color is set)

**Implementation:**

Update the folder icon color to use Yurakucho gold (`var(--line-5)`, `#C1A470`). The current implementation likely uses inline `color` or `fill` on the lucide-svelte folder icon.

Change folder icon styling:
```css
.folder-icon { color: var(--line-5); }
```

Keep file-type-specific icon colors as-is (they're already well-differentiated).

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

**Commit:** `style(web): use Yurakucho gold for directory icons`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Final build verification and cleanup

**Files:** No new files

**Implementation:**

Run full test suite and build to verify all 8 phases integrate correctly.

Check for any remaining references to removed elements:
- **Remove `getInterchange`**: Delete the `getInterchange` function from `packages/web/src/client/lib/api.ts` and the `/api/threads/interchange` route handler from `packages/web/src/server/routes/threads.ts` (lines 45-83). These are dead code after the Phase 3 SystemMap rewrite removed all interchange spline consumers.
- Search for `TaskDetailView` imports — should only be in the dead component file and possibly `components.test.ts`
- Verify no views still use custom card/table styles that should use shared components

**Verification:**
Run: `bun test --recursive`
Expected: All tests pass across all packages

Run: `bun run build`
Expected: Build succeeds

Run: `bun run lint`
Expected: No lint errors (or only pre-existing ones)

**Commit:** `chore(web): cleanup unused imports and verify full build`
<!-- END_TASK_4 -->
