import { Box, Text, useInput } from "ink";
import type React from "react";

export interface BannerProps {
	type: "error" | "info";
	message: string;
	onDismiss?: () => void;
}

/**
 * A bordered notification panel sized to its content. Error banners use a
 * red border with a ⚠ glyph; info banners use a blue border with a ℹ glyph.
 * The dismiss hint, when present, sits inside the border so it reads as
 * part of the banner rather than trailing text.
 */
export function Banner({ type, message, onDismiss }: BannerProps): React.ReactElement {
	const color = type === "error" ? "red" : "blue";
	const icon = type === "error" ? "⚠" : "ℹ";

	useInput(
		(input) => {
			if (input === "x") {
				onDismiss?.();
			}
		},
		{ isActive: !!onDismiss },
	);

	return (
		<Box
			borderStyle="round"
			borderColor={color}
			paddingX={1}
			flexDirection="row"
			alignSelf="flex-start"
		>
			<Text color={color} bold>
				{icon}{" "}
			</Text>
			<Text color={color}>{message}</Text>
			{onDismiss && (
				<Text color={color} dimColor>
					{" "}
					[press 'x' to dismiss]
				</Text>
			)}
		</Box>
	);
}
