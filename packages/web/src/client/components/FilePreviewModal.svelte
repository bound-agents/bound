<script lang="ts">
import { Download, X } from "lucide-svelte";
import { onDestroy, onMount } from "svelte";
import { client } from "../lib/bound";
import { extensionToLanguage, getFileCategory } from "../lib/file-categories";
import type { FileMetadata } from "../lib/file-tree";

interface Props {
	file: FileMetadata;
	onClose: () => void;
}

const { file, onClose }: Props = $props();

let content = $state<string | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let renderedHtml = $state<string | null>(null);
let blobUrl = $state<string | null>(null);

let modalRef: HTMLDivElement | undefined;
let previouslyFocused: HTMLElement | null = null;

const category = $derived(getFileCategory(file.path.split("/").pop() || "", file.is_binary));

onMount(async () => {
	await fetchContent();
	setupFocusTrap();
});

onDestroy(() => {
	if (blobUrl) URL.revokeObjectURL(blobUrl);
	previouslyFocused?.focus();
});

async function fetchContent(): Promise<void> {
	try {
		loading = true;
		error = null;
		const data = await client.getFile(file.path);

		if (data.content === null || data.size_bytes === 0) {
			// AC2.10: Empty file
			content = "";
			loading = false;
			return;
		}

		content = data.content;

		// Render based on category
		if (category === "code") {
			const ext = `.${(file.path.split(".").pop() || "").toLowerCase()}`;
			const lang = extensionToLanguage(ext) || "plaintext";
			const { highlightCode } = await import("../lib/markdown");
			if (content) {
				renderedHtml = await highlightCode(content, lang);
			}
		} else if (category === "markdown") {
			const { renderMarkdown } = await import("../lib/markdown");
			if (content) {
				renderedHtml = await renderMarkdown(content);
			}
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
				if (content) {
					const blob = new Blob([content], { type: mime });
					blobUrl = URL.createObjectURL(blob);
				}
			} else if (content) {
				// Base64-encoded binary content
				const binary = atob(content);
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

function download(): void {
	window.location.href = `/api/files/download?path=${encodeURIComponent(file.path)}`;
}
</script>

<div class="modal-backdrop">
	<button
		class="backdrop-close"
		onclick={onClose}
		aria-label="Close file preview"
		tabindex={-1}
	></button>
	<div
		class="modal-panel"
		role="dialog"
		aria-modal="true"
		aria-label="File preview: {file.path.split('/').pop()}"
		bind:this={modalRef}
		tabindex={-1}
		onkeydown={handleKeydown}
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

<style>
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

	.backdrop-close {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		background: none;
		border: none;
		cursor: default;
		padding: 0;
	}

	.modal-panel {
		position: relative;
		z-index: 1;
		background: var(--bg-secondary);
		border: 1px solid var(--bg-surface);
		border-radius: 8px;
		width: 100%;
		max-width: 900px;
		max-height: calc(100vh - 80px);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
		padding: 0;
	}

	.modal-panel:focus {
		outline: none;
	}

	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px;
		border-bottom: 1px solid var(--bg-surface);
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
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface);
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
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface);
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
		0% {
			left: -40%;
		}
		100% {
			left: 100%;
		}
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
</style>
