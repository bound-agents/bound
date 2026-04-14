<script lang="ts">
import { Folder } from "lucide-svelte";
import type { Component } from "svelte";
import type { FileMetadata, FileTreeNode } from "../lib/file-tree";

interface Props {
	items: FileTreeNode[];
	formatFileSize: (bytes: number) => string;
	getFileIcon: (name: string) => Component;
	relativeTime: (iso: string | null) => string;
	onSelectDirectory: (path: string) => void;
	onSelectFile: (file: FileMetadata) => void;
}

const { items, formatFileSize, getFileIcon, relativeTime, onSelectDirectory, onSelectFile }: Props =
	$props();
</script>

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

<style>
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
		background: rgba(42, 48, 68, 0.3);
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
</style>
