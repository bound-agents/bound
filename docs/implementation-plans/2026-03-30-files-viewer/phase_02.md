# Files Viewer Implementation Plan — Phase 2

**Goal:** Add breadcrumb navigation and a flat directory listing in the content area, completing the Explorer-style browsing experience.

**Architecture:** New Breadcrumbs.svelte and DirectoryListing.svelte components integrated into FilesView's content area. $derived computations in FilesView derive current directory contents and breadcrumb segments from selectedPath. A new findNodeByPath helper in file-tree.ts enables efficient tree traversal.

**Tech Stack:** Svelte 5 (runes: $state, $derived, $props), lucide-svelte, CSS flexbox

**Scope:** 3 phases from original design (phases 1-3). This is phase 2.

**Codebase verified:** 2026-03-30

---

## Acceptance Criteria Coverage

This phase implements and tests:

### files-viewer.AC1: Stable file browser layout
- **files-viewer.AC1.3 Success:** Breadcrumbs display the full path to the current directory as clickable segments
- **files-viewer.AC1.4 Success:** Clicking a breadcrumb segment navigates tree, listing, and breadcrumbs to that directory
- **files-viewer.AC1.6 Success:** Clicking a folder in the directory listing navigates into it, syncing tree, breadcrumbs, and listing
- **files-viewer.AC1.7 Edge:** Empty directory shows an appropriate empty state message in the content area

---

## Codebase Verification Findings

- **file-tree.ts** (`packages/web/src/client/lib/file-tree.ts`, 71 lines): Exports `buildFileTree()`, `FileMetadata`, `FileTreeNode`. Internal `sortTree()` not exported. `findNodeByPath()` does NOT exist yet — must be created.
- **file-tree.test.ts** (`packages/web/src/client/lib/__tests__/file-tree.test.ts`, 192 lines): Tests for `buildFileTree()` using bun:test. FileMetadata test fixtures include all fields: `id`, `path`, `is_binary`, `size_bytes`, `created_at`, `modified_at`, `deleted`, `created_by`, `host_origin`.
- **AgentFile type** (`packages/shared/src/types.ts:118-129`): `FileMetadata = Omit<AgentFile, "content">`. Key fields: `modified_at` (ISO 8601 string), `size_bytes` (number), `is_binary` (0|1).
- **Relative time formatting**: No shared utility exists. Duplicated `relativeTime()` pattern in 4 views (NetworkStatus, AdvisoryView, SystemMap, Timetable). Pattern: `Date.now() - new Date(iso).getTime()` → mins/hours/days ago.
- **List/table patterns**: Codebase uses flexbox rows, not HTML tables. TreeNode.svelte's `.node-row` with `.node-meta` (size + button) is the standard pattern.
- **Lucide icons available**: `File`, `FileArchive`, `FileCode`, `FileImage`, `FileText`, `ChevronDown`, `ChevronRight`, `Download`, `Folder`, `FolderOpen` already imported. `ChevronRight` can be reused for breadcrumb separators.
- **FilesView.svelte** (from Phase 1): Has `selectedPath` state, `selectDirectory()` handler, `expandedPaths` SvelteSet, `formatFileSize()`, `getFileIcon()`. The Phase 1 content area has `content-placeholder` div to be replaced.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add findNodeByPath helper to file-tree.ts

**Verifies:** None (infrastructure helper for $derived computations)

**Files:**
- Modify: `packages/web/src/client/lib/file-tree.ts`

**Implementation:**

Add an exported function that walks the tree to find a node by its `fullPath`. This is needed by FilesView's `$derived` computations to extract the children of the selected directory.

Add after the `buildFileTree` function (before the internal `sortTree` function):

```typescript
export function findNodeByPath(
	nodes: FileTreeNode[],
	path: string,
): FileTreeNode | null {
	for (const node of nodes) {
		if (node.fullPath === path) return node;
		if (path.startsWith(node.fullPath + "/")) {
			const found = findNodeByPath(node.children, path);
			if (found) return found;
		}
	}
	return null;
}
```

