# Files Viewer — Human Test Plan

**Feature:** Files viewer redesign (two-panel layout, breadcrumbs, directory listing, file preview modal)
**Implementation plan:** `docs/implementation-plans/2026-03-30-files-viewer/`
**Automated coverage:** 18/18 acceptance criteria covered by unit + e2e tests

## Prerequisites

- Bound server running locally with test data: `bun packages/cli/src/bound.ts start`
- At least several files in the VFS (created by the agent or manually inserted) including:
  - TypeScript files (e.g., in `home/user/src/`)
  - A markdown file (e.g., `home/user/docs/readme.md`)
  - A plain text file (e.g., `home/user/notes.txt`)
  - An image file (e.g., `home/user/icon.png`)
  - A binary file (e.g., `home/user/data.bin`)
  - An empty file (0 bytes)
  - At least 3 levels of nested directories
- Automated tests passing: `bun run test:e2e` (Playwright)
- Modern browser (Chrome or Firefox recommended)

## Phase 1: Layout Stability

| Step | Action | Expected |
|------|--------|----------|
| 1 | Navigate to `http://localhost:3000/#/files` | Two-panel layout loads: tree sidebar on left (~260px wide), content area filling remaining space on right |
| 2 | Resize the browser window from 1200px to 800px wide | Tree sidebar maintains its fixed width. Content area shrinks but does not overlap or push the sidebar. No horizontal scrollbar on the main layout |
| 3 | Expand a deeply nested folder in the tree sidebar (click chevrons through 3+ levels) | Content area does not shift, jump, or reflow. The sidebar may show a scrollbar if the tree overflows, but the sidebar width stays constant |
| 4 | Collapse the same folder back to the top level | Content area bounding box returns to exactly the same position. No visible flicker or reflow |
| 5 | Click a directory node (e.g., "src") in the tree sidebar | The node receives a visual highlight (colored background). The content area updates to show that directory's children. No other node is highlighted |
| 6 | Click a different directory node (e.g., "docs") | Highlight moves exclusively to the new node. Previous node loses highlight. Content area updates to show new directory's children |

## Phase 2: Breadcrumbs and Directory Listing Navigation

| Step | Action | Expected |
|------|--------|----------|
| 1 | Navigate to `http://localhost:3000/#/files` (fresh load) | Breadcrumbs show a single "/" segment. Directory listing shows top-level contents |
| 2 | Click "home" directory in the tree sidebar | Breadcrumbs update to show `/ > home`. The "/" is a clickable button. "home" is a non-clickable span (current location) |
| 3 | Click "user" directory in the tree sidebar | Breadcrumbs update to `/ > home > user`. "/" and "home" are clickable buttons. "user" is a non-clickable span |
| 4 | Click into "src" directory in the tree sidebar | Breadcrumbs show `/ > home > user > src`. All segments except "src" are clickable |
| 5 | Click the "home" breadcrumb segment | Tree, breadcrumbs, and listing all navigate to the "home" directory. Breadcrumbs reset to `/ > home`. Listing shows contents of `home/` |
| 6 | Click the "/" root breadcrumb segment | Everything resets to root. Breadcrumbs show only "/". Listing shows top-level directories |
| 7 | In the directory listing, click a folder row (has folder icon) | Navigates into that folder. Breadcrumbs update. Tree sidebar expands and highlights the corresponding node. Listing shows the folder's children |
| 8 | Verify breadcrumb nav element has `aria-label="File path"` | Inspect element or use screen reader to confirm the `<nav>` has the ARIA label |
| 9 | Mock or create a scenario with no files (empty database) | Navigate to `#/files`. The view shows "No files yet" empty state message instead of the tree/listing layout |

## Phase 3: File Preview Modal

