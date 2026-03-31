# Files Viewer — Test Requirements

This document maps every acceptance criterion from the files-viewer design to specific test cases. Each AC is either automated (unit, integration, or e2e) or documented as human-verified with justification.

---

## Summary Table

| AC | Description | Type | Automated | Test Location |
|----|-------------|------|-----------|---------------|
| AC1.1 | Two-panel grid does not shift on content resize | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC1.2 | Expand/collapse does not reflow content area | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC1.3 | Breadcrumbs display full path as clickable segments | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC1.4 | Breadcrumb click navigates tree, listing, breadcrumbs | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC1.5 | Directory click selects, updates content, highlights node | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC1.6 | Folder click in listing navigates, syncs tree/breadcrumbs | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC1.7 | Empty directory shows empty state message | unit + e2e | Yes | `packages/web/src/client/lib/__tests__/file-tree.test.ts`, `e2e/files-viewer.spec.ts` |
| AC2.1 | File click opens modal overlay | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC2.2 | Code files render with shiki syntax highlighting | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC2.3 | Markdown files render as formatted HTML | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC2.4 | Image files display inline, scaled to fit | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC2.5 | Plain text files display in monospace pre block | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC2.6 | Modal header shows filename and download button | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC2.7 | Modal closes via button, Escape, backdrop click | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC2.8 | Binary non-image files show fallback with download | unit + e2e | Yes | `packages/web/src/client/lib/__tests__/file-categories.test.ts`, `e2e/files-viewer.spec.ts` |
| AC2.9 | Failed fetch shows error state with retry button | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC2.10 | Empty file shows "This file is empty" message | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC2.11 | Modal is accessible: focus trap, ARIA, keyboard nav | e2e | Yes | `e2e/files-viewer.spec.ts` |
| AC3.1 | All changes within packages/web/src/client/ | audit | Yes | `e2e/files-viewer.spec.ts` (git diff assertion) |

---

## AC1: Stable file browser layout

### files-viewer.AC1.1 — Two-panel grid does not shift on content resize

> **Success:** Tree sidebar and content area render as a fixed two-panel grid that doesn't shift when resizing content.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"renders stable two-panel grid layout"`
- **Setup:** Mock `GET /api/files` with test data containing nested directories and files. Navigate to `#/files`.
- **Assertions:**
  - `.files-browser` element exists and has computed `display: grid`.
  - `.tree-sidebar` is visible as a child of `.files-browser`.
  - `.content-area` is visible as a child of `.files-browser`.
  - `.tree-sidebar` has a computed width approximately equal to 260px (allow +/- 2px tolerance for subpixel rendering).
  - `.content-area` fills the remaining width (computed width > 400px on a standard viewport).
- **Phase:** 1 (Task 3)

---

### files-viewer.AC1.2 — Expand/collapse does not reflow content area

> **Success:** Expanding/collapsing folders in tree sidebar does not cause the content area to reflow or jump.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"expand/collapse does not reflow content area"`
- **Setup:** Mock `GET /api/files` with test data containing nested directories. Navigate to `#/files`.
- **Assertions:**
  - Capture `.content-area` bounding box (`x`, `y`, `width`, `height`) before interaction.
  - Click a directory chevron to collapse a folder in the tree sidebar.
  - Capture `.content-area` bounding box after collapse.
  - Assert all four bounding box properties are unchanged (exact equality).
  - Expand the same folder again.
  - Capture `.content-area` bounding box after re-expand.
  - Assert all four bounding box properties match the original values.
- **Phase:** 1 (Task 3)

---

### files-viewer.AC1.3 — Breadcrumbs display full path as clickable segments

> **Success:** Breadcrumbs display the full path to the current directory as clickable segments.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"displays breadcrumbs for current path"`
- **Setup:** Mock `GET /api/files` with test data. Navigate to `#/files`.
- **Assertions:**
  - At root, breadcrumbs contain a single segment displaying `"/"`.
  - Click a directory (e.g., "home") in the tree. Assert breadcrumbs show segments `["/", "home"]`.
  - Click into a subdirectory (e.g., "user"). Assert breadcrumbs show `["/", "home", "user"]`.
  - All segments except the last are rendered as `<button>` elements (clickable).
  - The last segment is rendered as a `<span>` (non-clickable, current location).
  - Breadcrumb nav has `aria-label="File path"`.
