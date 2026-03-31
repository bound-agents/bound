# Files Viewer Implementation Plan — Phase 3

**Goal:** Add a modal overlay that previews file content with type-appropriate rendering, download, and close functionality.

**Architecture:** New FilePreviewModal.svelte component with type-based rendering pipeline: shiki for code, renderMarkdown for .md, blob URL for images, pre for text, fallback for binary. Modal opens on file click from DirectoryListing, fetches content via GET /api/files/*, renders by detected category. Focus trap, Escape/backdrop close, download button.

**Tech Stack:** Svelte 5 (runes: $state, $derived, $props), shiki (Tokyo Night), marked + DOMPurify, lucide-svelte, Blob URLs

**Scope:** 3 phases from original design (phases 1-3). This is phase 3.

**Codebase verified:** 2026-03-30

---

## Acceptance Criteria Coverage

This phase implements and tests:

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

---

## Codebase Verification Findings

- **markdown.ts** (`packages/web/src/client/lib/markdown.ts`, 154 lines): Shiki singleton via `getHighlighter()` (PRIVATE — not exported). Supports 10 languages: javascript, typescript, sql, python, bash, json, yaml, html, css, plaintext. Theme: tokyo-night. `renderMarkdown()` exported, async, returns sanitized HTML string. DOMPurify config: `ADD_ATTR: ["style"], ADD_TAGS: ["details", "summary"]`.
- **File content API**: `GET /api/files/*` (wildcard path) returns full `AgentFile` object WITH content. Binary files have base64-encoded content. `GET /api/files/download/:id` triggers browser download.
- **No existing modals**: Zero modal/dialog/overlay components in the codebase. This will be the first.
- **No focus trap utilities**: Only manual `tabindex={0}` patterns exist. Must implement focus trap from scratch.
- **Z-index safe**: Current max is z-index: 2 (SystemMap). z-index: 100 for modal is safe.
- **DOMPurify**: Already a dependency. Config pattern at markdown.ts:104-107.

---

<!-- START_TASK_1 -->
### Task 1: Export highlightCode function from markdown.ts

**Verifies:** None (infrastructure for AC2.2)

**Files:**
- Modify: `packages/web/src/client/lib/markdown.ts`

**Implementation:**

Export a public async function that wraps the private `getHighlighter()` for direct code highlighting in the file preview modal.

Add after the `getHighlighter()` function (before the Marked instance section, around line 32):

```typescript
/**
 * Highlights a code string with Shiki (Tokyo Night theme).
 * Falls back to plaintext for unsupported languages.
 * Output is sanitized with DOMPurify for safe {@html} injection.
 *
 * @param code The source code string to highlight.
 * @param lang The language identifier (e.g., "typescript", "python").
 * @returns Sanitized HTML string with syntax highlighting.
 */
export async function highlightCode(
	code: string,
	lang: string,
): Promise<string> {
	const highlighter = await getHighlighter();
	const supported = highlighter.getLoadedLanguages();
	const language = supported.includes(lang) ? lang : "plaintext";
	const html = highlighter.codeToHtml(code, {
		lang: language,
		theme: "tokyo-night",
	});
	return DOMPurify.sanitize(html, { ADD_ATTR: ["style"] });
}
```

This mirrors the exact logic used inside the `markedHighlight` callback (lines 49-56) but exposes it as a standalone function. The modal can call `highlightCode(content, "typescript")` directly without going through the markdown pipeline.

**Verification:**
Run: `bun test packages/web/src/client/lib/__tests__/markdown.test.ts`
Expected: All existing markdown tests still pass (no regressions).

**Commit:** `feat(web): export highlightCode function from markdown module`

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create file type detection utility

**Verifies:** None (infrastructure for AC2.2-AC2.5, AC2.8)

**Files:**
- Create: `packages/web/src/client/lib/file-categories.ts`

**Implementation:**

A small utility module that maps file extensions to render categories for the modal. This keeps the detection logic testable and separate from the modal component.

```typescript
export type FileCategory = "code" | "markdown" | "image" | "text" | "binary";

const CODE_EXTENSIONS = new Set([
	".ts", ".js", ".tsx", ".jsx",
	".py", ".sql", ".bash", ".sh",
	".json", ".yaml", ".yml",
	".html", ".css", ".scss",
]);

const IMAGE_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
]);