Key behavior:
- Returns `null` if path is not found or if path is `"/"` (root has no node — root contents are the top-level `nodes` array itself)
- Uses prefix matching (`path.startsWith(node.fullPath + "/")`) to prune search branches
- Recursively descends only into matching branches for efficiency

**Verification:**
Run: `bun test packages/web/src/client/lib/__tests__/file-tree.test.ts`
Expected: Existing tests still pass.

**Commit:** `feat(web): add findNodeByPath helper to file-tree`

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Unit tests for findNodeByPath

**Verifies:** None (tests for infrastructure helper)

**Files:**
- Modify: `packages/web/src/client/lib/__tests__/file-tree.test.ts`

**Implementation:**

Add a new `describe("findNodeByPath", ...)` block after the existing `describe("buildFileTree", ...)` block. Import `findNodeByPath` from `../file-tree`.

Tests to write (follow existing fixture pattern with full FileMetadata objects):

1. **"returns null for empty tree"** — `findNodeByPath([], "anything")` returns `null`
2. **"returns null for non-existent path"** — Build a tree with `dir/file.txt`, search for `"nonexistent"` → `null`
3. **"finds a top-level directory"** — Build a tree with `dir/file.txt`, search for `"dir"` → returns the dir node
4. **"finds a nested directory"** — Build a tree with `a/b/file.txt`, search for `"a/b"` → returns the `b` node
5. **"finds a file node"** — Build a tree with `dir/file.txt`, search for `"dir/file.txt"` → returns the file node with `type: "file"`
6. **"returns null for partial path match"** — Build a tree with `src/index.ts`, search for `"sr"` → `null` (partial prefix, not a real node)

Use `buildFileTree()` to construct test trees (same as existing tests), then pass result to `findNodeByPath()`.

**Verification:**
Run: `bun test packages/web/src/client/lib/__tests__/file-tree.test.ts`
Expected: All existing + new tests pass.

**Commit:** `test(web): add findNodeByPath unit tests`

<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Create Breadcrumbs.svelte component

**Verifies:** files-viewer.AC1.3, files-viewer.AC1.4

**Files:**
- Create: `packages/web/src/client/components/Breadcrumbs.svelte`

**Implementation:**

A new Svelte 5 component that renders clickable path segments from the current selectedPath.

**Props interface:**
```typescript
interface Props {
	segments: Array<{ name: string; path: string }>;
	onNavigate: (path: string) => void;
}
```

The `segments` array is computed by FilesView (Task 5) and passed in. Each segment has a display `name` and a `path` to navigate to when clicked. Example for `selectedPath = "home/user/src"`:
```
[
	{ name: "/", path: "/" },
	{ name: "home", path: "home" },
	{ name: "user", path: "home/user" },
	{ name: "src", path: "home/user/src" },
]
```

**Template structure:**
```svelte
<nav class="breadcrumbs" aria-label="File path">
	{#each segments as segment, i}
		{#if i > 0}
			<span class="separator">/</span>
		{/if}
		{#if i === segments.length - 1}
			<span class="current">{segment.name}</span>
		{:else}
			<button class="segment" onclick={() => onNavigate(segment.path)}>
				{segment.name}
			</button>
		{/if}
	{/each}
</nav>
```

