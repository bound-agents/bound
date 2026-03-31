# Files Viewer Design

## Summary

This design enhances the Bound web UI's file browsing experience by replacing the current single-pane reflowing tree with a stable two-panel layout inspired by Windows Explorer. The new interface features a fixed-width tree sidebar on the left for hierarchical navigation and a flexible content area on the right containing breadcrumb navigation and a flat directory listing. When users click a file in the directory listing, a modal overlay opens to preview the file content with type-appropriate rendering: syntax highlighting for code files, formatted HTML for markdown, inline display for images, or monospace pre-formatted text for plain files.

The approach leverages existing frontend infrastructure throughout -- the current `TreeNode.svelte` component is enhanced rather than replaced, the existing shiki/marked pipeline handles code and markdown rendering, and the file API endpoints remain unchanged. This is a purely client-side redesign using Svelte 5 runes for state management, CSS Grid for the two-panel layout, and a new modal component pattern that establishes the app's first reusable dialog convention. Real-time file updates continue to work via the existing `file_update` WebSocket event.

## Definition of Done

1. **Stable file browser layout** — The files view is rebuilt as a fixed two-panel layout (tree sidebar + content area) that doesn't reflow when expanding/collapsing folders. Breadcrumbs show the current path.

2. **File preview modal** — Clicking a file opens a modal overlay that renders the file content appropriately: syntax-highlighted code, rendered markdown, inline images, or plain text. The modal has download and close buttons.

3. **No new backend work** — Leverages existing file API endpoints and existing shiki/marked libraries. This is a purely frontend change.

## Acceptance Criteria

### files-viewer.AC1: Stable file browser layout
- **files-viewer.AC1.1 Success:** Tree sidebar and content area render as a fixed two-panel grid that doesn't shift when resizing content
- **files-viewer.AC1.2 Success:** Expanding/collapsing folders in tree sidebar does not cause the content area to reflow or jump
- **files-viewer.AC1.3 Success:** Breadcrumbs display the full path to the current directory as clickable segments
- **files-viewer.AC1.4 Success:** Clicking a breadcrumb segment navigates tree, listing, and breadcrumbs to that directory
- **files-viewer.AC1.5 Success:** Clicking a directory in the tree selects it, updates content area, and visually highlights the node
- **files-viewer.AC1.6 Success:** Clicking a folder in the directory listing navigates into it, syncing tree, breadcrumbs, and listing
- **files-viewer.AC1.7 Edge:** Empty directory shows an appropriate empty state message in the content area

### files-viewer.AC2: File preview modal
- **files-viewer.AC2.1 Success:** Clicking a file in the directory listing opens a modal overlay
- **files-viewer.AC2.2 Success:** Code files (`.ts`, `.js`, `.py`, etc.) render with shiki syntax highlighting
- **files-viewer.AC2.3 Success:** Markdown files render as formatted HTML via the existing `renderMarkdown()` pipeline
- **files-viewer.AC2.4 Success:** Image files display inline, scaled to fit the modal without exceeding natural size
- **files-viewer.AC2.5 Success:** Plain text files display in a monospace pre-formatted block
- **files-viewer.AC2.6 Success:** Modal header shows filename and a working download button
- **files-viewer.AC2.7 Success:** Modal closes via close button, Escape key, or backdrop click
- **files-viewer.AC2.8 Failure:** Binary non-image files show "preview not available" message with download button
- **files-viewer.AC2.9 Failure:** Failed content fetch shows error state with retry button
- **files-viewer.AC2.10 Edge:** Empty file (zero bytes) shows "This file is empty" message
- **files-viewer.AC2.11 Edge:** Modal is accessible: focus trap, `role="dialog"`, `aria-modal`, keyboard navigation

### files-viewer.AC3: Frontend-only constraint
- **files-viewer.AC3.1:** All changes are within `packages/web/src/client/` — no server-side modifications

## Glossary

