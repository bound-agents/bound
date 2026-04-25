<script lang="ts">
import type { SvelteSet } from "svelte/reactivity";
import type { FileTreeNode } from "../lib/file-tree";
import TreeNode from "./TreeNode.svelte";

interface Props {
	node: FileTreeNode;
	expandedPaths: SvelteSet<string>;
	toggleExpanded: (path: string) => void;
	formatFileSize?: (bytes: number) => string;
	getFileIcon?: unknown;
	downloadFile?: (path: string) => void;
	selectedPath: string;
	onSelectDirectory: (path: string) => void;
	level?: number;
}

const {
	node,
	expandedPaths,
	toggleExpanded,
	selectedPath,
	onSelectDirectory,
	level = 0,
}: Props = $props();

const isExpanded = $derived(expandedPaths.has(node.fullPath));
const isDir = $derived(node.type === "dir");
const childDirs = $derived(isDir ? node.children.filter((c) => c.type === "dir") : []);
const hasSubfolders = $derived(childDirs.length > 0);
const isSelected = $derived(selectedPath === node.fullPath);

function handleClick(): void {
	if (isDir) {
		onSelectDirectory(node.fullPath);
		if (hasSubfolders) toggleExpanded(node.fullPath);
	}
}
</script>

{#if isDir}
	<div
		class="node"
		class:selected={isSelected}
		style="padding-left: {8 + level * 14}px"
		onclick={handleClick}
		role="button"
		tabindex="0"
		onkeydown={(e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				handleClick();
			}
		}}
	>
		<span class="arrow" style="opacity: {hasSubfolders ? 1 : 0}">
			{hasSubfolders ? (isExpanded ? "▼" : "▶") : ""}
		</span>
		<span class="name">{node.name}</span>
	</div>
	{#if isExpanded}
		{#each childDirs as child (child.fullPath)}
			<TreeNode
				node={child}
				{expandedPaths}
				{toggleExpanded}
				{selectedPath}
				{onSelectDirectory}
				level={level + 1}
			/>
		{/each}
	{/if}
{/if}

<style>
	.node {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		cursor: pointer;
		background: transparent;
		border-left: 3px solid transparent;
		font-family: var(--font-display);
		font-size: 13px;
		color: var(--ink-2);
		font-weight: 500;
		transition: background 0.1s ease;
		outline: none;
	}

	.node:hover {
		background: rgba(26, 24, 20, 0.04);
	}

	.node.selected {
		background: var(--paper);
		border-left-color: var(--accent);
		color: var(--ink);
		font-weight: 600;
	}

	.node:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.arrow {
		color: var(--ink-3);
		font-size: 9px;
		width: 10px;
		text-align: center;
	}

	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
