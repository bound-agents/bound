import { Box, Text } from "ink";
import type React from "react";

export interface BannerProps {
	type: "error" | "info";
	message: string;
	onDismiss?: () => void;
}

export function Banner({ type, message, onDismiss }: BannerProps): React.ReactElement {
	const textColor = type === "error" ? "red" : "blue";

	return (
		<Box flexDirection="row">
			<Text color={textColor}>{message}</Text>
			{onDismiss && <Text color={textColor}> [Press 'x' to dismiss]</Text>}
		</Box>
	);
}