| Step | Action | Expected |
|------|--------|----------|
| 1 | Navigate to a directory containing a `.ts` file and click the file row | Modal overlay appears with backdrop. Modal panel has `role="dialog"` and `aria-modal="true"`. Header shows the filename (e.g., "app.ts"). Code is rendered with syntax highlighting (colored tokens, not plain monospace) |
| 2 | Close the modal by clicking the X button in the top-right | Modal disappears. Focus returns to the file row that was clicked |
| 3 | Re-open the same file. Press the `Escape` key | Modal closes. Focus returns to the trigger element |
| 4 | Re-open the modal. Click the darkened backdrop area (outside the white modal panel) | Modal closes. Verify that clicking INSIDE the panel does NOT close it |
| 5 | Open a `.md` markdown file | Modal shows formatted HTML: headings as `<h1>`, bold text as `<strong>`, lists as `<ul>/<ol>`. Not raw markdown text |
| 6 | Open a `.png` image file | Modal shows the image inline inside a `.preview-image` container. Image is scaled to fit (does not exceed container width). The `<img>` element has an `alt` attribute matching the filename |
| 7 | Open a `.svg` file (stored as text, `is_binary: 0`) | Modal renders the SVG as an image (via blob URL), not as raw XML text. Image preview container is used |
| 8 | Open a `.txt` plain text file | Modal shows content in a monospace `<pre>` block with `.preview-text` class. Content matches the raw file exactly |
| 9 | Open a binary non-image file (e.g., `.bin`, `.zip`) | Modal shows "Preview not available for this file type" message in `.preview-binary` container. A large "Download file" button is visible |
| 10 | Open an empty file (0 bytes) | Modal shows "This file is empty" in `.modal-empty` container. No preview content containers are present |
| 11 | Click the "Download" button in the modal header for any file | Browser initiates a download for the file. Verify the download request targets `/api/files/download/:id` |
| 12 | Simulate a network error (disable network or use DevTools to block `/api/files/*` requests), then click a file | Modal shows error state (`.modal-error`) with error message text and a "Retry" button |
| 13 | Re-enable network, then click the "Retry" button | Error state disappears. The correct preview renders for the file type |

## Phase 4: Accessibility Deep-Dive

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open any file modal. Inspect the `.modal-panel` element | Has `role="dialog"`, `aria-modal="true"`, `aria-label="File preview: <filename>"` |
| 2 | Inspect the close button (`.close-btn`) | Has `aria-label="Close preview"` |
| 3 | With the modal open, press `Tab` repeatedly (10+ times) | Focus cycles through focusable elements within the modal. Focus NEVER leaves the modal panel. After the last focusable element, Tab wraps to the first |
| 4 | Press `Shift+Tab` from the first focusable element | Focus wraps to the last focusable element within the modal (reverse cycle) |
| 5 | Close the modal via Escape | Focus returns to the file row (`.listing-row`) that originally triggered the modal open |
| 6 | Use a screen reader (VoiceOver on macOS: Cmd+F5) to navigate the modal | Screen reader announces "dialog", reads the filename from aria-label, identifies the close button by its label |

## End-to-End: Full Navigation Flow

1. Navigate to `http://localhost:3000/#/files`
2. In the directory listing, click the "home" folder row
3. Verify: breadcrumbs show `/ > home`, tree highlights "home", listing shows home's children
4. In the listing, click "user" folder
5. Verify: breadcrumbs show `/ > home > user`, tree highlights "user" (with home expanded above it)
6. In the tree sidebar, click "docs" (sibling of "user" under "home")
7. Verify: breadcrumbs show `/ > home > docs`, listing shows docs contents, tree highlights "docs"
8. Click "/" breadcrumb to go to root
9. Verify: breadcrumbs reset, listing shows top-level, no node is highlighted in tree
10. Navigate deep again: tree click home > user > src
11. Open a file in src (click `.listing-file` row)
12. Verify: modal opens with correct content
13. Close modal (Escape)
14. Verify: you're still in the src directory, breadcrumbs still show `/ > home > user > src`

## End-to-End: File Type Coverage Sweep