const TEXT_EXTENSIONS = new Set([
	".txt", ".log", ".env", ".csv", ".toml", ".ini", ".cfg",
]);

/**
 * Maps file extension to shiki language identifier.
 * Returns null for non-code files.
 */
export function extensionToLanguage(ext: string): string | null {
	const map: Record<string, string> = {
		".ts": "typescript",
		".tsx": "typescript",
		".js": "javascript",
		".jsx": "javascript",
		".py": "python",
		".sql": "sql",
		".bash": "bash",
		".sh": "bash",
		".json": "json",
		".yaml": "yaml",
		".yml": "yaml",
		".html": "html",
		".css": "css",
		".scss": "css",
	};
	return map[ext] ?? null;
}

/**
 * Determines the render category for a file based on extension and binary flag.
 *
 * @param filename The file name (e.g., "index.ts")
 * @param isBinary Whether the file is binary (is_binary field, 0 or 1)
 * @returns The render category
 */
export function getFileCategory(
	filename: string,
	isBinary: number,
): FileCategory {
	const ext = filename.includes(".")
		? "." + filename.split(".").pop()!.toLowerCase()
		: "";

	if (ext === ".md") return "markdown";
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	if (CODE_EXTENSIONS.has(ext)) return "code";
	if (TEXT_EXTENSIONS.has(ext)) return "text";

	// If it has a known text extension but isn't code/markdown/text,
	// and it's not binary, treat as plain text
	if (isBinary === 0) return "text";

	// Binary non-image files get the fallback
	return "binary";
}
```

Key decisions:
- Image check comes before code check (`.svg` could be argued as code, but user expects image display)
- Non-binary files with unknown extensions default to `"text"` (display as pre-formatted)
- Binary non-image files get `"binary"` fallback (AC2.8)

**Verification:**
Run: `bun test packages/web`
Expected: No regressions.

**Commit:** `feat(web): add file category detection utility`

<!-- END_TASK_2 -->

<!-- START_SUBCOMPONENT_A (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Add unit tests for file category detection

**Verifies:** None (tests for infrastructure utility)

**Files:**
- Create: `packages/web/src/client/lib/__tests__/file-categories.test.ts`

**Implementation:**

Unit tests for `getFileCategory()` and `extensionToLanguage()` using bun:test. Follow the existing pattern in `file-tree.test.ts`.

Tests to write:

**getFileCategory:**
1. **"detects TypeScript as code"** — `getFileCategory("index.ts", 0)` → `"code"`
2. **"detects JavaScript as code"** — `getFileCategory("app.js", 0)` → `"code"`
3. **"detects Python as code"** — `getFileCategory("main.py", 0)` → `"code"`
4. **"detects JSON as code"** — `getFileCategory("package.json", 0)` → `"code"`
5. **"detects markdown"** — `getFileCategory("readme.md", 0)` → `"markdown"`
6. **"detects PNG as image"** — `getFileCategory("photo.png", 0)` → `"image"`
7. **"detects JPG as image"** — `getFileCategory("pic.jpg", 0)` → `"image"`
8. **"detects SVG as image"** — `getFileCategory("icon.svg", 0)` → `"image"`
9. **"detects plain text"** — `getFileCategory("notes.txt", 0)` → `"text"`
10. **"detects log as text"** — `getFileCategory("app.log", 0)` → `"text"`
11. **"treats unknown non-binary as text"** — `getFileCategory("data.xyz", 0)` → `"text"`
12. **"treats unknown binary as binary"** — `getFileCategory("data.bin", 1)` → `"binary"`
13. **"treats binary non-image as binary"** — `getFileCategory("archive.zip", 1)` → `"binary"`
14. **"handles files without extension"** — `getFileCategory("Makefile", 0)` → `"text"`

**extensionToLanguage:**
1. **"maps .ts to typescript"** — `extensionToLanguage(".ts")` → `"typescript"`
2. **"maps .py to python"** — `extensionToLanguage(".py")` → `"python"`
3. **"maps .sh to bash"** — `extensionToLanguage(".sh")` → `"bash"`
4. **"returns null for unknown"** — `extensionToLanguage(".xyz")` → `null`
5. **"returns null for non-code"** — `extensionToLanguage(".png")` → `null`

**Verification:**
Run: `bun test packages/web/src/client/lib/__tests__/file-categories.test.ts`
Expected: All tests pass.

**Commit:** `test(web): add file category detection unit tests`

<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Create FilePreviewModal.svelte component

**Verifies:** files-viewer.AC2.1, files-viewer.AC2.2, files-viewer.AC2.3, files-viewer.AC2.4, files-viewer.AC2.5, files-viewer.AC2.6, files-viewer.AC2.7, files-viewer.AC2.8, files-viewer.AC2.9, files-viewer.AC2.10, files-viewer.AC2.11

**Files:**
- Create: `packages/web/src/client/components/FilePreviewModal.svelte`

**Implementation:**

The first modal component in the app. Fixed-position backdrop overlay with centered content panel. Fetches file content, detects type, renders appropriately.

**Props interface:**
```typescript
import type { FileMetadata } from "../lib/file-tree";