Key decisions:
- Last segment is non-clickable `<span>` (you're already there)
- Previous segments are `<button>` elements (keyboard accessible by default)
- Use `/` character as separator (not ChevronRight icon — keeps it minimal and matches file path convention)
- `aria-label="File path"` for accessibility

**CSS:**
```css
.breadcrumbs {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 12px 20px;
	border-bottom: 1px solid rgba(0, 155, 191, 0.1);
	font-family: var(--font-mono);
	font-size: var(--text-sm);
	min-height: 44px;
}

.segment {
	background: none;
	border: none;
	color: var(--line-3);
	font-family: inherit;
	font-size: inherit;
	cursor: pointer;
	padding: 2px 4px;
	border-radius: 3px;
	transition: background 0.15s ease;
}

.segment:hover {
	background: rgba(0, 155, 191, 0.1);
}

.segment:focus {
	outline: 2px solid var(--line-3);
	outline-offset: 1px;
}

.separator {
	color: var(--text-muted);
	user-select: none;
}

.current {
	color: var(--text-primary);
	font-weight: 600;
	padding: 2px 4px;
}
```

**Testing:**

AC1.3 and AC1.4 are tested in Task 6 (e2e test) — breadcrumb rendering and click navigation are interaction behaviors best verified through Playwright.

**Verification:**
Run: `bun test packages/web`
Expected: No regressions (component import test passes if one exists, or no test file needed for new component).

**Commit:** `feat(web): create Breadcrumbs component`

<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Create DirectoryListing.svelte component

**Verifies:** files-viewer.AC1.6, files-viewer.AC1.7

**Files:**
- Create: `packages/web/src/client/components/DirectoryListing.svelte`

**Implementation:**

A new Svelte 5 component that renders a flat list of the selected directory's contents with icon, name, size, and modified columns.

**Props interface:**
```typescript
interface Props {
	items: FileTreeNode[];
	formatFileSize: (bytes: number) => string;
	getFileIcon: (name: string) => Component;
	relativeTime: (iso: string | null) => string;
	onSelectDirectory: (path: string) => void;
	onSelectFile: (file: FileMetadata) => void;
}
```

The `items` array contains the direct children of the currently selected directory (dirs first, then files, alphabetically sorted — already handled by `sortTree()` inside `buildFileTree()`).

The `relativeTime` function is passed as a prop from FilesView (following the pattern of `formatFileSize` and `getFileIcon`), keeping DirectoryListing a pure presentation component. The function is defined in FilesView's script section (Task 5).

**Template structure:**

```svelte
{#if items.length === 0}
	<div class="empty-directory">
		<p>This directory is empty</p>
	</div>
{:else}
	<div class="listing-header">
		<span class="col-name">Name</span>
		<span class="col-size">Size</span>
		<span class="col-modified">Modified</span>
	</div>
	<div class="listing-body">
		{#each items as item}
			<div
				class="listing-row"
				class:listing-dir={item.type === "dir"}
				class:listing-file={item.type === "file"}
				onclick={() => {
					if (item.type === "dir") {
						onSelectDirectory(item.fullPath);
					} else if (item.file) {
						onSelectFile(item.file);
					}
				}}
				role="button"
				tabindex={0}
				onkeydown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						if (item.type === "dir") {
							onSelectDirectory(item.fullPath);
						} else if (item.file) {
							onSelectFile(item.file);
						}
					}
				}}
			>
				<div class="col-name">
					<div class="item-icon">
						{#if item.type === "dir"}
							<Folder size={16} />
						{:else}
							{@const Icon = getFileIcon(item.name)}
							<Icon size={16} />
						{/if}
					</div>
					<span class="item-name">{item.name}</span>
				</div>
				<span class="col-size">
					{item.file ? formatFileSize(item.file.size_bytes) : "—"}
				</span>
				<span class="col-modified">
					{item.file ? relativeTime(item.file.modified_at) : "—"}
				</span>
			</div>
		{/each}
	</div>
{/if}
```

Import `Folder` from `lucide-svelte` and `FileTreeNode`, `FileMetadata` types from `../lib/file-tree`.

Note: `onSelectFile` is a prop for Phase 3 integration (file preview modal). In Phase 2, FilesView will pass a no-op function. This keeps the component interface stable across phases.

**CSS:**
```css
.listing-header {
	display: grid;
	grid-template-columns: 1fr 100px 100px;
	padding: 8px 20px;
	border-bottom: 1px solid rgba(0, 155, 191, 0.1);
	color: var(--text-muted);
	font-family: var(--font-display);
	font-size: var(--text-xs);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	user-select: none;
}

.listing-body {
	display: flex;
	flex-direction: column;
}

.listing-row {
	display: grid;
	grid-template-columns: 1fr 100px 100px;
	padding: 10px 20px;
	align-items: center;
	cursor: pointer;
	transition: background 0.15s ease;
	border-bottom: 1px solid rgba(0, 155, 191, 0.05);
}

.listing-row:hover {
	background: rgba(15, 52, 96, 0.3);
}

.listing-row:focus {
	outline: 2px solid var(--line-3);
	outline-offset: -2px;
}

.listing-dir {
	font-weight: 600;
	color: var(--text-primary);
}

.listing-file {
	color: var(--text-secondary);
}

.col-name {
	display: flex;
	align-items: center;
	gap: 10px;
	min-width: 0;
}

.item-icon {
	display: flex;
	align-items: center;
	flex-shrink: 0;
	color: var(--text-secondary);
}

.listing-dir .item-icon {
	color: var(--line-5);
}

.item-name {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-family: var(--font-display);
	font-size: var(--text-sm);
}

.col-size,
.col-modified {
	font-family: var(--font-mono);
	font-size: var(--text-xs);
	color: var(--text-muted);
	text-align: right;
}

.empty-directory {
	display: flex;
	align-items: center;
	justify-content: center;
	flex: 1;
	padding: 48px 20px;
}

.empty-directory p {
	color: var(--text-muted);
	font-size: var(--text-sm);
	font-family: var(--font-display);
	margin: 0;
}
```

Key CSS decisions:
- Listing rows use CSS Grid (`grid-template-columns: 1fr 100px 100px`) for aligned columns
- Header and rows share the same grid template for column alignment
- Directory icons use `--line-5` (gold/Yurakucho) to visually distinguish from files
- Empty state message for AC1.7

**Testing:**

AC1.6 and AC1.7 are tested in Task 6 (e2e test). AC1.6 tests folder click navigation; AC1.7 tests empty directory state.

**Verification:**
Run: `bun test packages/web`
Expected: No regressions.

**Commit:** `feat(web): create DirectoryListing component`

<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_5 -->
### Task 5: Integrate breadcrumbs and directory listing into FilesView.svelte

**Verifies:** files-viewer.AC1.3, files-viewer.AC1.4, files-viewer.AC1.6, files-viewer.AC1.7

**Files:**
- Modify: `packages/web/src/client/views/FilesView.svelte`

**Implementation:**

Wire the new Breadcrumbs and DirectoryListing components into the content area, replacing the Phase 1 placeholder. Add $derived computations for breadcrumb segments and current directory contents.

**Script changes:**

1. Add imports (at top of script):
   ```typescript
   import Breadcrumbs from "../components/Breadcrumbs.svelte";
   import DirectoryListing from "../components/DirectoryListing.svelte";
   import { findNodeByPath } from "../lib/file-tree";
   ```

2. Add `relativeTime` helper function (after `getFileIcon` function):
   ```typescript
   function relativeTime(iso: string | null): string {
   	if (!iso) return "—";
   	const diff = Date.now() - new Date(iso).getTime();
   	const mins = Math.floor(diff / 60_000);
   	if (mins < 1) return "just now";
   	if (mins < 60) return `${mins}m ago`;
   	const hours = Math.floor(mins / 60);
   	if (hours < 24) return `${hours}h ago`;
   	const days = Math.floor(hours / 24);
   	return `${days}d ago`;
   }
   ```

3. Add `$derived` computations (after the `selectedPath` state declaration):
   ```typescript
   const breadcrumbSegments = $derived.by(() => {
   	const segments: Array<{ name: string; path: string }> = [
   		{ name: "/", path: "/" },
   	];
   	if (selectedPath === "/") return segments;
   	const parts = selectedPath.split("/");
   	for (let i = 0; i < parts.length; i++) {
   		segments.push({
   			name: parts[i],
   			path: parts.slice(0, i + 1).join("/"),
   		});
   	}
   	return segments;
   });

   const currentDirectoryContents = $derived.by(() => {
   	if (selectedPath === "/") return tree;
   	const node = findNodeByPath(tree, selectedPath);
   	return node ? node.children : [];
   });
   ```

4. Add `navigateToDirectory` function that handles both tree and listing navigation (after `selectDirectory`):
   ```typescript
   function navigateToDirectory(path: string): void {
   	selectedPath = path;
   	// Ensure all ancestors are expanded in the tree sidebar
   	if (path !== "/") {
   		const parts = path.split("/");
   		for (let i = 1; i <= parts.length; i++) {
   			expandedPaths.add(parts.slice(0, i).join("/"));
   		}
   	}
   }
   ```

5. Update `selectDirectory` to also call the expansion logic:
   ```typescript
   function selectDirectory(path: string): void {
   	navigateToDirectory(path);
   }
   ```

   This means tree clicks, breadcrumb clicks, and directory listing clicks all go through the same navigation logic.

**Template changes:**

Replace the `<main class="content-area">` section inside the `.files-browser` div (the Phase 1 placeholder) with:

```svelte
<main class="content-area">
	<Breadcrumbs
		segments={breadcrumbSegments}
		onNavigate={navigateToDirectory}
	/>
	<DirectoryListing
		items={currentDirectoryContents}
		{formatFileSize}
		{getFileIcon}
		{relativeTime}
		onSelectDirectory={navigateToDirectory}
		onSelectFile={() => {}}
	/>
</main>
```

Note: `onSelectFile` receives a no-op function for now. Phase 3 will replace this with the modal open handler.

**No CSS changes needed** — the content-area styling from Phase 1 (`display: flex; flex-direction: column; overflow-y: auto; min-height: 0;`) already supports the stacked Breadcrumbs + DirectoryListing layout.

Remove the `.content-placeholder` CSS class from the `<style>` section (no longer needed).

**Testing:**

All ACs for this task are tested in Task 6 (e2e test).

**Verification:**
Run: `bun test packages/web`
Expected: All tests pass.

Run: `bun run lint`
Expected: No new lint errors.

**Commit:** `feat(web): integrate breadcrumbs and directory listing into FilesView`

<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: E2e tests for breadcrumbs and directory listing

**Verifies:** files-viewer.AC1.3, files-viewer.AC1.4, files-viewer.AC1.6, files-viewer.AC1.7

**Files:**
- Modify: `e2e/files-viewer.spec.ts` (created in Phase 1, Task 3)

**Implementation:**

Add new test cases to the existing files-viewer e2e spec. Use the same route-mocked `/api/files` test data from Phase 1.

Tests to add (new `describe` block within the files-viewer spec):

1. **"displays breadcrumbs for current path" (AC1.3):** Navigate to `#/files`. Wait for tree to load. Click a directory in the tree (e.g., "home"). Assert breadcrumbs contain `["/", "home"]`. Click into "user" → breadcrumbs show `["/", "home", "user"]`.

2. **"breadcrumb click navigates to directory" (AC1.4):** Navigate deep into a directory via tree clicks. Click the root breadcrumb `/`. Assert directory listing shows top-level contents. Assert breadcrumbs reset to just `["/"]`.

3. **"folder click in directory listing navigates into it" (AC1.6):** Click a directory in the directory listing (not the tree). Assert breadcrumbs, tree selection, and listing all update to show that directory's contents.

4. **"empty directory shows empty state" (AC1.7):** The VFS model infers directories from file paths, so truly empty directories cannot appear through normal operation. AC1.7 is covered by two complementary verifications:
   - **Unit test (add to `file-tree.test.ts`):** Test that `findNodeByPath` returning `null` for a non-existent path causes `currentDirectoryContents` to be `[]`. This exercises the empty-state rendering path in DirectoryListing.
   - **E2e test:** Mock `/api/files` to return an empty array (`[]`). Navigate to `#/files`. Assert the existing "No files yet" empty state renders (this is the FilesView-level empty state, not the DirectoryListing empty state). Then, to verify the DirectoryListing empty state: use `page.evaluate()` to programmatically set `selectedPath` to a path that doesn't exist in the tree (e.g., `"nonexistent"`), OR accept that this edge case is adequately covered by the unit test and the component implementation (`{#if items.length === 0}` guard in DirectoryListing).

Follow existing e2e patterns: `page.route()` for mocking, selectors for DOM assertions.

**Verification:**
Run: `bun run test:e2e`
Expected: All files-viewer tests pass.

**Commit:** `test(e2e): add breadcrumbs and directory listing tests`

<!-- END_TASK_6 -->
