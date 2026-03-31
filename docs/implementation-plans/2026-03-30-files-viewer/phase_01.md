# Files Viewer Implementation Plan

**Goal:** Redesign the files browser as a stable two-panel Windows Explorer-style layout with file preview modal

**Architecture:** CSS Grid two-panel layout (fixed 260px sidebar + flexible content area), enhanced TreeNode with directory selection, new components for breadcrumbs, directory listing, and file preview modal. All state in FilesView.svelte using Svelte 5 runes.

**Tech Stack:** Svelte 5 (runes: $state, $derived, $props), CSS Grid, shiki, marked, lucide-svelte, Playwright (e2e)

**Scope:** 3 phases from original design (phases 1-3)

**Codebase verified:** 2026-03-30

---

## Acceptance Criteria Coverage

This phase implements and tests:

### files-viewer.AC1: Stable file browser layout
- **files-viewer.AC1.1 Success:** Tree sidebar and content area render as a fixed two-panel grid that doesn't shift when resizing content
- **files-viewer.AC1.2 Success:** Expanding/collapsing folders in tree sidebar does not cause the content area to reflow or jump
- **files-viewer.AC1.5 Success:** Clicking a directory in the tree selects it, updates content area, and visually highlights the node

---

## Codebase Verification Findings

- **FilesView.svelte** (`packages/web/src/client/views/FilesView.svelte`, 274 lines): Single-pane flexbox layout. State: `tree`, `loading`, `error`, `expandedPaths` (SvelteSet). Uses `buildFileTree()`, `wsEvents.subscribe()` for real-time updates. Helper functions: `formatFileSize()`, `getFileIcon()`, `downloadFile()`.
- **TreeNode.svelte** (`packages/web/src/client/components/TreeNode.svelte`, 244 lines): Recursive component with Props interface accepting `node`, `expandedPaths`, `toggleExpanded`, `formatFileSize`, `getFileIcon`, `downloadFile`, `level`. Uses `$derived` for `isExpanded`, `isDir`, `nodeName`, `IconComponent`. Keyboard support (Enter/Space). CSS indentation via `--tree-level` variable.
- **file-tree.ts** (`packages/web/src/client/lib/file-tree.ts`, 71 lines): Exports `buildFileTree()`, `FileMetadata`, `FileTreeNode`. Internal `sortTree()` (NOT exported) — dirs first, then files, alphabetical.
- **CSS Grid**: Not used anywhere in current codebase — this will be the first CSS Grid layout. All existing layouts use flexbox.
- **CSS variables**: Full Tokyo Metro palette in `App.svelte` (lines 52-95). Key variables: `--bg-primary`, `--bg-secondary`, `--bg-surface`, `--text-primary`, `--text-secondary`, `--text-muted`, `--line-3` (sky blue), `--font-display`, `--font-mono`, `--text-sm`, `--text-xs`.
- **SvelteSet**: Used from `svelte/reactivity` for `expandedPaths` tracking.
- **E2e test pattern**: Route mocking via `page.route()` in Playwright (see `e2e/model-selector.spec.ts`). Skip pattern: `process.env.SKIP_E2E === "1"`.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Enhance TreeNode.svelte with directory selection support

**Verifies:** files-viewer.AC1.5

**Files:**
- Modify: `packages/web/src/client/components/TreeNode.svelte`

**Implementation:**

Add two new props to the `Props` interface and wire directory selection into the existing click handler.

Changes to the `<script>` section:

1. Add to `Props` interface (after `downloadFile` prop, before `level`):
   ```typescript
   selectedPath: string;
   onSelectDirectory: (path: string) => void;
   ```

2. Destructure the new props alongside existing ones (in the `$props()` call):
   ```typescript
   const {
   	node,
   	expandedPaths,
   	toggleExpanded,
   	formatFileSize,
   	getFileIcon,
   	downloadFile,
   	selectedPath,
   	onSelectDirectory,
   	level = 0,
   }: Props = $props();
   ```

3. Add a `$derived` for selected state (after the existing `$derived` declarations):
   ```typescript
   const isSelected = $derived(selectedPath === node.fullPath);
   ```

