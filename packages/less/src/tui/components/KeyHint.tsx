import { Box, Text } from "ink";
import type React from "react";

export interface KeyHintProps {
	keys: string;
	label: string;
}

export function KeyHint({ keys, label }: KeyHintProps): React.ReactElement {
	return (
		<Box>
			<Text dimColor>[{keys}]</Text>
			<Text> {label}</Text>
		</Box>
	);
}
