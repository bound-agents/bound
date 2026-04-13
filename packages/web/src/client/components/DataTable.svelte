<script lang="ts">
import type { Snippet } from "svelte";
import { sortRows } from "../lib/data-table-utils";

interface ColumnDef {
	key: string;
	label: string;
	width?: string;
	mono?: boolean;
	sortable?: boolean;
}

interface Props {
	columns: ColumnDef[];
	rows: Record<string, unknown>[];
	sortable?: boolean;
	expandable?: boolean;
	expandedContent?: Snippet<[row: Record<string, unknown>]>;
	onRowClick?: (row: Record<string, unknown>) => void;
	rowAccent?: (row: Record<string, unknown>) => string | null;
	children?: Snippet;
}

let {
	columns,
	rows,
	sortable = false,
	expandable = false,
	expandedContent,
	onRowClick,
	rowAccent,
}: Props = $props();

let sortKey = $state<string | null>(null);
let sortDir = $state<"asc" | "desc">("asc");
let expandedRowId = $state<string | null>(null);

const sortedRows = $derived(sortRows(rows, sortKey, sortDir));

function handleColumnClick(colKey: string) {
	if (!sortable) return;
	if (sortKey === colKey) {
		sortDir = sortDir === "asc" ? "desc" : "asc";
	} else {
		sortKey = colKey;
		sortDir = "asc";
	}
}

function toggleRowExpansion(row: Record<string, unknown>) {
	const rowId = String(row.id ?? "");
	expandedRowId = expandedRowId === rowId ? null : rowId;
}

const gridTemplate = $derived(columns.map((col) => col.width || "1fr").join(" "));
</script>

<div class="data-table-wrapper">
	<div class="data-table">
		<div class="header-row" style="grid-template-columns: {gridTemplate}">
			{#each columns as col (col.key)}
				<div
					class="header-cell"
					class:sortable
					class:active={sortable && sortKey === col.key}
					onclick={() => handleColumnClick(col.key)}
				>
					<span class="header-label">{col.label}</span>
					{#if sortable && sortKey === col.key}
						<span class="sort-arrow">
							{sortDir === "asc" ? "▲" : "▼"}
						</span>
					{/if}
				</div>
			{/each}
		</div>

		<div class="body">
			{#each sortedRows as row, i (row.id ?? i)}
				{@const accentColor = rowAccent?.(row)}
				<div
					class="data-row"
					class:expandable
					style="grid-template-columns: {gridTemplate};
					{accentColor ? `border-left: 3px solid ${accentColor}` : ''}"
					onclick={() => {
						onRowClick?.(row);
						if (expandable) toggleRowExpansion(row);
					}}
				>
					{#each columns as col (col.key)}
						<div class="data-cell" class:mono={col.mono}>
							{row[col.key] ?? ""}
						</div>
					{/each}
				</div>

				{#if expandable && expandedRowId === String(row.id ?? "")}
					<div class="expanded-row">
						{#if expandedContent}
							{@render expandedContent(row)}
						{/if}
					</div>
				{/if}
			{/each}
		</div>
	</div>
</div>

<style>
	.data-table-wrapper {
		overflow-x: auto;
	}

	.data-table {
		display: contents;
	}

	.header-row {
		display: grid;
		gap: 0;
		position: sticky;
		top: 0;
		background: var(--bg-primary);
		border-bottom: 1px solid var(--bg-surface);
		z-index: 10;
	}

	.header-cell {
		padding: 12px 8px;
		font-size: var(--text-xs);
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.header-cell.sortable {
		cursor: pointer;
		user-select: none;
	}

	.header-cell.sortable:hover {
		color: var(--text-secondary);
	}

	.header-cell.active {
		color: var(--text-primary);
	}

	.sort-arrow {
		font-size: 0.65em;
		display: inline-flex;
		align-items: center;
	}

	.body {
		display: contents;
	}

	.data-row {
		display: grid;
		gap: 0;
		border-bottom: 1px solid var(--bg-surface);
		transition: background 0.15s ease;
	}

	.data-row.expandable {
		cursor: pointer;
	}

	.data-row:hover {
		background: rgba(15, 52, 96, 0.15);
	}

	.data-cell {
		padding: 12px 8px;
		font-size: var(--text-sm);
		color: var(--text-primary);
		display: flex;
		align-items: center;
		min-height: 40px;
		word-break: break-word;
	}

	.data-cell.mono {
		font-family: var(--font-mono);
		font-size: 0.85em;
	}

	.expanded-row {
		background: rgba(15, 52, 96, 0.1);
		border-bottom: 1px solid var(--bg-surface);
		padding: 12px 8px;
		grid-column: 1 / -1;
	}
</style>
