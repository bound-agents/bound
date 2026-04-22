import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";

export interface SelectListProps<T> {
	items: T[];
	onSelect: (item: T) => void;
	onCancel?: () => void;
	renderItem: (item: T, selected: boolean) => React.ReactNode;
	/**
	 * Maximum number of items to render at once. Larger lists are windowed
	 * around the selected index to keep the viewport manageable and to
	 * avoid overwhelming Ink's Yoga layout engine (which crashes with
	 * `d.apply(null, p)` / "Out of bounds memory access" when given
	 * thousands of sibling nodes).
	 */
	pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 15;

export function SelectList<T>({
	items,
	onSelect,
	onCancel,
	renderItem,
	pageSize = DEFAULT_PAGE_SIZE,
}: SelectListProps<T>): React.ReactElement {
	const [selectedIndex, setSelectedIndex] = useState(0);

	useInput((input, key) => {
		if (key.upArrow) {
			setSelectedIndex((prev) => Math.max(0, prev - 1));
		} else if (key.downArrow) {
			setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
		} else if (key.pageUp) {
			setSelectedIndex((prev) => Math.max(0, prev - pageSize));
		} else if (key.pageDown) {
			setSelectedIndex((prev) => Math.min(items.length - 1, prev + pageSize));
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
	const windowSize = Math.min(pageSize, total);
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