1. Navigate to a directory with mixed file types
2. Open a `.ts` file -- verify syntax highlighting (colored spans)
3. Close modal, open a `.md` file -- verify rendered HTML (headings, bold)
4. Close modal, open a `.png` file -- verify image display
5. Close modal, open a `.svg` file -- verify image display (not raw XML)
6. Close modal, open a `.txt` file -- verify monospace pre block
7. Close modal, open a `.bin` file -- verify binary fallback
8. Close modal, open an empty file -- verify "This file is empty"
9. Verify no console errors throughout the entire sequence

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|------------|-------|
| Visual aesthetics of syntax highlighting | Automated tests verify structure but not readability | Open several code files (.ts, .py, .json). Verify tokens have distinct, readable colors consistent with Tokyo Metro aesthetic |
| Image scaling at various sizes | Automated tests verify blob URL exists, not visual quality | Upload images of varying sizes (16x16, 4000x3000). Verify small images are NOT stretched, large images scale down to fit |
| Responsive layout at extreme viewports | Automated tests run at default viewport only | Resize to 600px and 2560px. Verify layout doesn't break or become unusable |
| Tokyo Metro visual consistency | Subjective design judgment | Review files view against existing views (threads, tasks). Verify fonts, spacing, colors, and borders match established aesthetic |
| Screen reader experience | Requires actual assistive technology | Use VoiceOver/NVDA to navigate. Verify tree is navigable, modal dialog is announced, focus trap works with screen reader |
| Cross-browser rendering | Automated tests run in Chromium only | Test in Firefox and Safari. Verify grid layout, modal, syntax highlighting, and images all render correctly |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 -- Two-panel grid stable | `e2e/files-viewer.spec.ts` "AC1.1" | Phase 1, Steps 1-2 |
| AC1.2 -- Expand/collapse no reflow | `e2e/files-viewer.spec.ts` "AC1.2" | Phase 1, Steps 3-4 |
| AC1.3 -- Breadcrumbs with segments | `e2e/files-viewer.spec.ts` "AC1.3" | Phase 2, Steps 1-4, 8 |
| AC1.4 -- Breadcrumb navigation | `e2e/files-viewer.spec.ts` "AC1.4" | Phase 2, Steps 5-6 |
| AC1.5 -- Directory click highlight | `e2e/files-viewer.spec.ts` "AC1.5" | Phase 1, Steps 5-6 |
| AC1.6 -- Listing folder navigation | `e2e/files-viewer.spec.ts` "AC1.6" | Phase 2, Step 7 |
| AC1.7 -- Empty directory state | `e2e/files-viewer.spec.ts` "AC1.7" + `file-tree.test.ts` | Phase 2, Step 9 |
| AC2.1 -- File opens modal | `e2e/files-viewer.spec.ts` "AC2.1" | Phase 3, Step 1 |
| AC2.2 -- Code syntax highlighting | `e2e/files-viewer.spec.ts` "AC2.2" + `file-categories.test.ts` | Phase 3, Step 1 |
| AC2.3 -- Markdown formatted HTML | `e2e/files-viewer.spec.ts` "AC2.3" + `file-categories.test.ts` | Phase 3, Step 5 |
| AC2.4 -- Image display inline | `e2e/files-viewer.spec.ts` "AC2.4" (PNG + SVG) | Phase 3, Steps 6-7 |
| AC2.5 -- Plain text monospace | `e2e/files-viewer.spec.ts` "AC2.5" + `file-categories.test.ts` | Phase 3, Step 8 |
| AC2.6 -- Filename and download | `e2e/files-viewer.spec.ts` "AC2.6" | Phase 3, Steps 1, 11 |
| AC2.7 -- Modal close methods | `e2e/files-viewer.spec.ts` "AC2.7" (3 tests) | Phase 3, Steps 2-4 |
| AC2.8 -- Binary fallback | `e2e/files-viewer.spec.ts` "AC2.8" + `file-categories.test.ts` | Phase 3, Step 9 |
| AC2.9 -- Error with retry | `e2e/files-viewer.spec.ts` "AC2.9" | Phase 3, Steps 12-13 |
| AC2.10 -- Empty file message | `e2e/files-viewer.spec.ts` "AC2.10" | Phase 3, Step 10 |
| AC2.11 -- Accessibility | `e2e/files-viewer.spec.ts` "AC2.1" (ARIA) + "AC2.11" (focus) | Phase 4, Steps 1-6 |
| AC3.1 -- Frontend-only changes | Structural review | `git diff --name-only main...HEAD` |