- **Phase:** 2 (Task 6)

---

### files-viewer.AC1.4 — Breadcrumb click navigates tree, listing, and breadcrumbs

> **Success:** Clicking a breadcrumb segment navigates tree, listing, and breadcrumbs to that directory.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"breadcrumb click navigates to directory"`
- **Setup:** Mock `GET /api/files` with test data containing at least 3 levels of nesting. Navigate deep into a directory via tree clicks (e.g., `home/user/src`).
- **Assertions:**
  - Click the root breadcrumb segment (`"/"`).
  - Assert breadcrumbs reset to `["/"]`.
  - Assert directory listing shows top-level contents (matching the root children).
  - Assert tree selection (`.node-selected`) is cleared or moves to root context.
  - Navigate back to `home/user/src`. Click the `"home"` breadcrumb segment.
  - Assert breadcrumbs show `["/", "home"]`.
  - Assert directory listing shows contents of `home/` directory.
- **Phase:** 2 (Task 6)

---

### files-viewer.AC1.5 — Directory click selects, updates content, highlights node

> **Success:** Clicking a directory in the tree selects it, updates content area, and visually highlights the node.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"clicking directory in tree selects and highlights it"`
- **Setup:** Mock `GET /api/files` with test data containing multiple directories. Navigate to `#/files`.
- **Assertions:**
  - Click a directory node (e.g., "src") in the tree sidebar.
  - Assert the clicked node's `.node-row` element has the `.node-selected` CSS class.
  - Assert no other `.node-row` elements have `.node-selected`.
  - Assert the content area updates (e.g., directory listing shows children of the selected directory).
  - Click a different directory node (e.g., "docs").
  - Assert the new node has `.node-selected` and the previous one does not.
- **Phase:** 1 (Task 3)

---

### files-viewer.AC1.6 — Folder click in listing navigates, syncs tree/breadcrumbs/listing

> **Success:** Clicking a folder in the directory listing navigates into it, syncing tree, breadcrumbs, and listing.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"folder click in directory listing navigates into it"`
- **Setup:** Mock `GET /api/files` with test data. Navigate to `#/files`. Select a directory that contains subdirectories.
- **Assertions:**
  - In the directory listing, click a folder row (identified by `.listing-dir` class).
  - Assert breadcrumbs update to include the clicked folder.
  - Assert directory listing now shows the clicked folder's children.
  - Assert the tree sidebar has the corresponding node highlighted (`.node-selected`).
  - Assert the tree sidebar has expanded ancestor paths (folder is visible and expanded in tree).
- **Phase:** 2 (Task 6)

---

### files-viewer.AC1.7 — Empty directory shows empty state message

> **Edge:** Empty directory shows an appropriate empty state message in the content area.

**Automated: unit + e2e**

The VFS infers directories from file paths, so truly empty directories cannot exist through normal file operations. This AC is covered by two complementary tests.

#### Unit test

- **Test file:** `packages/web/src/client/lib/__tests__/file-tree.test.ts`
- **Test name:** `"findNodeByPath returns null for non-existent path"` (already specified in Phase 2 Task 2)
- **Assertions:**
  - `findNodeByPath(tree, "nonexistent")` returns `null`.
  - When `findNodeByPath` returns `null`, `currentDirectoryContents` resolves to `[]`, which triggers the empty state rendering path in DirectoryListing (`{#if items.length === 0}`).
- **Phase:** 2 (Task 2)

#### E2e test

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"empty directory shows empty state"`
- **Setup:** Mock `GET /api/files` to return an empty array (`[]`).
- **Assertions:**
  - Navigate to `#/files`. The FilesView-level "No files yet" empty state renders.
  - Alternatively, mock a file set where a directory exists but has no direct children to exercise DirectoryListing's empty state. Assert the `.empty-directory` element is visible with text "This directory is empty".
- **Phase:** 2 (Task 6)

---

## AC2: File preview modal

### files-viewer.AC2.1 — File click opens modal overlay

