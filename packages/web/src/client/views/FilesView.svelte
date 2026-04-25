<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import FilePreviewModal from "../components/FilePreviewModal.svelte";
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";
import TicketTab from "../components/TicketTab.svelte";
import TreeNode from "../components/TreeNode.svelte";
import { client, wsEvents } from "../lib/bound";
import {
	type FileMetadata,
	type FileTreeNode,
	buildFileTree,
	findNodeByPath,
} from "../lib/file-tree";

let tree: FileTreeNode[] = $state([]);
let loading = $state(true);
let error = $state<string | null>(null);

let expandedPaths = $state(new SvelteSet<string>());
let selectedPath = $state("/");
let selectedFile = $state<FileMetadata | null>(null);

const breadcrumbSegments = $derived.by(() => {
	if (selectedPath === "/") return [] as string[];
	return selectedPath.split("/").filter(Boolean);
});

const currentDirectoryContents = $derived.by<FileTreeNode[]>(() => {
	if (selectedPath === "/") return tree;
	const node = findNodeByPath(tree, selectedPath);
	return node ? node.children : [];
});

const fileCount = $derived(currentDirectoryContents.filter((n) => n.type === "file").length);
const dirCount = $derived(currentDirectoryContents.filter((n) => n.type === "dir").length);

async function loadFiles(): Promise<void> {
	try {
		loading = true;
		error = null;
		const files = (await client.listFiles()) as FileMetadata[];
		tree = buildFileTree(files);
		expandedPaths.clear();
		for (const node of tree) expandAllRecursive(node);
		selectedPath = "/";
	} catch (err) {
		error = err instanceof Error ? err.message : "Failed to load files";
	} finally {
		loading = false;
	}
}

function expandAllRecursive(node: FileTreeNode): void {
	if (node.type === "dir") {
		expandedPaths.add(node.fullPath);
		for (const child of node.children) expandAllRecursive(child);
	}
}

function toggleExpanded(path: string): void {
	if (expandedPaths.has(path)) expandedPaths.delete(path);
	else expandedPaths.add(path);
}

function navigateToDirectory(path: string): void {
	selectedPath = path;
	if (path !== "/") {
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) {
			expandedPaths.add(parts.slice(0, i).join("/"));
		}
	}
}

