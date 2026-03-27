<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import type { Component } from "svelte";
	import { SvelteSet } from "svelte/reactivity";
	import {
		File,
		FileText,
		FileCode,
		FileImage,
		FileArchive,
	} from "lucide-svelte";
	import { buildFileTree, type FileTreeNode, type FileMetadata } from "../lib/file-tree";
	import { wsEvents } from "../lib/websocket";
	// biome-ignore lint/correctness/noUnusedImports: used in template
	import TreeNode from "../components/TreeNode.svelte";

	// biome-ignore lint/correctness/noUnusedVariables: used in template
	let tree: FileTreeNode[] = $state([]);
	// biome-ignore lint/correctness/noUnusedVariables: used in template
	let loading = $state(true);
	// biome-ignore lint/correctness/noUnusedVariables: used in template
	let error = $state<string | null>(null);

	// biome-ignore lint/correctness/noUnusedVariables: used in template
	// biome-ignore lint/style/useConst: $state requires let
	let expandedPaths = $state(new SvelteSet<string>());

	async function loadFiles(): Promise<void> {
		try {
			loading = true;
			error = null;
			const response = await fetch("/api/files/");
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const files = (await response.json()) as FileMetadata[];
			tree = buildFileTree(files);
			// Expand all directories on initial load
			expandedPaths.clear();
			for (const node of tree) {
				expandAllRecursive(node);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : "Failed to load files";
		} finally {
			loading = false;
		}
	}

	function expandAllRecursive(node: FileTreeNode): void {
		if (node.type === "dir") {
			expandedPaths.add(node.fullPath);
			for (const child of node.children) {
				expandAllRecursive(child);
			}
		}
	}

	// biome-ignore lint/correctness/noUnusedVariables: passed to template
	function toggleExpanded(path: string): void {
		if (expandedPaths.has(path)) {
			expandedPaths.delete(path);
		} else {
			expandedPaths.add(path);
		}
	}

	// biome-ignore lint/correctness/noUnusedVariables: passed to template
	function formatFileSize(bytes: number): string {
		if (bytes === 0) return "0 B";
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}

	// biome-ignore lint/correctness/noUnusedVariables: passed to template
	function getFileIcon(name: string): Component {
		const lower = name.toLowerCase();
		if (lower.endsWith(".md") || lower.endsWith(".txt")) return FileText;
		if (
			lower.endsWith(".ts") ||
			lower.endsWith(".js") ||
			lower.endsWith(".json") ||
			lower.endsWith(".py") ||
			lower.endsWith(".rs") ||
			lower.endsWith(".go")
		)
			return FileCode;
		if (lower.match(/\.(png|jpg|jpeg|gif|svg|webp)$/)) return FileImage;
		if (lower.match(/\.(zip|tar|gz|rar|7z)$/)) return FileArchive;
		return File;
	}

	// biome-ignore lint/correctness/noUnusedVariables: passed to template
	function downloadFile(fileId: string): void {
		window.location.href = `/api/files/download/${fileId}`;
	}

	let unsubscribe: (() => void) | null = null;

	onMount(() => {
		loadFiles();
		unsubscribe = wsEvents.subscribe((events) => {
			const lastEvent = events[events.length - 1];
			if (lastEvent?.type === "file_update") {
				loadFiles();
			}
		});
	});

	onDestroy(() => {
		if (unsubscribe) unsubscribe();
	});
</script>

<div class="files-view">
	<div class="files-header">
		<h1>Files</h1>
		<span class="subtitle">Agent Workspace</span>
	</div>

	{#if loading}
		<div class="loading-state">
			<div class="loading-bar"></div>
			<p>Loading files...</p>
		</div>
	{:else if error}
		<div class="error-state">
			<p class="error-text">{error}</p>
		</div>
	{:else if tree.length === 0}
		<div class="empty-state">
			<svg width="80" height="48" viewBox="0 0 80 48">
				<rect
					x="4"
					y="20"
					width="72"
					height="8"
					rx="4"
					fill="none"
					stroke="var(--text-muted)"
					stroke-width="1.5"
					opacity="0.3"
					stroke-dasharray="4 3"
				/>
			</svg>
			<p>No files yet</p>
		</div>
	{:else}
		<div class="tree-container">
			{#each tree as node}
				<TreeNode
					{node}
					{expandedPaths}
					{toggleExpanded}
					{formatFileSize}
					{getFileIcon}
					{downloadFile}
				/>
			{/each}
		</div>
	{/if}
</div>

<style>
	.files-view {
		padding: 32px 40px;
		max-width: 1120px;
		margin: 0 auto;
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.files-header {
		display: flex;
		align-items: baseline;
		gap: 16px;
		margin-bottom: 32px;
	}

	h1 {
		margin: 0;
		color: var(--text-primary);
		font-family: var(--font-display);
		font-size: var(--text-xl);
		font-weight: 700;
	}

	.subtitle {
		font-family: var(--font-display);
		font-size: var(--text-sm);
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.loading-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		padding: 48px 0;
	}

	.loading-bar {
		width: 120px;
		height: 3px;
		background: var(--bg-surface);
		border-radius: 2px;
		position: relative;
		overflow: hidden;
	}

	.loading-bar::after {
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

	.loading-state p,
	.empty-state p {
		color: var(--text-muted);
		font-size: var(--text-sm);
		margin: 0;
	}

	.error-state {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 48px 0;
	}

	.error-text {
		color: var(--alert-disruption);
		font-size: var(--text-sm);
		margin: 0;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		padding: 48px 0;
		text-align: center;
	}

	.tree-container {
		display: flex;
		flex-direction: column;
		gap: 0;
		overflow: auto;
	}

	@media (prefers-reduced-motion: reduce) {
		.loading-bar::after {
			animation: none;
		}
	}
</style>