> **Success:** Clicking a file in the directory listing opens a modal overlay.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"opens modal on file click"`
- **Setup:** Mock `GET /api/files` with test data including files. Mock `GET /api/files/*` to return file with content. Navigate to `#/files`, select a directory with files.
- **Assertions:**
  - Click a file row (`.listing-file`) in the directory listing.
  - Assert `.modal-backdrop` is visible.
  - Assert `.modal-panel` is visible.
  - Assert `.modal-panel` has `role="dialog"` attribute.
  - Assert `.modal-panel` has `aria-modal="true"` attribute.
- **Phase:** 3 (Task 6)

---

### files-viewer.AC2.2 — Code files render with shiki syntax highlighting

> **Success:** Code files (`.ts`, `.js`, `.py`, etc.) render with shiki syntax highlighting.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"renders code with syntax highlighting"`
- **Setup:** Mock file list and mock `GET /api/files/home/user/src/app.ts` to return a TypeScript file with content (e.g., `export function hello(): string { return "world"; }`).
- **Assertions:**
  - Click the TypeScript file in the directory listing.
  - Assert `.preview-code` container exists within the modal body.
  - Assert the container contains a `<pre>` element (shiki output wrapper).
  - Assert the container contains `<span>` elements with `style` attributes (shiki applies inline styles for syntax coloring).
  - Assert the original source text (`"hello"`, `"world"`) is present in the rendered output.
- **Phase:** 3 (Task 6)

**Supporting unit test (file category detection):**

- **Test file:** `packages/web/src/client/lib/__tests__/file-categories.test.ts`
- **Test names:** `"detects TypeScript as code"`, `"detects JavaScript as code"`, `"detects Python as code"`, `"detects JSON as code"`
- **Assertions:** `getFileCategory("index.ts", 0)` returns `"code"`, etc.
- **Phase:** 3 (Task 3)

**Supporting unit test (extension-to-language mapping):**

- **Test file:** `packages/web/src/client/lib/__tests__/file-categories.test.ts`
- **Test names:** `"maps .ts to typescript"`, `"maps .py to python"`, `"maps .sh to bash"`
- **Assertions:** `extensionToLanguage(".ts")` returns `"typescript"`, etc.
- **Phase:** 3 (Task 3)

---

### files-viewer.AC2.3 — Markdown files render as formatted HTML

> **Success:** Markdown files render as formatted HTML via the existing `renderMarkdown()` pipeline.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"renders markdown as formatted HTML"`
- **Setup:** Mock `GET /api/files/home/user/docs/readme.md` to return content `"# Hello\n\nThis is **bold** text."`.
- **Assertions:**
  - Click the markdown file in the directory listing.
  - Assert `.preview-markdown` container exists within the modal body.
  - Assert rendered output contains `<h1>` with text "Hello" (markdown heading rendered).
  - Assert rendered output contains `<strong>` with text "bold" (markdown bold rendered).
- **Phase:** 3 (Task 6)

**Supporting unit test (file category detection):**

- **Test file:** `packages/web/src/client/lib/__tests__/file-categories.test.ts`
- **Test name:** `"detects markdown"`
- **Assertions:** `getFileCategory("readme.md", 0)` returns `"markdown"`.
- **Phase:** 3 (Task 3)

---

### files-viewer.AC2.4 — Image files display inline, scaled to fit

> **Success:** Image files display inline, scaled to fit the modal without exceeding natural size.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test names:** `"displays PNG image inline"`, `"displays SVG image from raw text content"`
- **Setup (PNG):** Mock `GET /api/files/home/user/icon.png` to return a binary file (`is_binary: 1`) with base64-encoded 1x1 transparent PNG content.
- **Setup (SVG):** Mock `GET /api/files/home/user/logo.svg` to return a non-binary file (`is_binary: 0`) with raw SVG XML text content.
- **Assertions (PNG and SVG):**
  - Click the image file in the directory listing.
  - Assert `.preview-image` container exists within the modal body.
  - Assert an `<img>` element exists within the container.
  - Assert the `<img>` `src` attribute starts with `"blob:"` (blob URL created from content).
  - Assert the `<img>` has an `alt` attribute matching the filename.
- **Assertions (CSS scaling):**
  - Assert `.preview-image img` has CSS `max-width: 100%` and `object-fit: contain` (via computed style check or snapshot).
- **Phase:** 3 (Task 6)

**Supporting unit test (file category detection):**

- **Test file:** `packages/web/src/client/lib/__tests__/file-categories.test.ts`
- **Test names:** `"detects PNG as image"`, `"detects JPG as image"`, `"detects SVG as image"`
- **Assertions:** `getFileCategory("photo.png", 0)` returns `"image"`, etc.
- **Phase:** 3 (Task 3)

---

### files-viewer.AC2.5 — Plain text files display in monospace pre block

> **Success:** Plain text files display in a monospace pre-formatted block.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"displays plain text in monospace"`
- **Setup:** Mock `GET /api/files/home/user/notes.txt` to return content `"Some plain text content"`.
- **Assertions:**
  - Click the text file in the directory listing.
  - Assert `.preview-text` exists within the modal body.
  - Assert `.preview-text` is a `<pre>` element.
  - Assert the text content matches the raw file content exactly.
  - Assert `.preview-text` has `font-family` computed style containing `"IBM Plex Mono"` or the `--font-mono` variable value.
- **Phase:** 3 (Task 6)

**Supporting unit test (file category detection):**

- **Test file:** `packages/web/src/client/lib/__tests__/file-categories.test.ts`
- **Test names:** `"detects plain text"`, `"detects log as text"`, `"treats unknown non-binary as text"`
- **Assertions:** `getFileCategory("notes.txt", 0)` returns `"text"`, etc.
- **Phase:** 3 (Task 3)

---

### files-viewer.AC2.6 — Modal header shows filename and download button

> **Success:** Modal header shows filename and a working download button.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"shows filename and download button"`
- **Setup:** Open any file's modal preview.
- **Assertions:**
  - Assert `.modal-title` text content matches the file's basename (e.g., `"app.ts"` for `home/user/src/app.ts`).
  - Assert `.action-btn` (download button) exists in the modal header.
  - Assert the download button contains the text "Download".
  - Assert clicking the download button triggers navigation to `/api/files/download/:id` (verify via `page.waitForRequest()` or by intercepting the navigation).
- **Phase:** 3 (Task 6)

---

### files-viewer.AC2.7 — Modal closes via close button, Escape key, or backdrop click

> **Success:** Modal closes via close button, Escape key, or backdrop click.

**Automated: e2e (three separate test cases)**

- **Test file:** `e2e/files-viewer.spec.ts`

#### Close button

- **Test name:** `"closes via close button"`
- **Assertions:**
  - Open a file modal. Assert `.modal-backdrop` is visible.
  - Click the `.close-btn` element.
  - Assert `.modal-backdrop` is no longer visible (or does not exist in DOM).

#### Escape key

- **Test name:** `"closes via Escape key"`
- **Assertions:**
  - Open a file modal. Assert `.modal-backdrop` is visible.
  - Press `Escape` key via `page.keyboard.press("Escape")`.
  - Assert `.modal-backdrop` is no longer visible.

#### Backdrop click

- **Test name:** `"closes via backdrop click"`
- **Assertions:**
  - Open a file modal. Assert `.modal-backdrop` is visible.
  - Click the `.modal-backdrop` element directly (not the `.modal-panel` child). Use coordinate-based click at the edge of the backdrop, or use `force: true` on the backdrop selector.
  - Assert `.modal-backdrop` is no longer visible.
  - Verify that clicking inside `.modal-panel` does NOT close the modal (event does not propagate to backdrop handler because `e.target === e.currentTarget` guard).
- **Phase:** 3 (Task 6)

---

### files-viewer.AC2.8 — Binary non-image files show fallback

> **Failure:** Binary non-image files show "preview not available" message with download button.

**Automated: unit + e2e**

#### Unit test (file category detection)

- **Test file:** `packages/web/src/client/lib/__tests__/file-categories.test.ts`
- **Test names:** `"treats unknown binary as binary"`, `"treats binary non-image as binary"`
- **Assertions:**
  - `getFileCategory("data.bin", 1)` returns `"binary"`.
  - `getFileCategory("archive.zip", 1)` returns `"binary"`.
- **Phase:** 3 (Task 3)

#### E2e test

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"shows binary fallback"`
- **Setup:** Mock `GET /api/files/home/user/data.bin` to return `{ is_binary: 1, content: "AQID", ... }`.
- **Assertions:**
  - Click the binary file in the directory listing.
  - Assert `.preview-binary` container exists within the modal body.
  - Assert it contains text "Preview not available for this file type".
  - Assert it contains a `.download-btn-large` button with text "Download file".
- **Phase:** 3 (Task 6)

---

### files-viewer.AC2.9 — Failed fetch shows error state with retry

> **Failure:** Failed content fetch shows error state with retry button.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"shows error state with retry"`
- **Setup:** Mock `GET /api/files/home/user/src/app.ts` to return HTTP 500 on first request.
- **Assertions:**
  - Click the file in the directory listing.
  - Assert `.modal-error` container exists within the modal body.
  - Assert `.error-text` contains an error message (e.g., "HTTP 500").
  - Assert `.retry-btn` button exists with text "Retry".
  - Re-mock the endpoint to return HTTP 200 with valid content.
  - Click the `.retry-btn`.
  - Assert the error state disappears and the correct preview renders (e.g., `.preview-code` for a `.ts` file).
- **Phase:** 3 (Task 6)

---

### files-viewer.AC2.10 — Empty file shows "This file is empty" message

> **Edge:** Empty file (zero bytes) shows "This file is empty" message.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test name:** `"shows empty file message"`
- **Setup:** Mock `GET /api/files/home/user/empty.txt` to return `{ size_bytes: 0, content: null, ... }`.
- **Assertions:**
  - Click the empty file in the directory listing.
  - Assert `.modal-empty` container exists within the modal body.
  - Assert it contains text "This file is empty".
  - Assert no preview content containers exist (`.preview-code`, `.preview-markdown`, `.preview-image`, `.preview-text`, `.preview-binary` are all absent).
- **Phase:** 3 (Task 6)

---

### files-viewer.AC2.11 — Modal is accessible

> **Edge:** Modal is accessible: focus trap, `role="dialog"`, `aria-modal`, keyboard navigation.

**Automated: e2e**

- **Test file:** `e2e/files-viewer.spec.ts`
- **Test names:** `"opens modal on file click"` (ARIA attributes), `"traps focus within modal"` (focus trap)

#### ARIA attributes (tested alongside AC2.1)

- **Assertions:**
  - Assert `.modal-panel` has attribute `role="dialog"`.
  - Assert `.modal-panel` has attribute `aria-modal="true"`.
  - Assert `.modal-panel` has `aria-label` attribute containing the filename (e.g., `"File preview: app.ts"`).
  - Assert `.close-btn` has `aria-label="Close preview"`.

#### Focus trap

- **Test name:** `"traps focus within modal"`
- **Setup:** Open a file modal (one with content, so download + close buttons are present).
- **Assertions:**
  - Assert the modal panel (or a focusable child) has focus after opening.
  - Press `Tab` key. Assert `document.activeElement` is within `.modal-panel`.
  - Press `Tab` repeatedly (at least as many times as there are focusable elements + 1). Assert focus never leaves `.modal-panel` -- it wraps from the last focusable element back to the first.
  - Press `Shift+Tab` from the first focusable element. Assert focus wraps to the last focusable element.
  - After closing the modal, assert focus returns to the previously focused element (the file row that was clicked).

- **Phase:** 3 (Task 6)

---

## AC3: Frontend-only constraint

### files-viewer.AC3.1 — All changes within packages/web/src/client/

> All changes are within `packages/web/src/client/` -- no server-side modifications.

**Automated: audit (e2e harness or CI check)**

- **Test file:** `e2e/files-viewer.spec.ts` (or a standalone CI script)
- **Test name:** `"all changes are client-side only"` (optional, can also be a CI-level git diff check)
- **Approach:** This is verified structurally rather than behaviorally. Two complementary verification methods:

#### Method 1: Git diff assertion (CI)

Run `git diff --name-only main...HEAD` and assert every changed file matches one of:
- `packages/web/src/client/**` (client-side source)
- `e2e/**` (test files)
- `docs/**` (documentation)

No files in `packages/web/src/server/`, `packages/core/`, `packages/agent/`, or any other server-side package should be modified.

#### Method 2: Implementation review

During code review, verify:
- No new or modified files exist in `packages/web/src/server/`.
- No new API routes added to Hono server.
- No database schema changes.
- No changes to any package other than `packages/web` (client-side only) and `e2e/` (tests).
- The `file-tree.ts` utility (in `packages/web/src/client/lib/`) and new components are all within the client directory.

**Phase:** 3 (Task 5, verified at PR time)

---

## Unit Test Inventory

These unit tests support the e2e tests above by verifying core logic in isolation.

### `packages/web/src/client/lib/__tests__/file-tree.test.ts`

| Test | AC | Phase |
|------|----|-------|
| `findNodeByPath` returns null for empty tree | AC1.7 (supporting) | 2 |
| `findNodeByPath` returns null for non-existent path | AC1.7 (supporting) | 2 |
| `findNodeByPath` finds a top-level directory | AC1.7 (supporting) | 2 |
| `findNodeByPath` finds a nested directory | AC1.7 (supporting) | 2 |
| `findNodeByPath` finds a file node | AC1.7 (supporting) | 2 |
| `findNodeByPath` returns null for partial path match | AC1.7 (supporting) | 2 |

### `packages/web/src/client/lib/__tests__/file-categories.test.ts`

| Test | AC | Phase |
|------|----|-------|
| detects TypeScript as code | AC2.2 (supporting) | 3 |
| detects JavaScript as code | AC2.2 (supporting) | 3 |
| detects Python as code | AC2.2 (supporting) | 3 |
| detects JSON as code | AC2.2 (supporting) | 3 |
| detects markdown | AC2.3 (supporting) | 3 |
| detects PNG as image | AC2.4 (supporting) | 3 |
| detects JPG as image | AC2.4 (supporting) | 3 |
| detects SVG as image | AC2.4 (supporting) | 3 |
| detects plain text | AC2.5 (supporting) | 3 |
| detects log as text | AC2.5 (supporting) | 3 |
| treats unknown non-binary as text | AC2.5 (supporting) | 3 |
| treats unknown binary as binary | AC2.8 (supporting) | 3 |
| treats binary non-image as binary | AC2.8 (supporting) | 3 |
| handles files without extension | AC2.5 (supporting) | 3 |
| maps .ts to typescript | AC2.2 (supporting) | 3 |
| maps .py to python | AC2.2 (supporting) | 3 |
| maps .sh to bash | AC2.2 (supporting) | 3 |
| returns null for unknown extension | AC2.2 (supporting) | 3 |
| returns null for non-code extension | AC2.2 (supporting) | 3 |

---

## E2e Test Inventory

All e2e tests live in `e2e/files-viewer.spec.ts` and follow existing patterns: `page.route()` for API mocking, `process.env.SKIP_E2E === "1"` skip guard.

### Phase 1 tests (Layout)

| Test | AC |
|------|----|
| renders stable two-panel grid layout | AC1.1 |
| expand/collapse does not reflow content area | AC1.2 |
| clicking directory in tree selects and highlights it | AC1.5 |

### Phase 2 tests (Breadcrumbs and Directory Listing)

| Test | AC |
|------|----|
| displays breadcrumbs for current path | AC1.3 |
| breadcrumb click navigates to directory | AC1.4 |
| folder click in directory listing navigates into it | AC1.6 |
| empty directory shows empty state | AC1.7 |

### Phase 3 tests (File Preview Modal)

| Test | AC |
|------|----|
| opens modal on file click | AC2.1, AC2.11 (ARIA) |
| renders code with syntax highlighting | AC2.2 |
| renders markdown as formatted HTML | AC2.3 |
| displays PNG image inline | AC2.4 |
| displays SVG image from raw text content | AC2.4 |
| displays plain text in monospace | AC2.5 |
| shows filename and download button | AC2.6 |
| closes via close button | AC2.7 |
| closes via Escape key | AC2.7 |
| closes via backdrop click | AC2.7 |
| shows binary fallback | AC2.8 |
| shows error state with retry | AC2.9 |
| shows empty file message | AC2.10 |
| traps focus within modal | AC2.11 |