4. Modify `handleClick()` to call `onSelectDirectory` for directories (replace existing function):
   ```typescript
   function handleClick() {
   	if (isDir) {
   		toggleExpanded(node.fullPath);
   		onSelectDirectory(node.fullPath);
   	}
   }
   ```

5. Pass the new props through to the recursive `<TreeNode>` child in the template (add to the existing `<TreeNode>` element at line ~113-121):
   ```svelte
   <TreeNode
   	node={child}
   	{expandedPaths}
   	{toggleExpanded}
   	{formatFileSize}
   	{getFileIcon}
   	{downloadFile}
   	{selectedPath}
   	{onSelectDirectory}
   	level={level + 1}
   />
   ```

6. Add CSS class binding for selected state on the `.node-row` div (add alongside existing `class:node-dir` and `class:node-file`):
   ```svelte
   class:node-selected={isDir && isSelected}
   ```

7. Add CSS rule for selected state (add after `.node-row:hover` rule):
   ```css
   .node-row.node-selected {
   	background: rgba(0, 155, 191, 0.15);
   	border-left: 3px solid var(--line-3);
   	padding-left: calc(9px + var(--indent));
   }

   .node-row.node-selected:hover {
   	background: rgba(0, 155, 191, 0.2);
   }
   ```
   Note: `padding-left` is reduced by 3px to account for the 3px border-left, keeping alignment consistent.

**Testing:**

This task's behavior (AC1.5) is tested in Task 3 via e2e test. The directory selection state change and visual highlight are UI behaviors best verified through Playwright interaction.

**Verification:**
Run: `bun test packages/web`
Expected: Existing component import tests still pass (no regressions from prop additions).

**Commit:** `feat(web): add directory selection support to TreeNode component`

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Restructure FilesView.svelte to two-panel CSS Grid layout

**Verifies:** files-viewer.AC1.1, files-viewer.AC1.2, files-viewer.AC1.5

**Files:**
- Modify: `packages/web/src/client/views/FilesView.svelte`

**Implementation:**

Transform the single-pane flexbox layout into a two-panel CSS Grid with a fixed-width tree sidebar on the left and a flexible content area on the right.

**Script changes:**

1. Add `selectedPath` state (after `expandedPaths` declaration at line 20):
   ```typescript
   let selectedPath = $state("/");
   ```

2. Add `selectDirectory` handler (after `toggleExpanded` function):
   ```typescript
   function selectDirectory(path: string): void {
   	selectedPath = path;
   }
   ```

3. In `loadFiles()`, after `expandAllRecursive` loop (after line 36), set initial selectedPath to root:
   ```typescript
   // Reset selection to root when files reload
   selectedPath = "/";
   ```

**Template changes (replace the entire `{:else}` block, lines 144-157):**

Replace the existing `tree-container` div with a two-panel grid layout:

```svelte
{:else}
	<div class="files-browser">
		<aside class="tree-sidebar">
			{#each tree as node}
				<TreeNode
					{node}
					{expandedPaths}
					{toggleExpanded}
					{formatFileSize}
					{getFileIcon}
					{downloadFile}
					{selectedPath}
					onSelectDirectory={selectDirectory}
				/>
			{/each}
		</aside>
		<main class="content-area">
			<div class="content-placeholder">
				<p>Select a directory to browse its contents</p>
			</div>
		</main>
	</div>
{/if}
```

The `content-placeholder` is temporary — Phase 2 will replace it with breadcrumbs and a directory listing.

**CSS changes:**

Replace the existing `.tree-container` rule (lines 261-266) with the new grid layout styles:

```css
.files-browser {
	display: grid;
	grid-template-columns: 260px 1fr;
	flex: 1;
	min-height: 0;
	gap: 0;
	border: 1px solid rgba(0, 155, 191, 0.15);
	border-radius: 8px;
	overflow: hidden;
}

.tree-sidebar {
	display: flex;
	flex-direction: column;
	overflow-y: auto;
	overflow-x: hidden;
	min-height: 0;
	border-right: 1px solid rgba(0, 155, 191, 0.15);
	background: var(--bg-secondary);
	padding: 8px 0;
}

.content-area {
	display: flex;
	flex-direction: column;
	overflow-y: auto;
	min-height: 0;
	background: var(--bg-primary);
}

.content-placeholder {
	display: flex;
	align-items: center;
	justify-content: center;
	flex: 1;
	color: var(--text-muted);
	font-size: var(--text-sm);
	font-family: var(--font-display);
}

.content-placeholder p {
	margin: 0;
}
```