- **TreeNode.svelte**: Existing recursive Svelte component that renders a hierarchical file tree with expand/collapse and file icons via lucide-svelte. Enhanced with directory selection in this design.
- **CSS Grid**: Two-dimensional layout system used here to create a fixed-width sidebar and flexible content area via `grid-template-columns: 260px 1fr`.
- **Svelte 5 runes**: Modern reactivity primitives in Svelte 5, including `$state` for reactive variables and `$derived` for computed values that automatically update when dependencies change.
- **Shiki**: Syntax highlighting library using TextMate grammars and VS Code themes (Tokyo Night here). The app uses a cached instance configured with 10+ languages.
- **Marked**: Markdown parser library used in the existing `renderMarkdown()` pipeline. Combined with DOMPurify for XSS sanitization.
- **Blob URL**: Temporary URL (`blob:...`) created via `URL.createObjectURL()` referencing binary data in browser memory. Used for displaying images; must be revoked to prevent memory leaks.
- **Focus trap**: Accessibility pattern restricting keyboard tab navigation to remain within a modal dialog.
- **Tokyo Metro aesthetic**: Design language used throughout the Bound web UI, characterized by subway-line colors and clean typography. Existing CSS variable palette used exclusively.
- **WebSocket subscription**: Real-time update mechanism where the client subscribes to server events (like `file_update`) via persistent WebSocket connection at `/ws`.
- **ARIA attributes**: Accessibility metadata (`role="dialog"`, `aria-modal="true"`) helping screen readers understand interface element purpose and behavior.
- **VFS (Virtual File System)**: Bound's sandboxed filesystem where the agent reads and writes files. The `files` table persists VFS state across restarts.
- **DOMPurify**: Security library that sanitizes HTML to prevent XSS attacks, used in the markdown rendering pipeline.

## Architecture

Two-panel CSS Grid layout inspired by Windows Explorer. Fixed-width tree sidebar on the left, flexible content area on the right.

**Tree sidebar** (`TreeNode.svelte`, enhanced): Persistent hierarchical file tree with expand/collapse. Clicking a directory selects it, syncing the content area and breadcrumbs. Gains a "selected" visual state for the active directory.

**Content area** (top to bottom):
- **Breadcrumbs** (`Breadcrumbs.svelte`, new): Clickable path segments from root to current directory. Clicking a segment navigates the tree and listing to that folder.
- **Directory listing** (`DirectoryListing.svelte`, new): Flat table of the selected directory's contents. Columns: icon, name, size (human-readable), modified (relative time). Subdirectories first, then files, both sorted alphabetically. Clicking a folder navigates into it; clicking a file opens the preview modal.

**File preview modal** (`FilePreviewModal.svelte`, new): First modal component in the app. Fixed-position backdrop overlay with centered content panel. Header: filename, download button, close button. Body renders content based on file type:

| Category | Extensions | Rendering |
|----------|-----------|-----------|
| Code | `.ts`, `.js`, `.py`, `.sql`, `.bash`, `.json`, `.yaml`, `.html`, `.css` | Shiki syntax highlighting (Tokyo Night theme) |
| Markdown | `.md` | `renderMarkdown()` from existing `lib/markdown.ts` |
| Image | `.png`, `.jpg`, `.gif`, `.svg`, `.webp` | `<img>` with `object-fit: contain`, base64 decoded to blob URL |
| Plain text | `.txt`, `.log`, `.env`, `.csv`, other text | `<pre>` with IBM Plex Mono |
| Binary fallback | Any `is_binary = 1` non-image | Metadata + download button, no preview |

**State management**: All state lives in `FilesView.svelte` using Svelte 5 runes. `$state` for `files`, `selectedPath`, `selectedFile`, `expandedPaths`. `$derived` for `fileTree`, `currentDirectoryContents`, `breadcrumbSegments`. No external stores needed.

**Data flow**: Content area reacts to `selectedPath` changes (from tree clicks, directory listing clicks, or breadcrumb clicks). Modal opens when `selectedFile` is set, fetches full content via `GET /api/files/*`, renders by type, and revokes blob URLs on close.

**Real-time updates**: Existing `file_update` WebSocket event already triggers a full file list reload. If the modal is open when a reload occurs, the previewed file's `modified_at` is compared to detect changes and re-fetch content.

## Existing Patterns

Investigation found the following patterns already in use that this design follows:

- **TreeNode.svelte** (`packages/web/src/client/components/TreeNode.svelte`): Recursive tree component with expand/collapse, file icons via lucide-svelte, keyboard support. This design enhances it with a selected directory state rather than replacing it.
- **file-tree.ts** (`packages/web/src/client/lib/file-tree.ts`): `buildFileTree()` and `sortTree()` for hierarchical tree construction from flat file array. Reused directly for tree sidebar; `sortTree()` logic reused for directory listing sort order.
- **renderMarkdown()** (`packages/web/src/client/lib/markdown.ts`): Shiki singleton + marked pipeline with DOMPurify sanitization. Reused as-is for markdown file preview.
- **Shiki highlighter** (`packages/web/src/client/lib/markdown.ts`): Cached `createHighlighter()` promise with Tokyo Night theme and 10+ languages. Reused for code file preview.
- **WebSocket subscription** (`FilesView.svelte`): `wsEvents.subscribe()` pattern for real-time file updates. Preserved as-is.
- **CSS variable theming** (`App.svelte`): Tokyo Metro color palette, semantic colors, font families. Modal and new components use existing variables exclusively.
- **Scroll containment**: `min-height: 0` + `overflow-y: auto` pattern used throughout the app for independent scrollable regions.

