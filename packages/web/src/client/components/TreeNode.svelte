<script lang="ts">
import { ChevronDown, ChevronRight, Download, Folder, FolderOpen } from "lucide-svelte";
import type { Component } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import type { FileTreeNode } from "../lib/file-tree";
import TreeNode from "./TreeNode.svelte";

interface Props {
	node: FileTreeNode;
	expandedPaths: SvelteSet<string>;
	toggleExpanded: (path: string) => void;
	formatFileSize: (bytes: number) => string;
	getFileIcon: (name: string) => Component;
	downloadFile: (path: string) => void;
	selectedPath: string;
	onSelectDirectory: (path: string) => void;
	level?: number;
}

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

const isExpanded = $derived(expandedPaths.has(node.fullPath));
const isDir = $derived(node.type === "dir");
const hasChildDirs = $derived(isDir && node.children.some((c) => c.type === "dir"));
const nodeName = $derived(node.name);
const IconComponent = $derived(getFileIcon(nodeName));
const isSelected = $derived(selectedPath === node.fullPath);

function handleClick() {
	if (isDir) {
		toggleExpanded(node.fullPath);
		onSelectDirectory(node.fullPath);
	}
}

function handleDownload(e: Event) {
	e.stopPropagation();
	if (node.file) {
		downloadFile(node.file.path);
	}
}
</script>

<div class="tree-node" style="--tree-level: {level}">
	<div
		class="node-row"
		class:node-dir={isDir}
		class:node-file={!isDir}
		class:node-selected={isDir && isSelected}
		onclick={handleClick}
		role={isDir ? "button" : undefined}
		tabindex={isDir ? 0 : undefined}
		onkeydown={(e) => {
			if (isDir && (e.key === "Enter" || e.key === " ")) {
				e.preventDefault();
				handleClick();
			}
		}}
	>
		<div class="node-content">
			{#if isDir}
				<div class="expand-button">
					{#if hasChildDirs}
						{#if isExpanded}
							<ChevronDown size={16} />
						{:else}
							<ChevronRight size={16} />
						{/if}
					{/if}
				</div>
				<div class="node-icon">
					{#if isExpanded}
						<FolderOpen size={16} />
					{:else}
						<Folder size={16} />
					{/if}
				</div>
			{:else}
				<div class="expand-button"></div>
				<div class="node-icon">
					<IconComponent size={16} />
				</div>
			{/if}
			<span class="node-name">{nodeName}</span>
		</div>
		{#if !isDir && node.file}
			<div class="node-meta">
				<span class="file-size">{formatFileSize(node.file.size_bytes)}</span>
				<button
					class="download-btn"
					onclick={handleDownload}
					title="Download file"
					aria-label="Download {node.name}"
				>
					<Download size={14} />
				</button>
			</div>
		{/if}
	</div>

	{#if isDir && isExpanded}
		<div class="children">
			{#each node.children.filter((c) => c.type === "dir") as child}
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
			{/each}
		</div>
	{/if}
</div>

<style>
	.tree-node {
		--indent: calc(16px * var(--tree-level, 0));
	}

	.node-row {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 16px;
		padding-left: calc(12px + var(--indent));
		background: transparent;
		border: none;
		color: var(--text-primary);
		cursor: pointer;
		transition: background 0.15s ease;
		user-select: none;
	}

	.node-row:hover {
		background: rgba(42, 48, 68, 0.3);
	}

	/* Ticket stripe on selected directory */
	.node-row.node-selected {
		background: rgba(0, 155, 191, 0.1);
	}

	.node-row.node-selected::after {
		content: "";
		position: absolute;
		top: 0;
		left: calc(12px + var(--indent));
		width: 32px;
		height: 2px;
		background: var(--line-3);
		border-radius: 0 0 1px 1px;
	}

	.node-row.node-selected:hover {
		background: rgba(0, 155, 191, 0.15);
	}

	.node-row.node-dir {
		font-weight: 600;
	}

	.node-row.node-file {
		font-weight: 400;
		color: var(--text-secondary);
	}

	.node-row:focus {
		outline: 2px solid var(--line-3);
		outline-offset: -2px;
	}

	.node-content {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		min-width: 0;
	}

	.expand-button {
		width: 16px;
		height: 16px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		color: var(--text-muted);
	}

	.node-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		color: var(--text-secondary);
	}

	.node-dir .node-icon {
		color: var(--line-5);
	}

	.node-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-display);
		font-size: var(--text-sm);
	}

	.node-meta {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-left: 16px;
		flex-shrink: 0;
	}

	.file-size {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-muted);
		white-space: nowrap;
	}

	.download-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		color: var(--text-muted);
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.download-btn:hover {
		background: rgba(0, 155, 191, 0.1);
		border-color: var(--line-3);
		color: var(--line-3);
	}

	.download-btn:focus {
		outline: 2px solid var(--line-3);
		outline-offset: -1px;
	}

	.children {
		display: flex;
		flex-direction: column;
		gap: 0;
	}
</style>
