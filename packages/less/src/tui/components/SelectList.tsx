import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { tokens } from "../theme";

export interface SelectListProps<T> {
	items: T[];
	onSelect: (item: T) => void;
	onCancel?: () => void;
	renderItem: (item: T, selected: boolean) => React.ReactNode;
	/**
	 * Maximum number of items to render at once. If omitted, the list auto-
	 * sizes to the terminal height (minus chrome reserved for surrounding
	 * modal/action-bar content). Caller can pass an explicit cap to clamp
	 * further. Larger lists are windowed around the selected index to keep
	 * the viewport manageable and to avoid overwhelming Ink's Yoga layout
	 * engine (which crashes with `d.apply(null, p)` / "Out of bounds memory
	 * access" when given thousands of sibling nodes).
	 */
	pageSize?: number;
	/**
	 * Vertical rows reserved outside the list's own rows and its two
	 * indicator rows: every row of surrounding chrome PLUS one spare row.
	 * The spare row keeps the dynamic frame strictly shorter than
	 * `stdout.rows`; Ink clears and redraws the whole terminal (instead of
	 * line-diffing) when output height reaches `stdout.rows`, which makes
	 * navigation jitter and leaves stale rows behind when the view closes.
	 *
	 * Rendered height = items + 2 indicators + (reservedRows - 1) chrome
	 *                 = rows - 1 whenever the list is windowed.
	 *
	 * Defaults to MODAL_LIST_RESERVED_ROWS (9), matching PickerView/McpView:
	 * border 2 + paddingY 2 + title 1 + list marginTop 1 + ActionBar marginTop 1
	 * + ActionBar 1 = 8 chrome rows, + 1 spare row.
	 */
	reservedRows?: number;
}

// Hard safety cap to avoid Yoga choking on huge lists.
const MAX_PAGE_SIZE = 50;
// Floor so the list is always usable even in tiny terminals.
// One row: a larger floor would push tiny terminals past `rows - 1`.
const MIN_PAGE_SIZE = 1;
/** Chrome rows of a ModalOverlay list view (see `reservedRows`). */
export const MODAL_LIST_CHROME_ROWS = 8;
/** Rows kept free below `stdout.rows` so Ink never takes its full-clear path. */
export const INK_SPARE_ROWS = 1;
export const MODAL_LIST_RESERVED_ROWS = MODAL_LIST_CHROME_ROWS + INK_SPARE_ROWS;
const DEFAULT_RESERVED_ROWS = MODAL_LIST_RESERVED_ROWS;

export function SelectList<T>({
	items,
	onSelect,
	onCancel,
	renderItem,
	pageSize,
	reservedRows = DEFAULT_RESERVED_ROWS,
}: SelectListProps<T>): React.ReactElement {
	const [rawIndex, setSelectedIndex] = useState(0);
	// Clamp after the list shrinks so the cursor always stays visible.
	const selectedIndex = Math.min(rawIndex, Math.max(0, items.length - 1));
	// Re-renders on terminal resize so the window tracks the new height.
	const { rows: terminalRows } = useTerminalSize();

	// Auto-size to terminal if no explicit pageSize given. Reserve rows for
	// chrome, clamp to [MIN, MAX], and account for the ↑/↓ "more" indicators
	// that take an extra row each when the list is windowed.
	const autoSize = Math.max(
		MIN_PAGE_SIZE,
		Math.min(MAX_PAGE_SIZE, terminalRows - reservedRows - 2),
	);
	const effectivePageSize = pageSize ?? autoSize;

	useInput((input, key) => {
		if (key.upArrow) {
			setSelectedIndex((prev) => Math.max(0, prev - 1));
		} else if (key.downArrow) {
			setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
		} else if (key.pageUp) {
			setSelectedIndex((prev) => Math.max(0, prev - effectivePageSize));
		} else if (key.pageDown) {
			setSelectedIndex((prev) => Math.min(items.length - 1, prev + effectivePageSize));
		} else if (key.return) {
			onSelect(items[selectedIndex]);
		} else if (input === "c" && key.ctrl) {
			onCancel?.();
		} else if (key.escape) {
			onCancel?.();
		}
	});

	// Compute visible window centered on selection.
	const total = items.length;
	const windowSize = Math.min(effectivePageSize, total);
	let start = selectedIndex - Math.floor(windowSize / 2);
	if (start < 0) start = 0;
	if (start + windowSize > total) start = Math.max(0, total - windowSize);
	const end = start + windowSize;
	const visible = items.slice(start, end);

	const hasMoreAbove = start > 0;
	const hasMoreBelow = end < total;
	// A windowed list always reserves both indicator rows so its height never
	// changes while navigating (a changing height reflows the whole screen).
	const windowed = total > windowSize;

	return (
		<Box flexDirection="column">
			{windowed && (
				<Text color={tokens.scrollIndicator}>{hasMoreAbove ? `↑ ${start} more` : " "}</Text>
			)}
			{visible.map((item, i) => {
				const absoluteIndex = start + i;
				const rendered = renderItem(item, absoluteIndex === selectedIndex);
				// Callers may return either a primitive (string/number) — in
				// which case we wrap in <Text> for them — or a React element
				// that already handles its own layout. Wrapping an existing
				// <Box> in <Text> crashes Ink ("<Box> can’t be nested inside
				// <Text>").
				const needsTextWrap = typeof rendered === "string" || typeof rendered === "number";
				return (
					<Box key={`select-item-${absoluteIndex}`}>
						{needsTextWrap ? <Text>{rendered}</Text> : rendered}
					</Box>
				);
			})}
			{windowed && (
				<Text color={tokens.scrollIndicator}>{hasMoreBelow ? `↓ ${total - end} more` : " "}</Text>
			)}
		</Box>
	);
}