interface Props {
	file: FileMetadata;
	onClose: () => void;
}
```

**State management (script section):**
```typescript
let content = $state<string | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let renderedHtml = $state<string | null>(null);
let blobUrl = $state<string | null>(null);
```

**File category detection:**
```typescript
import { getFileCategory, extensionToLanguage } from "../lib/file-categories";

const category = $derived(getFileCategory(file.path.split("/").pop() || "", file.is_binary));
```

**Content fetching (onMount):**
```typescript
import { onMount, onDestroy } from "svelte";

onMount(async () => {
	await fetchContent();
	setupFocusTrap();
});

onDestroy(() => {
	if (blobUrl) URL.revokeObjectURL(blobUrl);
});

async function fetchContent(): Promise<void> {
	try {
		loading = true;
		error = null;
		const response = await fetch(`/api/files/${file.path}`);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = await response.json();

		if (data.content === null || data.size_bytes === 0) {
			// AC2.10: Empty file
			content = "";
			loading = false;
			return;
		}

		content = data.content;

		// Render based on category
		if (category === "code") {
			const ext = "." + (file.path.split(".").pop() || "").toLowerCase();
			const lang = extensionToLanguage(ext) || "plaintext";
			const { highlightCode } = await import("../lib/markdown");
			renderedHtml = await highlightCode(content!, lang);
		} else if (category === "markdown") {
			const { renderMarkdown } = await import("../lib/markdown");
			renderedHtml = await renderMarkdown(content!);
		} else if (category === "image") {
			const ext = file.path.split(".").pop()?.toLowerCase() || "";
			const mimeMap: Record<string, string> = {
				png: "image/png",
				jpg: "image/jpeg",
				jpeg: "image/jpeg",
				gif: "image/gif",
				svg: "image/svg+xml",
				webp: "image/webp",
			};
			const mime = mimeMap[ext] || "application/octet-stream";

			// SVG files from the agent VFS have is_binary=0 and raw XML text
			// content (not base64). Other image types have is_binary=1 and
			// base64-encoded content. Handle both cases.
			if (file.is_binary === 0) {
				// Raw text content (e.g., SVG XML)
				const blob = new Blob([content!], { type: mime });
				blobUrl = URL.createObjectURL(blob);
			} else {
				// Base64-encoded binary content
				const binary = atob(content!);
				const bytes = new Uint8Array(binary.length);
				for (let i = 0; i < binary.length; i++) {
					bytes[i] = binary.charCodeAt(i);
				}
				const blob = new Blob([bytes], { type: mime });
				blobUrl = URL.createObjectURL(blob);
			}
		}
		// "text" and "binary" categories use raw content directly in template
	} catch (err) {
		error = err instanceof Error ? err.message : "Failed to load file";
	} finally {
		loading = false;
	}
}

async function retry(): Promise<void> {
	await fetchContent();
}
```

**Focus trap implementation:**
```typescript
let modalRef: HTMLDivElement | undefined;
let previouslyFocused: HTMLElement | null = null;

function setupFocusTrap(): void {
	previouslyFocused = document.activeElement as HTMLElement;
	// Focus the modal container
	modalRef?.focus();
}

function handleKeydown(e: KeyboardEvent): void {
	if (e.key === "Escape") {
		e.preventDefault();
		onClose();
		return;
	}
	if (e.key === "Tab" && modalRef) {
		const focusable = modalRef.querySelectorAll<HTMLElement>(
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
		);
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}
}

