import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";

export interface SelectListProps<T> {
	items: T[];
	onSelect: (item: T) => void;
	onCancel?: () => void;
	renderItem: (item: T, selected: boolean) => React.ReactNode;
}

export function SelectList<T>({
	items,
	onSelect,
	onCancel,
	renderItem,
}: SelectListProps<T>): React.ReactElement {
	const [selectedIndex, setSelectedIndex] = useState(0);

	useInput((input, key) => {
		if (key.upArrow) {
			setSelectedIndex((prev) => Math.max(0, prev - 1));
		} else if (key.downArrow) {
			setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
		} else if (key.return) {
			onSelect(items[selectedIndex]);
		} else if (input === "c" && key.ctrl) {
			onCancel?.();
		} else if (key.escape) {
			onCancel?.();
		}
	});

	return (
		<Box flexDirection="column">
			{items.map((item, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: Items are rendered in fixed order and lack inherent IDs
				<Box key={`select-item-${index}`}>
					<Text>{renderItem(item, index === selectedIndex)}</Text>
				</Box>
			))}
		</Box>
	);
}
