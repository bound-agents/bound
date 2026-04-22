import { Box, Text, useInput, useStdout } from "ink";
import type React from "react";
import { useState } from "react";

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
	 * Vertical rows reserved for chrome outside the list (modal borders,
	 * header, action bar, padding). Subtracted from terminal height when
	 * auto-sizing. Defaults to 8 which matches PickerView's layout
	 * (borders=2, paddingY=2, title=1, ActionBar=1, marginTop gaps=2).
	 */
	reservedRows?: number;
}

// Hard safety cap to avoid Yoga choking on huge lists.
const MAX_PAGE_SIZE = 50;
// Floor so the list is always usable even in tiny terminals.
const MIN_PAGE_SIZE = 3;
const DEFAULT_RESERVED_ROWS = 8;

export function SelectList<T>({
	items,
	onSelect,
	onCancel,
	renderItem,
	pageSize,
	reservedRows = DEFAULT_RESERVED_ROWS,
}: SelectListProps<T>): React.ReactElement {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const { stdout } = useStdout();
	const terminalRows = stdout?.rows ?? 24;

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

	return (
		<Box flexDirection="column">
			{hasMoreAbove && <Text color="gray">↑ {start} more above</Text>}
			{visible.map((item, i) => {
				const absoluteIndex = start + i;
				return (
					<Box key={`select-item-${absoluteIndex}`}>
						<Text>{renderItem(item, absoluteIndex === selectedIndex)}</Text>
					</Box>
				);
			})}
			{hasMoreBelow && <Text color="gray">↓ {total - end} more below</Text>}
		</Box>
	);
}