Key CSS decisions:
- `grid-template-columns: 260px 1fr` — fixed sidebar width, flexible content (AC1.1)
- Both panels have `overflow-y: auto` + `min-height: 0` — independent scrolling (AC1.2)
- `gap: 0` with a `border-right` on sidebar — clean visual separator
- `background: var(--bg-secondary)` on sidebar vs `var(--bg-primary)` on content — subtle differentiation using existing theme variables

**Testing:**

AC1.1, AC1.2, and AC1.5 are all UI layout/interaction behaviors verified in Task 3 via Playwright e2e test.

**Verification:**
Run: `bun test packages/web`
Expected: All existing tests pass. No regressions from template restructure.

Run: `bun run lint`
Expected: No new lint errors.

**Commit:** `feat(web): restructure FilesView to two-panel CSS Grid layout`

<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: E2e test for two-panel layout and directory selection

**Verifies:** files-viewer.AC1.1, files-viewer.AC1.2, files-viewer.AC1.5

**Files:**
- Create: `e2e/files-viewer.spec.ts`

**Implementation:**

Create a Playwright e2e test that mocks the `/api/files` endpoint with test data and verifies the three ACs for this phase.

The test should:
1. Mock `GET /api/files` to return a file list with nested directories (at least 2 levels deep) and files
2. Navigate to the files view (`/#files`)
3. Wait for the tree to render

Test data structure for the mock (use this shape matching `FileMetadata`):
```typescript
const testFiles = [
	{ id: "1", path: "home/user/src/index.ts", is_binary: 0, size_bytes: 1024, created_at: "2026-03-30T00:00:00Z", modified_at: "2026-03-30T00:00:00Z", deleted: 0, created_by: "agent", host_origin: "local" },
	{ id: "2", path: "home/user/src/utils.ts", is_binary: 0, size_bytes: 512, created_at: "2026-03-30T00:00:00Z", modified_at: "2026-03-30T00:00:00Z", deleted: 0, created_by: "agent", host_origin: "local" },
	{ id: "3", path: "home/user/docs/readme.md", is_binary: 0, size_bytes: 256, created_at: "2026-03-30T00:00:00Z", modified_at: "2026-03-30T00:00:00Z", deleted: 0, created_by: "agent", host_origin: "local" },
	{ id: "4", path: "home/user/config.json", is_binary: 0, size_bytes: 128, created_at: "2026-03-30T00:00:00Z", modified_at: "2026-03-30T00:00:00Z", deleted: 0, created_by: "agent", host_origin: "local" },
];
```

Follow the existing e2e patterns in `e2e/model-selector.spec.ts`:
- Use `page.route("**/api/files", ...)` for mocking
- Use `process.env.SKIP_E2E === "1"` skip pattern
- Use `test.describe.configure({ mode: skipE2E ? "skip" : "default" })`

**Testing:**

Tests must verify each AC listed above:
- **files-viewer.AC1.1:** Assert that `.files-browser` element exists and has `display: grid`. Assert `.tree-sidebar` and `.content-area` are both visible children. Check that sidebar has a fixed computed width around 260px.
- **files-viewer.AC1.2:** Click a directory chevron to collapse it. Assert that `.content-area` bounding box (x, y, width, height) does not change before vs after the collapse. Expand it again — bounding box still stable.
- **files-viewer.AC1.5:** Click a directory node in the tree. Assert the clicked node gains the `.node-selected` CSS class. Assert a different directory does not have `.node-selected`. Click the other directory — assert selection moves.

**Verification:**
Run: `bun run test:e2e`
Expected: New files-viewer tests pass alongside existing e2e tests.

**Commit:** `test(e2e): add files-viewer layout and directory selection tests`

<!-- END_TASK_3 -->
