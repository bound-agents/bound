import { Box, Text } from "ink";
import type React from "react";

export interface KeyHintProps {
	keys: string;
	label: string;
}

/**
 * Renders a single keybinding hint as `<keys> label`, with the keys
 * highlighted in cyan so they pop against the dim status row.
 */
export function KeyHint({ keys, label }: KeyHintProps): React.ReactElement {
	return (
		<Box>
			<Text color="cyan">{keys}</Text>
			<Text dimColor> {label}</Text>
		</Box>
	);
}