function handleBackdropClick(e: MouseEvent): void {
	if (e.target === e.currentTarget) {
		onClose();
	}
}
```

Restore focus on close (add to onDestroy):
```typescript
onDestroy(() => {
	if (blobUrl) URL.revokeObjectURL(blobUrl);
	previouslyFocused?.focus();
});
```

**Download handler:**
```typescript
function download(): void {
	window.location.href = `/api/files/download/${file.id}`;
}
```

**Template:**
```svelte
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="modal-backdrop"
	onclick={handleBackdropClick}
	onkeydown={handleKeydown}
>
	<div
		class="modal-panel"
		role="dialog"
		aria-modal="true"
		aria-label="File preview: {file.path.split('/').pop()}"
		bind:this={modalRef}
		tabindex={-1}
	>
		<header class="modal-header">
			<h2 class="modal-title">{file.path.split("/").pop()}</h2>
			<div class="modal-actions">
				<button class="action-btn" onclick={download} title="Download file">
					<Download size={16} />
					<span>Download</span>
				</button>
				<button class="close-btn" onclick={onClose} title="Close" aria-label="Close preview">
					<X size={18} />
				</button>
			</div>
		</header>

		<div class="modal-body">
			{#if loading}
				<div class="modal-loading">
					<div class="loading-bar"></div>
					<p>Loading preview...</p>
				</div>
			{:else if error}
				<div class="modal-error">
					<p class="error-text">{error}</p>
					<button class="retry-btn" onclick={retry}>Retry</button>
				</div>
			{:else if content === "" || file.size_bytes === 0}
				<div class="modal-empty">
					<p>This file is empty</p>
				</div>
			{:else if category === "code" && renderedHtml}
				<div class="preview-code">{@html renderedHtml}</div>
			{:else if category === "markdown" && renderedHtml}
				<div class="preview-markdown">{@html renderedHtml}</div>
			{:else if category === "image" && blobUrl}
				<div class="preview-image">
					<img src={blobUrl} alt={file.path.split("/").pop()} />
				</div>
			{:else if category === "text"}
				<pre class="preview-text">{content}</pre>
			{:else}
				<div class="preview-binary">
					<p>Preview not available for this file type</p>
					<button class="download-btn-large" onclick={download}>
						<Download size={18} />
						<span>Download file</span>
					</button>
				</div>
			{/if}
		</div>
	</div>
</div>
```

Import `Download` and `X` from `lucide-svelte`.

**CSS (comprehensive):**

```css
.modal-backdrop {
	position: fixed;
	inset: 0;
	z-index: 100;
	background: rgba(0, 0, 0, 0.6);
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 40px;
}

.modal-panel {
	background: var(--bg-primary);
	border: 1px solid rgba(0, 155, 191, 0.2);
	border-radius: 12px;
	width: 100%;
	max-width: 900px;
	max-height: calc(100vh - 80px);
	display: flex;
	flex-direction: column;
	overflow: hidden;
	box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

.modal-panel:focus {
	outline: none;
}

.modal-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 16px 24px;
	border-bottom: 1px solid rgba(0, 155, 191, 0.15);
	flex-shrink: 0;
}

.modal-title {
	margin: 0;
	font-family: var(--font-mono);
	font-size: var(--text-sm);
	font-weight: 600;
	color: var(--text-primary);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.modal-actions {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-shrink: 0;
}

.action-btn {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 12px;
	background: transparent;
	border: 1px solid rgba(0, 155, 191, 0.2);
	border-radius: 6px;
	color: var(--text-secondary);
	font-family: var(--font-display);
	font-size: var(--text-xs);
	cursor: pointer;
	transition: all 0.15s ease;
}

.action-btn:hover {
	background: rgba(0, 155, 191, 0.1);
	border-color: var(--line-3);
	color: var(--line-3);
}

.action-btn:focus {
	outline: 2px solid var(--line-3);
	outline-offset: 1px;
}

.close-btn {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	background: transparent;
	border: 1px solid transparent;
	border-radius: 6px;
	color: var(--text-muted);
	cursor: pointer;
	transition: all 0.15s ease;
}

.close-btn:hover {
	background: rgba(255, 23, 68, 0.1);
	border-color: var(--alert-disruption);
	color: var(--alert-disruption);
}

.close-btn:focus {
	outline: 2px solid var(--line-3);
	outline-offset: 1px;
}

.modal-body {
	flex: 1;
	overflow-y: auto;
	min-height: 0;
}

/* Loading state */
.modal-loading {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 16px;
	padding: 48px 24px;
}

.modal-loading .loading-bar {
	width: 120px;
	height: 3px;
	background: var(--bg-surface);
	border-radius: 2px;
	position: relative;
	overflow: hidden;
}

.modal-loading .loading-bar::after {
	content: "";
	position: absolute;
	top: 0;
	left: -40%;
	width: 40%;
	height: 100%;
	background: var(--line-3);
	border-radius: 2px;
	animation: loadingSlide 1.2s ease-in-out infinite;
}

@keyframes loadingSlide {
	0% { left: -40%; }
	100% { left: 100%; }
}

.modal-loading p {
	color: var(--text-muted);
	font-size: var(--text-sm);
	margin: 0;
}

/* Error state */
.modal-error {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 16px;
	padding: 48px 24px;
}

.error-text {
	color: var(--alert-disruption);
	font-size: var(--text-sm);
	margin: 0;
}

.retry-btn {
	padding: 8px 20px;
	background: transparent;
	border: 1px solid var(--line-3);
	border-radius: 6px;
	color: var(--line-3);
	font-family: var(--font-display);
	font-size: var(--text-sm);
	cursor: pointer;
	transition: all 0.15s ease;
}

.retry-btn:hover {
	background: rgba(0, 155, 191, 0.1);
}

.retry-btn:focus {
	outline: 2px solid var(--line-3);
	outline-offset: 1px;
}

/* Empty state */
.modal-empty {
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 48px 24px;
}

.modal-empty p {
	color: var(--text-muted);
	font-size: var(--text-sm);
	margin: 0;
}

/* Code preview */
.preview-code {
	padding: 0;
	overflow-x: auto;
}

.preview-code :global(pre) {
	margin: 0;
	padding: 20px 24px;
	font-family: var(--font-mono);
	font-size: var(--text-sm);
	line-height: 1.6;
}

/* Markdown preview */
.preview-markdown {
	padding: 24px;
	font-family: var(--font-body);
	font-size: var(--text-sm);
	color: var(--text-primary);
	line-height: 1.7;
}

.preview-markdown :global(h1),
.preview-markdown :global(h2),
.preview-markdown :global(h3) {
	font-family: var(--font-display);
	color: var(--text-primary);
	margin-top: 24px;
	margin-bottom: 12px;
}

.preview-markdown :global(code) {
	font-family: var(--font-mono);
	background: var(--bg-surface);
	padding: 2px 6px;
	border-radius: 3px;
	font-size: 0.9em;
}

.preview-markdown :global(a) {
	color: var(--line-3);
}

/* Image preview */
.preview-image {
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
	background: repeating-conic-gradient(
		rgba(255, 255, 255, 0.03) 0% 25%,
		transparent 0% 50%
	) 50% / 20px 20px;
}

.preview-image img {
	max-width: 100%;
	max-height: calc(100vh - 200px);
	object-fit: contain;
	border-radius: 4px;
}

/* Text preview */
.preview-text {
	margin: 0;
	padding: 20px 24px;
	font-family: var(--font-mono);
	font-size: var(--text-sm);
	color: var(--text-secondary);
	line-height: 1.6;
	white-space: pre-wrap;
	word-break: break-word;
}

/* Binary fallback */
.preview-binary {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 20px;
	padding: 48px 24px;
}

.preview-binary p {
	color: var(--text-muted);
	font-size: var(--text-sm);
	margin: 0;
}

.download-btn-large {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 10px 24px;
	background: transparent;
	border: 1px solid var(--line-3);
	border-radius: 6px;
	color: var(--line-3);
	font-family: var(--font-display);
	font-size: var(--text-sm);
	cursor: pointer;
	transition: all 0.15s ease;
}

.download-btn-large:hover {
	background: rgba(0, 155, 191, 0.1);
}

.download-btn-large:focus {
	outline: 2px solid var(--line-3);
	outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
	.modal-loading .loading-bar::after {
		animation: none;
	}
}
```

Key CSS decisions:
- Backdrop: `position: fixed; inset: 0; z-index: 100` — covers entire viewport
- Panel: `max-width: 900px; max-height: calc(100vh - 80px)` — centered, scrollable
- Image preview: checkerboard background pattern to make transparent images visible
- Close button hover: red (`--alert-disruption`) to signal destructive-ish action
- Loading bar: reuses same animation pattern from FilesView

**Testing:**

All ACs for this component are tested in Task 6 (e2e test). The component is primarily visual/interactive behavior.

**Verification:**
Run: `bun test packages/web`
Expected: No regressions.

Run: `bun run lint`
Expected: No new lint errors.

**Commit:** `feat(web): create FilePreviewModal component with type-based rendering`

<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_5 -->
### Task 5: Wire file preview into FilesView.svelte

**Verifies:** files-viewer.AC2.1, files-viewer.AC2.6, files-viewer.AC2.7, files-viewer.AC3.1

**Files:**
- Modify: `packages/web/src/client/views/FilesView.svelte`

**Implementation:**

**FilesView.svelte script changes:**

1. Add import:
   ```typescript
   import FilePreviewModal from "../components/FilePreviewModal.svelte";
   import type { FileMetadata } from "../lib/file-tree";
   ```

2. Add `selectedFile` state (after `selectedPath`):
   ```typescript
   let selectedFile = $state<FileMetadata | null>(null);
   ```

3. Add file selection handler:
   ```typescript
   function openFilePreview(file: FileMetadata): void {
   	selectedFile = file;
   }

   function closeFilePreview(): void {
   	selectedFile = null;
   }
   ```

4. Replace the `onSelectFile={() => {}}` no-op in the DirectoryListing component with the real handler:
   ```svelte
   <DirectoryListing
   	items={currentDirectoryContents}
   	{formatFileSize}
   	{getFileIcon}
   	{relativeTime}
   	onSelectDirectory={navigateToDirectory}
   	onSelectFile={openFilePreview}
   />
   ```

5. Add conditional modal rendering at the end of the template (after the `.files-browser` div but still inside `.files-view`):
   ```svelte
   {#if selectedFile}
   	<FilePreviewModal file={selectedFile} onClose={closeFilePreview} />
   {/if}
   ```

6. Handle real-time file updates while modal is open. In the existing `wsEvents.subscribe()` callback (around line 98-103), add a check:
   ```typescript
   unsubscribe = wsEvents.subscribe((events) => {
   	const lastEvent = events[events.length - 1];
   	if (lastEvent?.type === "file_update") {
   		loadFiles();
   		// Note: modal stays open with stale content.
   		// User can close and reopen to see updated content.
   		// A more sophisticated approach would compare modified_at
   		// and auto-refresh, but that's out of scope for this phase.
   	}
   });
   ```

**DirectoryListing.svelte is already wired** — in Phase 2, Task 4, the `onSelectFile` prop exists and calls the handler when a file row is clicked. No changes needed to DirectoryListing.

**Verification:**
Run: `bun test packages/web`
Expected: All tests pass.

Run: `bun run lint`
Expected: No lint errors.

**Commit:** `feat(web): wire file preview modal into FilesView`

<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: E2e tests for file preview modal

**Verifies:** files-viewer.AC2.1, files-viewer.AC2.2, files-viewer.AC2.3, files-viewer.AC2.4, files-viewer.AC2.5, files-viewer.AC2.6, files-viewer.AC2.7, files-viewer.AC2.8, files-viewer.AC2.9, files-viewer.AC2.10, files-viewer.AC2.11

**Files:**
- Modify: `e2e/files-viewer.spec.ts` (extended from Phase 1 and Phase 2)

**Implementation:**

Add a new `describe("File Preview Modal", ...)` block to the existing files-viewer e2e spec. The mock data needs to include files of different types for comprehensive testing.

**Extended mock data** (add to the existing testFiles array or create a separate fixture):
```typescript
const previewTestFiles = [
	// Code file
	{ id: "10", path: "home/user/src/app.ts", is_binary: 0, size_bytes: 256, content: "export function hello(): string {\n\treturn \"world\";\n}\n", created_at: "2026-03-30T00:00:00Z", modified_at: "2026-03-30T00:00:00Z", deleted: 0, created_by: "agent", host_origin: "local" },
	// Markdown file
	{ id: "11", path: "home/user/docs/readme.md", is_binary: 0, size_bytes: 128, content: "# Hello\n\nThis is **bold** text.", created_at: "2026-03-30T00:00:00Z", modified_at: "2026-03-30T00:00:00Z", deleted: 0, created_by: "agent", host_origin: "local" },
	// Plain text file
	{ id: "12", path: "home/user/notes.txt", is_binary: 0, size_bytes: 32, content: "Some plain text content", created_at: "2026-03-30T00:00:00Z", modified_at: "2026-03-30T00:00:00Z", deleted: 0, created_by: "agent", host_origin: "local" },
	// Empty file
	{ id: "13", path: "home/user/empty.txt", is_binary: 0, size_bytes: 0, content: null, created_at: "2026-03-30T00:00:00Z", modified_at: "2026-03-30T00:00:00Z", deleted: 0, created_by: "agent", host_origin: "local" },
	// Binary file
	{ id: "14", path: "home/user/data.bin", is_binary: 1, size_bytes: 1024, content: "AQID", created_at: "2026-03-30T00:00:00Z", modified_at: "2026-03-30T00:00:00Z", deleted: 0, created_by: "agent", host_origin: "local" },
	// Image file (1x1 transparent PNG, base64-encoded)
	{ id: "15", path: "home/user/icon.png", is_binary: 1, size_bytes: 68, content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", created_at: "2026-03-30T00:00:00Z", modified_at: "2026-03-30T00:00:00Z", deleted: 0, created_by: "agent", host_origin: "local" },
	// SVG file (is_binary=0, raw XML text content)
	{ id: "16", path: "home/user/logo.svg", is_binary: 0, size_bytes: 120, content: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"10\" fill=\"#009BBF\"/></svg>", created_at: "2026-03-30T00:00:00Z", modified_at: "2026-03-30T00:00:00Z", deleted: 0, created_by: "agent", host_origin: "local" },
];
```

Mock both the list endpoint AND the content endpoint:
- `page.route("**/api/files", ...)` — returns file list without content
- `page.route("**/api/files/*", ...)` — returns individual file with content (match on path)

**Tests to write:**

1. **"opens modal on file click" (AC2.1):** Click a file in the directory listing. Assert `.modal-backdrop` and `.modal-panel` are visible. Assert `role="dialog"` and `aria-modal="true"` attributes exist (AC2.11).

2. **"renders code with syntax highlighting" (AC2.2):** Click `app.ts`. Assert `.preview-code` exists. Assert the content contains highlighted HTML (check for `<pre>` and `<span>` with style attributes from shiki).

3. **"renders markdown as formatted HTML" (AC2.3):** Click `readme.md`. Assert `.preview-markdown` exists. Assert rendered output contains `<h1>Hello</h1>` and `<strong>bold</strong>`.

4. **"displays plain text in monospace" (AC2.5):** Click `notes.txt`. Assert `.preview-text` exists with `<pre>` tag. Assert content matches raw text.

5. **"shows filename and download button" (AC2.6):** With modal open, assert `.modal-title` contains filename. Assert download button (`.action-btn`) exists.

6. **"closes via close button" (AC2.7):** Click `.close-btn`. Assert modal is no longer visible.

7. **"closes via Escape key" (AC2.7):** Open modal, press Escape. Assert modal is no longer visible.

8. **"closes via backdrop click" (AC2.7):** Open modal, click `.modal-backdrop` (not the panel). Assert modal closes.

9. **"shows binary fallback" (AC2.8):** Click `data.bin`. Assert `.preview-binary` exists with "Preview not available" text and download button.

10. **"shows error state with retry" (AC2.9):** Mock `/api/files/*` to return 500 for a specific file. Click that file. Assert `.modal-error` shows with retry button. Mock the endpoint to succeed, click retry. Assert content loads.

11. **"shows empty file message" (AC2.10):** Click `empty.txt`. Assert `.modal-empty` exists with "This file is empty" text.

12. **"traps focus within modal" (AC2.11):** Open modal. Press Tab repeatedly. Assert focus stays within modal panel (never leaves to elements behind backdrop).

13. **"displays PNG image inline" (AC2.4):** Click `icon.png`. Assert `.preview-image` exists. Assert `img` element has `src` attribute starting with `blob:`. Assert image is visible and contained within modal.

14. **"displays SVG image from raw text content" (AC2.4):** Click `logo.svg`. Assert `.preview-image` exists. Assert `img` element has `src` attribute starting with `blob:`. This tests the is_binary=0 SVG handling path where raw XML text is used instead of base64 decoding.

**Verification:**
Run: `bun run test:e2e`
Expected: All files-viewer tests pass.

**Commit:** `test(e2e): add file preview modal tests`

<!-- END_TASK_6 -->