function formatFileSize(bytes: number): string {
	if (bytes === 0) return "0 B";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function relativeTime(iso: string | null): string {
	if (!iso) return "—";
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function downloadFile(path: string): void {
	window.location.href = `/api/files/download?path=${encodeURIComponent(path)}`;
}

let unsubscribe: (() => void) | null = null;

onMount(() => {
	loadFiles();
	unsubscribe = wsEvents.subscribe((events) => {
		const last = events[events.length - 1];
		if (last?.type === "file:updated") loadFiles();
	});
});

onDestroy(() => {
	if (unsubscribe) unsubscribe();
});

function iconFor(name: string): string {
	const lower = name.toLowerCase();
	if (lower.endsWith(".md") || lower.endsWith(".txt"))
		return '<path d="M3 2h7l3 3v9H3z"/><path d="M10 2v3h3"/><path d="M5 8h6M5 11h6"/>';
	if (/\.(ts|js|json|py|rs|go|yaml|yml)$/.test(lower))
		return '<path d="M3 2h7l3 3v9H3z"/><path d="M10 2v3h3"/><path d="M6 9l-1.5 1.5L6 12M10 9l1.5 1.5L10 12"/>';
	if (/\.(png|jpg|jpeg|gif|svg|webp)$/.test(lower))
		return '<rect x="2" y="3" width="12" height="10"/><circle cx="6" cy="7" r="1"/><path d="M2 11l3-3 3 3 2-2 3 3"/>';
	if (/\.(csv|xlsx|xls)$/.test(lower))
		return '<rect x="2" y="3" width="12" height="10"/><path d="M2 7h12M2 10h12M6 3v10M10 3v10"/>';
	return '<path d="M3 2h7l3 3v9H3z"/><path d="M10 2v3h3"/>';
}
</script>

<Page>
	{#snippet children()}
		<SectionHeader number={5} subtitle="Agent Workspace" title="Files">
			{#snippet actions()}
				<TicketTab>
					{#snippet children()}
						{fileCount}
						{fileCount === 1 ? "file" : "files"}
						{#if dirCount > 0}
							· {dirCount} {dirCount === 1 ? "folder" : "folders"}
						{/if}
					{/snippet}
				</TicketTab>
			{/snippet}
		</SectionHeader>

		{#if loading}
			<div class="state">Loading files…</div>
		{:else if error}
			<div class="state err">{error}</div>
		{:else if tree.length === 0}
			<div class="state">No files yet.</div>
		{:else}
			<div class="files-browser">
				<aside class="tree-sidebar">
					<div class="kicker tree-label">Tree</div>
					{#each tree.filter((n) => n.type === "dir") as node (node.fullPath)}
						<TreeNode
							{node}
							{expandedPaths}
							{toggleExpanded}
							{formatFileSize}
							getFileIcon={() => ({}) as never}
							{downloadFile}
							{selectedPath}
							onSelectDirectory={navigateToDirectory}
						/>
					{/each}
				</aside>

				<main class="content-area">
					<div class="breadcrumbs">
						<button class="crumb" onclick={() => navigateToDirectory("/")}>/</button>
						{#each breadcrumbSegments as seg, i}
							{@const path = "/" + breadcrumbSegments.slice(0, i + 1).join("/")}
							{@const last = i === breadcrumbSegments.length - 1}
							<button class="crumb" class:last onclick={() => navigateToDirectory(path)}>
								{seg}
							</button>
							{#if !last}
								<span class="sep">/</span>
							{/if}
						{/each}
					</div>

					<div class="listing-header">
						<span></span>
						<span>Name</span>
						<span class="right">Size</span>
						<span class="right">Modified</span>
						<span class="right">Action</span>
					</div>

					<div class="listing">
						{#if currentDirectoryContents.length === 0}
							<div class="empty-dir">Empty directory.</div>
						{:else}
							{#each currentDirectoryContents as node (node.fullPath)}
								<div
									class="row"
									onclick={() => {
										if (node.type === "dir") navigateToDirectory(node.fullPath);
										else if (node.file) selectedFile = node.file;
									}}
									role="button"
									tabindex="0"
									onkeydown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											if (node.type === "dir") navigateToDirectory(node.fullPath);
											else if (node.file) selectedFile = node.file;
										}
									}}
								>
									<span class="icon-cell">
										{#if node.type === "dir"}
											<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
												<path d="M2 4h4l1.5 2h6.5v7H2z" />
											</svg>
										{:else}
											<svg
												width="14"
												height="14"
												viewBox="0 0 16 16"
												fill="none"
												stroke="currentColor"
												stroke-width="1.5"
											>
												{@html iconFor(node.name)}
											</svg>
										{/if}
									</span>
									<span class="name" class:dir={node.type === "dir"}>
										{node.name}{node.type === "dir" ? "/" : ""}
									</span>
									<span class="size tnum right">
										{node.type === "dir"
											? `${node.children.length} items`
											: formatFileSize(node.file?.size_bytes ?? 0)}
									</span>
									<span class="modified right">
										{relativeTime(node.type === "dir" ? null : (node.file?.modified_at ?? null))}
									</span>
									<span class="right">
										{#if node.type === "file"}
											<button
												class="open-btn"
												onclick={(e) => {
													e.stopPropagation();
													if (node.file) selectedFile = node.file;
												}}
											>
												Open
											</button>
										{/if}
									</span>
								</div>
							{/each}
						{/if}
					</div>
				</main>
			</div>
		{/if}

		{#if selectedFile}
			<FilePreviewModal file={selectedFile} onClose={() => (selectedFile = null)} />
		{/if}
	{/snippet}
</Page>

<style>
	.state {
		padding: 40px 16px;
		text-align: center;
		color: var(--ink-3);
		font-style: italic;
	}

	.state.err {
		color: var(--err);
	}

	.files-browser {
		display: grid;
		grid-template-columns: 260px 1fr;
		border: 1px solid var(--rule-soft);
		background: var(--paper);
		min-height: 520px;
	}

	.tree-sidebar {
		background: var(--paper-2);
		border-right: 1px solid var(--rule-soft);
		padding: 14px 10px;
		overflow-y: auto;
	}

	.kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.tree-label {
		padding: 0 8px 10px;
	}

	.content-area {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.breadcrumbs {
		padding: 14px 20px;
		border-bottom: 1px solid var(--rule-soft);
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
	}

	.crumb {
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 0;
		color: var(--ink-2);
		font-family: var(--font-display);
		font-size: 13px;
		font-weight: 500;
	}

	.crumb:hover:not(.last) {
		text-decoration: underline;
	}

	.crumb.last {
		color: var(--ink);
		font-weight: 600;
	}

	.sep {
		color: var(--ink-4);
	}

	.listing-header {
		display: grid;
		grid-template-columns: 24px 1fr 110px 120px 80px;
		gap: 14px;
		padding: 10px 20px;
		background: var(--paper-3);
		border-bottom: 1px solid var(--ink);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-2);
	}

	.right {
		text-align: right;
	}

	.listing {
		overflow-y: auto;
		flex: 1;
	}

	.row {
		display: grid;
		grid-template-columns: 24px 1fr 110px 120px 80px;
		gap: 14px;
		padding: 10px 20px;
		border-bottom: 1px solid var(--rule-faint);
		cursor: pointer;
		align-items: center;
		transition: background 0.12s ease;
		outline: none;
	}

	.row:hover {
		background: rgba(26, 24, 20, 0.035);
	}

	.row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.icon-cell {
		display: inline-flex;
		color: var(--ink-3);
	}

	.name {
		font-family: var(--font-display);
		font-size: 13.5px;
		font-weight: 500;
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.name.dir {
		font-weight: 600;
	}

	.size {
		font-variant-numeric: tabular-nums;
		font-size: 12px;
		color: var(--ink-3);
	}

	.modified {
		font-size: 12px;
		color: var(--ink-3);
	}

	.open-btn {
		background: transparent;
		border: 1px solid var(--rule-soft);
		padding: 3px 9px;
		cursor: pointer;
		font-size: 11px;
		font-weight: 500;
		color: var(--ink-2);
		font-family: var(--font-display);
	}

	.open-btn:hover {
		background: var(--paper-2);
		border-color: var(--ink-4);
	}

	.empty-dir {
		padding: 32px;
		text-align: center;
		color: var(--ink-4);
		font-style: italic;
	}
</style>