**New pattern introduced**: Modal/dialog component. No existing modal pattern exists in the codebase. `FilePreviewModal.svelte` establishes the convention: `position: fixed; inset: 0` backdrop, `z-index: 100`, focus trap, `role="dialog"` + `aria-modal="true"`, Escape/backdrop-click to close.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Layout Restructure
**Goal:** Transform FilesView from a single-pane reflowing tree into a stable two-panel CSS Grid layout with directory selection.

**Components:**
- `FilesView.svelte` (`packages/web/src/client/views/FilesView.svelte`) -- restructure to CSS Grid with `grid-template-columns: 260px 1fr`, add `selectedPath` state, wire tree selection to content area
- `TreeNode.svelte` (`packages/web/src/client/components/TreeNode.svelte`) -- add `selectedPath` prop and visual selected state, emit directory selection events alongside expand/collapse

**Dependencies:** None (first phase)

**Covers:** files-viewer.AC1.1, files-viewer.AC1.2, files-viewer.AC1.5

**Done when:** Files view renders as two stable panels. Tree sidebar scrolls independently. Expanding/collapsing folders does not reflow the content area. Clicking a directory in the tree updates `selectedPath` and highlights the selected node.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Breadcrumbs and Directory Listing
**Goal:** Add breadcrumb navigation and a flat directory listing in the content area, completing the Explorer-style browsing experience.

**Components:**
- `Breadcrumbs.svelte` (`packages/web/src/client/components/Breadcrumbs.svelte`) -- new component rendering clickable path segments derived from `selectedPath`
- `DirectoryListing.svelte` (`packages/web/src/client/components/DirectoryListing.svelte`) -- new component rendering current directory contents as a flat table with icon, name, size, modified columns
- `FilesView.svelte` -- add `$derived` computations for `currentDirectoryContents` and `breadcrumbSegments`, integrate new components into Grid layout
- `file-tree.ts` (`packages/web/src/client/lib/file-tree.ts`) -- add helper to find a node by path for directory content extraction

**Dependencies:** Phase 1 (two-panel layout with `selectedPath`)

**Covers:** files-viewer.AC1.3, files-viewer.AC1.4, files-viewer.AC1.6, files-viewer.AC1.7

**Done when:** Breadcrumbs show current path with clickable segments. Directory listing shows files and subdirectories for the selected path. Clicking a breadcrumb, tree node, or directory listing folder all stay in sync. Empty directories show appropriate empty state.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: File Preview Modal
**Goal:** Add a modal overlay that previews file content with type-appropriate rendering, download, and close functionality.

**Components:**
- `FilePreviewModal.svelte` (`packages/web/src/client/components/FilePreviewModal.svelte`) -- new modal component with backdrop, focus trap, type-based content rendering (shiki for code, renderMarkdown for .md, img for images, pre for text, fallback for binary), download button, close button
- `DirectoryListing.svelte` -- wire file row clicks to open modal by setting `selectedFile`
- `FilesView.svelte` -- add `selectedFile` state, conditionally render modal, handle close/download actions
- `file-tree.ts` or new utility -- file type detection helper mapping extensions to render categories

**Dependencies:** Phase 2 (directory listing provides file click targets)

**Covers:** files-viewer.AC2.1 through files-viewer.AC2.11, files-viewer.AC3.1

**Done when:** Clicking a file opens a modal with correctly rendered content. Code files show syntax highlighting, markdown renders as HTML, images display inline, plain text shows in monospace. Modal closes via button, Escape, or backdrop click. Download button works. Binary files show fallback. Error and empty states handled gracefully. Focus is trapped within the modal. All changes are client-side only.
<!-- END_PHASE_3 -->

## Additional Considerations

**Blob URL lifecycle:** Image previews create blob URLs via `URL.createObjectURL()`. These must be revoked on modal close and on component destroy to prevent memory leaks.

**Shiki language detection:** File extension maps to shiki language identifier. For extensions not in shiki's loaded set, fall back to plaintext highlighting. The existing shiki instance loads 10 languages; additional languages can be added to the highlighter config if needed.

**Large file handling:** Agent VFS files are typically small (generated code, configs, notes). No client-side truncation is needed initially. If large files become common, a size threshold with "file too large to preview" fallback can be added without architectural changes.
